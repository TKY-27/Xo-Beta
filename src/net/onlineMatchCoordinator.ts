import type { GameStateView } from '../sim/gameStateView';
import type { InputCommand } from '../sim/input';
import { emptyCommand } from '../sim/input';
import type { MapDef } from '../world/types';
import type { MapId } from '../world';
import { ClientReplica, type ClientReplicaEventResult, type ClientReplicaSnapshotResult } from './clientReplica';
import type {
  GameChannelLabel,
  GameConnectionState,
  GameMessage,
  GameNetworkMetrics,
  GamePayload,
} from './gameConnection';
import {
  HostAuthoritativeMatchSession,
  type HostReconnectTransaction,
  type AuthoritativeMatchEvent,
  type HostMatchTransport,
  type MatchPeerBinding,
  type SnapshotEncodeOptions,
  type EncodedSnapshot,
} from './hostMatchSession';
import {
  GuestMatchStartBarrier,
  HostMatchStartBarrier,
  MATCH_START_VERSION,
  computeGameplayMapHash,
  validateMatchStartPayload,
  validateMatchStartControl,
  type MatchStartPayload,
  type StartBarrierStatus,
} from './matchStart';
import {
  MatchStateCodecError,
  MatchStateDecoder,
  MatchStateEncoder,
  ReliableEventDeduplicator,
  canonicalBinaryValue,
  decodeAuthoritativeEventPacket,
  decodeReliablePacket,
  encodeAuthoritativeEventPacket,
  encodeInputCommandPacket,
  encodeReliablePacket,
  protocolInputToRemoteEnvelope,
  sessionBindingId,
  type ProtocolCommandFrame,
  type ReliablePacketKind,
} from './matchStateCodec';
import { InputPacketValidator, MATCH_PACKET_TYPES, MATCH_PROTOCOL_VERSION } from './matchProtocol';
import type { OnlineRoomMatchContext } from './privateRoom';
import type { PredictionState } from './prediction';

export const ONLINE_FIXED_HZ = 60;
export const ONLINE_FIXED_DT = 1 / ONLINE_FIXED_HZ;
export const ONLINE_START_COUNTDOWN_TICKS = ONLINE_FIXED_HZ * 3;
export const HOST_DISCONNECT_GRACE_MS = 5_000;
/** A hidden host tab is unsafe for an authoritative match after this bound. */
export const HOST_INACTIVITY_GRACE_MS = 10_000;
export const MAX_COORDINATOR_VIOLATIONS = 8;
export const MAX_PENDING_RECONNECT_EVENTS = 64;
export const MAX_PENDING_CONTROL_PACKETS = 64;
/** Reliable event retry storage is finite; overflow disconnects the peer. */
export const MAX_PENDING_RELIABLE_EVENTS_PER_PEER = 64;
/** A guest may request at most one recovery keyframe per half second. */
export const KEYFRAME_REQUEST_MIN_INTERVAL_TICKS = ONLINE_FIXED_HZ / 2;

export type OnlineMatchCoordinatorState =
  | 'idle'
  | 'preparing'
  | 'waiting-ready'
  | 'countdown'
  | 'active'
  | 'reconnecting'
  | 'ended'
  | 'failed'
  | 'disposed';

export type OnlineMatchEndReason =
  | 'cancelled'
  | 'host-disconnected'
  | 'host-ended'
  | 'host-inactive'
  | 'protocol-error';

export interface OnlineMatchRoomPort {
  sendGameMessage(peerId: string, channel: GameChannelLabel, data: GamePayload, snapshotSequence?: number): boolean;
  sendGameInput(data: GamePayload): boolean;
  disconnectGamePeer(peerId: string): boolean;
}

export interface PreparedParticipantReconnect {
  readonly accepted: boolean;
  readonly alive: boolean;
  commit(): void;
  rollback(): void;
}

export interface HostSessionFactoryInput {
  readonly payload: MatchStartPayload;
  readonly map: MapDef;
  readonly bindings: readonly MatchPeerBinding[];
  readonly transport: HostMatchTransport;
  readonly encodeSnapshot: (view: GameStateView, options: SnapshotEncodeOptions) => EncodedSnapshot;
  readonly onEvent: (event: AuthoritativeMatchEvent) => void;
  readonly onPresenceNotice: (kind: 'left' | 'rejoined', displayName: string) => void;
}

export interface GuestReplicaFactoryInput {
  readonly payload: MatchStartPayload;
  readonly map: MapDef;
  readonly localActorId: number;
}

export interface OnlineMatchCoordinatorOptions<S extends PredictionState = PredictionState> {
  readonly context: OnlineRoomMatchContext;
  readonly room: OnlineMatchRoomPort;
  readonly resolveMap: (mapId: MapId) => MapDef | Promise<MapDef>;
  readonly createHostSession?: (
    input: HostSessionFactoryInput,
  ) => HostAuthoritativeMatchSession | Promise<HostAuthoritativeMatchSession>;
  readonly createGuestReplica?: (
    input: GuestReplicaFactoryInput,
  ) => ClientReplica<S> | Promise<ClientReplica<S>>;
  readonly loadGuest?: (input: GuestReplicaFactoryInput) => void | Promise<void>;
  /** Sample edge-triggered controls exactly once per guest network tick. */
  readonly sampleLocalInput?: () => Readonly<InputCommand>;
  /** Return true only when local muzzle/audio/recoil presentation actually ran. */
  readonly onLocalInputSubmitted?: (inputSeq: number, command: Readonly<InputCommand>) => boolean;
  readonly nowMs?: () => number;
  readonly hostDisconnectGraceMs?: number;
  readonly hostInactivityGraceMs?: number;
  readonly onStateChange?: (state: OnlineMatchCoordinatorState) => void;
  readonly onBarrierStatus?: (status: StartBarrierStatus) => void;
  readonly onRuntimeReady?: (role: 'host' | 'guest', payload: MatchStartPayload) => void | Promise<void>;
  readonly onActivated?: (role: 'host' | 'guest', payload: MatchStartPayload) => void | Promise<void>;
  readonly onAuthoritativeEvent?: (event: AuthoritativeMatchEvent, matchedLocalPrediction: boolean) => void;
  readonly onPresenceNotice?: (kind: 'left' | 'rejoined', displayName: string) => void;
  readonly onHostVisibilityChange?: (hidden: boolean) => void;
  readonly onReconnectResult?: (accepted: boolean, alive: boolean) => void;
  readonly onEnd?: (reason: OnlineMatchEndReason) => void | Promise<void>;
  readonly onProtocolError?: (peerId: string, error: Error) => void;
  readonly onDisposeRuntime?: () => void;
}

interface PendingReliableEvent {
  readonly eventId: number;
  readonly packet: ArrayBuffer;
}

interface PendingReconnectPresence {
  readonly event: AuthoritativeMatchEvent;
  delivered: boolean;
}

interface RecoveryKeyframeState {
  readonly lastAcceptedHostTick: number;
  readonly pending: boolean;
}

interface RecoverySnapshotAttempt {
  readonly sequence: number;
  readonly packetCount: number;
  sentPackets: number;
}

type ReliableEventSendResult = 'sent' | 'queued' | 'rejected';

/**
 * Direct-DataChannel match bridge. It owns no signaling or relay fallback and
 * constructs no guest Match; map/presentation startup remains injected.
 */
export class OnlineMatchCoordinator<S extends PredictionState = PredictionState> {
  readonly role: 'host' | 'guest';
  readonly sessionId: number;

