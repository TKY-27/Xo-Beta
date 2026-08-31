/**
 * Compact Phase 4 gameplay wire format.
 *
 * The lobby protocol is JSON, but input and snapshots travel over the
 * dedicated DataChannels as binary packets. Every packet starts with the
 * same 24-byte header. The payload length is checked against the actual
 * ArrayBuffer before any packet-specific bytes are read.
 */

export const MATCH_PROTOCOL_VERSION = 1 as const;
export const MATCH_HEADER_BYTES = 24;
export const MATCH_PACKET_VERSION = MATCH_PROTOCOL_VERSION;
export const MAX_MATCH_PACKET_BYTES = 16 * 1024;
export const MAX_MATCH_PAYLOAD_BYTES = MAX_MATCH_PACKET_BYTES - MATCH_HEADER_BYTES;

export const MAX_INPUT_PAYLOAD_BYTES = 128;
export const MAX_RECENT_INPUT_FRAMES = 3;
export const MAX_SNAPSHOT_PAYLOAD_BYTES = 8 * 1024;
export const MAX_SNAPSHOT_ENTITIES = 64;
export const MAX_SNAPSHOT_CHUNKS = 64;
export const MAX_ENTITY_PAYLOAD_BYTES = 248;

export const INPUT_AXIS_MIN = -1;
export const INPUT_AXIS_MAX = 1;
export const INPUT_YAW_MIN = -Math.PI;
export const INPUT_YAW_MAX = Math.PI;
export const INPUT_PITCH_LIMIT = Math.PI / 2 - 0.02;

const UINT32_MAX = 0xffff_ffff;
const UINT32_HALF_RANGE = 0x8000_0000;
const UINT16_MAX = 0xffff;
const QUANTIZED_UNIT = 32_767;
const SELECTED_SLOT_NONE = -2;
const SHOT_TICK_NONE = UINT32_MAX;
const INPUT_PAYLOAD_BYTES = 28;
const INPUT_REDUNDANT_FRAME_BYTES = 28;
const SNAPSHOT_PAYLOAD_BYTES = 24;
const ENTITY_RECORD_HEADER_BYTES = 8;
const SNAPSHOT_FLAG_FULL = 0x01;
const SNAPSHOT_FLAG_DELTA = 0x02;
const SNAPSHOT_FLAG_CHUNKED = 0x04;
const ALLOWED_SNAPSHOT_FLAGS = SNAPSHOT_FLAG_FULL | SNAPSHOT_FLAG_DELTA | SNAPSHOT_FLAG_CHUNKED;

/** Header offsets. Bytes 18..23 are reserved and must be zero. */
export const MATCH_HEADER_OFFSETS = Object.freeze({
  version: 0,
  type: 1,
  flags: 2,
  session: 4,
  sequence: 8,
  tick: 12,
  payloadLength: 16,
  reserved: 18,
} as const);

export type MatchPacketType = 'input' | 'snapshot';

export const MATCH_PACKET_TYPES: Readonly<Record<MatchPacketType, number>> = Object.freeze({
  input: 1,
  snapshot: 2,
});

export const SNAPSHOT_FLAGS = Object.freeze({
  full: SNAPSHOT_FLAG_FULL,
  delta: SNAPSHOT_FLAG_DELTA,
  chunked: SNAPSHOT_FLAG_CHUNKED,
} as const);

export const INPUT_HELD_MASK = Object.freeze({
  jump: 1 << 0,
  sprint: 1 << 1,
  crouch: 1 << 2,
  fire: 1 << 3,
  ads: 1 << 4,
} as const);

export const INPUT_EDGE_MASK = Object.freeze({
  jump: 1 << 0,
  crouch: 1 << 1,
  fire: 1 << 2,
  reload: 1 << 3,
  interact: 1 << 4,
  melee: 1 << 5,
  dropWeapon: 1 << 6,
  dash: 1 << 7,
  grapple: 1 << 8,
  grappleRelease: 1 << 9,
  pound: 1 << 10,
  shield: 1 << 11,
  medkit: 1 << 12,
} as const);

export const INPUT_HELD_ALLOWED_MASK = Object.values(INPUT_HELD_MASK)
  .reduce((mask, bit) => mask | bit, 0);
export const INPUT_EDGE_ALLOWED_MASK = Object.values(INPUT_EDGE_MASK)
  .reduce((mask, bit) => mask | bit, 0);

export type MatchProtocolErrorCode =
  | 'invalid-packet'
  | 'invalid-length'
  | 'payload-too-large'
  | 'unsupported-protocol'
  | 'unknown-type'
  | 'session-mismatch'
  | 'sequence-stale'
  | 'sequence-duplicate'
  | 'sequence-future'
  | 'tick-stale'
  | 'tick-future'
  | 'rate-limited'
  | 'revision-stale'
  | 'chunk-invalid'
  | 'entity-too-large';

export class MatchProtocolError extends Error {
  readonly code: MatchProtocolErrorCode;

  constructor(code: MatchProtocolErrorCode, message: string) {
    super(message);
    this.name = 'MatchProtocolError';
    this.code = code;
  }
}

export { MatchProtocolError as MatchProtocolValidationError };

export interface MatchPacketHeader {
  readonly protocolVersion: number;
  readonly type: MatchPacketType;
  readonly flags: number;
  readonly sessionId: number;
  readonly session: number;
  readonly sequence: number;
  readonly tick: number;
  readonly payloadLength: number;
}

export interface InputFrameInput {
  /** Numeric session binding stored in the common header. */
  readonly sessionId?: number;
  readonly session?: number;
  readonly inputSeq?: number;
  readonly sequence?: number;
  readonly clientTick?: number;
  readonly tick?: number;
  readonly lastAckHostTick?: number;
  readonly ackHostTick?: number;
  readonly moveX?: number;
  readonly moveZ?: number;
  readonly axes?: readonly number[];
  readonly yaw: number;
  readonly pitch: number;
  readonly heldMask: number;
  readonly edgeMask: number;
  /** null and -1 both represent no inventory slot/fists. */
  readonly selectedSlot?: number | null;
  readonly shotTick?: number | null;
  readonly recentFrames?: readonly RecentInputFrameInput[];
}

export interface RecentInputFrameInput {
  readonly inputSeq?: number;
  readonly sequence?: number;
  readonly clientTick?: number;
  readonly tick?: number;
  readonly moveX?: number;
  readonly moveZ?: number;
  readonly axes?: readonly number[];
  readonly yaw: number;
  readonly pitch: number;
  readonly heldMask: number;
  readonly edgeMask: number;
  readonly selectedSlot?: number | null;
  readonly shotTick?: number | null;
}

