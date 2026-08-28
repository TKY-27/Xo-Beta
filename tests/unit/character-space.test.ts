import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
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
import { getSettings } from '../../src/core/settings';
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
    const noCollision = { cameraCast: () => null };

    rig.update(actor, 1 / 60, noCollision);
    expect(rig.camera.position.y).toBeCloseTo(feetY + MOVE.eyeHeight, 6);

    actor.crouched = true;
    rig.update(actor, 1, noCollision);
    expect(rig.camera.position.y).toBeCloseTo(feetY + MOVE.crouchEyeHeight, 6);

    actor.crouched = false;
    rig.mode = 'tps';
    rig.update(actor, 1, noCollision);
    expect(rig.camera.position.y).toBeCloseTo(feetY + MOVE.eyeHeight - 0.55, 6);

    rig.updateSpectate(actor, 1 / 60, noCollision);
    expect(rig.camera.position.y).toBeCloseTo(actor.eyeY - 0.2, 6);
  });

  it('ignores the owning actor during a TPS camera sweep and shortens only against scenery', () => {
    const phys = new PhysicsWorld();
    const body = new CharBody(phys, 1, 0, CAPSULE_CENTER_OFFSET, 0);
    const actor = new Actor('TPS_OWNER', true, body, 0x5fd0ff);
    phys.flush();

    const rig = new CameraRig(16 / 9);
    rig.mode = 'tps';
    rig.update(actor, 1, phys);
    expect(rig.camera.position.z).toBeGreaterThan(4.2);

    phys.addStaticBox(0, 2, 3, 4, 2, 0.15, 0, 'stone');
    phys.flush();
    rig.update(actor, 1, phys);
    expect(rig.camera.position.z).toBeGreaterThan(0.75);
    expect(rig.camera.position.z).toBeLessThan(3);
    body.dispose();
    phys.dispose();
  });

  it('projects the full TPS character at the configured left or right composition', () => {
    const actor = actorAtFeet('COMPOSE', 0, 0, 0);
    const rig = new CameraRig(16 / 9);
    const noCollision = { cameraCast: () => null };
    rig.mode = 'tps';

    const screenPosition = () => {
      rig.camera.updateMatrixWorld(true);
      const center = new THREE.Vector3(0, 0.93, 0).project(rig.camera);
      const feet = new THREE.Vector3(0, 0, 0).project(rig.camera);
      const head = new THREE.Vector3(0, 1.86, 0).project(rig.camera);
      const cameraSpaceCenter = new THREE.Vector3(0, 0.93, 0).applyMatrix4(rig.camera.matrixWorldInverse);
      return {
        x: (center.x + 1) / 2,
        feetY: (1 - feet.y) / 2,
        headY: (1 - head.y) / 2,
        cameraZ: cameraSpaceCenter.z,
      };
    };

    getSettings().tpsCharacterSide = 'left';
    rig.update(actor, 1, noCollision);
    const left = screenPosition();
    expect(left.x).toBeGreaterThan(0.32);
    expect(left.x).toBeLessThan(0.39);
    expect(left.headY).toBeGreaterThan(0);
    expect(left.feetY).toBeLessThan(1);
    expect(left.cameraZ).toBeLessThan(-0.1);

    getSettings().tpsCharacterSide = 'right';
    rig.update(actor, 1, noCollision);
    const right = screenPosition();
    expect(right.x).toBeGreaterThan(0.61);
    expect(right.x).toBeLessThan(0.68);
    expect(right.cameraZ).toBeLessThan(-0.1);
    getSettings().tpsCharacterSide = 'left';
  });

  it('clears sniper scope and FOV state when camera ownership changes', () => {
    const actor = actorAtFeet('SCOPE', 0, 0, 0);
    actor.inv.slots[0] = { kind: 'weapon', weaponId: 'sniper', rarity: 'common', ammoInMag: 1 };
    actor.inv.selected = 0;
    actor.wpn.adsAmount = 1;
    const rig = new CameraRig(16 / 9);
    rig.update(actor, 1, { cameraCast: () => null });
    expect(rig.scoped).toBe(true);
    rig.resetAimState();
    expect(rig.scoped).toBe(false);
    expect(rig.camera.fov).toBe(getSettings().fov);
  });

  it('keeps the TPS transport camera at a stable overhead height with continuous free look', () => {
    const rig = new CameraRig(16 / 9);
    rig.mode = 'tps';
    const transport = { x: 12, y: 120, z: -8 };
    const slot = { x: 0, y: 0, z: 0 };

    rig.updateTransport(transport, slot, 0, -0.4, 0, 1);
    const first = rig.camera.position.clone();
    expect(first.y).toBeCloseTo(transport.y + 22, 4);
    expect(first.distanceTo(new THREE.Vector3(transport.x, transport.y - 2.5, transport.z)))
      .toBeGreaterThan(35);
    rig.camera.updateMatrixWorld(true);
    const hullScreen = new THREE.Vector3(transport.x, transport.y - 2.5, transport.z).project(rig.camera);
    expect((hullScreen.x + 1) / 2).toBeGreaterThan(0.4);
    expect((hullScreen.x + 1) / 2).toBeLessThan(0.6);
    expect((1 - hullScreen.y) / 2).toBeGreaterThan(0.55);
    expect((1 - hullScreen.y) / 2).toBeLessThan(0.78);

    rig.updateTransport(transport, slot, 0.02, 0.9, 0, 1);
    const second = rig.camera.position.clone();
    expect(second.y).toBeCloseTo(first.y, 4);
    expect(second.distanceTo(first)).toBeGreaterThan(0.1);
    expect(second.distanceTo(first)).toBeLessThan(1);
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
