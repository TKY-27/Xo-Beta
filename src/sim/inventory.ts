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

export class Inventory {
  slots: Array<InventoryItem | null> = [null, null, null, null, null];
  selected = 0;
  ammo: AmmoPools = emptyAmmoPools();

  get selectedItem(): InventoryItem | null {
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
    // Full: swap with selected slot
    const sel = this.selected;
    const displaced = this.slots[sel]!;
    this.slots[sel] = item;
    return { ok: true, displaced, slot: sel };
  }

  removeSlot(slot: number): InventoryItem | null {
    const it = this.slots[slot];
    this.slots[slot] = null;
    if (this.selected === slot) this.selectFirstAvailable();
    return it ?? null;
  }

  select(slot: number): boolean {
    if (slot < 0 || slot >= INVENTORY_SLOTS) return false;
    if (this.slots[slot] === null) return false;
    this.selected = slot;
    return true;
  }

  cycle(dir: number): void {
    for (let step = 1; step <= INVENTORY_SLOTS; step++) {
      const idx = (this.selected + dir * step + INVENTORY_SLOTS * 4) % INVENTORY_SLOTS;
      if (this.slots[idx] !== null) {
        this.selected = idx;
        return;
      }
    }
  }

  selectFirstAvailable(): void {
    if (this.slots[this.selected] !== null) return;
    this.cycle(1);
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

  finishReload(w: WeaponInstance): void {
    const def = WEAPONS[w.weaponId];
    const need = def.magSize - w.ammoInMag;
    const take = Math.min(need, this.ammo[def.ammoType]);
    w.ammoInMag += take;
    this.ammo[def.ammoType] -= take;
  }

  cancelReloadPreserve(w: WeaponInstance): void {
    // Mag content is already authoritative; nothing to refund.
    void w;
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
    const sel = this.selectedWeapon;
    if (!sel) return true;
    const rank = (r: Rarity): number => RARITIES.indexOf(r);
    return rank(w.rarity) > rank(sel.rarity);
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
