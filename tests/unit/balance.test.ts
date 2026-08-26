/**
 * Unit tests: weapon balance configuration matches the design baseline.
 */

import { describe, it, expect } from 'vitest';
import { WEAPONS, RARITY_MODS, RARITIES, FLOOR_RARITY_WEIGHTS, CHESTS, HEAL_ITEMS, HIT_REGION_MULT, MOVE, STORM_PHASES } from '../../src/core/balance';

describe('weapon balance baseline', () => {
  it('pistol damage by rarity matches spec', () => {
    expect(WEAPONS.pistol.damage).toEqual([26, 29, 32, 35, 38]);
  });
  it('AR damage by rarity matches spec', () => {
    expect(WEAPONS.ar.damage).toEqual([24, 26, 28, 30, 32]);
    expect(Math.round(WEAPONS.ar.rpm)).toBe(700);
  });
  it('SMG damage by rarity matches spec and fires faster than AR', () => {
    expect(WEAPONS.smg.damage).toEqual([17, 18, 19, 20, 21]);
    expect(WEAPONS.smg.rpm).toBeGreaterThan(WEAPONS.ar.rpm);
  });
  it('shotgun pellet totals match spec maxima', () => {
    const totals = WEAPONS.shotgun.damage.map((d) => d * WEAPONS.shotgun.pellets);
    expect(totals[0]).toBeCloseTo(110);
    expect(totals[2]).toBeCloseTo(140);
    expect(totals[4]).toBeCloseTo(220);
  });
  it('sniper epic/legendary can one-shot chest a full 200hp target', () => {
    // chest multiplier = 1.0
    expect(WEAPONS.sniper.damage[3]! * HIT_REGION_MULT.chest).toBeGreaterThanOrEqual(200);
    expect(WEAPONS.sniper.damage[4]! * HIT_REGION_MULT.chest).toBeGreaterThanOrEqual(200);
    // lower rarities must NOT auto one-shot the chest
    expect(WEAPONS.sniper.damage[0]!).toBeLessThan(200);
    expect(WEAPONS.sniper.damage[2]!).toBeLessThan(200);
  });
  it('fire modes are correct per spec', () => {
    expect(WEAPONS.pistol.fireMode).toBe('semi');
    expect(WEAPONS.shotgun.fireMode).toBe('pump');
    expect(WEAPONS.sniper.fireMode).toBe('bolt');
    expect(WEAPONS.ar.fireMode).toBe('auto');
    expect(WEAPONS.smg.fireMode).toBe('auto');
  });
  it('exactly five weapon classes exist', () => {
    expect(Object.keys(WEAPONS).length).toBe(5);
  });
});

describe('rarity system', () => {
  it('five tiers with strictly improving modifiers', () => {
    for (let i = 1; i < RARITIES.length; i++) {
      const prev = RARITY_MODS[RARITIES[i - 1]!];
      const cur = RARITY_MODS[RARITIES[i]!];
      expect(cur.reloadMult).toBeLessThanOrEqual(prev.reloadMult);
      expect(cur.spreadMult).toBeLessThanOrEqual(prev.spreadMult);
      expect(cur.recoilMult).toBeLessThanOrEqual(prev.recoilMult);
      expect(cur.projSpeedMult).toBeGreaterThanOrEqual(prev.projSpeedMult);
    }
  });

  it('floor loot weights sum to 100 with epic/legendary excluded', () => {
    const sum = FLOOR_RARITY_WEIGHTS.reduce<number>((a, b) => a + b, 0);
    expect(sum).toBe(100);
    expect(FLOOR_RARITY_WEIGHTS[0]).toBe(46);
    // Epic and Legendary must never spawn as random floor loot.
    expect(FLOOR_RARITY_WEIGHTS[3]).toBe(0);
    expect(FLOOR_RARITY_WEIGHTS[4]).toBe(0);
  });
});