  private readonly context: OnlineRoomMatchContext;
  private readonly room: OnlineMatchRoomPort;
  private readonly options: OnlineMatchCoordinatorOptions<S>;
  private readonly nowMs: () => number;
  private readonly hostInactivityGraceMs: number;
  private readonly activeGuestPeerIds = new Set<string>();
  private readonly connectedGuestPeerIds = new Set<string>();
  private readonly guestPeerByParticipant = new Map<string, string>();
  private readonly actorIdByParticipant = new Map<string, number>();
  private readonly knownPeerIds = new Set<string>();
  private readonly reliableInboundSequences = new Map<string, number>();
  private readonly violations = new Map<string, number>();
  private readonly inputValidators = new Map<string, InputPacketValidator>();
  private readonly hostSnapshotEncoders = new Map<string, MatchStateEncoder>();
  private readonly eventDedup = new ReliableEventDeduplicator();
  private readonly predictedPresentationIds = new Set<number>();
  private readonly pendingReconnectResults = new Map<string,
    | {
      readonly participantId: string;
      readonly actorId: number;
      readonly accepted: true;
      readonly alive: boolean;
    }
    | { readonly accepted: false; readonly alive: false }
  >();
  private readonly pendingReconnectPresenceEvents = new Map<string, PendingReconnectPresence>();
  private readonly pendingReliableEventQueues = new Map<string, PendingReliableEvent[]>();
  private readonly pendingRecoveryKeyframes = new Map<string, RecoveryKeyframeState>();
  private readonly recoverySnapshotPackets = new Map<string, EncodedSnapshot>();
  private readonly recoverySnapshotAttempts = new Map<string, RecoverySnapshotAttempt>();
  private readonly pendingGuestEvents: AuthoritativeMatchEvent[] = [];
  private readonly recentInputs: ProtocolCommandFrame[] = [];
  private readonly guestStateDecoder: MatchStateDecoder;
  private controlQueue: Promise<void> = Promise.resolve();
  private pendingControlPackets = 0;

  private stateValue: OnlineMatchCoordinatorState = 'idle';
  private hostBarrier: HostMatchStartBarrier | null = null;
  private guestBarrier: GuestMatchStartBarrier | null = null;
  private hostSessionValue: HostAuthoritativeMatchSession | null = null;
  private replicaValue: ClientReplica<S> | null = null;
  private payloadValue: MatchStartPayload | null = null;
  private preparedMap: MapDef | null = null;
  private reliableSequence = 0;
  private networkTick = 0;
  private accumulator = 0;
  private countdownTarget: number | null = null;
  private guestLastAckHostTick = 0;
  private guestSimulationTick = 0;
  private guestRttMs = 0;
  private currentGuestInput: InputCommand = emptyCommand();
  private hostDisconnectDeadline: number | null = null;
  private hostHiddenSinceMs: number | null = null;
  private keyframeRequested = false;
  private awaitingRecoveryKeyframe = false;

  constructor(options: OnlineMatchCoordinatorOptions<S>) {
    this.options = options;
    this.context = options.context;
    this.room = options.room;
    this.role = options.context.role;
    this.sessionId = sessionBindingId(options.context.matchSessionBinding);
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.hostInactivityGraceMs = options.hostInactivityGraceMs ?? HOST_INACTIVITY_GRACE_MS;
    if (!Number.isFinite(this.hostInactivityGraceMs) || this.hostInactivityGraceMs < 500 || this.hostInactivityGraceMs > 60_000) {
      throw new Error('Invalid host inactivity grace period');
    }
    for (const participant of options.context.snapshot.participants) {
      if (participant.participantId !== options.context.localParticipantId) {
        this.knownPeerIds.add(participant.peerId);
        if (!participant.isHost) {
          this.activeGuestPeerIds.add(participant.peerId);
          if (participant.connected && participant.channelsOpen) this.connectedGuestPeerIds.add(participant.peerId);
          this.guestPeerByParticipant.set(participant.participantId, participant.peerId);
        }
      }
    }
    this.guestStateDecoder = new MatchStateDecoder(this.sessionId);
    if (this.role === 'guest') {
      const participant = this.localParticipant();
      this.guestBarrier = new GuestMatchStartBarrier(
        this.context.localParticipantId,
        participant.protocolSession,
        async (payload) => { await this.validateAndLoadGuest(payload); },
      );
      this.setState('waiting-ready');
    }
  }

  get state(): OnlineMatchCoordinatorState { return this.stateValue; }
  get hostSession(): HostAuthoritativeMatchSession | null { return this.hostSessionValue; }
  get replica(): ClientReplica<S> | null { return this.replicaValue; }
  get payload(): MatchStartPayload | null { return this.payloadValue; }
  get barrierStatus(): StartBarrierStatus | null { return this.hostBarrier?.status() ?? null; }
  get active(): boolean { return this.stateValue === 'active'; }

  /** Host preloads the one authoritative runtime, then sends one canonical payload. */
  async beginHost(): Promise<MatchStartPayload> {
    this.ensureUsable();
    if (this.role !== 'host') throw new Error('Only the room host can begin the match barrier');
    if (this.stateValue !== 'idle') throw new Error('Online match start has already begun');
    if (!this.options.createHostSession) throw new Error('Host session factory is required');
    this.setState('preparing');
    try {
      const preview = this.context.snapshot.rosterPreview;
      if (!preview.valid || preview.mode === 'solo' || preview.roster.length < 2) {
        throw new Error(preview.error ?? 'Final online roster is invalid');
      }
      const map = await this.options.resolveMap(preview.mapId);
      const mapHash = await computeGameplayMapHash(map);
      const payload: MatchStartPayload = Object.freeze({
        type: 'match-prepare',
        version: MATCH_START_VERSION,
        protocolVersion: MATCH_PROTOCOL_VERSION,
        protocolSession: this.context.matchSessionBinding,
        buildHash: this.context.snapshot.build.buildId,
        mapId: preview.mapId,
        mapHash,
        seed: preview.seed,
        mode: preview.mode,
        difficulty: preview.difficulty,
        roster: Object.freeze(preview.roster.map((entry) => Object.freeze({
          ...entry,
          ownership: Object.freeze({ ...entry.ownership }),
        }))),
        skins: Object.freeze(preview.roster.map((entry) => entry.skinId)),
        startHostTick: this.networkTick,
      });
      const participants = this.context.snapshot.participants.filter((participant) => !participant.isHost);
      this.hostBarrier = new HostMatchStartBarrier(payload, participants.map((participant) => ({
        peerId: participant.peerId,
        participantId: participant.participantId,
        protocolSession: participant.protocolSession,
      })), { nowMs: this.nowMs });
      this.payloadValue = payload;
      this.preparedMap = map;
      const bindings = buildPeerBindings(payload, this.context);
      for (const binding of bindings) this.actorIdByParticipant.set(binding.participantId, binding.actorId);
      this.hostSessionValue = await this.options.createHostSession({
        payload,
        map,
        bindings,
        transport: this.hostTransport(),
        encodeSnapshot: (view, encodeOptions) => this.encodeHostSnapshot(view, encodeOptions),
        onEvent: (event) => this.publishHostEvent(event),
        onPresenceNotice: (kind, displayName) => this.options.onPresenceNotice?.(kind, displayName),
      });
      this.hostBarrier.markHostReady();
      await this.options.onRuntimeReady?.('host', payload);
      for (const participant of participants) {
        this.sendControl(participant.peerId, 'match-prepare', payload, this.networkTick);
      }
      this.setState('waiting-ready');
      this.reportBarrier();
      this.maybeBeginCountdown();
      return payload;
    } catch (error) {
      this.releaseRuntime();
      this.setState('failed');
      throw error;
    }
  }

  /** Route the PrivateRoomController onGameMessage callback here. */
  async handleGameMessage(peerId: string, message: GameMessage): Promise<boolean> {
    if (this.stateValue === 'disposed' || this.stateValue === 'ended') return false;
    const data = binaryData(message.data);
    if (!data) return this.protocolFailure(peerId, new Error('Online match packets must be binary'));
    if (this.stateValue === 'failed') {
      if (this.role !== 'guest' || peerId !== this.context.hostPeerId || message.channel !== 'control') return false;
      try {
        const packet = decodeReliablePacket(data, this.sessionId);
        if (packet.kind !== 'host-disconnected'
          || !this.acceptReliableSequence(peerId, 'control', packet.sequence)) return false;
        return this.handleGuestControl(packet.kind, packet.payload);
      } catch (error) {
        return this.protocolFailure(peerId, asError(error));
      }
    }
    try {
      if (message.channel === 'input') return this.handleInput(peerId, data);
      if (message.channel === 'snapshot') return this.handleSnapshot(peerId, data);
      if (message.channel === 'event') return this.handleEvent(peerId, data);
      return await this.enqueueControl(peerId, data);
    } catch (error) {
      return this.protocolFailure(peerId, asError(error));
    }
  }

