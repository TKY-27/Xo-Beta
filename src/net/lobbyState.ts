import type { Difficulty } from '../core/balance';
import type { SkinId } from '../core/settings';
import {
  buildRoster,
  type MatchMode,
  type RosterEntry,
  type TeamId,
} from '../sim/roster';
import type { MapId } from '../world/index';
import {
  buildsMatch,
  MAX_DISPLAY_NAME_LENGTH,
  normalizeBuildIdentity,
  ProtocolSessionGuard,
  ProtocolValidationError,
  type BuildIdentity,
  type Handshake,
  type ProtocolMessage,
  validateHandshake,
  validateProtocolMessage,
} from './protocol';

export const MAX_HUMAN_PARTICIPANTS = 4;
export const MAX_LOBBY_HUMANS = MAX_HUMAN_PARTICIPANTS;

export type LobbyErrorCode =
  | 'invalid-lobby'
  | 'not-authorized'
  | 'peer-claims-host'
  | 'duplicate-peer'
  | 'duplicate-participant'
  | 'room-full'
  | 'unknown-peer'
  | 'unknown-participant'
  | 'build-mismatch'
  | 'stale-session'
  | 'participant-ready'
  | 'match-locked'
  | 'invalid-state';

export class LobbyError extends Error {
  readonly code: LobbyErrorCode;

  constructor(code: LobbyErrorCode, message: string) {
    super(message);
    this.name = 'LobbyError';
    this.code = code;
  }
}

export interface LobbyConfig {
  readonly mapId: MapId;
  readonly mode: MatchMode;
  /** Bot fill is kept explicit so the UI can toggle it independently. */
  readonly botFill: boolean;
  readonly difficulty: Difficulty;
  readonly seed: number;
}

export interface LobbyStateOptions {
  readonly roomId: string;
  readonly hostPeerId: string;
  readonly build: BuildIdentity;
  readonly hostParticipantId?: string;
  readonly hostDisplayName?: string;
  readonly hostSkinId?: SkinId;
  readonly mapId?: MapId;
  readonly mode?: MatchMode;
  readonly botFill?: boolean;
  readonly difficulty?: Difficulty;
  readonly seed?: number;
  readonly protocolSession?: string;
  readonly channelOpen?: boolean;
}

export interface LobbyParticipant {
  readonly participantId: string;
  readonly peerId: string;
  readonly slotId: number;
  readonly displayName: string;
  readonly skinId: SkinId;
  readonly teamId: TeamId | null;
  readonly ready: boolean;
  readonly isHost: boolean;
  readonly connected: boolean;
  readonly channelsOpen: boolean;
  readonly build: BuildIdentity;
  readonly protocolSession: string;
}

export interface LobbySnapshot {
  readonly revision: number;
  readonly roomId: string;
  readonly hostPeerId: string;
  readonly matchLocked: boolean;
  readonly build: BuildIdentity;
  readonly config: LobbyConfig;
  readonly effectiveMode: MatchMode;
  readonly participants: readonly LobbyParticipant[];
  /** Canonical host-computed Phase 2 roster shown identically to every peer. */
  readonly rosterPreview: LobbyRosterPreview;
}

export interface LobbyRosterPreview {
  readonly revision: number;
  readonly roomId: string;
  readonly mapId: MapId;
  readonly mode: MatchMode;
  readonly configuredMode: MatchMode;
  readonly botFill: boolean;
  readonly difficulty: Difficulty;
  readonly seed: number;
  readonly humans: readonly RosterEntry[];
  readonly roster: readonly RosterEntry[];
  readonly valid: boolean;
  readonly error: string | null;
}

export type StartBlocker =
  | 'match-locked'
  | 'protocol-build-mismatch'
  | 'guest-not-ready'
  | 'invalid-final-roster'
  | 'channels-closed';

export interface StartEligibility {
  readonly eligible: boolean;
  readonly protocolBuildMatch: boolean;
  readonly guestsReady: boolean;
  readonly validFinalRoster: boolean;
  readonly channelsOpen: boolean;
  readonly blockers: readonly StartBlocker[];
  readonly preview: LobbyRosterPreview;
}

