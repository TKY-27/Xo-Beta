import type { DataPayload, HandshakeReceiver, HandshakeSender } from 'trystero/nostr';
import type { Difficulty } from '../core/balance';
import { onLangChanged, t } from '../core/i18n';
import { getSettings, onSettingsChanged, updateSettings, type SkinId } from '../core/settings';
import type { MatchMode, TeamId } from '../sim/roster';
import type { MapId } from '../world';
import type {
  CreateRoomRequest,
  JoinRoomRequest,
  LobbyPlayerView,
  LobbyViewModel,
  OnlineLobbyActions,
  RoomUiErrorCode,
} from '../ui/onlineLobby';
import { RoomUiError } from '../ui/onlineLobby';
import {
  createAdmissionRequest,
  signAdmissionResponse,
  validateAdmissionRequest,
  validateAdmissionResponse,
  type AdmissionRejectCode,
  type AdmissionResponsePayload,
} from './admission';
import { base64UrlEncode, deriveInviteSecrets, randomBytes, type InviteKeyMaterial } from './crypto';
import {
  GameConnection,
  type GameConnectionOptions,
  type GameConnectionState,
  type GameProtocolBinding,
  type SignalMessage,
} from './gameConnection';
import { signLobby, verifySignedLobby, type HostIdentity, type SignedLobby } from './hostIdentity';
import {
  createInvite,
  createInviteUrl,
  parseInviteFragment,
  parseInviteToken,
  type Invite,
  type ParsedInvite,
} from './invite';
import {
  LobbyError,
  LobbyState,
  MAX_HUMAN_PARTICIPANTS,
  type LobbyParticipant,
  type LobbySnapshot,
} from './lobbyState';
import {
  buildHandshake,
  PROTOCOL_FEATURES,
  PROTOCOL_MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  PeerRateLimiter,
  ReplayNonceGuard,
  validateBuildIdentity,
  type BuildIdentity,
  type LobbyCommandMessage,
} from './protocol';
import {
  GuestReconnectSessionStore,
  MemoryReconnectStorage,
  ReconnectError,
  ReconnectTokenManager,
} from './reconnect';
import {
  openNostrSignalingRoom,
  type NostrSignalingOptions,
  type NostrSignalingRoom,
  type RelayHealth,
} from './signaling';

const LOBBY_ACTION = 'xo-lobby-v1';
const COMMAND_ACTION = 'xo-command-v1';
const GAME_SIGNAL_ACTION = 'xo-game-signal-v1';
const ADMISSION_TIMEOUT_MS = 12_000;
const PING_INTERVAL_MS = 3_000;

export type SignalingFactory = (options: NostrSignalingOptions) => NostrSignalingRoom;
export interface GameConnectionHandle {
  readonly state: GameConnectionState;
  start(): Promise<void>;
  handleSignal(signal: SignalMessage): Promise<void>;
  dispose(): void;
}
export type GameConnectionFactory = (options: GameConnectionOptions) => GameConnectionHandle;
type LocalCommand = LobbyCommandMessage extends infer Command
  ? Command extends LobbyCommandMessage
    ? Omit<Command, 'protocolVersion' | 'protocolSession' | 'senderPeerId' | 'nonce'>
    : never
  : never;

export interface PrivateRoomControllerOptions {
  readonly onView: (view: LobbyViewModel) => void;
  readonly onError?: (code: RoomUiErrorCode) => void;
  readonly signalingFactory?: SignalingFactory;
  readonly gameConnectionFactory?: GameConnectionFactory;
  readonly buildId?: string;
  readonly baseUrl?: string;
  readonly experimentalStartEnabled?: boolean;
  readonly sessionStorage?: Storage;
}

interface GuestProfile {
  readonly displayName: string;
  readonly skinId: SkinId;
  readonly proposedParticipantId: string;
  readonly protocolSession: string;
  readonly reconnectToken: string | null;
}

interface AdmissionDeferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

class FreshAdmissionRequired extends Error {}

/**
 * Coordinates the Phase 3 room only. It never constructs a Match: the start
 * request is an eligibility check guarded behind a development-only flag.
 */
export class PrivateRoomController implements OnlineLobbyActions {
  private readonly onView: (view: LobbyViewModel) => void;
  private readonly onError?: (code: RoomUiErrorCode) => void;
  private readonly signalingFactory: SignalingFactory;
  private readonly gameConnectionFactory: GameConnectionFactory;
  private readonly build: BuildIdentity;
  private readonly baseUrl: string;
  private readonly experimentalStartEnabled: boolean;
  private readonly injectedSessionStorage?: Storage;
  private readonly admissionRate = new PeerRateLimiter({ capacity: 6, refillPerSecond: 0.5 });
  private readonly admissionReplay = new ReplayNonceGuard(64);
  private readonly signalRate = new PeerRateLimiter({ capacity: 96, refillPerSecond: 24 });
  private readonly games = new Map<string, GameConnectionHandle>();
  private readonly pings = new Map<string, number>();
  private readonly disconnectedPeers = new Set<string>();
  private readonly cleanups: Array<() => void> = [];
  private readonly roomCleanups: Array<() => void> = [];

  private role: 'idle' | 'host' | 'guest' = 'idle';
  private invite: Invite | ParsedInvite | null = null;
  private derived: InviteKeyMaterial | null = null;
  private hostIdentity: HostIdentity | null = null;
  private signaling: NostrSignalingRoom | null = null;
  private lobby: LobbyState | null = null;
  private remoteSnapshot: LobbySnapshot | null = null;
  private localParticipantId = '';
  private localProtocolSession = '';
  private hostPeerId = '';
  private relays: readonly RelayHealth[] = [];
  private statusMessage = '';
  private reconnectManager: ReconnectTokenManager | null = null;
  private guestReconnect: GuestReconnectSessionStore | null = null;
  private guestProfile: GuestProfile | null = null;
  private admissionWait: AdmissionDeferred | null = null;
  private pingTimer: number | null = null;
  private disposed = false;