export interface RecentInputFrame {
  readonly inputSeq: number;
  readonly clientTick: number;
  readonly moveX: number;
  readonly moveZ: number;
  readonly axes: readonly [number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly heldMask: number;
  readonly edgeMask: number;
  readonly selectedSlot: number | null;
  readonly shotTick: number | null;
}

export interface InputFrame {
  readonly sessionId: number;
  readonly session: number;
  readonly inputSeq: number;
  readonly sequence: number;
  readonly clientTick: number;
  readonly tick: number;
  readonly lastAckHostTick: number;
  readonly moveX: number;
  readonly moveZ: number;
  readonly axes: readonly [number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly heldMask: number;
  readonly edgeMask: number;
  readonly selectedSlot: number | null;
  readonly shotTick: number | null;
  readonly recentFrames: readonly RecentInputFrame[];
}

export interface InputPacket extends InputFrame {
  readonly type: 'input';
  readonly protocolVersion: number;
  readonly flags: 0;
  readonly payloadLength: number;
  readonly header: MatchPacketHeader;
}

export interface SnapshotEntityInput {
  readonly id: number;
  readonly mask: number;
  readonly payload: ArrayBuffer | ArrayBufferView;
}

export interface SnapshotEntity extends SnapshotEntityInput {
  readonly payload: Uint8Array;
}

export interface SnapshotChunkInput {
  readonly sessionId?: number;
  readonly session?: number;
  readonly sequence: number;
  readonly hostTick: number;
  readonly tick?: number;
  readonly ackInputSeq: number;
  readonly revision: number;
  readonly full?: boolean;
  readonly delta?: boolean;
  readonly snapshotId?: number;
  readonly chunkIndex?: number;
  readonly fragmentIndex?: number;
  readonly chunkCount?: number;
  readonly fragmentCount?: number;
  readonly totalEntities?: number;
  readonly entities: readonly SnapshotEntityInput[];
}

export interface SnapshotChunk {
  readonly sessionId: number;
  readonly session: number;
  readonly type: 'snapshot';
  readonly protocolVersion: number;
  readonly flags: number;
  readonly sequence: number;
  readonly tick: number;
  readonly hostTick: number;
  readonly ackInputSeq: number;
  readonly revision: number;
  readonly full: boolean;
  readonly delta: boolean;
  readonly snapshotId: number;
  readonly chunkIndex: number;
  readonly fragmentIndex: number;
  readonly chunkCount: number;
  readonly fragmentCount: number;
  readonly totalEntities: number;
  readonly entities: readonly SnapshotEntity[];
  readonly payloadLength: number;
  readonly header: MatchPacketHeader;
}

export interface ReassembledSnapshot {
  readonly sessionId: number;
  readonly session: number;
  readonly sequence: number;
  readonly hostTick: number;
  readonly tick: number;
  readonly ackInputSeq: number;
  readonly revision: number;
  readonly full: boolean;
  readonly delta: boolean;
  readonly snapshotId: number;
  readonly entities: readonly SnapshotEntity[];
}

export type DecodedMatchPacket = InputPacket | SnapshotChunk;

type BinaryLike = ArrayBuffer | ArrayBufferView;

function fail(message: string, code: MatchProtocolErrorCode = 'invalid-packet'): MatchProtocolError {
  return new MatchProtocolError(code, message);
}

function asBytes(value: BinaryLike, label: string): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
  throw fail(`${label} must be an ArrayBuffer or ArrayBufferView`);
}

function copyBytes(value: BinaryLike, label: string): Uint8Array {
  return new Uint8Array(asBytes(value, label));
}

function uint32(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw fail(`${label} must be an unsigned 32-bit integer`);
  }
  return value;
}

function uint16(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > UINT16_MAX) {
    throw fail(`${label} must be an unsigned 16-bit integer`);
  }
  return value;
}

function finiteRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw fail(`${label} must be finite and within ${min}..${max}`);
  }
  return value;
}

function alias<T>(label: string, ...values: readonly (T | undefined)[]): T | undefined {
  const present = values.filter((value): value is T => value !== undefined);
  if (present.length === 0) return undefined;
  const first = present[0];
  if (present.some((value) => value !== first)) throw fail(`${label} aliases disagree`);
  return first;
}

function required<T>(label: string, ...values: readonly (T | undefined)[]): T {
  const value = alias(label, ...values);
  if (value === undefined) throw fail(`Missing ${label}`);
  return value;
}

function sessionId(value: InputFrameInput | SnapshotChunkInput, expected?: number): number {
  const session = uint32(required('sessionId', value.sessionId, value.session), 'sessionId');
  if (expected !== undefined && session !== expected) throw fail('Session binding mismatch', 'session-mismatch');
  return session;
}

function packetType(value: number): MatchPacketType {
  if (value === MATCH_PACKET_TYPES.input) return 'input';
  if (value === MATCH_PACKET_TYPES.snapshot) return 'snapshot';
  throw fail(`Unknown match packet type ${value}`, 'unknown-type');
}

function validateVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw fail('Invalid protocol version');
  if (value !== MATCH_PROTOCOL_VERSION) throw fail(`Unsupported protocol version ${value}`, 'unsupported-protocol');
  return value;
}

function validateHeaderFlags(type: MatchPacketType, flags: number): void {
  if (type === 'input') {
    if (flags !== 0) throw fail('Input packet flags must be zero');
    return;
  }
  if ((flags & ~ALLOWED_SNAPSHOT_FLAGS) !== 0
    || (flags & (SNAPSHOT_FLAG_FULL | SNAPSHOT_FLAG_DELTA)) === 0
    || (flags & SNAPSHOT_FLAG_FULL) !== 0 && (flags & SNAPSHOT_FLAG_DELTA) !== 0) {
    throw fail('Invalid snapshot flags');
  }
}

interface Envelope {
  readonly header: MatchPacketHeader;
  readonly payload: Uint8Array;
}

function encodeEnvelope(type: MatchPacketType, flags: number, session: number, sequence: number, tick: number,
  payload: Uint8Array, maxPayload: number): ArrayBuffer {
  validateVersion(MATCH_PROTOCOL_VERSION);
  validateHeaderFlags(type, flags);
  const packetSession = uint32(session, 'sessionId');
  const packetSequence = uint32(sequence, 'sequence');
  const packetTick = uint32(tick, 'tick');
  if (payload.byteLength > maxPayload || payload.byteLength > MAX_MATCH_PAYLOAD_BYTES) {
    throw fail(`Payload exceeds ${maxPayload} bytes`, 'payload-too-large');
  }
  if (MATCH_HEADER_BYTES + payload.byteLength > MAX_MATCH_PACKET_BYTES) {
    throw fail(`Packet exceeds ${MAX_MATCH_PACKET_BYTES} bytes`, 'payload-too-large');
  }
  const output = new ArrayBuffer(MATCH_HEADER_BYTES + payload.byteLength);
  const view = new DataView(output);
  view.setUint8(MATCH_HEADER_OFFSETS.version, MATCH_PROTOCOL_VERSION);
  view.setUint8(MATCH_HEADER_OFFSETS.type, MATCH_PACKET_TYPES[type]);
  view.setUint16(MATCH_HEADER_OFFSETS.flags, flags, true);
  view.setUint32(MATCH_HEADER_OFFSETS.session, packetSession, true);
  view.setUint32(MATCH_HEADER_OFFSETS.sequence, packetSequence, true);
  view.setUint32(MATCH_HEADER_OFFSETS.tick, packetTick, true);
  view.setUint16(MATCH_HEADER_OFFSETS.payloadLength, payload.byteLength, true);
  view.setUint16(MATCH_HEADER_OFFSETS.reserved, 0, true);
  view.setUint32(MATCH_HEADER_OFFSETS.reserved + 2, 0, true);
  new Uint8Array(output, MATCH_HEADER_BYTES).set(payload);
  return output;
}