export interface StartRequestResult {
  readonly accepted: boolean;
  readonly launched: false;
  readonly eligibility: StartEligibility;
}

export interface LobbyJoinRequest {
  readonly handshake: Handshake;
  readonly displayName?: string;
  readonly skinId?: SkinId;
  readonly teamId?: TeamId | null;
  /** Guest slots are 1..3; null asks the host to assign the next free slot. */
  readonly requestedSlot?: number | null;
  readonly channelOpen?: boolean;
}

export interface LobbyCommandResult {
  readonly accepted: true;
  readonly snapshot: LobbySnapshot;
  readonly start?: StartRequestResult;
}

const MAP_IDS: readonly MapId[] = Object.freeze(['neocity', 'oldfront', 'eden', 'ashara']);
const MODES: readonly MatchMode[] = Object.freeze([
  'ffa-bot-fill',
  'ffa',
  'teams',
  'teams-bot-fill',
  'humans-vs-bots',
]);
const DIFFICULTIES: readonly Difficulty[] = Object.freeze(['normal', 'hard', 'elite', 'nightmare']);
const SKINS: readonly SkinId[] = Object.freeze([
  'vanguard',
  'pathfinder',
  'specter',
  'striker',
  'warden',
  'nova',
]);

const HOST_COMMANDS = new Set<ProtocolMessage['type']>([
  'set-map',
  'set-mode',
  'set-bot-fill',
  'set-difficulty',
  'set-team',
  'start-request',
]);

interface MutableParticipant {
  participantId: string;
  peerId: string;
  slotId: number;
  displayName: string;
  skinId: SkinId;
  teamId: TeamId | null;
  ready: boolean;
  isHost: boolean;
  connected: boolean;
  channelsOpen: boolean;
  build: BuildIdentity;
  protocolSession: string;
}

/**
 * Host-owned lobby state. Every mutator is intentionally explicit: peers can
 * only change their own name/skin/readiness, while the host owns all match
 * configuration and the start request. This class only computes a roster; it
 * never constructs or starts a Match.
 */
export class LobbyState {
  readonly roomId: string;
  readonly hostPeerId: string;
  readonly build: BuildIdentity;

  private configValue: LobbyConfig;
  private revisionValue = 0;
  private matchLockedValue = false;
  private readonly participantsValue = new Map<string, MutableParticipant>();
  private readonly participantById = new Map<string, MutableParticipant>();
  private readonly sessionGuard: ProtocolSessionGuard;

  constructor(options: LobbyStateOptions) {
    this.roomId = validateIdentifier(options.roomId, 'roomId');
    this.hostPeerId = validateIdentifier(options.hostPeerId, 'hostPeerId');
    try {
      this.build = normalizeBuildIdentity(options.build);
    } catch (error) {
      throw new LobbyError('invalid-lobby', error instanceof Error ? error.message : 'Invalid build identity');
    }

    const mode = validateEnum(options.mode ?? 'ffa-bot-fill', MODES, 'mode');
    const botFill = mode === 'humans-vs-bots' ? true : options.botFill ?? defaultBotFill(mode);
    this.configValue = Object.freeze({
      mapId: validateEnum(options.mapId ?? 'neocity', MAP_IDS, 'mapId'),
      mode,
      botFill,
      difficulty: validateEnum(options.difficulty ?? 'normal', DIFFICULTIES, 'difficulty'),
      seed: validateSeed(options.seed ?? randomSeed()),
    });
    this.sessionGuard = new ProtocolSessionGuard();

    const hostParticipant: MutableParticipant = {
      participantId: validateIdentifier(options.hostParticipantId ?? 'host', 'hostParticipantId'),
      peerId: this.hostPeerId,
      slotId: 0,
      displayName: validateDisplayName(options.hostDisplayName ?? 'HOST'),
      skinId: validateEnum(options.hostSkinId ?? 'vanguard', SKINS, 'hostSkinId'),
      teamId: null,
      // The host is allowed to set their own name before declaring ready.
      ready: false,
      isHost: true,
      connected: true,
      channelsOpen: options.channelOpen ?? true,
      build: this.build,
      protocolSession: validateIdentifier(options.protocolSession ?? randomId(), 'protocolSession'),
    };
    if (mode === 'humans-vs-bots') hostParticipant.teamId = 0;
    this.insertParticipant(hostParticipant);
  }

