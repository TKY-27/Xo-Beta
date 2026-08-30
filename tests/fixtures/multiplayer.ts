import type { SkinId } from '../../src/core/settings';
import {
  buildRoster,
  localHumanRosterEntry,
  type MatchMode,
  type RosterEntry,
  type TeamId,
} from '../../src/sim/roster';

export function humanEntry(index: number, teamId: TeamId | null = null): RosterEntry {
  const skinIds: readonly SkinId[] = ['vanguard', 'pathfinder', 'specter', 'striker'];
  return index === 0
    ? localHumanRosterEntry({
        slotId: index,
        actorId: index + 1,
        peerId: `peer-${index + 1}`,
        displayName: `HUMAN ${index + 1}`,
        teamId,
        skinId: skinIds[index]!,
        accentColor: 0x44aaff + index,
      })
    : {
        slotId: index,
        actorId: index + 1,
        displayName: `HUMAN ${index + 1}`,
        ownership: { kind: 'remote-human', peerId: `peer-${index + 1}` },
        connectionState: 'connected',
        teamId,
        skinId: skinIds[index]!,
        accentColor: 0x44aaff + index,
      };
}

export function humans(count: number, teams: readonly (TeamId | null)[] = []): RosterEntry[] {
  return Array.from({ length: count }, (_, index) => humanEntry(index, teams[index] ?? null));
}

export function rosterFixture(mode: MatchMode, count: number, teams: readonly (TeamId | null)[] = [], seed = 731): RosterEntry[] {
  return buildRoster({ mode, humans: humans(count, teams), seed });
}

export const qaRosterFixtures = Object.freeze({
  twoVsTwo: () => rosterFixture('teams', 4, [0, 0, 1, 1]),
  fiveVsFiveWithBots: () => rosterFixture('teams-bot-fill', 4, [0, 0, 1, 1]),
  fourHumansVsSixBots: () => rosterFixture('humans-vs-bots', 4, [0, 0, 0, 0]),
});
