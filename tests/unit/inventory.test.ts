/**
 * Unit tests: inventory — 5 universal slots, stacking, ammo pools, reload.
 */

import { describe, it, expect } from 'vitest';
import { INVENTORY_SLOTS, Inventory, MELEE_SLOT, type WeaponInstance } from '../../src/sim/inventory';
import { WEAPONS } from '../../src/core/balance';

function weapon(id: 'pistol' | 'smg' | 'ar' | 'shotgun' | 'sniper', rarity: WeaponInstance['rarity'] = 'common'): WeaponInstance {
  return { kind: 'weapon', weaponId: id, rarity, ammoInMag: WEAPONS[id].magSize };
}

describe('slots', () => {
  it('starts with five empty universal slots', () => {
    const inv = new Inventory();
    expect(inv.slots.length).toBe(5);
    expect(inv.slots.every((s) => s === null)).toBe(true);
  });

  it('allows five weapons', () => {
    const inv = new Inventory();
    for (const id of ['pistol', 'smg', 'ar', 'shotgun', 'sniper'] as const) {
      expect(inv.add(weapon(id)).ok).toBe(true);
    }
    expect(inv.totalWeaponCount()).toBe(5);
  });

  it('allows five healing stacks', () => {
    const inv = new Inventory();
    for (let i = 0; i < 5; i++) {
      expect(inv.add({ kind: 'heal', itemId: i % 2 ? 'medkit' : 'shieldpot', count: 1 }).ok).toBe(true);
    }
    // Everything stored is a heal (stacks may merge into fewer slots)
    expect(inv.slots.every((s) => s === null || s.kind === 'heal')).toBe(true);
    expect(inv.slots.some((s) => s !== null)).toBe(true);
  });
});

describe('heal stacking', () => {
  it('stacks same item up to stack size', () => {
    const inv = new Inventory();
    inv.add({ kind: 'heal', itemId: 'medkit', count: 1 });
    const res = inv.add({ kind: 'heal', itemId: 'medkit', count: 1 });
    expect(res.ok).toBe(true);
    // both in one slot
    expect(inv.slots.filter(Boolean).length).toBe(1);
    expect((inv.slots[0] as { count: number }).count).toBe(2);
  });

  it('overflow creates a second stack and respects cap of 2 per medkit stack', () => {
    const inv = new Inventory();
    inv.add({ kind: 'heal', itemId: 'medkit', count: 2 });
    inv.add({ kind: 'heal', itemId: 'medkit', count: 2 });
    const medkits = inv.slots.filter((s) => s?.kind === 'heal') as Array<{ count: number }>;
    expect(medkits.length).toBe(2);
    medkits.forEach((m) => expect(m.count).toBeLessThanOrEqual(2));
  });
});

describe('ammo & reload', () => {
  it('staged reload pulls discrete rounds from reserve without exceeding capacity', () => {
    const inv = new Inventory();
    const w = weapon('ar');
    w.ammoInMag = 5;
    inv.add(w);
    inv.ammo.medium = 100;
    expect(inv.loadReloadRounds(w, 25)).toBe(25);
    expect(w.ammoInMag).toBe(WEAPONS.ar.magSize);
    expect(inv.ammo.medium).toBe(100 - (WEAPONS.ar.magSize - 5));
  });

  it('does not consume reserve when a staged request loads no round', () => {
    const inv = new Inventory();
    const w = weapon('pistol');
    w.ammoInMag = 4;
    inv.add(w);
    inv.ammo.light = 10;
    expect(inv.loadReloadRounds(w, 0.9)).toBe(0);
    expect(w.ammoInMag).toBe(4);
    expect(inv.ammo.light).toBe(10);
  });

  it('cannot reload with empty reserve', () => {
    const inv = new Inventory();
    const w = weapon('smg');
    w.ammoInMag = 0;
    inv.add(w);
    expect(inv.ammo.light).toBe(0);
    expect(inv.startReload(w)).toBe(false);
  });

  it('addAmmo caps at reserve max', () => {
    const inv = new Inventory();
    const added = inv.addAmmo('light', 9999, WEAPONS.pistol.reserveMax);
    expect(added).toBe(WEAPONS.pistol.reserveMax);
    expect(inv.ammo.light).toBe(WEAPONS.pistol.reserveMax);
  });
});

describe('selection', () => {
  it('selects valid slots only and cycles through fists and occupied slots', () => {
    const inv = new Inventory();
    inv.add(weapon('ar'), 0);
    inv.add(weapon('pistol'), 4);
    expect(inv.selected).toBe(MELEE_SLOT); // starts on fists
    expect(inv.select(1)).toBe(false);
    expect(inv.selected).toBe(MELEE_SLOT);
    inv.cycle(1); // fists → first occupied slot
    expect(inv.selected).toBe(0);
    inv.cycle(1); // → slot 4 (next non-empty)
    expect(inv.selected).toBe(4);
    inv.cycle(-1); // back to slot 0
    expect(inv.selected).toBe(0);
    inv.cycle(-1); // wraps to fists
    expect(inv.selected).toBe(MELEE_SLOT);
  });

  it('removing the selected slot falls back to fists', () => {
    const inv = new Inventory();
    inv.add(weapon('ar'));
    inv.add(weapon('pistol'));
    inv.select(0);
    inv.removeSlot(0);
    expect(inv.isMeleeSelected).toBe(true);
    expect(inv.selectedWeapon).toBeNull();
  });

  it('swaps occupied and empty slots while keeping selection on the item', () => {
    const inv = new Inventory();
    const ar = weapon('ar');
    inv.add(ar, 0);
    inv.select(0);

    expect(inv.swapSlots(0, 3)).toBe(true);
    expect(inv.slots[0]).toBeNull();
    expect(inv.slots[3]).toBe(ar);
    expect(inv.selected).toBe(3);
  });

  it('swaps two items and rejects non-inventory indices', () => {
    const inv = new Inventory();
    const ar = weapon('ar');
    const pistol = weapon('pistol');
    inv.add(ar, 0);
    inv.add(pistol, 1);

    expect(inv.swapSlots(0, 1)).toBe(true);
    expect(inv.slots[0]).toBe(pistol);
    expect(inv.slots[1]).toBe(ar);
    expect(inv.swapSlots(MELEE_SLOT, 1)).toBe(false);
    expect(inv.swapSlots(0, INVENTORY_SLOTS)).toBe(false);
  });

  it('never writes a hidden -1 slot when full while fists are selected', () => {
    const inv = new Inventory();
    for (const id of ['pistol', 'smg', 'ar', 'shotgun', 'sniper'] as const) inv.add(weapon(id));

    const result = inv.add(weapon('ar', 'legendary'));
    expect(result.ok).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(inv.slots, '-1')).toBe(false);
    expect(inv.slots).toHaveLength(5);
  });

  it('judges full-inventory upgrades against the weakest weapon, not the held slot', () => {
    const inv = new Inventory();
    inv.add(weapon('pistol', 'legendary'));
    inv.add(weapon('smg', 'common'));
    inv.add(weapon('ar', 'rare'));
    inv.add(weapon('shotgun', 'rare'));
    inv.add(weapon('sniper', 'epic'));
    inv.select(0);

    expect(inv.wouldUpgradeWeapon(weapon('ar', 'uncommon'))).toBe(true);
    expect(inv.wouldUpgradeWeapon(weapon('ar', 'common'))).toBe(false);
    expect(inv.worstWeaponSlot()).toBe(1);
  });
});
