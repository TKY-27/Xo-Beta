import { beforeAll, describe, expect, it } from 'vitest';
import { CAPSULE_CENTER_OFFSET, CharBody, initPhysics, PhysicsWorld } from '../../src/physics/physics';
import { Actor } from '../../src/sim/actor';
import { CombatSystem, type CombatEvents } from '../../src/sim/combat';
import { MovementSystem } from '../../src/sim/movement';

beforeAll(async () => {
  await initPhysics();
});

function combatEvents(breaks: string[], hits: Actor[]): CombatEvents {
  return {
    onMuzzleFlash: () => undefined,
    onShotFired: () => undefined,
    onImpact: () => undefined,
    onActorHit: (target) => hits.push(target),
    onTracer: () => undefined,
    onRicochet: () => undefined,
    onGlassBreak: (stableId) => breaks.push(stableId),
    onDestructibleDamaged: () => undefined,
    onMeleeSwing: () => undefined,
    onMeleeHit: () => undefined,
  };
}

describe('authoritative upper-floor glass combat', () => {
  it('breaks one upper pane, removes its collider, and lets a sniper hit the actor behind it', () => {
    const phys = new PhysicsWorld();
    const shooterBody = new CharBody(phys, 1, 0, CAPSULE_CENTER_OFFSET, 0);
    const targetBody = new CharBody(phys, 2, 0, CAPSULE_CENTER_OFFSET, -7);
    const shooter = new Actor('SHOOTER', true, shooterBody, 0xffffff);
    const target = new Actor('TARGET', false, targetBody, 0xffaa44);
    shooter.inv.add({ kind: 'weapon', weaponId: 'sniper', rarity: 'common', ammoInMag: 1 });
    shooter.inv.select(0);

    const glassCollider = phys.addDestructibleBox(1, 0, 1.6, -2, 1.5, 1, 0.04, 'glass');
    phys.flush();
    const breaks: string[] = [];
    const hits: Actor[] = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
    const combat = new CombatSystem(phys, movement, combatEvents(breaks, hits));
    combat.registerDestructibles([{
      id: 1,
      stableId: 'fixture:building:glass:upper:0001',
      hp: 5,
      collider: glassCollider,
      geo: { kind: 'box', x: 0, y: 1.6, z: -2, sx: 3, sy: 2, sz: 0.08, yaw: 0, mat: 'glass', materialHint: 'glass' },
      type: 'glass',
      alive: true,
    }] as never);

    expect(combat.tryFire(shooter, 0, { x: 0, y: 0, z: -1 })).toBe(true);
    combat.update(1 / 60, [shooter, target]);

    const destructible = combat.destructibleList()[0]!;
    expect(destructible.alive).toBe(false);
    expect(breaks).toEqual(['fixture:building:glass:upper:0001']);
    expect(hits).toContain(target);
    expect(target.effectiveHealth()).toBeLessThan(target.maxEffectiveHealth());
    expect(phys.raycast(0, 1.6, -0.8, 0, 0, -1, 1.5)).toBeNull();

    // A stale second hit cannot fire a second event or remove the collider
    // again after the authoritative alive edge has already closed.
    expect(combat.damageDestructible(1, 100)).toBe(false);
    expect(breaks).toHaveLength(1);

    shooterBody.dispose();
    targetBody.dispose();
    phys.dispose();
  });
});