  /** Route the PrivateRoomController onGameStateChange callback here. */
  handleConnectionState(peerId: string, state: GameConnectionState): void {
    if (this.stateValue === 'disposed' || this.stateValue === 'ended') return;
    if (this.role === 'host') {
      if (state === 'connected') {
        if (!this.knownPeerIds.has(peerId)) return;
        this.connectedGuestPeerIds.add(peerId);
        if (this.pendingReconnectResults.has(peerId)) this.flushPendingReconnectResult(peerId);
        else if ([...this.guestPeerByParticipant.values()].includes(peerId)) this.activeGuestPeerIds.add(peerId);
        this.flushPendingReliableEvents(peerId);
      }
      if (state === 'failed' || state === 'closed' || state === 'disposed') {
        this.connectedGuestPeerIds.delete(peerId);
        this.activeGuestPeerIds.delete(peerId);
        this.hostSessionValue?.markDisconnected(peerId);
        if (this.stateValue === 'countdown') {
          // No countdown-cancel packet exists by design. Terminate the bounded
          // start attempt for every remaining peer rather than letting their
          // local countdowns enter a match missing a locked-roster member.
          this.cancelStart();
          return;
        }
        if ((this.stateValue === 'preparing' || this.stateValue === 'waiting-ready')
          && this.hostBarrier?.markDisconnected(peerId)) this.reportBarrier();
      }
      return;
    }
    if (peerId !== this.context.hostPeerId) return;
    if (state === 'restarting' || state === 'failed' || state === 'closed') {
      this.hostDisconnectDeadline ??= this.nowMs() + (this.options.hostDisconnectGraceMs ?? HOST_DISCONNECT_GRACE_MS);
      this.awaitingRecoveryKeyframe = true;
      this.currentGuestInput = emptyCommand();
      this.recentInputs.length = 0;
      this.predictedPresentationIds.clear();
      this.setState('reconnecting');
    } else if (state === 'connected' && this.hostDisconnectDeadline !== null) {
      this.hostDisconnectDeadline = null;
      this.keyframeRequested = false;
      this.requestRecoveryKeyframe();
      this.setState(this.payloadValue && this.replicaValue
        ? this.countdownTarget === null ? 'active' : 'countdown'
        : 'waiting-ready');
    }
  }

  /** Advance an arbitrary render delta through a bounded 60 Hz accumulator. */
  update(elapsedSeconds: number): void {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error('Invalid coordinator elapsed time');
    if (this.stateValue === 'disposed' || this.stateValue === 'ended' || this.stateValue === 'failed') return;
    this.accumulator += Math.min(elapsedSeconds, 0.25);
    while (this.accumulator >= ONLINE_FIXED_DT) {
      this.accumulator -= ONLINE_FIXED_DT;
      this.fixedUpdate();
    }
    this.checkHostDisconnectDeadline();
    this.enforceHostVisibilityDeadline();
  }

  /** One exact online clock/simulation tick; useful for deterministic harnesses. */
  fixedUpdate(): void {
    if (this.stateValue === 'disposed' || this.stateValue === 'ended' || this.stateValue === 'failed') return;
    this.networkTick = nextUint32(this.networkTick);
    if (this.stateValue === 'waiting-ready' && this.role === 'host') this.reportBarrier();
    if (this.countdownTarget !== null && this.networkTick >= this.countdownTarget) this.activate();
    if (this.stateValue === 'active') {
      if (this.role === 'host') {
        this.flushPendingReliableEvents();
        this.hostSessionValue?.fixedUpdate(ONLINE_FIXED_DT);
        // Events can be emitted synchronously by the authoritative fixed step.
        // Retry them after the step as well so a recovered channel does not
        // wait for another simulation tick before receiving the event.
        this.flushPendingReliableEvents();
        for (const peerId of this.pendingReconnectResults.keys()) {
          if (this.connectedGuestPeerIds.has(peerId)) this.flushPendingReconnectResult(peerId);
        }
      }
      else if (this.awaitingRecoveryKeyframe) {
        if (!this.keyframeRequested) this.requestRecoveryKeyframe();
      } else this.sendGuestInputTick();
    }
    this.checkHostDisconnectDeadline();
    this.enforceHostVisibilityDeadline();
  }

  /** Main samples local controls; the coordinator sends them at exactly 60 Hz. */
  setLocalInput(command: Readonly<InputCommand>): void {
    if (this.role !== 'guest') return;
    this.currentGuestInput = cloneCommand(command);
  }

  clearLocalInput(): void {
    if (this.role === 'guest') this.currentGuestInput = emptyCommand();
  }

  /** Feed address-free WebRTC stats into the guest presentation clock. */
  observeNetworkMetrics(peerId: string, metrics: GameNetworkMetrics): void {
    if (this.role !== 'guest' || peerId !== this.context.hostPeerId || metrics.rttMs === null) return;
    if (!Number.isFinite(metrics.rttMs) || metrics.rttMs < 0) return;
    this.guestRttMs = Math.min(10_000, metrics.rttMs);
  }

