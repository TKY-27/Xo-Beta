import { beforeAll, describe, expect, it } from 'vitest';
import { CAPSULE_CENTER_OFFSET, CharBody, initPhysics, PhysicsWorld } from '../../src/physics/physics';
import { Actor } from '../../src/sim/actor';
import { CombatSystem, type CombatEvents, type Projectile } from '../../src/sim/combat';
import { Match } from '../../src/sim/match';
import { MovementSystem } from '../../src/sim/movement';
import { ActorDamagePolicy, type MatchMode, type RosterEntry } from '../../src/sim/roster';

beforeAll(async () => {
  await initPhysics();
});

function entry(actor: Actor, teamId: number | null): RosterEntry {
  return {
    slotId: actor.id - 1,
    actorId: actor.id,
    displayName: actor.name,
    ownership: { kind: 'bot' },
    connectionState: 'bot',
    teamId,
    skinId: 'vanguard',
    accentColor: actor.accentColor,
  };
}

function policy(mode: MatchMode, entries: readonly RosterEntry[]): ActorDamagePolicy {
  return new ActorDamagePolicy(mode, (actorId) => entries.find((candidate) => candidate.actorId === actorId) ?? null);
}

function events(hits: Actor[], shieldBreaks: Actor[], meleeHits: Actor[]): CombatEvents {
  return {
    onMuzzleFlash: () => undefined,
    onShotFired: () => undefined,
    onImpact: () => undefined,
    onActorHit: (target) => hits.push(target),
    onShieldBroken: (target) => shieldBreaks.push(target),
    onTracer: () => undefined,
    onRicochet: () => undefined,
    onGlassBreak: () => undefined,
    onDestructibleDamaged: () => undefined,
    onMeleeSwing: () => undefined,
    onMeleeHit: (target) => meleeHits.push(target),
  };
}

function armProjectile(projectile: Projectile, ownerId: number, weaponId: Projectile['weaponId'], isPellet = false): void {
  Object.assign(projectile, {
    active: true,
    ownerId,
    weaponId,
    x: 0,
    y: CAPSULE_CENTER_OFFSET + 1.1,
    z: -0.7,
    vx: 0,
    vy: 0,
    vz: -900,
    damage: 80,
    headMult: 2,
    legMult: 0.75,
    falloffStart: 500,
    falloffEnd: 600,
    falloffEndMult: 1,
    gravityScale: 0,
    dist: 0,
    life: 1,
    tracerColor: 0xffffff,
    isPellet,
    ricochets: 0,
    inWater: false,
  });
}

function combatLine(mode: MatchMode = 'teams'): {
  phys: PhysicsWorld;
  bodies: CharBody[];
  actors: [Actor, Actor, Actor];
  combat: CombatSystem;
  hits: Actor[];
  shieldBreaks: Actor[];
  meleeHits: Actor[];
} {
  const phys = new PhysicsWorld();
  const bodies = [
    new CharBody(phys, 1, 0, CAPSULE_CENTER_OFFSET, 0),
    new CharBody(phys, 2, 0, CAPSULE_CENTER_OFFSET, -4),
    new CharBody(phys, 3, 0, CAPSULE_CENTER_OFFSET, -8),
  ];
  const actors = [
    new Actor('SOURCE', bodies[0]!, 0xffffff),
    new Actor('ALLY', bodies[1]!, 0x44aaff),
    new Actor('ENEMY', bodies[2]!, 0xff5544),
  ] as [Actor, Actor, Actor];
  phys.flush();
  const hits: Actor[] = [];
  const shieldBreaks: Actor[] = [];
  const meleeHits: Actor[] = [];
  const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as MovementSystem;
  const combat = new CombatSystem(phys, movement, events(hits, shieldBreaks, meleeHits));
  const entries = [entry(actors[0], mode === 'ffa' ? null : 0), entry(actors[1], mode === 'ffa' ? null : 0), entry(actors[2], mode === 'ffa' ? null : 1)];
  const damagePolicy = policy(mode, entries);
  combat.attackerLookup = (actorId) => actors.find((actor) => actor.id === actorId) ?? null;
  combat.canAffectActor = (attacker, target) => damagePolicy.allows(attacker.id, target.id);
  return { phys, bodies, actors, combat, hits, shieldBreaks, meleeHits };
}

function disposeLine(line: ReturnType<typeof combatLine>): void {
  for (const body of line.bodies) body.dispose();
  line.phys.dispose();
}

describe('authoritative team damage policy', () => {
  it.each([
    ['projectile', 'pistol', false],
    ['shotgun pellet', 'shotgun', true],
    ['sniper shot', 'sniper', false],
  ] as const)('makes an allied %s transparent and damages the enemy behind it', (_name, weaponId, pellet) => {
    const line = combatLine();
    const [source, ally, enemy] = line.actors;
    const allyHealth = ally.effectiveHealth();
    const enemyHealth = enemy.effectiveHealth();
    armProjectile(line.combat.projectiles[0]!, source.id, weaponId, pellet);

    line.combat.update(1 / 60, line.actors);

    expect(ally.effectiveHealth()).toBe(allyHealth);
    expect(enemy.effectiveHealth()).toBeLessThan(enemyHealth);
    expect(line.hits).toEqual([enemy]);
    expect(source.stats.damageDealt).toBeGreaterThan(0);
    disposeLine(line);
  });

  it('suppresses allied melee damage, shield break, knockback, feedback, and credit', () => {
    const line = combatLine();
    const [source, ally] = line.actors;
    ally.body.teleport(0, CAPSULE_CENTER_OFFSET, -1.2);
    ally.shield = 10;
    const velocity = { ...ally.body.velocity };

    expect(line.combat.tryMelee(source, 1 / 60, [source, ally])).toBe(true);

    expect(ally.shield).toBe(10);
    expect(ally.health).toBe(100);
    expect(ally.body.velocity).toEqual(velocity);
    expect(line.meleeHits).toEqual([]);
    expect(line.shieldBreaks).toEqual([]);
    expect(source.stats.damageDealt).toBe(0);
    expect(source.stats.kills).toBe(0);
    disposeLine(line);
  });

  it('suppresses allied ground-pound damage and impulse', () => {
    const line = combatLine();
    const [source, ally] = line.actors;
    ally.body.teleport(0, CAPSULE_CENTER_OFFSET, -2);
    const entries = [entry(source, 0), entry(ally, 0)];
    const damagePolicy = policy('teams', entries);
    const pendingEliminations: unknown[] = [];
    const method = (Match.prototype as unknown as {
      poundAoE(sourceActor: Actor, x: number, y: number, z: number): void;
    }).poundAoE;
    method.call({ actors: [source, ally], damagePolicy, pendingEliminations }, source, 0, CAPSULE_CENTER_OFFSET, 0);
    expect(ally.effectiveHealth()).toBe(200);
    expect(ally.body.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(pendingEliminations).toEqual([]);
    disposeLine(line);
  });

  it('keeps FFA and environmental damage unchanged', () => {
    const line = combatLine('ffa');
    const [source, target] = line.actors;
    target.body.teleport(0, CAPSULE_CENTER_OFFSET, -1.2);
    const before = target.effectiveHealth();
    line.combat.tryMelee(source, 1 / 60, [source, target]);
    expect(target.effectiveHealth()).toBeLessThan(before);

    const afterActorDamage = target.effectiveHealth();
    target.applyDamage(7);
    expect(target.effectiveHealth()).toBe(afterActorDamage - 7);
    disposeLine(line);
  });
});
