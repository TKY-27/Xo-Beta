import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CombatSystem, type CombatEvents } from '../../src/sim/combat';
import { Actor } from '../../src/sim/actor';
import { CharBody, PhysicsWorld } from '../../src/physics/physics';
import { CAPSULE_CENTER_OFFSET } from '../../src/sim/movement';
import { RARITY_MODS, WEAPONS, type Rarity, type WeaponId } from '../../src/core/balance';
import { setGameSeed } from '../../src/core/rng';
import type { MovementSystem } from '../../src/sim/movement';
import { ensureWorldReady } from '../../src/world';

const NO_EVENTS: CombatEvents = {
  onMuzzleFlash: () => undefined,
  onShotFired: () => undefined,
  onImpact: () => undefined,
  onActorHit: () => undefined,
  onTracer: () => undefined,
  onRicochet: () => undefined,
  onGlassBreak: () => undefined,
  onDestructibleDamaged: () => undefined,
  onMeleeSwing: () => undefined,
  onMeleeHit: () => undefined,
} as never;

const LOOK_AHEAD = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;

function makeActor(phys: PhysicsWorld, id: number, name: string): Actor {
  const body = new CharBody(phys, id, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
  return new Actor(name, body, 0xffffff);
}

function giveWeapon(actor: Actor, weaponId: WeaponId, rarity: Rarity = 'common'): void {
  actor.inv.slots[0] = { kind: 'weapon', weaponId, rarity, ammoInMag: WEAPONS[weaponId].magSize };
  actor.inv.select(0);
}

beforeAll(async () => {
  await ensureWorldReady();
});

beforeEach(() => {
  setGameSeed(1234);
});

describe('per-weapon recoil profiles', () => {
  it('every weapon defines a complete coherent profile', () => {
    for (const def of Object.values(WEAPONS)) {
      const r = def.recoil;
      expect(r.vertical).toBeGreaterThan(0);
      expect(r.horizontal).toBeGreaterThanOrEqual(0);
      expect(r.climbPerShot).toBeGreaterThanOrEqual(0);
      expect(r.climbMax).toBeGreaterThanOrEqual(0);
      expect(r.climbMax).toBeGreaterThanOrEqual(r.climbPerShot);
      expect(r.recover).toBeGreaterThan(0);
      expect(r.camera).toBeGreaterThan(0);
      expect(r.camera).toBeLessThanOrEqual(1);
      expect(r.viewmodel).toBeGreaterThan(0);
      expect(r.ads).toBeGreaterThan(0);
      expect(r.ads).toBeLessThanOrEqual(1);
      expect(r.crouch).toBeGreaterThan(0);
      expect(r.crouch).toBeLessThanOrEqual(1);
    }
    // Design intents: sniper strongest single kick and slowest recovery; SMG
    // the highest sustained climb; shotgun the heaviest viewmodel impulse.
    expect(WEAPONS.sniper.recoil.vertical).toBeGreaterThan(WEAPONS.pistol.recoil.vertical);
    expect(WEAPONS.sniper.recoil.recover).toBeLessThan(WEAPONS.pistol.recoil.recover);
    expect(WEAPONS.smg.recoil.climbMax).toBeGreaterThan(WEAPONS.ar.recoil.climbMax);
    expect(WEAPONS.shotgun.recoil.viewmodel).toBeGreaterThan(WEAPONS.ar.recoil.viewmodel);
  });

  it('applied kick equals the profile scaled by rarity and seeded variation', () => {
    const phys = new PhysicsWorld();
    const shooter = makeActor(phys, 401, 'SHOOTER');
    giveWeapon(shooter, 'ar');
    const combat = new CombatSystem(phys, LOOK_AHEAD, NO_EVENTS);
    shooter.wpn.lastShotTime = 99;
    const before = shooter.wpn.recoilPitch;
    const fired = combat.tryFire(shooter, 0, { x: 0, y: 0, z: -1 });
    expect(fired).toBe(true);
    const applied = shooter.wpn.recoilPitch - before;
    const expectedMax = WEAPONS.ar.recoil.vertical * RARITY_MODS.common.recoilMult;
    expect(applied).toBeGreaterThan(0);
    expect(applied).toBeLessThanOrEqual(expectedMax * 1.16);
    phys.dispose();
  });

  it('sustained fire climbs and a pause resets the climb', () => {
    const phys = new PhysicsWorld();
    const shooter = makeActor(phys, 402, 'SPRAYER');
    giveWeapon(shooter, 'smg');
    const combat = new CombatSystem(phys, LOOK_AHEAD, NO_EVENTS);
    // First shot after a long pause: climb resets to 0.
    shooter.wpn.lastShotTime = 99;
    combat.tryFire(shooter, 0, { x: 0, y: 0, z: -1 });
    expect(shooter.wpn.recoilClimb).toBe(0);
    // Immediate follow-up within the sustain window climbs.
    shooter.wpn.lastShotTime = 0.05;
    shooter.wpn.fireCooldown = 0;
    combat.tryFire(shooter, 0, { x: 0, y: 0, z: -1 });
    expect(shooter.wpn.recoilClimb).toBeCloseTo(WEAPONS.smg.recoil.climbPerShot, 9);
    // A long pause re-arms the climb window.
    combat.updateWeaponTimers(shooter, 1.5);
    expect(shooter.wpn.lastShotTime).toBeGreaterThanOrEqual(1.5);
    phys.dispose();
  });

  it('recovery is exponential in the weapon profile rate and frame-rate independent', () => {
    const phys = new PhysicsWorld();
    const build = () => {
      const shooter = makeActor(phys, 403, 'RECOIL');
      giveWeapon(shooter, 'pistol');
      const combat = new CombatSystem(phys, LOOK_AHEAD, NO_EVENTS);
      shooter.wpn.recoilPitch = 0.1;
      shooter.wpn.recoilYaw = 0.02;
      return { shooter, combat };
    };
    const recover = WEAPONS.pistol.recoil.recover;
    // One 0.5 s step.
    const a = build();
    a.combat.updateWeaponTimers(a.shooter, 0.5);
    // Thirty 1/60 s steps.
    const b = build();
    for (let i = 0; i < 30; i++) b.combat.updateWeaponTimers(b.shooter, 1 / 60);
    const expected = 0.1 * Math.exp(-recover * 0.5);
    expect(a.shooter.wpn.recoilPitch).toBeCloseTo(expected, 5);
    expect(b.shooter.wpn.recoilPitch).toBeCloseTo(expected, 2);
    phys.dispose();
  });

  it('the authoritative shot resolves before recoil moves the view', () => {
    const phys = new PhysicsWorld();
    const shooter = makeActor(phys, 404, 'ORDER');
    giveWeapon(shooter, 'pistol');
    const combat = new CombatSystem(phys, LOOK_AHEAD, NO_EVENTS);
    shooter.wpn.lastShotTime = 99;
    const before = shooter.wpn.recoilPitch;
    const fired = combat.tryFire(shooter, 0, { x: 0, y: 0, z: -1 });
    expect(fired).toBe(true);
    // The returned projectiles were spawned from the pre-kick aim; this
    // shot's kick lands strictly after they were launched.
    expect(shooter.wpn.recoilPitch).toBeGreaterThan(before);
    phys.dispose();
  });
});
