/**
 * The five inventory positions may optionally have a preferred item category.
 * This module contains only data validation so the same contract can be used
 * by settings, the lobby admission profile, and the authoritative simulation.
 */

export type PreferredItemCategory =
  | 'none'
  | 'shotgun'
  | 'smg'
  | 'ar'
  | 'sniper'
  | 'pistol'
  | 'healing';

export const PREFERRED_ITEM_CATEGORIES: readonly PreferredItemCategory[] = Object.freeze([
  'none', 'shotgun', 'smg', 'ar', 'sniper', 'pistol', 'healing',
]);

export type PreferredItemSlotList = readonly [
  PreferredItemCategory,
  PreferredItemCategory,
  PreferredItemCategory,
  PreferredItemCategory,
  PreferredItemCategory,
];

export interface PreferredItemSlots {
  readonly enabled: boolean;
  readonly slots: PreferredItemSlotList;
}

const DEFAULT_SLOT_LIST: PreferredItemSlotList = Object.freeze([
  'none', 'none', 'none', 'none', 'none',
]) as PreferredItemSlotList;

export const DEFAULT_PREFERRED_ITEM_SLOTS: PreferredItemSlots = Object.freeze({
  enabled: false,
  slots: DEFAULT_SLOT_LIST,
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Return a deeply immutable copy of a validated preference object. */
export function clonePreferredItemSlots(value: PreferredItemSlots): PreferredItemSlots {
  return Object.freeze({
    enabled: value.enabled,
    slots: Object.freeze([...value.slots]) as PreferredItemSlotList,
  });
}

/**
 * Validate an untrusted settings/profile value. The function deliberately
 * requires an object with one boolean and exactly five allowlisted strings;
 * inherited keys and prototype-bearing objects are not accepted.
 */
export function validatePreferredItemSlots(value: unknown): PreferredItemSlots {
  if (!isPlainRecord(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.slots)
    || value.slots.length !== 5) {
    throw new Error('Invalid preferred item slot settings');
  }
  const slots = value.slots.map((slot) => {
    if (typeof slot !== 'string' || !PREFERRED_ITEM_CATEGORIES.includes(slot as PreferredItemCategory)) {
      throw new Error('Invalid preferred item slot category');
    }
    return slot as PreferredItemCategory;
  }) as unknown as PreferredItemSlotList;
  return Object.freeze({
    enabled: value.enabled,
    slots: Object.freeze(slots),
  });
}

/** Safe local-storage merge helper: malformed persisted data falls back. */
export function safePreferredItemSlots(
  value: unknown,
  fallback: PreferredItemSlots = DEFAULT_PREFERRED_ITEM_SLOTS,
): PreferredItemSlots {
  try {
    return validatePreferredItemSlots(value);
  } catch {
    return clonePreferredItemSlots(fallback);
  }
}

export function isPreferredItemSlots(value: unknown): value is PreferredItemSlots {
  try {
    validatePreferredItemSlots(value);
    return true;
  } catch {
    return false;
  }
}
