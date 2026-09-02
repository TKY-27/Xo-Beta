import { describe, expect, it } from 'vitest';
import { damageAfterDistanceFalloff } from '../../src/sim/combat';
import { RARITY_MODS, WEAPONS, type WeaponId } from '../../src/core/balance';

/** Weapons with meaningful falloff windows; sniper identity checked separately. */
const WEAPON_IDS: WeaponId[] = ['pistol', 'smg', 'ar', 'shotgun', 'sniper'];

describe('ballistic distance falloff', () => {
  it('applies full damage at and before falloffStart with no discontinuity at the boundary', () => {
    for (const id of WEAPON_IDS) {
      const def = WEAPONS[id];
      expect(damageAfterDistanceFalloff(100, 0, def.falloffStart, def.falloffEnd, def.falloffEndMult)).toBe(100);
      expect(damageAfterDistanceFalloff(100, def.falloffStart, def.falloffStart, def.falloffEnd, def.falloffEndMult)).toBe(100);
      // Boundary continuity: just past start begins interpolating from 100.
      const justPast = damageAfterDistanceFalloff(100, def.falloffStart + 0.01, def.falloffStart, def.falloffEnd, def.falloffEndMult);
      expect(justPast).toBeLessThan(100.0001);
      expect(justPast).toBeGreaterThan(99.9);
    }
  });

  it('interpolates linearly and reaches exactly endMult at falloffEnd', () => {
    for (const id of WEAPON_IDS) {
      const def = WEAPONS[id];
      const mid = (def.falloffStart + def.falloffEnd) / 2;
      const midExpected = 100 * (1 + (def.falloffEndMult - 1) * 0.5);
      expect(damageAfterDistanceFalloff(100, mid, def.falloffStart, def.falloffEnd, def.falloffEndMult))
        .toBeCloseTo(midExpected, 6);
      expect(damageAfterDistanceFalloff(100, def.falloffEnd, def.falloffStart, def.falloffEnd, def.falloffEndMult))
        .toBeCloseTo(100 * def.falloffEndMult, 6);
      // Beyond end: clamped at endMult.
      expect(damageAfterDistanceFalloff(100, def.falloffEnd * 3, def.falloffStart, def.falloffEnd, def.falloffEndMult))
        .toBeCloseTo(100 * def.falloffEndMult, 6);
    }
  });

  it('keeps the authored falloff identity per weapon', () => {
    // Shotguns must not stay lethal at range; snipers keep long-range identity.
    const shotgun = WEAPONS.shotgun;
    expect(shotgun.falloffEnd).toBeLessThan(50);
    expect(shotgun.falloffEndMult).toBeLessThan(0.3);
    const sniper = WEAPONS.sniper;
    expect(sniper.falloffStart).toBeGreaterThanOrEqual(250);
    expect(sniper.falloffEndMult).toBeGreaterThanOrEqual(0.8);
    // No weapon deals negative or amplified-by-falloff damage.
    for (const id of WEAPON_IDS) {
      const def = WEAPONS[id];
      expect(def.falloffEndMult).toBeGreaterThan(0);
      expect(def.falloffEndMult).toBeLessThanOrEqual(1);
      expect(def.falloffEnd).toBeGreaterThan(def.falloffStart);
      const far = damageAfterDistanceFalloff(1000, 10000, def.falloffStart, def.falloffEnd, def.falloffEndMult);
      expect(far).toBeGreaterThanOrEqual(1);
    }
  });

  it('floors damage at 1 and never returns negative values', () => {
    expect(damageAfterDistanceFalloff(0.4, 0, 10, 20, 0.5)).toBe(1);
    // Falloff then floor: 2 * 0.1 = 0.2 clamps to the 1-damage floor.
    expect(damageAfterDistanceFalloff(2, 10000, 10, 20, 0.1)).toBe(1);
    expect(damageAfterDistanceFalloff(5, -50, 10, 20, 0.5)).toBe(5);
  });

  it('scales monotonically with rarity recoil control without removing recoil', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const tier of Object.values(RARITY_MODS)) {
      expect(tier.recoilMult).toBeLessThan(previous);
      expect(tier.recoilMult).toBeGreaterThan(0);
      previous = tier.recoilMult;
    }
  });
});
