import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_RECORDS,
  clearMatchRecords,
  loadMatchRecords,
  recordMatch,
  summarize,
  type MatchRecord,
} from '../../src/core/statsStore';

function makeRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    at: 1700000000000,
    map: 'neocity',
    mode: 'solo',
    won: false,
    placement: 3,
    players: 10,
    kills: 2,
    damage: 400,
    accuracy: 0.25,
    headshots: 1,
    survivalTime: 300,
    ...overrides,
  };
}

describe('statsStore', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      get length() { return store.size; },
    } as Storage;
    clearMatchRecords();
  });

  it('round-trips a record through storage', () => {
    recordMatch(makeRecord());
    expect(loadMatchRecords()).toHaveLength(1);
    expect(loadMatchRecords()[0]!.map).toBe('neocity');
  });

  it('newest record first and bounded at MAX_RECORDS', () => {
    for (let i = 0; i < MAX_RECORDS + 10; i++) {
      recordMatch(makeRecord({ at: i, kills: i }));
    }
    const records = loadMatchRecords();
    expect(records).toHaveLength(MAX_RECORDS);
    expect(records[0]!.at).toBe(MAX_RECORDS + 9);
  });

  it('rejects corrupt entries instead of throwing', () => {
    recordMatch(makeRecord());
    localStorage.setItem(
      'xo-beta-match-history-v1',
      JSON.stringify({ version: 1, records: [{ at: 'junk', kills: -5 }, 'garbage'] }),
    );
    const records = loadMatchRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.kills).toBeGreaterThanOrEqual(0);
  });

  it('summarizes aggregates over the record list', () => {
    const records = [
      makeRecord({ won: true, placement: 1, kills: 5, damage: 1200, headshots: 2, survivalTime: 600 }),
      makeRecord({ placement: 4, kills: 1, damage: 300, headshots: 0, survivalTime: 200 }),
    ];
    const s = summarize(records);
    expect(s.matches).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.winRate).toBeCloseTo(0.5);
    expect(s.bestPlacement).toBe(1);
    expect(s.avgKills).toBeCloseTo(3);
    expect(s.avgDamage).toBeCloseTo(750);
    expect(s.totalKills).toBe(6);
    expect(s.headshots).toBe(2);
    expect(s.bestSurvivalTime).toBe(600);
    expect(s.totalSurvivalTime).toBe(800);
  });

  it('summarize of an empty history is all-zero, not NaN', () => {
    const s = summarize([]);
    expect(s.matches).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.avgKills).toBe(0);
    expect(s.bestPlacement).toBe(0);
  });
});
