import type { InputCommand } from '../sim/input';
import { WEAPONS } from '../core/balance';
import type { GameStateView } from '../sim/gameStateView';
import type { Match, MatchEventsMap } from '../sim/match';
import type { TeamId } from '../sim/roster';
import {
  RemoteInputController,
  type RemoteInputEnvelope,
  type RemoteInputResult,
  type RemoteInputTelemetry,
} from './remoteInput';

export const HOST_TICK_RATE = 60;
export const INITIAL_SNAPSHOT_RATE = 20;
export const MEASURED_SNAPSHOT_RATE = 30;
export const KEYFRAME_INTERVAL_TICKS = HOST_TICK_RATE;
export const RECONNECT_WINDOW_MS = 60_000;
export const TACTICAL_PING_LIFETIME_TICKS = HOST_TICK_RATE * 6;
export const TACTICAL_PING_MAX_RANGE = 260;

export interface MatchPeerBinding {
  readonly participantId: string;
  readonly peerId: string;
  readonly actorId: number;
  readonly teamId: TeamId | null;
}

export interface EncodedSnapshot {
  readonly packets: readonly ArrayBuffer[];
  readonly totalBytes: number;
}

export interface SnapshotEncodeOptions {
  readonly full: boolean;
  readonly sequence: number;
  readonly viewerParticipantId: string;
  readonly viewerPeerId: string;
  readonly viewerActorId: number;
  readonly acknowledgedInputSequence: number;
  readonly acknowledgedInputByActor: ReadonlyMap<number, number>;
}

export interface HostMatchTransport {
  send(peerId: string, channel: 'control' | 'event' | 'snapshot', data: ArrayBuffer, sequence?: number): boolean;
  disconnect(peerId: string): void;
}

export interface HostReconnectTransaction {
  readonly accepted: boolean;
  readonly alive: boolean;
  commit(): void;
  rollback(): void;
}

export interface HostLagCompensationLike {
  recordTick(match: Match, hostTick: number): void;
  resolveAcceptedShot(input: {
    readonly actor: Match['actors'][number];
    readonly currentHostTick: number;
    readonly requestedShotTick: number;
    readonly dt: number;
  }): { readonly accepted: boolean };
}

export interface AuthoritativeMatchEvent {
  readonly eventId: number;
  readonly revision: number;
  readonly hostTick: number;
  readonly type: keyof MatchEventsMap | 'playerLeave' | 'playerRejoin' | 'tacticalPing';
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface TacticalPing {
  readonly eventId: number;
  readonly senderActorId: number;
  readonly teamId: TeamId | null;
  readonly kind: 'location';
  readonly x: number;
  readonly z: number;
  readonly createdHostTick: number;
  readonly expiresHostTick: number;
  readonly recipients: readonly string[];
}

export interface NetworkPercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface HostNetworkMetrics {
  readonly tickRate: number;
  readonly snapshotRate: number;
  readonly snapshotSizes: NetworkPercentiles;
  readonly snapshotsProduced: number;
  readonly packetsSent: number;
  readonly packetsDropped: number;
  readonly bytesProduced: number;
  readonly bytesSentByPeer: Readonly<Record<string, number>>;
  readonly totalUploadBytes: number;
}

interface PeerRuntime {
  binding: MatchPeerBinding;
  controller: RemoteInputController;
  disconnectedAtMs: number | null;
  reconnectDeadlineMs: number | null;
  noticeSent: boolean;
}

/** One fixed 60 Hz Match, irrespective of peer count. */
/**
 * The complete set of host-authoritative match events forwarded to guests.
 * Presentation features (decals, tracers, flashes) must derive from these
 * existing events — never add new high-frequency network fields.
 */
export const AUTHORITATIVE_EVENT_TYPES = [
  'shotFired', 'impact', 'glassBreak', 'destructibleDestroyed', 'actorHit',
  'shieldHit', 'shieldBroken', 'eliminated', 'itemPickedUp', 'chestOpened', 'reloadStarted',
  'healStarted', 'healCancelled', 'healDone', 'stormWaiting', 'stormShrinking',
  'stormFinal', 'phaseChanged', 'matchWon',
] as const;

export class HostAuthoritativeMatchSession {
  private readonly peersByPeerId = new Map<string, PeerRuntime>();
  private readonly peersByParticipant = new Map<string, PeerRuntime>();
  private readonly eventCleanups: Array<() => void> = [];
  private readonly snapshotSizes: number[] = [];
  private readonly bytesSentByPeer = new Map<string, number>();
  private readonly acknowledgedInputByActor = new Map<number, number>();
  private readonly activeShotInputSequenceByActor = new Map<number, number>();
  private readonly pingRate = new Map<string, { tokens: number; tick: number }>();
  private snapshotSequence = 0;
  private eventId = 0;
  private snapshotRate = INITIAL_SNAPSHOT_RATE;
  private snapshotsProduced = 0;
  private packetsSent = 0;
  private packetsDropped = 0;
  private bytesProduced = 0;
  private disposed = false;
  // The first state packet must use the reliable control channel; recovery
  // and the one-second cadence reuse the same full-keyframe path.
  private requestedKeyframe = true;
  private measuredTicks = 0;
  private measuredSimMs = 0;