  get config(): LobbyConfig {
    return this.configValue;
  }

  get effectiveMode(): MatchMode {
    return effectiveMode(this.configValue.mode, this.configValue.botFill);
  }

  get revision(): number {
    return this.revisionValue;
  }

  get matchLocked(): boolean {
    return this.matchLockedValue;
  }

  get participants(): readonly LobbyParticipant[] {
    return this.snapshot().participants;
  }

  getParticipantByPeer(peerId: string): LobbyParticipant | null {
    const participant = this.participantsValue.get(peerId);
    return participant ? freezeParticipant(participant) : null;
  }

  participantForPeer(peerId: string): LobbyParticipant | null {
    return this.getParticipantByPeer(peerId);
  }

  getParticipant(participantId: string): LobbyParticipant | null {
    const participant = this.participantById.get(participantId);
    return participant ? freezeParticipant(participant) : null;
  }

  snapshot(): LobbySnapshot {
    const participants = [...this.participantsValue.values()]
      .sort((a, b) => a.slotId - b.slotId)
      .map(freezeParticipant);
    return Object.freeze({
      revision: this.revisionValue,
      roomId: this.roomId,
      hostPeerId: this.hostPeerId,
      matchLocked: this.matchLockedValue,
      build: this.build,
      config: this.configValue,
      effectiveMode: this.effectiveMode,
      participants: Object.freeze(participants),
      rosterPreview: this.rosterPreview(),
    });
  }

  getSnapshot(): LobbySnapshot {
    return this.snapshot();
  }

  /** Validate and add a participant from a host-verified handshake. */
  addParticipant(input: Handshake | LobbyJoinRequest): LobbyParticipant {
    this.requireUnlocked();
    const request = isJoinRequest(input) ? input : { handshake: input };
    let handshake: Handshake;
    try {
      handshake = validateHandshake(request.handshake, {
        expectedRoomId: this.roomId,
        expectedProtocolVersion: this.build.protocolVersion,
        expectedBuildId: this.build.buildId,
        expectedFeatures: this.build.features,
        expectedHostPeerId: this.hostPeerId,
      });
    } catch (error) {
      if (error instanceof ProtocolValidationError && error.code === 'build-mismatch') {
        throw new LobbyError('build-mismatch', error.message);
      }
      throw new LobbyError(
        error instanceof ProtocolValidationError && error.code === 'unauthorized'
          ? 'peer-claims-host'
          : 'invalid-lobby',
        error instanceof Error ? error.message : 'Invalid participant handshake',
      );
    }
    if (handshake.role !== 'participant' || handshake.peerId === this.hostPeerId) {
      throw new LobbyError('peer-claims-host', 'A participant cannot claim the host slot');
    }
    if (this.participantsValue.has(handshake.peerId)) {
      throw new LobbyError('duplicate-peer', `Peer is already in this lobby: ${handshake.peerId}`);
    }
    if (this.participantById.has(handshake.participantId)) {
      throw new LobbyError('duplicate-participant', `Participant is already in this lobby: ${handshake.participantId}`);
    }
    if (this.participantsValue.size >= MAX_HUMAN_PARTICIPANTS) {
      throw new LobbyError('room-full', `Lobby supports at most ${MAX_HUMAN_PARTICIPANTS} humans`);
    }
    const requestedSlot = validateRequestedSlot(request.requestedSlot ?? null);
    const slotId = this.nextFreeSlot(requestedSlot);
    const participant: MutableParticipant = {
      participantId: handshake.participantId,
      peerId: handshake.peerId,
      slotId,
      displayName: validateDisplayName(request.displayName ?? `PLAYER ${slotId + 1}`),
      skinId: validateEnum(request.skinId ?? defaultSkin(slotId), SKINS, 'skinId'),
      teamId: participantTeamForMode(
        this.effectiveMode,
        slotId,
        request.teamId === undefined ? null : validateTeam(request.teamId),
      ),
      ready: false,
      isHost: false,
      connected: true,
      channelsOpen: request.channelOpen ?? true,
      build: normalizeBuildIdentity({
        protocolVersion: handshake.protocolVersion,
        buildId: handshake.buildId,
        features: handshake.features,
      }),
      protocolSession: handshake.protocolSession,
    };
    this.insertParticipant(participant);
    this.bumpRevision();
    return freezeParticipant(participant);
  }

