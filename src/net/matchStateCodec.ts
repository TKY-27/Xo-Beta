import type { Rarity, WeaponId } from '../core/balance';
import type { SkinId } from '../core/settings';
import type {
  ActorView,
  GameStateView,
  InventoryView,
  LocalMovementView,
  TeamResult,
  TeamView,
} from '../sim/gameStateView';
import { emptyCommand, type InputCommand } from '../sim/input';
import type { MoveState } from '../sim/actor';
import type { ConnectionState, TeamId } from '../sim/roster';
import type { AuthoritativeMatchEvent, EncodedSnapshot, SnapshotEncodeOptions } from './hostMatchSession';
import {
  INPUT_EDGE_MASK,
  INPUT_HELD_MASK,
  MATCH_HEADER_BYTES,
  MATCH_HEADER_OFFSETS,
  MATCH_PROTOCOL_VERSION,
  MAX_ENTITY_PAYLOAD_BYTES,
  MAX_SNAPSHOT_PAYLOAD_BYTES,
  SnapshotReassembler,
  decodeInputPacket,
  decodeSnapshotChunk,
  encodeInputPacket,
  encodeSnapshotChunk,
  mapClientShotTickToHost,
  splitSnapshot,
  type InputFrame,
  type InputFrameInput,
  type RecentInputFrameInput,
  type ReassembledSnapshot,
  type SnapshotEntityInput,
} from './matchProtocol';
import type { RemoteInputEnvelope, RemoteInputFrame } from './remoteInput';

export const MATCH_STATE_CODEC_VERSION = 1;
export const MAX_RELIABLE_PAYLOAD_BYTES = 48 * 1024;
export const MAX_STATE_ACTORS = 10;
export const MAX_STATE_CHESTS = 128;
export const MAX_STATE_LOOT = 256;
export const MAX_STATE_DESTRUCTIBLES = 1024;

const STATE_PACKET_BYTES = MATCH_HEADER_BYTES + MAX_SNAPSHOT_PAYLOAD_BYTES;
const ACTOR_BUCKETS = 10;
const TEAM_BUCKETS = 1;
const CHEST_BUCKETS = 4;
const LOOT_BUCKETS = 16;
const DESTRUCTIBLE_BUCKETS = 32;
const DESTRUCTIBLES_PER_PAGE = MAX_STATE_DESTRUCTIBLES / DESTRUCTIBLE_BUCKETS;
const EXPECTED_FULL_RECORDS = 1 + ACTOR_BUCKETS + TEAM_BUCKETS + CHEST_BUCKETS
  + LOOT_BUCKETS + DESTRUCTIBLE_BUCKETS;

const RECORD_ID = Object.freeze({
  meta: 1,
  actor: 0x0100,
  team: 0x0200,
  chest: 0x1000,
  loot: 0x2000,
  destructible: 0x3000,
} as const);

const RECORD_MASK = Object.freeze({
  meta: 1 << 0,
  actor: 1 << 1,
  team: 1 << 2,
  chest: 1 << 3,
  loot: 1 << 4,
  destructible: 1 << 5,
} as const);

const SECTION = Object.freeze({
  meta: 1,
  actor: 2,
  team: 3,
  chest: 4,
  loot: 5,
  destructible: 6,
} as const);

const PHASES = ['transport', 'drop', 'live', 'results'] as const;
const MODES = ['solo', 'ffa-bot-fill', 'ffa', 'teams', 'teams-bot-fill', 'humans-vs-bots'] as const;
const STORM_STATES = ['idle', 'waiting', 'shrinking', 'done'] as const;
const MOVE_STATES = [
  'ground', 'air', 'slide', 'wallrun', 'mantle', 'grapple',
  'poundWindup', 'poundFall', 'swim', 'freefall', 'glide',
] as const satisfies readonly MoveState[];
const SKINS = ['vanguard', 'pathfinder', 'specter', 'striker', 'warden', 'nova'] as const satisfies readonly SkinId[];
const WEAPONS = ['pistol', 'shotgun', 'ar', 'smg', 'sniper'] as const satisfies readonly WeaponId[];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const satisfies readonly Rarity[];
const CONNECTIONS = ['connected', 'disconnected', 'bot'] as const satisfies readonly ConnectionState[];
const LOOT_KINDS = ['weapon', 'ammo', 'heal'] as const;
const AMMO_TYPES = ['light', 'medium', 'shells', 'heavy'] as const;
const CHEST_KINDS = ['standard', 'elite', 'vault'] as const;
const AUTHORITATIVE_EVENT_TYPES = new Set<AuthoritativeMatchEvent['type']>([
  'shotFired', 'impact', 'glassBreak', 'destructibleDestroyed', 'actorHit',
  'shieldHit', 'shieldBroken', 'eliminated', 'itemPickedUp', 'chestOpened',
  'reloadStarted', 'healStarted', 'healCancelled', 'healDone', 'stormWaiting',
  'stormShrinking', 'stormFinal', 'phaseChanged', 'matchWon', 'playerLeave',
  'playerRejoin', 'tacticalPing',
]);

export type ReliablePacketKind =
  | 'match-prepare'
  | 'ready-to-simulate'
  | 'load-failed'
  | 'start-countdown'
  | 'authoritative-event'
  | 'tactical-ping-request'
  | 'keyframe-request'
  | 'reconnect-request'
  | 'reconnect-result'
  | 'host-visibility'
  | 'host-disconnected';

const RELIABLE_KIND_CODES: Readonly<Record<ReliablePacketKind, number>> = Object.freeze({
  'match-prepare': 16,
  'ready-to-simulate': 17,
  'load-failed': 25,
  'start-countdown': 18,
  'authoritative-event': 19,
  'tactical-ping-request': 20,
  'keyframe-request': 21,
  'reconnect-request': 22,
  'reconnect-result': 23,
  'host-visibility': 26,
  'host-disconnected': 24,
});

const RELIABLE_CODE_KINDS = new Map<number, ReliablePacketKind>(
  Object.entries(RELIABLE_KIND_CODES).map(([kind, code]) => [code, kind as ReliablePacketKind]),
);

export type CanonicalBinaryValue = null | boolean | number | string
  | readonly CanonicalBinaryValue[] | { readonly [key: string]: CanonicalBinaryValue };

export interface ReliablePacketInput {
  readonly kind: ReliablePacketKind;
  readonly sessionId: number;
  readonly sequence: number;
  readonly tick: number;
  readonly payload: CanonicalBinaryValue;
}

export interface ReliablePacket extends ReliablePacketInput {
  readonly protocolVersion: number;
  readonly payloadLength: number;
}

export interface InputFrameMetadata {
  readonly sessionId: number;
  readonly inputSeq: number;
  readonly clientTick: number;
  readonly lastAckHostTick: number;
  readonly shotTick?: number | null;
  readonly recentFrames?: readonly ProtocolCommandFrame[];
}

export interface ProtocolCommandFrame {
  readonly inputSeq: number;
  readonly clientTick: number;
  readonly shotTick?: number | null;
  readonly command: Readonly<InputCommand>;
}

export interface DecodedStateSnapshot {
  readonly state: GameStateView;
  readonly revision: number;
  readonly hostTick: number;
  readonly acknowledgedInputSequence: number;
  readonly full: boolean;
}

export type MatchStateCodecErrorCode =
  | 'invalid-state'
  | 'invalid-packet'
  | 'invalid-length'
  | 'payload-too-large'
  | 'session-mismatch'
  | 'keyframe-required'
  | 'obsolete-snapshot';

export class MatchStateCodecError extends Error {
  constructor(readonly code: MatchStateCodecErrorCode, message: string) {
    super(message);
    this.name = 'MatchStateCodecError';
  }
}

class BinaryWriter {
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(private readonly limit: number) {
    this.buffer = new ArrayBuffer(limit);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  u8(value: number): void { this.ensure(1); this.view.setUint8(this.offset, unsigned(value, 0xff, 'u8')); this.offset += 1; }
  i8(value: number): void { this.ensure(1); this.view.setInt8(this.offset, signed(value, -0x80, 0x7f, 'i8')); this.offset += 1; }
  u16(value: number): void { this.ensure(2); this.view.setUint16(this.offset, unsigned(value, 0xffff, 'u16'), true); this.offset += 2; }
  i16(value: number): void { this.ensure(2); this.view.setInt16(this.offset, signed(value, -0x8000, 0x7fff, 'i16'), true); this.offset += 2; }
  u32(value: number): void { this.ensure(4); this.view.setUint32(this.offset, unsigned(value, 0xffff_ffff, 'u32'), true); this.offset += 4; }
  f32(value: number): void { this.ensure(4); this.view.setFloat32(this.offset, finite(value, 'f32'), true); this.offset += 4; }
  f64(value: number): void { this.ensure(8); this.view.setFloat64(this.offset, finite(value, 'f64'), true); this.offset += 8; }

  raw(value: Uint8Array): void {
    this.ensure(value.byteLength);
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }

  string8(value: string, maxBytes = 255): void {
    const encoded = encodeText(value, maxBytes);
    this.u8(encoded.byteLength);
    this.raw(encoded);
  }

  string16(value: string, maxBytes = 0xffff): void {
    const encoded = encodeText(value, maxBytes);
    this.u16(encoded.byteLength);
    this.raw(encoded);
  }

  finish(): Uint8Array { return this.bytes.slice(0, this.offset); }
  get length(): number { return this.offset; }

  private ensure(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.offset + bytes > this.limit) {
      throw new MatchStateCodecError('payload-too-large', `Binary payload exceeds ${this.limit} bytes`);
    }
  }
}

class BinaryReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number { this.ensure(1); const value = this.view.getUint8(this.offset); this.offset += 1; return value; }
  i8(): number { this.ensure(1); const value = this.view.getInt8(this.offset); this.offset += 1; return value; }
  u16(): number { this.ensure(2); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  i16(): number { this.ensure(2); const value = this.view.getInt16(this.offset, true); this.offset += 2; return value; }
  u32(): number { this.ensure(4); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
  f32(): number { this.ensure(4); const value = this.view.getFloat32(this.offset, true); this.offset += 4; return finite(value, 'decoded f32'); }
  f64(): number { this.ensure(8); const value = this.view.getFloat64(this.offset, true); this.offset += 8; return finite(value, 'decoded f64'); }

  raw(length: number): Uint8Array {
    this.ensure(length);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string8(maxBytes = 255): string { const length = this.u8(); return this.text(length, maxBytes); }
  string16(maxBytes = 0xffff): string { const length = this.u16(); return this.text(length, maxBytes); }

  done(): boolean { return this.offset === this.bytes.byteLength; }
  assertDone(label: string): void {
    if (!this.done()) throw new MatchStateCodecError('invalid-length', `${label} contains trailing bytes`);
  }

  private text(length: number, maxBytes: number): string {
    if (length > maxBytes) throw new MatchStateCodecError('invalid-length', 'Encoded string exceeds its bound');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.raw(length));
    } catch {
      throw new MatchStateCodecError('invalid-packet', 'Encoded string is not valid UTF-8');
    }
  }

  private ensure(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new MatchStateCodecError('invalid-length', 'Binary payload is truncated');
    }
  }
}

/** Convert the complete tick command into the protocol's held/edge masks. */
export function inputCommandToProtocolFrame(
  command: Readonly<InputCommand>,
  metadata: InputFrameMetadata,
): InputFrameInput {
  validateCommand(command);
  const recentFrames: RecentInputFrameInput[] = (metadata.recentFrames ?? []).map((frame) => {
    validateCommand(frame.command);
    return commandFrame(frame.command, frame.inputSeq, frame.clientTick, frame.shotTick);
  });
  return Object.freeze({
    sessionId: metadata.sessionId,
    inputSeq: metadata.inputSeq,
    clientTick: metadata.clientTick,
    lastAckHostTick: metadata.lastAckHostTick,
    ...commandFrame(command, metadata.inputSeq, metadata.clientTick, metadata.shotTick),
    recentFrames: Object.freeze(recentFrames),
  });
}

/** Decode protocol masks without allowing unknown bits to become simulation intent. */
export function protocolFrameToInputCommand(frame: Pick<InputFrame,
  'moveX' | 'moveZ' | 'yaw' | 'pitch' | 'heldMask' | 'edgeMask' | 'selectedSlot'>): InputCommand {
  const command = emptyCommand();
  command.moveX = frame.moveX;
  command.moveZ = frame.moveZ;
  command.yaw = frame.yaw;
  command.pitch = frame.pitch;
  command.jumpHeld = (frame.heldMask & INPUT_HELD_MASK.jump) !== 0;
  command.sprint = (frame.heldMask & INPUT_HELD_MASK.sprint) !== 0;
  command.crouchHeld = (frame.heldMask & INPUT_HELD_MASK.crouch) !== 0;
  command.fireHeld = (frame.heldMask & INPUT_HELD_MASK.fire) !== 0;
  command.adsHeld = (frame.heldMask & INPUT_HELD_MASK.ads) !== 0;
  command.jumpPressed = (frame.edgeMask & INPUT_EDGE_MASK.jump) !== 0;
  command.crouchPressed = (frame.edgeMask & INPUT_EDGE_MASK.crouch) !== 0;
  command.firePressed = (frame.edgeMask & INPUT_EDGE_MASK.fire) !== 0;
  command.reloadPressed = (frame.edgeMask & INPUT_EDGE_MASK.reload) !== 0;
  command.interactPressed = (frame.edgeMask & INPUT_EDGE_MASK.interact) !== 0;
  command.meleePressed = (frame.edgeMask & INPUT_EDGE_MASK.melee) !== 0;
  command.dropWeaponPressed = (frame.edgeMask & INPUT_EDGE_MASK.dropWeapon) !== 0;
  command.dashPressed = (frame.edgeMask & INPUT_EDGE_MASK.dash) !== 0;
  command.grapplePressed = (frame.edgeMask & INPUT_EDGE_MASK.grapple) !== 0;
  command.grappleRelease = (frame.edgeMask & INPUT_EDGE_MASK.grappleRelease) !== 0;
  command.poundPressed = (frame.edgeMask & INPUT_EDGE_MASK.pound) !== 0;
  command.shieldPressed = (frame.edgeMask & INPUT_EDGE_MASK.shield) !== 0;
  command.medkitPressed = (frame.edgeMask & INPUT_EDGE_MASK.medkit) !== 0;
  command.slotRequest = frame.selectedSlot;
  return command;
}

export function decodeRemoteInputEnvelope(
  data: ArrayBuffer | ArrayBufferView,
  receivedHostTick: number,
): RemoteInputEnvelope {
  return protocolInputToRemoteEnvelope(decodeInputPacket(data), receivedHostTick);
}

export function protocolInputToRemoteEnvelope(
  packet: InputFrame,
  receivedHostTick: number,
  maxShotRewindTicks = 15,
): RemoteInputEnvelope {
  const frames: RemoteInputFrame[] = [packet, ...packet.recentFrames].map((frame) => Object.freeze({
    sequence: frame.inputSeq,
    clientTick: frame.clientTick,
    lastAcknowledgedHostTick: packet.lastAckHostTick,
    shotTick: frame.shotTick === null
      ? receivedHostTick
      : mapClientShotTickToHost(
        receivedHostTick,
        packet.lastAckHostTick,
        packet.clientTick,
        frame.shotTick,
        maxShotRewindTicks,
      ),
    command: Object.freeze(protocolFrameToInputCommand(frame)),
  }));
  return Object.freeze({ receivedHostTick, frames: Object.freeze(frames) });
}

export function encodeInputCommandPacket(command: Readonly<InputCommand>, metadata: InputFrameMetadata): ArrayBuffer {
  return encodeInputPacket(inputCommandToProtocolFrame(command, metadata));
}

/**
 * Projection is deliberately one-way: private inventory can be removed, but
 * never synthesized. Match/host-session must provide the owning actor's real
 * inventory before calling this function.
 */
export function projectGameStateForViewer(view: GameStateView, localActorId: number | null): GameStateView {
  if (localActorId !== null && (!Number.isSafeInteger(localActorId) || localActorId <= 0 || localActorId > 0xffff)) {
    throw new MatchStateCodecError('invalid-state', 'Invalid local actor ID');
  }
  const actors = view.actors.map((actor) => Object.freeze({
    ...actor,
    inventory: actor.id === localActorId ? actor.inventory : null,
  }));
  const localMovement = localActorId !== null && view.localMovement?.actorId === localActorId
    ? view.localMovement
    : null;
  return Object.freeze({
    ...view,
    localActorId,
    localMovement,
    actors: Object.freeze(actors),
  });
}

/** Stable section/bucket records keep a 642-object NeoCity keyframe below 64 wire records. */
export function encodeGameStateRecords(
  view: GameStateView,
  localActorId = view.localActorId,
  destructibleOrder: readonly string[] = [],
): readonly SnapshotEntityInput[] {
  const projected = projectGameStateForViewer(view, localActorId);
  validateStateBounds(projected);
  const records: SnapshotEntityInput[] = [{
    id: RECORD_ID.meta,
    mask: RECORD_MASK.meta,
    payload: encodeMeta(projected),
  }];
  records.push(...encodeBuckets(projected.actors, ACTOR_BUCKETS, RECORD_ID.actor, RECORD_MASK.actor,
    (actor) => numericBucket(actor.id, ACTOR_BUCKETS), writeActorBucket));
  records.push(...encodeBuckets(projected.teams, TEAM_BUCKETS, RECORD_ID.team, RECORD_MASK.team,
    () => 0, writeTeamBucket));
  records.push(...encodeBuckets(projected.chests, CHEST_BUCKETS, RECORD_ID.chest, RECORD_MASK.chest,
    (chest) => numericBucket(chest.id, CHEST_BUCKETS), writeChestBucket));
  records.push(...encodeBuckets(projected.loot, LOOT_BUCKETS, RECORD_ID.loot, RECORD_MASK.loot,
    (loot) => numericBucket(loot.id, LOOT_BUCKETS), writeLootBucket));
  records.push(...encodeDestructibleRecords(projected.destructibles, destructibleOrder));
  if (records.length !== EXPECTED_FULL_RECORDS) {
    throw new MatchStateCodecError('invalid-state', 'Unexpected state record count');
  }
  return Object.freeze(records.map((record) => Object.freeze(record)));
}

export class MatchStateEncoder {
  private keyframeRecords: Map<number, SnapshotEntityInput> | null = null;
  private wireSequence = 1;

  constructor(
    readonly sessionId: number,
    readonly localActorId: number | null,
    private readonly destructibleOrder: readonly string[] = [],
  ) {
    unsigned(sessionId, 0xffff_ffff, 'sessionId');
    validateDestructibleOrder(destructibleOrder);
  }

