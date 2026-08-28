/**
 * Inventory: 5 universal slots (weapons or heal stacks) + shared ammo pools.
 * Pure data logic — no physics/rendering — fully unit-testable.
 */

import type { AmmoType, HealItemId, Rarity, WeaponId } from '../core/balance';
import { HEAL_ITEMS, RARITIES, WEAPONS } from '../core/balance';

export interface WeaponInstance {
  kind: 'weapon';
  weaponId: WeaponId;
  rarity: Rarity;
  ammoInMag: number;
}

export interface HealStack {
  kind: 'heal';
  itemId: HealItemId;
  count: number;
}

export type InventoryItem = WeaponInstance | HealStack;

export interface AmmoPools {
  light: number;
  medium: number;
  shells: number;
  heavy: number;
}

export function emptyAmmoPools(): AmmoPools {
  return { light: 0, medium: 0, shells: 0, heavy: 0 };
}

export const INVENTORY_SLOTS = 5;

/**
 * Fists are a permanent pseudo-slot rendered left of the five inventory
 * slots in the HUD. It does NOT consume an inventory slot; `selected = MELEE_SLOT`
 * means the actor is unarmed (melee only).
 */
export const MELEE_SLOT = -1;

export class Inventory {
  slots: Array<InventoryItem | null> = [null, null, null, null, null];
  /** -1 = fists (permanent melee pseudo-slot), 0..4 = inventory slots. */
  selected = MELEE_SLOT;
  ammo: AmmoPools = emptyAmmoPools();

  get isMeleeSelected(): boolean {
    return this.selected === MELEE_SLOT;
  }

  get selectedItem(): InventoryItem | null {
    if (this.selected === MELEE_SLOT) return null;
    return this.slots[this.selected] ?? null;
  }

  get selectedWeapon(): WeaponInstance | null {
    const it = this.selectedItem;
    return it && it.kind === 'weapon' ? it : null;
  }

