import type { Difficulty } from '../core/balance';
import type { SkinId } from '../core/settings';
import type { MatchMode, RosterEntry } from '../sim/roster';
import type { MapDef } from '../world/types';
import type { MapId } from '../world';

export const MATCH_START_VERSION = 1;
export const MAX_MATCH_START_BYTES = 48 * 1024;
export const MATCH_START_READY_TIMEOUT_MS = 30_000;

export interface MatchStartPayload {
  readonly type: 'match-prepare';
  readonly version: typeof MATCH_START_VERSION;
  readonly protocolVersion: number;
  readonly protocolSession: string;
  readonly buildHash: string;
  readonly mapId: MapId;
  readonly mapHash: string;
  readonly seed: number;
  readonly mode: MatchMode;
  readonly difficulty: Difficulty;
  readonly roster: readonly RosterEntry[];
  readonly skins: readonly SkinId[];
  readonly startHostTick: number;
}

export interface ReadyToSimulate {
  readonly type: 'ready-to-simulate';
  readonly version: typeof MATCH_START_VERSION;
  readonly protocolSession: string;
  readonly mapHash: string;
  readonly participantId: string;
}

export interface StartCountdown {
  readonly type: 'start-countdown';
  readonly version: typeof MATCH_START_VERSION;
  readonly protocolSession: string;
  readonly startHostTick: number;
}

export type MatchStartControl = MatchStartPayload | ReadyToSimulate | StartCountdown;

export interface StartBarrierParticipant {
  readonly peerId: string;
  readonly participantId: string;
  readonly protocolSession: string;
}

export interface StartBarrierStatus {
  readonly hostReady: boolean;
  readonly readyParticipantIds: readonly string[];
  readonly waitingParticipantIds: readonly string[];
  readonly failedParticipantIds: readonly string[];
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly countdown: StartCountdown | null;
}

/** Host-owned READY_TO_SIMULATE barrier. It never silently removes a peer. */
export class HostMatchStartBarrier {
  private readonly participantsByPeer = new Map<string, StartBarrierParticipant>();
  private readonly ready = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly beganAtMs: number;
  private readonly timeoutMs: number;
  private readonly nowMs: () => number;
  private hostReady = false;
  private cancelled = false;
  private countdownValue: StartCountdown | null = null;

  constructor(
    readonly payload: MatchStartPayload,
    participants: readonly StartBarrierParticipant[],
    options: { readonly nowMs?: () => number; readonly timeoutMs?: number } = {},
  ) {
    this.payload = validateMatchStartPayload(payload);
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.timeoutMs = options.timeoutMs ?? MATCH_START_READY_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Invalid start barrier timeout');
    for (const participant of participants) {
      const peerId = identifier(participant.peerId, 'peerId');
      const participantId = identifier(participant.participantId, 'participantId');
      const protocolSession = identifier(participant.protocolSession, 'protocolSession');
      if (this.participantsByPeer.has(peerId)
        || [...this.participantsByPeer.values()].some((entry) => entry.participantId === participantId)) {
        throw new Error('Duplicate start barrier participant');
      }
      this.participantsByPeer.set(peerId, Object.freeze({ peerId, participantId, protocolSession }));
    }
    this.beganAtMs = this.nowMs();
  }

  markHostReady(): void {
    if (!this.cancelled) this.hostReady = true;
  }

  acceptReady(peerId: string, input: unknown): boolean {
    if (this.cancelled || this.countdownValue) return false;
    const participant = this.participantsByPeer.get(peerId);
    if (!participant || this.failed.has(participant.participantId)) return false;
    const ready = validateMatchStartControl(input);
    if (ready.type !== 'ready-to-simulate'
      || ready.protocolSession !== participant.protocolSession
      || ready.participantId !== participant.participantId
      || ready.mapHash !== this.payload.mapHash) return false;
    this.ready.add(participant.participantId);
    return true;
  }

