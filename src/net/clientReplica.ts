/**
 * Guest-side authoritative replica.
 *
 * A ClientReplica owns no Match, physics world, combat system, or mutation
 * route.  It accepts host-produced snapshots/events, keeps an immutable
 * GameStateView for presentation, and optionally predicts only the local
 * actor's movement transform through an injected shared movement step. Full
 * mobility runtime fields are restored from the host before replay; health,
 * damage, inventory, loot, storm, winner, and results remain authoritative.
 */

import type { AmmoType, HealItemId, WeaponId } from '../core/balance';
import { emptyCommand, type InputCommand } from '../sim/input';
import type {
  ActorView,
  DestructibleView,
  GameStateView,
  InventoryView,
  LocalMovementView,
  MatchWinnerView,
  TeamResult,
  TeamView,
  TransportView,
} from '../sim/gameStateView';
import type { MoveState } from '../sim/actor';
import type { InventoryItem } from '../sim/inventory';

type WeaponInventoryItem = Extract<InventoryItem, { kind: 'weapon' }>;
type HealInventoryItem = Extract<InventoryItem, { kind: 'heal' }>;
import {
  HostClockEstimator,
  type HostClockEstimate,
  type HostClockSample,
  RemoteInterpolationBuffer,
  type RemoteInterpolationOptions,
} from './interpolation';
import {
  LocalMovementPrediction,
  type AuthoritativePredictionState,
  type LocalPredictionOptions,
  type MovementStep,
  type PredictionReconciliation,
  type PredictionState,
  type PredictionTelemetry,
} from './prediction';

export interface AuthoritativeSnapshotInput {
  /** Full immutable view, usually supplied by the protocol adapter. */
  readonly state?: GameStateView;
  /** Host state revision; if omitted, the embedded view's revision is used. */
  readonly revision?: number;
  /** Host timestamp in milliseconds. */
  readonly hostTime?: number;
  readonly hostTick?: number;
  /** Highest local input included by the authoritative state. */
  readonly ackInputSeq?: number;
  readonly receivedAt?: number;
  /** Local WebRTC RTT observation used only to align presentation clocks. */
  readonly roundTripTimeMs?: number;
}

export interface AuthoritativeEventInput {
  readonly eventId?: number;
  readonly revision?: number;
  readonly hostTick?: number;
  readonly hostTime?: number;
  readonly type?: string;
  readonly payload?: unknown;
  readonly state?: GameStateView;
}

export interface ClientReplicaAdapter<Snapshot = unknown, Event = unknown> {
  /** Convert a decoded wire snapshot to the replica's small snapshot surface. */
  snapshot?(value: Snapshot): AuthoritativeSnapshotInput;
  event?(value: Event): AuthoritativeEventInput;
}

/**
 * Optional complete movement-state projection for local reconciliation.
 * `ActorView` intentionally carries only renderer-facing movement fields; a
 * shared movement world can use this hook to attach its owner-only dash,
 * mantle, grapple, wall-run, and coyote-time state to the same snapshot. The
 * already-normalized owner-only `localMovement` projection is provided as the
 * third argument for adapters that need no additional lookup.
 */
export type AuthoritativeStateFromActor<S extends PredictionState = PredictionState> = (
  actor: ActorView,
  previousPredicted: Readonly<S>,
  localMovement: LocalMovementView | null,
) => Readonly<S> | null;

export interface ClientInputFrame {
  readonly inputSeq: number;
  readonly presentationPredictionId: number;
  readonly input: Readonly<InputCommand>;
  readonly dt: number;
}

export interface ClientReplicaOptions<
  S extends PredictionState = PredictionState,
  Snapshot = AuthoritativeSnapshotInput,
  Event = AuthoritativeEventInput,
> {
  readonly initialView?: GameStateView | null;
  readonly localActorId?: number | null;
  readonly now?: () => number;
  readonly interpolation?: RemoteInterpolationOptions;
  readonly clock?: HostClockEstimator;
  readonly movementStep?: MovementStep<S>;
  readonly authoritativeStateFromActor?: AuthoritativeStateFromActor<S>;
  readonly prediction?: Omit<LocalPredictionOptions<S>, 'initialState' | 'movementStep'> & {
    readonly initialState?: S;
  };
  readonly initialPredictionState?: S;
  readonly adapter?: ClientReplicaAdapter<Snapshot, Event>;
  readonly onInput?: (frame: ClientInputFrame) => void;
}

export interface ClientReplicaSnapshotResult {
  readonly accepted: boolean;
  readonly revision: number;
  readonly acknowledgedInputId: number;
  readonly reconciliation: PredictionReconciliation | null;
}

export interface ClientReplicaEventResult {
  readonly accepted: boolean;
  readonly eventId: number;
  readonly revision: number;
}

interface NormalizedSnapshot {
  readonly state: GameStateView;
  readonly revision: number;
  readonly hostTime: number;
  readonly receivedAt: number;
  readonly roundTripTimeMs: number;
  readonly acknowledgedInputId: number;
}

interface NormalizedEvent {
  readonly eventId: number;
  readonly revision: number;
  readonly hostTime: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly state?: GameStateView;
}

const MOVE_STATES: readonly MoveState[] = Object.freeze([
  'ground', 'air', 'slide', 'wallrun', 'mantle', 'grapple',
  'poundWindup', 'poundFall', 'swim', 'freefall', 'glide',
]);
const MAX_PRESENTATION_PREDICTION_IDS = 1024;
const DEFAULT_STORM = Object.freeze({
  state: 'idle' as const,
  phaseIndex: -1,
  timer: 0,
  centerX: 0,
  centerZ: 0,
  radius: 0,
});
const DEFAULT_TRANSPORT: TransportView = Object.freeze({ x: 0, y: 0, z: 0, jumpAllowed: false });

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

function clonePosition(value: unknown, fallback = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
  const p = record(value);
  return {
    x: finite(p.x, fallback.x),
    y: finite(p.y, fallback.y),
    z: finite(p.z, fallback.z),
  };
}

