import { describe, expect, it } from 'vitest';
import { runHeadlessMatch, type SimResult } from '../../src/sim/simRunner';
import type { MatchMode, RosterEntry } from '../../src/sim/roster';
import { humans } from '../fixtures/multiplayer';

interface Fixture {
  name: string;
  mode: MatchMode;
  humans: RosterEntry[];
  expectedActors: number;
  teamMode: boolean;
}

const FIXTURES: readonly Fixture[] = [
  { name: 'four-human FFA', mode: 'ffa', humans: humans(4), expectedActors: 4, teamMode: false },
  { name: '2v2', mode: 'teams', humans: humans(4, [0, 0, 1, 1]), expectedActors: 4, teamMode: true },
  { name: '5v5 with Bots', mode: 'teams-bot-fill', humans: humans(4, [0, 0, 1, 1]), expectedActors: 10, teamMode: true },
  { name: 'four humans versus six Bots', mode: 'humans-vs-bots', humans: humans(4), expectedActors: 10, teamMode: true },
  { name: 'solo regression', mode: 'solo', humans: humans(1), expectedActors: 10, teamMode: false },
];

function deterministicSignature(result: SimResult): unknown {
  return {
    durationTicks: Math.round(result.durationSec * 60),
    winnerName: result.winnerName,
    winnerTeamId: result.winnerTeamId,
    placements: result.placements,
    feed: result.feed,
    itemsPickedUp: result.itemsPickedUp,
    chestOpens: result.chestOpens,
  };
}

describe('multiplayer multi-seed long simulations', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} has legal deterministic outcomes without friendly fire`, async () => {
      const first = await runHeadlessMatch({
        mapId: 'eden',
        seed: 41021,
        difficulty: 'hard',
        maxSeconds: 60 * 26,
        mode: fixture.mode,
        humans: fixture.humans,
      });
      const replay = await runHeadlessMatch({
        mapId: 'eden',
        seed: 41021,
        difficulty: 'hard',
        maxSeconds: 60 * 26,
        mode: fixture.mode,
        humans: fixture.humans,
      });
      const secondSeed = await runHeadlessMatch({
        mapId: 'eden',
        seed: 41022,
        difficulty: 'hard',
        maxSeconds: 60 * 26,
        mode: fixture.mode,
        humans: fixture.humans,
      });

      for (const result of [first, replay, secondSeed]) {
        expect(result.winnerName).not.toBe('NONE');
        expect(result.placements).toHaveLength(fixture.expectedActors);
        expect(result.friendlyFireHits).toBe(0);
        if (fixture.teamMode) expect(result.winnerTeamId === 0 || result.winnerTeamId === 1).toBe(true);
        else expect(result.winnerTeamId).toBeNull();
      }
      expect(deterministicSignature(replay)).toEqual(deterministicSignature(first));
    }, 900_000);
  }
});
