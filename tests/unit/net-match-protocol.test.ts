import { describe, expect, it } from 'vitest';
import {
  INPUT_EDGE_MASK,
  INPUT_HELD_MASK,
  INPUT_PITCH_LIMIT,
  MATCH_HEADER_BYTES,
  MATCH_HEADER_OFFSETS,
  MAX_RECENT_INPUT_FRAMES,
  MatchProtocolError,
  InputPacketValidator,
  SnapshotReassembler,
  decodeInputPacket,
  decodeMatchPacket,
  decodeSnapshotChunk,
  encodeInputPacket,
  encodeSnapshotChunk,
  encodeSnapshotChunks,
  splitSnapshot,
  type InputFrameInput,
  type SnapshotChunkInput,
} from '../../src/net/matchProtocol';

const session = 0x1020_3040;

function input(overrides: Partial<InputFrameInput> = {}): InputFrameInput {
  return {
    sessionId: session,
    inputSeq: 10,
    clientTick: 100,
    lastAckHostTick: 98,
    moveX: 0.25,
    moveZ: -0.5,
    yaw: 1.25,
    pitch: -0.2,
    heldMask: INPUT_HELD_MASK.fire | INPUT_HELD_MASK.ads,
    edgeMask: INPUT_EDGE_MASK.fire,
    selectedSlot: 2,
    shotTick: 100,
    recentFrames: [{
      inputSeq: 9,
      clientTick: 99,
      moveX: 0,
      moveZ: -1,
      yaw: 1.1,
      pitch: -0.2,
      heldMask: INPUT_HELD_MASK.fire,
      edgeMask: 0,
      selectedSlot: 2,
      shotTick: null,
    }],
    ...overrides,
  };
}

function snapshot(overrides: Partial<SnapshotChunkInput> = {}): SnapshotChunkInput {
  return {
    sessionId: session,
    sequence: 40,
    hostTick: 200,
    ackInputSeq: 10,
    revision: 7,
    full: true,
    entities: [
      { id: 1, mask: 1, payload: new Uint8Array([1, 2, 3]) },
      { id: 2, mask: 2, payload: new Uint8Array([4, 5]) },
    ],
    ...overrides,
  };
}

