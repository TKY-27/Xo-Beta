import { describe, expect, it } from 'vitest';
import { MATCH } from '../../src/core/balance';
import {
  areRosterEntriesHostile,
  buildRoster,
  buildSoloRoster,
  localHumanRosterEntry,
  validateRoster,
  type RosterEntry,
} from '../../src/sim/roster';
import { humanEntry, humans, qaRosterFixtures, rosterFixture } from '../fixtures/multiplayer';

function humanCount(roster: readonly RosterEntry[]): number {
  return roster.filter((entry) => entry.ownership.kind !== 'bot').length;
}

describe('deterministic multiplayer roster construction', () => {
  it('builds solo and preserves the one-human practice roster', () => {
    const solo = buildSoloRoster(31);
    expect(solo).toHaveLength(MATCH.combatantCount);
    expect(humanCount(solo)).toBe(1);
    expect(solo.filter((entry) => entry.ownership.kind === 'bot')).toHaveLength(9);
    expect(buildSoloRoster(31, { practice: true })).toEqual([localHumanRosterEntry()]);
  });

  it.each([1, 2, 3, 4])('fills %i-human FFA to ten', (count) => {
    const roster = rosterFixture('ffa-bot-fill', count);
    expect(roster).toHaveLength(10);
    expect(humanCount(roster)).toBe(count);
    expect(roster.every((entry) => entry.teamId === null)).toBe(true);
    for (const first of roster) {
      for (const second of roster) {
        expect(areRosterEntriesHostile('ffa-bot-fill', first, second)).toBe(first.actorId !== second.actorId);
      }
    }
  });

  it.each([2, 3, 4])('builds Bot-off %i-human FFA at actual size', (count) => {
    const roster = rosterFixture('ffa', count);
    expect(roster).toHaveLength(count);
    expect(humanCount(roster)).toBe(count);
  });

  it.each([
    ['1v1', [0, 1]],
    ['2v1', [0, 0, 1]],
    ['2v2', [0, 0, 1, 1]],
  ] as const)('preserves host team assignment for %s', (_name, teams) => {
    const roster = rosterFixture('teams', teams.length, teams);
    expect(roster.map((entry) => entry.teamId)).toEqual(teams);
    expect(roster.every((entry) => entry.ownership.kind !== 'bot')).toBe(true);
  });

  it('builds balanced 5v5 Bot fill and defaults four humans to 2v2', () => {
    const roster = rosterFixture('teams-bot-fill', 4);
    expect(roster).toHaveLength(10);
    expect(roster.filter((entry) => entry.teamId === 0)).toHaveLength(5);
    expect(roster.filter((entry) => entry.teamId === 1)).toHaveLength(5);
    expect(roster.slice(0, 4).map((entry) => entry.teamId)).toEqual([0, 1, 0, 1]);
    expect(qaRosterFixtures.fiveVsFiveWithBots()).toHaveLength(10);
  });

  it.each([1, 2, 3, 4])('builds %i humans versus the remaining Bots', (count) => {
    const roster = rosterFixture('humans-vs-bots', count);
    expect(roster).toHaveLength(10);
    expect(roster.filter((entry) => entry.teamId === 0)).toHaveLength(count);
    expect(roster.filter((entry) => entry.teamId === 1)).toHaveLength(10 - count);
    expect(roster.filter((entry) => entry.teamId === 1).every((entry) => entry.ownership.kind === 'bot')).toBe(true);
  });

  it('is identical for a fixed seed and configuration', () => {
    const config = { mode: 'teams-bot-fill' as const, humans: humans(4, [0, 0, 1, 1]), seed: 99431 };
    expect(buildRoster(config)).toEqual(buildRoster(config));
    expect(qaRosterFixtures.twoVsTwo()).toHaveLength(4);
    expect(qaRosterFixtures.fourHumansVsSixBots()).toHaveLength(10);
  });
});

describe('roster validation', () => {
  it.each([
    ['more than four humans', () => buildRoster({ mode: 'ffa-bot-fill', humans: humans(5), seed: 1 })],
    ['duplicate slots', () => buildRoster({ mode: 'ffa', humans: [humanEntry(0), { ...humanEntry(1), slotId: 0 }], seed: 1 })],
    ['duplicate actors', () => buildRoster({ mode: 'ffa', humans: [humanEntry(0), { ...humanEntry(1), actorId: 1 }], seed: 1 })],
    ['duplicate peers', () => buildRoster({ mode: 'ffa', humans: [humanEntry(0), { ...humanEntry(1), ownership: { kind: 'remote-human', peerId: 'peer-1' } }], seed: 1 })],
    ['invalid team', () => buildRoster({ mode: 'teams', humans: [humanEntry(0, 0), humanEntry(1, 3)], seed: 1 })],
    ['invalid skin', () => buildRoster({ mode: 'ffa', humans: [humanEntry(0), { ...humanEntry(1), skinId: 'invalid' as never }], seed: 1 })],
    ['invalid display name', () => buildRoster({ mode: 'ffa', humans: [{ ...humanEntry(0), displayName: '  ' }, humanEntry(1)], seed: 1 })],
    ['one-human Bot-off FFA', () => buildRoster({ mode: 'ffa', humans: humans(1), seed: 1 })],
    ['one-human Bot-off teams', () => buildRoster({ mode: 'teams', humans: humans(1, [0]), seed: 1 })],
    ['empty opposing team', () => buildRoster({ mode: 'teams', humans: humans(2, [0, 0]), seed: 1 })],
    ['team in FFA', () => buildRoster({ mode: 'ffa', humans: humans(2, [0, 1]), seed: 1 })],
  ])('rejects %s', (_name, makeRoster) => {
    expect(makeRoster).toThrow();
  });

  it('rejects inconsistent connection state and a prebuilt team without opposition', () => {
    const inconsistent = { ...humanEntry(0), connectionState: 'bot' as const };
    expect(() => validateRoster('solo', [inconsistent, ...buildSoloRoster(3).slice(1)])).toThrow();
    expect(() => validateRoster('teams', humans(2, [0, 0]))).toThrow();
  });

  it('rejects prebuilt rosters that bypass canonical mode construction', () => {
    const solo = buildSoloRoster(7);
    const noHuman = solo.map((entry) => ({
      ...entry,
      ownership: { kind: 'bot' as const },
      connectionState: 'bot' as const,
    }));
    expect(() => validateRoster('solo', noHuman)).toThrow();
    expect(() => validateRoster('teams-bot-fill', rosterFixture('humans-vs-bots', 4))).toThrow();
    expect(() => validateRoster('humans-vs-bots', rosterFixture('teams-bot-fill', 4))).toThrow();
    expect(() => validateRoster('teams', rosterFixture('teams', 2, [0, 1]), true)).toThrow();
  });
});