  constructor(options: PrivateRoomControllerOptions) {
    this.onView = options.onView;
    this.onError = options.onError;
    this.signalingFactory = options.signalingFactory ?? openNostrSignalingRoom;
    this.gameConnectionFactory = options.gameConnectionFactory ?? ((gameOptions) => new GameConnection(gameOptions));
    this.build = Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      buildId: options.buildId ?? __XO_BUILD_HASH__,
      features: PROTOCOL_FEATURES,
    });
    this.baseUrl = options.baseUrl ?? applicationBaseUrl();
    this.experimentalStartEnabled = options.experimentalStartEnabled
      ?? (import.meta.env.DEV && new URLSearchParams(location.search).has('experimental-online-start'));
    this.injectedSessionStorage = options.sessionStorage;
    this.cleanups.push(onSettingsChanged((settings) => {
      const local = this.currentSnapshot()?.participants.find((participant) => participant.participantId === this.localParticipantId);
      if (local && local.skinId !== settings.playerSkin) void this.setOwnSkin(settings.playerSkin);
    }));
    this.cleanups.push(onLangChanged(() => this.render()));
  }

  get active(): boolean {
    return this.role !== 'idle';
  }

  async createRoom(request: CreateRoomRequest): Promise<void> {
    this.assertUsable();
    await this.leaveRoom();
    const displayName = validateLocalDisplayName(request.displayName);
    const invite = await createInvite({ baseUrl: this.baseUrl });
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    this.role = 'host';
    this.invite = invite;
    this.derived = derived;
    this.hostIdentity = invite.hostIdentity;
    this.localParticipantId = randomIdentifier();
    this.localProtocolSession = base64UrlEncode(derived.protocolSessionBinding);
    this.reconnectManager = new ReconnectTokenManager({
      storage: new MemoryReconnectStorage(),
      storagePrefix: `xo-host-${derived.reconnectNamespace}:`,
    });

    try {
      const signaling = this.signalingFactory({
        discoveryId: derived.discoveryRoomId,
        signalingPassword: derived.signalingPassword,
        onPeerHandshake: (peerId, send, receive) => this.handleHostHandshake(peerId, send, receive),
        onJoinError: (reason) => this.handleJoinError(reason),
        onRelayExhausted: () => this.handleRelayExhausted(),
      });
      this.signaling = signaling;
      this.hostPeerId = signaling.peerId;
      this.lobby = new LobbyState({
        roomId: derived.discoveryRoomId,
        hostPeerId: signaling.peerId,
        hostParticipantId: this.localParticipantId,
        hostDisplayName: displayName,
        hostSkinId: request.skinId,
        protocolSession: this.localProtocolSession,
        build: this.build,
        channelOpen: true,
      });
      this.bindRoomActions(signaling);
      this.observeRelays(signaling);
      if (!await signaling.waitForRelay()) throw roomError('discovery-failed');
      this.render();
    } catch (error) {
      await this.leaveRoom();
      throw normalizeRoomError(error, 'discovery-failed');
    }
  }

  async joinRoom(request: JoinRoomRequest): Promise<void> {
    await this.joinRoomAttempt(request, randomIdentifier(), true);
  }

  private async joinRoomAttempt(
    request: JoinRoomRequest,
    protocolSession: string,
    allowFreshRetry: boolean,
  ): Promise<void> {
    this.assertUsable();
    await this.leaveRoom();
    const displayName = validateLocalDisplayName(request.displayName);
    let invite: ParsedInvite;
    try {
      invite = parseInviteInput(request.invite);
    } catch {
      throw roomError('invalid-invite');
    }
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const guestReconnect = new GuestReconnectSessionStore({
      namespace: derived.reconnectNamespace,
      storage: this.injectedSessionStorage,
    });
    this.role = 'guest';
    this.invite = invite;
    this.derived = derived;
    this.guestReconnect = guestReconnect;
    this.guestProfile = {
      displayName,
      skinId: request.skinId,
      proposedParticipantId: randomIdentifier(),
      protocolSession,
      reconnectToken: guestReconnect.load(),
    };
    this.localProtocolSession = protocolSession;
    this.admissionWait = deferred();
    // A relay can fail before joinRoom begins awaiting this promise. Attach a
    // rejection observer immediately so cleanup never creates an unhandled
    // rejection; the original promise still rejects when awaited below.
    void this.admissionWait.promise.catch(() => undefined);

    try {
      const signaling = this.signalingFactory({
        discoveryId: derived.discoveryRoomId,
        signalingPassword: derived.signalingPassword,
        onPeerHandshake: (peerId, send, receive) => this.handleGuestHandshake(peerId, send, receive),
        onJoinError: (reason) => this.handleJoinError(reason),
        onRelayExhausted: () => this.handleRelayExhausted(),
      });
      this.signaling = signaling;
      this.bindRoomActions(signaling);
      this.observeRelays(signaling);
      if (!await signaling.waitForRelay()) throw roomError('discovery-failed');
      await withTimeout(this.admissionWait.promise, ADMISSION_TIMEOUT_MS, roomError('discovery-failed'));
      history.replaceState(null, '', createInviteUrl(invite.token, this.baseUrl));
      this.render();
    } catch (error) {
      const retryFresh = allowFreshRetry && error instanceof FreshAdmissionRequired;
      await this.leaveRoom();
      if (retryFresh) return this.joinRoomAttempt(request, protocolSession, false);
      throw normalizeRoomError(error, 'discovery-failed');
    } finally {
      this.admissionWait = null;
    }
  }

  async leaveRoom(preserveInviteFragment = false): Promise<void> {
    this.stopPing();
    for (const cleanup of this.roomCleanups.splice(0)) cleanup();
    for (const game of this.games.values()) game.dispose();
    this.games.clear();
    this.pings.clear();
    this.disconnectedPeers.clear();
    this.admissionRate.reset();
    this.admissionReplay.reset();
    this.signalRate.reset();
    const signaling = this.signaling;
    this.signaling = null;
    if (signaling) await signaling.dispose().catch(() => undefined);
    this.reconnectManager?.clear();
    this.reconnectManager = null;
    this.role = 'idle';
    this.invite = null;
    this.derived = null;
    this.hostIdentity = null;
    this.lobby = null;
    this.remoteSnapshot = null;
    this.localParticipantId = '';
    this.localProtocolSession = '';
    this.hostPeerId = '';
    this.relays = [];
    this.statusMessage = '';
    this.guestReconnect = null;
    this.guestProfile = null;
    this.admissionWait?.reject(roomError('discovery-failed'));
    this.admissionWait = null;
    if (!preserveInviteFragment && typeof location !== 'undefined' && location.hash.startsWith('#join=')) {
      history.replaceState(null, '', applicationBaseUrl());
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.leaveRoom();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  async setReady(ready: boolean): Promise<void> {
    await this.applyLocalCommand({ type: 'set-ready', ready });
  }

  async setOwnDisplayName(displayName: string): Promise<void> {
    await this.applyLocalCommand({ type: 'set-display-name', displayName: validateLocalDisplayName(displayName) });
  }

  async setOwnSkin(skinId: SkinId): Promise<void> {
    await this.applyLocalCommand({ type: 'set-skin', skinId });
    if (getSettings().playerSkin !== skinId) updateSettings({ playerSkin: skinId });
  }

  async setMap(mapId: MapId): Promise<void> {
    await this.applyLocalCommand({ type: 'set-map', mapId });
  }

  async setMode(mode: MatchMode): Promise<void> {
    await this.applyLocalCommand({ type: 'set-mode', mode });
  }

  async setBotFill(botFill: boolean): Promise<void> {
    await this.applyLocalCommand({ type: 'set-bot-fill', botFill });
  }

  async setDifficulty(difficulty: Difficulty): Promise<void> {
    await this.applyLocalCommand({ type: 'set-difficulty', difficulty });
  }

  async setTeam(participantId: string, teamId: TeamId): Promise<void> {
    await this.applyLocalCommand({ type: 'set-team', participantId, teamId });
  }

  async requestStart(): Promise<void> {
    if (this.role !== 'host' || !this.experimentalStartEnabled) return;
    const result = await this.applyLocalCommand({ type: 'start-request' });
    if (result?.start?.accepted) {
      this.statusMessage = t('lobby.startVerified');
      this.render();
    }
  }

  private async handleHostHandshake(
    peerId: string,
    send: HandshakeSender,
    receive: HandshakeReceiver,
  ): Promise<void> {
    const identity = this.requireHostIdentity();
    let requestNonce = randomIdentifier();
    let rejection: AdmissionRejectCode = 'invalid-request';
    try {
      this.admissionRate.assertAllowed(peerId);
      const received = await receive();
      requestNonce = admissionRequestNonce(received.data) ?? requestNonce;
      const request = await validateAdmissionRequest(received.data, this.requireDerived().lobbyAuthenticationKey, {
        build: this.build,
        hostFingerprint: identity.fingerprint,
      });
      requestNonce = request.nonce;
      this.admissionReplay.assertFresh(peerId, request.protocolSession, request.nonce);
      const lobby = this.requireLobby();
      let participant: LobbyParticipant;
      let reconnectToken: string;

      if (request.reconnectToken) {
        const manager = this.requireReconnectManager();
        const record = manager.getRecord(request.reconnectToken);
        if (!record || record.roomId !== lobby.roomId) throw new ReconnectError('unknown-reconnect', 'Unknown reconnect token');
        if (request.requestedSlot !== null && request.requestedSlot !== record.slotId) {
          throw new ReconnectError('binding-mismatch', 'Reconnect slot does not match');
        }
        const existing = lobby.getParticipant(record.participantId);
        if (!existing || existing.connected || existing.isHost || existing.slotId !== record.slotId) {
          throw new ReconnectError('binding-mismatch', 'Reconnect participant is unavailable');
        }
        const grant = manager.reclaimGrant(request.reconnectToken, record, {
          nextProtocolSession: request.protocolSession,
        });
        participant = lobby.reclaimParticipant(
          record.participantId,
          existing.peerId,
          peerId,
          grant.binding.protocolSession,
        );
        reconnectToken = grant.token;
      } else {
        if (request.participantId === null) throw new Error('Fresh admission requires a participant identity');
        const handshake = buildHandshake({
          roomId: lobby.roomId,
          peerId,
          participantId: request.participantId,
          role: 'participant',
          protocolSession: request.protocolSession,
          build: this.build,
        });
        participant = lobby.addParticipant({
          handshake,
          displayName: request.displayName,
          skinId: request.skinId,
          requestedSlot: request.requestedSlot,
          channelOpen: false,
        });
        reconnectToken = this.requireReconnectManager().issue({
          roomId: lobby.roomId,
          slotId: participant.slotId,
          participantId: participant.participantId,
          protocolSession: participant.protocolSession,
        });
      }

      const payload: AdmissionResponsePayload = {
        type: 'admission-response',
        version: 1,
        accepted: true,
        role: 'host',
        requestNonce: request.nonce,
        hostPeerId: lobby.hostPeerId,
        participantId: participant.participantId,
        slotId: participant.slotId,
        protocolSession: participant.protocolSession,
        reconnectToken,
        build: this.build,
        lobby: lobby.snapshot(),
      };
      await send(await signAdmissionResponse(identity, payload) as unknown as DataPayload);
      this.render();
      return;
    } catch (error) {
      rejection = admissionRejectCode(error);
      const payload: AdmissionResponsePayload = {
        type: 'admission-response',
        version: 1,
        accepted: false,
        role: 'host',
        requestNonce,
        code: rejection,
      };
      await send(await signAdmissionResponse(identity, payload) as unknown as DataPayload).catch(() => undefined);
      throw error;
    }
  }

  private async handleGuestHandshake(
    peerId: string,
    send: HandshakeSender,
    receive: HandshakeReceiver,
  ): Promise<void> {
    const profile = this.guestProfile;
    const invite = this.invite;
    if (this.role !== 'guest' || !profile || !invite) throw new Error('Guest admission is unavailable');
    const request = await createAdmissionRequest({
      build: this.build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: profile.reconnectToken ? null : profile.proposedParticipantId,
      protocolSession: profile.protocolSession,
      displayName: profile.displayName,
      skinId: profile.skinId,
      reconnectToken: profile.reconnectToken,
      lobbyAuthenticationKey: this.requireDerived().lobbyAuthenticationKey,
    });
    await send(request as unknown as DataPayload);
    let verifiedHostResponse = false;
    try {
      const received = await receive();
      const response = await validateAdmissionResponse(
        received.data,
        invite.hostFingerprint,
        request.nonce,
        this.build,
      );
      verifiedHostResponse = true;
      if (!response.accepted) {
        if (response.code === 'invalid-reconnect') {
          this.guestReconnect?.clear();
          throw new FreshAdmissionRequired();
        }
        throw roomError(rejectToUiCode(response.code));
      }
      if (response.hostPeerId !== peerId) throw roomError('wrong-secret');
      const snapshot = validateLobbySnapshot(response.lobby, this.build, this.requireDerived().discoveryRoomId);
      if (snapshot.hostPeerId !== peerId) throw roomError('wrong-secret');
      const localPeerId = this.signaling?.peerId;
      const local = snapshot.participants.find((participant) => participant.participantId === response.participantId);
      if (!localPeerId || !local || local.isHost || local.peerId !== localPeerId
        || local.slotId !== response.slotId || local.protocolSession !== response.protocolSession
        || response.protocolSession !== request.protocolSession) throw roomError('wrong-secret');
      this.hostPeerId = peerId;
      this.localParticipantId = response.participantId;
      this.localProtocolSession = response.protocolSession;
      this.remoteSnapshot = snapshot;
      this.guestReconnect?.replace(response.reconnectToken, this.signaling?.peerId);
      this.admissionWait?.resolve();
    } catch (error) {
      // Trystero rooms are mesh-connected at the control layer. Another guest
      // can attempt the same handshake but cannot produce a signature matching
      // the invite's host commitment. Ignore that candidate and keep waiting
      // for the real host; only a verified host response may settle admission.
      if (verifiedHostResponse) {
        this.admissionWait?.reject(error instanceof FreshAdmissionRequired
          ? error
          : normalizeRoomError(error, 'wrong-secret'));
      }
      throw error;
    }
  }

  private bindRoomActions(signaling: NostrSignalingRoom): void {
    const lobbyAction = signaling.room.makeAction(LOBBY_ACTION);
    const commandAction = signaling.room.makeAction(COMMAND_ACTION);
    const signalAction = signaling.room.makeAction(GAME_SIGNAL_ACTION);

    lobbyAction.onMessage = async (data, context) => {
      if (this.role !== 'guest' || context.peerId !== this.hostPeerId || !this.invite) return;
      try {
        assertBoundedPayload(data);
        if (!await verifySignedLobby(data as unknown as SignedLobby, this.invite.hostFingerprint)) {
          throw new Error('Invalid host signature');
        }
        const signed = data as unknown as SignedLobby<unknown>;
        const snapshot = validateLobbySnapshot(signed.payload, this.build, this.requireDerived().discoveryRoomId);
        if (snapshot.hostPeerId !== this.hostPeerId) throw new Error('Host changed');
        if (this.remoteSnapshot && snapshot.revision < this.remoteSnapshot.revision) return;
        this.remoteSnapshot = snapshot;
        this.render();
      } catch {
        this.reportError('wrong-secret');
      }
    };

    commandAction.onMessage = async (data, context) => {
      if (this.role !== 'host') return;
      try {
        assertBoundedPayload(data);
        this.requireLobby().applyCommand(context.peerId, data);
        await this.broadcastLobby();
      } catch {
        // Invalid, stale, replayed, unauthorized, and rate-limited messages
        // fail closed without reflecting untrusted payload data into the UI.
      }
    };

    signalAction.onMessage = async (data, context) => {
      if (this.role === 'guest' && context.peerId !== this.hostPeerId) return;
      if (this.role === 'host' && !this.lobby?.getParticipantByPeer(context.peerId)) return;
      try {
        this.signalRate.assertAllowed(context.peerId);
        assertBoundedPayload(data);
        const signal = validateSignalMessage(data);
        const game = this.games.get(context.peerId);
        if (!game) return;
        await game.handleSignal(signal);
      } catch {
        this.markDirectFailed(context.peerId);
      }
    };

    signaling.room.onPeerJoin = (peerId) => {
      this.disconnectedPeers.delete(peerId);
      if (this.role === 'host') {
        if (!this.lobby?.getParticipantByPeer(peerId)) return;
        this.lobby.markConnected(peerId);
        this.startGameConnection(peerId, 'host', signalAction.send.bind(signalAction));
        void this.broadcastLobby();
      } else if (this.role === 'guest' && peerId === this.hostPeerId) {
        this.startGameConnection(peerId, 'guest', signalAction.send.bind(signalAction));
      }
      this.startPing();
      this.render();
    };

    signaling.room.onPeerLeave = (peerId) => {
      this.disconnectedPeers.add(peerId);
      this.games.get(peerId)?.dispose();
      this.games.delete(peerId);
      this.pings.delete(peerId);
      if (this.role === 'host') {
        try {
          this.requireLobby().markDisconnected(peerId);
          void this.broadcastLobby();
        } catch {
          // A peer that failed admission never entered the authoritative lobby.
        }
      } else if (peerId === this.hostPeerId) {
        this.statusMessage = t('room.hostLeft');
      }
      this.render();
    };

    this.sendLobbyMessage = (payload, target) => lobbyAction.send(payload as DataPayload, { target });
    this.sendCommandMessage = (payload, target) => commandAction.send(payload as DataPayload, { target });
  }

  private sendLobbyMessage: ((payload: unknown, target?: string | null) => Promise<void>) | null = null;
  private sendCommandMessage: ((payload: unknown, target?: string | null) => Promise<void>) | null = null;

  private startGameConnection(
    peerId: string,
    role: 'host' | 'guest',
    sendSignal: (data: DataPayload, options?: { target?: string | string[] | null }) => Promise<void>,
  ): void {
    if (this.games.has(peerId)) return;
    const snapshot = this.currentSnapshot();
    const local = snapshot?.participants.find((participant) => participant.participantId === this.localParticipantId);
    const remote = snapshot?.participants.find((participant) => participant.peerId === peerId);
    const signaling = this.signaling;
    if (!snapshot || !local || !remote || !signaling
      || local.peerId !== signaling.peerId || local.isHost !== (role === 'host')
      || remote.isHost === local.isHost) {
      this.markDirectFailed(peerId);
      return;
    }
    const protocolBinding = this.gameProtocolBinding(snapshot, local, role);
    const expectedRemoteProtocolBinding = this.gameProtocolBinding(
      snapshot,
      remote,
      role === 'host' ? 'guest' : 'host',
    );
    const game = this.gameConnectionFactory({
      role,
      protocolBinding,
      expectedRemoteProtocolBinding,
      onSignal: (signal) => sendSignal(signal as unknown as DataPayload, { target: peerId }),
      onStateChange: (state) => this.onGameState(peerId, state),
      onError: () => this.markDirectFailed(peerId),
    });
    this.games.set(peerId, game);
    void game.start().catch(() => this.markDirectFailed(peerId));
  }

  private gameProtocolBinding(
    snapshot: LobbySnapshot,
    participant: LobbyParticipant,
    role: 'host' | 'guest',
  ): GameProtocolBinding {
    return Object.freeze({
      protocolVersion: snapshot.build.protocolVersion,
      buildId: snapshot.build.buildId,
      roomId: snapshot.roomId,
      role,
      participantId: participant.participantId,
      peerId: participant.peerId,
      protocolSession: participant.protocolSession,
    });
  }

  private onGameState(peerId: string, state: GameConnectionState): void {
    if (this.role === 'host' && this.lobby?.getParticipantByPeer(peerId)) {
      this.lobby.setChannelOpen(peerId, state === 'connected');
      void this.broadcastLobby();
    }
    if (state === 'failed' || state === 'closed') {
      this.statusMessage = t('room.directFailed');
      this.reportError('direct-failed');
    }
    this.render();
  }

  private markDirectFailed(peerId: string): void {
    if (this.role === 'host' && this.lobby?.getParticipantByPeer(peerId)) {
      this.lobby.setChannelOpen(peerId, false);
      void this.broadcastLobby();
    }
    this.statusMessage = t('room.directFailed');
    this.reportError('direct-failed');
    this.render();
  }

  private async applyLocalCommand(
    fields: LocalCommand,
  ): Promise<ReturnType<LobbyState['applyCommand']> | null> {
    if (!this.signaling || !this.localProtocolSession) return null;
    const message = {
      ...fields,
      protocolVersion: PROTOCOL_VERSION,
      protocolSession: this.localProtocolSession,
      senderPeerId: this.signaling.peerId,
      nonce: randomIdentifier(),
    } as LobbyCommandMessage;
    if (this.role === 'host') {
      const result = this.requireLobby().applyCommand(this.signaling.peerId, message);
      await this.broadcastLobby();
      return result;
    }
    if (this.role === 'guest' && this.hostPeerId && this.sendCommandMessage) {
      await this.sendCommandMessage(message, this.hostPeerId);
    }
    return null;
  }

  private async broadcastLobby(target: string | null = null): Promise<void> {
    if (this.role !== 'host' || !this.sendLobbyMessage) return;
    const signed = await signLobby(this.requireHostIdentity(), this.requireLobby().snapshot());
    await this.sendLobbyMessage(signed, target);
    this.render();
  }

  private observeRelays(signaling: NostrSignalingRoom): void {
    this.relays = signaling.relayHealth();
    const unsubscribe = signaling.onRelayHealth((health) => {
      this.relays = health;
      this.render();
    });
    this.roomCleanups.push(unsubscribe);
  }

  private startPing(): void {
    if (this.pingTimer !== null || !this.signaling) return;
    const sample = () => {
      const signaling = this.signaling;
      if (!signaling) return;
      for (const peerId of Object.keys(signaling.room.getPeers())) {
        void signaling.room.ping(peerId).then((value) => {
          if (Number.isFinite(value) && value >= 0 && value <= 60_000) this.pings.set(peerId, value);
          this.render();
        }).catch(() => this.pings.delete(peerId));
      }
    };
    sample();
    this.pingTimer = window.setInterval(sample, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private handleJoinError(reason: 'handshake' | 'direct'): void {
    const code: RoomUiErrorCode = reason === 'direct' ? 'direct-failed' : 'discovery-failed';
    this.reportError(code);
  }

  private handleRelayExhausted(): void {
    this.statusMessage = t('room.discoveryFailed');
    this.reportError('discovery-failed');
    this.render();
  }

  private reportError(code: RoomUiErrorCode): void {
    this.onError?.(code);
  }

  private render(): void {
    const snapshot = this.currentSnapshot();
    const invite = this.invite;
    if (!snapshot || !invite || this.role === 'idle') return;
    const preview = snapshot.rosterPreview;
    const players: LobbyPlayerView[] = snapshot.participants.map((participant) => ({
      slotId: participant.slotId,
      participantId: participant.participantId,
      displayName: participant.displayName,
      skinId: participant.skinId,
      teamId: participant.teamId,
      isHost: participant.isHost,
      isLocal: participant.participantId === this.localParticipantId,
      connected: participant.connected && !this.disconnectedPeers.has(participant.peerId),
      ready: participant.ready,
      pingMs: participant.isHost && this.role === 'host' ? null : this.pings.get(participant.peerId) ?? null,
      directState: this.directState(participant),
    }));
    const roster = preview.roster;
    const humanCount = snapshot.participants.length;
    const botCount = Math.max(0, roster.length - humanCount);
    const teamA = roster.filter((entry) => entry.teamId === 0).length;
    const teamB = roster.filter((entry) => entry.teamId === 1).length;
    const rosterSummary = snapshot.effectiveMode === 'humans-vs-bots'
      ? t('lobby.rosterHumansBots', { humans: humanCount, bots: botCount })
      : snapshot.effectiveMode === 'teams' || snapshot.effectiveMode === 'teams-bot-fill'
        ? t('lobby.rosterTeams', { teamA, teamB })
        : t('lobby.rosterFfa', { humans: humanCount, bots: botCount, total: roster.length });
    const startEligible = this.role === 'host'
      ? this.requireLobby().getStartEligibility().eligible
      : !snapshot.matchLocked
        && snapshot.participants.filter((participant) => !participant.isHost).every((participant) => participant.ready)
        && snapshot.participants.every((participant) => participant.connected && participant.channelsOpen);
    const view: LobbyViewModel = {
      inviteCode: invite.token,
      inviteLink: createInviteUrl(invite.token, this.baseUrl),
      isHost: this.role === 'host',
      localParticipantId: this.localParticipantId,
      players,
      map: snapshot.config.mapId,
      mode: snapshot.effectiveMode,
      difficulty: snapshot.config.difficulty,
      rosterSummary,
      rosterLines: roster.map((entry) => `${entry.slotId + 1}. ${entry.displayName} — ${entry.skinId.toUpperCase()}${entry.teamId === null ? '' : ` — ${t(entry.teamId === 0 ? 'lobby.teamA' : 'lobby.teamB')}`}`),
      relays: this.relays,
      startEligible,
      experimentalStartEnabled: this.experimentalStartEnabled && this.role === 'host',
      statusMessage: this.statusMessage || undefined,
    };
    this.onView(view);
  }

  private directState(participant: LobbyParticipant): LobbyPlayerView['directState'] {
    if (!participant.connected || this.disconnectedPeers.has(participant.peerId)) return 'disconnected';
    if (participant.isHost && this.role === 'host') return 'open';
    if (participant.participantId === this.localParticipantId && this.role === 'host') return 'open';
    if (this.role === 'guest' && !participant.isHost && participant.participantId !== this.localParticipantId) {
      return participant.channelsOpen ? 'open' : 'connecting';
    }
    const remotePeerId = participant.participantId === this.localParticipantId
      ? this.hostPeerId
      : participant.peerId;
    const state = this.games.get(remotePeerId)?.state;
    if (state === 'connected') return 'open';
    if (state === 'failed' || state === 'closed' || state === 'disposed') return 'failed';
    return 'connecting';
  }

  private currentSnapshot(): LobbySnapshot | null {
    return this.role === 'host' ? this.lobby?.snapshot() ?? null : this.remoteSnapshot;
  }

  private requireDerived(): InviteKeyMaterial {
    if (!this.derived) throw new Error('Invite key material is unavailable');
    return this.derived;
  }

  private requireLobby(): LobbyState {
    if (!this.lobby) throw new Error('Host lobby is unavailable');
    return this.lobby;
  }

  private requireHostIdentity(): HostIdentity {
    if (!this.hostIdentity) throw new Error('Host identity is unavailable');
    return this.hostIdentity;
  }

  private requireReconnectManager(): ReconnectTokenManager {
    if (!this.reconnectManager) throw new Error('Reconnect manager is unavailable');
    return this.reconnectManager;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('PrivateRoomController is disposed');
  }
}

function applicationBaseUrl(): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseInviteInput(value: string): ParsedInvite {
  const input = value.trim();
  if (input.includes('#') || /^https?:\/\//iu.test(input)) return parseInviteFragment(input);
  return parseInviteToken(input);
}

function validateLocalDisplayName(value: string): string {
  const normalized = value.normalize('NFC');
  if (normalized.length < 1 || normalized.length > 24 || normalized !== normalized.trim()
    || hasControlCharacter(normalized)
    || new TextEncoder().encode(normalized).byteLength > 96) {
    throw roomError('invalid-name');
  }
  return normalized;
}

function randomIdentifier(): string {
  return base64UrlEncode(randomBytes(18));
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function deferred(): AdmissionDeferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(error), timeoutMs);
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

function roomError(code: RoomUiErrorCode): RoomUiError {
  return new RoomUiError(code);
}

function normalizeRoomError(error: unknown, fallback: RoomUiErrorCode): RoomUiError {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && [
      'invalid-invite', 'invalid-name', 'incompatible', 'room-full',
      'wrong-secret', 'discovery-failed', 'direct-failed',
    ].includes(code)) return roomError(code as RoomUiErrorCode);
  }
  return roomError(fallback);
}

function admissionRejectCode(error: unknown): AdmissionRejectCode {
  if (error instanceof LobbyError) {
    if (error.code === 'room-full') return 'room-full';
    if (error.code === 'match-locked') return 'match-locked';
    if (error.code === 'duplicate-peer' || error.code === 'duplicate-participant') return 'duplicate-peer';
    if (error.code === 'build-mismatch') return 'incompatible';
  }
  if (error instanceof ReconnectError) return 'invalid-reconnect';
  const message = error instanceof Error ? error.message : '';
  if (/incompatible|protocol|build|feature/iu.test(message)) return 'incompatible';
  if (/wrong-secret|fingerprint|proof/iu.test(message)) return 'wrong-secret';
  if (/duplicate/iu.test(message)) return 'duplicate-peer';
  if (/locked/iu.test(message)) return 'match-locked';
  return 'invalid-request';
}

function admissionRequestNonce(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const nonce = (value as Record<string, unknown>).nonce;
  return typeof nonce === 'string' && nonce.length >= 1 && nonce.length <= 128
    && nonce === nonce.trim() && !hasControlCharacter(nonce)
    ? nonce
    : null;
}

function rejectToUiCode(code: AdmissionRejectCode): RoomUiErrorCode {
  if (code === 'room-full') return 'room-full';
  if (code === 'incompatible') return 'incompatible';
  if (code === 'wrong-secret') return 'wrong-secret';
  return code === 'invalid-reconnect' ? 'wrong-secret' : 'discovery-failed';
}

function assertBoundedPayload(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('Malformed control payload');
  }
  if (new TextEncoder().encode(encoded).byteLength > PROTOCOL_MAX_PAYLOAD_BYTES) {
    throw new Error('Control payload is too large');
  }
}

function validateSignalMessage(value: unknown): SignalMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed signal');
  const record = value as Record<string, unknown>;
  if (record.type === 'offer' || record.type === 'answer') {
    const sdp = record.sdp;
    if (typeof sdp === 'string') return { type: record.type, sdp };
    if (sdp && typeof sdp === 'object' && !Array.isArray(sdp)) {
      const description = sdp as Record<string, unknown>;
      if (description.type !== record.type || typeof description.sdp !== 'string') throw new Error('Malformed SDP');
      return { type: record.type, sdp: { type: record.type, sdp: description.sdp } };
    }
  }
  if (record.type === 'candidate') {
    const candidate = record.candidate;
    if (typeof candidate === 'string') return { type: 'candidate', candidate };
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && typeof (candidate as Record<string, unknown>).candidate === 'string') {
      const item = candidate as RTCIceCandidateInit;
      return { type: 'candidate', candidate: item };
    }
  }
  throw new Error('Unknown signal message');
}