function decodeEnvelope(value: BinaryLike): Envelope {
  const bytes = asBytes(value, 'packet');
  if (bytes.byteLength > MAX_MATCH_PACKET_BYTES) throw fail('Packet is too large', 'payload-too-large');
  if (bytes.byteLength < MATCH_HEADER_BYTES) throw fail('Packet is shorter than the 24-byte header', 'invalid-length');
  const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const version = validateVersion(view.getUint8(MATCH_HEADER_OFFSETS.version));
  const type = packetType(view.getUint8(MATCH_HEADER_OFFSETS.type));
  const flags = view.getUint16(MATCH_HEADER_OFFSETS.flags, true);
  validateHeaderFlags(type, flags);
  if (view.getUint16(MATCH_HEADER_OFFSETS.reserved, true) !== 0
    || view.getUint32(MATCH_HEADER_OFFSETS.reserved + 2, true) !== 0) {
    throw fail('Packet reserved header bytes must be zero');
  }
  const session = view.getUint32(MATCH_HEADER_OFFSETS.session, true);
  const sequence = view.getUint32(MATCH_HEADER_OFFSETS.sequence, true);
  const tick = view.getUint32(MATCH_HEADER_OFFSETS.tick, true);
  const payloadLength = view.getUint16(MATCH_HEADER_OFFSETS.payloadLength, true);
  if (MATCH_HEADER_BYTES + payloadLength !== bytes.byteLength) {
    throw fail(`Packet length does not match payloadLength ${payloadLength}`, 'invalid-length');
  }
  const header: MatchPacketHeader = Object.freeze({
    protocolVersion: version,
    type,
    flags,
    sessionId: session,
    session,
    sequence,
    tick,
    payloadLength,
  });
  return { header, payload: bytes.slice(MATCH_HEADER_BYTES) };
}

function quantize(value: number, min: number, max: number, label: string): number {
  finiteRange(value, label, min, max);
  return Math.max(-QUANTIZED_UNIT, Math.min(QUANTIZED_UNIT,
    Math.round(((value - min) / (max - min)) * QUANTIZED_UNIT * 2 - QUANTIZED_UNIT)));
}

function dequantize(value: number, min: number, max: number): number {
  return min + ((value + QUANTIZED_UNIT) / (2 * QUANTIZED_UNIT)) * (max - min);
}

function axis(value: unknown, label: string): number {
  return finiteRange(value, label, INPUT_AXIS_MIN, INPUT_AXIS_MAX);
}

function yaw(value: unknown, label = 'yaw', epsilon = 0): number {
  return finiteRange(value, label, INPUT_YAW_MIN - epsilon, INPUT_YAW_MAX + epsilon);
}

function pitch(value: unknown, label = 'pitch', epsilon = 0): number {
  return finiteRange(value, label, -INPUT_PITCH_LIMIT - epsilon, INPUT_PITCH_LIMIT + epsilon);
}

function mask(value: unknown, label: string, allowed: number): number {
  const result = uint16(value, label);
  if ((result & ~allowed) !== 0) throw fail(`${label} contains unsupported bits`);
  return result;
}

function slot(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1 || value > 4) {
    throw fail('selectedSlot must be null or an inventory slot from -1..4');
  }
  return value;
}

function encodeSlot(value: number | null): number {
  return slot(value) === null ? SELECTED_SLOT_NONE : slot(value)!;
}

function decodeSlot(value: number): number | null {
  if (value === SELECTED_SLOT_NONE) return null;
  return slot(value);
}

function shot(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = uint32(value, 'shotTick');
  if (result === SHOT_TICK_NONE) throw fail('shotTick uses a reserved value');
  return result;
}

function encodeShot(value: number | null): number {
  return value === null ? SHOT_TICK_NONE : shot(value)!;
}

function axes(value: readonly number[] | undefined, label: string): readonly [number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) throw fail(`${label} must contain exactly two values`);
  return [axis(value[0], `${label}[0]`), axis(value[1], `${label}[1]`)] as const;
}

function normalizeRecent(value: RecentInputFrameInput, index: number): RecentInputFrame {
  const seq = uint32(required(`recentFrames[${index}].inputSeq`, value.inputSeq, value.sequence), 'inputSeq');
  const tick = uint32(required(`recentFrames[${index}].clientTick`, value.clientTick, value.tick), 'clientTick');
  const providedAxes = axes(value.axes, `recentFrames[${index}].axes`);
  const moveX = axis(required(`recentFrames[${index}].moveX`, value.moveX, providedAxes?.[0]), 'moveX');
  const moveZ = axis(required(`recentFrames[${index}].moveZ`, value.moveZ, providedAxes?.[1]), 'moveZ');
  const currentYaw = yaw(value.yaw, `recentFrames[${index}].yaw`);
  const currentPitch = pitch(value.pitch, `recentFrames[${index}].pitch`);
  const heldMask = mask(value.heldMask, `recentFrames[${index}].heldMask`, INPUT_HELD_ALLOWED_MASK);
  const edgeMask = mask(value.edgeMask, `recentFrames[${index}].edgeMask`, INPUT_EDGE_ALLOWED_MASK);
  const selectedSlot = slot(value.selectedSlot);
  const shotTick = shot(value.shotTick);
  if (shotTick !== null && shotTick > tick) throw fail('Redundant shotTick is in the future', 'tick-future');
  return Object.freeze({
    inputSeq: seq,
    clientTick: tick,
    moveX,
    moveZ,
    axes: Object.freeze([moveX, moveZ]) as readonly [number, number],
    yaw: currentYaw,
    pitch: currentPitch,
    heldMask,
    edgeMask,
    selectedSlot,
    shotTick,
  });
}

function normalizeInput(value: InputFrameInput): InputFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Input frame must be an object');
  const session = sessionId(value);
  const inputSeq = uint32(required('inputSeq', value.inputSeq, value.sequence), 'inputSeq');
  const clientTick = uint32(required('clientTick', value.clientTick, value.tick), 'clientTick');
  const lastAckHostTick = uint32(required('lastAckHostTick', value.lastAckHostTick, value.ackHostTick), 'lastAckHostTick');
  const providedAxes = axes(value.axes, 'axes');
  const moveX = axis(required('moveX', value.moveX, providedAxes?.[0]), 'moveX');
  const moveZ = axis(required('moveZ', value.moveZ, providedAxes?.[1]), 'moveZ');
  const currentYaw = yaw(value.yaw);
  const currentPitch = pitch(value.pitch);
  const heldMask = mask(value.heldMask, 'heldMask', INPUT_HELD_ALLOWED_MASK);
  const edgeMask = mask(value.edgeMask, 'edgeMask', INPUT_EDGE_ALLOWED_MASK);
  const selectedSlot = slot(value.selectedSlot);
  const shotTick = shot(value.shotTick);
  if (shotTick !== null && shotTick > clientTick) throw fail('shotTick is in the future', 'tick-future');
  const recentFrames = value.recentFrames ?? [];
  if (!Array.isArray(recentFrames) || recentFrames.length > MAX_RECENT_INPUT_FRAMES) {
    throw fail(`recentFrames must contain at most ${MAX_RECENT_INPUT_FRAMES} frames`);
  }
  const recent = recentFrames.map((frame, index) => normalizeRecent(frame!, index));
  const seen = new Set<number>();
  for (const frame of recent) {
    if (seen.has(frame.inputSeq)) throw fail('recentFrames contain duplicate input sequences', 'sequence-duplicate');
    seen.add(frame.inputSeq);
    if (frame.inputSeq >= inputSeq) throw fail('recentFrames contain a future sequence', 'sequence-future');
    if (frame.clientTick > clientTick) throw fail('recentFrames contain a future tick', 'tick-future');
  }
  return Object.freeze({
    sessionId: session,
    session,
    inputSeq,
    sequence: inputSeq,
    clientTick,
    tick: clientTick,
    lastAckHostTick,
    moveX,
    moveZ,
    axes: Object.freeze([moveX, moveZ]) as readonly [number, number],
    yaw: currentYaw,
    pitch: currentPitch,
    heldMask,
    edgeMask,
    selectedSlot,
    shotTick,
    recentFrames: Object.freeze(recent),
  });
}