  /** Returns displaced item if the slot was occupied by a different item. */
  add(item: InventoryItem, preferSlot?: number): { ok: boolean; displaced?: InventoryItem; slot?: number } {
    if (item.kind === 'heal') {
      // Stack first
      for (let i = 0; i < INVENTORY_SLOTS; i++) {
        const s = this.slots[i];
        if (s && s.kind === 'heal' && s.itemId === item.itemId && s.count < HEAL_ITEMS[s.itemId].stackSize) {
          const def = HEAL_ITEMS[item.itemId];
          const space = def.stackSize - s.count;
          const take = Math.min(space, item.count);
          s.count += take;
          item.count -= take;
          if (item.count <= 0) return { ok: true, slot: i };
        }
      }
    }
    // Preferred slot if empty
    if (preferSlot !== undefined && this.slots[preferSlot] === null) {
      this.slots[preferSlot] = item;
      return { ok: true, slot: preferSlot };
    }
    // Any empty slot
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      if (this.slots[i] === null) {
        this.slots[i] = item;
        return { ok: true, slot: i };
      }
    }
    // Full: swap only with an actual inventory slot. Fists are index -1 and
    // must never become a hidden array property (which caused endless bot
    // pick/drop churn). A caller may provide an explicit bot upgrade slot.
    const swapSlot = preferSlot ?? this.selected;
    if (swapSlot < 0 || swapSlot >= INVENTORY_SLOTS) return { ok: false };
    const displaced = this.slots[swapSlot]!;
    this.slots[swapSlot] = item;
    return { ok: true, displaced, slot: swapSlot };
  }

  removeSlot(slot: number): InventoryItem | null {
    if (!Number.isInteger(slot) || slot < 0 || slot >= INVENTORY_SLOTS) return null;
    const it = this.slots[slot];
    this.slots[slot] = null;
    if (this.selected === slot) {
      // Prefer fists over force-cycling: unarmed is always valid.
      this.selected = MELEE_SLOT;
    }
    return it ?? null;
  }

  /**
   * Swap two inventory slots, including an occupied slot with an empty one.
   * Selection follows the item so dragging the equipped item never silently
   * changes what is in the player's hands. Fists (-1) are not draggable.
   */
  swapSlots(from: number, to: number): boolean {
    if (!Number.isInteger(from) || !Number.isInteger(to)
      || from < 0 || from >= INVENTORY_SLOTS || to < 0 || to >= INVENTORY_SLOTS) {
      return false;
    }
    if (from === to) return true;

    const item = this.slots[from] ?? null;
    this.slots[from] = this.slots[to] ?? null;
    this.slots[to] = item;

    if (this.selected === from) this.selected = to;
    else if (this.selected === to) this.selected = from;
    return true;
  }

  /** Switch to the permanent fists pseudo-slot. */
  selectMelee(): void {
    this.selected = MELEE_SLOT;
  }

  select(slot: number): boolean {
    if (slot < 0 || slot >= INVENTORY_SLOTS) return false;
    if (this.slots[slot] === null) return false;
    this.selected = slot;
    return true;
  }

  cycle(dir: number): void {
    // Ordered selection ring: fists (lowest) → occupied slots ascending.
    const order: number[] = [MELEE_SLOT];
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      if (this.slots[i] !== null) order.push(i);
    }
    if (order.length === 1) {
      this.selected = MELEE_SLOT;
      return;
    }
    let pos = order.indexOf(this.selected);
    if (pos === -1) pos = dir > 0 ? -1 : 1;
    this.selected = order[(pos + dir + order.length) % order.length]!;
  }

  selectFirstAvailable(): void {
    if (this.isMeleeSelected) return;
    if (this.slots[this.selected] !== null) return;
    // Nothing held → fists.
    this.selected = MELEE_SLOT;
  }

  addAmmo(type: AmmoType, amount: number, reserveMax: number): number {
    const before = this.ammo[type];
    const after = Math.min(reserveMax, before + amount);
    this.ammo[type] = after;
    return after - before;
  }

  /** Consume ammo from mag; returns false when empty. */
  consumeMagRound(w: WeaponInstance): boolean {
    if (w.ammoInMag <= 0) return false;
    w.ammoInMag--;
    return true;
  }

  startReload(w: WeaponInstance): boolean {
    const def = WEAPONS[w.weaponId];
    if (w.ammoInMag >= def.magSize) return false;
    if (this.ammo[def.ammoType] <= 0) return false;
    return true;
  }

  /**
   * Transfer a discrete number of rounds from reserve into a magazine.
   * Reloading is deliberately incremental: callers invoke this as the
   * reload animation advances, so a cancelled reload keeps only rounds that
   * were visibly loaded and never consumes the remainder up front.
   */
  loadReloadRounds(w: WeaponInstance, requested: number): number {
    if (!Number.isFinite(requested) || requested <= 0) return 0;
    const def = WEAPONS[w.weaponId];
    const need = def.magSize - w.ammoInMag;
    const take = Math.min(Math.floor(requested), need, this.ammo[def.ammoType]);
    if (take <= 0) return 0;
    w.ammoInMag += take;
    this.ammo[def.ammoType] -= take;
    return take;
  }

  /** Can this item be stored without a forced swap? */
  canStore(item: InventoryItem): boolean {
    const empty = this.slots.some((s) => s === null);
    if (empty) return true;
    if (item.kind === 'heal') {
      // stackable onto an existing partial stack?
      return this.slots.some((s) => s && s.kind === 'heal' && s.itemId === item.itemId && s.count < HEAL_ITEMS[item.itemId].stackSize);
    }
    return false;
  }

  /** Would storing this weapon be an upgrade over what we'd displace? */
  wouldUpgradeWeapon(w: WeaponInstance): boolean {
    if (this.slots.some((s) => s === null)) return true;
    const rank = (r: Rarity): number => RARITIES.indexOf(r);
    const slot = this.worstWeaponSlot();
    if (slot === null) return true; // full of heals: first weapon is useful
    const current = this.slots[slot] as WeaponInstance;
    return rank(w.rarity) > rank(current.rarity);
  }

  /** Lowest-rarity weapon slot, with stable slot order for ties. */
  worstWeaponSlot(): number | null {
    let best: number | null = null;
    let bestRank = Infinity;
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const item = this.slots[i];
      if (item?.kind !== 'weapon') continue;
      const rank = RARITIES.indexOf(item.rarity);
      if (rank < bestRank) {
        best = i;
        bestRank = rank;
      }
    }
    return best;
  }

  totalWeaponCount(): number {
    let n = 0;
    for (const s of this.slots) if (s?.kind === 'weapon') n++;
    return n;
  }

  findHeal(itemId: HealItemId): { slot: number; stack: HealStack } | null {
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const s = this.slots[i];
      if (s && s.kind === 'heal' && s.itemId === itemId && s.count > 0) {
        return { slot: i, stack: s };
      }
    }
    return null;
  }

  consumeHeal(itemId: HealItemId): boolean {
    const found = this.findHeal(itemId);
    if (!found) return false;
    found.stack.count--;
    if (found.stack.count <= 0) this.removeSlot(found.slot);
    return true;
  }
}