function validateLobbySnapshot(value: unknown, build: BuildIdentity, roomId: string): LobbySnapshot {
  assertBoundedPayload(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed lobby snapshot');
  const snapshot = value as Record<string, unknown>;
  if (Object.keys(snapshot).sort().join('|') !== [
    'build', 'config', 'effectiveMode', 'hostPeerId', 'matchLocked', 'participants', 'revision', 'roomId', 'rosterPreview',
  ].sort().join('|')) throw new Error('Malformed lobby snapshot');
  const receivedBuild = validateBuildIdentity(snapshot.build);
  if (receivedBuild.protocolVersion !== build.protocolVersion || receivedBuild.buildId !== build.buildId
    || receivedBuild.features.join('|') !== build.features.join('|')) throw roomError('incompatible');
  if (snapshot.roomId !== roomId || !validIdentifier(snapshot.hostPeerId)
    || typeof snapshot.matchLocked !== 'boolean') throw new Error('Wrong lobby binding');
  const config = requirePlainRecord(snapshot.config, 'lobby config');
  assertExactObjectKeys(config, ['mapId', 'mode', 'botFill', 'difficulty', 'seed']);
  const mapIds = ['neocity', 'oldfront', 'eden', 'ashara'];
  const modes = ['ffa-bot-fill', 'ffa', 'teams', 'teams-bot-fill', 'humans-vs-bots'];
  const difficulties = ['normal', 'hard', 'elite', 'nightmare'];
  if (typeof config.mapId !== 'string' || !mapIds.includes(config.mapId)
    || typeof config.mode !== 'string' || !modes.includes(config.mode)
    || typeof config.botFill !== 'boolean'
    || typeof config.difficulty !== 'string' || !difficulties.includes(config.difficulty)
    || !Number.isSafeInteger(config.seed) || (config.seed as number) < 0) {
    throw new Error('Malformed lobby config');
  }
  if (config.mode === 'humans-vs-bots' && config.botFill !== true) throw new Error('Malformed Bot fill');
  const expectedMode = config.mode === 'humans-vs-bots'
    ? config.mode
    : config.mode.startsWith('teams')
      ? config.botFill ? 'teams-bot-fill' : 'teams'
      : config.botFill ? 'ffa-bot-fill' : 'ffa';
  if (snapshot.effectiveMode !== expectedMode) throw new Error('Malformed effective mode');
  if (!Array.isArray(snapshot.participants) || snapshot.participants.length < 1
    || snapshot.participants.length > MAX_HUMAN_PARTICIPANTS) throw new Error('Malformed participants');
  const participants = snapshot.participants as LobbyParticipant[];
  const slots = new Set<number>();
  const peers = new Set<string>();
  const ids = new Set<string>();
  let hostCount = 0;
  for (const participant of participants) {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) throw new Error('Malformed participant');
    assertExactObjectKeys(participant as unknown as Record<string, unknown>, [
      'participantId', 'peerId', 'slotId', 'displayName', 'skinId', 'teamId',
      'ready', 'isHost', 'connected', 'channelsOpen', 'build', 'protocolSession',
    ]);
    const participantBuild = validateBuildIdentity(participant.build);
    if (!sameBuildIdentity(participantBuild, build)
      || !Number.isInteger(participant.slotId) || participant.slotId < 0 || participant.slotId >= 4
      || !validIdentifier(participant.peerId) || !validIdentifier(participant.participantId)
      || !validDisplayName(participant.displayName)
      || typeof participant.skinId !== 'string' || !['vanguard', 'pathfinder', 'specter', 'striker', 'warden', 'nova'].includes(participant.skinId)
      || (participant.teamId !== null && participant.teamId !== 0 && participant.teamId !== 1)
      || typeof participant.ready !== 'boolean' || typeof participant.isHost !== 'boolean'
      || typeof participant.connected !== 'boolean' || typeof participant.channelsOpen !== 'boolean'
      || !validIdentifier(participant.protocolSession)) throw new Error('Malformed participant');
    if (slots.has(participant.slotId) || peers.has(participant.peerId) || ids.has(participant.participantId)) {
      throw new Error('Duplicate lobby participant');
    }
    slots.add(participant.slotId);
    peers.add(participant.peerId);
    ids.add(participant.participantId);
    if (participant.isHost) {
      hostCount += 1;
      if (participant.slotId !== 0 || participant.peerId !== snapshot.hostPeerId) throw new Error('Invalid host slot');
    }
  }
  if (hostCount !== 1 || !Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0) {
    throw new Error('Malformed lobby snapshot');
  }
  validateRosterPreview(snapshot.rosterPreview, snapshot, config, participants);
  return value as LobbySnapshot;
}