function writeQuantizedFrame(view: DataView, offset: number, frame: RecentInputFrame): void {
  view.setUint32(offset, frame.inputSeq, true);
  view.setUint32(offset + 4, frame.clientTick, true);
  view.setInt16(offset + 8, quantize(frame.moveX, INPUT_AXIS_MIN, INPUT_AXIS_MAX, 'moveX'), true);
  view.setInt16(offset + 10, quantize(frame.moveZ, INPUT_AXIS_MIN, INPUT_AXIS_MAX, 'moveZ'), true);
  view.setInt16(offset + 12, quantize(frame.yaw, INPUT_YAW_MIN, INPUT_YAW_MAX, 'yaw'), true);
  view.setInt16(offset + 14, quantize(frame.pitch, -INPUT_PITCH_LIMIT, INPUT_PITCH_LIMIT, 'pitch'), true);
  view.setUint16(offset + 16, frame.heldMask, true);
  view.setUint16(offset + 18, frame.edgeMask, true);
  view.setInt8(offset + 20, encodeSlot(frame.selectedSlot));
  view.setUint8(offset + 21, 0);
  view.setUint16(offset + 22, 0, true);
  view.setUint32(offset + 24, encodeShot(frame.shotTick), true);
}

function readQuantizedFrame(view: DataView, offset: number, index: number): RecentInputFrame {
  const inputSeq = view.getUint32(offset, true);
  const clientTick = view.getUint32(offset + 4, true);
  const moveX = dequantize(view.getInt16(offset + 8, true), INPUT_AXIS_MIN, INPUT_AXIS_MAX);
  const moveZ = dequantize(view.getInt16(offset + 10, true), INPUT_AXIS_MIN, INPUT_AXIS_MAX);
  const currentYaw = dequantize(view.getInt16(offset + 12, true), INPUT_YAW_MIN, INPUT_YAW_MAX);
  const currentPitch = dequantize(view.getInt16(offset + 14, true), -INPUT_PITCH_LIMIT, INPUT_PITCH_LIMIT);
  axis(moveX, `recentFrames[${index}].moveX`);
  axis(moveZ, `recentFrames[${index}].moveZ`);
  yaw(currentYaw, `recentFrames[${index}].yaw`, 1e-5);
  pitch(currentPitch, `recentFrames[${index}].pitch`, 1e-5);
  const heldMask = mask(view.getUint16(offset + 16, true), 'heldMask', INPUT_HELD_ALLOWED_MASK);
  const edgeMask = mask(view.getUint16(offset + 18, true), 'edgeMask', INPUT_EDGE_ALLOWED_MASK);
  if (view.getUint8(offset + 21) !== 0 || view.getUint16(offset + 22, true) !== 0) {
    throw fail('Input redundancy reserved bytes must be zero');
  }
  const selectedSlot = decodeSlot(view.getInt8(offset + 20));
  const encodedShot = view.getUint32(offset + 24, true);
  const shotTick = encodedShot === SHOT_TICK_NONE ? null : shot(encodedShot);
  if (shotTick !== null && shotTick > clientTick) throw fail('Redundant shotTick is in the future', 'tick-future');
  return Object.freeze({
    inputSeq,
    clientTick,
    moveX,
    moveZ,
    axes: Object.freeze([moveX, moveZ]) as readonly [number, number],
    yaw: currentYaw,
    pitch: currentPitch,
    heldMask,
    edgeMask,
    selectedSlot,
    shotTick,
  });
}

export function encodeInputPacket(value: InputFrameInput): ArrayBuffer {
  const frame = normalizeInput(value);
  const payload = new ArrayBuffer(INPUT_PAYLOAD_BYTES + frame.recentFrames.length * INPUT_REDUNDANT_FRAME_BYTES);
  const view = new DataView(payload);
  view.setUint32(0, frame.lastAckHostTick, true);
  view.setInt16(4, quantize(frame.moveX, INPUT_AXIS_MIN, INPUT_AXIS_MAX, 'moveX'), true);
  view.setInt16(6, quantize(frame.moveZ, INPUT_AXIS_MIN, INPUT_AXIS_MAX, 'moveZ'), true);
  view.setInt16(8, quantize(frame.yaw, INPUT_YAW_MIN, INPUT_YAW_MAX, 'yaw'), true);
  view.setInt16(10, quantize(frame.pitch, -INPUT_PITCH_LIMIT, INPUT_PITCH_LIMIT, 'pitch'), true);
  view.setUint16(12, frame.heldMask, true);
  view.setUint16(14, frame.edgeMask, true);
  view.setInt8(16, encodeSlot(frame.selectedSlot));
  view.setUint8(17, 0);
  view.setUint16(18, 0, true);
  view.setUint32(20, encodeShot(frame.shotTick), true);
  view.setUint8(24, frame.recentFrames.length);
  view.setUint8(25, 0);
  view.setUint16(26, 0, true);
  frame.recentFrames.forEach((recent, index) => writeQuantizedFrame(view,
    INPUT_PAYLOAD_BYTES + index * INPUT_REDUNDANT_FRAME_BYTES, recent));
  return encodeEnvelope('input', 0, frame.sessionId, frame.inputSeq, frame.clientTick,
    new Uint8Array(payload), MAX_INPUT_PAYLOAD_BYTES);
}