describe('Phase 4 compact binary match protocol', () => {
  it('uses a fixed common header and round-trips quantized input with shot tick', () => {
    const encoded = encodeInputPacket(input());
    expect(encoded.byteLength).toBe(MATCH_HEADER_BYTES + 28 + 28);
    const header = new DataView(encoded);
    expect(header.getUint8(MATCH_HEADER_OFFSETS.version)).toBe(1);
    expect(header.getUint8(MATCH_HEADER_OFFSETS.type)).toBe(1);
    expect(header.getUint32(MATCH_HEADER_OFFSETS.session, true)).toBe(session);
    expect(header.getUint32(MATCH_HEADER_OFFSETS.sequence, true)).toBe(10);
    expect(header.getUint32(MATCH_HEADER_OFFSETS.tick, true)).toBe(100);
    expect(header.getUint16(MATCH_HEADER_OFFSETS.payloadLength, true)).toBe(56);
    expect(new TextDecoder().decode(encoded)).not.toContain('inputSeq');

    const decoded = decodeInputPacket(encoded);
    expect(decoded).toMatchObject({
      type: 'input',
      sessionId: session,
      inputSeq: 10,
      clientTick: 100,
      lastAckHostTick: 98,
      selectedSlot: 2,
      shotTick: 100,
    });
    expect(decoded.moveX).toBeCloseTo(0.25, 3);
    expect(decoded.moveZ).toBeCloseTo(-0.5, 3);
    expect(decoded.recentFrames[0]?.inputSeq).toBe(9);
  });

  it('strictly bounds input values, masks, redundancy and exact lengths', () => {
    expect(() => encodeInputPacket(input({ moveX: 2 }))).toThrow(/moveX|finite|within/i);
    expect(() => encodeInputPacket(input({ pitch: INPUT_PITCH_LIMIT + 0.001 }))).toThrow(/pitch|finite/i);
    expect(() => encodeInputPacket(input({ heldMask: 0x8000 }))).toThrow(/heldMask|unsupported/i);
    expect(() => encodeInputPacket(input({ recentFrames: new Array(MAX_RECENT_INPUT_FRAMES + 1).fill({}) }))).toThrow(/recent/i);
    const truncated = new Uint8Array(encodeInputPacket(input())).slice(0, -1);
    expect(() => decodeInputPacket(truncated)).toThrowError(MatchProtocolError);
    expect(() => decodeInputPacket(truncated)).toThrow(/length/i);
    const wrongPayloadLength = new Uint8Array(encodeInputPacket(input()));
    new DataView(wrongPayloadLength.buffer).setUint16(MATCH_HEADER_OFFSETS.payloadLength, 1, true);
    expect(() => decodeInputPacket(wrongPayloadLength)).toThrow(/length/i);
  });

  it('reuses a stateful validator for session, stale/duplicate/future sequence and tick/rate gates', () => {
    let now = 0;
    const validator = new InputPacketValidator({
      expectedSessionId: session,
      sequenceWindow: 2,
      maxFutureSequence: 1,
      currentHostTick: 100,
      maxFutureTicks: 2,
      maxPastTicks: 4,
      maxInputsPerSecond: 2,
      inputBurst: 2,
      now: () => now,
    });
    expect(validator.validate(encodeInputPacket(input()), { nowMs: now })).toBeDefined();
    expect(() => validator.validate(encodeInputPacket(input()), { nowMs: now })).toThrow(/duplicate/i);
    expect(() => validator.validate(encodeInputPacket(input({ inputSeq: 12 })), { nowMs: now }))
      .toThrow(/future sequence|rate/i);
    now = 1_000;
    expect(validator.validate(encodeInputPacket(input({ inputSeq: 11 })), { nowMs: now })).toBeDefined();
    expect(() => validator.validate(encodeInputPacket(input({ inputSeq: 13, clientTick: 104, shotTick: 104, recentFrames: [] })), { nowMs: now }))
      .toThrow(/future|rate/i);
    expect(() => validator.validate(encodeInputPacket(input({ inputSeq: 13, clientTick: 95, shotTick: 95, recentFrames: [] })), { nowMs: now }))
      .toThrow(/stale|rate/i);
    expect(() => validator.validate(encodeInputPacket({ ...input(), sessionId: 99 }), { nowMs: now }))
      .toThrow(/session/i);
  });

  it('round-trips generic entity records and full/delta chunk metadata', () => {
    const full = decodeSnapshotChunk(encodeSnapshotChunk(snapshot()));
    expect(full).toMatchObject({
      type: 'snapshot',
      sessionId: session,
      full: true,
      delta: false,
      sequence: 40,
      hostTick: 200,
      ackInputSeq: 10,
      revision: 7,
      chunkIndex: 0,
      chunkCount: 1,
      totalEntities: 2,
    });
    expect([...full.entities[0]!.payload]).toEqual([1, 2, 3]);
    const delta = decodeSnapshotChunk(encodeSnapshotChunk(snapshot({
      sequence: 41,
      hostTick: 201,
      revision: 8,
      full: false,
      delta: true,
    })));
    expect(delta.delta).toBe(true);
    expect(decodeMatchPacket(encodeSnapshotChunk(snapshot()))).toMatchObject({ type: 'snapshot', revision: 7 });
  });

  it('splits only at entity boundaries and reassembles safely in any order', () => {
    const frame = snapshot({
      entities: Array.from({ length: 8 }, (_, index) => ({
        id: index + 1,
        mask: 1,
        payload: new Uint8Array([index, index + 1, index + 2]),
      })),
    });
    const chunks = splitSnapshot(frame, 70);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.chunkCount === chunks.length)).toBe(true);
    const packets = encodeSnapshotChunks(frame, 70);
    const reassembler = new SnapshotReassembler();
    let result = null;
    for (const packet of [...packets].reverse()) result = reassembler.add(packet) ?? result;
    expect(result).toMatchObject({ snapshotId: 40, revision: 7, entities: expect.any(Array) });
    expect(result?.entities.map((entity) => entity.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => splitSnapshot(frame, 50)).toThrow(/entity|packet/i);
  });
});