function validateRosterPreview(
  value: unknown,
  snapshot: Record<string, unknown>,
  config: Record<string, unknown>,
  participants: readonly LobbyParticipant[],
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed roster preview');
  const preview = value as Record<string, unknown>;
  assertExactObjectKeys(preview, [
    'revision', 'roomId', 'mapId', 'mode', 'configuredMode', 'botFill',
    'difficulty', 'seed', 'humans', 'roster', 'valid', 'error',
  ]);
  if (preview.revision !== snapshot.revision || preview.roomId !== snapshot.roomId
    || preview.mapId !== config.mapId || preview.mode !== snapshot.effectiveMode
    || preview.configuredMode !== config.mode || preview.botFill !== config.botFill
    || preview.difficulty !== config.difficulty || preview.seed !== config.seed
    || !Array.isArray(preview.humans) || preview.humans.length !== participants.length
    || !Array.isArray(preview.roster) || preview.roster.length > 10
    || typeof preview.valid !== 'boolean'
    || (preview.error !== null && typeof preview.error !== 'string')) throw new Error('Malformed roster preview');
  if (preview.valid && preview.roster.length < participants.length) throw new Error('Malformed roster preview');
  const humanEntries = preview.humans.map(validateRosterEntry);
  const rosterEntries = preview.roster.map(validateRosterEntry);
  for (const participant of participants) {
    const human = humanEntries.find((entry) => entry.slotId === participant.slotId);
    if (!human || human.ownership.kind === 'bot' || human.ownership.peerId !== participant.peerId
      || human.displayName !== participant.displayName || human.skinId !== participant.skinId
      || human.teamId !== participant.teamId) throw new Error('Roster human does not match lobby participant');
    if (preview.valid) {
      const rosterHuman = rosterEntries.find((entry) => entry.slotId === participant.slotId);
      if (!rosterHuman || rosterHuman.ownership.kind === 'bot'
        || rosterHuman.ownership.peerId !== participant.peerId) throw new Error('Final roster omits a lobby participant');
    }
  }
  const rosterSlots = new Set<number>();
  const actorIds = new Set<number>();
  for (const entry of rosterEntries) {
    if (rosterSlots.has(entry.slotId) || actorIds.has(entry.actorId)) throw new Error('Duplicate roster entry');
    rosterSlots.add(entry.slotId);
    actorIds.add(entry.actorId);
  }
}

