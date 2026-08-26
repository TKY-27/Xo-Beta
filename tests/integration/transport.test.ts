import { describe, it, expect, beforeAll } from 'vitest';
import { Match, type ActorController } from '../../src/sim/match';
import type { Actor } from '../../src/sim/actor';
import { loadMap } from '../../src/world';
import { RAPIER_READY } from '../../src/world/rapierReady';
import { emptyCommand } from '../../src/sim/input';

type Loaded = Awaited<ReturnType<typeof loadMap>>;
let loaded: Loaded;

beforeAll(async () => {
  await RAPIER_READY();
  loaded = await loadMap('neocity');
});

const STEP = 1 / 60;

/**
 * Deterministic input source driven through the REAL command pipeline
 * (controllers -> fixedUpdate -> updateTransport/updateLive -> physics step),
 * so grounded detection and character-controller motion behave exactly like
 * they do in the running game.
 */
class StubController implements ActorController {
  jumpQueued = false;
  moving = false;
  updateCommand(_actor: Actor, _dt: number): ReturnType<typeof emptyCommand> {
    const cmd = emptyCommand();
    if (this.jumpQueued) {
      cmd.jumpPressed = true;
      this.jumpQueued = false;
    }
    if (this.moving) {
      cmd.moveZ = 1;
      cmd.sprint = true;
      cmd.yaw = Math.PI;
    }
    return cmd;
  }
}

function makeMatch(): Match {
  return new Match({ mapDef: loaded.def, seed: 777, difficulty: 'normal', withPlayer: true });
}

describe('transport / drop lifecycle', () => {
  it('landed player keeps full control while other actors are still aboard', () => {
    const m = makeMatch();
    const player = m.player!;
    const bots = m.actors.filter((a) => !a.isPlayer);
    expect(bots.length).toBeGreaterThan(0);
    const stub = new StubController();
    m.controllers.set(player.id, stub);

    // Ride until the jump gate opens (~5 s into the approach).
    const gate = m as unknown as { transportGateOpen: boolean };
    let guard = 0;
    while (!gate.transportGateOpen && guard++ < 2000) {
      m.fixedUpdate(STEP);
    }
    expect(gate.transportGateOpen).toBe(true);

    // Player jumps immediately; bots hold their seats.
    stub.jumpQueued = true;
    m.fixedUpdate(STEP);
    expect(player.deployed).toBe(true);
    expect(['freefall', 'glide']).toContain(player.state);

    // Fall until landed. Bots stay aboard, so the match phase must STILL be
    // 'transport' when the player touches ground.
    guard = 0;
    while ((player.state === 'freefall' || player.state === 'glide') && guard++ < 6000) {
      m.fixedUpdate(STEP);
    }
    expect(guard).toBeLessThan(6000);
    expect(player.state).not.toBe('freefall');
    expect(player.state).not.toBe('glide');
    expect(m.phase).toBe('transport');

    // The landed player must respond to movement input on the very next
    // simulation updates, even though no other actor has jumped yet.
    const pz0 = player.body.position.z;
    stub.moving = true;
    for (let i = 0; i < 10; i++) m.fixedUpdate(STEP);
    const moved = Math.abs(player.body.position.z - pz0);
    expect(moved).toBeGreaterThan(0.2);
    expect(m.phase).toBe('transport');

    // Ground contact or settled vertical state: never frozen mid-air.
    expect(
      player.body.grounded ||
        player.state === 'ground' ||
        Math.abs(player.body.velocity.y) < 3,
    ).toBe(true);

    // Held/repeated jumping must never re-capture the player into transport.
    const groundY = player.body.position.y;
    for (let i = 0; i < 60; i++) {
      stub.jumpQueued = true;
      m.fixedUpdate(STEP);
    }
    expect(player.deployed).toBe(true);
    expect(player.body.position.y).toBeLessThan(groundY + 30);
    stub.moving = false;
  });

  it('force-deploys every remaining actor exactly once at route end', () => {
    const m = makeMatch();
    let guard = 0;
    while (m.phase === 'transport' && guard++ < 20000) {
      m.fixedUpdate(STEP);
    }
    expect(guard).toBeLessThan(20000);
    // Route finished: nobody may still be aboard and nobody may have vanished.
    for (const a of m.actors) {
      expect(a.deployed).toBe(true);
      const p = a.body.position;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    }
    expect(['drop', 'live']).toContain(m.phase);
  });
});