export function decodeInputPacket(value: BinaryLike): InputPacket {
  const envelope = decodeEnvelope(value);
  if (envelope.header.type !== 'input') throw fail('Packet is not an input packet');
  const payload = envelope.payload;
  if (payload.byteLength < INPUT_PAYLOAD_BYTES || payload.byteLength > MAX_INPUT_PAYLOAD_BYTES
    || (payload.byteLength - INPUT_PAYLOAD_BYTES) % INPUT_REDUNDANT_FRAME_BYTES !== 0) {
    throw fail('Input payload has an invalid exact length', 'invalid-length');
  }
  const view = new DataView(payload.buffer as ArrayBuffer, payload.byteOffset, payload.byteLength);
  const count = view.getUint8(24);
  if (count > MAX_RECENT_INPUT_FRAMES || payload.byteLength !== INPUT_PAYLOAD_BYTES + count * INPUT_REDUNDANT_FRAME_BYTES) {
    throw fail('Input redundancy count does not match payload length', 'invalid-length');
  }
  if (view.getUint8(17) !== 0 || view.getUint16(18, true) !== 0 || view.getUint8(25) !== 0 || view.getUint16(26, true) !== 0) {
    throw fail('Input reserved bytes must be zero');
  }
  const inputSeq = envelope.header.sequence;
  const clientTick = envelope.header.tick;
  const lastAckHostTick = view.getUint32(0, true);
  const moveX = dequantize(view.getInt16(4, true), INPUT_AXIS_MIN, INPUT_AXIS_MAX);
  const moveZ = dequantize(view.getInt16(6, true), INPUT_AXIS_MIN, INPUT_AXIS_MAX);
  const currentYaw = dequantize(view.getInt16(8, true), INPUT_YAW_MIN, INPUT_YAW_MAX);
  const currentPitch = dequantize(view.getInt16(10, true), -INPUT_PITCH_LIMIT, INPUT_PITCH_LIMIT);
  axis(moveX, 'moveX');
  axis(moveZ, 'moveZ');
  yaw(currentYaw, 'yaw', 1e-5);
  pitch(currentPitch, 'pitch', 1e-5);
  const heldMask = mask(view.getUint16(12, true), 'heldMask', INPUT_HELD_ALLOWED_MASK);
  const edgeMask = mask(view.getUint16(14, true), 'edgeMask', INPUT_EDGE_ALLOWED_MASK);
  const selectedSlot = decodeSlot(view.getInt8(16));
  const encodedShot = view.getUint32(20, true);
  const shotTick = encodedShot === SHOT_TICK_NONE ? null : shot(encodedShot);
  if (shotTick !== null && shotTick > clientTick) throw fail('shotTick is in the future', 'tick-future');
  const recentFrames = Array.from({ length: count }, (_, index) => readQuantizedFrame(view,
    INPUT_PAYLOAD_BYTES + index * INPUT_REDUNDANT_FRAME_BYTES, index));
  const seen = new Set<number>();
  for (const frame of recentFrames) {
    if (seen.has(frame.inputSeq)) throw fail('Input redundancy contains duplicate sequences', 'sequence-duplicate');
    seen.add(frame.inputSeq);
    if (frame.inputSeq >= inputSeq) throw fail('Input redundancy contains a future sequence', 'sequence-future');
    if (frame.clientTick > clientTick) throw fail('Input redundancy contains a future tick', 'tick-future');
  }
  const frame: InputFrame = Object.freeze({
    sessionId: envelope.header.sessionId,
    session: envelope.header.session,
    inputSeq,
    sequence: inputSeq,
    clientTick,
    tick: clientTick,
    lastAckHostTick,
    moveX,
    moveZ,
    axes: Object.freeze([moveX, moveZ]) as readonly [number, number],
    yaw: currentYaw,
    pitch: currentPitch,
    heldMask,
    edgeMask,
    selectedSlot,
    shotTick,
    recentFrames: Object.freeze(recentFrames),
  });
  return Object.freeze({
    ...frame,
    type: 'input' as const,
    protocolVersion: envelope.header.protocolVersion,
    flags: 0 as const,
    payloadLength: envelope.header.payloadLength,
    header: envelope.header,
  });
}

export function validateInputFrame(value: InputFrameInput): InputFrame {
  return normalizeInput(value);
}

function normalizeEntity(value: SnapshotEntityInput, index: number): SnapshotEntity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`Entity ${index} must be an object`);
  const id = uint16(value.id, `entities[${index}].id`);
  if (id === 0) throw fail(`entities[${index}].id must be non-zero`);
  const componentMask = uint16(value.mask, `entities[${index}].mask`);
  const payload = copyBytes(value.payload, `entities[${index}].payload`);
  if (payload.byteLength > MAX_ENTITY_PAYLOAD_BYTES) throw fail(`Entity ${index} payload is too large`, 'entity-too-large');
  if (ENTITY_RECORD_HEADER_BYTES + payload.byteLength > UINT16_MAX) throw fail(`Entity ${index} record is too large`, 'entity-too-large');
  return Object.freeze({ id, mask: componentMask, payload });
}

function fullDelta(value: SnapshotChunkInput): boolean {
  if (value.full === undefined && value.delta === undefined) return true;
  if (value.full !== undefined && typeof value.full !== 'boolean') throw fail('full must be boolean');
  if (value.delta !== undefined && typeof value.delta !== 'boolean') throw fail('delta must be boolean');
  if (value.full !== undefined && value.delta !== undefined && value.full === value.delta) throw fail('Snapshot must be full or delta');
  return value.full ?? !value.delta;
}

