/**
 * Loot: randomized item generation, world item entities with polished
 * presentation data (bob/glow), chest opening, inventory drops on death.
 */

import {
  AMMO_PICKUP_AMOUNTS, CHESTS, FLOOR_RARITY_WEIGHTS, HEAL_ITEMS, RARITIES, RARITY_COLORS, WEAPONS,
  type AmmoType, type ChestKind, type HealItemId, type Rarity, type WeaponId,
} from '../core/balance';
import { Rng } from '../core/rng';
import type { Actor } from './actor';
import type { InventoryItem, WeaponInstance } from './inventory';

export type WorldItemKind = 'weapon' | 'ammo' | 'heal';

export interface WorldItem {
  id: number;
  kind: WorldItemKind;
  x: number;
  y: number;
  z: number;
  /** Presentation */
  bobPhase: number;
  rarity: Rarity;
  /** Contents (exactly one is set by kind) */
  weapon?: WeaponInstance;
  heal?: { itemId: HealItemId; count: number };
  ammo?: { type: AmmoType; amount: number };
  spawnT: number;
  /** Pop-out animation initial velocity. */
  vx: number;
  vy: number;
  vz: number;
  settled: boolean;
}

export interface LootEvents {
  onSpawn(item: WorldItem): void;
  onPickup(item: WorldItem, actor: Actor): void;
}

let nextItemId = 1;

export class LootSystem {
  items: WorldItem[] = [];
  time = 0;

  constructor(public events: LootEvents) {}

  rollRarity(rng: Rng, weights: readonly number[] = FLOOR_RARITY_WEIGHTS): Rarity {
    const idx = rng.weighted([...weights]);
    const table: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
    return table[idx] ?? 'common';
  }

  rollWeaponId(rng: Rng): WeaponId {
    // Slightly weighted toward common loadouts; sniper rarer on floor.
    const ids: readonly WeaponId[] = ['pistol', 'shotgun', 'ar', 'smg', 'sniper'];
    return ids[rng.weighted([24, 22, 26, 20, 8])] ?? 'pistol';
  }

  makeWeaponInstance(rng: Rng, rarity?: Rarity): WeaponInstance {
    const weaponId = this.rollWeaponId(rng);
    const r = rarity ?? this.rollRarity(rng);
    return { kind: 'weapon', weaponId, rarity: r, ammoInMag: WEAPONS[weaponId].magSize };
  }

  spawnWeapon(x: number, y: number, z: number, w: WeaponInstance, rng: Rng, pop = false): WorldItem {
    return this.spawn({
      kind: 'weapon', x, y, z, rarity: w.rarity, weapon: w,
      vx: pop ? rng.range(-2.4, 2.4) : 0,
      vy: pop ? rng.range(3.5, 6) : 0,
      vz: pop ? rng.range(-2.4, 2.4) : 0,
    }, rng);
  }

  spawnAmmo(x: number, y: number, z: number, type: AmmoType, amount: number, rng: Rng, pop = false): WorldItem {
    const rarityByAmmo: Record<AmmoType, Rarity> = { light: 'common', medium: 'uncommon', shells: 'uncommon', heavy: 'rare' };
    return this.spawn({
      kind: 'ammo', x, y, z, rarity: rarityByAmmo[type], ammo: { type, amount },
      vx: pop ? rng.range(-2.4, 2.4) : 0,
      vy: pop ? rng.range(3.5, 6) : 0,
      vz: pop ? rng.range(-2.4, 2.4) : 0,
    }, rng);
  }

  spawnHeal(x: number, y: number, z: number, itemId: HealItemId, count: number, rng: Rng, pop = false): WorldItem {
    const rarity: Rarity = itemId === 'medkit' ? 'rare' : 'uncommon';
    return this.spawn({
      kind: 'heal', x, y, z, rarity, heal: { itemId, count },
      vx: pop ? rng.range(-2.4, 2.4) : 0,
      vy: pop ? rng.range(3.5, 6) : 0,
      vz: pop ? rng.range(-2.4, 2.4) : 0,
    }, rng);
  }

  private spawn(partial: Omit<WorldItem, 'id' | 'bobPhase' | 'spawnT' | 'settled'>, rng: Rng): WorldItem {
    const item: WorldItem = {
      ...partial,
      id: nextItemId++,
      bobPhase: rng.angle(),
      spawnT: this.time,
      settled: false,
    };
    this.items.push(item);
    this.events.onSpawn(item);
    return item;
  }

  /** Roll a floor-loot item appropriate for the bias. */
  spawnFloorLoot(x: number, y: number, z: number, bias: 'weapon' | 'ammo' | 'heal' | undefined, rng: Rng): WorldItem {
    const kindRoll = bias
      ? bias
      : (['weapon', 'ammo', 'heal'] as const)[rng.weighted([52, 30, 18])];
    if (kindRoll === 'weapon') {
      return this.spawnWeapon(x, y, z, this.makeWeaponInstance(rng), rng);
    }
    if (kindRoll === 'ammo') {
      const type = rng.pick(['light', 'medium', 'shells', 'heavy'] as const);
      return this.spawnAmmo(x, y, z, type, Math.round(AMMO_PICKUP_AMOUNTS[type] * rng.range(0.7, 1.15)), rng);
    }
    const itemId = rng.bool(0.45) ? 'medkit' : 'shieldpot';
    return this.spawnHeal(x, y, z, itemId, 1, rng);
  }