  constructor(
    readonly match: Match,
    bindings: readonly MatchPeerBinding[],
    private readonly transport: HostMatchTransport,
    private readonly encodeSnapshot: (view: GameStateView, options: SnapshotEncodeOptions) => EncodedSnapshot,
    private readonly options: {
      readonly lagCompensation?: HostLagCompensationLike;
      readonly nowMs?: () => number;
      readonly onEvent?: (event: AuthoritativeMatchEvent) => void;
      readonly onPresenceNotice?: (kind: 'left' | 'rejoined', displayName: string) => void;
      readonly disconnectGraceMs?: number;
    } = {},
  ) {
    for (const binding of bindings) this.installBinding(binding);
    this.bindAuthoritativeEvents();
    this.options.lagCompensation?.recordTick(match, match.hostTick);
  }

  receiveInput(peerId: string, envelope: RemoteInputEnvelope): RemoteInputResult {
    const runtime = this.peersByPeerId.get(peerId);
    if (!runtime || runtime.disconnectedAtMs !== null) {
      return Object.freeze({ accepted: false, reason: 'actor-mismatch', violations: 0, disconnected: true });
    }
    const result = runtime.controller.accept(envelope);
    if (result.accepted) {
      const latest = envelope.frames.reduce((best, frame) => frame.sequence > best ? frame.sequence : best, -1);
      if (latest >= 0) this.acknowledgedInputByActor.set(runtime.binding.actorId, latest);
    }
    return result;
  }

  fixedUpdate(dt: number): void {
    if (this.disposed) return;
    if (this.match.hostTick >= 0xffff_ffff) throw new Error('Authoritative host tick exhausted');
    if (this.match.stateRevision >= 0xffff_ffff) throw new Error('Authoritative state revision exhausted');
    const before = performance.now();
    const nextTick = this.match.hostTick + 1;
    for (const runtime of this.peersByParticipant.values()) runtime.controller.setHostTick(nextTick);
    this.match.fixedUpdate(dt);
    this.options.lagCompensation?.recordTick(this.match, this.match.hostTick);
    this.measuredSimMs += performance.now() - before;
    this.measuredTicks++;
    this.updatePresence();
    this.expirePings();
    this.maybeTuneSnapshotRate();
    if (this.shouldSendSnapshot()) this.publishSnapshot();
  }

  requestRecoveryKeyframe(): void {
    this.requestedKeyframe = true;
  }

  markDisconnected(peerId: string): boolean {
    const runtime = this.peersByPeerId.get(peerId);
    if (!runtime || runtime.disconnectedAtMs !== null) return false;
    const now = this.nowMs();
    runtime.disconnectedAtMs = now;
    runtime.reconnectDeadlineMs = now + RECONNECT_WINDOW_MS;
    runtime.noticeSent = false;
    runtime.controller.neutralize();
    this.match.markPeerDisconnected(runtime.binding.peerId);
    return true;
  }

  reconnectParticipant(participantId: string, newPeerId: string): { accepted: boolean; alive: boolean } {
    const transaction = this.prepareReconnectParticipant(participantId, newPeerId);
    if (transaction.accepted) transaction.commit();
    return Object.freeze({ accepted: transaction.accepted, alive: transaction.alive });
  }

