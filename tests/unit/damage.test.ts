/**
 * Unit tests: damage application, shield-first ordering, healing caps.
 */

import { describe, it, expect } from 'vitest';
import { Actor } from '../../src/sim/actor';

// CharBody requires a PhysicsWorld; for pure damage logic we stub it.
function makeActor(name: string): Actor {
  const actor = Object.create(Actor.prototype) as Actor;
  (actor as { name: string }).name = name;
  (actor as { isPlayer: boolean }).isPlayer = false;
  actor.personality = null;
  actor.health = 100;
  actor.shield = 100;
  actor.alive = true;
  return actor;
}

describe('damage model', () => {
  it('shield absorbs before health', () => {
    const a = makeActor('t');
    const dealt = a.applyDamage(30);
    expect(dealt).toBe(30);
    expect(a.shield).toBe(70);
    expect(a.health).toBe(100);
  });

  it('overflow carries through shield into health', () => {
    const a = makeActor('t');
    a.shield = 20;
    const dealt = a.applyDamage(60);
    expect(dealt).toBe(60);
    expect(a.shield).toBe(0);
    expect(a.health).toBe(60);
  });

  it('dies at zero effective health', () => {
    const a = makeActor('t');
    a.applyDamage(200);
    expect(a.alive).toBe(false);
    expect(a.health).toBeLessThanOrEqual(0);
  });

  it('cannot be overkilled below sensible floor and returns actual dealt', () => {
    const a = makeActor('t');
    a.shield = 0;
    const dealt = a.applyDamage(500);
    expect(dealt).toBe(100);
  });
});

describe('regional damage math', () => {
  const cases: Array<[number, number]> = [
    [2.0, 2.0],   // headshot with common pistol: 26*2 = 52
    [1.0, 1.0],
    [0.9, 0.9],
    [0.75, 0.75],
    [0.7, 0.7],
  ];
  it.each(cases)('multiplier %f applies linearly', (mult) => {
    const a = makeActor('t');
    a.shield = 0;
    a.applyDamage(26 * mult);
    expect(a.health).toBeCloseTo(100 - 26 * mult, 5);
  });

  it('legendary sniper headshot exceeds any target pool', () => {
    const a = makeActor('t');
    a.applyDamage(230 * 2.2);
    expect(a.alive).toBe(false);
  });

  it('shotgun legendary full-pellet hit can eliminate a 200hp target', () => {
    const a = makeActor('t');
    const total = WEAPONS_LEGENDARY_SHOTGUN;
    a.applyDamage(total);
    expect(a.alive).toBe(false);
  });
});

const WEAPONS_LEGENDARY_SHOTGUN = 22 * 10; // mirrors balance.ts shotgun values

describe('healing', () => {
  it('health caps at 100', () => {
    const a = makeActor('t');
    a.health = 50;
    a.healHealth(75);
    expect(a.health).toBe(100);
  });
  it('shield caps at 100', () => {
    const a = makeActor('t');
    a.addShield(50);
    expect(a.shield).toBe(100);
  });
});
