import { beforeAll, describe, expect, it } from 'vitest';
import { RAPIER_READY } from '../../src/world/rapierReady';
import { loadMap } from '../../src/world';
import { Match } from '../../src/sim/match';
import { WEAPONS } from '../../src/core/balance';

beforeAll(async () => {
  await RAPIER_READY();
});

async function makePractice(): Promise<Match> {
  const loaded = await loadMap('eden');
  return new Match({
    mapDef: loaded.def,
    seed: 120034,
    difficulty: 'normal',
    withPlayer: true,
    practice: true,
  });
}

describe('player inventory UI simulation API', () => {
  it('selects and reorders slots while cancelling only the moved weapon reload', async () => {
    const match = await makePractice();
    const player = match.player!;
    const ar = { kind: 'weapon' as const, weaponId: 'ar' as const, rarity: 'common' as const, ammoInMag: 5 };
    const heal = { kind: 'heal' as const, itemId: 'shieldpot' as const, count: 1 };
    player.inv.add(ar, 0);
    player.inv.add(heal, 1);
    expect(match.selectPlayerInventorySlot(0)).toBe(true);
    expect(player.inv.selected).toBe(0);
    player.wpn.reloadTimer = 1;
    player.wpn.reloadTotal = 2;
    player.wpn.reloadWeaponId = 'ar';
    player.wpn.reloadInitialAmmo = 5;
    player.wpn.reloadRoundsLoaded = 2;
    player.wpn.swapTimer = 0;
    expect(match.selectPlayerInventorySlot(0)).toBe(true);
    expect(player.wpn.reloadTimer).toBe(1);
    expect(player.wpn.swapTimer).toBe(0);

    player.wpn.reloadTimer = 1;
    player.wpn.reloadTotal = 2;
    player.wpn.reloadWeaponId = 'ar';
    player.wpn.reloadInitialAmmo = 5;
    player.wpn.reloadRoundsLoaded = 2;

    expect(match.reorderPlayerInventory(0, 3)).toBe(true);
    expect(player.inv.selected).toBe(3);
    expect(player.inv.slots[3]).toBe(ar);
    expect(player.inv.slots[0]).toBeNull();
    expect(player.wpn.reloadTimer).toBe(0);
    expect(player.wpn.reloadRoundsLoaded).toBe(0);
    expect(player.wpn.reloadWeaponId).toBeNull();

    expect(match.selectPlayerInventorySlot(1)).toBe(true);
    expect(player.inv.selected).toBe(1);
    expect(player.wpn.swapTimer).toBeGreaterThan(0);
    match.dispose();
  }, 30_000);

  it('drops selected weapons and non-weapon healing stacks through one API', async () => {
    const match = await makePractice();
    const player = match.player!;
    const weapon = { kind: 'weapon' as const, weaponId: 'pistol' as const, rarity: 'rare' as const, ammoInMag: WEAPONS.pistol.magSize };
    const heal = { kind: 'heal' as const, itemId: 'medkit' as const, count: 1 };
    player.inv.add(weapon, 0);
    player.inv.add(heal, 1);
    expect(match.selectPlayerInventorySlot(0)).toBe(true);
    expect(match.dropPlayerInventorySlot(0)).toBe(true);
    expect(player.inv.slots[0]).toBeNull();
    const droppedWeapon = match.loot.items.find((item) => item.kind === 'weapon' && item.weapon?.weaponId === 'pistol');
    expect(droppedWeapon).toBeDefined();
    expect(match.nearestInteractableItem(player)).not.toBe(droppedWeapon);
    match.loot.time = droppedWeapon!.pickupLockedUntil!;
    expect(match.nearestInteractableItem(player)).toBe(droppedWeapon);
    expect(match.dropPlayerInventorySlot(1)).toBe(true);
    expect(player.inv.slots[1]).toBeNull();
    expect(match.loot.items.some((item) => item.kind === 'heal' && item.heal?.itemId === 'medkit')).toBe(true);
    expect(match.dropPlayerInventorySlot(1)).toBe(false);
    match.dispose();
  }, 30_000);

  it('chooses the nearest floor item from feet with deterministic id tie-breaks', async () => {
    const match = await makePractice();
    const player = match.player!;
    const p = player.body.position;
    const first = match.loot.spawnWeapon(p.x + 1.1, p.y - 1.35, p.z, {
      kind: 'weapon', weaponId: 'pistol', rarity: 'common', ammoInMag: WEAPONS.pistol.magSize,
    }, match.rng);
    const second = match.loot.spawnWeapon(p.x + 1.1, p.y - 1.35, p.z, {
      kind: 'weapon', weaponId: 'ar', rarity: 'rare', ammoInMag: WEAPONS.ar.magSize,
    }, match.rng);
    expect(match.nearestInteractableItem(player)?.id).toBe(first.id);

    second.x = p.x + 0.4;
    expect(match.nearestInteractableItem(player)?.id).toBe(second.id);
    match.dispose();
  }, 30_000);

  it('uses the same floor-aware chest resolver for prompts and interaction', async () => {
    const match = await makePractice();
    const player = match.player!;
    const p = player.body.position;
    const feetY = p.y - 1.35;
    match.chests.splice(0, match.chests.length,
      { id: 20, kind: 'vault', x: p.x + 0.25, y: feetY + 3.1, z: p.z, opened: false, openT: 0 },
      { id: 10, kind: 'standard', x: p.x + 1.25, y: feetY, z: p.z, opened: false, openT: 0 },
    );

    expect(match.nearestInteractableChest(player)?.id).toBe(10);
    match.tryInteract(player);
    expect(match.chests.find((chest) => chest.id === 10)?.opened).toBe(true);
    expect(match.chests.find((chest) => chest.id === 20)?.opened).toBe(false);
    match.dispose();
  }, 30_000);
});