  addGuest(input: Handshake | LobbyJoinRequest): LobbyParticipant {
    return this.addParticipant(input);
  }

  join(input: Handshake | LobbyJoinRequest): LobbyParticipant {
    return this.addParticipant(input);
  }

  /** Mark transport/channel state observed by the host; not a peer command. */
  setChannelOpen(peerId: string, open: boolean): void {
    const participant = this.requireParticipant(peerId);
    if (typeof open !== 'boolean') throw new LobbyError('invalid-state', 'Channel state must be boolean');
    if (participant.channelsOpen === open) return;
    participant.channelsOpen = open;
    this.bumpRevision();
  }

  markChannelOpen(peerId: string, open = true): void {
    this.setChannelOpen(peerId, open);
  }

  markDisconnected(peerId: string): void {
    const participant = this.requireParticipant(peerId);
    if (!participant.connected && !participant.channelsOpen && !participant.ready) return;
    participant.connected = false;
    participant.channelsOpen = false;
    participant.ready = false;
    this.bumpRevision();
  }

  /** Mark the lobby/signaling connection back online; direct channels open separately. */
  markConnected(peerId: string): void {
    const participant = this.requireParticipant(peerId);
    if (participant.connected) return;
    participant.connected = true;
    this.bumpRevision();
  }

  /**
   * Rebind one previously disconnected guest to a new transport peer. Token
   * authentication belongs in the reconnect coordinator; this method is the
   * host-authoritative state transition after that token has been checked.
   */
  reclaimParticipant(
    participantId: string,
    previousPeerId: string,
    nextPeerId: string,
    nextProtocolSession: string,
  ): LobbyParticipant {
    this.requireUnlocked();
    const checkedParticipantId = validateIdentifier(participantId, 'participantId');
    const participant = this.participantById.get(checkedParticipantId);
    if (!participant || participant.isHost || participant.peerId !== previousPeerId) {
      throw new LobbyError('stale-session', 'Reconnect claim does not match a disconnected participant');
    }
    if (participant.connected || participant.channelsOpen) {
      throw new LobbyError('invalid-state', 'Only a disconnected participant may be reclaimed');
    }
    const checkedNextPeerId = validateIdentifier(nextPeerId, 'nextPeerId');
    if (checkedNextPeerId === this.hostPeerId) {
      throw new LobbyError('peer-claims-host', 'Reconnect cannot claim the host peer');
    }
    if (this.participantsValue.has(checkedNextPeerId)) {
      throw new LobbyError('duplicate-peer', `Peer is already in this lobby: ${checkedNextPeerId}`);
    }
    const checkedSession = validateIdentifier(nextProtocolSession, 'nextProtocolSession');
    if (checkedSession === participant.protocolSession) {
      throw new LobbyError('stale-session', 'Reconnect must rotate the protocol session');
    }

    this.participantsValue.delete(previousPeerId);
    participant.peerId = checkedNextPeerId;
    participant.protocolSession = checkedSession;
    participant.connected = false;
    participant.channelsOpen = false;
    participant.ready = false;
    this.participantsValue.set(checkedNextPeerId, participant);
    this.sessionGuard.nonceGuard.reset(previousPeerId);
    this.sessionGuard.nonceGuard.reset(checkedNextPeerId);
    this.sessionGuard.rateLimiter.reset(previousPeerId);
    this.sessionGuard.rateLimiter.reset(checkedNextPeerId);
    this.bumpRevision();
    return freezeParticipant(participant);
  }

