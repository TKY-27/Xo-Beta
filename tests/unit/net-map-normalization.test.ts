import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../../src/physics/physics';
import { Match } from '../../src/sim/match';
import { buildRoster, localHumanRosterEntry, remoteHumanRosterEntry } from '../../src/sim/roster';
import { loadMap, type MapId } from '../../src/world';
import { normalizeMapForMatch } from '../../src/world/builder';

beforeAll(async () => initPhysics());

describe('online map normalization', () => {
  it.each(['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[])(
    'keeps the %s destructible dictionary stable when Match takes ownership',
    (mapId) => {
      const map = normalizeMapForMatch(loadMap(mapId).def);
      const dictionary = map.destructibles.map((value) => value.stableId);
      const host = localHumanRosterEntry({ peerId: 'host-peer', displayName: 'HOST' });
      const guest = remoteHumanRosterEntry({
        slotId: 1,
        actorId: 2,
        peerId: 'guest-peer',
        displayName: 'GUEST',
      });
      const match = new Match({
        mapDef: map,
        seed: 73,
        difficulty: 'normal',
        mode: 'ffa',
        roster: buildRoster({ mode: 'ffa', humans: [host, guest], seed: 73 }),
      });

      try {
        expect(match.toGameStateView(1).destructibles.map((value) => value.id)).toEqual(dictionary);
        expect(normalizeMapForMatch(map).destructibles.map((value) => value.stableId)).toEqual(dictionary);
      } finally {
        match.dispose();
      }
    },
    15_000,
  );
});