function cloneTransport(value: unknown, fallback: TransportView = DEFAULT_TRANSPORT): TransportView {
  const source = record(value);
  return {
    x: finite(source.x, fallback.x),
    y: finite(source.y, fallback.y),
    z: finite(source.z, fallback.z),
    jumpAllowed: typeof source.jumpAllowed === 'boolean' ? source.jumpAllowed : fallback.jumpAllowed,
  };
}

function cloneInput(value: Partial<InputCommand>): InputCommand {
  const command = emptyCommand();
  for (const key of Object.keys(command) as Array<keyof InputCommand>) {
    const item = value[key];
    if (item !== undefined) command[key] = item as never;
  }
  return command;
}

function freezePosition(value: { x: number; y: number; z: number }): Readonly<{ x: number; y: number; z: number }> {
  return Object.freeze(value);
}

function cloneOwnership(value: unknown): ActorView['ownership'] {
  const ownership = record(value);
  if (ownership.kind === 'bot') return Object.freeze({ kind: 'bot' });
  const kind = ownership.kind === 'local-human' ? 'local-human' : 'remote-human';
  return Object.freeze({ kind, peerId: typeof ownership.peerId === 'string' ? ownership.peerId : '' });
}

function cloneInventory(value: unknown): InventoryView | null {
  if (value === null || value === undefined) return null;
  const source = record(value);
  const slots: Array<Readonly<InventoryItem> | null> = Array.isArray(source.slots)
    ? source.slots.map((item) => {
      if (!item || typeof item !== 'object') return null;
      const itemRecord = record(item);
      if (itemRecord.kind === 'weapon') {
        return Object.freeze({
          kind: 'weapon' as const,
          weaponId: itemRecord.weaponId as WeaponInventoryItem['weaponId'],
          rarity: itemRecord.rarity as WeaponInventoryItem['rarity'],
          ammoInMag: finite(itemRecord.ammoInMag, 0),
        });
      }
      return Object.freeze({
        kind: 'heal' as const,
        itemId: itemRecord.itemId as HealInventoryItem['itemId'],
        count: finite(itemRecord.count, 0),
      });
    })
    : [null, null, null, null, null];
  while (slots.length < 5) slots.push(null);
  const ammoSource = record(source.ammo);
  return Object.freeze({
    selected: integer(source.selected, -1),
    slots: Object.freeze(slots.slice(0, 5)),
    ammo: Object.freeze({
      light: finite(ammoSource.light, 0),
      medium: finite(ammoSource.medium, 0),
      shells: finite(ammoSource.shells, 0),
      heavy: finite(ammoSource.heavy, 0),
    }),
    healing: source.healing && typeof source.healing === 'object'
      ? Object.freeze({ ...record(source.healing) }) as InventoryView['healing']
      : null,
  });
}

function cloneActor(value: unknown): ActorView {
  const source = record(value);
  const position = clonePosition(source.position);
  const velocity = clonePosition(source.velocity);
  const moveState = MOVE_STATES.includes(source.moveState as MoveState)
    ? source.moveState as MoveState
    : 'ground';
  return Object.freeze({
    id: integer(source.id, 0),
    displayName: typeof source.displayName === 'string' ? source.displayName : '',
    ownership: cloneOwnership(source.ownership),
    connectionState: source.connectionState === 'disconnected' ? 'disconnected'
      : source.connectionState === 'bot' ? 'bot' : 'connected',
    teamId: source.teamId === null || source.teamId === undefined ? null : integer(source.teamId, 0),
    skinId: typeof source.skinId === 'string' ? source.skinId as ActorView['skinId'] : 'vanguard',
    accentColor: integer(source.accentColor, 0),
    alive: source.alive !== false,
    health: finite(source.health, 0),
    shield: finite(source.shield, 0),
    position: freezePosition(position),
    velocity: freezePosition(velocity),
    yaw: finite(source.yaw, 0),
    pitch: finite(source.pitch, 0),
    grounded: source.grounded === true,
    moveState,
    crouched: source.crouched === true,
    deployed: source.deployed !== false,
    equippedWeapon: source.equippedWeapon === null || source.equippedWeapon === undefined
      ? null : source.equippedWeapon as WeaponId,
    inventory: cloneInventory(source.inventory),
    placement: integer(source.placement, 0),
    stats: Object.freeze({
      kills: finite(record(source.stats).kills, 0),
      damageDealt: finite(record(source.stats).damageDealt, 0),
      shotsFired: finite(record(source.stats).shotsFired, 0),
      shotsHit: finite(record(source.stats).shotsHit, 0),
      headshots: finite(record(source.stats).headshots, 0),
      survivalTime: finite(record(source.stats).survivalTime, 0),
    }),
  });
}

function cloneTeam(value: unknown): TeamView {
  const source = record(value);
  const members = Array.isArray(source.members) ? source.members.map((member) => {
    const item = record(member);
    return Object.freeze({
      actorId: integer(item.actorId, 0),
      slotId: integer(item.slotId, 0),
      displayName: typeof item.displayName === 'string' ? item.displayName : '',
      accentColor: integer(item.accentColor, 0),
      alive: item.alive === true,
      connectionState: item.connectionState === 'disconnected' ? 'disconnected'
        : item.connectionState === 'bot' ? 'bot' : 'connected',
    });
  }) : [];
  return Object.freeze({
    teamId: integer(source.teamId, 0),
    members: Object.freeze(members),
    aliveCount: integer(source.aliveCount, members.filter((member) => member.alive).length),
  });
}

function cloneChest(value: unknown): GameStateView['chests'][number] {
  const source = record(value);
  const kind = source.kind === 'elite' || source.kind === 'vault' ? source.kind : 'standard';
  return Object.freeze({
    id: integer(source.id, 0), kind,
    x: finite(source.x, 0), y: finite(source.y, 0), z: finite(source.z, 0),
    opened: source.opened === true,
  });
}

