import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../../src/core/balance';
import { Actor } from '../../src/sim/actor';
import { CombatSystem, type CombatEvents } from '../../src/sim/combat';
import { MovementSystem } from '../../src/sim/movement';

function actorWithPistol(ammoInMag: number): Actor {
  const body = {
    actorId: 1,
    position: { x: 0, y: 1.6, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
  } as never;
  const actor = new Actor('TEST', true, body, 0xffffff);
  actor.inv.add({ kind: 'weapon', weaponId: 'pistol', rarity: 'common', ammoInMag });
  actor.inv.select(0);
  return actor;
}

function events(
  shots: Array<{ dry: boolean; x?: number; y?: number; z?: number }>,
  tracers: number[],
  flashes: Array<{ x: number; y: number; z: number }> = [],
  reloads: boolean[] = [],
): CombatEvents {
  return {
    onMuzzleFlash: (_actor, _weapon, x, y, z) => flashes.push({ x, y, z }),
    onShotFired: (_actor, _weapon, x, y, z, dry) => shots.push({ dry, x, y, z }),
    onReloadStarted: (_actor, empty) => reloads.push(empty),
    onImpact: () => undefined,
    onActorHit: () => undefined,
    onTracer: () => { tracers[0] = (tracers[0] ?? 0) + 1; },
    onRicochet: () => undefined,
    onGlassBreak: () => undefined,
    onDestructibleDamaged: () => undefined,
    onMeleeSwing: () => undefined,
    onMeleeHit: () => undefined,
  };
}

describe('authoritative firearm edges', () => {
  it('fires the last real round as a non-dry shot and emits a tracer segment', () => {
    const shots: Array<{ dry: boolean; x?: number; y?: number; z?: number }> = [];
    const tracers = [0];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem({ raycast: () => null } as never, movement, events(shots, tracers));
    const actor = actorWithPistol(1);

    expect(combat.tryFire(actor, 1 / 60)).toBe(true);
    expect(actor.inv.selectedWeapon?.ammoInMag).toBe(0);
    expect(shots).toMatchObject([{ dry: false }]);
    combat.update(1 / 60, [actor]);
    expect(tracers[0]).toBeGreaterThan(0);
    const afterFirstStep = tracers[0]!;
    combat.update(1 / 60, [actor]);
    // A moving projectile publishes its complete short-lived trail, not only
    // the first ~2.8u substep after the muzzle.
    expect(tracers[0]).toBeGreaterThan(afterFirstStep);

    // Cooldown advances on the fixed weapon timer, independent of whether a
    // semi-auto trigger is held. Once the 200 ms cycle has elapsed, the empty
    // click is explicit dry.
    combat.updateWeaponTimers(actor, 0.2);
    expect(combat.tryFire(actor, 0)).toBe(false);
    expect(shots).toMatchObject([{ dry: false }, { dry: true }]);
  });

  it('allows the next pistol click after its fixed cycle without a held trigger', () => {
    const shots: Array<{ dry: boolean }> = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem({ raycast: () => null } as never, movement, events(shots, [0]));
    const actor = actorWithPistol(2);

    expect(combat.tryFire(actor, 0)).toBe(true);
    expect(combat.tryFire(actor, 0)).toBe(false);
    combat.updateWeaponTimers(actor, 60 / WEAPONS.pistol.rpm);
    expect(combat.tryFire(actor, 0)).toBe(true);
    expect(shots.filter((shot) => !shot.dry)).toHaveLength(2);
  });

  it('shares a canonical muzzle between projectile, flash and gunshot audio event', () => {
    const shots: Array<{ dry: boolean; x?: number; y?: number; z?: number }> = [];
    const flashes: Array<{ x: number; y: number; z: number }> = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem({ raycast: () => null } as never, movement, events(shots, [0], flashes));
    const actor = actorWithPistol(2);

    expect(combat.tryFire(actor, 1 / 60)).toBe(true);
    const projectile = combat.projectiles.find((p) => p.active)!;
    expect(flashes[0]).toEqual({ x: projectile.x, y: projectile.y, z: projectile.z });
    expect(shots[0]).toMatchObject({ dry: false, x: projectile.x, y: projectile.y, z: projectile.z });
  });

  it('recycles the closest-to-expiry projectile instead of producing an audio-only shot', () => {
    const shots: Array<{ dry: boolean; x?: number; y?: number; z?: number }> = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem({ raycast: () => null } as never, movement, events(shots, [0]));
    for (let i = 0; i < combat.projectiles.length; i++) {
      const projectile = combat.projectiles[i]!;
      projectile.active = true;
      projectile.ownerId = 99;
      projectile.life = 2 + i / 1000;
    }
    const actor = actorWithPistol(2);

    expect(combat.tryFire(actor, 1 / 60)).toBe(true);
    expect(combat.projectiles.some((p) => p.ownerId === actor.id && p.life === 3.2)).toBe(true);
    expect(shots).toMatchObject([{ dry: false }]);
  });

  it('keeps pistol cadence at the configured 300 RPM minimum', () => {
    expect(WEAPONS.pistol.rpm).toBe(300);
    expect(60 / WEAPONS.pistol.rpm).toBeCloseTo(0.2, 8);
  });

  it('automatically starts a staged reload after the last real round', () => {
    const shots: Array<{ dry: boolean }> = [];
    const reloads: boolean[] = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem(
      { raycast: () => null } as never,
      movement,
      events(shots, [0], [], reloads),
    );
    const actor = actorWithPistol(1);
    actor.inv.ammo.light = 11;

    expect(combat.tryFire(actor, 1 / 60)).toBe(true);
    expect(actor.inv.selectedWeapon?.ammoInMag).toBe(0);
    expect(actor.wpn.reloadTimer).toBeGreaterThan(0);
    expect(reloads).toEqual([true]);
    expect(shots[0]?.dry).toBe(false);
  });

  it('loads rounds in proportion to elapsed reload time and consumes reserve as loaded', () => {
    const shots: Array<{ dry: boolean }> = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem({ raycast: () => null } as never, movement, events(shots, [0]));
    const actor = actorWithPistol(1);
    actor.inv.ammo.light = 11;
    expect(combat.tryFire(actor, 1 / 60)).toBe(true);
    const total = actor.wpn.reloadTotal;
    combat.updateWeaponTimers(actor, total / 2);

    // Pistol mag is 15, so half of the 15-round deficit is loaded at 50%.
    expect(actor.inv.selectedWeapon?.ammoInMag).toBe(Math.floor(WEAPONS.pistol.magSize / 2));
    expect(actor.inv.ammo.light).toBe(11 - Math.floor(WEAPONS.pistol.magSize / 2));
    expect(actor.wpn.reloadTimer).toBeGreaterThan(0);
  });

  it('cancels a staged reload on a click once at least one round is loaded', () => {
    const shots: Array<{ dry: boolean }> = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem({ raycast: () => null } as never, movement, events(shots, [0]));
    const actor = actorWithPistol(1);
    actor.inv.ammo.light = 11;
    expect(combat.tryFire(actor, 1 / 60)).toBe(true);
    combat.updateWeaponTimers(actor, actor.wpn.reloadTotal * 0.5);
    const loadedBeforeClick = actor.inv.selectedWeapon?.ammoInMag ?? 0;
    const reserveBeforeClick = actor.inv.ammo.light;
    actor.wpn.fireCooldown = 0;

    expect(loadedBeforeClick).toBeGreaterThan(0);
    expect(combat.tryFire(actor, 0)).toBe(true);
    expect(actor.wpn.reloadTimer).toBe(0);
    expect(actor.inv.selectedWeapon?.ammoInMag).toBe(loadedBeforeClick - 1);
    expect(actor.inv.ammo.light).toBe(reserveBeforeClick);
    expect(shots.filter((shot) => !shot.dry)).toHaveLength(2);
  });

  it('keeps an empty magazine reloading until a round is available', () => {
    const shots: Array<{ dry: boolean }> = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem({ raycast: () => null } as never, movement, events(shots, [0]));
    const actor = actorWithPistol(1);
    actor.inv.ammo.light = 11;
    expect(combat.tryFire(actor, 1 / 60)).toBe(true);
    actor.wpn.fireCooldown = 0;

    // No reload tick has elapsed, so the first click cannot invent a round.
    expect(combat.tryFire(actor, 0)).toBe(false);
    expect(actor.inv.selectedWeapon?.ammoInMag).toBe(0);
    expect(actor.wpn.reloadTimer).toBeGreaterThan(0);
    expect(shots.at(-1)?.dry).toBe(false);
  });

  it('does not duplicate reserve ammo when a staged reload completes', () => {
    const shots: Array<{ dry: boolean }> = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem({ raycast: () => null } as never, movement, events(shots, [0]));
    const actor = actorWithPistol(1);
    actor.inv.ammo.light = 15;
    expect(combat.tryFire(actor, 1 / 60)).toBe(true);
    const total = actor.wpn.reloadTotal;
    combat.updateWeaponTimers(actor, total);

    expect(actor.inv.selectedWeapon?.ammoInMag).toBe(WEAPONS.pistol.magSize);
    expect(actor.inv.ammo.light).toBe(0);
    expect(actor.wpn.reloadTimer).toBe(0);
    expect(actor.wpn.reloadWeaponId).toBeNull();
  });
});
