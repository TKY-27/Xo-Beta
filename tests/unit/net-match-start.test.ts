import { describe, expect, it } from 'vitest';
import { buildRoster, localHumanRosterEntry, remoteHumanRosterEntry } from '../../src/sim/roster';
import { loadMap } from '../../src/world';
import {
  computeGameplayMapHash,
  decodeMatchStartControl,
  encodeMatchStartControl,
  GuestMatchStartBarrier,
  HostMatchStartBarrier,
  validateMatchStartPayload,
  type MatchStartPayload,
} from '../../src/net/matchStart';

function payload(mapHash = 'a'.repeat(64)): MatchStartPayload {
  const roster = buildRoster({
    mode: 'ffa',
    seed: 42,
    humans: [
      localHumanRosterEntry({ peerId: 'host-peer', displayName: 'HOST' }),
      remoteHumanRosterEntry({ slotId: 1, actorId: 2, peerId: 'guest-peer', displayName: 'GUEST' }),
    ],
  });
  return {
    type: 'match-prepare',
    version: 1,
    protocolVersion: 1,
    protocolSession: 'session-1',
    buildHash: 'build-1',
    mapId: 'eden',
    mapHash,
    seed: 42,
    mode: 'ffa',
    difficulty: 'normal',
    roster,
    skins: roster.map((entry) => entry.skinId),
    startHostTick: 120,
  };
}

describe('Phase 4 match start barrier payloads', () => {
  it('round-trips a canonical bounded start payload', () => {
    const encoded = encodeMatchStartControl(payload());
    expect(decodeMatchStartControl(encoded)).toEqual(payload());
  });

  it('binds protocol, build, session, and map hash', () => {
    expect(() => validateMatchStartPayload(payload(), { buildHash: 'wrong' })).toThrow(/build/u);
    expect(() => validateMatchStartPayload(payload(), { protocolSession: 'wrong' })).toThrow(/session/u);
    expect(() => validateMatchStartPayload(payload(), { mapHash: 'b'.repeat(64) })).toThrow(/map hash/u);
  });

  it('rejects extra claims and inconsistent skins', () => {
    expect(() => validateMatchStartPayload({ ...payload(), winner: 1 })).toThrow(/fields/u);
    expect(() => validateMatchStartPayload({ ...payload(), skins: ['nova', 'nova'] })).toThrow(/skin binding/u);
  });

  it('produces stable gameplay hashes and distinguishes authored maps', async () => {
    const first = await computeGameplayMapHash(loadMap('eden').def);
    const second = await computeGameplayMapHash(loadMap('eden').def);
    const other = await computeGameplayMapHash(loadMap('oldfront').def);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  it('waits for every loaded participant before starting the countdown', async () => {
    let now = 100;
    const start = payload();
    const host = new HostMatchStartBarrier(start, [{
      peerId: 'guest-peer', participantId: 'guest-id', protocolSession: 'guest-session',
    }], { nowMs: () => now, timeoutMs: 1_000 });
    const guest = new GuestMatchStartBarrier('guest-id', 'guest-session', async () => undefined);
    const ready = await guest.prepare(start, {
      buildHash: 'build-1', mapHash: start.mapHash, protocolSession: 'session-1',
    });
    expect(host.tryStart(10)).toBeNull();
    expect(host.acceptReady('guest-peer', ready)).toBe(true);
    expect(host.tryStart(10)).toBeNull();
    host.markHostReady();
    const countdown = host.tryStart(10, 180)!;
    expect(countdown.startHostTick).toBe(190);
    expect(guest.acceptCountdown(countdown).startHostTick).toBe(190);
    expect(host.status().waitingParticipantIds).toEqual([]);
    expect(host.status().failedParticipantIds).toEqual([]);
    now = 2_000;
    expect(host.status().timedOut).toBe(false);
  });

  it('reports an authenticated guest load failure and cannot start silently', () => {
    const host = new HostMatchStartBarrier(payload(), [{
      peerId: 'guest-peer', participantId: 'guest-id', protocolSession: 'guest-session',
    }]);
    host.markHostReady();
    expect(host.markLoadFailed('guest-peer', 'guest-id')).toBe(true);
    expect(host.status()).toMatchObject({
      failedParticipantIds: ['guest-id'],
      waitingParticipantIds: [],
      countdown: null,
    });
    expect(host.tryStart(10)).toBeNull();
    expect(host.markLoadFailed('intruder', 'guest-id')).toBe(false);
  });

  it('removes READY and blocks countdown when that participant disconnects', async () => {
    const start = payload();
    const host = new HostMatchStartBarrier(start, [{
      peerId: 'guest-peer', participantId: 'guest-id', protocolSession: 'guest-session',
    }]);
    const guest = new GuestMatchStartBarrier('guest-id', 'guest-session', async () => undefined);
    const ready = await guest.prepare(start, {
      buildHash: 'build-1', mapHash: start.mapHash, protocolSession: 'session-1',
    });
    host.markHostReady();
    expect(host.acceptReady('guest-peer', ready)).toBe(true);
    expect(host.markDisconnected('guest-peer')).toBe(true);
    expect(host.status()).toMatchObject({
      readyParticipantIds: [],
      failedParticipantIds: ['guest-id'],
      countdown: null,
    });
    expect(host.tryStart(10)).toBeNull();
  });

  it('reports load timeout without silently dropping the guest', () => {
    let now = 0;
    const host = new HostMatchStartBarrier(payload(), [{
      peerId: 'guest-peer', participantId: 'guest-id', protocolSession: 'guest-session',
    }], { nowMs: () => now, timeoutMs: 500 });
    now = 501;
    expect(host.status()).toMatchObject({
      timedOut: true,
      waitingParticipantIds: ['guest-id'],
      countdown: null,
    });
  });
});
