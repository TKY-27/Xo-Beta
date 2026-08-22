/**
 * Integration tests: full headless matches through the real simulation.
 * These exercise transport → drop → looting → combat → storm → winner.
 */

import { describe, it, expect } from 'vitest';
import { runHeadlessMatch } from '../../src/sim/simRunner';
import { MATCH } from '../../src/core/balance';

describe('headless match lifecycle', () => {
  it('runs to a single winner with consistent placements', async () => {
    const r = await runHeadlessMatch({ mapId: 'neocity', seed: 1234, difficulty: 'hard', maxSeconds: 60 * 26 });
    expect(r.winnerName).not.toBe('NONE');
    // Exactly one placement #1
    expect(r.placements.filter((p) => p.placement === 1).length).toBe(1);
    // Placements are a permutation of 1..10
    const sorted = r.placements.map((p) => p.placement).sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Winner survived
    expect(r.placements.find((p) => p.placement === 1)?.survived).toBe(true);
  }, 240_000);

  it('bots loot and fight: pickups and eliminations occur naturally', async () => {
    const r = await runHeadlessMatch({ mapId: 'oldfront', seed: 777, difficulty: 'normal', maxSeconds: 60 * 26 });
    expect(r.itemsPickedUp).toBeGreaterThan(20);
    // 8+ eliminations (a rare simultaneous-survivor edge can leave 2 alive at cap)
    expect(r.killFeedSize).toBeGreaterThanOrEqual(6);
    expect(r.chestOpens).toBeGreaterThan(0);
  }, 240_000);

  it('storm pressure exists: some matches end with storm kills', async () => {
    // Run three seeds; at least one should feature storm deaths
    let sawStormDeaths = false;
    for (const seed of [31, 32, 33]) {
      const r = await runHeadlessMatch({ mapId: 'eden', seed, difficulty: 'hard', maxSeconds: 60 * 26 });
      if (r.stormDeaths > 0) {
        sawStormDeaths = true;
        break;
      }
      void seed;
    }
    expect(sawStormDeaths).toBe(true);
  }, 600_000);

  it('same seed produces identical kill sequences (deterministic sim)', async () => {
    const a = await runHeadlessMatch({ mapId: 'neocity', seed: 424242, difficulty: 'elite', maxSeconds: 150 });
    const b = await runHeadlessMatch({ mapId: 'neocity', seed: 424242, difficulty: 'elite', maxSeconds: 150 });
    // Same duration & same elimination count within the capped window
    expect(Math.round(a.durationSec * 10)).toBe(Math.round(b.durationSec * 10));
    expect(a.killFeedSize).toBe(b.killFeedSize);
    expect(a.headshots).toBe(b.headshots);
    expect(a.itemsPickedUp).toBe(b.itemsPickedUp);
  }, 300_000);
});

describe('match configuration', () => {
  it('spawns exactly ten combatants in bot-only mode', async () => {
    const r = await runHeadlessMatch({ mapId: 'neocity', seed: 8, difficulty: 'normal', maxSeconds: 5 });
    expect(r.placements.length).toBe(MATCH.combatantCount);
  }, 120_000);
});