  rebindParticipant(
    participantId: string,
    previousPeerId: string,
    nextPeerId: string,
    nextProtocolSession: string,
  ): LobbyParticipant {
    return this.reclaimParticipant(participantId, previousPeerId, nextPeerId, nextProtocolSession);
  }

  reclaimGuest(
    participantId: string,
    previousPeerId: string,
    nextPeerId: string,
    nextProtocolSession: string,
  ): LobbyParticipant {
    return this.reclaimParticipant(participantId, previousPeerId, nextPeerId, nextProtocolSession);
  }

  /** Participant-owned fields. Names are frozen once that participant is ready. */
  setDisplayName(peerId: string, displayName: string): void {
    this.requireUnlocked();
    const participant = this.requireParticipant(peerId);
    this.requireConnected(participant);
    if (participant.ready) throw new LobbyError('participant-ready', 'Display name cannot change after ready');
    const normalized = validateDisplayName(displayName);
    if (participant.displayName === normalized) return;
    participant.displayName = normalized;
    this.bumpRevision();
  }

  setSkin(peerId: string, skinId: SkinId): void {
    this.requireUnlocked();
    const participant = this.requireParticipant(peerId);
    this.requireConnected(participant);
    const skin = validateEnum(skinId, SKINS, 'skinId');
    if (participant.skinId === skin) return;
    participant.skinId = skin;
    this.bumpRevision();
  }

  setReady(peerId: string, ready: boolean): void {
    this.requireUnlocked();
    const participant = this.requireParticipant(peerId);
    this.requireConnected(participant);
    if (typeof ready !== 'boolean') throw new LobbyError('invalid-state', 'Ready state must be boolean');
    if (participant.ready === ready) return;
    participant.ready = ready;
    this.bumpRevision();
  }

  /** Host-only match configuration mutators. */
  setMap(peerId: string, mapId: MapId): void {
    this.requireUnlocked();
    this.requireHost(peerId);
    const value = validateEnum(mapId, MAP_IDS, 'mapId');
    if (this.configValue.mapId === value) return;
    this.configValue = Object.freeze({ ...this.configValue, mapId: value });
    this.invalidateReadyStates();
  }

  setMode(peerId: string, mode: MatchMode): void {
    this.requireUnlocked();
    this.requireHost(peerId);
    const value = validateEnum(mode, MODES, 'mode');
    const botFill = value === 'ffa-bot-fill' || value === 'teams-bot-fill'
      ? true
      : value === 'ffa' || value === 'teams' ? false : true;
    if (this.configValue.mode === value && this.configValue.botFill === botFill) return;
    this.configValue = Object.freeze({ ...this.configValue, mode: value, botFill });
    this.normalizeTeamsForMode(effectiveMode(value, botFill));
    this.invalidateReadyStates();
  }

  setBotFill(peerId: string, botFill: boolean): void {
    this.requireUnlocked();
    this.requireHost(peerId);
    if (typeof botFill !== 'boolean') throw new LobbyError('invalid-state', 'Bot fill must be boolean');
    if (this.configValue.mode === 'humans-vs-bots' && !botFill) {
      throw new LobbyError('invalid-state', 'Humans-versus-Bots always requires Bot fill');
    }
    if (this.configValue.botFill === botFill) return;
    this.configValue = Object.freeze({ ...this.configValue, botFill });
    this.invalidateReadyStates();
  }

  setDifficulty(peerId: string, difficulty: Difficulty): void {
    this.requireUnlocked();
    this.requireHost(peerId);
    const value = validateEnum(difficulty, DIFFICULTIES, 'difficulty');
    if (this.configValue.difficulty === value) return;
    this.configValue = Object.freeze({ ...this.configValue, difficulty: value });
    this.invalidateReadyStates();
  }

