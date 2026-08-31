import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../../src/physics/physics';
import { Match } from '../../src/sim/match';
import { buildRoster, localHumanRosterEntry, remoteHumanRosterEntry } from '../../src/sim/roster';
import { loadMap } from '../../src/world';

beforeAll(async () => initPhysics());

function makeMatch(): Match {
  const host = localHumanRosterEntry({ peerId: 'host-peer', displayName: 'HOST' });
  const guest = remoteHumanRosterEntry({ slotId: 1, actorId: 2, peerId: 'guest-peer', displayName: 'GUEST' });
  return new Match({
    mapDef: loadMap('oldfront').def,
    seed: 17,
    difficulty: 'normal',
    mode: 'ffa',
    roster: buildRoster({ mode: 'ffa', humans: [host, guest], seed: 17 }),
  });
}

describe('Match authoritative clock', () => {
  it('advances hostTick and stateRevision without uint32 coercion', () => {
    const match = makeMatch();
    match.phase = 'results';
    match.finished = true;

    match.fixedUpdate(1 / 60);

    expect(match.hostTick).toBe(1);
    expect(match.stateRevision).toBe(1);
  });

  it('fails closed before hostTick can wrap', () => {
    const match = makeMatch();
    match.hostTick = 0xffff_ffff;
    match.phase = 'results';
    match.finished = true;

    expect(() => match.fixedUpdate(1 / 60)).toThrow(/host tick exhausted/i);
    expect(match.hostTick).toBe(0xffff_ffff);
    expect(match.stateRevision).toBe(0);
  });

  it('fails closed before stateRevision can wrap', () => {
    const match = makeMatch();
    match.stateRevision = 0xffff_ffff;
    match.phase = 'results';
    match.finished = true;

    expect(() => match.fixedUpdate(1 / 60)).toThrow(/state revision exhausted/i);
    expect(match.hostTick).toBe(0);
    expect(match.stateRevision).toBe(0xffff_ffff);
  });
});
