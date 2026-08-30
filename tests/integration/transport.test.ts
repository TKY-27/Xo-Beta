import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Match, type ActorController } from '../../src/sim/match';
import type { Actor } from '../../src/sim/actor';
import { loadMap } from '../../src/world';
import { RAPIER_READY } from '../../src/world/rapierReady';
import { emptyCommand } from '../../src/sim/input';
import { buildSoloRoster } from '../../src/sim/roster';

type Loaded = Awaited<ReturnType<typeof loadMap>>;
let loaded: Loaded;

beforeAll(async () => {
  await RAPIER_READY();
  loaded = await loadMap('neocity');
});

const STEP = 1 / 60;
// Each case constructs the full Neo City physics/nav world. Keep the normal
// parallel full-suite load from turning a correct simulation assertion into a
// five-second infrastructure timeout.
// Each case constructs a complete production-map Nav graph. Parallel all-map
// integration runs can legitimately exceed the old 15 s ceiling even though
// the same assertions complete quickly in isolation.
const TRANSPORT_TEST_TIMEOUT = 60_000;

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
  return new Match({ mapDef: loaded.def, seed: 777, difficulty: 'normal', mode: 'solo', roster: buildSoloRoster(777) });
}

describe('transport / drop lifecycle', () => {
  it('publishes the pre-step transport position for presentation interpolation', () => {
    const m = makeMatch();
    expect(m.transportPos.x).toBe(m.transportFrom[0]);
    expect(m.transportPos.z).toBe(m.transportFrom[1]);
    expect(m.previousTransportPos).toEqual(m.transportPos);
    const before = { ...m.transportPos };
    m.fixedUpdate(STEP);
    expect(m.previousTransportPos).toEqual(before);
    expect(m.transportPos).not.toEqual(m.previousTransportPos);

    const current = { ...m.transportPos };
    m.fixedUpdate(STEP);
    expect(m.previousTransportPos).toEqual(current);
    m.dispose();
  }, TRANSPORT_TEST_TIMEOUT);

  it('keeps aboard physics bodies parked until their one deployment placement', () => {
    const m = makeMatch();
    const player = m.localActor!;
    const stub = new StubController();
    m.controllers.set(player.id, stub);
    const parked = { ...player.body.position };

    for (let i = 0; i < 30; i++) m.fixedUpdate(STEP);
    expect(player.body.position.x).toBeCloseTo(parked.x, 6);
    expect(player.body.position.y).toBeCloseTo(parked.y, 6);
    expect(player.body.position.z).toBeCloseTo(parked.z, 6);
    expect(m.transportPos.x).not.toBeCloseTo(parked.x, 3);

    const gate = m as unknown as { transportGateOpen: boolean };
    let guard = 0;
    while (!gate.transportGateOpen && guard++ < 2000) m.fixedUpdate(STEP);
    const deployTeleport = vi.spyOn(player.body, 'teleport');
    stub.jumpQueued = true;
    m.fixedUpdate(STEP);
    expect(player.deployed).toBe(true);
    expect(deployTeleport).toHaveBeenCalledTimes(1);
    expect(deployTeleport.mock.calls[0]?.[0]).toBeCloseTo(m.transportPos.x, 6);
    expect(deployTeleport.mock.calls[0]?.[2]).toBeCloseTo(m.transportPos.z, 6);
    expect(Math.hypot(
      player.body.position.x - m.transportPos.x,
      player.body.position.z - m.transportPos.z,
    )).toBeLessThan(12);
    m.dispose();
  }, TRANSPORT_TEST_TIMEOUT);

  it('landed player keeps full control while other actors are still aboard', () => {
    const m = makeMatch();
    const player = m.localActor!;
    const bots = m.actors.filter((a) => m.isBotActor(a));
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
    // Glide touchdown uses a safe teleport, which deliberately invalidates
    // contact state. It must remain air for this exact frame instead of
    // publishing a false `ground && !grounded` combination.
    expect(player.state).toBe('air');
    expect(player.body.grounded).toBe(false);
    expect(m.phys.characterPenetrationsAt(
      player.body.position.x,
      player.body.position.y,
      player.body.position.z,
      player.body.body,
    )).toEqual([]);
    expect(player.state === 'ground' && !player.body.grounded).toBe(false);
    m.fixedUpdate(STEP);
    expect(player.body.grounded).toBe(true);
    expect(player.state).toBe('ground');
    expect(m.phys.characterPenetrationsAt(
      player.body.position.x,
      player.body.position.y,
      player.body.position.z,
      player.body.body,
    )).toEqual([]);

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
    m.dispose();
  }, TRANSPORT_TEST_TIMEOUT);

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
    m.dispose();
  }, TRANSPORT_TEST_TIMEOUT);
});