  /**
   * Prepare an Actor rebind without changing the live Match. The room may
   * still be waiting for the authenticated admission response to cross the
   * transport, so a pending reconnect must not change ownership or connection
   * state observed by the fixed simulation or an existing guest snapshot.
   */
  prepareReconnectParticipant(participantId: string, newPeerId: string): HostReconnectTransaction {
    const runtime = this.peersByParticipant.get(participantId);
    if (!runtime || !this.canReconnectParticipant(participantId, newPeerId)) {
      return rejectedReconnectTransaction();
    }
    const oldPeerId = runtime.binding.peerId;
    const oldBytes = this.bytesSentByPeer.get(oldPeerId);
    const newBytes = this.bytesSentByPeer.get(newPeerId);
    const roster = this.match.rosterEntryForActor(runtime.binding.actorId);
    if (!roster || roster.ownership.kind === 'bot' || roster.ownership.peerId !== oldPeerId
      || roster.connectionState !== 'disconnected') {
      return rejectedReconnectTransaction();
    }
    const nextBinding = Object.freeze({ ...runtime.binding, peerId: newPeerId });
    const nextController = this.makeController(nextBinding);
    const actor = this.match.actors.find((candidate) => candidate.id === runtime.binding.actorId);
    let settled = false;
    return Object.freeze({
      accepted: true,
      get alive(): boolean {
        return actor?.alive === true;
      },
      commit: () => {
        if (settled) return;
        settled = true;
        // Fixed simulation continues while the signed admission response is
        // in flight. Re-read lifecycle state at the commit point so a grace
        // notice or elimination that occurred during that interval is not
        // lost from the reconnect result.
        const presenceWasAnnounced = runtime.noticeSent;
        this.peersByPeerId.delete(oldPeerId);
        runtime.binding = nextBinding;
        runtime.controller = nextController;
        this.match.controllers.set(runtime.binding.actorId, runtime.controller);
        runtime.disconnectedAtMs = null;
        runtime.reconnectDeadlineMs = null;
        runtime.noticeSent = false;
        this.peersByPeerId.set(newPeerId, runtime);
        const retiredBytes = oldBytes ?? 0;
        this.bytesSentByPeer.delete(oldPeerId);
        this.bytesSentByPeer.delete(newPeerId);
        if (retiredBytes + (newBytes ?? 0) > 0) {
          this.bytesSentByPeer.set(newPeerId, retiredBytes + (newBytes ?? 0));
        }
        this.pingRate.delete(oldPeerId);
        roster.ownership = roster.ownership.kind === 'bot'
          ? { kind: 'bot' }
          : { kind: roster.ownership.kind, peerId: newPeerId };
        if (!this.match.restorePeerControl(newPeerId)) {
          throw new Error('Reconnect Actor remained disconnected after commit');
        }
        if (presenceWasAnnounced) {
          this.publishPresence('playerRejoin', runtime.binding.actorId, oldPeerId, newPeerId);
          this.notifyPresenceNotice('rejoined', actor?.name ?? participantId);
        }
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        // Preparation is side-effect free. Only the newly allocated controller
        // needs to be neutralized when the admission is rejected.
        nextController.neutralize();
      },
    });
  }

  /** Read-only preflight used before the lobby rotates a reconnect token. */
  canReconnectParticipant(participantId: string, newPeerId: string): boolean {
    const runtime = this.peersByParticipant.get(participantId);
    const now = this.nowMs();
    return Boolean(runtime
      && runtime.disconnectedAtMs !== null
      && runtime.reconnectDeadlineMs !== null
      && now < runtime.reconnectDeadlineMs
      && !this.peersByPeerId.has(newPeerId));
  }