  encode(view: GameStateView, options: SnapshotEncodeOptions): EncodedSnapshot {
    if (this.localActorId !== null && options.viewerActorId !== this.localActorId) {
      throw new MatchStateCodecError('invalid-state', 'Snapshot encoder viewer binding changed');
    }
    const all = encodeGameStateRecords(view, this.localActorId, this.destructibleOrder);
    const current = new Map(all.map((record) => [record.id, record]));
    const full = options.full || this.keyframeRecords === null;
    let entities: readonly SnapshotEntityInput[];
    if (full) {
      entities = all;
      this.keyframeRecords = cloneRecordMap(current);
    } else {
      const base = this.keyframeRecords!;
      entities = all.filter((record) => !bytesEqual(record.payload, base.get(record.id)?.payload));
    }
    const ackInputSeq = this.localActorId === null ? 0 : options.acknowledgedInputSequence;
    const input = {
      sessionId: this.sessionId,
      sequence: this.wireSequence,
      snapshotId: options.sequence,
      hostTick: view.hostTick,
      ackInputSeq,
      revision: view.stateRevision,
      full,
      delta: !full,
      entities,
    } as const;
    const chunks = splitSnapshot(input, STATE_PACKET_BYTES);
    if (this.wireSequence + chunks.length > 0xffff_ffff) {
      throw new MatchStateCodecError('invalid-state', 'Snapshot sequence exhausted');
    }
    const packets = chunks.map((chunk) => encodeSnapshotChunk(chunk));
    this.wireSequence += chunks.length;
    return Object.freeze({
      packets: Object.freeze(packets),
      totalBytes: packets.reduce((sum, packet) => sum + packet.byteLength, 0),
    });
  }

  reset(): void {
    this.keyframeRecords = null;
    this.wireSequence = 1;
  }
}

export class MatchStateDecoder {
  private readonly reassembler = new SnapshotReassembler();
  private keyframeRecords: Map<number, SnapshotEntityInput> | null = null;
  private latestRevision = -1;

  private destructibleOrder: readonly string[];

  constructor(readonly expectedSessionId: number, destructibleOrder: readonly string[] = []) {
    unsigned(expectedSessionId, 0xffff_ffff, 'expectedSessionId');
    validateDestructibleOrder(destructibleOrder);
    this.destructibleOrder = Object.freeze([...destructibleOrder]);
  }

  add(data: ArrayBuffer | ArrayBufferView): DecodedStateSnapshot | null {
    // Bind the session before SnapshotReassembler allocates a pending
    // multi-chunk entry. A wrong-session flood must not consume the bounded
    // reassembly table even temporarily.
    const chunk = decodeSnapshotChunk(data);
    if (chunk.sessionId !== this.expectedSessionId) {
      throw new MatchStateCodecError('session-mismatch', 'Snapshot session binding mismatch');
    }
    const snapshot = this.reassembler.add(chunk);
    if (!snapshot) return null;
    if (snapshot.revision <= this.latestRevision) return null;
    let records: Map<number, SnapshotEntityInput>;
    if (snapshot.full) {
      records = snapshotRecordMap(snapshot);
      assertFullRecordSet(records);
      this.keyframeRecords = cloneRecordMap(records);
    } else {
      if (!this.keyframeRecords) {
        throw new MatchStateCodecError('keyframe-required', 'Delta snapshot arrived before a full keyframe');
      }
      records = cloneRecordMap(this.keyframeRecords);
      for (const entity of snapshot.entities) records.set(entity.id, entity);
    }
    const state = decodeGameStateRecords(records, snapshot, this.destructibleOrder);
    this.latestRevision = snapshot.revision;
    return Object.freeze({
      state,
      revision: snapshot.revision,
      hostTick: snapshot.hostTick,
      acknowledgedInputSequence: snapshot.ackInputSeq,
      full: snapshot.full,
    });
  }

  reset(): void {
    this.reassembler.clear();
    this.keyframeRecords = null;
    this.latestRevision = -1;
  }

  get hasKeyframe(): boolean { return this.keyframeRecords !== null; }

  configureDestructibles(order: readonly string[]): void {
    if (this.keyframeRecords) throw new MatchStateCodecError('invalid-state', 'Cannot replace a live destructible dictionary');
    validateDestructibleOrder(order);
    this.destructibleOrder = Object.freeze([...order]);
  }
}

export function encodeReliablePacket(input: ReliablePacketInput): ArrayBuffer {
  const payload = encodeCanonicalBinary(input.payload);
  if (payload.byteLength > MAX_RELIABLE_PAYLOAD_BYTES) {
    throw new MatchStateCodecError('payload-too-large', 'Reliable payload is too large');
  }
  const output = new ArrayBuffer(MATCH_HEADER_BYTES + payload.byteLength);
  const view = new DataView(output);
  view.setUint8(MATCH_HEADER_OFFSETS.version, MATCH_PROTOCOL_VERSION);
  view.setUint8(MATCH_HEADER_OFFSETS.type, RELIABLE_KIND_CODES[input.kind]);
  view.setUint16(MATCH_HEADER_OFFSETS.flags, 0, true);
  view.setUint32(MATCH_HEADER_OFFSETS.session, unsigned(input.sessionId, 0xffff_ffff, 'sessionId'), true);
  view.setUint32(MATCH_HEADER_OFFSETS.sequence, unsigned(input.sequence, 0xffff_ffff, 'sequence'), true);
  view.setUint32(MATCH_HEADER_OFFSETS.tick, unsigned(input.tick, 0xffff_ffff, 'tick'), true);
  view.setUint16(MATCH_HEADER_OFFSETS.payloadLength, payload.byteLength, true);
  view.setUint16(MATCH_HEADER_OFFSETS.reserved, 0, true);
  view.setUint32(MATCH_HEADER_OFFSETS.reserved + 2, 0, true);
  new Uint8Array(output, MATCH_HEADER_BYTES).set(payload);
  return output;
}

export function decodeReliablePacket(
  data: ArrayBuffer | ArrayBufferView,
  expectedSessionId?: number,
): ReliablePacket {
  const bytes = binaryBytes(data);
  if (bytes.byteLength < MATCH_HEADER_BYTES || bytes.byteLength > MATCH_HEADER_BYTES + MAX_RELIABLE_PAYLOAD_BYTES) {
    throw new MatchStateCodecError('invalid-length', 'Reliable packet length is outside its bound');
  }
  const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(MATCH_HEADER_OFFSETS.version) !== MATCH_PROTOCOL_VERSION) {
    throw new MatchStateCodecError('invalid-packet', 'Unsupported reliable protocol version');
  }
  const kind = RELIABLE_CODE_KINDS.get(view.getUint8(MATCH_HEADER_OFFSETS.type));
  if (!kind || view.getUint16(MATCH_HEADER_OFFSETS.flags, true) !== 0
    || view.getUint16(MATCH_HEADER_OFFSETS.reserved, true) !== 0
    || view.getUint32(MATCH_HEADER_OFFSETS.reserved + 2, true) !== 0) {
    throw new MatchStateCodecError('invalid-packet', 'Invalid reliable packet header');
  }
  const sessionId = view.getUint32(MATCH_HEADER_OFFSETS.session, true);
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    throw new MatchStateCodecError('session-mismatch', 'Reliable packet session binding mismatch');
  }
  const payloadLength = view.getUint16(MATCH_HEADER_OFFSETS.payloadLength, true);
  if (MATCH_HEADER_BYTES + payloadLength !== bytes.byteLength) {
    throw new MatchStateCodecError('invalid-length', 'Reliable payload length does not match the packet');
  }
  return Object.freeze({
    kind,
    sessionId,
    sequence: view.getUint32(MATCH_HEADER_OFFSETS.sequence, true),
    tick: view.getUint32(MATCH_HEADER_OFFSETS.tick, true),
    payload: decodeCanonicalBinary(bytes.slice(MATCH_HEADER_BYTES)),
    protocolVersion: MATCH_PROTOCOL_VERSION,
    payloadLength,
  });
}

export function encodeAuthoritativeEventPacket(
  event: AuthoritativeMatchEvent,
  sessionId: number,
  sequence = event.eventId,
): ArrayBuffer {
  return encodeReliablePacket({
    kind: 'authoritative-event',
    sessionId,
    sequence,
    tick: event.hostTick,
    payload: canonicalEvent(event),
  });
}

export function decodeAuthoritativeEventPacket(
  data: ArrayBuffer | ArrayBufferView,
  expectedSessionId?: number,
): AuthoritativeMatchEvent {
  const packet = decodeReliablePacket(data, expectedSessionId);
  if (packet.kind !== 'authoritative-event') {
    throw new MatchStateCodecError('invalid-packet', 'Reliable packet is not an authoritative event');
  }
  const value = objectValue(packet.payload, 'event');
  const eventId = uint32Value(value.eventId, 'eventId');
  const revision = uint32Value(value.revision, 'revision');
  const hostTick = uint32Value(value.hostTick, 'hostTick');
  const type = stringValue(value.type, 'event type', 64) as AuthoritativeMatchEvent['type'];
  if (!AUTHORITATIVE_EVENT_TYPES.has(type)) {
    throw new MatchStateCodecError('invalid-packet', 'Unknown authoritative event type');
  }
  const payload = objectValue(value.payload, 'event payload');
  if (hostTick !== packet.tick || eventId !== packet.sequence) {
    throw new MatchStateCodecError('invalid-packet', 'Event envelope does not match its payload');
  }
  return Object.freeze({ eventId, revision, hostTick, type, payload: Object.freeze({ ...payload }) });
}

/** Ordered reliable events still need replay protection across reconnects. */
export class ReliableEventDeduplicator {
  private highestEventId = 0;
  private highestRevision = 0;

  accept(event: Pick<AuthoritativeMatchEvent, 'eventId' | 'revision'>): boolean {
    const eventId = unsigned(event.eventId, 0xffff_ffff, 'eventId');
    const revision = unsigned(event.revision, 0xffff_ffff, 'revision');
    if (eventId === 0 || eventId <= this.highestEventId || revision < this.highestRevision) return false;
    this.highestEventId = eventId;
    this.highestRevision = revision;
    return true;
  }