  setTeam(peerId: string, participantId: string, teamId: TeamId | null): void {
    this.requireUnlocked();
    this.requireHost(peerId);
    if (this.effectiveMode !== 'teams' && this.effectiveMode !== 'teams-bot-fill') {
      throw new LobbyError('invalid-state', 'Team assignment is available only in Team Battle');
    }
    const participant = this.participantById.get(validateIdentifier(participantId, 'participantId'));
    if (!participant) throw new LobbyError('unknown-participant', `Unknown participant: ${participantId}`);
    const value = validateTeam(teamId);
    if (participant.teamId === value) return;
    participant.teamId = value;
    this.invalidateReadyStates();
  }

  /** Compute only. There is deliberately no Match construction in this API. */
  rosterPreview(): LobbyRosterPreview {
    const mode = this.effectiveMode;
    const humans = this.humanRosterEntries();
    try {
      const roster = buildRoster({ mode, humans, seed: this.configValue.seed });
      return Object.freeze({
        revision: this.revisionValue,
        roomId: this.roomId,
        mapId: this.configValue.mapId,
        mode,
        configuredMode: this.configValue.mode,
        botFill: this.configValue.botFill,
        difficulty: this.configValue.difficulty,
        seed: this.configValue.seed,
        humans: Object.freeze(humans.map(cloneRosterEntry)),
        roster: Object.freeze(roster.map(cloneRosterEntry)),
        valid: true,
        error: null,
      });
    } catch (error) {
      return Object.freeze({
        revision: this.revisionValue,
        roomId: this.roomId,
        mapId: this.configValue.mapId,
        mode,
        configuredMode: this.configValue.mode,
        botFill: this.configValue.botFill,
        difficulty: this.configValue.difficulty,
        seed: this.configValue.seed,
        humans: Object.freeze(humans.map(cloneRosterEntry)),
        roster: Object.freeze([]),
        valid: false,
        error: error instanceof Error ? error.message : 'Invalid final roster',
      });
    }
  }

  previewRoster(): LobbyRosterPreview {
    return this.rosterPreview();
  }

  getRosterPreview(): LobbyRosterPreview {
    return this.rosterPreview();
  }

  getStartEligibility(): StartEligibility {
    const preview = this.rosterPreview();
    const protocolBuildMatch = [...this.participantsValue.values()]
      .every((participant) => buildsMatch(this.build, participant.build)
        && participant.protocolSession.length > 0);
    const guestsReady = [...this.participantsValue.values()]
      .filter((participant) => !participant.isHost)
      .every((participant) => participant.ready);
    const channelsOpen = [...this.participantsValue.values()]
      .every((participant) => participant.connected && participant.channelsOpen);
    const blockers: StartBlocker[] = [];
    if (this.matchLockedValue) blockers.push('match-locked');
    if (!protocolBuildMatch) blockers.push('protocol-build-mismatch');
    if (!guestsReady) blockers.push('guest-not-ready');
    if (!preview.valid) blockers.push('invalid-final-roster');
    if (!channelsOpen) blockers.push('channels-closed');
    return Object.freeze({
      eligible: blockers.length === 0,
      protocolBuildMatch,
      guestsReady,
      validFinalRoster: preview.valid,
      channelsOpen,
      blockers: Object.freeze(blockers),
      preview,
    });
  }

  canStart(): boolean {
    return this.getStartEligibility().eligible;
  }

  /** A request is an eligibility check only; no match is launched here. */
  requestStart(peerId: string): StartRequestResult {
    this.requireHost(peerId);
    const eligibility = this.getStartEligibility();
    if (eligibility.eligible) {
      this.matchLockedValue = true;
      this.bumpRevision();
    }
    return Object.freeze({ accepted: eligibility.eligible, launched: false, eligibility });
  }