  requestTacticalPing(x: number, z: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(z) || this.stateValue !== 'active') return false;
    if (this.role === 'host') {
      if (!this.hostSessionValue || !this.payloadValue) return false;
      const actorId = localActorIdForPayload(this.payloadValue, this.context);
      return this.hostSessionValue.requestLocalTacticalPing(actorId, x, z) !== null;
    }
    return this.sendControl(this.context.hostPeerId, 'tactical-ping-request', { x, z }, this.networkTick);
  }

  requestRecoveryKeyframe(): boolean {
    if (this.role !== 'guest' || this.keyframeRequested) return false;
    this.keyframeRequested = true;
    const sent = this.sendControl(this.context.hostPeerId, 'keyframe-request', {}, this.networkTick);
    if (!sent) this.keyframeRequested = false;
    return sent;
  }

  /** Fail-closed preflight before the room rotates a locked-match token. */
  canAcceptReconnectedParticipant(participantId: string, newPeerId: string): boolean {
    if (this.role !== 'host' || !this.hostSessionValue || this.stateValue !== 'active') return false;
    const oldPeerId = this.guestPeerByParticipant.get(participantId);
    return Boolean(oldPeerId
      && oldPeerId !== newPeerId
      && this.actorIdByParticipant.has(participantId)
      && this.hostSessionValue.canReconnectParticipant(participantId, newPeerId));
  }

  /** Commit the Actor rebind after token rotation and before lobby admission. */
  acceptReconnectedParticipant(participantId: string, newPeerId: string): { accepted: boolean; alive: boolean } {
    const transaction = this.prepareAcceptedReconnectedParticipant(participantId, newPeerId);
    if (transaction.accepted) transaction.commit();
    return Object.freeze({ accepted: transaction.accepted, alive: transaction.alive });
  }

  /**
   * Prepare the host runtime rebind without mutating coordinator state. The
   * room commits this transaction only after the signed admission response has
   * been handed to the transport; otherwise a fixed update could serialize a
   * replacement peer or Actor into a snapshot that is already in flight.
   */
  prepareAcceptedReconnectedParticipant(
    participantId: string,
    newPeerId: string,
  ): PreparedParticipantReconnect {
    // A participant that reloads before the canonical start barrier completes
    // must not be promoted into a partially-started runtime. The host keeps
    // waiting and may cancel explicitly; live matches use the full reclaim
    // path below for the complete 60-second window.
    if (!this.canAcceptReconnectedParticipant(participantId, newPeerId)) {
      return rejectedParticipantReconnect();
    }
    const oldPeerId = this.guestPeerByParticipant.get(participantId);
    const actorId = this.actorIdByParticipant.get(participantId);
    if (!oldPeerId || actorId === undefined || !this.payloadValue) {
      return rejectedParticipantReconnect();
    }
    const hostSession = this.hostSessionValue;
    if (!hostSession) return rejectedParticipantReconnect();
    // Keep the coordinator compatible with narrow host-session doubles used by
    // older integrations. Production HostAuthoritativeMatchSession exposes a
    // side-effect-free preparation method; a legacy implementation has already
    // committed its rebind and therefore cannot participate in rollback.
    let hostTransaction: HostReconnectTransaction;
    if (typeof hostSession.prepareReconnectParticipant !== 'function') {
      const legacy = hostSession.reconnectParticipant(participantId, newPeerId);
      if (!legacy.accepted) return rejectedParticipantReconnect();
      hostTransaction = {
        accepted: true,
        alive: legacy.alive,
        commit: () => undefined,
        rollback: () => undefined,
      };
    } else {
      hostTransaction = hostSession.prepareReconnectParticipant(participantId, newPeerId);
    }
    if (!hostTransaction.accepted) return rejectedParticipantReconnect();

    let settled = false;
    return Object.freeze({
      accepted: true,
      get alive(): boolean {
        return hostTransaction.alive;
      },
      commit: () => {
        if (settled) return;
        settled = true;
        // Commit the authoritative session first. Its live Actor/presence
        // state may have changed during the asynchronous admission send.
        hostTransaction.commit();
        this.migratePeerRetryState(oldPeerId, newPeerId);
        this.knownPeerIds.delete(oldPeerId);
        this.knownPeerIds.add(newPeerId);
        this.activeGuestPeerIds.delete(oldPeerId);
        this.connectedGuestPeerIds.delete(oldPeerId);
        this.guestPeerByParticipant.set(participantId, newPeerId);
        this.inputValidators.delete(oldPeerId);
        this.inputValidators.delete(newPeerId);
        this.reliableInboundSequences.delete(`${oldPeerId}:control`);
        this.reliableInboundSequences.delete(`${oldPeerId}:event`);
        this.violations.delete(oldPeerId);
        this.pendingReconnectResults.set(newPeerId, Object.freeze({
          participantId, actorId, accepted: true, alive: hostTransaction.alive,
        }));
        try {
          this.room.disconnectGamePeer(oldPeerId);
        } catch {
          // The authoritative rebind is already committed. A stale transport
          // close adapter cannot unwind Actor/lobby admission state.
        }
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        // Preparation does not touch coordinator maps or transport state. The
        // host transaction only owns a newly allocated controller until the
        // admission is committed, so rollback is intentionally side-effect
        // free apart from releasing that staged controller.
        hostTransaction.rollback();
      },
    });
  }

  cancelStart(): void {
    if (this.role !== 'host' || !this.hostBarrier || this.stateValue === 'active') return;
    this.hostBarrier.cancel();
    for (const peerId of this.activeGuestPeerIds) this.sendControl(peerId, 'host-disconnected', { reason: 'cancelled' }, this.networkTick);
    this.terminate('cancelled');
  }

  /** Broadcast the host-tab safety state over authenticated control. */
  setHostVisibility(hidden: boolean): void {
    if (this.role !== 'host' || this.stateValue === 'disposed' || this.stateValue === 'ended' || this.stateValue === 'failed') return;
    if (hidden) {
      if (this.hostHiddenSinceMs !== null) return;
      const now = this.nowMs();
      if (!Number.isFinite(now)) {
        this.terminate('protocol-error');
        return;
      }
      this.hostHiddenSinceMs = now;
      this.options.onHostVisibilityChange?.(true);
      for (const peerId of this.activeGuestPeerIds) {
        this.sendControl(peerId, 'host-visibility', { hidden: true }, this.networkTick);
      }
      return;
    }
    if (this.hostHiddenSinceMs === null) return;
    this.hostHiddenSinceMs = null;
    this.options.onHostVisibilityChange?.(false);
    for (const peerId of this.activeGuestPeerIds) {
      this.sendControl(peerId, 'host-visibility', { hidden: false }, this.networkTick);
    }
  }

  /** Enforce the bounded hidden-host policy even if the render loop is sparse. */
  enforceHostVisibilityDeadline(): boolean {
    if (this.role !== 'host' || this.hostHiddenSinceMs === null) return false;
    const now = this.nowMs();
    if (!Number.isFinite(now)) {
      this.terminate('protocol-error');
      return true;
    }
    const elapsed = now - this.hostHiddenSinceMs;
    if (elapsed < this.hostInactivityGraceMs) return false;
    for (const peerId of this.activeGuestPeerIds) {
      this.sendControl(peerId, 'host-disconnected', { reason: 'host-inactive' }, this.networkTick);
    }
    this.terminate('host-inactive');
    return true;
  }

  endHostMatch(reason: 'host-ended' | 'host-inactive' = 'host-ended'): void {
    if (this.role !== 'host') return;
    for (const peerId of this.activeGuestPeerIds) this.sendControl(peerId, 'host-disconnected', { reason }, this.networkTick);
    this.terminate(reason);
  }

  dispose(): void {
    if (this.stateValue === 'disposed') return;
    this.releaseRuntime();
    this.setState('disposed');
    for (const peerId of this.knownPeerIds) this.room.disconnectGamePeer(peerId);
  }

  private async enqueueControl(peerId: string, data: ArrayBuffer | ArrayBufferView): Promise<boolean> {
    if (this.pendingControlPackets >= MAX_PENDING_CONTROL_PACKETS) {
      throw new Error('Reliable control queue exceeded its bound');
    }
    this.pendingControlPackets += 1;
    const operation = this.controlQueue.then(async () => {
      if (this.stateValue === 'disposed' || this.stateValue === 'ended' || this.stateValue === 'failed') return false;
      return this.handleControl(peerId, data);
    });
    this.controlQueue = operation.then(() => undefined, () => undefined);
    try {
      return await operation;
    } finally {
      this.pendingControlPackets -= 1;
    }
  }

  private handleInput(peerId: string, data: ArrayBuffer | ArrayBufferView): boolean {
    if (this.role !== 'host' || !this.hostSessionValue
      || this.stateValue !== 'active' && this.stateValue !== 'countdown') {
      throw new Error('Input packet is not permitted in the current match state');
    }
    let validator = this.inputValidators.get(peerId);
    if (!validator) {
      validator = new InputPacketValidator({
        expectedSessionId: this.sessionId,
        sequenceWindow: 128,
        maxFutureSequence: 64,
        maxFutureTicks: 15,
        maxPastTicks: 120,
        maxShotRewindTicks: 15,
        maxInputsPerSecond: 90,
        inputBurst: 90,
        now: this.nowMs,
      });
      this.inputValidators.set(peerId, validator);
    }
    const hostTick = this.hostSessionValue.match.hostTick;
    const packet = validator.validate(data, { currentHostTick: hostTick, nowMs: this.nowMs() });
    // Both peers activate against the same canonical tick, but independent
    // browser timers can let the guest reach that tick one callback before the
    // host. Validate and consume its sequence/rate budget, then drop it until
    // the host becomes active; authority never simulates countdown input.
    if (this.stateValue === 'countdown') return false;
    return this.hostSessionValue.receiveInput(peerId, protocolInputToRemoteEnvelope(packet, hostTick)).accepted;
  }

  private handleSnapshot(peerId: string, data: ArrayBuffer | ArrayBufferView): boolean {
    if (this.role !== 'guest' || peerId !== this.context.hostPeerId) throw new Error('Snapshot sender is not the host');
    return this.consumeSnapshot(data);
  }

  private handleEvent(peerId: string, data: ArrayBuffer | ArrayBufferView): boolean {
    if (this.role !== 'guest' || peerId !== this.context.hostPeerId) {
      throw new Error('Authoritative event sender is not the active host');
    }
    const event = decodeAuthoritativeEventPacket(data, this.sessionId);
    if (!this.acceptReliableSequence(peerId, 'event', event.eventId) || !this.eventDedup.accept(event)) return false;
    if (!this.replicaValue || this.awaitingRecoveryKeyframe) {
      if (this.pendingGuestEvents.length >= MAX_PENDING_RECONNECT_EVENTS) {
        throw new Error('Authoritative event recovery backlog exceeded its bound');
      }
      this.pendingGuestEvents.push(event);
      return true;
    }
    return this.applyGuestEvent(event);
  }

  private applyGuestEvent(event: AuthoritativeMatchEvent): boolean {
    if (!this.replicaValue) return false;
    const result: ClientReplicaEventResult = this.replicaValue.applyEvent({
      eventId: event.eventId,
      revision: event.revision,
      hostTick: event.hostTick,
      type: event.type,
      payload: event.payload,
    });
    if (!result.accepted) return false;
    const prediction = event.type === 'shotFired' && typeof event.payload.predictionInputSequence === 'number'
      ? event.payload.predictionInputSequence : null;
    const matched = prediction !== null && this.predictedPresentationIds.delete(prediction);
    try {
      this.options.onAuthoritativeEvent?.(event, matched);
    } catch {
      // Audio/VFX/HUD observers cannot be reclassified as remote protocol
      // abuse after the authoritative event was already deduplicated.
    }
    return true;
  }

  private async handleControl(peerId: string, data: ArrayBuffer | ArrayBufferView): Promise<boolean> {
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength > 1 && bytes[1] === MATCH_PACKET_TYPES.snapshot) {
      if (this.role !== 'guest' || peerId !== this.context.hostPeerId) throw new Error('Reliable keyframe sender is not the host');
      return this.consumeSnapshot(data);
    }
    const packet = decodeReliablePacket(data, this.sessionId);
    if (!this.acceptReliableSequence(peerId, 'control', packet.sequence)) return false;
    if (this.role === 'host') return this.handleHostControl(peerId, packet.kind, packet.payload);
    if (peerId !== this.context.hostPeerId) throw new Error('Control sender is not the host');
    return this.handleGuestControl(packet.kind, packet.payload);
  }

  private handleHostControl(peerId: string, kind: ReliablePacketKind, payload: unknown): boolean {
    if (!this.hostBarrier || !this.hostSessionValue) throw new Error('Host runtime is not prepared');
    if (kind === 'ready-to-simulate') {
      const control = validateMatchStartControl(payload);
      if (!this.hostBarrier.acceptReady(peerId, control)) throw new Error('Invalid or duplicate match readiness');
      this.reportBarrier();
      this.maybeBeginCountdown();
      return true;
    }
    if (kind === 'load-failed') {
      const value = record(payload);
      exactControlKeys(value, ['participantId']);
      const participantId = identifierValue(value.participantId, 'load failed participantId');
      if (!this.hostBarrier.markLoadFailed(peerId, participantId)) {
        throw new Error('Invalid match load failure report');
      }
      this.reportBarrier();
      return true;
    }
    if (kind === 'keyframe-request' && this.stateValue === 'active') {
      this.acceptKeyframeRequest(peerId);
      return true;
    }
    if (kind === 'tactical-ping-request' && this.stateValue === 'active') {
      const value = record(payload);
      return this.hostSessionValue.requestTacticalPing(
        peerId,
        finiteNumber(value.x, 'ping x'),
        finiteNumber(value.z, 'ping z'),
      ) !== null;
    }
    throw new Error(`Host rejected control packet ${kind}`);
  }

  private async handleGuestControl(kind: ReliablePacketKind, payload: unknown): Promise<boolean> {
    if (kind === 'match-prepare') {
      if (!this.guestBarrier || this.payloadValue) throw new Error('Duplicate match preparation');
      const control = validateMatchStartControl(payload);
      if (control.type !== 'match-prepare') throw new Error('Invalid match preparation payload');
      let ready;
      try {
        ready = await this.guestBarrier.prepare(control, {
          protocolVersion: MATCH_PROTOCOL_VERSION,
          protocolSession: this.context.matchSessionBinding,
          buildHash: this.context.snapshot.build.buildId,
        });
      } catch (error) {
        this.sendControl(this.context.hostPeerId, 'load-failed', {
          participantId: this.context.localParticipantId,
        }, this.networkTick);
        this.setState('failed');
        throw error;
      }
      if (this.stateValue === 'disposed' || this.stateValue === 'ended' || this.stateValue === 'failed') return false;
      this.payloadValue = control;
      return this.sendControl(this.context.hostPeerId, 'ready-to-simulate', ready, this.networkTick);
    }
    if (kind === 'start-countdown') {
      if (!this.guestBarrier || !this.payloadValue || !this.preparedMap) throw new Error('Countdown arrived before preparation');
      const control = validateMatchStartControl(payload);
      const countdown = this.guestBarrier.acceptCountdown(control);
      const localActorId = localActorIdForPayload(this.payloadValue, this.context);
      this.replicaValue = await (this.options.createGuestReplica?.({
        payload: this.payloadValue,
        map: this.preparedMap,
        localActorId,
      }) ?? new ClientReplica<S>({ localActorId }));
      await this.options.onRuntimeReady?.('guest', this.payloadValue);
      this.countdownTarget = countdown.startHostTick;
      this.networkTick = Math.max(this.networkTick, Math.max(0, countdown.startHostTick - ONLINE_START_COUNTDOWN_TICKS));
      this.setState('countdown');
      return true;
    }
    if (kind === 'reconnect-result') {
      const value = record(payload);
      const accepted = booleanValue(value.accepted, 'reconnect accepted');
      const alive = booleanValue(value.alive, 'reconnect alive');
      if (!accepted) {
        exactControlKeys(value, ['accepted', 'alive']);
        if (alive) throw new Error('Rejected reconnect cannot report a live Actor');
        try {
          this.options.onReconnectResult?.(false, false);
        } catch {
          // Reconnect UI cannot turn an authenticated control result into a
          // protocol violation.
        }
        return false;
      }
      exactControlKeys(value, ['accepted', 'actorId', 'alive', 'participantId', 'startPayload']);
      const participantId = identifierValue(value.participantId, 'reconnect participantId');
      if (participantId !== this.context.localParticipantId) throw new Error('Reconnect participant binding mismatch');
      const actorId = integerValue(value.actorId, 1, 0xffff, 'reconnect actorId');
      const startPayload = validateMatchStartPayload(value.startPayload, {
        protocolVersion: MATCH_PROTOCOL_VERSION,
        protocolSession: this.context.matchSessionBinding,
        buildHash: this.context.snapshot.build.buildId,
      });
      reconnectActorIdForPayload(startPayload, this.context, actorId);
      if (this.payloadValue) assertSameMatchPayload(this.payloadValue, startPayload);

      this.awaitingRecoveryKeyframe = true;
      // The authenticated host schedules a requester-only reliable keyframe
      // before this result can be delivered. Suppress a redundant guest
      // request, which would otherwise be misclassified as recovery abuse.
      this.keyframeRequested = true;
      this.currentGuestInput = emptyCommand();
      this.recentInputs.length = 0;
      this.predictedPresentationIds.clear();
      if (!this.replicaValue) {
        const input = await this.validateAndLoadGuest(startPayload, actorId);
        const replica = await (this.options.createGuestReplica?.(input) ?? new ClientReplica<S>({ localActorId: actorId }));
        this.payloadValue = startPayload;
        this.replicaValue = replica;
        try {
          await this.options.onRuntimeReady?.('guest', startPayload);
          this.countdownTarget = null;
          this.setState('active');
          await this.options.onActivated?.('guest', startPayload);
        } catch (error) {
          this.releaseRuntime();
          this.setState('failed');
          throw error;
        }
      } else {
        if (!this.preparedMap || !this.payloadValue) throw new Error('Reconnect runtime is incomplete');
        this.countdownTarget = null;
        this.setState('active');
      }
      this.hostDisconnectDeadline = null;
      try {
        this.options.onReconnectResult?.(true, alive);
      } catch {
        // The replica/control lifecycle is already committed.
      }
      return true;
    }
    if (kind === 'host-visibility') {
      const value = record(payload);
      exactControlKeys(value, ['hidden']);
      const hidden = booleanValue(value.hidden, 'host visibility');
      try {
        this.options.onHostVisibilityChange?.(hidden);
      } catch {
        // Presentation warnings cannot turn authenticated host state into a
        // protocol failure.
      }
      return true;
    }
    if (kind === 'host-disconnected') {
      const value = record(payload);
      exactControlKeys(value, ['reason']);
      const reason = value.reason;
      if (reason !== 'cancelled' && reason !== 'host-ended' && reason !== 'host-inactive') {
        throw new Error('Invalid host-disconnected reason');
      }
      this.terminate(reason);
      return true;
    }
    throw new Error(`Guest rejected control packet ${kind}`);
  }

  private consumeSnapshot(data: ArrayBuffer | ArrayBufferView): boolean {
    if (!this.replicaValue) throw new Error('Replica is not initialized');
    try {
      const decoded = this.guestStateDecoder.add(data);
      if (!decoded) return false;
      const result: ClientReplicaSnapshotResult = this.replicaValue.applySnapshot({
        state: decoded.state,
        revision: decoded.revision,
        hostTick: decoded.hostTick,
        ackInputSeq: decoded.acknowledgedInputSequence,
        receivedAt: this.nowMs(),
        roundTripTimeMs: this.guestRttMs,
      });
      if (!result.accepted) return false;
      this.guestLastAckHostTick = decoded.hostTick;
      // clientTick remains in the guest's own monotonic clock domain. The host
      // maps shots through lastAckHostTick; delayed or reordered snapshots must
      // never move the client clock and turn valid input into future/stale data.
      if (decoded.full) {
        this.keyframeRequested = false;
        this.awaitingRecoveryKeyframe = false;
        this.flushPendingGuestEvents();
      }
      return true;
    } catch (error) {
      if (error instanceof MatchStateCodecError && error.code === 'keyframe-required') {
        this.requestRecoveryKeyframe();
        return false;
      }
      throw error;
    }
  }

  private async validateAndLoadGuest(
    payload: MatchStartPayload,
    reconnectActorId?: number,
  ): Promise<GuestReplicaFactoryInput> {
    const map = await this.options.resolveMap(payload.mapId);
    const mapHash = await computeGameplayMapHash(map);
    if (mapHash !== payload.mapHash) throw new Error('Loaded map hash does not match the host payload');
    const localActorId = reconnectActorId === undefined
      ? localActorIdForPayload(payload, this.context)
      : reconnectActorIdForPayload(payload, this.context, reconnectActorId);
    const input = Object.freeze({ payload, map, localActorId });
    await this.options.loadGuest?.(input);
    this.guestStateDecoder.configureDestructibles(map.destructibles.map((value) => value.stableId));
    this.preparedMap = map;
    return input;
  }

  private maybeBeginCountdown(): void {
    if (!this.hostBarrier || this.countdownTarget !== null) return;
    const countdown = this.hostBarrier.tryStart(this.networkTick, ONLINE_START_COUNTDOWN_TICKS);
    if (!countdown) return;
    this.countdownTarget = countdown.startHostTick;
    for (const peerId of this.activeGuestPeerIds) this.sendControl(peerId, 'start-countdown', countdown, this.networkTick);
    this.setState('countdown');
    this.reportBarrier();
  }

  private activate(): void {
    if (!this.payloadValue || this.countdownTarget === null) return;
    if (this.role === 'host' && !this.hostSessionValue || this.role === 'guest' && !this.replicaValue) {
      this.terminate('protocol-error');
      return;
    }
    this.countdownTarget = null;
    this.setState('active');
    void Promise.resolve(this.options.onActivated?.(this.role, this.payloadValue)).catch((error) => {
      this.options.onProtocolError?.(this.context.hostPeerId, asError(error));
      this.terminate('protocol-error');
    });
  }

  private sendGuestInputTick(): void {
    if (!this.replicaValue) return;
    this.guestSimulationTick = nextUint32(this.guestSimulationTick);
    const sampled = this.options.sampleLocalInput?.();
    const command = cloneCommand(sampled ?? this.currentGuestInput);
    const submittedCommand = Object.freeze(command);
    const inputSeq = this.replicaValue.submitInput(submittedCommand, ONLINE_FIXED_DT);
    if (!Number.isSafeInteger(inputSeq) || inputSeq <= 0 || inputSeq > 0xffff_ffff) {
      this.terminate('protocol-error');
      return;
    }
    let predictedPresentation = command.fireHeld || command.firePressed;
    if (this.options.onLocalInputSubmitted) {
      try {
        predictedPresentation = this.options.onLocalInputSubmitted(inputSeq, submittedCommand) === true;
      } catch {
        // Presentation observers cannot interrupt input delivery; a later
        // host confirmation remains eligible to play when prediction failed.
        predictedPresentation = false;
      }
    }
    if (predictedPresentation) this.predictedPresentationIds.add(inputSeq);
    const packet = encodeInputCommandPacket(submittedCommand, {
      sessionId: this.sessionId,
      inputSeq,
      clientTick: this.guestSimulationTick,
      lastAckHostTick: this.guestLastAckHostTick,
      shotTick: command.fireHeld || command.firePressed ? this.guestSimulationTick : null,
      recentFrames: this.recentInputs.slice(-3),
    });
    this.room.sendGameInput(packet);
    this.recentInputs.push(Object.freeze({ inputSeq, clientTick: this.guestSimulationTick, command: submittedCommand }));
    if (this.recentInputs.length > 3) this.recentInputs.splice(0, this.recentInputs.length - 3);
    for (const predicted of this.predictedPresentationIds) if (predicted + 256 < inputSeq) this.predictedPresentationIds.delete(predicted);
    this.currentGuestInput = commandWithoutEdges(command);
  }

  private encodeHostSnapshot(
    view: GameStateView,
    options: SnapshotEncodeOptions,
  ): EncodedSnapshot {
    let encoder = this.hostSnapshotEncoders.get(options.viewerParticipantId);
    if (!encoder) {
      if (!this.preparedMap) throw new Error('Host map is not prepared');
      encoder = new MatchStateEncoder(
        this.sessionId,
        options.viewerActorId,
        this.preparedMap.destructibles.map((value) => value.stableId),
      );
      this.hostSnapshotEncoders.set(options.viewerParticipantId, encoder);
    }
    const recovery = this.pendingRecoveryKeyframes.get(options.viewerPeerId);
    const forceRecovery = recovery?.pending === true;
    const previousRecovery = forceRecovery ? this.recoverySnapshotPackets.get(options.viewerPeerId) : undefined;
    const encoded = previousRecovery ?? encoder.encode(view, {
      ...options,
      // HostAuthoritativeMatchSession decides whether a snapshot is full
      // before invoking this callback. A guest-specific recovery request must
      // still upgrade only this viewer's packet.
      full: options.full || forceRecovery,
    });
    if (forceRecovery) {
      // Reuse the exact chunks until every chunk is accepted by the local
      // DataChannel. This prevents repeated congestion from leaving a trail
      // of incomplete snapshot IDs in the guest reassembler.
      this.recoverySnapshotPackets.set(options.viewerPeerId, encoded);
      this.recoverySnapshotAttempts.set(options.viewerPeerId, {
        sequence: options.sequence,
        packetCount: encoded.packets.length,
        sentPackets: 0,
      });
    }
    return encoded;
  }

  private publishHostEvent(event: AuthoritativeMatchEvent): void {
    if (event.type === 'playerRejoin' && typeof event.payload.newPeerId === 'string') {
      this.pendingReconnectPresenceEvents.set(event.payload.newPeerId, {
        event,
        delivered: false,
      });
    }
    const recipients = event.type === 'tacticalPing' && Array.isArray(event.payload.recipients)
      ? event.payload.recipients.filter((value): value is string => (
        typeof value === 'string'
        && this.activeGuestPeerIds.has(value)
        && this.connectedGuestPeerIds.has(value)
      ))
      : [...this.activeGuestPeerIds].filter((peerId) => this.connectedGuestPeerIds.has(peerId));
    const packet = encodeAuthoritativeEventPacket(event, this.sessionId);
    for (const peerId of recipients) this.sendReliableEvent(peerId, event, packet);
    if (this.shouldPresentHostEvent(event)) {
      try {
        this.options.onAuthoritativeEvent?.(event, false);
      } catch {
        // Host-local presentation is outside simulation and transport state.
      }
    }
  }

  private shouldPresentHostEvent(event: AuthoritativeMatchEvent): boolean {
    // Presence has a dedicated host-local callback. The authoritative event
    // still travels to every guest, but must not create a second host notice.
    if (event.type === 'playerLeave' || event.type === 'playerRejoin') return false;
    if (event.type !== 'tacticalPing' || !this.payloadValue) return true;
    const senderActorId = event.payload.senderActorId;
    if (typeof senderActorId !== 'number') return false;
    const localActorId = localActorIdForPayload(this.payloadValue, this.context);
    if (senderActorId === localActorId) return true;
    const localTeam = this.payloadValue.roster.find((entry) => entry.actorId === localActorId)?.teamId ?? null;
    const senderTeam = this.payloadValue.roster.find((entry) => entry.actorId === senderActorId)?.teamId ?? null;
    return localTeam !== null && senderTeam === localTeam;
  }

  private flushPendingReconnectResult(peerId: string): boolean {
    const pending = this.pendingReconnectResults.get(peerId);
    if (!pending || !this.hostSessionValue || !this.connectedGuestPeerIds.has(peerId)) return false;
    if (pending.accepted && !this.payloadValue) return false;
    const payload = pending.accepted
      ? { ...pending, startPayload: this.payloadValue! }
      : pending;
    const presence = this.pendingReconnectPresenceEvents.get(peerId);
    if (presence && !presence.delivered) {
      const result = this.sendReliableEvent(
        peerId,
        presence.event,
        encodeAuthoritativeEventPacket(presence.event, this.sessionId),
      );
      if (result !== 'sent') return false;
      presence.delivered = true;
    }
    const sent = this.sendControl(peerId, 'reconnect-result', payload, this.networkTick);
    if (!sent) return false;
    this.pendingReconnectResults.delete(peerId);
    this.pendingReconnectPresenceEvents.delete(peerId);
    if (pending.accepted) {
      this.activeGuestPeerIds.add(peerId);
      this.pendingRecoveryKeyframes.set(peerId, Object.freeze({
        lastAcceptedHostTick: this.hostSessionValue.match.hostTick,
        pending: true,
      }));
    } else {
      this.connectedGuestPeerIds.delete(peerId);
      this.room.disconnectGamePeer(peerId);
    }
    return true;
  }

  private flushPendingGuestEvents(): void {
    if (!this.replicaValue || this.awaitingRecoveryKeyframe) return;
    const pending = this.pendingGuestEvents.splice(0, this.pendingGuestEvents.length);
    for (const event of pending) this.applyGuestEvent(event);
  }

  private sendReliableEvent(
    peerId: string,
    event: AuthoritativeMatchEvent,
    packet: ArrayBuffer,
  ): ReliableEventSendResult {
    let queue = this.pendingReliableEventQueues.get(peerId);
    if (queue) {
      // A queued packet always has priority over a newer event. This keeps
      // event-channel ordering intact when a transient buffer rejection is
      // followed by a successful send.
      if (queue.some((pending) => pending.eventId === event.eventId)) return 'queued';
      if (queue.length >= MAX_PENDING_RELIABLE_EVENTS_PER_PEER) {
        this.failReliableEventBacklog(peerId);
        return 'rejected';
      }
      queue.push(Object.freeze({ eventId: event.eventId, packet }));
      return 'queued';
    }
    if (this.room.sendGameMessage(peerId, 'event', packet)) return 'sent';
    queue = [Object.freeze({ eventId: event.eventId, packet })];
    this.pendingReliableEventQueues.set(peerId, queue);
    return 'queued';
  }

  private flushPendingReliableEvents(peerId?: string): void {
    const peers = peerId === undefined ? [...this.pendingReliableEventQueues.keys()] : [peerId];
    for (const targetPeerId of peers) {
      if (!this.connectedGuestPeerIds.has(targetPeerId)) continue;
      const queue = this.pendingReliableEventQueues.get(targetPeerId);
      if (!queue) continue;
      while (queue.length > 0) {
        const pending = queue[0]!;
        if (!this.room.sendGameMessage(targetPeerId, 'event', pending.packet)) break;
        queue.shift();
        this.markReliableEventDelivered(targetPeerId, pending.eventId);
      }
      if (queue.length === 0) this.pendingReliableEventQueues.delete(targetPeerId);
    }
  }

  private markReliableEventDelivered(peerId: string, eventId: number): void {
    const presence = this.pendingReconnectPresenceEvents.get(peerId);
    if (presence?.event.eventId === eventId) presence.delivered = true;
  }

  private failReliableEventBacklog(peerId: string): void {
    const error = new Error('Reliable authoritative event queue exceeded its bound');
    // Continuing to simulate an Actor whose reliable event stream cannot be
    // delivered would make the peer's replica permanently non-authoritative.
    // A reconnect receives a complete authoritative keyframe. Discard this
    // stale presentation backlog so a full queue cannot reject the mandatory
    // rejoin event and deadlock the replacement connection.
    this.pendingReliableEventQueues.delete(peerId);
    this.connectedGuestPeerIds.delete(peerId);
    this.activeGuestPeerIds.delete(peerId);
    try {
      this.hostSessionValue?.markDisconnected(peerId);
    } catch {
      // A lifecycle observer must not prevent the transport from being closed.
    }
    try {
      this.room.disconnectGamePeer(peerId);
    } catch {
      // The room owns the underlying close operation; keep the queue bounded
      // even if a test or adapter reports a close failure.
    }
    try {
      this.options.onProtocolError?.(peerId, error);
    } catch {
      // Protocol observers cannot change the already-failed peer lifecycle.
    }
  }

  private migratePeerRetryState(oldPeerId: string, newPeerId: string): void {
    const oldQueue = this.pendingReliableEventQueues.get(oldPeerId);
    const newQueue = this.pendingReliableEventQueues.get(newPeerId);
    if (oldQueue) {
      this.pendingReliableEventQueues.delete(oldPeerId);
      if (!newQueue) this.pendingReliableEventQueues.set(newPeerId, oldQueue);
      else {
        for (const pending of oldQueue) {
          if (newQueue.some((candidate) => candidate.eventId === pending.eventId)) continue;
          if (newQueue.length >= MAX_PENDING_RELIABLE_EVENTS_PER_PEER) {
            this.failReliableEventBacklog(newPeerId);
            break;
          }
          newQueue.push(pending);
        }
      }
    }
    // A new DataChannel generation always receives a freshly scheduled full
    // keyframe after its reconnect result. Never inherit an old pending/rate
    // window without its matching packet attempt.
    this.pendingRecoveryKeyframes.delete(oldPeerId);
    this.pendingRecoveryKeyframes.delete(newPeerId);
    this.recoverySnapshotPackets.delete(oldPeerId);
    this.recoverySnapshotPackets.delete(newPeerId);
    this.recoverySnapshotAttempts.delete(oldPeerId);
    this.recoverySnapshotAttempts.delete(newPeerId);
    this.pendingReconnectResults.delete(oldPeerId);
    this.pendingReconnectPresenceEvents.delete(oldPeerId);
  }

  private acceptKeyframeRequest(peerId: string): void {
    if (!this.connectedGuestPeerIds.has(peerId) || !this.activeGuestPeerIds.has(peerId)) {
      throw new Error('Keyframe request is not from an active guest');
    }
    const hostTick = this.hostSessionValue?.match.hostTick;
    if (hostTick === undefined) throw new Error('Host runtime is not prepared');
    const previous = this.pendingRecoveryKeyframes.get(peerId);
    if (previous?.pending) throw new Error('Duplicate keyframe request while recovery is pending');
    if (previous && hostTick - previous.lastAcceptedHostTick < KEYFRAME_REQUEST_MIN_INTERVAL_TICKS) {
      throw new Error('Keyframe request rate exceeded');
    }
    this.pendingRecoveryKeyframes.set(peerId, Object.freeze({
      lastAcceptedHostTick: hostTick,
      pending: true,
    }));
  }

  private sendHostPacket(
    peerId: string,
    channel: 'control' | 'event' | 'snapshot',
    data: ArrayBuffer,
    sequence?: number,
  ): boolean {
    const attempt = sequence === undefined ? undefined : this.recoverySnapshotAttempts.get(peerId);
    const recoveryChunk = attempt?.sequence === sequence;
    // HostMatchSession chooses the channel before calling the injected
    // encoder. A requester-only full snapshot therefore needs this narrow
    // upgrade when the session still labels it as a lossy delta snapshot.
    const actualChannel = recoveryChunk ? 'control' : channel;
    const sent = this.room.sendGameMessage(peerId, actualChannel, data, sequence);
    if (sent && recoveryChunk) this.markRecoverySnapshotPacketSent(peerId, sequence!);
    return sent;
  }

  private markRecoverySnapshotPacketSent(peerId: string, sequence: number): void {
    const attempt = this.recoverySnapshotAttempts.get(peerId);
    if (!attempt || attempt.sequence !== sequence) return;
    attempt.sentPackets += 1;
    if (attempt.sentPackets < attempt.packetCount) return;
    this.recoverySnapshotAttempts.delete(peerId);
    this.recoverySnapshotPackets.delete(peerId);
    const recovery = this.pendingRecoveryKeyframes.get(peerId);
    if (recovery?.pending) {
      this.pendingRecoveryKeyframes.set(peerId, Object.freeze({
        ...recovery,
        pending: false,
      }));
    }
  }

  private hostTransport(): HostMatchTransport {
    return Object.freeze({
      send: (peerId: string, channel: 'control' | 'event' | 'snapshot', data: ArrayBuffer, sequence?: number) => (
        this.sendHostPacket(peerId, channel, data, sequence)
      ),
      disconnect: (peerId: string) => { this.room.disconnectGamePeer(peerId); },
    });
  }

  private sendControl(
    peerId: string,
    kind: Exclude<ReliablePacketKind, 'authoritative-event'>,
    payload: unknown,
    tick: number,
  ): boolean {
    const packet = encodeReliablePacket({
      kind,
      sessionId: this.sessionId,
      sequence: this.nextReliableSequence(),
      tick,
      payload: canonicalBinaryValue(payload),
    });
    return this.room.sendGameMessage(peerId, 'control', packet);
  }

  private nextReliableSequence(): number {
    this.reliableSequence = nextUint32(this.reliableSequence);
    return this.reliableSequence;
  }

  private acceptReliableSequence(peerId: string, channel: 'control' | 'event', sequence: number): boolean {
    const key = `${peerId}:${channel}`;
    const highest = this.reliableInboundSequences.get(key) ?? 0;
    if (sequence === 0 || sequence <= highest) return false;
    this.reliableInboundSequences.set(key, sequence);
    return true;
  }

  private reportBarrier(): void {
    const status = this.hostBarrier?.status();
    if (status) this.options.onBarrierStatus?.(status);
  }

  private checkHostDisconnectDeadline(): void {
    if (this.role !== 'guest' || this.hostDisconnectDeadline === null) return;
    if (this.nowMs() >= this.hostDisconnectDeadline) this.terminate('host-disconnected');
  }

  private protocolFailure(peerId: string, error: Error): false {
    const count = (this.violations.get(peerId) ?? 0) + 1;
    this.violations.set(peerId, count);
    this.options.onProtocolError?.(peerId, error);
    if (count >= MAX_COORDINATOR_VIOLATIONS) {
      this.room.disconnectGamePeer(peerId);
      if (this.role === 'host') this.hostSessionValue?.markDisconnected(peerId);
      else if (peerId === this.context.hostPeerId) this.terminate('protocol-error');
    }
    return false;
  }

  private terminate(reason: OnlineMatchEndReason): void {
    if (this.stateValue === 'ended' || this.stateValue === 'disposed') return;
    this.releaseRuntime();
    this.setState('ended');
    for (const peerId of this.knownPeerIds) this.room.disconnectGamePeer(peerId);
    void Promise.resolve(this.options.onEnd?.(reason)).catch((error) => {
      this.options.onProtocolError?.(this.context.hostPeerId, asError(error));
    });
  }

  private releaseRuntime(): void {
    this.hostSessionValue?.dispose();
    this.hostSessionValue = null;
    this.replicaValue?.reset();
    this.replicaValue = null;
    this.hostBarrier?.cancel();
    this.hostBarrier = null;
    this.guestBarrier = null;
    this.guestStateDecoder.reset();
    for (const encoder of this.hostSnapshotEncoders.values()) encoder.reset();
    this.hostSnapshotEncoders.clear();
    this.inputValidators.clear();
    this.reliableInboundSequences.clear();
    this.eventDedup.reset();
    this.pendingReconnectResults.clear();
    this.pendingReconnectPresenceEvents.clear();
    this.pendingReliableEventQueues.clear();
    this.pendingRecoveryKeyframes.clear();
    this.recoverySnapshotPackets.clear();
    this.recoverySnapshotAttempts.clear();
    this.pendingGuestEvents.length = 0;
    this.connectedGuestPeerIds.clear();
    this.actorIdByParticipant.clear();
    this.predictedPresentationIds.clear();
    this.recentInputs.length = 0;
    this.guestSimulationTick = 0;
    this.guestRttMs = 0;
    this.currentGuestInput = emptyCommand();
    this.hostDisconnectDeadline = null;
    this.hostHiddenSinceMs = null;
    this.keyframeRequested = false;
    this.awaitingRecoveryKeyframe = false;
    this.options.onDisposeRuntime?.();
  }

  private localParticipant() {
    const participant = this.context.snapshot.participants.find(
      (value) => value.participantId === this.context.localParticipantId,
    );
    if (!participant) throw new Error('Local participant is absent from the final lobby');
    return participant;
  }

  private ensureUsable(): void {
    if (this.stateValue === 'disposed' || this.stateValue === 'ended' || this.stateValue === 'failed') {
      throw new Error('Online match coordinator is not usable');
    }
  }

  private setState(state: OnlineMatchCoordinatorState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.options.onStateChange?.(state);
  }
}