  markLoadFailed(peerId: string, participantId: string): boolean {
    if (this.cancelled || this.countdownValue) return false;
    const participant = this.participantsByPeer.get(identifier(peerId, 'peerId'));
    const checkedParticipantId = identifier(participantId, 'participantId');
    if (!participant || participant.participantId !== checkedParticipantId) return false;
    this.ready.delete(checkedParticipantId);
    this.failed.add(checkedParticipantId);
    return true;
  }

  /** A READY peer that loses its direct channel remains in the final roster
   * and blocks start; it is never silently removed from the barrier. */
  markDisconnected(peerId: string): boolean {
    if (this.cancelled || this.countdownValue) return false;
    const participant = this.participantsByPeer.get(identifier(peerId, 'peerId'));
    if (!participant) return false;
    this.ready.delete(participant.participantId);
    this.failed.add(participant.participantId);
    return true;
  }

  tryStart(currentHostTick: number, countdownTicks = 180): StartCountdown | null {
    if (this.cancelled || this.countdownValue || !this.hostReady || this.failed.size > 0
      || this.ready.size !== this.participantsByPeer.size) return this.countdownValue;
    const tick = integer(currentHostTick, 0, 0xffffffff, 'currentHostTick');
    const delay = integer(countdownTicks, 1, 3600, 'countdownTicks');
    this.countdownValue = Object.freeze({
      type: 'start-countdown',
      version: MATCH_START_VERSION,
      protocolSession: this.payload.protocolSession,
      startHostTick: Math.min(0xffffffff, tick + delay),
    });
    return this.countdownValue;
  }

  cancel(): void {
    this.cancelled = true;
    this.countdownValue = null;
  }

  status(): StartBarrierStatus {
    const ready = [...this.ready].sort();
    const failed = [...this.failed].sort();
    const waiting = [...this.participantsByPeer.values()]
      .filter((participant) => !this.ready.has(participant.participantId)
        && !this.failed.has(participant.participantId))
      .map((participant) => participant.participantId)
      .sort();
    return Object.freeze({
      hostReady: this.hostReady,
      readyParticipantIds: Object.freeze(ready),
      waitingParticipantIds: Object.freeze(waiting),
      failedParticipantIds: Object.freeze(failed),
      timedOut: !this.cancelled && this.countdownValue === null && this.nowMs() - this.beganAtMs >= this.timeoutMs,
      cancelled: this.cancelled,
      countdown: this.countdownValue,
    });
  }
}

/** Guest-side load/validation gate. Loading failure never emits Ready. */
export class GuestMatchStartBarrier {
  private prepared: MatchStartPayload | null = null;
  private ready: ReadyToSimulate | null = null;
  private countdownValue: StartCountdown | null = null;

  constructor(
    private readonly participantId: string,
    private readonly protocolSession: string,
    private readonly validateAndLoad: (payload: MatchStartPayload) => Promise<void>,
  ) {
    identifier(participantId, 'participantId');
    identifier(protocolSession, 'protocolSession');
  }

  async prepare(
    input: unknown,
    expected: Parameters<typeof validateMatchStartPayload>[1],
  ): Promise<ReadyToSimulate> {
    const payload = validateMatchStartPayload(input, expected);
    await this.validateAndLoad(payload);
    this.prepared = payload;
    this.ready = Object.freeze({
      type: 'ready-to-simulate',
      version: MATCH_START_VERSION,
      protocolSession: this.protocolSession,
      mapHash: payload.mapHash,
      participantId: this.participantId,
    });
    return this.ready;
  }

  acceptCountdown(input: unknown): StartCountdown {
    if (!this.prepared || !this.ready) throw new Error('Match is not ready to simulate');
    const countdown = validateMatchStartControl(input);
    if (countdown.type !== 'start-countdown'
      || countdown.protocolSession !== this.prepared.protocolSession) {
      throw new Error('Invalid start countdown binding');
    }
    this.countdownValue = countdown;
    return countdown;
  }

  get countdown(): StartCountdown | null {
    return this.countdownValue;
  }
}

