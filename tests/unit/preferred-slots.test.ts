import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERRED_ITEM_SLOTS,
  safePreferredItemSlots,
  validatePreferredItemSlots,
} from '../../src/core/preferredSlots';
import { Inventory } from '../../src/sim/inventory';
import { resolvePreferredPickupSlot } from '../../src/sim/preferredSlots';

const prefs = (slots: ['none' | 'shotgun' | 'smg' | 'ar' | 'sniper' | 'pistol' | 'healing', ...Array<'none' | 'shotgun' | 'smg' | 'ar' | 'sniper' | 'pistol' | 'healing'>]): ReturnType<typeof validatePreferredItemSlots> =>
  validatePreferredItemSlots({ enabled: true, slots });

describe('preferred pickup slots', () => {
  it('uses exactly five allowlisted categories and rejects inherited/prototype data', () => {
    expect(validatePreferredItemSlots({ enabled: true, slots: ['ar', 'smg', 'shotgun', 'sniper', 'pistol'] }).slots).toEqual([
      'ar', 'smg', 'shotgun', 'sniper', 'pistol',
    ]);
    expect(() => validatePreferredItemSlots({ enabled: true, slots: ['__proto__', 'none', 'none', 'none', 'none'] })).toThrow();
    const polluted = Object.create({ slots: ['ar', 'none', 'none', 'none', 'none'] }) as { enabled: boolean };
    polluted.enabled = true;
    expect(() => validatePreferredItemSlots(polluted)).toThrow();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('falls back to disabled none values for malformed persisted settings', () => {
    expect(safePreferredItemSlots({ enabled: 'yes', slots: [] })).toEqual(DEFAULT_PREFERRED_ITEM_SLOTS);
    expect(safePreferredItemSlots(undefined)).toEqual(DEFAULT_PREFERRED_ITEM_SLOTS);
  });

  it('resolves a matching empty slot without overwriting occupied items', () => {
    const inv = new Inventory();
    inv.add({ kind: 'weapon', weaponId: 'pistol', rarity: 'common', ammoInMag: 12 }, 0);
    expect(resolvePreferredPickupSlot(inv, { kind: 'weapon', weaponId: 'ar', rarity: 'rare', ammoInMag: 30 }, prefs(['none', 'ar', 'none', 'none', 'none']))).toBe(1);
    expect(resolvePreferredPickupSlot(inv, { kind: 'weapon', weaponId: 'ar', rarity: 'rare', ammoInMag: 30 }, prefs(['pistol', 'ar', 'none', 'none', 'none']))).toBe(1);
  });

  it('preserves heal stacking before preferred placement and uses preference after a full stack', () => {
    const inv = new Inventory();
    inv.add({ kind: 'heal', itemId: 'medkit', count: 1 }, 0);
    expect(resolvePreferredPickupSlot(inv, { kind: 'heal', itemId: 'medkit', count: 1 }, prefs(['healing', 'none', 'none', 'none', 'none']))).toBeUndefined();
    inv.slots[0] = { kind: 'heal', itemId: 'medkit', count: 2 };
    expect(resolvePreferredPickupSlot(inv, { kind: 'heal', itemId: 'medkit', count: 1 }, prefs(['none', 'healing', 'none', 'none', 'none']))).toBe(1);
  });
});