function cloneLoot(value: unknown): GameStateView['loot'][number] {
  const source = record(value);
  const kind = source.kind === 'ammo' || source.kind === 'heal' ? source.kind : 'weapon';
  const common = {
    id: integer(source.id, 0),
    x: finite(source.x, 0), y: finite(source.y, 0), z: finite(source.z, 0),
    yaw: finite(source.yaw, 0),
    rarity: typeof source.rarity === 'string'
      ? source.rarity as GameStateView['loot'][number]['rarity'] : 'common' as const,
  };
  if (kind === 'weapon') {
    const weapon = record(source.weapon);
    return Object.freeze({
      ...common,
      kind: 'weapon' as const,
      weaponId: (source.weaponId ?? weapon.weaponId ?? 'pistol') as WeaponId,
      ammoInMag: finite(source.ammoInMag ?? weapon.ammoInMag, 0),
    });
  }
  if (kind === 'ammo') {
    const ammo = record(source.ammo);
    return Object.freeze({
      ...common,
      kind: 'ammo' as const,
      ammoType: (source.ammoType ?? ammo.type ?? 'light') as AmmoType,
      amount: finite(source.amount ?? ammo.amount, 0),
    });
  }
  const heal = record(source.heal);
  return Object.freeze({
    ...common,
    kind: 'heal' as const,
    itemId: (source.itemId ?? heal.itemId ?? 'medkit') as HealItemId,
    count: finite(source.count ?? heal.count, 0),
  });
}

function cloneStorm(value: unknown): GameStateView['storm'] {
  const source = record(value);
  const state = source.state === 'waiting' || source.state === 'shrinking' || source.state === 'done'
    ? source.state : DEFAULT_STORM.state;
  return Object.freeze({
    state,
    phaseIndex: integer(source.phaseIndex, DEFAULT_STORM.phaseIndex),
    timer: finite(source.timer, 0),
    centerX: finite(source.centerX, 0),
    centerZ: finite(source.centerZ, 0),
    radius: finite(source.radius, DEFAULT_STORM.radius),
  });
}

function cloneLocalMovement(value: unknown): LocalMovementView | null {
  if (!value || typeof value !== 'object') return null;
  const source = record(value);
  const waterSurfaceY = typeof source.waterSurfaceY === 'number' && Number.isFinite(source.waterSurfaceY)
    ? source.waterSurfaceY : null;
  return Object.freeze({
    actorId: integer(source.actorId, -1),
    groundNormalY: finite(source.groundNormalY, 1),
    hitCeiling: source.hitCeiling === true,
    slidAlongWall: source.slidAlongWall === true,
    slideTimer: finite(source.slideTimer, 0),
    slideDirX: finite(source.slideDirX, 0),
    slideDirZ: finite(source.slideDirZ, 0),
    slideCooldown: finite(source.slideCooldown, 0),
    wallrunTimer: finite(source.wallrunTimer, 0),
    wallSide: finite(source.wallSide, 0),
    wallNormalX: finite(source.wallNormalX, 0),
    wallNormalZ: finite(source.wallNormalZ, 0),
    mantleTimer: finite(source.mantleTimer, 0),
    mantleCooldown: finite(source.mantleCooldown, 0),
    mantleFrom: freezePosition(clonePosition(source.mantleFrom)),
    mantleTo: freezePosition(clonePosition(source.mantleTo)),
    grappleActive: source.grappleActive === true,
    grapplePoint: freezePosition(clonePosition(source.grapplePoint)),
    grappleCooldown: finite(source.grappleCooldown, 0),
    dashCharges: finite(source.dashCharges, 0),
    dashRegen: finite(source.dashRegen, 0),
    dashTimer: finite(source.dashTimer, 0),
    dashDirX: finite(source.dashDirX, 0),
    dashDirZ: finite(source.dashDirZ, 0),
    jumpsUsed: integer(source.jumpsUsed, 0),
    coyote: finite(source.coyote, 0),
    jumpBuffered: finite(source.jumpBuffered, 0),
    bhopWindow: finite(source.bhopWindow, 0),
    wallrunCooldown: finite(source.wallrunCooldown, 0),
    wallrunLanded: source.wallrunLanded === true,
    wallrunChains: integer(source.wallrunChains, 0),
    lastWallNx: finite(source.lastWallNx, 0),
    lastWallNz: finite(source.lastWallNz, 0),
    peakFallSpeed: finite(source.peakFallSpeed, 0),
    airborneGroundTime: finite(source.airborneGroundTime, 0),
    poundTimer: finite(source.poundTimer, 0),
    footstepAccum: finite(source.footstepAccum, 0),
    inWater: source.inWater === true,
    submerged: source.submerged === true,
    waterSurfaceY,
    adsAmount: finite(source.adsAmount, 0),
    healingMovementPenalty: source.healingMovementPenalty === true,
  });
}

function cloneWinner(value: unknown): MatchWinnerView | null {
  if (!value || typeof value !== 'object') return null;
  const source = record(value);
  if (source.kind === 'team') return Object.freeze({ kind: 'team', teamId: integer(source.teamId, 0) });
  if (source.kind === 'actor') {
    return Object.freeze({
      kind: 'actor', actorId: integer(source.actorId, 0),
      displayName: typeof source.displayName === 'string' ? source.displayName : '',
    });
  }
  return null;
}

function cloneResult(value: unknown): TeamResult {
  const source = record(value);
  const surviving = Array.isArray(source.survivingActorIds)
    ? source.survivingActorIds.map((id) => integer(id, 0)) : [];
  return Object.freeze({
    teamId: integer(source.teamId, 0),
    won: source.won === true,
    eliminations: integer(source.eliminations, 0),
    survivingActorIds: Object.freeze(surviving),
  });
}

function cloneDestructible(value: unknown): DestructibleView {
  const source = record(value);
  return Object.freeze({
    id: typeof source.id === 'string' ? source.id : String(integer(source.id, 0)),
    revision: integer(source.revision, 0),
    destroyed: source.destroyed === true,
  });
}

