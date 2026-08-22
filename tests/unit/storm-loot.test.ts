/**
 * Unit tests: storm circle progression + loot rolls (seeded).
 */

import { describe, it, expect } from 'vitest';
import { Storm } from '../../src/sim/storm';
import { LootSystem } from '../../src/sim/loot';
import { Rng, setGameSeed } from '../../src/core/rng';
import { STORM_INITIAL_RADIUS } from '../../src/core/balance';

const noopEvents = {
  onPhaseWaiting: () => undefined,
  onShrinkStart: () => undefined,
  onFinalCircle: () => undefined,
};

describe('storm', () => {
  it('starts idle until begin()', () => {
    const s = new Storm(500, new Rng(1), noopEvents);
    expect(s.state).toBe('idle');
    expect(s.radius).toBe(STORM_INITIAL_RADIUS);
  });

  it('holds the wait timer then shrinks toward the announced target', () => {
    const s = new Storm(500, new Rng(7), noopEvents);
    s.begin();
    expect(s.state).toBe('waiting');
    const next = s.nextCircle();
    // Announced circle is strictly smaller and inside map bounds
    expect(next.r).toBeLessThan(s.radius);
    expect(Math.abs(next.x)).toBeLessThanOrEqual(230);
    expect(Math.abs(next.z)).toBeLessThanOrEqual(230);

    // Fast-forward through waiting
    for (let i = 0; i < 60 * 1200; i++) s.update(1 / 60);
    // After the full schedule the circle must be nearly zero
    expect(s.radius).toBeLessThan(1);
    expect(s.state).toBe('done');
  });

  it('damage flag works geometrically', () => {
    const s = new Storm(500, new Rng(3), noopEvents);
    s.begin();
    s.centerX = 0;
    s.centerZ = 0;
    s.radius = 100;
    expect(s.isOutside(150, 0)).toBe(true);
    expect(s.isOutside(50, 0)).toBe(false);
    expect(s.distanceOutside(120, 0)).toBeCloseTo(20);
    expect(s.distanceOutside(80, 0)).toBeCloseTo(-20);
  });
});

describe('loot generation', () => {
  it('rarity distribution roughly matches configured weights', () => {
    setGameSeed(42);
    const loot = new LootSystem({ onSpawn: () => undefined, onPickup: () => undefined });
    const rng = new Rng(99);
    const counts = [0, 0, 0, 0, 0];
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const r = loot.rollRarity(rng);
      const idx = ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(r);
      counts[idx === -1 ? 0 : idx]!++;
    }
    const pct = counts.map((c) => (c / N) * 100) as [number, number, number, number, number];
    expect(pct[0]).toBeGreaterThan(37); // common ~40%
    expect(pct[0]).toBeLessThan(43);
    expect(pct[4]!).toBeGreaterThan(2.8); // legendary ~4%
    expect(pct[4]!).toBeLessThan(5.2);
    expect(pct[4]!).toBeLessThan(pct[3]!); // legendary rarer than epic
  });

  it('chest contents stay within their tier band', () => {
    const loot = new LootSystem({ onSpawn: () => undefined, onPickup: () => undefined });
    const rng = new Rng(5);
    for (let i = 0; i < 60; i++) {
      const items = loot.openChest('standard', 0, 0, 0, rng);
      const weapons = items.filter((it) => it.kind === 'weapon');
      for (const w of weapons) {
        if (w.weapon) {
          expect(['common', 'uncommon', 'rare']).toContain(w.weapon.rarity);
        }
      }
      expect(items.length).toBeGreaterThanOrEqual(2);
    }
    for (let i = 0; i < 40; i++) {
      const items = loot.openChest('vault', 0, 0, 0, rng);
      for (const w of items) {
        if (w.kind === 'weapon' && w.weapon) {
          expect(['rare', 'epic', 'legendary']).toContain(w.weapon.rarity);
        }
      }
    }
  });

  it('dropped weapon mags spawn full', () => {
    const loot = new LootSystem({ onSpawn: () => undefined, onPickup: () => undefined });
    const w = loot.makeWeaponInstance(new Rng(11), 'epic');
    const def = { pistol: 15, smg: 32, ar: 30, shotgun: 6, sniper: 5 } as Record<string, number>;
    expect(w.ammoInMag).toBe(def[w.weaponId]);
  });
});
