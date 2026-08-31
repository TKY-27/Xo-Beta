import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_FEATURES,
  PROTOCOL_MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  PeerRateLimiter,
  ProtocolSessionGuard,
  ProtocolValidationError,
  ReplayNonceGuard,
  buildHandshake,
  buildsMatch,
  encodeProtocolMessage,
  validateProtocolMessage,
  type BuildIdentity,
} from '../../src/net/protocol';

const build: BuildIdentity = {
  protocolVersion: PROTOCOL_VERSION,
  buildId: 'test-build',
  features: [...PROTOCOL_FEATURES],
};

function handshake(overrides: Partial<Parameters<typeof buildHandshake>[0]> = {}) {
  return buildHandshake({
    roomId: 'room-1',
    peerId: 'peer-1',
    participantId: 'participant-1',
    role: 'participant',
    protocolSession: 'session-1',
    nonce: 'nonce-1',
    build,
    ...overrides,
  });
}

describe('Phase 3 lobby protocol', () => {
  it('builds and validates an immutable, canonical handshake', () => {
    const value = handshake();
    expect(value.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(value.features).toEqual([...PROTOCOL_FEATURES]);
    expect(() => validateProtocolMessage(value)).not.toThrow();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.features)).toBe(true);
  });

  it('normalizes Unicode display names but rejects controls, overflow, and unknown fields', () => {
    const message = {
      type: 'set-display-name',
      protocolVersion: PROTOCOL_VERSION,
      protocolSession: 'session-1',
      senderPeerId: 'peer-1',
      nonce: 'nonce-2',
      displayName: 'e\u0301',
    };
    expect(validateProtocolMessage(message)).toMatchObject({ displayName: 'é' });
    expect(() => validateProtocolMessage({ ...message, displayName: 'bad\u0000name' })).toThrow();
    expect(() => validateProtocolMessage({
      ...message,
      displayName: 'x'.repeat(25),
    })).toThrow();
    expect(() => validateProtocolMessage({ ...message, extra: true })).toThrow();
    expect(() => validateProtocolMessage({ ...message, ready: true })).toThrow();
  });

  it('rejects unsupported protocol/build/feature values and unlisted message types', () => {
    expect(() => validateProtocolMessage({ ...handshake(), protocolVersion: 99 })).toThrowError(ProtocolValidationError);
    expect(() => validateProtocolMessage({
      ...handshake(),
      features: ['lobby-v1', 'future-feature'],
    })).toThrow();
    expect(() => validateProtocolMessage({
      type: 'chat',
      protocolVersion: PROTOCOL_VERSION,
      protocolSession: 'session-1',
      senderPeerId: 'peer-1',
      nonce: 'nonce-3',
      text: 'not part of Phase 3',
    })).toThrow();
    expect(buildsMatch(build, { ...build, buildId: 'other' })).toBe(false);
  });

  it('applies a bounded UTF-8 payload gate before transport serialization', () => {
    const base = {
      type: 'set-display-name' as const,
      protocolVersion: PROTOCOL_VERSION,
      protocolSession: 'session-1',
      senderPeerId: 'peer-1',
      nonce: 'nonce-4',
      displayName: 'PLAYER',
    };
    expect(() => encodeProtocolMessage(base)).not.toThrow();
    expect(() => validateProtocolMessage(`{"type":"set-ready","protocolVersion":${PROTOCOL_VERSION},"protocolSession":"s","senderPeerId":"p","nonce":"n","ready":true}`)).not.toThrow();
    expect(() => validateProtocolMessage(`{"type":"set-display-name","protocolVersion":${PROTOCOL_VERSION},"protocolSession":"s","senderPeerId":"p","nonce":"n","displayName":"${'x'.repeat(PROTOCOL_MAX_PAYLOAD_BYTES)}"}`)).toThrowError(/payload|bytes/i);
  });

  it('rejects duplicate and stale nonces per peer/session', () => {
    const guard = new ReplayNonceGuard();
    expect(guard.accept('peer-1', 'session-1', 'n1')).toBe(true);
    expect(guard.accept('peer-1', 'session-1', 'n1')).toBe(false);
    expect(guard.accept('peer-1', 'session-2', 'n2')).toBe(false);
    expect(guard.accept('peer-2', 'session-2', 'n2')).toBe(true);
  });

  it('rate-limits each peer independently and combines both gates', () => {
    let now = 0;
    const limiter = new PeerRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
    now = 1000;
    expect(limiter.allow('a')).toBe(true);

    const session = new ProtocolSessionGuard({
      rateLimiter: new PeerRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => now }),
    });
    const message = {
      type: 'set-ready' as const,
      protocolVersion: PROTOCOL_VERSION,
      protocolSession: 'session-1',
      senderPeerId: 'peer-1',
      nonce: 'nonce-5',
      ready: true,
    };
    expect(session.accept('peer-1', message)).toEqual(message);
    expect(() => session.accept('peer-1', { ...message, nonce: 'nonce-6' })).toThrowError(/rate limited/i);
  });

  it('bounds attacker-keyed rate and replay state and expires idle peers', () => {
    let now = 0;
    const limiter = new PeerRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      maxPeers: 2,
      peerTtlMs: 100,
      now: () => now,
    });
    expect(limiter.allow('attacker-a')).toBe(true);
    expect(limiter.allow('attacker-b')).toBe(true);
    expect(limiter.allow('attacker-c')).toBe(false);
    expect(limiter.trackedPeers).toBe(2);
    now = 100;
    expect(limiter.allow('attacker-c')).toBe(true);
    expect(limiter.trackedPeers).toBe(1);

    now = 0;
    const guard = new ReplayNonceGuard(8, { maxPeers: 2, peerTtlMs: 100, now: () => now });
    expect(guard.accept('peer-a', 'session-a', 'nonce-a')).toBe(true);
    expect(guard.accept('peer-b', 'session-b', 'nonce-b')).toBe(true);
    expect(guard.accept('peer-c', 'session-c', 'nonce-c')).toBe(false);
    expect(guard.trackedPeers).toBe(2);
    now = 100;
    expect(guard.accept('peer-c', 'session-c', 'nonce-c')).toBe(true);
    expect(guard.trackedPeers).toBe(1);
  });
});