  /** Apply a validated wire command after sender/session/replay/rate checks. */
  applyCommand(transportPeerId: string, input: unknown): LobbyCommandResult {
    // Bind the transport peer and its current protocol session before touching
    // the replay/rate guards. A stale or unknown packet must not install an
    // attacker-controlled session in the guard and poison the real peer's
    // subsequent commands.
    const candidate = validateProtocolMessage(input);
    if (candidate.type === 'handshake') {
      throw new LobbyError('invalid-state', 'Handshake is handled by addParticipant');
    }
    const participant = this.requireParticipant(transportPeerId);
    this.requireConnected(participant);
    if (participant.protocolSession !== candidate.protocolSession) {
      throw new LobbyError('stale-session', 'Protocol session is stale');
    }
    const message = this.sessionGuard.accept(transportPeerId, candidate);
    if (HOST_COMMANDS.has(message.type)) this.requireHost(transportPeerId);
    switch (message.type) {
      case 'set-display-name': this.setDisplayName(transportPeerId, message.displayName); break;
      case 'set-skin': this.setSkin(transportPeerId, message.skinId); break;
      case 'set-ready': this.setReady(transportPeerId, message.ready); break;
      case 'set-map': this.setMap(transportPeerId, message.mapId); break;
      case 'set-mode': this.setMode(transportPeerId, message.mode); break;
      case 'set-bot-fill': this.setBotFill(transportPeerId, message.botFill); break;
      case 'set-difficulty': this.setDifficulty(transportPeerId, message.difficulty); break;
      case 'set-team': this.setTeam(transportPeerId, message.participantId, message.teamId); break;
      case 'start-request': {
        const start = this.requestStart(transportPeerId);
        return Object.freeze({ accepted: true, snapshot: this.snapshot(), start });
      }
    }
    void participant;
    return Object.freeze({ accepted: true, snapshot: this.snapshot() });
  }

  handleCommand(transportPeerId: string, input: unknown): LobbyCommandResult {
    return this.applyCommand(transportPeerId, input);
  }

  private insertParticipant(participant: MutableParticipant): void {
    this.participantsValue.set(participant.peerId, participant);
    this.participantById.set(participant.participantId, participant);
  }

  private nextFreeSlot(requestedSlot: number | null = null): number {
    if (requestedSlot !== null) {
      if ([...this.participantsValue.values()].some((participant) => participant.slotId === requestedSlot)) {
        throw new LobbyError('room-full', `Requested lobby slot is occupied: ${requestedSlot}`);
      }
      return requestedSlot;
    }
    for (let slot = 0; slot < MAX_HUMAN_PARTICIPANTS; slot++) {
      if (![...this.participantsValue.values()].some((participant) => participant.slotId === slot)) return slot;
    }
    throw new LobbyError('room-full', 'No human slot is available');
  }

  private requireParticipant(peerId: string): MutableParticipant {
    const participant = this.participantsValue.get(peerId);
    if (!participant) throw new LobbyError('unknown-peer', `Unknown lobby peer: ${peerId}`);
    return participant;
  }

  private requireConnected(participant: MutableParticipant): void {
    if (!participant.connected) {
      throw new LobbyError('invalid-state', 'Disconnected peer cannot change lobby state');
    }
  }

  private requireHost(peerId: string): MutableParticipant {
    const participant = this.requireParticipant(peerId);
    if (!participant.isHost || peerId !== this.hostPeerId) {
      throw new LobbyError('not-authorized', 'Only the host may change lobby configuration');
    }
    return participant;
  }

  private requireUnlocked(): void {
    if (this.matchLockedValue) {
      throw new LobbyError('match-locked', 'The lobby is locked for match start');
    }
  }

  private invalidateReadyStates(): void {
    for (const participant of this.participantsValue.values()) {
      if (!participant.isHost) participant.ready = false;
    }
    // Configuration changes are state changes even when everyone was already
    // unready, so clients still receive a monotonic snapshot revision.
    this.bumpRevision();
  }

  private normalizeTeamsForMode(mode: MatchMode): void {
    for (const participant of this.participantsValue.values()) {
      participant.teamId = participantTeamForMode(mode, participant.slotId, participant.teamId);
    }
  }

  private bumpRevision(): void {
    this.revisionValue += 1;
  }

  private humanRosterEntries(): RosterEntry[] {
    return [...this.participantsValue.values()]
      .sort((a, b) => a.slotId - b.slotId)
      .map((participant) => ({
        slotId: participant.slotId,
        actorId: participant.slotId + 1,
        displayName: participant.displayName,
        ownership: participant.isHost
          ? { kind: 'local-human' as const, peerId: participant.peerId }
          : { kind: 'remote-human' as const, peerId: participant.peerId },
        connectionState: participant.connected ? 'connected' as const : 'disconnected' as const,
        teamId: participant.teamId,
        skinId: participant.skinId,
        accentColor: participant.isHost ? 0x5fd0ff : 0x9b7dff + participant.slotId * 0x1100,
      }));
  }
}