/**
 * Hash only map data that can affect authoritative gameplay. Presentation-only
 * sky, lights, vegetation and surface paths intentionally do not participate.
 */
export async function computeGameplayMapHash(map: MapDef): Promise<string> {
  const manifest = {
    id: map.id,
    size: map.size,
    heightfield: map.heightfield
      ? { n: map.heightfield.n, heights: Array.from(map.heightfield.heights) }
      : null,
    terrainCutouts: map.terrainCutouts ?? [],
    geo: map.geo.filter((entry) => entry.noCollide !== true),
    destructibles: map.destructibles,
    vehicles: map.vehicles,
    water: map.water,
    chests: map.chests,
    loot: map.loot,
    platforms: map.platforms,
    transportRoute: map.transportRoute,
  };
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeMatchStartControl(message: MatchStartControl): Uint8Array {
  const validated = validateMatchStartControl(message);
  const encoded = new TextEncoder().encode(canonicalJson(validated));
  if (encoded.byteLength > MAX_MATCH_START_BYTES) throw new Error('Match start control payload is too large');
  return encoded;
}

export function decodeMatchStartControl(data: ArrayBuffer | ArrayBufferView): MatchStartControl {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MATCH_START_BYTES) {
    throw new Error('Invalid match start control payload length');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Invalid match start control payload');
  }
  return validateMatchStartControl(parsed);
}

export function validateMatchStartPayload(
  value: unknown,
  expected?: {
    readonly protocolVersion?: number;
    readonly protocolSession?: string;
    readonly buildHash?: string;
    readonly mapHash?: string;
  },
): MatchStartPayload {
  const object = record(value, 'match start payload');
  exactKeys(object, [
    'type', 'version', 'protocolVersion', 'protocolSession', 'buildHash', 'mapId',
    'mapHash', 'seed', 'mode', 'difficulty', 'roster', 'skins', 'startHostTick',
  ]);
  if (object.type !== 'match-prepare' || object.version !== MATCH_START_VERSION) {
    throw new Error('Unsupported match start payload');
  }
  const protocolVersion = integer(object.protocolVersion, 1, 0xffff, 'protocolVersion');
  const protocolSession = identifier(object.protocolSession, 'protocolSession');
  const buildHash = identifier(object.buildHash, 'buildHash');
  const mapId = enumValue(object.mapId, ['neocity', 'oldfront', 'eden', 'ashara'] as const, 'mapId');
  const mapHash = hexHash(object.mapHash, 'mapHash');
  const seed = integer(object.seed, 0, 0xffffffff, 'seed');
  const mode = enumValue(object.mode, [
    'ffa-bot-fill', 'ffa', 'teams', 'teams-bot-fill', 'humans-vs-bots',
  ] as const, 'mode');
  const difficulty = enumValue(object.difficulty, ['normal', 'hard', 'elite', 'nightmare'] as const, 'difficulty');
  if (!Array.isArray(object.roster) || object.roster.length < 2 || object.roster.length > 10) {
    throw new Error('Invalid final roster');
  }
  const roster = Object.freeze(object.roster.map(validateRosterEntry));
  if (!Array.isArray(object.skins) || object.skins.length !== roster.length) throw new Error('Invalid start skins');
  const skins = Object.freeze(object.skins.map((skin) => enumValue(
    skin,
    ['vanguard', 'pathfinder', 'specter', 'striker', 'warden', 'nova'] as const,
    'skin',
  )));
  const startHostTick = integer(object.startHostTick, 0, 0xffffffff, 'startHostTick');
  if (new Set(roster.map((entry) => entry.actorId)).size !== roster.length
    || new Set(roster.map((entry) => entry.slotId)).size !== roster.length) {
    throw new Error('Duplicate final roster identity');
  }
  for (let index = 0; index < roster.length; index++) {
    if (roster[index]!.skinId !== skins[index]) throw new Error('Roster skin binding mismatch');
  }
  if (expected?.protocolVersion !== undefined && protocolVersion !== expected.protocolVersion) {
    throw new Error('Match protocol version mismatch');
  }
  if (expected?.protocolSession !== undefined && protocolSession !== expected.protocolSession) {
    throw new Error('Match protocol session mismatch');
  }
  if (expected?.buildHash !== undefined && buildHash !== expected.buildHash) {
    throw new Error('Match build mismatch');
  }
  if (expected?.mapHash !== undefined && mapHash !== expected.mapHash) {
    throw new Error('Match map hash mismatch');
  }
  return Object.freeze({
    type: 'match-prepare', version: MATCH_START_VERSION, protocolVersion,
    protocolSession, buildHash, mapId, mapHash, seed, mode, difficulty,
    roster, skins, startHostTick,
  });
}