  reset(): void { this.highestEventId = 0; this.highestRevision = 0; }
}

export function sessionBindingId(binding: string): number {
  if (typeof binding !== 'string' || binding.length < 6 || binding.length > 256) {
    throw new MatchStateCodecError('invalid-state', 'Invalid session binding');
  }
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(binding)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Validate and normalize an application object before reliable binary encoding. */
export function canonicalBinaryValue(value: unknown): CanonicalBinaryValue {
  return toCanonicalValue(value);
}

function commandFrame(
  command: Readonly<InputCommand>,
  inputSeq: number,
  clientTick: number,
  shotTick: number | null | undefined,
): RecentInputFrameInput & { readonly lastAckHostTick?: never } {
  let heldMask = 0;
  if (command.jumpHeld) heldMask |= INPUT_HELD_MASK.jump;
  if (command.sprint) heldMask |= INPUT_HELD_MASK.sprint;
  if (command.crouchHeld) heldMask |= INPUT_HELD_MASK.crouch;
  if (command.fireHeld) heldMask |= INPUT_HELD_MASK.fire;
  if (command.adsHeld) heldMask |= INPUT_HELD_MASK.ads;
  let edgeMask = 0;
  if (command.jumpPressed) edgeMask |= INPUT_EDGE_MASK.jump;
  if (command.crouchPressed) edgeMask |= INPUT_EDGE_MASK.crouch;
  if (command.firePressed) edgeMask |= INPUT_EDGE_MASK.fire;
  if (command.reloadPressed) edgeMask |= INPUT_EDGE_MASK.reload;
  if (command.interactPressed) edgeMask |= INPUT_EDGE_MASK.interact;
  if (command.meleePressed) edgeMask |= INPUT_EDGE_MASK.melee;
  if (command.dropWeaponPressed) edgeMask |= INPUT_EDGE_MASK.dropWeapon;
  if (command.dashPressed) edgeMask |= INPUT_EDGE_MASK.dash;
  if (command.grapplePressed) edgeMask |= INPUT_EDGE_MASK.grapple;
  if (command.grappleRelease) edgeMask |= INPUT_EDGE_MASK.grappleRelease;
  if (command.poundPressed) edgeMask |= INPUT_EDGE_MASK.pound;
  if (command.shieldPressed) edgeMask |= INPUT_EDGE_MASK.shield;
  if (command.medkitPressed) edgeMask |= INPUT_EDGE_MASK.medkit;
  return Object.freeze({
    inputSeq,
    clientTick,
    moveX: command.moveX,
    moveZ: command.moveZ,
    yaw: normalizeYaw(command.yaw),
    pitch: command.pitch,
    heldMask,
    edgeMask,
    selectedSlot: command.slotRequest,
    shotTick: shotTick ?? ((command.fireHeld || command.firePressed) ? clientTick : null),
  });
}

function validateCommand(command: Readonly<InputCommand>): void {
  if (!command || !Number.isFinite(command.moveX) || !Number.isFinite(command.moveZ)
    || Math.abs(command.moveX) > 1 || Math.abs(command.moveZ) > 1
    || Math.hypot(command.moveX, command.moveZ) > 1.001
    || !Number.isFinite(command.yaw) || !Number.isFinite(command.pitch)
    || command.pitch < -Math.PI / 2 + 0.02 || command.pitch > Math.PI / 2 - 0.02
    || command.slotRequest !== null && (!Number.isSafeInteger(command.slotRequest)
      || command.slotRequest < -1 || command.slotRequest > 4)) {
    throw new MatchStateCodecError('invalid-state', 'Input command is outside protocol bounds');
  }
  for (const key of [
    'jumpPressed', 'jumpHeld', 'sprint', 'crouchHeld', 'crouchPressed', 'fireHeld',
    'firePressed', 'adsHeld', 'reloadPressed', 'interactPressed', 'meleePressed',
    'dropWeaponPressed', 'dashPressed', 'grapplePressed', 'grappleRelease',
    'poundPressed', 'shieldPressed', 'medkitPressed',
  ] as const) {
    if (typeof command[key] !== 'boolean') throw new MatchStateCodecError('invalid-state', 'Input command flag is not boolean');
  }
}

function normalizeYaw(yaw: number): number {
  const wrapped = ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return wrapped === -Math.PI && yaw > 0 ? Math.PI : wrapped;
}

function encodeMeta(view: GameStateView): Uint8Array {
  const writer = sectionWriter(SECTION.meta);
  writer.u32(view.hostTick);
  writer.u32(view.stateRevision);
  writer.f32(view.time);
  writer.f32(view.phaseTime);
  writer.u8(enumIndex(PHASES, view.phase, 'phase'));
  writer.u8(enumIndex(MODES, view.mode, 'mode'));
  writer.u16(view.localActorId ?? 0);
  writer.u8(enumIndex(STORM_STATES, view.storm.state, 'storm state'));
  writer.i16(view.storm.phaseIndex);
  writer.f32(view.storm.timer);
  writer.f32(view.storm.centerX);
  writer.f32(view.storm.centerZ);
  writer.f32(view.storm.radius);
  writer.f32(view.transport.x);
  writer.f32(view.transport.y);
  writer.f32(view.transport.z);
  writer.u8(view.transport.jumpAllowed ? 1 : 0);
  writeLocalMovement(writer, view.localMovement, view.localActorId);
  if (!view.winner) writer.u8(0);
  else if (view.winner.kind === 'actor') { writer.u8(1); writer.u16(view.winner.actorId); }
  else { writer.u8(2); writer.i16(view.winner.teamId); }
  writer.u8(view.teamResults.length);
  for (const result of [...view.teamResults].sort((a, b) => a.teamId - b.teamId)) writeTeamResult(writer, result);
  return writer.finish();
}

function decodeMeta(payload: Uint8Array): Omit<GameStateView,
  'actors' | 'teams' | 'chests' | 'loot' | 'destructibles'> {
  const reader = sectionReader(payload, SECTION.meta);
  const hostTick = reader.u32();
  const stateRevision = reader.u32();
  const time = reader.f32();
  const phaseTime = reader.f32();
  const phase = enumAt(PHASES, reader.u8(), 'phase');
  const mode = enumAt(MODES, reader.u8(), 'mode');
  const local = reader.u16();
  const storm = Object.freeze({
    state: enumAt(STORM_STATES, reader.u8(), 'storm state'),
    phaseIndex: reader.i16(),
    timer: reader.f32(),
    centerX: reader.f32(),
    centerZ: reader.f32(),
    radius: reader.f32(),
  });
  const transport = Object.freeze({
    x: reader.f32(),
    y: reader.f32(),
    z: reader.f32(),
    jumpAllowed: booleanByte(reader.u8(), 'transport jump gate'),
  });
  const localMovement = readLocalMovement(reader, local === 0 ? null : local);
  const winnerKind = reader.u8();
  let winner: GameStateView['winner'] = null;
  if (winnerKind === 1) winner = Object.freeze({ kind: 'actor', actorId: reader.u16(), displayName: '' });
  else if (winnerKind === 2) winner = Object.freeze({ kind: 'team', teamId: reader.i16() });
  else if (winnerKind !== 0) throw new MatchStateCodecError('invalid-packet', 'Invalid winner kind');
  const resultCount = reader.u8();
  const teamResults = Array.from({ length: resultCount }, () => readTeamResult(reader));
  reader.assertDone('meta record');
  return Object.freeze({
    hostTick, stateRevision, time, phaseTime, phase, mode,
    localActorId: local === 0 ? null : local,
    storm, transport, localMovement, winner,
    teamResults: Object.freeze(teamResults),
  });
}

function writeLocalMovement(
  writer: BinaryWriter,
  movement: LocalMovementView | null,
  localActorId: number | null,
): void {
  if (!movement) {
    writer.u8(0);
    return;
  }
  if (localActorId === null || movement.actorId !== localActorId) invalid('Local movement Actor binding mismatch');
  writer.u8(1);
  writer.u16(movement.actorId);
  let flags = 0;
  if (movement.hitCeiling) flags |= 1 << 0;
  if (movement.slidAlongWall) flags |= 1 << 1;
  if (movement.grappleActive) flags |= 1 << 2;
  if (movement.wallrunLanded) flags |= 1 << 3;
  if (movement.inWater) flags |= 1 << 4;
  if (movement.submerged) flags |= 1 << 5;
  if (movement.waterSurfaceY !== null) flags |= 1 << 6;
  if (movement.healingMovementPenalty) flags |= 1 << 7;
  writer.u8(flags);
  writer.i16(quantizeUnit(movement.groundNormalY, 'groundNormalY'));
  writer.i16(quantizeUnit(movement.slideDirX, 'slideDirX'));
  writer.i16(quantizeUnit(movement.slideDirZ, 'slideDirZ'));
  writer.i16(quantizeUnit(movement.wallNormalX, 'wallNormalX'));
  writer.i16(quantizeUnit(movement.wallNormalZ, 'wallNormalZ'));
  writer.i16(quantizeUnit(movement.dashDirX, 'dashDirX'));
  writer.i16(quantizeUnit(movement.dashDirZ, 'dashDirZ'));
  writer.i16(quantizeUnit(movement.lastWallNx, 'lastWallNx'));
  writer.i16(quantizeUnit(movement.lastWallNz, 'lastWallNz'));
  for (const [label, value] of [
    ['slideTimer', movement.slideTimer],
    ['slideCooldown', movement.slideCooldown],
    ['wallrunTimer', movement.wallrunTimer],
    ['mantleTimer', movement.mantleTimer],
    ['mantleCooldown', movement.mantleCooldown],
    ['grappleCooldown', movement.grappleCooldown],
    ['dashRegen', movement.dashRegen],
    ['dashTimer', movement.dashTimer],
    ['coyote', movement.coyote],
    ['jumpBuffered', movement.jumpBuffered],
    ['bhopWindow', movement.bhopWindow],
    ['wallrunCooldown', movement.wallrunCooldown],
    ['poundTimer', movement.poundTimer],
  ] as const) writer.i16(quantizeShortTimer(value, label));
  writer.i8(boundedInteger(movement.wallSide, -1, 1, 'wallSide'));
  writer.u8(boundedInteger(movement.dashCharges, 0, 8, 'dashCharges'));
  writer.u8(boundedInteger(movement.jumpsUsed, 0, 8, 'jumpsUsed'));
  writer.u8(boundedInteger(movement.wallrunChains, 0, 8, 'wallrunChains'));
  writeQuantizedVector(writer, movement.mantleFrom);
  writeQuantizedVector(writer, movement.mantleTo);
  writeQuantizedVector(writer, movement.grapplePoint);
  writer.f32(boundedFinite(movement.peakFallSpeed, 0, 512, 'peakFallSpeed'));
  writer.f32(boundedFinite(movement.airborneGroundTime, 0, 600, 'airborneGroundTime'));
  writer.f32(boundedFinite(movement.footstepAccum, 0, 32, 'footstepAccum'));
  if (movement.waterSurfaceY !== null) writer.i16(quantizeWorld(movement.waterSurfaceY));
  writer.u16(quantizeUnsignedUnit(movement.adsAmount, 'adsAmount'));
}

function readLocalMovement(reader: BinaryReader, localActorId: number | null): LocalMovementView | null {
  const present = reader.u8();
  if (present === 0) return null;
  if (present !== 1 || localActorId === null) return invalid('Invalid local movement presence');
  const actorId = reader.u16();
  if (actorId !== localActorId) return invalid('Local movement Actor binding mismatch');
  const flags = reader.u8();
  const groundNormalY = dequantizeUnit(reader.i16());
  const slideDirX = dequantizeUnit(reader.i16());
  const slideDirZ = dequantizeUnit(reader.i16());
  const wallNormalX = dequantizeUnit(reader.i16());
  const wallNormalZ = dequantizeUnit(reader.i16());
  const dashDirX = dequantizeUnit(reader.i16());
  const dashDirZ = dequantizeUnit(reader.i16());
  const lastWallNx = dequantizeUnit(reader.i16());
  const lastWallNz = dequantizeUnit(reader.i16());
  const slideTimer = dequantizeShortTimer(reader.i16());
  const slideCooldown = dequantizeShortTimer(reader.i16());
  const wallrunTimer = dequantizeShortTimer(reader.i16());
  const mantleTimer = dequantizeShortTimer(reader.i16());
  const mantleCooldown = dequantizeShortTimer(reader.i16());
  const grappleCooldown = dequantizeShortTimer(reader.i16());
  const dashRegen = dequantizeShortTimer(reader.i16());
  const dashTimer = dequantizeShortTimer(reader.i16());
  const coyote = dequantizeShortTimer(reader.i16());
  const jumpBuffered = dequantizeShortTimer(reader.i16());
  const bhopWindow = dequantizeShortTimer(reader.i16());
  const wallrunCooldown = dequantizeShortTimer(reader.i16());
  const poundTimer = dequantizeShortTimer(reader.i16());
  const wallSide = reader.i8();
  if (wallSide < -1 || wallSide > 1) return invalid('Invalid wallSide');
  const dashCharges = readBoundedCounter(reader, 'dashCharges');
  const jumpsUsed = readBoundedCounter(reader, 'jumpsUsed');
  const wallrunChains = readBoundedCounter(reader, 'wallrunChains');
  const mantleFrom = readQuantizedVector(reader);
  const mantleTo = readQuantizedVector(reader);
  const grapplePoint = readQuantizedVector(reader);
  const peakFallSpeed = boundedFinite(reader.f32(), 0, 512, 'peakFallSpeed');
  const airborneGroundTime = boundedFinite(reader.f32(), 0, 600, 'airborneGroundTime');
  const footstepAccum = boundedFinite(reader.f32(), 0, 32, 'footstepAccum');
  const waterSurfaceY = (flags & (1 << 6)) !== 0 ? dequantizeWorld(reader.i16()) : null;
  const adsAmount = dequantizeUnsignedUnit(reader.u16());
  return Object.freeze({
    actorId,
    groundNormalY,
    hitCeiling: (flags & (1 << 0)) !== 0,
    slidAlongWall: (flags & (1 << 1)) !== 0,
    slideTimer,
    slideDirX,
    slideDirZ,
    slideCooldown,
    wallrunTimer,
    wallSide,
    wallNormalX,
    wallNormalZ,
    mantleTimer,
    mantleCooldown,
    mantleFrom,
    mantleTo,
    grappleActive: (flags & (1 << 2)) !== 0,
    grapplePoint,
    grappleCooldown,
    dashCharges,
    dashRegen,
    dashTimer,
    dashDirX,
    dashDirZ,
    jumpsUsed,
    coyote,
    jumpBuffered,
    bhopWindow,
    wallrunCooldown,
    wallrunLanded: (flags & (1 << 3)) !== 0,
    wallrunChains,
    lastWallNx,
    lastWallNz,
    peakFallSpeed,
    airborneGroundTime,
    poundTimer,
    footstepAccum,
    inWater: (flags & (1 << 4)) !== 0,
    submerged: (flags & (1 << 5)) !== 0,
    waterSurfaceY,
    adsAmount,
    healingMovementPenalty: (flags & (1 << 7)) !== 0,
  });
}

function writeTeamResult(writer: BinaryWriter, result: TeamResult): void {
  writer.i16(result.teamId);
  writer.u8(result.won ? 1 : 0);
  writer.u16(result.eliminations);
  writer.u8(result.survivingActorIds.length);
  for (const actorId of result.survivingActorIds) writer.u16(actorId);
}

function readTeamResult(reader: BinaryReader): TeamResult {
  const teamId = reader.i16();
  const won = booleanByte(reader.u8(), 'team result won');
  const eliminations = reader.u16();
  const count = reader.u8();
  return Object.freeze({
    teamId,
    won,
    eliminations,
    survivingActorIds: Object.freeze(Array.from({ length: count }, () => reader.u16())),
  });
}

function writeActorBucket(writer: BinaryWriter, actors: readonly ActorView[]): void {
  for (const actor of [...actors].sort((a, b) => a.id - b.id)) {
    writer.u16(actor.id);
    writer.string8(actor.displayName, 48);
    writer.u8(actor.ownership.kind === 'bot' ? 0 : actor.ownership.kind === 'local-human' ? 1 : 2);
    writer.string8(actor.ownership.kind === 'bot' ? '' : actor.ownership.peerId, 96);
    writer.u8(enumIndex(CONNECTIONS, actor.connectionState, 'connection state'));
    writer.i16(actor.teamId ?? -1);
    writer.u8(enumIndex(SKINS, actor.skinId, 'skin'));
    writer.u32(actor.accentColor);
    let flags = 0;
    if (actor.alive) flags |= 1;
    if (actor.grounded) flags |= 2;
    if (actor.crouched) flags |= 4;
    if (actor.deployed) flags |= 8;
    writer.u8(flags);
    writer.f32(actor.health);
    writer.f32(actor.shield);
    writeVector(writer, actor.position);
    writeVector(writer, actor.velocity);
    writer.f32(actor.yaw);
    writer.f32(actor.pitch);
    writer.u8(enumIndex(MOVE_STATES, actor.moveState, 'move state'));
    writer.u8(actor.equippedWeapon === null ? 0xff : enumIndex(WEAPONS, actor.equippedWeapon, 'weapon'));
    writer.u16(actor.placement);
    writer.u16(actor.stats.kills);
    writer.f32(actor.stats.damageDealt);
    writer.u32(actor.stats.shotsFired);
    writer.u32(actor.stats.shotsHit);
    writer.u32(actor.stats.headshots);
    writer.f32(actor.stats.survivalTime);
    writeInventory(writer, actor.inventory);
  }
}

function readActorBucket(reader: BinaryReader, count: number): ActorView[] {
  return Array.from({ length: count }, () => {
    const id = reader.u16();
    const displayName = reader.string8(48);
    const ownershipKind = reader.u8();
    const peerId = reader.string8(96);
    const ownership: ActorView['ownership'] = ownershipKind === 0
      ? Object.freeze({ kind: 'bot' })
      : ownershipKind === 1
        ? Object.freeze({ kind: 'local-human', peerId })
        : ownershipKind === 2
          ? Object.freeze({ kind: 'remote-human', peerId })
          : invalid('Invalid actor ownership kind');
    const connectionState = enumAt(CONNECTIONS, reader.u8(), 'connection state');
    const rawTeam = reader.i16();
    const skinId = enumAt(SKINS, reader.u8(), 'skin');
    const accentColor = reader.u32();
    const flags = reader.u8();
    if ((flags & ~0x0f) !== 0) invalid('Invalid actor flags');
    const health = reader.f32();
    const shield = reader.f32();
    const position = readVector(reader);
    const velocity = readVector(reader);
    const yaw = reader.f32();
    const pitch = reader.f32();
    const moveState = enumAt(MOVE_STATES, reader.u8(), 'move state');
    const rawWeapon = reader.u8();
    const equippedWeapon = rawWeapon === 0xff ? null : enumAt(WEAPONS, rawWeapon, 'weapon');
    const placement = reader.u16();
    const stats = Object.freeze({
      kills: reader.u16(),
      damageDealt: reader.f32(),
      shotsFired: reader.u32(),
      shotsHit: reader.u32(),
      headshots: reader.u32(),
      survivalTime: reader.f32(),
    });
    const inventory = readInventory(reader);
    return Object.freeze({
      id, displayName, ownership, connectionState,
      teamId: rawTeam === -1 ? null : rawTeam,
      skinId, accentColor,
      alive: (flags & 1) !== 0,
      health, shield, position, velocity, yaw, pitch,
      grounded: (flags & 2) !== 0,
      moveState,
      crouched: (flags & 4) !== 0,
      deployed: (flags & 8) !== 0,
      equippedWeapon, inventory, placement, stats,
    });
  });
}

function writeInventory(writer: BinaryWriter, inventory: InventoryView | null): void {
  if (!inventory) { writer.u8(0); return; }
  writer.u8(1);
  writer.i8(inventory.selected);
  if (inventory.slots.length !== 5) invalid('Inventory must contain five slots');
  for (const item of inventory.slots) {
    if (!item) writer.u8(0);
    else if (item.kind === 'weapon') {
      writer.u8(1);
      writer.u8(enumIndex(WEAPONS, item.weaponId, 'inventory weapon'));
      writer.u8(enumIndex(RARITIES, item.rarity, 'inventory rarity'));
      writer.u16(item.ammoInMag);
    } else {
      writer.u8(item.itemId === 'medkit' ? 2 : 3);
      writer.u8(item.count);
    }
  }
  writer.u16(inventory.ammo.light);
  writer.u16(inventory.ammo.medium);
  writer.u16(inventory.ammo.shells);
  writer.u16(inventory.ammo.heavy);
  if (!inventory.healing) writer.u8(0);
  else {
    writer.u8(inventory.healing.itemId === 'medkit' ? 1 : 2);
    writer.f32(inventory.healing.remaining);
    writer.f32(inventory.healing.total);
  }
}

function readInventory(reader: BinaryReader): InventoryView | null {
  const present = reader.u8();
  if (present === 0) return null;
  if (present !== 1) return invalid('Invalid inventory presence byte');
  const selected = reader.i8();
  const slots: InventoryView['slots'][number][] = [];
  for (let index = 0; index < 5; index++) {
    const kind = reader.u8();
    if (kind === 0) slots.push(null);
    else if (kind === 1) slots.push(Object.freeze({
      kind: 'weapon',
      weaponId: enumAt(WEAPONS, reader.u8(), 'inventory weapon'),
      rarity: enumAt(RARITIES, reader.u8(), 'inventory rarity'),
      ammoInMag: reader.u16(),
    }));
    else if (kind === 2 || kind === 3) slots.push(Object.freeze({
      kind: 'heal', itemId: kind === 2 ? 'medkit' : 'shieldpot', count: reader.u8(),
    }));
    else invalid('Invalid inventory slot kind');
  }
  const ammo = Object.freeze({ light: reader.u16(), medium: reader.u16(), shells: reader.u16(), heavy: reader.u16() });
  const healingKind = reader.u8();
  const healing = healingKind === 0 ? null
    : healingKind === 1 || healingKind === 2
      ? Object.freeze({
        itemId: healingKind === 1 ? 'medkit' as const : 'shieldpot' as const,
        remaining: reader.f32(), total: reader.f32(),
      })
      : invalid('Invalid healing kind');
  return Object.freeze({ selected, slots: Object.freeze(slots), ammo, healing });
}

function writeTeamBucket(writer: BinaryWriter, teams: readonly TeamView[]): void {
  for (const team of [...teams].sort((a, b) => a.teamId - b.teamId)) {
    writer.i16(team.teamId);
    writer.u8(team.aliveCount);
    writer.u8(team.members.length);
    for (const member of [...team.members].sort((a, b) => a.slotId - b.slotId)) {
      writer.u16(member.actorId);
      writer.u8(member.slotId);
      writer.u8(member.alive ? 1 : 0);
      writer.u8(enumIndex(CONNECTIONS, member.connectionState, 'team connection'));
    }
  }
}

interface EncodedTeam {
  readonly teamId: TeamId;
  readonly aliveCount: number;
  readonly members: readonly { readonly actorId: number; readonly slotId: number; readonly alive: boolean; readonly connectionState: ConnectionState }[];
}

function readTeamBucket(reader: BinaryReader, count: number): EncodedTeam[] {
  return Array.from({ length: count }, () => {
    const teamId = reader.i16();
    const aliveCount = reader.u8();
    const memberCount = reader.u8();
    return Object.freeze({
      teamId,
      aliveCount,
      members: Object.freeze(Array.from({ length: memberCount }, () => Object.freeze({
        actorId: reader.u16(),
        slotId: reader.u8(),
        alive: booleanByte(reader.u8(), 'team member alive'),
        connectionState: enumAt(CONNECTIONS, reader.u8(), 'team connection'),
      }))),
    });
  });
}

function writeChestBucket(writer: BinaryWriter, chests: GameStateView['chests']): void {
  for (const chest of [...chests].sort((a, b) => a.id - b.id)) {
    writer.u32(chest.id);
    writer.u8(enumIndex(CHEST_KINDS, chest.kind, 'chest kind'));
    writer.f32(chest.x); writer.f32(chest.y); writer.f32(chest.z);
    writer.u8(chest.opened ? 1 : 0);
  }
}

function readChestBucket(reader: BinaryReader, count: number): GameStateView['chests'][number][] {
  return Array.from({ length: count }, () => Object.freeze({
    id: reader.u32(),
    kind: enumAt(CHEST_KINDS, reader.u8(), 'chest kind'),
    x: reader.f32(), y: reader.f32(), z: reader.f32(),
    opened: booleanByte(reader.u8(), 'chest opened'),
  }));
}

function writeLootBucket(writer: BinaryWriter, loot: GameStateView['loot']): void {
  for (const item of [...loot].sort((a, b) => a.id - b.id)) {
    writer.u16(item.id);
    writer.u8(enumIndex(LOOT_KINDS, item.kind, 'loot kind'));
    writer.i16(quantizeWorld(item.x)); writer.i16(quantizeWorld(item.y)); writer.i16(quantizeWorld(item.z));
    writer.i16(quantizeAngle(item.yaw));
    writer.u8(enumIndex(RARITIES, item.rarity, 'loot rarity'));
    if (item.kind === 'weapon') {
      writer.u8(enumIndex(WEAPONS, item.weaponId, 'loot weapon'));
      writer.u16(item.ammoInMag);
    } else if (item.kind === 'ammo') {
      writer.u8(enumIndex(AMMO_TYPES, item.ammoType, 'loot ammo type'));
      writer.u16(item.amount);
    } else {
      writer.u8(item.itemId === 'medkit' ? 0 : 1);
      writer.u8(item.count);
    }
  }
}

function readLootBucket(reader: BinaryReader, count: number): GameStateView['loot'][number][] {
  return Array.from({ length: count }, () => {
    const id = reader.u16();
    const kind = enumAt(LOOT_KINDS, reader.u8(), 'loot kind');
    const x = dequantizeWorld(reader.i16());
    const y = dequantizeWorld(reader.i16());
    const z = dequantizeWorld(reader.i16());
    const yaw = dequantizeAngle(reader.i16());
    const rarity = enumAt(RARITIES, reader.u8(), 'loot rarity');
    if (kind === 'weapon') return Object.freeze({
      id, kind, x, y, z, yaw, rarity,
      weaponId: enumAt(WEAPONS, reader.u8(), 'loot weapon'),
      ammoInMag: reader.u16(),
    });
    if (kind === 'ammo') return Object.freeze({
      id, kind, x, y, z, yaw, rarity,
      ammoType: enumAt(AMMO_TYPES, reader.u8(), 'loot ammo type'),
      amount: reader.u16(),
    });
    const item = reader.u8();
    if (item > 1) invalid('Invalid loot heal item');
    return Object.freeze({
      id, kind, x, y, z, yaw, rarity,
      itemId: item === 0 ? 'medkit' as const : 'shieldpot' as const,
      count: reader.u8(),
    });
  });
}

function encodeDestructibleRecords(
  values: GameStateView['destructibles'],
  order: readonly string[],
): SnapshotEntityInput[] {
  if (values.length !== order.length) invalid('Destructible state does not match the loaded map dictionary');
  const byId = new Map(values.map((value) => [value.id, value]));
  if (byId.size !== values.length || order.some((id) => !byId.has(id))) invalid('Destructible dictionary identity mismatch');
  return Array.from({ length: DESTRUCTIBLE_BUCKETS }, (_, page) => {
    const start = page * DESTRUCTIBLES_PER_PAGE;
    const ids = order.slice(start, start + DESTRUCTIBLES_PER_PAGE);
    const states = ids.map((id) => byId.get(id)!);
    const writer = sectionWriter(SECTION.destructible);
    writer.u16(states.length);
    writer.u16(start);
    writer.u8(states.length);
    const bitset = new Uint8Array(Math.ceil(states.length / 8));
    states.forEach((state, index) => {
      if (state.destroyed) bitset[index >> 3] = bitset[index >> 3]! | (1 << (index & 7));
    });
    writer.u8(bitset.byteLength);
    writer.raw(bitset);
    const revised = states.map((state, index) => ({ state, index })).filter(({ state }) => state.revision !== 0);
    writer.u8(revised.length);
    for (const { state, index } of revised) { writer.u8(index); writer.u32(state.revision); }
    return Object.freeze({
      id: RECORD_ID.destructible + page,
      mask: RECORD_MASK.destructible,
      payload: writer.finish(),
    });
  });
}

function readDestructiblePage(
  reader: BinaryReader,
  count: number,
  page: number,
  order: readonly string[],
): GameStateView['destructibles'][number][] {
  const start = reader.u16();
  const span = reader.u8();
  const expectedStart = page * DESTRUCTIBLES_PER_PAGE;
  const expectedIds = order.slice(expectedStart, expectedStart + DESTRUCTIBLES_PER_PAGE);
  if (start !== expectedStart || span !== count || span !== expectedIds.length) invalid('Destructible page does not match the map dictionary');
  const bitsetLength = reader.u8();
  if (bitsetLength !== Math.ceil(span / 8)) invalid('Invalid destructible bitset length');
  const bitset = reader.raw(bitsetLength);
  const revisions = new Map<number, number>();
  const revisionCount = reader.u8();
  if (revisionCount > span) invalid('Invalid destructible revision count');
  for (let index = 0; index < revisionCount; index++) {
    const offset = reader.u8();
    const revision = reader.u32();
    if (offset >= span || revision === 0 || revisions.has(offset)) invalid('Invalid destructible revision entry');
    revisions.set(offset, revision);
  }
  return expectedIds.map((id, index) => Object.freeze({
    id,
    revision: revisions.get(index) ?? 0,
    destroyed: (bitset[index >> 3]! & (1 << (index & 7))) !== 0,
  }));
}

function encodeBuckets<T>(
  values: readonly T[],
  bucketCount: number,
  idBase: number,
  mask: number,
  bucketFor: (value: T) => number,
  write: (writer: BinaryWriter, values: readonly T[]) => void,
): SnapshotEntityInput[] {
  const buckets = Array.from({ length: bucketCount }, () => [] as T[]);
  for (const value of values) {
    const bucket = bucketFor(value);
    if (!Number.isSafeInteger(bucket) || bucket < 0 || bucket >= bucketCount) invalid('Invalid state bucket');
    buckets[bucket]!.push(value);
  }
  return buckets.map((bucket, index) => {
    const writer = sectionWriter(sectionForMask(mask));
    writer.u16(bucket.length);
    write(writer, bucket);
    return Object.freeze({ id: idBase + index, mask, payload: writer.finish() });
  });
}

function decodeGameStateRecords(
  records: ReadonlyMap<number, SnapshotEntityInput>,
  snapshot: ReassembledSnapshot,
  destructibleOrder: readonly string[],
): GameStateView {
  const metaRecord = records.get(RECORD_ID.meta);
  if (!metaRecord || metaRecord.mask !== RECORD_MASK.meta) invalid('Missing state metadata');
  const meta = decodeMeta(binaryBytes(metaRecord.payload));
  if (meta.hostTick !== snapshot.hostTick || meta.stateRevision !== snapshot.revision) {
    throw new MatchStateCodecError('invalid-packet', 'State metadata does not match snapshot envelope');
  }
  const actors = decodeBucketRange(records, RECORD_ID.actor, ACTOR_BUCKETS, RECORD_MASK.actor,
    SECTION.actor, readActorBucket).sort((a, b) => a.id - b.id);
  const encodedTeams = decodeBucketRange(records, RECORD_ID.team, TEAM_BUCKETS, RECORD_MASK.team,
    SECTION.team, readTeamBucket).sort((a, b) => a.teamId - b.teamId);
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  const teams: TeamView[] = encodedTeams.map((team) => Object.freeze({
    teamId: team.teamId,
    aliveCount: team.aliveCount,
    members: Object.freeze(team.members.map((member) => {
      const actor = actorById.get(member.actorId);
      if (!actor) return invalid('Team references an unknown actor');
      return Object.freeze({ ...member, displayName: actor.displayName, accentColor: actor.accentColor });
    })),
  }));
  const chests = decodeBucketRange(records, RECORD_ID.chest, CHEST_BUCKETS, RECORD_MASK.chest,
    SECTION.chest, readChestBucket).sort((a, b) => a.id - b.id);
  const loot = decodeBucketRange(records, RECORD_ID.loot, LOOT_BUCKETS, RECORD_MASK.loot,
    SECTION.loot, readLootBucket).sort((a, b) => a.id - b.id);
  const destructibles: GameStateView['destructibles'][number][] = [];
  for (let page = 0; page < DESTRUCTIBLE_BUCKETS; page++) {
    const record = records.get(RECORD_ID.destructible + page);
    if (!record || record.mask !== RECORD_MASK.destructible) invalid('Missing destructible page');
    const reader = sectionReader(binaryBytes(record.payload), SECTION.destructible);
    const count = reader.u16();
    destructibles.push(...readDestructiblePage(reader, count, page, destructibleOrder));
    reader.assertDone('destructible page');
  }
  if (new Set(actors.map((actor) => actor.id)).size !== actors.length
    || new Set(chests.map((chest) => chest.id)).size !== chests.length
    || new Set(loot.map((item) => item.id)).size !== loot.length
    || new Set(destructibles.map((value) => value.id)).size !== destructibles.length) {
    invalid('State contains duplicate stable IDs');
  }
  if (meta.localActorId !== null && !actorById.has(meta.localActorId)) invalid('Local actor is absent');
  if (actors.some((actor) => actor.id !== meta.localActorId && actor.inventory !== null)) {
    invalid('Snapshot exposes non-owner inventory');
  }
  if (meta.localMovement !== null && meta.localMovement.actorId !== meta.localActorId) {
    invalid('Snapshot exposes non-owner movement runtime');
  }
  const winner = meta.winner?.kind === 'actor'
    ? Object.freeze({ ...meta.winner, displayName: actorById.get(meta.winner.actorId)?.displayName ?? '' })
    : meta.winner;
  return Object.freeze({
    ...meta,
    winner,
    actors: Object.freeze(actors),
    teams: Object.freeze(teams),
    chests: Object.freeze(chests),
    loot: Object.freeze(loot),
    destructibles: Object.freeze(destructibles),
  });
}

function decodeBucketRange<T>(
  records: ReadonlyMap<number, SnapshotEntityInput>,
  base: number,
  count: number,
  mask: number,
  section: number,
  read: (reader: BinaryReader, count: number) => T[],
): T[] {
  const values: T[] = [];
  for (let index = 0; index < count; index++) {
    const record = records.get(base + index);
    if (!record || record.mask !== mask) invalid('Missing or mismatched state bucket');
    const reader = sectionReader(binaryBytes(record.payload), section);
    const entryCount = reader.u16();
    values.push(...read(reader, entryCount));
    reader.assertDone('state bucket');
  }
  return values;
}

function sectionWriter(section: number): BinaryWriter {
  const writer = new BinaryWriter(MAX_ENTITY_PAYLOAD_BYTES);
  writer.u8(MATCH_STATE_CODEC_VERSION);
  writer.u8(section);
  return writer;
}

function sectionReader(payload: Uint8Array, expectedSection: number): BinaryReader {
  const reader = new BinaryReader(payload);
  if (reader.u8() !== MATCH_STATE_CODEC_VERSION || reader.u8() !== expectedSection) {
    throw new MatchStateCodecError('invalid-packet', 'Unsupported state record section');
  }
  return reader;
}

function sectionForMask(mask: number): number {
  if (mask === RECORD_MASK.actor) return SECTION.actor;
  if (mask === RECORD_MASK.team) return SECTION.team;
  if (mask === RECORD_MASK.chest) return SECTION.chest;
  if (mask === RECORD_MASK.loot) return SECTION.loot;
  if (mask === RECORD_MASK.destructible) return SECTION.destructible;
  return invalid('Unknown state record mask');
}

function snapshotRecordMap(snapshot: ReassembledSnapshot): Map<number, SnapshotEntityInput> {
  const records = new Map<number, SnapshotEntityInput>();
  for (const entity of snapshot.entities) {
    if (records.has(entity.id)) invalid('Snapshot repeats a state record');
    records.set(entity.id, entity);
  }
  return records;
}

function assertFullRecordSet(records: ReadonlyMap<number, SnapshotEntityInput>): void {
  if (records.size !== EXPECTED_FULL_RECORDS) invalid('Full keyframe has an incomplete state record set');
  const expected: number[] = [RECORD_ID.meta];
  for (const [base, count] of [
    [RECORD_ID.actor, ACTOR_BUCKETS], [RECORD_ID.team, TEAM_BUCKETS],
    [RECORD_ID.chest, CHEST_BUCKETS], [RECORD_ID.loot, LOOT_BUCKETS],
    [RECORD_ID.destructible, DESTRUCTIBLE_BUCKETS],
  ] as const) for (let index = 0; index < count; index++) expected.push(base + index);
  if (expected.some((id) => !records.has(id))) invalid('Full keyframe is missing a state record');
}

function cloneRecordMap(records: ReadonlyMap<number, SnapshotEntityInput>): Map<number, SnapshotEntityInput> {
  return new Map([...records.entries()].map(([id, record]) => [id, Object.freeze({
    id: record.id,
    mask: record.mask,
    payload: binaryBytes(record.payload).slice(),
  })]));
}

function validateStateBounds(view: GameStateView): void {
  if (view.actors.length > MAX_STATE_ACTORS || view.teams.length > 2
    || view.chests.length > MAX_STATE_CHESTS || view.loot.length > MAX_STATE_LOOT
    || view.destructibles.length > MAX_STATE_DESTRUCTIBLES || view.teamResults.length > 2) {
    throw new MatchStateCodecError('invalid-state', 'Game state exceeds protocol entity bounds');
  }
  if (!Number.isSafeInteger(view.hostTick) || view.hostTick < 0 || view.hostTick > 0xffff_ffff
    || !Number.isSafeInteger(view.stateRevision) || view.stateRevision < 0 || view.stateRevision > 0xffff_ffff) {
    throw new MatchStateCodecError('invalid-state', 'Game state tick or revision is invalid');
  }
}

function encodeCanonicalBinary(value: CanonicalBinaryValue): Uint8Array {
  const writer = new BinaryWriter(MAX_RELIABLE_PAYLOAD_BYTES);
  writeCanonical(writer, value, 0);
  return writer.finish();
}

function decodeCanonicalBinary(bytes: Uint8Array): CanonicalBinaryValue {
  const reader = new BinaryReader(bytes);
  const value = readCanonical(reader, 0);
  reader.assertDone('canonical reliable payload');
  return value;
}

function writeCanonical(writer: BinaryWriter, value: CanonicalBinaryValue, depth: number): void {
  if (depth > 8) invalid('Reliable payload nesting is too deep');
  if (value === null) { writer.u8(0); return; }
  if (value === false) { writer.u8(1); return; }
  if (value === true) { writer.u8(2); return; }
  if (typeof value === 'number') {
    finite(value, 'canonical number');
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff) { writer.u8(3); writer.u32(value); }
    else if (Number.isSafeInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff) {
      writer.u8(4);
      writer.u32(value >>> 0);
    } else { writer.u8(5); writer.f64(value); }
    return;
  }
  if (typeof value === 'string') { writer.u8(6); writer.string16(value, 8192); return; }
  if (Array.isArray(value)) {
    if (value.length > 512) invalid('Reliable array is too large');
    writer.u8(7); writer.u16(value.length);
    for (const item of value) writeCanonical(writer, item, depth + 1);
    return;
  }
  if (typeof value !== 'object') invalid('Reliable payload contains an unsupported value');
  const source = value as { readonly [key: string]: CanonicalBinaryValue };
  const keys = Object.keys(source).sort();
  if (keys.length > 256) invalid('Reliable object has too many keys');
  writer.u8(8); writer.u16(keys.length);
  for (const key of keys) {
    if (isUnsafeWireKey(key)) invalid('Reliable object contains a reserved key');
    writer.string8(key, 96);
    const item = source[key];
    if (item === undefined) invalid('Reliable payload contains undefined');
    writeCanonical(writer, item, depth + 1);
  }
}