function normalizeSnapshot(value: SnapshotChunkInput): SnapshotChunkInput & {
  readonly sessionId: number;
  readonly full: boolean;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly totalEntities: number;
  readonly snapshotId: number;
  readonly entitiesNormalized: readonly SnapshotEntity[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Snapshot chunk must be an object');
  const session = sessionId(value);
  const hostTick = uint32(value.hostTick, 'hostTick');
  if (value.tick !== undefined && value.tick !== hostTick) throw fail('tick and hostTick aliases disagree');
  const sequence = uint32(value.sequence, 'sequence');
  const ackInputSeq = uint32(value.ackInputSeq, 'ackInputSeq');
  const revision = uint32(value.revision, 'revision');
  if (!Array.isArray(value.entities) || value.entities.length > MAX_SNAPSHOT_ENTITIES) {
    throw fail(`Snapshot must contain at most ${MAX_SNAPSHOT_ENTITIES} entities`);
  }
  const entitiesNormalized = value.entities.map((entity, index) => normalizeEntity(entity!, index));
  const ids = new Set<number>();
  for (const entity of entitiesNormalized) {
    if (ids.has(entity.id)) throw fail('Snapshot contains duplicate entity IDs');
    ids.add(entity.id);
  }
  const isFull = fullDelta(value);
  const snapshotId = uint32(value.snapshotId ?? sequence, 'snapshotId');
  const chunkIndex = uint16(alias('chunkIndex', value.chunkIndex, value.fragmentIndex) ?? 0, 'chunkIndex');
  const chunkCount = uint16(alias('chunkCount', value.chunkCount, value.fragmentCount) ?? 1, 'chunkCount');
  const totalEntities = uint16(value.totalEntities ?? entitiesNormalized.length, 'totalEntities');
  if (chunkCount < 1 || chunkCount > MAX_SNAPSHOT_CHUNKS || chunkIndex >= chunkCount
    || totalEntities > MAX_SNAPSHOT_ENTITIES || entitiesNormalized.length > totalEntities
    || chunkCount === 1 && totalEntities !== entitiesNormalized.length) {
    throw fail('Invalid snapshot chunk metadata', 'chunk-invalid');
  }
  return {
    ...value,
    sessionId: session,
    sequence,
    hostTick,
    ackInputSeq,
    revision,
    full: isFull,
    chunkIndex,
    chunkCount,
    totalEntities,
    snapshotId,
    entitiesNormalized,
  };
}

function encodeSnapshotPayload(value: ReturnType<typeof normalizeSnapshot>): Uint8Array {
  const records = value.entitiesNormalized.map((entity) => {
    const length = ENTITY_RECORD_HEADER_BYTES + entity.payload.byteLength;
    const record = new Uint8Array(length);
    const view = new DataView(record.buffer);
    view.setUint16(0, length, true);
    view.setUint16(2, entity.id, true);
    view.setUint16(4, entity.mask, true);
    view.setUint16(6, 0, true);
    record.set(entity.payload, ENTITY_RECORD_HEADER_BYTES);
    return record;
  });
  const length = SNAPSHOT_PAYLOAD_BYTES + records.reduce((total, record) => total + record.byteLength, 0);
  if (length > MAX_SNAPSHOT_PAYLOAD_BYTES) throw fail('Snapshot payload is too large', 'payload-too-large');
  const payload = new Uint8Array(length);
  const view = new DataView(payload.buffer);
  view.setUint32(0, value.snapshotId, true);
  view.setUint16(4, value.chunkIndex, true);
  view.setUint16(6, value.chunkCount, true);
  view.setUint16(8, value.totalEntities, true);
  view.setUint16(10, value.entitiesNormalized.length, true);
  view.setUint32(12, value.ackInputSeq, true);
  view.setUint32(16, value.hostTick, true);
  view.setUint32(20 - 0, value.revision, true);
  let offset = SNAPSHOT_PAYLOAD_BYTES;
  for (const record of records) {
    payload.set(record, offset);
    offset += record.byteLength;
  }
  return payload;
}

export function encodeSnapshotChunk(value: SnapshotChunkInput): ArrayBuffer {
  const normalized = normalizeSnapshot(value);
  const payload = encodeSnapshotPayload(normalized);
  const flags = (normalized.full ? SNAPSHOT_FLAG_FULL : SNAPSHOT_FLAG_DELTA)
    | (normalized.chunkCount > 1 ? SNAPSHOT_FLAG_CHUNKED : 0);
  return encodeEnvelope('snapshot', flags, normalized.sessionId, normalized.sequence, normalized.hostTick,
    payload, MAX_SNAPSHOT_PAYLOAD_BYTES);
}

export function decodeSnapshotChunk(value: BinaryLike): SnapshotChunk {
  const envelope = decodeEnvelope(value);
  if (envelope.header.type !== 'snapshot') throw fail('Packet is not a snapshot packet');
  const payload = envelope.payload;
  if (payload.byteLength < SNAPSHOT_PAYLOAD_BYTES || payload.byteLength > MAX_SNAPSHOT_PAYLOAD_BYTES) {
    throw fail('Snapshot payload is outside its bounds', 'invalid-length');
  }
  const view = new DataView(payload.buffer as ArrayBuffer, payload.byteOffset, payload.byteLength);
  const snapshotId = view.getUint32(0, true);
  const chunkIndex = view.getUint16(4, true);
  const chunkCount = view.getUint16(6, true);
  const totalEntities = view.getUint16(8, true);
  const entityCount = view.getUint16(10, true);
  const ackInputSeq = view.getUint32(12, true);
  const hostTick = view.getUint32(16, true);
  const revision = view.getUint32(20 - 0, true);
  if (hostTick !== envelope.header.tick) throw fail('Snapshot hostTick does not match envelope tick');
  if (chunkCount < 1 || chunkCount > MAX_SNAPSHOT_CHUNKS || chunkIndex >= chunkCount
    || totalEntities > MAX_SNAPSHOT_ENTITIES || entityCount > MAX_SNAPSHOT_ENTITIES || entityCount > totalEntities
    || chunkCount === 1 && totalEntities !== entityCount
    || ((envelope.header.flags & SNAPSHOT_FLAG_CHUNKED) !== 0) !== (chunkCount > 1)) {
    throw fail('Invalid snapshot chunk metadata', 'chunk-invalid');
  }
  const entities: SnapshotEntity[] = [];
  const ids = new Set<number>();
  let offset = SNAPSHOT_PAYLOAD_BYTES;
  for (let index = 0; index < entityCount; index += 1) {
    if (offset + ENTITY_RECORD_HEADER_BYTES > payload.byteLength) throw fail('Snapshot entity header is truncated', 'invalid-length');
    const recordLength = view.getUint16(offset, true);
    if (recordLength < ENTITY_RECORD_HEADER_BYTES || recordLength > ENTITY_RECORD_HEADER_BYTES + MAX_ENTITY_PAYLOAD_BYTES
      || offset + recordLength > payload.byteLength) throw fail('Snapshot entity record length is invalid', 'entity-too-large');
    const id = view.getUint16(offset + 2, true);
    const maskValue = view.getUint16(offset + 4, true);
    if (id === 0 || ids.has(id)) throw fail('Snapshot contains an invalid or duplicate entity ID');
    ids.add(id);
    if (view.getUint16(offset + 6, true) !== 0) throw fail('Snapshot entity reserved bytes must be zero');
    const payloadLength = recordLength - ENTITY_RECORD_HEADER_BYTES;
    const entityPayload = payload.slice(offset + ENTITY_RECORD_HEADER_BYTES, offset + recordLength);
    if (recordLength !== ENTITY_RECORD_HEADER_BYTES + payloadLength) throw fail('Snapshot record length mismatch', 'invalid-length');
    entities.push(Object.freeze({ id, mask: maskValue, payload: entityPayload }));
    offset += recordLength;
  }
  if (offset !== payload.byteLength) throw fail('Snapshot payload has trailing bytes', 'invalid-length');
  const full = (envelope.header.flags & SNAPSHOT_FLAG_FULL) !== 0;
  return Object.freeze({
    sessionId: envelope.header.sessionId,
    session: envelope.header.session,
    type: 'snapshot' as const,
    protocolVersion: envelope.header.protocolVersion,
    flags: envelope.header.flags,
    sequence: envelope.header.sequence,
    tick: envelope.header.tick,
    hostTick,
    ackInputSeq,
    revision,
    full,
    delta: !full,
    snapshotId,
    chunkIndex,
    fragmentIndex: chunkIndex,
    chunkCount,
    fragmentCount: chunkCount,
    totalEntities,
    entities: Object.freeze(entities),
    payloadLength: envelope.header.payloadLength,
    header: envelope.header,
  });
}

export function splitSnapshot(value: SnapshotChunkInput, maxPacketBytes = MAX_MATCH_PACKET_BYTES): SnapshotChunkInput[] {
  if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < MATCH_HEADER_BYTES + SNAPSHOT_PAYLOAD_BYTES
    || maxPacketBytes > MAX_MATCH_PACKET_BYTES) {
    throw fail('maxPacketBytes is outside the packet bounds');
  }
  const normalized = normalizeSnapshot({ ...value, chunkIndex: 0, chunkCount: 1, totalEntities: value.entities.length });
  const capacity = maxPacketBytes - MATCH_HEADER_BYTES - SNAPSHOT_PAYLOAD_BYTES;
  const groups: SnapshotEntity[] = [];
  const fragments: SnapshotEntity[][] = [];
  let current: SnapshotEntity[] = [];
  let used = 0;
  for (const entity of normalized.entitiesNormalized) {
    const bytes = ENTITY_RECORD_HEADER_BYTES + entity.payload.byteLength;
    if (bytes > capacity) throw fail('Entity cannot fit in the requested packet size', 'entity-too-large');
    if (current.length > 0 && used + bytes > capacity) {
      fragments.push(current);
      current = [];
      used = 0;
    }
    current.push(entity);
    used += bytes;
  }
  if (current.length > 0 || fragments.length === 0) fragments.push(current);
  if (fragments.length > MAX_SNAPSHOT_CHUNKS) throw fail('Snapshot requires too many chunks', 'chunk-invalid');
  void groups;
  return fragments.map((entities, index) => ({
    ...value,
    sessionId: normalized.sessionId,
    sequence: normalized.sequence + index <= UINT32_MAX ? normalized.sequence + index : (() => {
      throw fail('Snapshot chunk sequence overflows uint32', 'sequence-future');
    })(),
    hostTick: normalized.hostTick,
    ackInputSeq: normalized.ackInputSeq,
    revision: normalized.revision,
    full: normalized.full,
    delta: !normalized.full,
    snapshotId: normalized.snapshotId,
    chunkIndex: index,
    fragmentIndex: index,
    chunkCount: fragments.length,
    fragmentCount: fragments.length,
    totalEntities: normalized.entitiesNormalized.length,
    entities,
  }));
}

