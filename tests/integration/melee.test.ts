/**
 * Integration tests: melee (fists) — hit detection, damage, knockback, kill.
 * Uses the real simulation stack (physics + movement) on a real map.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Match } from '../../src/sim/match';
import { loadMap } from '../../src/world';
import { RAPIER_READY } from '../../src/world/rapierReady';
import { MELEE } from '../../src/core/balance';

async function makeMatch(mapId: 'neocity' | 'oldfront' | 'eden' | 'ashara', seed: number): Promise<Match> {
  const loaded = await loadMap(mapId);
  return new Match({ mapDef: loaded.def, seed, difficulty: 'normal', withPlayer: true });
}

beforeAll(async () => {
  await RAPIER_READY();
});

describe('melee fists', () => {
  it('punch damages a target in range and knocks them back', async () => {
    const m = await makeMatch('neocity', 5);
    const a = m.actors[0]!;
    const b = m.actors[1]!;
    a.body.position.x = 0; a.body.position.z = 0;
    b.body.position.x = 0; b.body.position.z = -(MELEE.range - 0.4);
    a.yaw = 0; a.pitch = 0;
    const shieldBefore = b.shield;
    let hitEvent: { killed: boolean } | null = null;
    m.events.on('meleeHit', (e) => { if (e.targetId === b.id) hitEvent = { killed: e.killed }; });
    m.events.on('meleeSwing', () => { /* swing observed */ });
    const fired = m.combat.tryMelee(a, 1 / 60, m.actors);
    expect(fired).toBe(true);
    expect(hitEvent).not.toBeNull();
    expect(b.shield).toBeLessThan(shieldBefore);
    expect(a.stats.damageDealt).toBeGreaterThan(0);
    expect(b.body.velocity.z).toBeLessThan(0); // shoved away (−Z, forward)
  }, 60_000);

  it('punch misses targets outside range or behind the attacker', async () => {
    const m = await makeMatch('neocity', 6);
    const a = m.actors[0]!;
    const b = m.actors[1]!;
    a.body.position.x = 0; a.body.position.z = 0;
    a.yaw = 0; a.pitch = 0;

    let hits = 0;
    m.events.on('meleeHit', () => { hits++; });

    // Too far
    b.body.position.x = 0; b.body.position.z = -(MELEE.range + 2);
    m.combat.tryMelee(a, 1 / 60, m.actors);
    a.wpn.fireCooldown = 0;
    // Directly behind (yaw 0 faces −Z)
    b.body.position.x = 0; b.body.position.z = MELEE.range * 0.5;
    m.combat.tryMelee(a, 1 / 60, m.actors);
    expect(hits).toBe(0);
  }, 60_000);

  it('enough punches eliminate a target and emit the kill', async () => {
    const m = await makeMatch('eden', 7);
    const a = m.actors[0]!;
    const b = m.actors[1]!;
    a.yaw = 0; a.pitch = 0;
    let killed = false;
    m.events.on('meleeHit', (e) => { if (e.targetId === b.id && e.killed) killed = true; });
    for (let i = 0; i < 40 && !killed; i++) {
      a.wpn.fireCooldown = 0;
      // Hold the victim in front (knockback shoves them away each punch)
      b.body.position.x = a.body.position.x;
      b.body.position.z = a.body.position.z - 1.5;
      b.alive = true;
      m.combat.tryMelee(a, 1 / 60, m.actors);
    }
    expect(killed).toBe(true);
    expect(b.alive).toBe(false);
  }, 60_000);

  it('processes a victim only once when two death paths enqueue the same actor', async () => {
    const m = await makeMatch('eden', 8);
    const attacker = m.actors[0]!;
    const victim = m.actors[1]!;
    attacker.yaw = 0; attacker.pitch = 0;
    victim.body.position.x = attacker.body.position.x;
    victim.body.position.z = attacker.body.position.z - 1.2;
    victim.shield = 0;
    victim.health = 1;
    let eliminated = 0;
    m.events.on('eliminated', (event) => {
      if (event.victimId === victim.id) eliminated++;
    });
    m.combat.tryMelee(attacker, 1 / 60, m.actors);

    const internals = m as unknown as {
      pendingEliminations: Array<unknown>;
      processEliminations(): void;
    };
    expect(internals.pendingEliminations).toHaveLength(1);
    internals.pendingEliminations.push(internals.pendingEliminations[0]);
    internals.processEliminations();

    expect(eliminated).toBe(1);
    expect(attacker.stats.kills).toBe(1);
    expect(m.killFeed.filter((entry) => entry.victimId === victim.id)).toHaveLength(1);
  }, 60_000);
});