function readCanonical(reader: BinaryReader, depth: number): CanonicalBinaryValue {
  if (depth > 8) invalid('Reliable payload nesting is too deep');
  const tag = reader.u8();
  if (tag === 0) return null;
  if (tag === 1) return false;
  if (tag === 2) return true;
  if (tag === 3) return reader.u32();
  if (tag === 4) return reader.u32() | 0;
  if (tag === 5) return reader.f64();
  if (tag === 6) return reader.string16(8192);
  if (tag === 7) {
    const length = reader.u16();
    if (length > 512) invalid('Reliable array is too large');
    return Object.freeze(Array.from({ length }, () => readCanonical(reader, depth + 1)));
  }
  if (tag === 8) {
    const count = reader.u16();
    if (count > 256) invalid('Reliable object has too many keys');
    const value = Object.create(null) as Record<string, CanonicalBinaryValue>;
    let previous = '';
    for (let index = 0; index < count; index++) {
      const key = reader.string8(96);
      if (isUnsafeWireKey(key)) invalid('Reliable object contains a reserved key');
      if (index > 0 && key <= previous || Object.hasOwn(value, key)) invalid('Reliable object keys are not canonical');
      previous = key;
      value[key] = readCanonical(reader, depth + 1);
    }
    return Object.freeze(value);
  }
  return invalid('Unknown reliable value tag');
}