/** Deeply copy and freeze the exact renderer-facing view contract. */
export function freezeGameStateView(value: unknown): GameStateView {
  const source = record(value);
  const phase = source.phase === 'drop' || source.phase === 'live' || source.phase === 'results'
    ? source.phase : 'transport';
  const actors = Array.isArray(source.actors) ? source.actors.map(cloneActor) : [];
  const teams = Array.isArray(source.teams) ? source.teams.map(cloneTeam) : [];
  const chests = Array.isArray(source.chests) ? source.chests.map(cloneChest) : [];
  const loot = Array.isArray(source.loot) ? source.loot.map(cloneLoot) : [];
  const destructibles = Array.isArray(source.destructibles) ? source.destructibles.map(cloneDestructible) : [];
  const mode = source.mode === 'ffa-bot-fill' || source.mode === 'ffa' || source.mode === 'teams'
    || source.mode === 'teams-bot-fill' || source.mode === 'humans-vs-bots' ? source.mode : 'solo';
  const transport = cloneTransport(source.transport, DEFAULT_TRANSPORT);
  return Object.freeze({
    hostTick: integer(source.hostTick, 0),
    stateRevision: integer(source.stateRevision, 0),
    time: finite(source.time, 0),
    phaseTime: finite(source.phaseTime, 0),
    phase,
    actors: Object.freeze(actors),
    localActorId: source.localActorId === null || source.localActorId === undefined
      ? null : integer(source.localActorId, 0),
    teams: Object.freeze(teams),
    mode,
    chests: Object.freeze(chests),
    loot: Object.freeze(loot),
    storm: cloneStorm(source.storm),
    transport: Object.freeze(transport),
    localMovement: cloneLocalMovement(source.localMovement),
    destructibles: Object.freeze(destructibles),
    winner: cloneWinner(source.winner),
    teamResults: Object.freeze(Array.isArray(source.teamResults) ? source.teamResults.map(cloneResult) : []),
  });
}

function mergeView(base: GameStateView, patch: Partial<GameStateView>): GameStateView {
  return freezeGameStateView({ ...base, ...patch });
}

function numericAlias(source: Record<string, unknown>, names: readonly string[], fallback: number): number {
  for (const name of names) {
    if (source[name] !== undefined) return finite(source[name], fallback);
  }
  return fallback;
}

function intAlias(source: Record<string, unknown>, names: readonly string[], fallback: number): number {
  for (const name of names) {
    if (source[name] !== undefined) return integer(source[name], fallback);
  }
  return fallback;
}

function snapshotState(value: AuthoritativeSnapshotInput): GameStateView {
  const source = record(value);
  const candidate = source.state
    ?? (Array.isArray(source.actors) ? source : null);
  return freezeGameStateView(candidate ?? {});
}

