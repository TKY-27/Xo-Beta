import { beforeAll, describe, expect, it } from 'vitest';
import { CharBody, PhysicsWorld } from '../../src/physics/physics';
import { buildColliders } from '../../src/world/builder';
import { ensureWorldReady, loadMap, MAP_LIST, type MapId } from '../../src/world';
import { CAPSULE_CENTER_OFFSET, MovementSystem } from '../../src/sim/movement';
import { Actor } from '../../src/sim/actor';
import { emptyCommand } from '../../src/sim/input';
import type { GeoBox, MapDef } from '../../src/world/types';

beforeAll(async () => {
  await ensureWorldReady();
});

/** Guard proxies: hidden continuous colliders placed along visible rail lines. */
function guardProxies(def: MapDef): GeoBox[] {
  return def.geo.filter((g): g is GeoBox => g.kind === 'box'
    && g.noRender === true
    && g.stairRamp !== true
    && g.sy >= 0.5
    && g.sx <= 0.4
    && g.sz >= 1.0);
}

function movementFor(phys: PhysicsWorld): MovementSystem {
  return new MovementSystem(phys, {
    onFootstep: () => undefined,
    onLand: () => undefined,
    onJump: () => undefined,
    onSlide: () => undefined,
    onWallrunStart: () => undefined,
    onMantle: () => undefined,
    onGrappleAttach: () => undefined,
    onGrappleRelease: () => undefined,
    onPoundImpact: () => undefined,
    onDash: () => undefined,
    onSplash: () => undefined,
  });
}

const MAPS: MapId[] = MAP_LIST.map((entry) => entry.id);

describe('railing guard proxies', () => {
  it('every map exposes functional guard envelopes beside visible rails', () => {
    for (const id of MAPS) {
      const def = loadMap(id).def;
      const guards = guardProxies(def);
      // Guarded stair sites exist on every map (fire escapes, towers,
      // lookouts, ramps or tank walkways).
      expect(guards.length, `${id} has no guard proxies`).toBeGreaterThan(0);
      for (const guard of guards) {
        expect(guard.sz, `${id} guard too short`).toBeGreaterThan(1.0);
      }
    }
  });

  it('a capsule pushing sideways cannot pass through any guard envelope', () => {
    for (const id of MAPS) {
      const def = loadMap(id).def;
      const phys = new PhysicsWorld();
      buildColliders(def, phys);
      phys.flush();
      try {
        const guards = guardProxies(def);
        expect(guards.length).toBeGreaterThan(0);
        let tested = 0;
        const failures: string[] = [];
        for (const guard of guards) {
          // Horizontal perpendicular of the yaw-aligned guard.
          const px = Math.cos(guard.yaw);
          const pz = -Math.sin(guard.yaw);
          for (const side of [-1, 1]) {
            const spawn = {
              x: guard.x + px * side * (guard.sx / 2 + 0.8),
              z: guard.z + pz * side * (guard.sx / 2 + 0.8),
            };
            const support = phys.surfaceAt(spawn.x, spawn.z, guard.y + guard.sy / 2 + 1.5, 3);
            if (support === null) continue;
            if (Math.abs(support - (guard.y - guard.sy / 2)) > 1.0) continue;
            const body = new CharBody(
              phys,
              9500 + (tested++ % 400),
              spawn.x,
              support + CAPSULE_CENTER_OFFSET + 0.03,
              spawn.z,
            );
            const actor = new Actor('guard-push', body, 0x5fd0ff);
            const movement = movementFor(phys);
            for (let f = 0; f < 10; f++) {
              movement.update(actor, emptyCommand(), 1 / 60);
              phys.fixedStep(1 / 60);
            }
            if (!body.grounded
              || phys.characterPenetrationsAt(body.position.x, body.position.y, body.position.z, body.body).length > 0) {
              body.dispose();
              continue;
            }
            // Push laterally into the guard for 1.2 s.
            const toward = side > 0 ? -1 : 1;
            const localRight = px * toward;
            const localForward = pz * toward;
            for (let f = 0; f < 72; f++) {
              const command = emptyCommand();
              // moveX = right axis: project (px,pz) toward the guard.
              command.moveX = 1;
              command.yaw = Math.atan2(-localRight, -localForward);
              movement.update(actor, command, 1 / 60);
              phys.fixedStep(1 / 60);
            }
            // Signed distance from the guard plane (positive = original side).
            const signed = ((body.position.x - guard.x) * px
              + (body.position.z - guard.z) * pz) * side;
            if (signed < guard.sx / 2 - 0.05) {
              failures.push(
                `${id} guard @(${guard.x.toFixed(1)},${guard.y.toFixed(1)},${guard.z.toFixed(1)}) `
                + `side ${side}: capsule crossed to signed=${signed.toFixed(2)}`,
              );
            }
            body.dispose();
          }
        }
        expect(tested, `${id}: no guard side was testable`).toBeGreaterThan(0);
        expect(failures, failures.join('\n')).toEqual([]);
      } finally {
        phys.dispose();
      }
    }
  }, 300_000);

  it('overpass access flights keep an edge-hugging walker on the structure', () => {
    // Before the guard envelopes existed, a diagonal walk hugging the outer
    // edge of the exposed overpass access flights drifted off the structure
    // and reached the end line at ground level (feetY ~0 instead of ~6.8).
    const def = loadMap('neocity').def;
    const phys = new PhysicsWorld();
    buildColliders(def, phys);
    phys.flush();
    try {
      const flights = def.stairs.filter((f) => Math.abs(f.y) < 0.01 && f.width >= 2.2 && f.totalRise > 6);
      expect(flights.length).toBeGreaterThan(0);
      for (const flight of flights) {
        const dirX = flight.dir === 1 ? 1 : flight.dir === 3 ? -1 : 0;
        const dirZ = flight.dir === 0 ? 1 : flight.dir === 2 ? -1 : 0;
        const crossX = -dirZ;
        const crossZ = dirX;
        const body = new CharBody(
          phys,
          9901,
          flight.x + crossX * (flight.width / 2 - 0.5),
          flight.y + CAPSULE_CENTER_OFFSET + 0.05,
          flight.z + crossZ * (flight.width / 2 - 0.5),
        );
        const actor = new Actor('overpass-edge', body, 0x5fd0ff);
        const movement = movementFor(phys);
        for (let f = 0; f < 10; f++) {
          movement.update(actor, emptyCommand(), 1 / 60);
          phys.fixedStep(1 / 60);
        }
        let climbed = false;
        const dirYaw = flight.dir === 0 ? Math.PI : flight.dir === 1 ? -Math.PI / 2 : flight.dir === 2 ? 0 : Math.PI / 2;
        for (let f = 0; f < 540 && !climbed; f++) {
          const command = emptyCommand();
          command.moveZ = 1;
          command.yaw = dirYaw;
          movement.update(actor, command, 1 / 60);
          phys.fixedStep(1 / 60);
          const along = (body.position.x - flight.x) * dirX + (body.position.z - flight.z) * dirZ;
          const feet = body.position.y - CAPSULE_CENTER_OFFSET;
          if (along >= flight.run * 0.92 && feet >= flight.y + flight.totalRise - 0.25) climbed = true;
        }
        const feet = body.position.y - CAPSULE_CENTER_OFFSET;
        expect(climbed, `flight @(${flight.x},${flight.z}) edge walk fell off at feetY=${feet.toFixed(2)}`).toBe(true);
        body.dispose();
      }
    } finally {
      phys.dispose();
    }
  }, 120_000);
});
