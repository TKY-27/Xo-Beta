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
  mapClientShotTickToHost,
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
    expect(validator.validate(encodeInputPacket(input({
      inputSeq: 11, clientTick: 101, shotTick: 101, recentFrames: [],
    })), { nowMs: now })).toBeDefined();
    expect(() => validator.validate(encodeInputPacket(input({ inputSeq: 12, clientTick: 104, shotTick: 104, recentFrames: [] })), { nowMs: now }))
      .toThrow(/future|rate/i);
    expect(() => validator.validate(encodeInputPacket(input({ inputSeq: 12, clientTick: 95, shotTick: 95, recentFrames: [] })), { nowMs: now }))
      .toThrow(/stale|rate/i);
    expect(() => validator.validate(encodeInputPacket({ ...input(), sessionId: 99 }), { nowMs: now }))
      .toThrow(/session/i);
  });

  it('applies client-clock bounds to redundant input frames', () => {
    const validator = new InputPacketValidator({
      expectedSessionId: session,
      currentHostTick: 100,
      maxFutureTicks: 2,
      maxPastTicks: 4,
      maxInputsPerSecond: 100,
      inputBurst: 100,
    });
    const staleRedundant = input({
      inputSeq: 11,
      clientTick: 100,
      shotTick: null,
      recentFrames: [{
        ...input().recentFrames![0]!,
        inputSeq: 10,
        clientTick: 95,
        shotTick: null,
      }],
    });
    expect(() => validator.validate(encodeInputPacket(staleRedundant))).toThrow(/input frame tick is stale/i);
  });

  it('maps client-local shot timestamps onto bounded host history', () => {
    expect(mapClientShotTickToHost(100, 90, 500, 500, 15)).toBe(95);
    expect(mapClientShotTickToHost(100, 90, 500, 498, 15)).toBe(93);
    expect(mapClientShotTickToHost(2, 0xffff_fffe, 12, 12, 15)).toBe(0);
    expect(() => mapClientShotTickToHost(100, 101, 500, 500, 15)).toThrow(/ack tick.*future/i);
    expect(() => mapClientShotTickToHost(100, 90, 500, 501, 15)).toThrow(/shot tick.*future/i);
  });

  it('keeps client and host tick origins distinct while bounding client clock advances', () => {
    const validator = new InputPacketValidator({
      expectedSessionId: session,
      currentHostTick: 5_000,
      maxFutureTicks: 2,
      maxPastTicks: 4,
      maxShotRewindTicks: 15,
      maxInputsPerSecond: 100,
      inputBurst: 100,
    });
    expect(validator.validate(encodeInputPacket(input({
      inputSeq: 1,
      clientTick: 1,
      lastAckHostTick: 4_990,
      shotTick: 1,
      recentFrames: [],
    })))).toBeDefined();
    expect(validator.validate(encodeInputPacket(input({
      inputSeq: 2,
      clientTick: 3,
      lastAckHostTick: 4_992,
      shotTick: null,
      recentFrames: [],
    })))).toBeDefined();
    expect(() => validator.validate(encodeInputPacket(input({
      inputSeq: 3,
      clientTick: 6,
      lastAckHostTick: 4_994,
      shotTick: null,
      recentFrames: [],
    })))).toThrow(/future/i);
  });

  it('rejects future and excessive projectile rewind ticks before host simulation', () => {
    const validator = new InputPacketValidator({
      expectedSessionId: session,
      currentHostTick: 100,
      maxFutureTicks: 2,
      maxPastTicks: 120,
      maxShotRewindTicks: 15,
    });
    expect(() => encodeInputPacket(input({
      inputSeq: 11, clientTick: 100, shotTick: 101, recentFrames: [],
    }))).toThrow(/shotTick.*future/i);
    expect(validator.validate(encodeInputPacket(input({
      inputSeq: 11, clientTick: 101, shotTick: 101, recentFrames: [],
    })))).toBeDefined();
    expect(() => validator.validate(encodeInputPacket(input({
      inputSeq: 12, clientTick: 100, lastAckHostTick: 68, shotTick: 100, recentFrames: [],
    })))).toThrow(/rewind window/i);
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

  it('evicts incomplete older deltas while retaining an older full keyframe', () => {
    const reassembler = new SnapshotReassembler(2);
    const revisionOne = encodeSnapshotChunks(snapshot({
      sequence: 1,
      snapshotId: 1,
      revision: 1,
      hostTick: 201,
    }), 60);
    const revisionTwo = encodeSnapshotChunks(snapshot({
      sequence: 2,
      snapshotId: 2,
      revision: 2,
      hostTick: 202,
      full: false,
      delta: true,
    }), 60);
    expect(revisionOne).toHaveLength(2);
    expect(revisionTwo).toHaveLength(2);

    expect(reassembler.add(revisionOne[0]!)).toBeNull();
    expect(reassembler.add(revisionTwo[0]!)).toBeNull();
    expect(reassembler.add(revisionOne[1]!)).toMatchObject({ revision: 1, snapshotId: 1, full: true });
    expect(reassembler.add(revisionTwo[1]!)).toMatchObject({ revision: 2, snapshotId: 2, full: false });

    for (let revision = 3; revision <= 12; revision += 1) {
      const packets = encodeSnapshotChunks(snapshot({
        sequence: revision,
        snapshotId: revision,
        revision,
        hostTick: 200 + revision,
        full: false,
        delta: true,
      }), 60);
      expect(reassembler.add(packets[0]!)).toBeNull();
    }
  });

  it('bounds distinct incomplete snapshots that reuse one revision', () => {
    const reassembler = new SnapshotReassembler(2);
    for (const snapshotId of [1, 2]) {
      const packets = encodeSnapshotChunks(snapshot({
        sequence: snapshotId,
        snapshotId,
        revision: 7,
        hostTick: 207,
      }), 60);
      expect(packets).toHaveLength(2);
      expect(reassembler.add(packets[0]!)).toBeNull();
    }
    const abusive = encodeSnapshotChunks(snapshot({
      sequence: 3,
      snapshotId: 3,
      revision: 7,
      hostTick: 207,
    }), 60);
    expect(() => reassembler.add(abusive[0]!)).toThrow(/too many snapshots/i);
  });
});