interface ValidatedRosterEntry {
  slotId: number;
  actorId: number;
  displayName: string;
  skinId: SkinId;
  teamId: TeamId | null;
  ownership: { kind: 'bot' } | { kind: 'local-human' | 'remote-human'; peerId: string };
}

function validateRosterEntry(value: unknown): ValidatedRosterEntry {
  const record = requirePlainRecord(value, 'roster entry');
  assertExactObjectKeys(record, [
    'slotId', 'actorId', 'displayName', 'ownership', 'connectionState', 'teamId', 'skinId', 'accentColor',
  ]);
  const ownership = requirePlainRecord(record.ownership, 'roster ownership');
  const kind = ownership.kind;
  if (kind === 'bot') assertExactObjectKeys(ownership, ['kind']);
  else {
    assertExactObjectKeys(ownership, ['kind', 'peerId']);
    if ((kind !== 'local-human' && kind !== 'remote-human') || !validIdentifier(ownership.peerId)) {
      throw new Error('Malformed roster ownership');
    }
  }
  if (!Number.isInteger(record.slotId) || (record.slotId as number) < 0 || (record.slotId as number) >= 10
    || !Number.isSafeInteger(record.actorId) || (record.actorId as number) <= 0
    || !validDisplayName(record.displayName)
    || typeof record.skinId !== 'string' || !['vanguard', 'pathfinder', 'specter', 'striker', 'warden', 'nova'].includes(record.skinId)
    || (record.teamId !== null && record.teamId !== 0 && record.teamId !== 1)
    || !Number.isInteger(record.accentColor) || (record.accentColor as number) < 0 || (record.accentColor as number) > 0xffffff
    || (kind === 'bot' ? record.connectionState !== 'bot' : record.connectionState !== 'connected' && record.connectionState !== 'disconnected')) {
    throw new Error('Malformed roster entry');
  }
  return record as unknown as ValidatedRosterEntry;
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Malformed ${label}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`Malformed ${label}`);
  return value as Record<string, unknown>;
}

function assertExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('Unexpected or missing lobby fields');
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && value === value.trim() && !hasControlCharacter(value);
}

function validDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value === value.normalize('NFC')
    && value.length >= 1 && value.length <= 24 && value === value.trim()
    && !hasControlCharacter(value) && new TextEncoder().encode(value).byteLength <= 96;
}

function sameBuildIdentity(left: BuildIdentity, right: BuildIdentity): boolean {
  return left.protocolVersion === right.protocolVersion && left.buildId === right.buildId
    && left.features.join('|') === right.features.join('|');
}
