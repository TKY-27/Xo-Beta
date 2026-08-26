import { beforeAll, describe, expect, it } from 'vitest';
import { MELEE, MOVE } from '../../src/core/balance';
import {
  CAPSULE_CENTER_OFFSET,
  CharBody,
  feetYFromBodyCenter,
  initPhysics,
  PhysicsWorld,
  type CharBody as CharBodyType,
} from '../../src/physics/physics';
import { CameraRig } from '../../src/render/cameraRig';
import { Actor } from '../../src/sim/actor';
import { CombatSystem } from '../../src/sim/combat';
import { emptyCommand } from '../../src/sim/input';
import { groundSurfaceForActor } from '../../src/sim/match';
import { MovementSystem, type MovementEvents } from '../../src/sim/movement';
import { buildColliders, WorldBuilder } from '../../src/world/builder';

beforeAll(async () => {
  await initPhysics();
});

const noMovementEvents: MovementEvents = {
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
};

function fakeBody(x: number, y: number, z: number): CharBodyType {
  return {
    position: { x, y, z },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
  } as CharBodyType;
}

function actorAtFeet(name: string, x: number, feetY: number, z: number): Actor {
  return new Actor(name, true, fakeBody(x, feetY + CAPSULE_CENTER_OFFSET, z), 0x5fd0ff);
}

describe('authoritative character-space coordinates', () => {
  it('derives standing and crouched eyes from the physical soles', () => {
    const actor = actorAtFeet('EYE', 0, 7.25, 0);
    expect(feetYFromBodyCenter(actor.body.position.y)).toBeCloseTo(7.25, 8);
    expect(actor.eyeY).toBeCloseTo(7.25 + MOVE.eyeHeight, 8);
    actor.crouched = true;
    expect(actor.eyeY).toBeCloseTo(7.25 + MOVE.crouchEyeHeight, 8);
  });

  it('anchors FPS, TPS and spectator cameras to soles instead of adding eye height to the capsule centre', () => {
    const feetY = 4.5;
    const actor = actorAtFeet('CAMERA', 2, feetY, -3);
    const rig = new CameraRig(16 / 9);
    const noCollision = { raycast: () => null };

    rig.update(actor, 1 / 60, noCollision);
    expect(rig.camera.position.y).toBeCloseTo(feetY + MOVE.eyeHeight, 6);

    actor.crouched = true;
    rig.update(actor, 1, noCollision);
    expect(rig.camera.position.y).toBeCloseTo(feetY + MOVE.crouchEyeHeight, 6);

    actor.crouched = false;
    rig.mode = 'tps';
    rig.update(actor, 1, noCollision);
    expect(rig.camera.position.y).toBeCloseTo(feetY + MOVE.eyeHeight + 0.25, 6);

    rig.updateSpectate(actor, 1 / 60);
    expect(rig.camera.position.y).toBeCloseTo(actor.eyeY - 0.2, 6);
  });

  it('probes the support immediately below the soles for footstep material', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 4, 0.25, 4, 0, 'wood');
    phys.flush();
    const actor = actorAtFeet('STEP', 0, 0.05, 0);
    expect(groundSurfaceForActor(phys, actor)).toBe('wood');
  });

  it('keeps arbitrary-yaw boxes and vehicles on their rendered local footprint', () => {
    const phys = new PhysicsWorld();
    const b = new WorldBuilder('rotation', 'Rotation', 'Rotation', 100);
    b.box(0, 1, 0, 8, 2, 2, 'concrete', Math.PI / 4);
    b.def.vehicles.push({
      x: 20, y: 0, z: 0, yaw: Math.PI / 4,
      variant: 'sedan', color: 0xffffff, explodable: false,
    });
    buildColliders(b.def, phys);
    phys.flush();

    // Along the rotated long axis is solid; a point inside the old expanded
    // AABB but outside the rendered short axis must remain clear.
    expect(phys.surfaceAt(2.5, -2.5, 4, 4)).toBeCloseTo(2, 5);
    expect(phys.surfaceAt(2.5, 0, 4, 4)).toBeNull();

    // Vehicles use the same arbitrary yaw as their render group instead of
    // snapping the collider to one of four axis-aligned footprints.
    expect(phys.surfaceAt(21.2, 1.2, 4, 4)).toBeCloseTo(1.65, 5);
    expect(phys.surfaceAt(21.2, -1.2, 4, 4)).toBeNull();
  });

  it('detects chest-deep water using foot-relative torso height', () => {
    const phys = new PhysicsWorld();
    const body = new CharBody(phys, 77, 0, CAPSULE_CENTER_OFFSET, 0);
    const actor = new Actor('SWIM', true, body, 0x5fd0ff);
    const movement = new MovementSystem(phys, noMovementEvents);
    movement.waterAt = (_x, y) => y <= 2.2
      ? { minX: -10, maxX: 10, minZ: -10, maxZ: 10, surfaceY: 2, depth: 5 }
      : null;

    movement.update(actor, emptyCommand(), 1 / 60);
    expect(actor.inWater).toBe(true);
    expect(actor.state).toBe('swim');
    body.dispose();
  });
});

describe('melee height resolution', () => {
  it('does not double-add the attacker body height and turn level punches into headshots', () => {
    const attacker = actorAtFeet('ATTACKER', 0, 0, 0);
    const target = actorAtFeet('TARGET', 0, 0, -1);
    let headshot: boolean | null = null;
    const movement = {
      lookDir: () => ({ x: 0, y: 0, z: -1 }),
    } as unknown as MovementSystem;
    const combat = new CombatSystem({} as PhysicsWorld, movement, {
      onMuzzleFlash: () => undefined,
      onShotFired: () => undefined,
      onImpact: () => undefined,
      onActorHit: () => undefined,
      onTracer: () => undefined,
      onRicochet: () => undefined,
      onGlassBreak: () => undefined,
      onDestructibleDamaged: () => undefined,
      onMeleeSwing: () => undefined,
      onMeleeHit: (_target, _attacker, damage, _killed, isHeadshot) => {
        headshot = isHeadshot;
        expect(damage).toBe(MELEE.damage);
      },
    });

    expect(combat.tryMelee(attacker, 1 / 60, [attacker, target])).toBe(true);
    expect(headshot).toBe(false);
  });
});