function buildPeerBindings(payload: MatchStartPayload, context: OnlineRoomMatchContext): readonly MatchPeerBinding[] {
  const bindings: MatchPeerBinding[] = [];
  for (const participant of context.snapshot.participants) {
    if (participant.participantId === context.localParticipantId) continue;
    const entry = payload.roster.find((candidate) => candidate.ownership.kind !== 'bot'
      && candidate.ownership.peerId === participant.peerId);
    if (!entry || entry.ownership.kind === 'bot') throw new Error('Final roster does not bind every admitted guest');
    bindings.push(Object.freeze({
      participantId: participant.participantId,
      peerId: participant.peerId,
      actorId: entry.actorId,
      teamId: entry.teamId,
    }));
  }
  return Object.freeze(bindings);
}

function rejectedParticipantReconnect(): PreparedParticipantReconnect {
  return Object.freeze({
    accepted: false,
    alive: false,
    commit: () => undefined,
    rollback: () => undefined,
  });
}

function localActorIdForPayload(payload: MatchStartPayload, context: OnlineRoomMatchContext): number {
  const participant = context.snapshot.participants.find(
    (value) => value.participantId === context.localParticipantId,
  );
  if (!participant) throw new Error('Local participant is absent from the lobby');
  const entry = payload.roster.find((candidate) => candidate.ownership.kind !== 'bot'
    && candidate.ownership.peerId === participant.peerId);
  if (!entry) throw new Error('Local participant has no final Actor binding');
  return entry.actorId;
}