function canonicalEvent(event: AuthoritativeMatchEvent): CanonicalBinaryValue {
  return {
    eventId: event.eventId,
    revision: event.revision,
    hostTick: event.hostTick,
    type: event.type,
    payload: toCanonicalObject(event.payload),
  };
}

function toCanonicalObject(value: Readonly<Record<string, unknown>>): { readonly [key: string]: CanonicalBinaryValue } {
  const output = Object.create(null) as Record<string, CanonicalBinaryValue>;
  for (const [key, item] of Object.entries(value)) {
    if (isUnsafeWireKey(key)) invalid('Authoritative event contains a reserved key');
    output[key] = toCanonicalValue(item);
  }
  return output;
}

function isUnsafeWireKey(value: string): boolean {
  return value === '__proto__' || value === 'constructor' || value === 'prototype';
}

function toCanonicalValue(value: unknown): CanonicalBinaryValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toCanonicalValue);
  if (value && typeof value === 'object') return toCanonicalObject(value as Readonly<Record<string, unknown>>);
  return invalid('Authoritative event contains a non-binary value');
}

function objectValue(value: CanonicalBinaryValue | undefined, label: string): Readonly<Record<string, CanonicalBinaryValue>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${label}`);
  return value as Readonly<Record<string, CanonicalBinaryValue>>;
}

function uint32Value(value: CanonicalBinaryValue | undefined, label: string): number {
  if (typeof value !== 'number') invalid(`Invalid ${label}`);
  return unsigned(value, 0xffff_ffff, label);
}

function stringValue(value: CanonicalBinaryValue | undefined, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || encodeText(value, maxBytes).byteLength > maxBytes) invalid(`Invalid ${label}`);
  return value;
}

function writeVector(writer: BinaryWriter, value: Readonly<{ x: number; y: number; z: number }>): void {
  writer.f32(value.x); writer.f32(value.y); writer.f32(value.z);
}

function readVector(reader: BinaryReader): Readonly<{ x: number; y: number; z: number }> {
  return Object.freeze({ x: reader.f32(), y: reader.f32(), z: reader.f32() });
}

function numericBucket(id: number, count: number): number {
  return unsigned(id, 0xffff_ffff, 'entity ID') % count;
}

function quantizeWorld(value: number): number {
  finite(value, 'world coordinate');
  const encoded = Math.round(value * 32);
  return signed(encoded, -0x8000, 0x7fff, 'world coordinate');
}

function dequantizeWorld(value: number): number { return value / 32; }

function writeQuantizedVector(
  writer: BinaryWriter,
  value: Readonly<{ x: number; y: number; z: number }>,
): void {
  writer.i16(quantizeWorld(value.x));
  writer.i16(quantizeWorld(value.y));
  writer.i16(quantizeWorld(value.z));
}

function readQuantizedVector(reader: BinaryReader): Readonly<{ x: number; y: number; z: number }> {
  return Object.freeze({
    x: dequantizeWorld(reader.i16()),
    y: dequantizeWorld(reader.i16()),
    z: dequantizeWorld(reader.i16()),
  });
}

function quantizeUnit(value: number, label: string): number {
  const checked = boundedFinite(value, -1.001, 1.001, label);
  return Math.round(Math.max(-1, Math.min(1, checked)) * 0x7fff);
}

function dequantizeUnit(value: number): number { return value / 0x7fff; }

function quantizeUnsignedUnit(value: number, label: string): number {
  return Math.round(boundedFinite(value, 0, 1, label) * 0xffff);
}

function dequantizeUnsignedUnit(value: number): number { return value / 0xffff; }

function quantizeShortTimer(value: number, label: string): number {
  const checked = boundedFinite(value, -1, 31.999, label);
  return Math.round(checked * 1024);
}

function dequantizeShortTimer(value: number): number { return value / 1024; }

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) return invalid(`Invalid ${label}`);
  return value;
}

function boundedFinite(value: number, min: number, max: number, label: string): number {
  const checked = finite(value, label);
  if (checked < min || checked > max) return invalid(`Invalid ${label}`);
  return checked;
}

function readBoundedCounter(reader: BinaryReader, label: string): number {
  const value = reader.u8();
  if (value > 8) return invalid(`Invalid ${label}`);
  return value;
}

function quantizeAngle(value: number): number {
  const yaw = normalizeYaw(finite(value, 'world yaw'));
  return Math.max(-0x7fff, Math.min(0x7fff, Math.round(yaw / Math.PI * 0x7fff)));
}

function dequantizeAngle(value: number): number { return value / 0x7fff * Math.PI; }

function validateDestructibleOrder(order: readonly string[]): void {
  if (!Array.isArray(order) || order.length > MAX_STATE_DESTRUCTIBLES
    || new Set(order).size !== order.length
    || order.some((id) => typeof id !== 'string' || id.length === 0 || encodeText(id, 96).byteLength > 96)) {
    invalid('Invalid loaded-map destructible dictionary');
  }
}

function enumIndex<T extends string>(values: readonly T[], value: T, label: string): number {
  const index = values.indexOf(value);
  if (index < 0) return invalid(`Invalid ${label}`);
  return index;
}

function enumAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) return invalid(`Invalid ${label}`);
  return value;
}

function booleanByte(value: number, label: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  return invalid(`Invalid ${label}`);
}

function bytesEqual(a: ArrayBuffer | ArrayBufferView, b?: ArrayBuffer | ArrayBufferView): boolean {
  if (!b) return false;
  const left = binaryBytes(a);
  const right = binaryBytes(b);
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
  return true;
}

function binaryBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (!ArrayBuffer.isView(value)) return invalid('Expected binary payload');
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function encodeText(value: string, maxBytes: number): Uint8Array {
  if (typeof value !== 'string' || value.includes('\0')) invalid('Invalid binary string');
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > maxBytes) throw new MatchStateCodecError('payload-too-large', `String exceeds ${maxBytes} bytes`);
  return bytes;
}

function unsigned(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) return invalid(`Invalid ${label}`);
  return value;
}

function signed(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) return invalid(`Invalid ${label}`);
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) return invalid(`Invalid ${label}`);
  return value;
}

function invalid(message: string): never {
  throw new MatchStateCodecError('invalid-state', message);
}
