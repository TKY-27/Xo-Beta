import { describe, expect, it } from 'vitest';
import {
  decodeCrockfordBase32,
} from '../../src/net/invite';
import {
  decodeMatchStartControl,
} from '../../src/net/matchStart';
import {
  decodeAuthoritativeEventPacket,
  decodeReliablePacket,
  decodeRemoteInputEnvelope,
  MatchStateDecoder,
} from '../../src/net/matchStateCodec';
import {
  decodeInputPacket,
  decodeMatchPacket,
  decodeSnapshotChunk,
  InputPacketValidator,
} from '../../src/net/matchProtocol';
import {
  PeerRateLimiter,
  ProtocolSessionGuard,
  ReplayNonceGuard,
  decodeProtocolMessage,
} from '../../src/net/protocol';

/** Small deterministic corpus: repeatable in CI and independent of RNG state. */
function fuzzBytes(seed: number): Uint8Array {
  let state = seed >>> 0;
  const length = seed % 97 === 0
    ? 16 * 1024 + (seed % 257)
    : seed % 19 === 0
      ? seed % 65
      : seed % 1_024;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function fuzzText(seed: number): string {
  const bytes = fuzzBytes(seed);
  return String.fromCharCode(...Array.from(bytes.slice(0, Math.min(bytes.length, 256)), (value) => value));
}

function expectDecoderToFailClosed(name: string, decode: (bytes: Uint8Array) => unknown): void {
  for (let seed = 1; seed <= 320; seed += 1) {
    try {
      decode(fuzzBytes(seed * 7919));
    } catch (error) {
      expect(error, `${name} seed ${seed}`).toBeInstanceOf(Error);
    }
  }
}

describe('network decoder and validation fuzz corpus', () => {
  it('keeps every binary decoder and snapshot state machine fail-closed', () => {
    expectDecoderToFailClosed('input', (bytes) => decodeInputPacket(bytes));
    expectDecoderToFailClosed('snapshot', (bytes) => decodeSnapshotChunk(bytes));
    expectDecoderToFailClosed('match packet', (bytes) => decodeMatchPacket(bytes));
    expectDecoderToFailClosed('remote input envelope', (bytes) => decodeRemoteInputEnvelope(bytes, 1));
    expectDecoderToFailClosed('reliable', (bytes) => decodeReliablePacket(bytes, 0x1234_5678));
    expectDecoderToFailClosed('authoritative event', (bytes) => decodeAuthoritativeEventPacket(bytes, 0x1234_5678));
    expectDecoderToFailClosed('match state', (bytes) => new MatchStateDecoder(0x1234_5678).add(bytes));
    expectDecoderToFailClosed('match start', (bytes) => decodeMatchStartControl(bytes));
  });

  it('keeps text protocol, invite decoding, and stateful gates bounded under fuzz input', () => {
    const validator = new InputPacketValidator({ expectedSessionId: 0x1234_5678, now: () => 0 });
    const protocol = new ProtocolSessionGuard({
      rateLimiter: new PeerRateLimiter({ maxPeers: 8, peerTtlMs: 10_000, now: () => 0 }),
      nonceGuard: new ReplayNonceGuard(8, { maxPeers: 8, peerTtlMs: 10_000, now: () => 0 }),
    });
    const replay = new ReplayNonceGuard(8, { maxPeers: 8, peerTtlMs: 10_000, now: () => 0 });
    const rate = new PeerRateLimiter({ maxPeers: 8, peerTtlMs: 10_000, now: () => 0 });

    for (let seed = 1; seed <= 320; seed += 1) {
      const text = fuzzText(seed * 15_173);
      try {
        decodeProtocolMessage(text);
      } catch (error) {
        expect(error, `protocol seed ${seed}`).toBeInstanceOf(Error);
      }
      try {
        decodeCrockfordBase32(text);
      } catch (error) {
        expect(error, `invite seed ${seed}`).toBeInstanceOf(Error);
      }
      try {
        validator.validate(fuzzBytes(seed * 31_337), { currentHostTick: seed, nowMs: seed });
      } catch (error) {
        expect(error, `input validator seed ${seed}`).toBeInstanceOf(Error);
      }
      try {
        protocol.accept(`peer-${seed % 32}`, { fuzz: text });
      } catch (error) {
        expect(error, `protocol session seed ${seed}`).toBeInstanceOf(Error);
      }
      expect(replay.accept(`peer-${seed % 32}`, text.slice(0, 128), text.slice(0, 256))).toBeTypeOf('boolean');
      expect(rate.allow(`peer-${seed % 32}`)).toBeTypeOf('boolean');
    }
  });
});