function reconnectActorIdForPayload(
  payload: MatchStartPayload,
  context: OnlineRoomMatchContext,
  actorId: number,
): number {
  const participant = context.snapshot.participants.find(
    (value) => value.participantId === context.localParticipantId,
  );
  if (!participant) throw new Error('Reconnect participant is absent from the locked lobby');
  const entry = payload.roster.find((candidate) => candidate.actorId === actorId);
  if (!entry || entry.ownership.kind === 'bot' || entry.slotId !== participant.slotId) {
    throw new Error('Reconnect Actor does not match the authenticated roster slot');
  }
  return actorId;
}

function assertSameMatchPayload(current: MatchStartPayload, reconnect: MatchStartPayload): void {
  if (current.protocolVersion !== reconnect.protocolVersion
    || current.protocolSession !== reconnect.protocolSession
    || current.buildHash !== reconnect.buildHash
    || current.mapId !== reconnect.mapId
    || current.mapHash !== reconnect.mapHash
    || current.seed !== reconnect.seed
    || current.mode !== reconnect.mode
    || current.difficulty !== reconnect.difficulty
    || current.startHostTick !== reconnect.startHostTick
    || current.roster.length !== reconnect.roster.length
    || current.skins.length !== reconnect.skins.length) {
    throw new Error('Reconnect payload does not identify the active match');
  }
  for (let index = 0; index < current.roster.length; index++) {
    const left = current.roster[index]!;
    const right = reconnect.roster[index]!;
    if (left.slotId !== right.slotId || left.actorId !== right.actorId
      || left.displayName !== right.displayName || left.connectionState !== right.connectionState
      || left.teamId !== right.teamId || left.skinId !== right.skinId
      || left.accentColor !== right.accentColor || left.ownership.kind !== right.ownership.kind
      || (left.ownership.kind !== 'bot' && right.ownership.kind !== 'bot'
        && left.ownership.peerId !== right.ownership.peerId)
      || current.skins[index] !== reconnect.skins[index]) {
      throw new Error('Reconnect payload changed the locked roster');
    }
  }
}

function cloneCommand(command: Readonly<InputCommand>): InputCommand {
  const clone = emptyCommand();
  for (const key of Object.keys(clone) as Array<keyof InputCommand>) clone[key] = command[key] as never;
  return clone;
}

function commandWithoutEdges(command: Readonly<InputCommand>): InputCommand {
  return {
    ...cloneCommand(command),
    jumpPressed: false,
    crouchPressed: false,
    firePressed: false,
    reloadPressed: false,
    interactPressed: false,
    slotRequest: null,
    meleePressed: false,
    dropWeaponPressed: false,
    dashPressed: false,
    grapplePressed: false,
    grappleRelease: false,
    poundPressed: false,
    shieldPressed: false,
    medkitPressed: false,
  };
}

function binaryData(value: unknown): ArrayBuffer | ArrayBufferView | null {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  return null;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid control payload');
  return value as Readonly<Record<string, unknown>>;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`);
  return value;
}

function integerValue(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function identifierValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error(`Invalid ${label}`);
  return value;
}

function exactControlKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('Reconnect result has unexpected fields');
  }
}

function nextUint32(value: number): number {
  const next = (value + 1) >>> 0;
  if (next === 0) throw new Error('Online match sequence exhausted');
  return next;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
