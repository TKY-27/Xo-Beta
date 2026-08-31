import type { PreferredItemCategory, PreferredItemSlots } from '../core/preferredSlots';
import { isPreferredItemSlots } from '../core/preferredSlots';
import { HEAL_ITEMS } from '../core/balance';
import type { Inventory, InventoryItem } from './inventory';

const WEAPON_CATEGORIES: Readonly<Record<string, PreferredItemCategory>> = Object.freeze({
  shotgun: 'shotgun',
  smg: 'smg',
  ar: 'ar',
  sniper: 'sniper',
  pistol: 'pistol',
});

export function preferredCategoryForItem(item: InventoryItem): PreferredItemCategory {
  if (item.kind === 'heal') return 'healing';
  return WEAPON_CATEGORIES[item.weaponId] ?? 'none';
}

/**
 * Resolve only an empty preferred slot. Inventory.add remains responsible for
 * stacking heals first and for the ordinary empty-slot fallback; a preference
 * never authorizes overwriting an occupied item.
 */
export function resolvePreferredPickupSlot(
  inventory: Pick<Inventory, 'slots'>,
  item: InventoryItem,
  preferences: PreferredItemSlots,
): number | undefined {
  if (!isPreferredItemSlots(preferences) || !preferences.enabled) return undefined;

  // The canonical add path stacks an existing heal before consulting a slot.
  // Returning undefined here preserves that ordering for every caller.
  if (item.kind === 'heal' && inventory.slots.some((slot) =>
    slot?.kind === 'heal'
      && slot.itemId === item.itemId
      && slot.count < HEAL_ITEMS[item.itemId].stackSize)) return undefined;

  const category = preferredCategoryForItem(item);
  if (category === 'none') return undefined;
  for (let slot = 0; slot < preferences.slots.length; slot++) {
    if (preferences.slots[slot] === category && inventory.slots[slot] === null) return slot;
  }
  return undefined;
}
