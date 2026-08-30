import { beforeAll, describe, expect, it } from 'vitest';
import { WEAPONS, type WeaponId } from '../../src/core/balance';
import { setGameSeed } from '../../src/core/rng';
import {
  HostLagCompensation,
  LAG_COMPENSATION_MAX_REWIND_MS,
  type ResolveAcceptedShotInput,
} from '../../src/net/lagCompensation';
import { CAPSULE_CENTER_OFFSET, CharBody, initPhysics, PhysicsWorld } from '../../src/physics/physics';
import { Actor } from '../../src/sim/actor';
import { CombatSystem, type CombatEvents } from '../../src/sim/combat';
import type { Match } from '../../src/sim/match';
import { MovementSystem } from '../../src/sim/movement';

interface RecordedEvents {
  hits: Actor[];
  breaks: string[];
  shots: Array<{ x: number; y: number; z: number; dry: boolean }>;
}

interface Fixture {
  phys: PhysicsWorld;
  actors: Actor[];
  combat: CombatSystem;
  match: Match;
  events: RecordedEvents;
  dispose(): void;
}

beforeAll(async () => {
  await initPhysics();
});

function createFixture(actorPositions: ReadonlyArray<Readonly<{ x: number; z: number }>>): Fixture {
  const phys = new PhysicsWorld();
  const bodies = actorPositions.map((position, index) => (
    new CharBody(phys, index + 1, position.x, CAPSULE_CENTER_OFFSET, position.z)
  ));
  const actors = bodies.map((body, index) => new Actor(`ACTOR-${index + 1}`, body, 0xffffff));
  for (const actor of actors) actor.body.grounded = true;
  phys.flush();

  const recorded: RecordedEvents = { hits: [], breaks: [], shots: [] };
  const events: CombatEvents = {
    onMuzzleFlash: () => undefined,
    onShotFired: (_actor, _weapon, x, y, z, dry) => recorded.shots.push({ x, y, z, dry }),
    onImpact: () => undefined,
    onActorHit: (target) => recorded.hits.push(target),
    onTracer: () => undefined,
    onRicochet: () => undefined,
    onGlassBreak: (stableId) => recorded.breaks.push(stableId),
    onDestructibleDamaged: () => undefined,
    onMeleeSwing: () => undefined,
    onMeleeHit: () => undefined,
  };
  const movement = { lookDir: (actor: Actor) => {
    const cp = Math.cos(actor.pitch);
    return { x: -Math.sin(actor.yaw) * cp, y: Math.sin(actor.pitch), z: -Math.cos(actor.yaw) * cp };
  } } as unknown as MovementSystem;
  const combat = new CombatSystem(phys, movement, events);
  combat.attackerLookup = (id) => actors.find((actor) => actor.id === id) ?? null;
  const match = { actors, combat, phys } as unknown as Match;
  return {
    phys,
    actors,
    combat,
    match,
    events: recorded,
    dispose: () => {
      for (const body of bodies) body.dispose();
      phys.dispose();
    },
  };
}

function equip(actor: Actor, weaponId: WeaponId, ammoInMag = 1): void {
  actor.inv.add({ kind: 'weapon', weaponId, rarity: 'common', ammoInMag });
  actor.inv.select(0);
  actor.wpn.adsAmount = 1;
}

function recordRange(
  lag: HostLagCompensation,
  fixture: Fixture,
  firstTick: number,
  lastTick: number,
  beforeRecord?: (tick: number) => void,
): void {
  for (let tick = firstTick; tick <= lastTick; tick++) {
    beforeRecord?.(tick);
    lag.recordTick(fixture.match, tick);
  }
}

function addUpperFloorGlass(fixture: Fixture): void {
  const collider = fixture.phys.addDestructibleBox(1, 0, 1.6, -8, 1.5, 1, 0.04, 'glass');
  fixture.phys.flush();
  fixture.combat.registerDestructibles([{
    id: 1,
    stableId: 'fixture:building:glass:upper:0001',
    hp: 5,
    collider,
    geo: {
      kind: 'box', x: 0, y: 1.6, z: -8,
      sx: 3, sy: 2, sz: 0.08, yaw: 0,
      mat: 'glass', materialHint: 'glass',
    },
    type: 'glass',
    alive: true,
  }]);
}

