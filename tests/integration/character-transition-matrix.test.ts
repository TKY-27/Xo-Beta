import { beforeAll, describe, expect, it } from 'vitest';
import { type ActorController, Match } from '../../src/sim/match';
import type { Actor } from '../../src/sim/actor';
import { emptyCommand } from '../../src/sim/input';
import { loadMap, type MapId } from '../../src/world';
import { RAPIER_READY } from '../../src/world/rapierReady';

const STEP = 1 / 60;

beforeAll(async () => {
  await RAPIER_READY();
});

class MatrixPlayerController implements ActorController {
  deployRequested = false;
  ticks = 0;

  updateCommand(actor: Actor): ReturnType<typeof emptyCommand> {
    const cmd = emptyCommand();
    this.ticks++;
    const p = actor.body.position;
    // Always steer toward the playable centre so an early transport jump
    // exercises flight and landing without deliberately leaving the map.
    cmd.yaw = Math.atan2(p.x, p.z);
    if (!actor.deployed) {
      cmd.jumpPressed = this.deployRequested;
      this.deployRequested = false;
      return cmd;
    }
    if (actor.state === 'freefall' || actor.state === 'glide') {
      cmd.moveZ = 0.75;
      cmd.pitch = -0.45;
      return cmd;
    }
    cmd.moveZ = 1;
    cmd.sprint = true;
    // Exercise ordinary jump/landing edges after touchdown without turning
    // the matrix into a combat or advanced-mobility test.
    if (actor.body.grounded && this.ticks % 150 === 0) cmd.jumpPressed = true;
    return cmd;
  }
}

describe('all-map character transition matrix', () => {
  for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
    it(`${id} keeps every deployed player and bot capsule clear through drop, landing and movement`, () => {
      const loaded = loadMap(id);
      const match = new Match({
        mapDef: loaded.def,
        seed: 703119,
        difficulty: 'normal',
        withPlayer: true,
      });
      const player = match.player!;
      const controller = new MatrixPlayerController();
      match.controllers.set(player.id, controller);
      const origin = { ...player.body.position };
      let sawPlayerFlight = false;
      let sawPlayerGround = false;
      let sawBotFlight = false;
      let sawBotGround = false;
      let liveFrames = 0;

      for (let frame = 0; frame < 4_800; frame++) {
        const gateOpen = (match as unknown as { transportGateOpen: boolean }).transportGateOpen;
        if (gateOpen && !player.deployed) controller.deployRequested = true;
        match.fixedUpdate(STEP);
        if (match.phase === 'live') liveFrames++;

        for (const actor of match.actors) {
          if (!actor.alive || !actor.deployed) continue;
          const p = actor.body.position;
          expect(
            Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
            `${id} frame ${frame} actor ${actor.id} has non-finite position`,
          ).toBe(true);
          expect(match.phys.characterPenetrationsAt(
            p.x,
            p.y,
            p.z,
            actor.body.body,
          ), `${id} frame ${frame} actor ${actor.id} ${actor.state}`).toEqual([]);
          if (actor.state === 'ground') {
            expect(actor.body.grounded, `${id} frame ${frame} actor ${actor.id} false ground`).toBe(true);
          }
          const flying = actor.state === 'freefall' || actor.state === 'glide';
          if (actor.isPlayer) {
            sawPlayerFlight ||= flying;
            sawPlayerGround ||= actor.state === 'ground' && actor.body.grounded;
          } else {
            sawBotFlight ||= flying;
            sawBotGround ||= actor.state === 'ground' && actor.body.grounded;
          }
        }

        if (liveFrames >= 360 && sawPlayerGround && sawBotGround) break;
      }

      expect(sawPlayerFlight).toBe(true);
      expect(sawPlayerGround).toBe(true);
      expect(sawBotFlight).toBe(true);
      expect(sawBotGround).toBe(true);
      expect(match.phase).toBe('live');
      expect(Math.hypot(
        player.body.position.x - origin.x,
        player.body.position.z - origin.z,
      )).toBeGreaterThan(4);
      match.dispose();
    }, 60_000);
  }
});