function isJoinRequest(value: Handshake | LobbyJoinRequest): value is LobbyJoinRequest {
  return typeof value === 'object' && value !== null && 'handshake' in value;
}

function freezeParticipant(value: MutableParticipant): LobbyParticipant {
  return Object.freeze({
    participantId: value.participantId,
    peerId: value.peerId,
    slotId: value.slotId,
    displayName: value.displayName,
    skinId: value.skinId,
    teamId: value.teamId,
    ready: value.ready,
    isHost: value.isHost,
    connected: value.connected,
    channelsOpen: value.channelsOpen,
    build: value.build,
    protocolSession: value.protocolSession,
  });
}

function cloneRosterEntry(entry: RosterEntry): RosterEntry {
  return {
    ...entry,
    ownership: entry.ownership.kind === 'bot'
      ? { kind: 'bot' }
      : { kind: entry.ownership.kind, peerId: entry.ownership.peerId },
  };
}

function validateIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || value !== value.trim() || hasControlCharacter(value)) {
    throw new LobbyError('invalid-lobby', `Invalid ${label}`);
  }
  return value;
}

function validateDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new LobbyError('invalid-lobby', 'Display name must be a string');
  const normalized = value.normalize('NFC');
  if (normalized.length < 1 || normalized.length > MAX_DISPLAY_NAME_LENGTH
    || normalized !== normalized.trim() || hasControlCharacter(normalized)) {
    throw new LobbyError('invalid-lobby', 'Invalid display name');
  }
  if (new TextEncoder().encode(normalized).byteLength > MAX_DISPLAY_NAME_LENGTH * 4) {
    throw new LobbyError('invalid-lobby', 'Display name is too large');
  }
  return normalized;
}

function validateSeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LobbyError('invalid-lobby', 'Seed must be a non-negative safe integer');
  }
  return value;
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new LobbyError('invalid-lobby', `Invalid ${label}`);
  }
  return value as T;
}

function validateTeam(value: unknown): TeamId | null {
  if (value === null || value === 0 || value === 1) return value;
  throw new LobbyError('invalid-state', 'Team must be null, 0, or 1');
}

function validateRequestedSlot(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= MAX_HUMAN_PARTICIPANTS) {
    throw new LobbyError('invalid-lobby', 'Requested lobby slot must be null or an available guest slot');
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function defaultSkin(slotId: number): SkinId {
  return SKINS[slotId % SKINS.length]!;
}

function defaultBotFill(mode: MatchMode): boolean {
  return mode === 'ffa-bot-fill' || mode === 'teams-bot-fill' || mode === 'humans-vs-bots';
}

function effectiveMode(mode: MatchMode, botFill: boolean): MatchMode {
  if (mode === 'humans-vs-bots') return mode;
  if (mode === 'ffa' || mode === 'ffa-bot-fill') return botFill ? 'ffa-bot-fill' : 'ffa';
  if (mode === 'teams' || mode === 'teams-bot-fill') return botFill ? 'teams-bot-fill' : 'teams';
  return mode;
}

function participantTeamForMode(mode: MatchMode, slotId: number, current: TeamId | null): TeamId | null {
  if (mode === 'teams' || mode === 'teams-bot-fill') return current ?? slotId % 2;
  if (mode === 'humans-vs-bots') return 0;
  return null;
}

function randomId(): string {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.getRandomValues) throw new LobbyError('invalid-lobby', 'Secure randomness is unavailable');
  const bytes = new Uint8Array(18);
  cryptoObject.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === 'function') {
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomSeed(): number {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) {
    const value = new Uint32Array(1);
    cryptoObject.getRandomValues(value);
    return value[0]!;
  }
  return Math.floor(Date.now() / 1000);
}