describe('chests', () => {
  it('standard chests drop common..rare only', () => {
    const w = CHESTS.standard.rarityWeights;
    expect(w[0]).toBeGreaterThan(0);
    expect(w[3]).toBe(0);
    expect(w[4]).toBe(0);
  });
  it('elite chests never drop legendary, vault chests skew epic+', () => {
    expect(CHESTS.elite.rarityWeights[4]).toBe(0);
    const vaultEpicPlus = (CHESTS.vault.rarityWeights[3] ?? 0) + (CHESTS.vault.rarityWeights[4] ?? 0);
    expect(vaultEpicPlus).toBeGreaterThanOrEqual(80);
  });
});

describe('healing items', () => {
  it('med kit heals 75 over ~5s, stacks of 2', () => {
    expect(HEAL_ITEMS.medkit.amount).toBe(75);
    expect(HEAL_ITEMS.medkit.useTime).toBeCloseTo(5);
    expect(HEAL_ITEMS.medkit.stackSize).toBe(2);
  });
  it('shield potion restores 50 over ~3s, stacks of 3', () => {
    expect(HEAL_ITEMS.shieldpot.amount).toBe(50);
    expect(HEAL_ITEMS.shieldpot.useTime).toBeCloseTo(3);
    expect(HEAL_ITEMS.shieldpot.stackSize).toBe(3);
  });
});

describe('hit regions', () => {
  it('matches spec multipliers', () => {
    expect(HIT_REGION_MULT.head).toBeCloseTo(2.0);
    expect(HIT_REGION_MULT.chest).toBeCloseTo(1.0);
    expect(HIT_REGION_MULT.abdomen).toBeCloseTo(0.9);
    expect(HIT_REGION_MULT.arms).toBeCloseTo(0.75);
    expect(HIT_REGION_MULT.legs).toBeCloseTo(0.7);
  });
});

describe('storm schedule', () => {
  it('circles shrink monotonically toward near-zero', () => {
    for (let i = 1; i < STORM_PHASES.length; i++) {
      expect(STORM_PHASES[i]!.radius).toBeLessThan(STORM_PHASES[i - 1]!.radius);
    }
    expect(STORM_PHASES[STORM_PHASES.length - 1]!.radius).toBeLessThan(1);
  });
  it('damage escalates every phase', () => {
    for (let i = 1; i < STORM_PHASES.length; i++) {
      expect(STORM_PHASES[i]!.dps).toBeGreaterThan(STORM_PHASES[i - 1]!.dps);
    }
  });
  it('total schedule lands in the 14-18 minute window after landing', () => {
    const total = STORM_PHASES.reduce((s, p) => s + p.wait + p.shrink, 0);
    expect(total).toBeGreaterThan(60 * 14);
    expect(total).toBeLessThan(60 * 18);
  });
});

describe('movement config sanity', () => {
  it('uses a readable asymmetric jump arc with a small sprint boost', () => {
    const riseGravity = MOVE.gravity * MOVE.jumpRiseGravityScale;
    const fallGravity = MOVE.gravity * MOVE.fallGravityScale;
    const apexSeconds = MOVE.jumpVel / riseGravity;
    const apexHeight = (MOVE.jumpVel * MOVE.jumpVel) / (2 * riseGravity);
    const totalAirTime = apexSeconds + Math.sqrt((2 * apexHeight) / fallGravity);

    expect(apexHeight).toBeGreaterThan(1.7);
    expect(apexHeight).toBeLessThan(2.1);
    expect(totalAirTime).toBeGreaterThan(0.7);
    expect(totalAirTime).toBeLessThan(0.85);
    expect(MOVE.sprintJumpMultiplier).toBeGreaterThan(1);
    expect(MOVE.sprintJumpMultiplier).toBeLessThanOrEqual(1.1);
  });

  it('double jump enabled with two charges', () => {
    expect(MOVE.maxJumps).toBe(2);
  });
  it('dash: two ground charges, regen exists', () => {
    expect(MOVE.dashChargesGround).toBe(2);
    expect(MOVE.dashRegenTime).toBeGreaterThan(0);
  });
  it('grapple has cooldown and generous range', () => {
    expect(MOVE.grappleCooldown).toBeGreaterThan(0);
    expect(MOVE.grappleRange).toBeGreaterThan(50);
  });
});