export function encodeSnapshotChunks(value: SnapshotChunkInput, maxPacketBytes = MAX_MATCH_PACKET_BYTES): ArrayBuffer[] {
  return splitSnapshot(value, maxPacketBytes).map((chunk) => encodeSnapshotChunk(chunk));
}

export class SnapshotReassembler {
  private readonly pending = new Map<number, {
    readonly first: SnapshotChunk;
    readonly chunks: Map<number, SnapshotChunk>;
  }>();
  private readonly maxPending: number;
  private latestDeltaRevision: number | null = null;
  private latestCompletedFullRevision: number | null = null;

  constructor(maxPending = MAX_SNAPSHOT_CHUNKS) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > MAX_SNAPSHOT_CHUNKS) {
      throw new RangeError(`maxPending must be between 1 and ${MAX_SNAPSHOT_CHUNKS}`);
    }
    this.maxPending = maxPending;
  }

  add(value: BinaryLike | SnapshotChunk): ReassembledSnapshot | null {
    const chunk = isSnapshotChunk(value) ? value : decodeSnapshotChunk(value);
    if (this.latestCompletedFullRevision !== null && chunk.revision <= this.latestCompletedFullRevision) return null;
    if (chunk.full) {
      // A delta can overtake a full keyframe on separate DataChannels. Keep
      // pending full snapshots admissible until a newer full actually lands.
      this.evictOlderPendingDeltas(chunk.revision);
    } else {
      if (this.latestDeltaRevision !== null && chunk.revision < this.latestDeltaRevision) return null;
      if (this.latestDeltaRevision === null || chunk.revision > this.latestDeltaRevision) {
        this.latestDeltaRevision = chunk.revision;
        this.evictOlderPendingDeltas(chunk.revision);
      }
    }
    if (chunk.chunkCount === 1) {
      const result = toReassembled(chunk);
      if (chunk.full) this.markFullCompleted(chunk.revision);
      return result;
    }
    let state = this.pending.get(chunk.snapshotId);
    if (!state) {
      if (this.pending.size >= this.maxPending) throw fail('Too many snapshots awaiting reassembly', 'payload-too-large');
      state = { first: chunk, chunks: new Map() };
      this.pending.set(chunk.snapshotId, state);
    } else if (state.first.sessionId !== chunk.sessionId || state.first.chunkCount !== chunk.chunkCount
      || state.first.totalEntities !== chunk.totalEntities || state.first.hostTick !== chunk.hostTick
      || state.first.ackInputSeq !== chunk.ackInputSeq || state.first.revision !== chunk.revision
      || state.first.full !== chunk.full) {
      this.pending.delete(chunk.snapshotId);
      throw fail('Snapshot chunks disagree on metadata', 'chunk-invalid');
    }
    if (state.chunks.has(chunk.chunkIndex)) return null;
    const seenIds = new Set<number>();
    for (const existing of state.chunks.values()) {
      for (const entity of existing.entities) seenIds.add(entity.id);
    }
    for (const entity of chunk.entities) {
      if (seenIds.has(entity.id)) {
        this.pending.delete(chunk.snapshotId);
        throw fail('Snapshot chunks repeat an entity ID', 'chunk-invalid');
      }
    }
    state.chunks.set(chunk.chunkIndex, chunk);
    if (state.chunks.size !== chunk.chunkCount) return null;
    const chunks = [...state.chunks.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const entities = chunks.flatMap((part) => part.entities);
    this.pending.delete(chunk.snapshotId);
    if (entities.length !== chunk.totalEntities) throw fail('Snapshot reassembly entity count mismatch', 'chunk-invalid');
    const result = Object.freeze({
      sessionId: state.first.sessionId,
      session: state.first.session,
      sequence: state.first.sequence,
      hostTick: state.first.hostTick,
      tick: state.first.tick,
      ackInputSeq: state.first.ackInputSeq,
      revision: state.first.revision,
      full: state.first.full,
      delta: state.first.delta,
      snapshotId: state.first.snapshotId,
      entities: Object.freeze(entities),
    });
    if (state.first.full) this.markFullCompleted(state.first.revision);
    return result;
  }

  push(value: BinaryLike | SnapshotChunk): ReassembledSnapshot | null { return this.add(value); }
  clear(): void {
    this.pending.clear();
    this.latestDeltaRevision = null;
    this.latestCompletedFullRevision = null;
  }

  private evictOlderPendingDeltas(revision: number): void {
    for (const [snapshotId, state] of this.pending) {
      if (!state.first.full && state.first.revision < revision) this.pending.delete(snapshotId);
    }
  }

  private markFullCompleted(revision: number): void {
    if (this.latestCompletedFullRevision !== null && revision <= this.latestCompletedFullRevision) return;
    this.latestCompletedFullRevision = revision;
    for (const [snapshotId, state] of this.pending) {
      if (state.first.revision <= revision) this.pending.delete(snapshotId);
    }
  }
}

function isSnapshotChunk(value: BinaryLike | SnapshotChunk): value is SnapshotChunk {
  return typeof value === 'object' && value !== null && 'type' in value
    && (value as { type?: unknown }).type === 'snapshot';
}

function toReassembled(chunk: SnapshotChunk): ReassembledSnapshot {
  return Object.freeze({
    sessionId: chunk.sessionId,
    session: chunk.session,
    sequence: chunk.sequence,
    hostTick: chunk.hostTick,
    tick: chunk.tick,
    ackInputSeq: chunk.ackInputSeq,
    revision: chunk.revision,
    full: chunk.full,
    delta: chunk.delta,
    snapshotId: chunk.snapshotId,
    entities: chunk.entities,
  });
}

export function decodeMatchPacket(value: BinaryLike): DecodedMatchPacket {
  const header = decodeEnvelope(value).header;
  return header.type === 'input' ? decodeInputPacket(value) : decodeSnapshotChunk(value);
}

export class SequenceWindow {
  private highest: number | null = null;
  private readonly seen = new Set<number>();

  constructor(readonly window = 128, readonly maxFuture = 64) {
    if (!Number.isSafeInteger(window) || window < 1 || !Number.isSafeInteger(maxFuture) || maxFuture < 0) {
      throw new RangeError('Sequence windows must be non-negative safe integers');
    }
  }

  get latest(): number | null { return this.highest; }

  check(value: number): void {
    const sequence = uint32(value, 'sequence');
    if (this.seen.has(sequence)) throw fail(`Duplicate sequence ${sequence}`, 'sequence-duplicate');
    if (this.highest !== null) {
      if (sequence > this.highest && sequence - this.highest > this.maxFuture) throw fail('Future sequence', 'sequence-future');
      if (sequence < this.highest && this.highest - sequence > this.window) throw fail('Stale sequence', 'sequence-stale');
    }
  }

  accept(value: number): void {
    const sequence = uint32(value, 'sequence');
    this.check(sequence);
    if (this.highest === null || sequence > this.highest) this.highest = sequence;
    this.seen.add(sequence);
    if (this.highest !== null) {
      for (const old of this.seen) if (this.highest - old > this.window) this.seen.delete(old);
    }
  }

  reset(): void { this.highest = null; this.seen.clear(); }
}