function normalizeSnapshot(value: AuthoritativeSnapshotInput, fallbackRevision: number, now: number): NormalizedSnapshot {
  const source = record(value);
  const state = snapshotState(value);
  const revision = intAlias(source, ['revision'],
    state.stateRevision || fallbackRevision);
  const hostTick = intAlias(source, ['hostTick'], state.hostTick);
  const hostTime = numericAlias(source, ['hostTime'],
    hostTick > 0 ? hostTick * (1000 / 60) : state.time * 1000);
  const receivedAt = numericAlias(source, ['receivedAt'], now);
  const roundTripTimeMs = Math.min(10_000, Math.max(0,
    numericAlias(source, ['roundTripTimeMs'], 0),
  ));
  const acknowledgedInputId = intAlias(source, ['ackInputSeq'], 0);
  const adjusted = freezeGameStateView({
    ...state,
    hostTick,
    stateRevision: revision,
  });
  return { state: adjusted, revision, hostTime, receivedAt, roundTripTimeMs, acknowledgedInputId };
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeEvent(value: AuthoritativeEventInput, fallbackRevision: number, now: number): NormalizedEvent {
  const source = record(value);
  const payload = payloadRecord(source.payload ?? source);
  const eventId = integer(source.eventId, fallbackRevision);
  const revision = intAlias(source, ['revision'], fallbackRevision);
  const eventType = source.type ?? payload.type ?? 'unknown';
  const type = typeof eventType === 'string' ? eventType : String(eventType);
  const hostTick = intAlias(source, ['hostTick'], 0);
  const hostTime = numericAlias(source, ['hostTime'], hostTick > 0 ? hostTick * (1000 / 60) : now);
  const eventState = source.state ?? payload.state;
  return {
    eventId, revision, hostTime, type, payload,
    state: eventState && typeof eventState === 'object' ? freezeGameStateView(eventState) : undefined,
  };
}

/**
 * Fallback transform/basic-mobility baseline for the renderer-facing view.
 *
 * ActorView deliberately does not contain the complete shared movement
 * machine state.  Callers using a richer S must provide
 * `authoritativeStateFromActor`; this fallback must never be treated as a
 * complete dash/mantle/grapple/coyote baseline.
 */
function actorTransformBaseline(actor: ActorView): PredictionState {
  return {
    position: actor.position,
    velocity: actor.velocity,
    yaw: actor.yaw,
    pitch: actor.pitch,
    grounded: actor.grounded,
    state: actor.moveState,
  };
}

/**
 * Build the complete shared movement baseline carried by GameStateView. The
 * projection contains every ClientMovementPredictionState mobility field;
 * spreading the previous state also preserves fields from a compatible
 * caller-defined S. This is a full movement-state merge, not a transform
 * object cast, and it never copies gameplay authority into prediction.
 */
function buildLocalMovementBaseline<S extends PredictionState>(
  actor: ActorView,
  localMovement: LocalMovementView | null,
  previous: Readonly<S>,
): S | null {
  if (!localMovement || localMovement.actorId !== actor.id) return null;
  const baseline = {
    ...previous,
    position: clonePosition(actor.position),
    velocity: clonePosition(actor.velocity),
    yaw: actor.yaw,
    pitch: actor.pitch,
    grounded: actor.grounded,
    state: actor.moveState,
    movementEnabled: actor.alive,
    deployed: actor.deployed,
    crouched: actor.crouched,
    groundNormalY: localMovement.groundNormalY,
    hitCeiling: localMovement.hitCeiling,
    slidAlongWall: localMovement.slidAlongWall,
    slideTimer: localMovement.slideTimer,
    slideDirX: localMovement.slideDirX,
    slideDirZ: localMovement.slideDirZ,
    slideCooldown: localMovement.slideCooldown,
    wallrunTimer: localMovement.wallrunTimer,
    wallSide: localMovement.wallSide,
    wallNormalX: localMovement.wallNormalX,
    wallNormalZ: localMovement.wallNormalZ,
    mantleTimer: localMovement.mantleTimer,
    mantleCooldown: localMovement.mantleCooldown,
    mantleFrom: clonePosition(localMovement.mantleFrom),
    mantleTo: clonePosition(localMovement.mantleTo),
    grappleActive: localMovement.grappleActive,
    grapplePoint: clonePosition(localMovement.grapplePoint),
    grappleCooldown: localMovement.grappleCooldown,
    dashCharges: localMovement.dashCharges,
    dashRegen: localMovement.dashRegen,
    dashTimer: localMovement.dashTimer,
    dashDirX: localMovement.dashDirX,
    dashDirZ: localMovement.dashDirZ,
    jumpsUsed: localMovement.jumpsUsed,
    coyote: localMovement.coyote,
    jumpBuffered: localMovement.jumpBuffered,
    bhopWindow: localMovement.bhopWindow,
    wallrunCooldown: localMovement.wallrunCooldown,
    wallrunLanded: localMovement.wallrunLanded,
    wallrunChains: localMovement.wallrunChains,
    lastWallNx: localMovement.lastWallNx,
    lastWallNz: localMovement.lastWallNz,
    peakFallSpeed: localMovement.peakFallSpeed,
    airborneGroundTime: localMovement.airborneGroundTime,
    poundTimer: localMovement.poundTimer,
    footstepAccum: localMovement.footstepAccum,
    inWater: localMovement.inWater,
    submerged: localMovement.submerged,
    waterSurfaceY: localMovement.waterSurfaceY ?? Number.NEGATIVE_INFINITY,
    equippedWeapon: actor.equippedWeapon,
    adsAmount: localMovement.adsAmount,
    healingMovementPenalty: localMovement.healingMovementPenalty,
  };
  return baseline as S;
}

function stateActor(state: GameStateView, actorId: number): ActorView | null {
  return state.actors.find((actor) => actor.id === actorId) ?? null;
}

function applyEventToView(view: GameStateView, event: NormalizedEvent): GameStateView {
  if (event.state) return event.state;
  const payload = event.payload;
  const type = event.type.toLowerCase();
  if (type === 'phasechanged' || type === 'phase-changed' || type === 'phase') {
    const phase = payload.phase;
    if (phase === 'transport' || phase === 'drop' || phase === 'live' || phase === 'results') {
      return mergeView(view, { phase, phaseTime: finite(payload.phaseTime, 0) });
    }
  }
  if (type === 'transport' || type === 'transportphase' || type === 'transport-phase') {
    const phase = payload.phase;
    const transport = payload.transport ?? payload.position;
    return mergeView(view, {
      phase: phase === 'drop' || phase === 'live' || phase === 'results' ? phase : 'transport',
      transport: cloneTransport(transport, view.transport),
    });
  }
  if (type === 'stormwaiting' || type === 'storm-waiting') {
    return mergeView(view, {
      storm: {
        ...view.storm,
        state: 'waiting',
        phaseIndex: intAlias(payload, ['index', 'phaseIndex'], view.storm.phaseIndex),
        timer: finite(payload.waitTime, view.storm.timer),
        radius: finite(payload.targetRadius, view.storm.radius),
      },
    });
  }
  if (type === 'stormshrinking' || type === 'storm-shrinking') {
    return mergeView(view, {
      storm: {
        ...view.storm,
        state: 'shrinking',
        phaseIndex: intAlias(payload, ['index', 'phaseIndex'], view.storm.phaseIndex),
        timer: finite(payload.shrinkTime, view.storm.timer),
        radius: finite(payload.targetRadius, view.storm.radius),
      },
    });
  }
  if (type === 'stormfinal' || type === 'storm-final') {
    return mergeView(view, { storm: { ...view.storm, state: 'done', timer: 0 } });
  }
  if (type === 'eliminated' || type === 'death' || type === 'actor-dead') {
    const actorId = intAlias(payload, ['victimId', 'actorId', 'targetId'], -1);
    const actors = view.actors.map((actor) => actor.id !== actorId ? actor : freezeGameStateView({
      ...view,
      actors: [{ ...actor, alive: false, placement: integer(payload.placement, actor.placement) }],
    }).actors[0]!);
    if (actorId >= 0) return mergeView(view, { actors });
  }
  if (type === 'transportjumped' || type === 'transport-jumped') {
    const actorId = intAlias(payload, ['actorId', 'id'], -1);
    if (actorId >= 0) {
      const actors = view.actors.map((actor) => actor.id === actorId
        ? freezeGameStateView({ ...view, actors: [{ ...actor, deployed: true }] }).actors[0]!
        : actor);
      return mergeView(view, { actors });
    }
  }
  if (type === 'playerleave' || type === 'player-leave'
    || type === 'playerrejoin' || type === 'player-rejoin') {
    const actorId = intAlias(payload, ['actorId', 'id'], -1);
    if (actorId >= 0) {
      const connected = type === 'playerrejoin' || type === 'player-rejoin';
      const replacementPeerId = typeof payload.newPeerId === 'string' ? payload.newPeerId : null;
      const actors = view.actors.map((actor) => {
        if (actor.id !== actorId || actor.ownership.kind === 'bot') return actor;
        return freezeGameStateView({
          ...view,
          actors: [{
            ...actor,
            connectionState: connected ? 'connected' : 'disconnected',
            ownership: replacementPeerId
              ? { ...actor.ownership, peerId: replacementPeerId }
              : actor.ownership,
          }],
        }).actors[0]!;
      });
      return mergeView(view, { actors });
    }
  }
  if (type === 'matchwon' || type === 'match-won' || type === 'winner') {
    const winner = payload.winner ?? payload;
    const normalizedWinner = cloneWinner(winner);
    if (normalizedWinner) return mergeView(view, { winner: normalizedWinner, phase: 'results' });
    if (payload.teamId !== undefined && payload.teamId !== null) return mergeView(view, {
      winner: Object.freeze({ kind: 'team', teamId: integer(payload.teamId, 0) }), phase: 'results',
    });
    if (payload.winnerId !== undefined || payload.actorId !== undefined) return mergeView(view, {
      winner: Object.freeze({
        kind: 'actor', actorId: intAlias(payload, ['winnerId', 'actorId'], 0),
        displayName: typeof payload.winnerName === 'string' ? payload.winnerName : '',
      }), phase: 'results',
    });
  }
  if (type === 'results' || type === 'teamresults' || type === 'team-results') {
    const rawResults = payload.teamResults ?? payload.results;
    const results = Array.isArray(rawResults) ? rawResults.map(cloneResult) : view.teamResults;
    return mergeView(view, { teamResults: results, phase: 'results' });
  }
  if (type === 'chestopened' || type === 'chest-opened') {
    const chestId = intAlias(payload, ['chestId', 'id'], -1);
    if (chestId >= 0) return mergeView(view, {
      chests: view.chests.map((chest) => chest.id === chestId ? Object.freeze({ ...chest, opened: true }) : chest),
    });
  }
  if (type === 'itempickedup' || type === 'item-picked-up') {
    const itemId = intAlias(payload, ['itemId', 'id'], -1);
    if (itemId >= 0) return mergeView(view, { loot: view.loot.filter((item) => item.id !== itemId) });
  }
  if (type === 'glassbreak' || type === 'glass-break'
    || type === 'destructibledestroyed' || type === 'destructible-destroyed') {
    const id = typeof payload.destructibleId === 'string' ? payload.destructibleId : String(payload.id ?? '');
    if (id) {
      const revision = integer(payload.revision, event.revision);
      return mergeView(view, {
        destructibles: view.destructibles.map((item) => item.id === id
          ? Object.freeze({ ...item, destroyed: true, revision: Math.max(item.revision, revision) })
          : item),
      });
    }
  }
  return view;
}

function applyDiscreteOverlay(sampled: GameStateView, authoritative: GameStateView): GameStateView {
  // Events can arrive on the reliable channel ahead of the next lossy
  // snapshot.  Overlay only discrete authoritative fields; positions remain
  // owned by interpolation/prediction.
  const sampledById = new Map(sampled.actors.map((actor) => [actor.id, actor]));
  const authoritativeById = new Map(authoritative.actors.map((actor) => [actor.id, actor]));
  const actors = sampled.actors.map((actor) => {
    const auth = authoritativeById.get(actor.id);
    if (!auth) return actor;
    // Keep the interpolated transform, but use the newest authoritative
    // metadata immediately. This prevents stale health/inventory/results
    // presentation while never turning a remote snapshot into a simulation.
    return Object.freeze({
      ...actor,
      displayName: auth.displayName,
      ownership: auth.ownership,
      connectionState: auth.connectionState,
      teamId: auth.teamId,
      skinId: auth.skinId,
      accentColor: auth.accentColor,
      alive: auth.alive,
      health: auth.health,
      shield: auth.shield,
      grounded: auth.grounded,
      moveState: auth.moveState,
      crouched: auth.crouched,
      deployed: auth.deployed,
      equippedWeapon: auth.equippedWeapon,
      inventory: auth.inventory,
      placement: auth.placement,
      stats: auth.stats,
    });
  });
  for (const actor of authoritative.actors) {
    if (!sampledById.has(actor.id)) actors.push(actor);
  }
  return freezeGameStateView({
    ...sampled,
    phase: sampled.phase === authoritative.phase ? sampled.phase : authoritative.phase,
    winner: authoritative.winner,
    teamResults: authoritative.teamResults,
    chests: authoritative.chests,
    loot: authoritative.loot,
    storm: authoritative.storm,
    destructibles: authoritative.destructibles,
    teams: authoritative.teams,
    mode: authoritative.mode,
    phaseTime: authoritative.phaseTime,
    actors,
    transport: sampled.phase === authoritative.phase
      ? { ...sampled.transport, jumpAllowed: authoritative.transport.jumpAllowed }
      : authoritative.transport,
    localMovement: authoritative.localMovement,
  });
}

/**
 * Guest state replica.  Constructing this object never constructs a Match;
 * the only simulation dependency is the explicitly injected movement step.
 */
export class ClientReplica<
  S extends PredictionState = PredictionState,
  Snapshot = AuthoritativeSnapshotInput,
  Event = AuthoritativeEventInput,
> {
  readonly interpolation: RemoteInterpolationBuffer<GameStateView>;
  readonly adapter?: ClientReplicaAdapter<Snapshot, Event>;
  readonly onInput?: (frame: ClientInputFrame) => void;

  private readonly now: () => number;
  private readonly movementStep?: MovementStep<S>;
  private readonly authoritativeStateFromActor?: AuthoritativeStateFromActor<S>;
  private readonly predictionOptions: ClientReplicaOptions<S, Snapshot, Event>['prediction'];
  private readonly configuredLocalActorId: number | null;
  private readonly hasConfiguredLocalActorId: boolean;
  private readonly initialPredictionState?: S;
  private prediction: LocalMovementPrediction<S> | null = null;
  private localActorIdValue: number | null;
  private latestAuthoritative: GameStateView | null = null;
  private latestRevisionValue = -1;
  private latestEventRevisionValue = -1;
  private highestEventId: number | null = null;
  private readonly eventLog: NormalizedEvent[] = [];
  private readonly pendingPresentationPredictionIds = new Set<number>();
  private readonly acknowledgedPresentationPredictionIdsValue = new Set<number>();
  private fallbackPredictionId = 1;
  private lastReconciliationValue: PredictionReconciliation | null = null;
  private lastUpdateMs: number | null = null;

  constructor(options: ClientReplicaOptions<S, Snapshot, Event> = {}) {
    this.now = options.now ?? (() => Date.now());
    this.adapter = options.adapter;
    this.onInput = options.onInput;
    this.movementStep = options.movementStep;
    this.authoritativeStateFromActor = options.authoritativeStateFromActor;
    this.predictionOptions = options.prediction;
    this.hasConfiguredLocalActorId = options.localActorId !== undefined;
    this.configuredLocalActorId = options.localActorId ?? null;
    this.initialPredictionState = options.initialPredictionState;
    this.localActorIdValue = options.localActorId ?? options.initialView?.localActorId ?? null;
    this.interpolation = new RemoteInterpolationBuffer<GameStateView>(options.interpolation, options.clock);
    if (options.initialView) {
      const state = freezeGameStateView(options.initialView);
      this.latestAuthoritative = state;
      this.localActorIdValue = options.localActorId ?? state.localActorId;
      this.latestRevisionValue = state.stateRevision;
      const initial = normalizeSnapshot({ state }, state.stateRevision, this.now());
      this.interpolation.push({ revision: initial.revision, hostTime: initial.hostTime, state: initial.state }, initial.receivedAt);
      this.maybeCreatePrediction(state, options.initialPredictionState);
    }
  }

  get localActorId(): number | null {
    return this.localActorIdValue;
  }

  get latestRevision(): number {
    return this.latestRevisionValue;
  }

  get latestEventRevision(): number {
    return this.latestEventRevisionValue;
  }

  get lastReconciliation(): PredictionReconciliation | null {
    return this.lastReconciliationValue;
  }

  get predictionController(): LocalMovementPrediction<S> | null {
    return this.prediction;
  }

  get inputHistory() {
    return this.prediction?.inputHistory ?? Object.freeze([]);
  }

  /** Monotonic local IDs available to presentation effects (muzzle, dash, etc.). */
  get presentationPredictionIds(): readonly number[] {
    return Object.freeze([...this.pendingPresentationPredictionIds]);
  }

  get acknowledgedPresentationPredictionIds(): readonly number[] {
    return Object.freeze([...this.acknowledgedPresentationPredictionIdsValue]);
  }

  get clockEstimate(): HostClockEstimate {
    return this.interpolation.clock.estimate();
  }

  get bufferMs(): number {
    return this.interpolation.bufferMs;
  }

  /** Submit one local input and return its stable presentation-prediction ID. */
  submitInput(input: Partial<InputCommand>, dt = 1 / 60): number {
    const id = this.prediction?.submitInput(input, dt) ?? this.fallbackPredictionId++;
    this.pendingPresentationPredictionIds.add(id);
    trimNumberSet(this.pendingPresentationPredictionIds);
    const command = cloneInput(input);
    const frame: ClientInputFrame = Object.freeze({
      inputSeq: id,
      presentationPredictionId: id,
      input: Object.freeze(command),
      dt,
    });
    try {
      this.onInput?.(frame);
    } catch {
      // Input observers cannot corrupt local presentation state.
    }
    return id;
  }

  observeClock(sample: HostClockSample): HostClockEstimate {
    return this.interpolation.observeClock(sample);
  }

  applySnapshot(input: Snapshot, receivedAt = this.now()): ClientReplicaSnapshotResult {
    const snapshot = this.adapter?.snapshot
      ? this.adapter.snapshot(input)
      : input as unknown as AuthoritativeSnapshotInput;
    const normalized = normalizeSnapshot(snapshot, this.latestRevisionValue + 1, receivedAt);
    if (!Number.isSafeInteger(normalized.revision) || normalized.revision <= this.latestRevisionValue) {
      return Object.freeze({ accepted: false, revision: normalized.revision, acknowledgedInputId: normalized.acknowledgedInputId, reconciliation: null });
    }
    // Host ticks start at a different origin from the browser's monotonic
    // clock. Align those domains before sampling the intentional 80–120 ms
    // interpolation delay. The transport RTT bounds the midpoint estimate;
    // when stats are not available yet, the first arrival still establishes
    // a usable offset and later samples smooth out route jitter.
    this.interpolation.observeClock({
      clientSentAt: normalized.receivedAt - normalized.roundTripTimeMs,
      clientReceivedAt: normalized.receivedAt,
      hostTime: normalized.hostTime,
    });
    const pushed = this.interpolation.push({
      revision: normalized.revision,
      hostTime: normalized.hostTime,
      state: normalized.state,
    }, normalized.receivedAt);
    if (!pushed) {
      return Object.freeze({ accepted: false, revision: normalized.revision, acknowledgedInputId: normalized.acknowledgedInputId, reconciliation: null });
    }
    this.latestRevisionValue = normalized.revision;
    this.latestAuthoritative = normalized.state;
    if (!this.hasConfiguredLocalActorId && normalized.state.localActorId !== null) {
      this.localActorIdValue = normalized.state.localActorId;
    }
    this.acknowledgePresentationThrough(normalized.acknowledgedInputId);
    const hadPrediction = this.prediction !== null;
    this.maybeCreatePrediction(normalized.state, this.initialPredictionState);
    if (this.eventLog.length > 0) {
      for (const event of this.eventLog) {
        if (event.revision >= normalized.revision) this.latestAuthoritative = applyEventToView(this.latestAuthoritative!, event);
      }
    }
    const localActor = this.localActorIdValue === null || !this.latestAuthoritative
      ? null : stateActor(this.latestAuthoritative, this.localActorIdValue);
    if (localActor && this.prediction && hadPrediction) {
      const previousPredicted = this.prediction.predictedState;
      const authoritativeMovement: PredictionState | AuthoritativePredictionState<S> | Readonly<S> =
        this.authoritativeStateFromActor?.(
          localActor,
          previousPredicted,
          this.latestAuthoritative.localMovement,
        )
          ?? buildLocalMovementBaseline(
            localActor,
            this.latestAuthoritative.localMovement,
            previousPredicted,
          )
          ?? actorTransformBaseline(localActor);
      this.lastReconciliationValue = this.prediction.reconcile(
        authoritativeMovement,
        normalized.acknowledgedInputId,
      );
    } else {
      this.lastReconciliationValue = null;
    }
    return Object.freeze({
      accepted: true,
      revision: normalized.revision,
      acknowledgedInputId: normalized.acknowledgedInputId,
      reconciliation: this.lastReconciliationValue,
    });
  }

  applyEvent(input: Event): ClientReplicaEventResult {
    const adapted = this.adapter?.event
      ? this.adapter.event(input)
      : input as unknown as AuthoritativeEventInput;
    const event = normalizeEvent(adapted, Math.max(this.latestRevisionValue, this.latestEventRevisionValue) + 1, this.now());
    if ((this.highestEventId !== null && event.eventId <= this.highestEventId)
      || event.revision < this.latestEventRevisionValue) {
      return Object.freeze({ accepted: false, eventId: event.eventId, revision: event.revision });
    }
    const supersededBySnapshot = event.revision < this.latestRevisionValue;
    if (!supersededBySnapshot) {
      this.eventLog.push(event);
      if (this.eventLog.length > 256) this.eventLog.shift();
    }
    const presentationId = intAlias(event.payload, ['predictionInputSequence'], -1);
    if (presentationId >= 0 && this.pendingPresentationPredictionIds.has(presentationId)) {
      this.pendingPresentationPredictionIds.delete(presentationId);
      this.acknowledgedPresentationPredictionIdsValue.add(presentationId);
      trimNumberSet(this.acknowledgedPresentationPredictionIdsValue);
    }
    this.highestEventId = Math.max(this.highestEventId ?? event.eventId, event.eventId);
    this.latestEventRevisionValue = Math.max(this.latestEventRevisionValue, event.revision);
    // Separate reliable DataChannels can be overtaken by a newer lossy
    // snapshot. Accept the event once for presentation/deduplication, but do
    // not let an older state edge regress the newer authoritative view.
    if (!supersededBySnapshot) {
      const base = this.latestAuthoritative ?? this.interpolation.sample(this.now());
      if (base) this.latestAuthoritative = applyEventToView(base, event);
    }
    return Object.freeze({ accepted: true, eventId: event.eventId, revision: event.revision });
  }

  /** Advance presentation correction and sample the view at local time. */
  update(now = this.now()): GameStateView | null {
    const elapsed = this.lastUpdateMs === null ? 1000 / 60 : Math.max(0, now - this.lastUpdateMs);
    this.lastUpdateMs = now;
    this.prediction?.advance(elapsed);
    return this.viewAt(now);
  }

  viewAt(now = this.now()): GameStateView | null {
    const sampled = this.interpolation.sample(now) ?? this.latestAuthoritative;
    if (!sampled) return null;
    const overlaid = this.latestAuthoritative ? applyDiscreteOverlay(sampled, this.latestAuthoritative) : sampled;
    const scopedLocalActorId = this.hasConfiguredLocalActorId ? this.configuredLocalActorId : this.localActorIdValue;
    const withEvents = overlaid.localActorId !== scopedLocalActorId
      ? freezeGameStateView({ ...overlaid, localActorId: scopedLocalActorId })
      : overlaid;
    if (!this.prediction || this.localActorIdValue === null) return freezeGameStateView(withEvents);
    const localIndex = withEvents.actors.findIndex((actor) => actor.id === this.localActorIdValue);
    if (localIndex < 0) return freezeGameStateView(withEvents);
    // Death is authoritative and discrete. Do not keep drawing a local
    // predicted transform over the dead actor while the next snapshot drains.
    if (!withEvents.actors[localIndex]!.alive) return freezeGameStateView(withEvents);
    const visual = this.prediction.visualState();
    const actor = withEvents.actors[localIndex]!;
    const moveState = MOVE_STATES.includes(visual.state as MoveState) ? visual.state as MoveState : actor.moveState;
    const updatedActor = Object.freeze({
      ...actor,
      position: freezePosition({ ...visual.position }),
      velocity: freezePosition({ ...(visual.velocity ?? actor.velocity) }),
      yaw: finite(visual.yaw, actor.yaw),
      pitch: finite(visual.pitch, actor.pitch),
      grounded: visual.grounded ?? actor.grounded,
      moveState,
    });
    const actors = [...withEvents.actors];
    actors[localIndex] = updatedActor;
    return freezeGameStateView({ ...withEvents, actors });
  }

  get view(): GameStateView | null {
    return this.viewAt(this.now());
  }

  telemetry(): PredictionTelemetry {
    return this.prediction?.telemetry() ?? Object.freeze({
      samples: 0, negligible: 0, soft: 0, hard: 0, acknowledgedInputs: 0,
      replayedInputs: 0, p50Error: 0, p95Error: 0, p99Error: 0, maxError: 0,
    });
  }

  /** Start a fresh measurement window without changing predicted state. */
  resetTelemetry(): void {
    this.prediction?.resetTelemetry();
  }

  reset(): void {
    this.interpolation.clear();
    this.latestAuthoritative = null;
    this.latestRevisionValue = -1;
    this.latestEventRevisionValue = -1;
    this.highestEventId = null;
    this.eventLog.length = 0;
    this.pendingPresentationPredictionIds.clear();
    this.acknowledgedPresentationPredictionIdsValue.clear();
    this.localActorIdValue = this.hasConfiguredLocalActorId ? this.configuredLocalActorId : null;
    this.prediction = null;
    this.lastReconciliationValue = null;
    this.lastUpdateMs = null;
    this.fallbackPredictionId = 1;
  }

  private maybeCreatePrediction(view: GameStateView, explicitState?: S): void {
    if (!this.movementStep || this.localActorIdValue === null || this.prediction) return;
    const actor = stateActor(view, this.localActorIdValue);
    if (!actor) return;
    const transformInitial = {
      position: { ...actor.position },
      velocity: { ...actor.velocity },
      yaw: actor.yaw,
      pitch: actor.pitch,
      grounded: actor.grounded,
      state: actor.moveState,
    };
    const projectedInitial = buildLocalMovementBaseline(actor, view.localMovement, transformInitial);
    const initial = explicitState ?? this.predictionOptions?.initialState ?? projectedInitial ?? transformInitial;
    this.prediction = new LocalMovementPrediction<S>({
      ...(this.predictionOptions ?? {}),
      initialState: initial,
      movementStep: this.movementStep,
      initialInputId: Math.max(
        this.fallbackPredictionId,
        this.predictionOptions?.initialInputId ?? 1,
      ),
    });
  }

  private acknowledgePresentationThrough(inputId: number): void {
    if (!Number.isSafeInteger(inputId) || inputId < 0) return;
    for (const pendingId of this.pendingPresentationPredictionIds) {
      if (pendingId > inputId) continue;
      this.pendingPresentationPredictionIds.delete(pendingId);
      this.acknowledgedPresentationPredictionIdsValue.add(pendingId);
    }
    trimNumberSet(this.acknowledgedPresentationPredictionIdsValue);
  }
}

function trimNumberSet(values: Set<number>): void {
  while (values.size > MAX_PRESENTATION_PREDICTION_IDS) {
    const first = values.values().next().value as number | undefined;
    if (first === undefined) return;
    values.delete(first);
  }
}