  requestTacticalPing(peerId: string, x: number, z: number): TacticalPing | null {
    const runtime = this.peersByPeerId.get(peerId);
    if (!runtime || runtime.disconnectedAtMs !== null || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    return this.createTacticalPing(runtime.binding.actorId, runtime.binding.teamId, peerId, x, z);
  }

  requestLocalTacticalPing(actorId: number, x: number, z: number): TacticalPing | null {
    const roster = this.match.rosterEntryForActor(actorId);
    if (!roster || roster.ownership.kind !== 'local-human' || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    return this.createTacticalPing(actorId, roster.teamId, `host:${actorId}`, x, z);
  }

  private createTacticalPing(
    actorId: number,
    teamId: TeamId | null,
    rateKey: string,
    x: number,
    z: number,
  ): TacticalPing | null {
    const half = this.match.mapDef.size / 2;
    const actor = this.match.actors.find((candidate) => candidate.id === actorId);
    if (!actor?.alive
      || x < -half || x > half || z < -half || z > half
      || Math.hypot(x - actor.body.position.x, z - actor.body.position.z) > TACTICAL_PING_MAX_RANGE
      || !this.consumePingRate(rateKey)) return null;
    const teamMode = this.match.teams.length > 0;
    const recipients = teamMode
      ? [...this.peersByParticipant.values()]
        .filter((peer) => peer.binding.teamId === teamId)
        .map((peer) => peer.binding.peerId)
      : this.peersByPeerId.has(rateKey) ? [rateKey] : [];
    const ping: TacticalPing = Object.freeze({
      eventId: this.nextEventId(),
      senderActorId: actorId,
      teamId,
      kind: 'location',
      x,
      z,
      createdHostTick: this.match.hostTick,
      expiresHostTick: this.match.hostTick + TACTICAL_PING_LIFETIME_TICKS,
      recipients: Object.freeze(recipients),
    });
    this.emitEventWithId(ping.eventId, 'tacticalPing', ping as unknown as Record<string, unknown>);
    return ping;
  }

  peerInputTelemetry(participantId: string): RemoteInputTelemetry | null {
    return this.peersByParticipant.get(participantId)?.controller.telemetry ?? null;
  }

  get metrics(): HostNetworkMetrics {
    const byPeer = Object.fromEntries([...this.bytesSentByPeer.entries()].sort(([a], [b]) => a.localeCompare(b)));
    return Object.freeze({
      tickRate: HOST_TICK_RATE,
      snapshotRate: this.snapshotRate,
      snapshotSizes: percentiles(this.snapshotSizes),
      snapshotsProduced: this.snapshotsProduced,
      packetsSent: this.packetsSent,
      packetsDropped: this.packetsDropped,
      bytesProduced: this.bytesProduced,
      bytesSentByPeer: Object.freeze(byPeer),
      totalUploadBytes: [...this.bytesSentByPeer.values()].reduce((sum, bytes) => sum + bytes, 0),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.eventCleanups.splice(0)) cleanup();
    for (const runtime of this.peersByParticipant.values()) runtime.controller.neutralize();
    this.peersByPeerId.clear();
    this.peersByParticipant.clear();
  }

  private installBinding(binding: MatchPeerBinding): void {
    if (!binding.participantId || !binding.peerId || !Number.isSafeInteger(binding.actorId)
      || this.peersByPeerId.has(binding.peerId) || this.peersByParticipant.has(binding.participantId)) {
      throw new Error('Invalid or duplicate match peer binding');
    }
    const roster = this.match.rosterEntryForActor(binding.actorId);
    if (!roster || roster.ownership.kind === 'bot' || roster.ownership.peerId !== binding.peerId) {
      throw new Error('Match peer does not own the bound human Actor');
    }
    const frozen = Object.freeze({ ...binding });
    const runtime: PeerRuntime = {
      binding: frozen,
      controller: this.makeController(frozen),
      disconnectedAtMs: null,
      reconnectDeadlineMs: null,
      noticeSent: false,
    };
    this.peersByPeerId.set(binding.peerId, runtime);
    this.peersByParticipant.set(binding.participantId, runtime);
    this.match.controllers.set(binding.actorId, runtime.controller);
  }

  private makeController(binding: MatchPeerBinding): RemoteInputController {
    return new RemoteInputController(binding.peerId, binding.actorId, {
      onDisconnect: (peerId) => {
        this.markDisconnected(peerId);
        this.transport.disconnect(peerId);
      },
      onInputTimeout: (actor) => {
        this.match.neutralizeActorActions(actor.id);
      },
      onInputMissing: (actor) => {
        this.match.neutralizeActorActions(actor.id);
      },
      onAcceptedShot: (actor, frame) => {
        const lag = this.options.lagCompensation;
        if (!lag) return false;
        const weapon = actor.inv.selectedWeapon;
        // Match invokes this after inventory/healing selection and weapon
        // timer updates. Keep a defensive phase check for direct callers.
        if (!weapon
          || this.match.phase === 'results'
          || this.match.phase === 'transport' && !actor.deployed) return false;
        const fireMode = WEAPONS[weapon.weaponId].fireMode;
        const wantsFire = fireMode === 'auto'
          ? frame.command.fireHeld
          : frame.command.firePressed;
        if (!wantsFire) return false;
        this.activeShotInputSequenceByActor.set(
          actor.id,
          frame.fireInputSequence ?? frame.sequence,
        );
        try {
          // Match advances hostTick at the start of fixedUpdate and invokes
          // this callback during that same tick, before the session's normal
          // post-step history capture. Capture the accepted-shot boundary now
          // so a legitimate zero-rewind/current-tick shot resolves against a
          // frame that actually exists. The post-step capture below replaces
          // this same tick with the completed state for later shots.
          lag.recordTick(this.match, this.match.hostTick);
          lag.resolveAcceptedShot({
            actor,
            currentHostTick: this.match.hostTick,
            requestedShotTick: frame.shotTick,
            dt: 1 / HOST_TICK_RATE,
          });
        } finally {
          this.activeShotInputSequenceByActor.delete(actor.id);
        }
        // Rejected rewind requests fail closed rather than falling through to
        // an uncompensated client-triggered shot.
        return true;
      },
    });
  }

  private shouldSendSnapshot(): boolean {
    const stride = HOST_TICK_RATE / this.snapshotRate;
    return Number.isInteger(stride) && this.match.hostTick % stride === 0;
  }

  private publishSnapshot(): void {
    const full = this.requestedKeyframe || this.match.hostTick % KEYFRAME_INTERVAL_TICKS === 0;
    this.requestedKeyframe = false;
    const sequence = ++this.snapshotSequence;
    this.snapshotsProduced++;
    for (const runtime of this.peersByParticipant.values()) {
      if (runtime.disconnectedAtMs !== null) continue;
      const encoded = this.encodeSnapshot(this.match.toGameStateView(runtime.binding.actorId), {
        full,
        sequence,
        viewerParticipantId: runtime.binding.participantId,
        viewerPeerId: runtime.binding.peerId,
        viewerActorId: runtime.binding.actorId,
        acknowledgedInputSequence: this.acknowledgedInputByActor.get(runtime.binding.actorId) ?? 0,
        acknowledgedInputByActor: this.acknowledgedInputByActor,
      });
      if (!Number.isSafeInteger(encoded.totalBytes) || encoded.totalBytes < 0
        || encoded.packets.some((packet) => !(packet instanceof ArrayBuffer))) {
        throw new Error('Snapshot encoder returned invalid output');
      }
      this.bytesProduced += encoded.totalBytes;
      pushBounded(this.snapshotSizes, encoded.totalBytes, 2048);
      for (let packetIndex = 0; packetIndex < encoded.packets.length; packetIndex++) {
        const packet = encoded.packets[packetIndex]!;
        const channel = full ? 'control' : 'snapshot';
        if (this.transport.send(runtime.binding.peerId, channel, packet, sequence)) {
          this.packetsSent++;
          this.bytesSentByPeer.set(
            runtime.binding.peerId,
            (this.bytesSentByPeer.get(runtime.binding.peerId) ?? 0) + packet.byteLength,
          );
        } else {
          // A partial logical snapshot can never reassemble. Once a chunk is
          // congested, obsolete-drop the remaining chunks for this peer.
          this.packetsDropped += encoded.packets.length - packetIndex;
          break;
        }
      }
    }
  }

  private maybeTuneSnapshotRate(): void {
    // Measure ten seconds at the initial rate. Increase only when host sim
    // cost, packet size and congestion are all comfortably bounded.
    if (this.snapshotRate !== INITIAL_SNAPSHOT_RATE || this.measuredTicks < HOST_TICK_RATE * 10) return;
    const meanSimMs = this.measuredSimMs / Math.max(1, this.measuredTicks);
    const sizes = percentiles(this.snapshotSizes);
    const dropRatio = this.packetsDropped / Math.max(1, this.packetsSent + this.packetsDropped);
    if (meanSimMs <= 4 && sizes.p95 <= 16 * 1024 && dropRatio <= 0.01) {
      this.snapshotRate = MEASURED_SNAPSHOT_RATE;
    }
  }

  private updatePresence(): void {
    const grace = this.options.disconnectGraceMs ?? 2_000;
    const now = this.nowMs();
    for (const runtime of this.peersByParticipant.values()) {
      if (runtime.disconnectedAtMs === null || runtime.noticeSent || now - runtime.disconnectedAtMs < grace) continue;
      runtime.noticeSent = true;
      const actor = this.match.actors.find((candidate) => candidate.id === runtime.binding.actorId);
      this.publishPresence('playerLeave', runtime.binding.actorId, runtime.binding.peerId);
      this.notifyPresenceNotice('left', actor?.name ?? runtime.binding.participantId);
    }
  }

  private publishPresence(
    type: 'playerLeave' | 'playerRejoin',
    actorId: number,
    peerId: string,
    newPeerId?: string,
  ): void {
    this.emitEvent(type, { actorId, peerId, ...(newPeerId ? { newPeerId } : {}) });
  }

  private bindAuthoritativeEvents(): void {
    const bind = <K extends keyof MatchEventsMap>(type: K): void => {
      this.eventCleanups.push(this.match.events.on(type, (payload) => {
        this.emitEvent(type, payload as unknown as Record<string, unknown>);
      }));
    };
    for (const type of [
      'shotFired', 'impact', 'glassBreak', 'destructibleDestroyed', 'actorHit',
      'shieldHit', 'shieldBroken', 'eliminated', 'itemPickedUp', 'chestOpened', 'reloadStarted',
      'healStarted', 'healCancelled', 'healDone', 'stormWaiting', 'stormShrinking',
      'stormFinal', 'phaseChanged', 'matchWon',
    ] as const) bind(type);
  }

  private emitEvent(type: AuthoritativeMatchEvent['type'], payload: Record<string, unknown>): void {
    const actorId = typeof payload.actorId === 'number' ? payload.actorId : null;
    const predictionInputSequence = type === 'shotFired' && actorId !== null
      ? this.activeShotInputSequenceByActor.get(actorId)
        ?? this.acknowledgedInputByActor.get(actorId)
        ?? null
      : null;
    this.emitEventWithId(this.nextEventId(), type, {
      ...payload,
      ...(predictionInputSequence === null ? {} : { predictionInputSequence }),
    });
  }

  private emitEventWithId(eventId: number, type: AuthoritativeMatchEvent['type'], payload: Record<string, unknown>): void {
    const observer = this.options.onEvent;
    if (!observer) return;
    try {
      observer(Object.freeze({
        eventId,
        revision: this.match.stateRevision,
        hostTick: this.match.hostTick,
        type,
        payload: Object.freeze({ ...payload }),
      }));
    } catch {
      // Event observers are presentation-only and cannot unwind authoritative
      // state or consume a second event ID on retry.
    }
  }

  private notifyPresenceNotice(kind: 'left' | 'rejoined', displayName: string): void {
    const observer = this.options.onPresenceNotice;
    if (!observer) return;
    try {
      observer(kind, displayName);
    } catch {
      // Presence observers cannot change the committed connection lifecycle.
    }
  }

  private nextEventId(): number {
    // Event IDs are monotonic for the lifetime of one authoritative Match.
    // Never wrap to 1: reconnect deduplicators would correctly treat that as
    // replayed history. An impossible multi-year match fails closed instead.
    if (this.eventId === 0xffff_ffff) throw new Error('Authoritative event ID exhausted');
    this.eventId += 1;
    return this.eventId;
  }

  private consumePingRate(peerId: string): boolean {
    const state = this.pingRate.get(peerId) ?? { tokens: 2, tick: this.match.hostTick };
    const elapsed = Math.max(0, this.match.hostTick - state.tick);
    state.tokens = Math.min(2, state.tokens + elapsed / HOST_TICK_RATE);
    state.tick = this.match.hostTick;
    if (state.tokens < 1) {
      this.pingRate.set(peerId, state);
      return false;
    }
    state.tokens -= 1;
    this.pingRate.set(peerId, state);
    return true;
  }

  private expirePings(): void {
    // Pings are event-driven and consumers own their fixed expiry tick. This
    // method intentionally performs no allocation or timer creation.
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? performance.now();
  }
}

function pushBounded(values: number[], value: number, max: number): void {
  values.push(value);
  if (values.length > max) values.splice(0, values.length - max);
}

function percentiles(values: readonly number[]): NetworkPercentiles {
  if (values.length === 0) return Object.freeze({ p50: 0, p95: 0, p99: 0 });
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
  return Object.freeze({ p50: at(0.5), p95: at(0.95), p99: at(0.99) });
}

function rejectedReconnectTransaction(): HostReconnectTransaction {
  return Object.freeze({
    accepted: false,
    alive: false,
    commit: () => undefined,
    rollback: () => undefined,
  });
}

export function neutralInputForNetwork(): InputCommand {
  return {
    moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
    jumpPressed: false, jumpHeld: false, sprint: false, crouchHeld: false,
    crouchPressed: false, fireHeld: false, firePressed: false, adsHeld: false,
    reloadPressed: false, interactPressed: false, slotRequest: null,
    meleePressed: false, dropWeaponPressed: false, dashPressed: false,
    grapplePressed: false, grappleRelease: false, poundPressed: false,
    shieldPressed: false, medkitPressed: false,
  };
}