  /** Open a chest: rolls rewards and pops them out around the chest. */
  openChest(kind: ChestKind, x: number, y: number, z: number, rng: Rng): WorldItem[] {
    const cfg = CHESTS[kind];
    const out: WorldItem[] = [];
    const rolls = rng.int(cfg.rolls[0], cfg.rolls[1]);
    let weaponDone = false;
    for (let i = 0; i < rolls; i++) {
      if (!weaponDone || rng.bool(0.25)) {
        const rarity = this.rollRarity(rng, cfg.rarityWeights);
        const w = this.makeWeaponInstance(rng, rarity);
        out.push(this.spawnWeapon(x, y + 0.5, z, w, rng, true));
        weaponDone = true;
        // Guarantee matching ammo with a weapon
        const def = WEAPONS[w.weaponId];
        out.push(this.spawnAmmo(x, y + 0.5, z, def.ammoType, Math.round(AMMO_PICKUP_AMOUNTS[def.ammoType] * 1.4), rng, true));
      } else if (rng.bool(cfg.healChance)) {
        const itemId = rng.bool(0.5) ? 'medkit' : 'shieldpot';
        out.push(this.spawnHeal(x, y + 0.5, z, itemId, 1, rng, true));
      } else {
        const type = rng.pick(['light', 'medium', 'shells', 'heavy'] as const);
        out.push(this.spawnAmmo(x, y + 0.5, z, type, Math.round(AMMO_PICKUP_AMOUNTS[type] * 1.3), rng, true));
      }
    }
    return out;
  }

  /** Drop an actor's whole inventory at its position (death drop). */
  dropInventory(actor: Actor, rng: Rng): void {
    const p = actor.body.position;
    for (const slot of actor.inv.slots) {
      if (!slot) continue;
      if (slot.kind === 'weapon') {
        this.spawnWeapon(p.x, p.y + 0.8, p.z, slot, rng, true);
      } else {
        this.spawnHeal(p.x, p.y + 0.8, p.z, slot.itemId, slot.count, rng, true);
      }
    }
    for (const [type, amount] of Object.entries(actor.inv.ammo)) {
      if (amount > 0) {
        this.spawnAmmo(p.x, p.y + 0.8, p.z, type as AmmoType, amount, rng, true);
      }
    }
  }

  /** Physics-lite settling for popped items + bob timing. */
  update(dt: number, surfaceQuery: (x: number, z: number, fromY: number) => number | null): void {
    this.time += dt;
    for (const it of this.items) {
      if (!it.settled) {
        it.vy -= 22 * dt;
        it.x += it.vx * dt;
        it.y += it.vy * dt;
        it.z += it.vz * dt;
        it.vx *= Math.exp(-2 * dt);
        it.vz *= Math.exp(-2 * dt);
        const ground = surfaceQuery(it.x, it.z, it.y + 1.5);
        if (ground !== null && it.y <= ground + 0.35) {
          it.y = ground + 0.35;
          it.settled = true;
          it.vx = 0; it.vy = 0; it.vz = 0;
        } else if (it.vy < -30) {
          it.settled = true;
        }
      }
    }
  }

  /** Attempt pickup; returns displaced item if inventory was full.
   *  swapIfBetterOnly: when inventory is full, only swap weapons for strictly
   *  higher rarity (prevents bot pick-up/drop churn). */
  pickup(item: WorldItem, actor: Actor, swapIfBetterOnly = false): InventoryItem | null | false {
    if (item.kind === 'weapon' && item.weapon) {
      if (swapIfBetterOnly && actor.inv.slots.every((s) => s !== null)) {
        const cur = actor.inv.selectedWeapon;
        if (cur && rarityRank(item.weapon.rarity) <= rarityRank(cur.rarity)) return false;
      }
      const res = actor.inv.add({ ...item.weapon });
      if (!res.ok) return false;
      this.remove(item);
      this.events.onPickup(item, actor);
      return res.displaced ?? null;
    }
    if (item.kind === 'ammo' && item.ammo) {
      const added = actor.inv.addAmmo(item.ammo.type, item.ammo.amount, WEAPONS_MAX_RESERVE[item.ammo.type]);
      if (added <= 0) return false;
      this.remove(item);
      this.events.onPickup(item, actor);
      return null;
    }
    if (item.kind === 'heal' && item.heal) {
      const res = actor.inv.add({ kind: 'heal', itemId: item.heal.itemId, count: item.heal.count });
      if (!res.ok) return false;
      this.remove(item);
      this.events.onPickup(item, actor);
      return res.displaced ?? null;
    }
    return false;
  }

  remove(item: WorldItem): void {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
  }

  nearestItem(x: number, y: number, z: number, maxDist: number, filter?: (it: WorldItem) => boolean): WorldItem | null {
    let best: WorldItem | null = null;
    let bestD = maxDist * maxDist;
    for (const it of this.items) {
      if (filter && !filter(it)) continue;
      const dx = it.x - x, dy = it.y - y, dz = it.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }
}

export const WEAPONS_MAX_RESERVE: Record<AmmoType, number> = {
  light: WEAPONS.pistol.reserveMax,
  medium: WEAPONS.ar.reserveMax,
  shells: WEAPONS.shotgun.reserveMax,
  heavy: WEAPONS.sniper.reserveMax,
};

function rarityRank(r: Rarity): number {
  return RARITIES.indexOf(r);
}

export function itemGlowColor(it: WorldItem): number {
  if (it.kind === 'heal' && it.heal) return HEAL_ITEMS[it.heal.itemId].color;
  if (it.kind === 'ammo') return 0xbfc9d4;
  return RARITY_COLORS[it.rarity];
}