describe('host-authoritative projectile lag compensation', () => {
  const latencyCases = [
    { latencyMs: 0, rewindTicks: 0 },
    { latencyMs: 50, rewindTicks: 3 },
    { latencyMs: 100, rewindTicks: 6 },
    { latencyMs: 150, rewindTicks: 9 },
    { latencyMs: LAG_COMPENSATION_MAX_REWIND_MS, rewindTicks: 15 },
  ] as const;

  it.each(latencyCases)(
    'maps $latencyMs ms to $rewindTicks ticks and performs bounded deterministic catch-up',
    ({ latencyMs, rewindTicks }) => {
      const fixture = createFixture([{ x: 0, z: 0 }]);
      const shooter = fixture.actors[0]!;
      equip(shooter, 'pistol', 2);
      setGameSeed(0x1a2b3c4d);
      const lag = new HostLagCompensation();
      const currentTick = 100;
      recordRange(lag, fixture, currentTick - rewindTicks, currentTick);

      const result = lag.resolveAcceptedShot({
        actor: shooter,
        currentHostTick: currentTick,
        requestedShotTick: currentTick - rewindTicks,
        dt: 1 / 60,
      });
      const projectile = fixture.combat.projectiles.find((candidate) => candidate.active && candidate.ownerId === shooter.id);

      expect(result).toMatchObject({
        accepted: true,
        acceptedTick: currentTick - rewindTicks,
        rewindTicks,
        clamped: false,
        catchupSubsteps: rewindTicks * 2,
      });
      expect(result.errorDistance).toBeCloseTo(0, 8);
      expect(projectile).toBeDefined();
      expect(projectile!.dist).toBeCloseTo(WEAPONS.pistol.projectileSpeed * (latencyMs / 1000), 0);
      expect(shooter.inv.selectedWeapon?.ammoInMag).toBe(1);
      expect(shooter.stats.shotsFired).toBe(1);

      if (rewindTicks === 0) {
        expect(projectile!.dist).toBe(0);
        fixture.combat.update(1 / 60, fixture.actors);
        expect(projectile!.dist).toBeGreaterThan(0);
      }
      fixture.dispose();
    },
  );

  it('rejects future and excessive rewind before consuming ammo', () => {
    const fixture = createFixture([{ x: 0, z: 0 }]);
    const shooter = fixture.actors[0]!;
    equip(shooter, 'pistol', 3);
    const lag = new HostLagCompensation();
    recordRange(lag, fixture, 5, 20);

    expect(lag.resolveAcceptedShot({
      actor: shooter, currentHostTick: 20, requestedShotTick: 21, dt: 1 / 60,
    })).toMatchObject({ accepted: false, rejectedReason: 'future-shot' });
    expect(lag.resolveAcceptedShot({
      actor: shooter, currentHostTick: 20, requestedShotTick: 4, dt: 1 / 60,
    })).toMatchObject({ accepted: false, rewindTicks: 16, rejectedReason: 'excessive-rewind' });
    expect(shooter.inv.selectedWeapon?.ammoInMag).toBe(3);
    expect(shooter.stats.shotsFired).toBe(0);
    fixture.dispose();
  });

  it('keeps RPM and ammo authority on the live host weapon state', () => {
    const fixture = createFixture([{ x: 0, z: 0 }]);
    const shooter = fixture.actors[0]!;
    equip(shooter, 'pistol', 2);
    const lag = new HostLagCompensation();
    lag.recordTick(fixture.match, 40);

    const first = lag.resolveAcceptedShot({
      actor: shooter, currentHostTick: 40, requestedShotTick: 40, dt: 1 / 60,
    });
    const second = lag.resolveAcceptedShot({
      actor: shooter, currentHostTick: 40, requestedShotTick: 40, dt: 1 / 60,
    });

    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: false, rejectedReason: 'fire-denied' });
    expect(shooter.inv.selectedWeapon?.ammoInMag).toBe(1);
    expect(shooter.stats.shotsFired).toBe(1);
    fixture.dispose();
  });

  it('hits a historical moving-target pose without moving the live actor or accepting forged shot fields', () => {
    const fixture = createFixture([{ x: 0, z: 0 }, { x: 0, z: -20 }]);
    const [shooter, target] = fixture.actors as [Actor, Actor];
    equip(shooter, 'sniper');
    const lag = new HostLagCompensation();
    recordRange(lag, fixture, 10, 13, (tick) => {
      const xByTick: Record<number, number> = { 10: 0, 11: 0.05, 12: 2.5, 13: 5 };
      target.body.teleport(xByTick[tick]!, CAPSULE_CENTER_OFFSET, -20);
    });
    const livePosition = { ...target.body.position };
    const forgedInput = {
      actor: shooter,
      currentHostTick: 13,
      requestedShotTick: 10,
      dt: 1 / 60,
      targetActorId: 999,
      damage: 999_999,
      muzzle: { x: 999, y: 999, z: 999 },
    } as ResolveAcceptedShotInput;

    const result = lag.resolveAcceptedShot(forgedInput);

    expect(result.accepted).toBe(true);
    expect(fixture.events.hits).toEqual([target]);
    expect(target.body.position).toEqual(livePosition);
    expect(target.alive).toBe(true);
    expect(target.effectiveHealth()).toBe(100);
    expect(fixture.events.shots[0]?.x).toBeCloseTo(0, 6);
    expect(fixture.events.shots[0]?.z).toBeCloseTo(-0.7, 6);
    expect(result.errorDistance).toBeCloseTo(0, 8);
    fixture.dispose();
  });

  it('keeps allied historical hit regions transparent and damages the enemy behind them', () => {
    const fixture = createFixture([
      { x: 0, z: 0 },
      { x: 0, z: -8 },
      { x: 0, z: -16 },
    ]);
    const [shooter, teammate, enemy] = fixture.actors as [Actor, Actor, Actor];
    equip(shooter, 'sniper');
    fixture.combat.canAffectActor = (attacker, target) => !(attacker === shooter && target === teammate);
    const lag = new HostLagCompensation();
    recordRange(lag, fixture, 10, 12);

    const result = lag.resolveAcceptedShot({
      actor: shooter, currentHostTick: 12, requestedShotTick: 10, dt: 1 / 60,
    });

    expect(result.accepted).toBe(true);
    expect(teammate.effectiveHealth()).toBe(teammate.maxEffectiveHealth());
    expect(enemy.effectiveHealth()).toBeLessThan(enemy.maxEffectiveHealth());
    expect(fixture.events.hits).toEqual([enemy]);
    fixture.dispose();
  });

  it('breaks intact upper-floor glass and continues the sniper through the new opening', () => {
    const fixture = createFixture([{ x: 0, z: 0 }, { x: 0, z: -14 }]);
    const [shooter, target] = fixture.actors as [Actor, Actor];
    equip(shooter, 'sniper');
    addUpperFloorGlass(fixture);
    const lag = new HostLagCompensation();
    recordRange(lag, fixture, 10, 12);

    const result = lag.resolveAcceptedShot({
      actor: shooter, currentHostTick: 12, requestedShotTick: 10, dt: 1 / 60,
    });

    expect(result.accepted).toBe(true);
    expect(fixture.combat.destructibleList()[0]?.alive).toBe(false);
    expect(fixture.events.breaks).toEqual(['fixture:building:glass:upper:0001']);
    expect(fixture.events.hits).toEqual([target]);
    fixture.dispose();
  });

  it('uses stable historical glass revisions without replaying a later break edge', () => {
    const fixture = createFixture([{ x: 0, z: 0 }, { x: 0, z: -14 }]);
    const [shooter, target] = fixture.actors as [Actor, Actor];
    equip(shooter, 'sniper');
    addUpperFloorGlass(fixture);
    const lag = new HostLagCompensation();
    lag.recordTick(fixture.match, 10);
    expect(fixture.combat.damageDestructible(1, 100)).toBe(true);
    lag.recordTick(fixture.match, 11);
    lag.recordTick(fixture.match, 12);

    const result = lag.resolveAcceptedShot({
      actor: shooter, currentHostTick: 12, requestedShotTick: 10, dt: 1 / 60,
    });

    expect(result.accepted).toBe(true);
    expect(fixture.events.breaks).toEqual(['fixture:building:glass:upper:0001']);
    expect(fixture.events.hits).toEqual([target]);
    fixture.dispose();
  });

  it('lets a sniper pass through a pane already broken at the requested shot tick', () => {
    const fixture = createFixture([{ x: 0, z: 0 }, { x: 0, z: -14 }]);
    const [shooter, target] = fixture.actors as [Actor, Actor];
    equip(shooter, 'sniper');
    addUpperFloorGlass(fixture);
    expect(fixture.combat.damageDestructible(1, 100)).toBe(true);
    fixture.events.breaks.length = 0;
    const lag = new HostLagCompensation();
    recordRange(lag, fixture, 10, 12);

    const result = lag.resolveAcceptedShot({
      actor: shooter, currentHostTick: 12, requestedShotTick: 10, dt: 1 / 60,
    });

    expect(result.accepted).toBe(true);
    expect(fixture.events.breaks).toEqual([]);
    expect(fixture.events.hits).toEqual([target]);
    fixture.dispose();
  });
});