export function validateMatchStartControl(value: unknown): MatchStartControl {
  const object = record(value, 'match start control');
  if (object.type === 'match-prepare') return validateMatchStartPayload(object);
  if (object.type === 'ready-to-simulate') {
    exactKeys(object, ['type', 'version', 'protocolSession', 'mapHash', 'participantId']);
    if (object.version !== MATCH_START_VERSION) throw new Error('Unsupported match ready payload');
    return Object.freeze({
      type: 'ready-to-simulate',
      version: MATCH_START_VERSION,
      protocolSession: identifier(object.protocolSession, 'protocolSession'),
      mapHash: hexHash(object.mapHash, 'mapHash'),
      participantId: identifier(object.participantId, 'participantId'),
    });
  }
  if (object.type === 'start-countdown') {
    exactKeys(object, ['type', 'version', 'protocolSession', 'startHostTick']);
    if (object.version !== MATCH_START_VERSION) throw new Error('Unsupported match countdown payload');
    return Object.freeze({
      type: 'start-countdown',
      version: MATCH_START_VERSION,
      protocolSession: identifier(object.protocolSession, 'protocolSession'),
      startHostTick: integer(object.startHostTick, 0, 0xffffffff, 'startHostTick'),
    });
  }
  throw new Error('Unknown match start control type');
}

function validateRosterEntry(value: unknown): RosterEntry {
  const object = record(value, 'roster entry');
  exactKeys(object, [
    'slotId', 'actorId', 'displayName', 'ownership', 'connectionState', 'teamId',
    'skinId', 'accentColor',
  ]);
  const ownershipObject = record(object.ownership, 'roster ownership');
  const ownershipKind = enumValue(ownershipObject.kind, ['local-human', 'remote-human', 'bot'] as const, 'ownership kind');
  if (ownershipKind === 'bot') exactKeys(ownershipObject, ['kind']);
  else exactKeys(ownershipObject, ['kind', 'peerId']);
  const ownership = ownershipKind === 'bot'
    ? { kind: 'bot' as const }
    : { kind: ownershipKind, peerId: identifier(ownershipObject.peerId, 'peerId') };
  const teamId = object.teamId === null ? null : integer(object.teamId, 0, 1, 'teamId');
  return Object.freeze({
    slotId: integer(object.slotId, 0, 9, 'slotId'),
    actorId: integer(object.actorId, 1, 0xffff, 'actorId'),
    displayName: displayName(object.displayName),
    ownership,
    connectionState: enumValue(object.connectionState, ['connected', 'disconnected', 'bot'] as const, 'connectionState'),
    teamId,
    skinId: enumValue(object.skinId, ['vanguard', 'pathfinder', 'specter', 'striker', 'warden', 'nova'] as const, 'skinId'),
    accentColor: integer(object.accentColor, 0, 0xffffff, 'accentColor'),
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Unsupported canonical value');
  return encoded;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function exactKeys(object: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('Unexpected match start fields');
  }
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`Invalid ${name}`);
  }
  return value as number;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function hexHash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function displayName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 24
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })) {
    throw new Error('Invalid displayName');
  }
  return value;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error(`Invalid ${name}`);
  return value as T;
}