class TokenBucket {
  private tokens: number;
  private lastMs: number | null = null;

  constructor(readonly rate: number, readonly capacity: number) {
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError('Rate and capacity must be positive');
    }
    this.tokens = capacity;
  }

  allow(nowMs: number): boolean {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError('nowMs must be non-negative');
    if (this.lastMs !== null) this.tokens = Math.min(this.capacity,
      this.tokens + Math.max(0, nowMs - this.lastMs) / 1000 * this.rate);
    this.lastMs = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  reset(): void { this.tokens = this.capacity; this.lastMs = null; }
}

export interface InputPacketValidatorOptions {
  readonly expectedSessionId?: number;
  readonly expectedSession?: number;
  readonly sequenceWindow?: number;
  readonly maxFutureSequence?: number;
  readonly currentHostTick?: number;
  readonly maxFutureTicks?: number;
  readonly maxPastTicks?: number;
  readonly maxShotRewindTicks?: number;
  readonly maxInputsPerSecond?: number;
  readonly inputBurst?: number;
  readonly now?: () => number;
}

export interface InputPacketValidationContext {
  readonly currentHostTick?: number;
  readonly nowMs?: number;
}

/**
 * Map a client-local shot timestamp onto the host's bounded history.
 *
 * The last acknowledged host snapshot travelled host -> guest, while this
 * input travelled guest -> host. Assuming a symmetric direct route, half of
 * that round-trip span is the closest safe estimate of the shot's host tick.
 * Older redundant input frames subtract their client-local age as well.
 */
export function mapClientShotTickToHost(
  currentHostTick: number,
  lastAcknowledgedHostTick: number,
  packetClientTick: number,
  shotClientTick: number,
  maxRewindTicks = 15,
): number {
  const current = uint32(currentHostTick, 'currentHostTick');
  const acknowledged = uint32(lastAcknowledgedHostTick, 'lastAckHostTick');
  const clientTick = uint32(packetClientTick, 'clientTick');
  const shotTick = uint32(shotClientTick, 'shotTick');
  if (!Number.isSafeInteger(maxRewindTicks) || maxRewindTicks < 0) {
    throw new RangeError('maxRewindTicks must be a non-negative safe integer');
  }

  const acknowledgedAge = (current - acknowledged) >>> 0;
  if (acknowledgedAge >= UINT32_HALF_RANGE) {
    throw fail('Input ack tick is in the future', 'tick-future');
  }
  const localShotAge = (clientTick - shotTick) >>> 0;
  if (localShotAge >= UINT32_HALF_RANGE) {
    throw fail('Shot tick is in the future', 'tick-future');
  }
  const rewindTicks = Math.ceil(acknowledgedAge / 2) + localShotAge;
  if (rewindTicks > maxRewindTicks) {
    throw fail('Shot tick exceeds the rewind window', 'tick-stale');
  }
  return (current - rewindTicks) >>> 0;
}

/** Stateful inbound input gate: structural codec + session + replay + tick + rate. */
export class InputPacketValidator {
  private readonly expectedSession: number | undefined;
  private readonly currentHostTick: number | undefined;
  private readonly maxFutureTicks: number;
  private readonly maxPastTicks: number;
  private readonly maxShotRewindTicks: number;
  private readonly sequence: SequenceWindow;
  private readonly clientTicks: SequenceWindow;
  private readonly rate: TokenBucket;
  private readonly now: () => number;

  constructor(options: InputPacketValidatorOptions = {}) {
    if (options.expectedSessionId !== undefined && options.expectedSession !== undefined
      && options.expectedSessionId !== options.expectedSession) throw fail('Expected session aliases disagree', 'session-mismatch');
    this.expectedSession = options.expectedSessionId ?? options.expectedSession;
    if (this.expectedSession !== undefined) uint32(this.expectedSession, 'expectedSession');
    this.currentHostTick = options.currentHostTick;
    if (this.currentHostTick !== undefined) uint32(this.currentHostTick, 'currentHostTick');
    this.maxFutureTicks = options.maxFutureTicks ?? 6;
    this.maxPastTicks = options.maxPastTicks ?? 120;
    this.maxShotRewindTicks = options.maxShotRewindTicks ?? 15;
    if (!Number.isSafeInteger(this.maxFutureTicks) || this.maxFutureTicks < 0
      || !Number.isSafeInteger(this.maxPastTicks) || this.maxPastTicks < 0
      || !Number.isSafeInteger(this.maxShotRewindTicks) || this.maxShotRewindTicks < 0) {
      throw new RangeError('Tick windows are invalid');
    }
    this.sequence = new SequenceWindow(options.sequenceWindow ?? 128, options.maxFutureSequence ?? 64);
    this.clientTicks = new SequenceWindow(this.maxPastTicks, this.maxFutureTicks);
    const rate = options.maxInputsPerSecond ?? 120;
    this.rate = new TokenBucket(rate, options.inputBurst ?? rate);
    this.now = options.now ?? (() => Date.now());
  }

  validate(value: BinaryLike, context: InputPacketValidationContext = {}): InputPacket {
    const packet = decodeInputPacket(value);
    if (this.expectedSession !== undefined && packet.sessionId !== this.expectedSession) throw fail('Session binding mismatch', 'session-mismatch');
    const current = context.currentHostTick ?? this.currentHostTick;
    this.sequence.check(packet.inputSeq);
    this.clientTicks.check(packet.clientTick);
    for (const frame of [packet, ...packet.recentFrames]) {
      const frameAge = (packet.clientTick - frame.clientTick) >>> 0;
      if (frameAge >= UINT32_HALF_RANGE) throw fail('Input frame tick is in the future', 'tick-future');
      if (frameAge > this.maxPastTicks) throw fail('Input frame tick is stale', 'tick-stale');
    }
    if (current !== undefined) {
      uint32(current, 'currentHostTick');
      const acknowledgedAge = (current - packet.lastAckHostTick) >>> 0;
      if (acknowledgedAge >= UINT32_HALF_RANGE) throw fail('Input ack tick is in the future', 'tick-future');
      for (const frame of [packet, ...packet.recentFrames]) {
        if (frame.shotTick === null) continue;
        mapClientShotTickToHost(
          current,
          packet.lastAckHostTick,
          packet.clientTick,
          frame.shotTick,
          this.maxShotRewindTicks,
        );
      }
    }
    if (!this.rate.allow(context.nowMs ?? this.now())) throw fail('Input packet rate limit exceeded', 'rate-limited');
    this.sequence.accept(packet.inputSeq);
    this.clientTicks.accept(packet.clientTick);
    return packet;
  }

  reset(): void { this.sequence.reset(); this.clientTicks.reset(); this.rate.reset(); }
}

export const MatchProtocolValidator = InputPacketValidator;

export function validateInputPacket(value: BinaryLike, options: InputPacketValidatorOptions = {},
  context: InputPacketValidationContext = {}): InputPacket {
  return new InputPacketValidator(options).validate(value, context);
}

export const encodeInput = encodeInputPacket;
export const decodeInput = decodeInputPacket;
export const encodeSnapshot = encodeSnapshotChunk;
export const decodeSnapshot = decodeSnapshotChunk;
export const encodeSnapshotPacket = encodeSnapshotChunk;
export const decodeSnapshotPacket = decodeSnapshotChunk;
export const encodeSnapshotPacketChunks = encodeSnapshotChunks;
