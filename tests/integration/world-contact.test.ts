import { beforeAll, describe, expect, it } from 'vitest';
import { CharBody, PhysicsWorld } from '../../src/physics/physics';
import {
  buildColliders,
  filterInvalidCrates,
  groundCrates,
  isChestPlacementClear,
  isTreePlacementClear,
  resolveSupportedChests,
  WorldBuilder,
} from '../../src/world/builder';
import { ensureWorldReady, loadMap, type MapId } from '../../src/world';
import { CAPSULE_CENTER_OFFSET, feetYFromBodyCenter } from '../../src/sim/movement';
import { MovementSystem } from '../../src/sim/movement';
import { Actor } from '../../src/sim/actor';
import { emptyCommand } from '../../src/sim/input';
import { MOVE } from '../../src/core/balance';
import { ROCK_CLEARANCE_RADIUS } from '../../src/world/types';
import { rockColliderProfile } from '../../src/world/rockProfiles';

beforeAll(async () => {
  await ensureWorldReady();
});

function occupiedAt(def: ReturnType<typeof loadMap>['def'], x: number, z: number): boolean {
  if (def.geo.some((g) => {
    const extent = g.kind === 'box' ? Math.max(g.sx, g.sz) / 2 : g.r;
    return Math.hypot(g.x - x, g.z - z) < extent + 4;
  })) return true;
  if (def.trees.some((t) => Math.hypot(t.x - x, t.z - z) < t.scale + 4)) return true;
  if (def.rocks.some((r) => Math.hypot(r.x - x, r.z - z) < r.scale + 4)) return true;
  if (def.chests.some((c) => Math.hypot(c.x - x, c.z - z) < 4)) return true;
  return def.vehicles.some((v) => Math.hypot(v.x - x, v.z - z) < 8);
}

function movementFor(
  phys: PhysicsWorld,
  onSplash: (actor: Actor, heavy: boolean) => void = () => undefined,
  onJump: (actor: Actor, kind: string) => void = () => undefined,
  onLand: (actor: Actor, impactSpeed: number, fallDamage: number) => void = () => undefined,
  onFootstep: (actor: Actor, running: boolean) => void = () => undefined,
): MovementSystem {
  return new MovementSystem(phys, {
    onFootstep,
    onLand,
    onJump,
    onSlide: () => undefined,
    onWallrunStart: () => undefined,
    onMantle: () => undefined,
    onGrappleAttach: () => undefined,
    onGrappleRelease: () => undefined,
    onPoundImpact: () => undefined,
    onDash: () => undefined,
    onSplash,
  });
}

describe('fall damage', () => {
  it('scales with inferred fall height and is lighter than the former damage curve', () => {
    const phys = new PhysicsWorld();
    const damageAt = (speed: number, id: number): number => {
      const body = new CharBody(phys, id, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
      const actor = new Actor(`Fall damage ${id}`, body, 0xffffff);
      let damage = 0;
      const movement = movementFor(
        phys,
        () => undefined,
        () => undefined,
        (_landed, _impactSpeed, fallDamage) => { damage = fallDamage; },
      );
      actor.peakFallSpeed = speed;
      movement.notifyGrounded(actor);
      body.dispose();
      return damage;
    };

    expect(MOVE.fallDamageMax).toBe(80);
    expect(damageAt(MOVE.fallDamageMinSpeed, 9100)).toBe(0);
    const minSquared = MOVE.fallDamageMinSpeed ** 2;
    const rangeSquared = MOVE.fallDamageMaxSpeed ** 2 - minSquared;
    for (const [index, heightFraction] of [0.25, 0.5, 0.75].entries()) {
      const speed = Math.sqrt(minSquared + rangeSquared * heightFraction);
      expect(damageAt(speed, 9101 + index)).toBe(Math.round(MOVE.fallDamageMax * heightFraction));
    }
    expect(damageAt(MOVE.fallDamageMaxSpeed, 9104)).toBe(80);
    phys.dispose();
  });
});

describe('rendered terrain and physics ground alignment', () => {
  it('resolves a ray-selected wall-edge landing to a clear point on the same floor', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 5, 0.25, 5, 0, 'stone');
    phys.addStaticBox(0.35, 1, 0, 0.2, 1, 1, 0, 'stone');
    phys.flush();
    const requestedY = CAPSULE_CENTER_OFFSET + 0.05;
    expect(phys.isCharacterPositionClear(0, requestedY, 0)).toBe(false);
    const placement = phys.findClearStandingPlacement(0, 0, 0);
    expect(placement).not.toBeNull();
    expect(phys.characterPenetrationsAt(placement!.x, placement!.y, placement!.z)).toEqual([]);
    expect(feetYFromBodyCenter(placement!.y)).toBeCloseTo(0.05, 2);
    phys.dispose();
  });

  it('rejects an unproven support layer below a one-sided terrain surface', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, 9.75, 0, 5, 0.25, 5, 0, 'dirt');
    phys.flush();
    expect(phys.findClearStandingPlacement(0, 0, 0)).toBeNull();
    const placement = phys.findClearStandingPlacement(0, 10, 0);
    expect(placement).not.toBeNull();
    expect(feetYFromBodyCenter(placement!.y)).toBeCloseTo(10.05, 2);
    expect(phys.characterPenetrationsAt(placement!.x, placement!.y, placement!.z)).toEqual([]);
    phys.dispose();
  });

  it('rejects a swimming capsule hidden below one-sided terrain', () => {
    const phys = new PhysicsWorld();
    const heights = new Float32Array(9).fill(0);
    phys.addHeightfield(-5, -5, 5, 5, heights, 3, 3, 'dirt');
    phys.flush();

    expect(phys.isCharacterPositionClear(0, -0.3, 0)).toBe(true);
    expect(phys.findClearSwimmingPlacement(0, -0.3, 0)).toBeNull();
    expect(phys.findClearSwimmingPlacement(0, 2, 0)).toEqual({
      x: 0,
      y: 2 - MOVE.swimSurfaceCenterDepth,
      z: 0,
    });
    phys.dispose();
  });

  it('reports the finished terrain separately from roofs and authored floors', () => {
    const phys = new PhysicsWorld();
    const heights = new Float32Array(9).fill(10);
    phys.addHeightfield(-5, -5, 5, 5, heights, 3, 3, 'dirt');
    phys.addStaticBox(0, 20, 0, 2, 0.5, 2, 0, 'metal');
    phys.flush();

    expect(phys.surfaceAt(0, 0, 30, 40)).toBeCloseTo(20.5, 4);
    expect(phys.terrainSurfaceAt(0, 0, 30, 40)).toBeCloseTo(10, 4);
    expect(phys.terrainSurfaceAt(8, 0, 30, 40)).toBeNull();
    phys.addStaticBox(8, 4.5, 0, 2, 0.5, 2, 0, 'dirt', true);
    phys.flush();
    expect(phys.terrainSurfaceAt(8, 0, 30, 40)).toBeCloseTo(5, 4);
    phys.dispose();
  });

  it('matches cylinder and sphere collision footprints to their rendered radii', () => {
    const builder = new WorldBuilder('round-colliders', 'Round colliders', 'Visual parity fixture', 100);
    builder.cyl(0, 1, 0, 1, 2, 'metal');
    builder.sphere(4, 1, 0, 1, 'rock');
    const phys = new PhysicsWorld();
    buildColliders(builder.def, phys);
    phys.flush();
    expect(phys.surfaceAt(0.95, 0, 3, 4)).toBeCloseTo(2, 2);
    expect(phys.surfaceAt(1.01, 0, 3, 4)).toBeNull();
    expect(phys.surfaceAt(4.95, 0, 3, 4)).not.toBeNull();
    expect(phys.surfaceAt(5.01, 0, 3, 4)).toBeNull();
    phys.dispose();
  });

  it('keeps cameras and characters outside the visible medium-rock footprint', () => {
    const builder = new WorldBuilder('rock-collider', 'Rock collider', 'Visual parity fixture', 100);
    builder.rock(0, 0, 0, 1);
    const phys = new PhysicsWorld();
    buildColliders(builder.def, phys);
    phys.flush();
    const rock = builder.def.rocks[0]!;
    const profile = rockColliderProfile(rock.variant);
    // Widest profile-box extent along +z and +x at camera/character height.
    const extent = (axis: 'x' | 'z'): number => Math.max(...profile.boxes
      .filter((b) => b.y + b.hy > 0.9 && b.y - b.hy < 1.3)
      .map((b) => (axis === 'z' ? b.z : b.x)
        + b.hx * Math.abs(Math.sin(b.yaw)) + b.hz * Math.abs(Math.cos(b.yaw))));
    const zExtent = extent('z');
    const hit = phys.cameraCast(0, 1, zExtent + 1, 0, 0, -1, 4, 0.2);
    expect(hit).not.toBeNull();
    expect(hit!.dist).toBeLessThan(1.5);
    // A capsule on the rock's measured footprint cannot stand inside it.
    expect(phys.isCharacterPositionClear(0, CAPSULE_CENTER_OFFSET, 0)).toBe(false);
    // And the measured silhouette leaves no oversized invisible corner:
    // standing just outside the widest collider extent is clear.
    expect(phys.isCharacterPositionClear(
      extent('x') + 0.62,
      CAPSULE_CENTER_OFFSET,
      0,
    )).toBe(true);
    phys.dispose();
  });

  it('does not accumulate grounded penetration while idling on a flat collider', () => {
    for (const [x, z] of [[-242, -242], [-100, -100], [4, 4], [100, 100]] as const) {
      const phys = new PhysicsWorld();
      phys.addStaticBox(0, -1, 0, 350, 1, 350, 0, 'stone');
      phys.flush();
      const body = new CharBody(phys, 80, x, CAPSULE_CENTER_OFFSET + 0.05, z);
      const actor = new Actor('IDLE SUPPORT TEST', body, 0x5fd0ff);
      const movement = movementFor(phys);
      for (let frame = 0; frame < 180; frame++) {
        movement.update(actor, emptyCommand(), 1 / 60);
        phys.fixedStep(1 / 60);
        expect(phys.characterPenetrationsAt(x, body.position.y, z, body.body)).toEqual([]);
      }
      expect(body.grounded).toBe(true);
      expect(feetYFromBodyCenter(body.position.y)).toBeCloseTo(0, 2);
      body.dispose();
      phys.dispose();
    }
  });

  it('does not grant a second ordinary jump or emit a double-jump event while airborne', () => {
    const phys = new PhysicsWorld();
    const body = new CharBody(phys, 997, 0, CAPSULE_CENTER_OFFSET + 3, 0);
    const actor = new Actor('Single jump regression', body, 0xffffff);
    const jumpKinds: string[] = [];
    const movement = movementFor(phys, undefined, (_jumpingActor, kind) => jumpKinds.push(kind));
    actor.state = 'air';
    actor.jumpsUsed = 1;
    body.velocity.y = -1;

    const command = emptyCommand();
    command.jumpPressed = true;
    movement.update(actor, command, 1 / 60);

    expect(body.velocity.y).toBeLessThanOrEqual(-1);
    expect(actor.jumpsUsed).toBe(1);
    expect(jumpKinds).not.toContain('double');
    body.dispose();
    phys.dispose();
  });

  it('never starts a mantle from forward input alone', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -1, 4, 0.25, 4, 0, 'stone');
    phys.addStaticBox(0, 0.9, -1, 2, 0.9, 0.45, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 998, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Forward-only mantle regression', body, 0xffffff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }

    const command = emptyCommand();
    command.moveZ = 1;
    movement.update(actor, command, 1 / 60);

    expect(actor.state).not.toBe('mantle');
    body.dispose();
    phys.dispose();
  });

  it('refuses a jump-forward mantle onto a 0.35 metre window ledge', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -1, 4, 0.25, 4, 0, 'stone');
    phys.addStaticBox(0, 0.9, -0.75, 2, 0.9, 0.175, 0, 'metal');
    phys.flush();
    const body = new CharBody(phys, 999, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Thin ledge mantle regression', body, 0xffffff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }

    const command = emptyCommand();
    command.moveZ = 1;
    command.jumpPressed = true;
    movement.update(actor, command, 1 / 60);

    expect(actor.state).not.toBe('mantle');
    body.dispose();
    phys.dispose();
  });

  it('refuses a mantle when the centre has support but the capsule sides do not', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -1, 4, 0.25, 4, 0, 'stone');
    phys.addStaticBox(0, 0.9, -1, 0.15, 0.9, 0.45, 0, 'metal');
    phys.flush();
    const body = new CharBody(phys, 1008, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Mantle side support regression', body, 0xffffff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    const command = emptyCommand();
    command.moveZ = 1;
    command.jumpPressed = true;
    movement.update(actor, command, 1 / 60);

    expect(actor.state).not.toBe('mantle');
    body.dispose();
    phys.dispose();
  });

  it('leaves step-height obstacles to autostep instead of treating them as mantles', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -1, 4, 0.25, 4, 0, 'stone');
    phys.addStaticBox(0, MOVE.stepHeight / 2, -1, 2, MOVE.stepHeight / 2, 0.45, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 1009, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Mantle step-height regression', body, 0xffffff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    const command = emptyCommand();
    command.moveZ = 1;
    command.jumpPressed = true;
    movement.update(actor, command, 1 / 60);

    expect(actor.state).not.toBe('mantle');
    body.dispose();
    phys.dispose();
  });

  it('does not climb continuously when jump is spammed into one wall for five seconds', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -10, 100, 0.25, 100, 0, 'stone');
    phys.addStaticBox(0, 0.9, -1, 2, 0.9, 0.45, 0, 'stone');
    phys.addStaticBox(0, 5, -2.25, 2, 5, 0.25, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 1000, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Mantle spam regression', body, 0xffffff);
    const movement = movementFor(phys);
    let maxHeight = body.position.y;

    for (let frame = 0; frame < 300; frame++) {
      const command = emptyCommand();
      command.moveZ = 1;
      command.jumpPressed = frame % 6 === 0;
      movement.update(actor, command, 1 / 60);
      phys.fixedStep(1 / 60);
      maxHeight = Math.max(maxHeight, body.position.y);
    }

    expect(maxHeight).toBeLessThan(6);
    body.dispose();
    phys.dispose();
  });

  it('blocks a second mantle until recovery expires', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -2, 5, 0.25, 5, 0, 'stone');
    phys.addStaticBox(0, 0.9, -1, 2, 0.9, 0.45, 0, 'stone');
    phys.addStaticBox(0, 2.7, -2, 2, 0.9, 0.45, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 1001, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Mantle recovery regression', body, 0xffffff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    const first = emptyCommand();
    first.moveZ = 1;
    first.jumpPressed = true;
    movement.update(actor, first, 1 / 60);
    phys.fixedStep(1 / 60);
    expect(actor.state).toBe('mantle');
    for (let frame = 0; frame < 40 && actor.state === 'mantle'; frame++) {
      const command = emptyCommand();
      command.moveZ = 1;
      movement.update(actor, command, 1 / 60);
      phys.fixedStep(1 / 60);
    }
    expect(actor.state).toBe('ground');

    const second = emptyCommand();
    second.moveZ = 1;
    second.jumpPressed = true;
    movement.update(actor, second, 1 / 60);

    expect(actor.mantleCooldown).toBeGreaterThan(0);
    expect(actor.state).not.toBe('mantle');
    for (let frame = 0; frame < 120 && (!body.grounded || actor.mantleCooldown > 0); frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    expect(actor.mantleCooldown).toBe(0);
    expect(body.grounded).toBe(true);
    body.teleport(0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    actor.state = 'air';
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    const recovered = emptyCommand();
    recovered.moveZ = 1;
    recovered.jumpPressed = true;
    movement.update(actor, recovered, 1 / 60);
    expect(actor.state).toBe('mantle');
    body.dispose();
    phys.dispose();
  });

  it('does not restore the ordinary jump after mantle completion', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -1, 4, 0.25, 4, 0, 'stone');
    phys.addStaticBox(0, 0.9, -1, 2, 0.9, 0.45, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 1002, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Mantle jump reset regression', body, 0xffffff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    actor.jumpsUsed = 1;
    const start = emptyCommand();
    start.moveZ = 1;
    start.jumpPressed = true;
    movement.update(actor, start, 1 / 60);
    phys.fixedStep(1 / 60);
    expect(actor.state).toBe('mantle');
    for (let frame = 0; frame < 40 && actor.state === 'mantle'; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }

    expect(actor.state).toBe('ground');
    expect(actor.jumpsUsed).toBe(1);
    body.dispose();
    phys.dispose();
  });

  it('discards a blocked diagonal dash component instead of releasing it away from the wall', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 20, 0.25, 20, 0, 'stone');
    phys.addStaticBox(0, 5, 0, 0.25, 5, 20, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 1003, -0.72, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Dash wall release regression', body, 0xffffff);
    const movement = movementFor(phys);
    body.move(0, -0.1, 0);
    phys.fixedStep(1 / 60);

    const dash = emptyCommand();
    dash.moveZ = 1;
    dash.yaw = -Math.PI / 4;
    dash.dashPressed = true;
    let sawWallContact = false;
    for (let frame = 0; frame < 3; frame++) {
      movement.update(actor, dash, 1 / 60);
      phys.fixedStep(1 / 60);
      sawWallContact ||= body.slidAlongWall;
      dash.dashPressed = false;
    }
    expect(sawWallContact).toBe(true);
    expect(body.velocity.x).toBeLessThan(0.1);

    const away = emptyCommand();
    away.moveZ = 1;
    away.yaw = Math.PI / 2;
    movement.update(actor, away, 1 / 60);
    expect(body.velocity.x).toBeLessThanOrEqual(0.5);
    body.dispose();
    phys.dispose();
  });

  it('discards blocked slide velocity while retaining authored slide speed', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 20, 0.25, 20, 0, 'stone');
    phys.addStaticBox(0, 5, 0, 0.25, 5, 20, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 1004, -0.72, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Slide wall regression', body, 0xffffff);
    const movement = movementFor(phys);
    body.move(0, -0.1, 0);
    phys.fixedStep(1 / 60);
    actor.state = 'slide';
    actor.slideDirX = Math.SQRT1_2;
    actor.slideDirZ = -Math.SQRT1_2;
    body.velocity.x = 10;
    body.velocity.z = -10;
    const command = emptyCommand();
    command.crouchHeld = true;
    for (let frame = 0; frame < 3; frame++) {
      movement.update(actor, command, 1 / 60);
      phys.fixedStep(1 / 60);
    }

    expect(body.slidAlongWall).toBe(true);
    expect(body.velocity.x).toBeLessThan(0.1);
    expect(Math.hypot(body.velocity.x, body.velocity.z)).toBeLessThanOrEqual(
      MOVE.softSpeedCap + MOVE.slideBoostAdd + 0.01,
    );
    body.dispose();
    phys.dispose();
  });

  it('keeps wall sprint and jump spam bounded for ten seconds', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 20, 0.25, 20, 0, 'stone');
    phys.addStaticBox(0, 5, 0, 0.25, 5, 20, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 1005, -0.72, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Wall jump spam speed regression', body, 0xffffff);
    const movement = movementFor(phys);
    body.move(0, -0.1, 0);
    phys.fixedStep(1 / 60);
    let maxSpeed = 0;
    for (let frame = 0; frame < 600; frame++) {
      const command = emptyCommand();
      command.moveZ = 1;
      command.yaw = -Math.PI / 2;
      command.sprint = true;
      command.jumpPressed = frame % 12 === 0;
      movement.update(actor, command, 1 / 60);
      phys.fixedStep(1 / 60);
      maxSpeed = Math.max(maxSpeed, Math.hypot(body.velocity.x, body.velocity.z));
    }

    expect(maxSpeed).toBeLessThanOrEqual(MOVE.softSpeedCap + 0.01);
    body.dispose();
    phys.dispose();
  });

  it('removes outward and excess velocity after a map-boundary clamp', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 10, 0.25, 10, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 1006, 0.99, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Boundary speed cap regression', body, 0xffffff);
    const movement = movementFor(phys);
    movement.bounds = { half: 1 };
    body.move(0, -0.1, 0);
    phys.fixedStep(1 / 60);
    body.velocity.z = 100;
    const command = emptyCommand();
    command.moveZ = 1;
    command.yaw = -Math.PI / 2;
    command.sprint = true;
    command.jumpPressed = true;
    movement.update(actor, command, 1 / 60);

    expect(body.velocity.x).toBeLessThanOrEqual(0);
    expect(Math.hypot(body.velocity.x, body.velocity.z)).toBeLessThanOrEqual(MOVE.softSpeedCap + 0.01);
    let maxBoundarySpeed = 0;
    for (let frame = 0; frame < 600; frame++) {
      command.jumpPressed = frame % 12 === 0;
      movement.update(actor, command, 1 / 60);
      phys.fixedStep(1 / 60);
      maxBoundarySpeed = Math.max(maxBoundarySpeed, Math.hypot(body.velocity.x, body.velocity.z));
    }
    expect(maxBoundarySpeed).toBeLessThanOrEqual(MOVE.dashSpeed + 0.01);
    body.dispose();
    phys.dispose();
  });

  it('preserves the authored dash speed in open space', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 20, 0.25, 20, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 1007, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Open dash speed regression', body, 0xffffff);
    const movement = movementFor(phys);
    body.move(0, -0.1, 0);
    phys.fixedStep(1 / 60);
    const beforeZ = body.position.z;
    const command = emptyCommand();
    command.moveZ = 1;
    command.dashPressed = true;
    movement.update(actor, command, 1 / 60);

    expect(Math.hypot(body.velocity.x, body.velocity.z)).toBeCloseTo(MOVE.dashSpeed, 5);
    expect((beforeZ - body.position.z) * 60).toBeGreaterThan(MOVE.dashSpeed - 0.1);
    body.dispose();
    phys.dispose();
  });

  it('keeps the queued Rapier translation synchronized when flight hits map bounds', () => {
    const phys = new PhysicsWorld();
    const body = new CharBody(phys, 991, 0, 20, 0);
    const actor = new Actor('Boundary glide', body, 0xffffff);
    const movement = movementFor(phys);
    movement.bounds = { half: 1 };
    actor.state = 'glide';
    body.velocity.x = 100;

    movement.update(actor, emptyCommand(), 1 / 60);
    expect(body.position.x).toBeCloseTo(1, 8);
    expect(body.velocity.x).toBe(0);
    phys.step();
    expect(body.body.translation().x).toBeCloseTo(body.position.x, 8);
    expect(Math.abs(body.body.translation().x)).toBeLessThanOrEqual(1);
  });

  it('does not convert blocked wall-stick velocity into jump-spam speed', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, 10, 0, 0.25, 10, 100, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 992, -0.72, CAPSULE_CENTER_OFFSET + 10, 40);
    const actor = new Actor('Wall speed regression', body, 0xffffff);
    const movement = movementFor(phys);
    actor.state = 'wallrun';
    actor.wallSide = 1;
    actor.wallNormalX = -1;
    body.velocity.x = MOVE.sprintSpeed; // blocked, directly into the wall
    body.velocity.z = -MOVE.sprintSpeed; // genuine along-wall momentum

    let preJumpMax = 0;
    let overallMax = 0;
    for (let frame = 0; frame < 60; frame++) {
      const cmd = emptyCommand();
      cmd.moveZ = 1;
      cmd.yaw = 0;
      cmd.jumpPressed = frame === 30;
      movement.update(actor, cmd, 1 / 60);
      phys.fixedStep(1 / 60);
      const speed = Math.hypot(body.velocity.x, body.velocity.z);
      if (frame < 30) preJumpMax = Math.max(preJumpMax, speed);
      overallMax = Math.max(overallMax, speed);
    }

    // The blocked X component must be discarded, not rotated into Z by the
    // wall-run blend. The explicit wall jump may add its authored outward
    // impulse, but repeated input cannot create an unbounded launch.
    expect(preJumpMax).toBeLessThanOrEqual(MOVE.sprintSpeed + 0.01);
    expect(overallMax).toBeLessThan(11.55);
    expect(actor.state).toBe('air');
    body.dispose();
    phys.dispose();
  });

  it('keeps a successful slide entry active for the following movement tick', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 20, 0.25, 20, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 996, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Slide state regression', body, 0xffffff);
    const movement = movementFor(phys);

    body.move(0, -0.1, 0);
    phys.fixedStep(1 / 60);
    expect(body.grounded).toBe(true);
    body.velocity.z = MOVE.slideMinEntrySpeed + 1;

    const entry = emptyCommand();
    entry.crouchPressed = true;
    entry.crouchHeld = true;
    entry.moveZ = 1;
    movement.update(actor, entry, 1 / 60);
    expect(actor.state).toBe('slide');

    const sliding = emptyCommand();
    sliding.crouchHeld = true;
    sliding.moveZ = 1;
    movement.update(actor, sliding, 1 / 60);
    phys.fixedStep(1 / 60);
    expect(actor.state).toBe('slide');
    expect(phys.characterPenetrationsAt(
      body.position.x,
      body.position.y,
      body.position.z,
      body.body,
    )).toEqual([]);
    body.dispose();
    phys.dispose();
  });

  it('keeps crouched movement silent and resets the gait accumulator', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 20, 0.25, 20, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 997, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('Quiet crouch regression', body, 0xffffff);
    let footsteps = 0;
    const movement = movementFor(phys, undefined, undefined, undefined, () => { footsteps++; });

    body.move(0, -0.1, 0);
    phys.fixedStep(1 / 60);
    actor.footstepAccum = 1.4;
    const crouched = emptyCommand();
    crouched.crouchHeld = true;
    crouched.moveZ = 1;
    for (let frame = 0; frame < 120; frame++) {
      movement.update(actor, crouched, 1 / 60);
      phys.fixedStep(1 / 60);
    }

    expect(actor.crouched).toBe(true);
    expect(actor.footstepAccum).toBe(0);
    expect(footsteps).toBe(0);

    body.dispose();
    phys.dispose();
  });

  it('resets wall-run and jump state on the actual KCC landing tick', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 20, 0.25, 20, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 993, 0, CAPSULE_CENTER_OFFSET + 2, 0);
    const actor = new Actor('Landing reset regression', body, 0xffffff);
    const movement = movementFor(phys);
    actor.state = 'air';
    actor.jumpsUsed = MOVE.maxJumps;
    actor.wallrunLanded = false;
    actor.wallrunChains = MOVE.wallRunMaxChains;
    body.velocity.y = -1;

    for (let frame = 0; frame < 120 && !body.grounded; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }

    expect(body.grounded).toBe(true);
    expect(actor.state).toBe('ground');
    expect(actor.jumpsUsed).toBe(0);
    expect(actor.wallrunLanded).toBe(true);
    expect(actor.wallrunChains).toBe(0);
    body.dispose();
    phys.dispose();
  });

  it('marks a wall run airborne so the same-wall guard can activate', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, 5, 0, 0.25, 5, 30, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 994, -0.72, CAPSULE_CENTER_OFFSET + 3, 8);
    const actor = new Actor('Wall re-entry regression', body, 0xffffff);
    const movement = movementFor(phys);
    actor.state = 'air';
    actor.wallrunLanded = true;
    body.velocity.z = -8;
    const cmd = emptyCommand();
    cmd.moveZ = 1;

    movement.update(actor, cmd, 1 / 60);

    expect(actor.state).toBe('wallrun');
    expect(actor.wallrunLanded).toBe(false);
    expect(actor.wallrunChains).toBe(1);
    body.dispose();
    phys.dispose();
  });

  it('clears jump and wall-chain state when a wall run lands directly', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 20, 0.25, 20, 0, 'stone');
    phys.addStaticBox(0, 3, 0, 0.25, 3, 20, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 995, -0.72, CAPSULE_CENTER_OFFSET + 1.2, 6);
    const actor = new Actor('Wall landing regression', body, 0xffffff);
    const movement = movementFor(phys);
    actor.state = 'wallrun';
    actor.wallSide = 1;
    actor.wallNormalX = -1;
    actor.jumpsUsed = 1;
    actor.wallrunLanded = false;
    actor.wallrunChains = 1;
    body.velocity.z = -8;
    body.velocity.y = -4;

    for (let frame = 0; frame < 60 && !body.grounded; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }

    expect(actor.state).toBe('ground');
    expect(body.grounded).toBe(true);
    expect(body.velocity.y).toBe(0);
    expect(actor.jumpsUsed).toBe(0);
    expect(actor.wallrunLanded).toBe(true);
    expect(actor.wallrunChains).toBe(0);
    body.dispose();
    phys.dispose();
  });

  it('mantles with capsule sweeps and never teleports through the ledge', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -1, 4, 0.25, 4, 0, 'stone');
    phys.addStaticBox(0, 0.9, -1, 2, 0.9, 0.45, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 90, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('MANTLE TEST', body, 0x5fd0ff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }

    const command = emptyCommand();
    command.moveZ = 1;
    command.yaw = 0;
    command.jumpPressed = true;
    movement.update(actor, command, 1 / 60);
    phys.fixedStep(1 / 60);
    expect(actor.state).toBe('mantle');
    command.jumpPressed = false;

    for (let frame = 0; frame < 32; frame++) {
      movement.update(actor, command, 1 / 60);
      phys.fixedStep(1 / 60);
      expect(phys.characterPenetrationsAt(
        body.position.x,
        body.position.y,
        body.position.z,
        body.body,
      )).toEqual([]);
    }
    expect(feetYFromBodyCenter(body.position.y)).toBeCloseTo(1.8, 1);
    expect(body.position.z).toBeLessThan(-0.8);
    body.dispose();
    phys.dispose();
  });

  it('keeps a grounded actor grounded while outward input presses against map bounds', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -1, 0, 10, 1, 10, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 992, 0.9, CAPSULE_CENTER_OFFSET + 0.05, 0);
    body.move(0, -0.1, 0);
    phys.fixedStep(1 / 60);
    expect(body.grounded).toBe(true);

    const actor = new Actor('Ground boundary', body, 0xffffff);
    actor.state = 'ground';
    const movement = movementFor(phys);
    movement.bounds = { half: 1 };
    const cmd = emptyCommand();
    cmd.moveZ = 1;
    cmd.yaw = -Math.PI / 2; // forward = +X

    for (let frame = 0; frame < 120; frame++) {
      movement.update(actor, cmd, 1 / 60);
      phys.fixedStep(1 / 60);
      expect(body.position.x, `frame ${frame}`).toBeLessThanOrEqual(1);
      expect(body.body.translation().x, `frame ${frame}`).toBeCloseTo(body.position.x, 6);
      expect(body.grounded, `frame ${frame}`).toBe(true);
      expect(actor.state, `frame ${frame}`).toBe('ground');
      expect(phys.characterPenetrationsAt(
        body.position.x,
        body.position.y,
        body.position.z,
        body.body,
      ), `frame ${frame}`).toEqual([]);
    }

    body.dispose();
    phys.dispose();
  });

  it('refuses a mantle target that only a centre ray considers clear', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -1, 4, 0.25, 4, 0, 'stone');
    phys.addStaticBox(0, 0.9, -1, 2, 0.9, 0.45, 0, 'stone');
    // The old centre headroom ray misses this side jamb, but the full capsule
    // radius at the target would overlap it materially.
    phys.addStaticBox(0.55, 2.9, -1, 0.2, 1.1, 0.5, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 91, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('BLOCKED MANTLE TEST', body, 0x5fd0ff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }

    const command = emptyCommand();
    command.moveZ = 1;
    command.yaw = 0;
    command.jumpPressed = true;
    movement.update(actor, command, 1 / 60);
    phys.fixedStep(1 / 60);
    expect(actor.state).not.toBe('mantle');
    expect(phys.characterPenetrationsAt(body.position.x, body.position.y, body.position.z, body.body)).toEqual([]);
    body.dispose();
    phys.dispose();
  });

  it('aborts a mantle without a launch or jump reset when geometry blocks after preflight', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, -1, 4, 0.25, 4, 0, 'stone');
    phys.addStaticBox(0, 0.9, -1, 2, 0.9, 0.45, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 92, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('DYNAMIC MANTLE TEST', body, 0x5fd0ff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    // Seed the value after the initial KCC landing, which now correctly owns
    // the ordinary jump/wall-run reset.
    actor.jumpsUsed = 1;
    const command = emptyCommand();
    command.moveZ = 1;
    command.jumpPressed = true;
    movement.update(actor, command, 1 / 60);
    phys.fixedStep(1 / 60);
    expect(actor.state).toBe('mantle');

    phys.addStaticBox(0, 2.4, 0, 1, 0.1, 1, 0, 'stone');
    phys.flush();
    for (let frame = 0; frame < 32 && actor.state === 'mantle'; frame++) {
      movement.update(actor, command, 1 / 60);
      phys.fixedStep(1 / 60);
      expect(phys.characterPenetrationsAt(body.position.x, body.position.y, body.position.z, body.body)).toEqual([]);
    }
    expect(actor.state).not.toBe('mantle');
    expect(body.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(actor.jumpsUsed).toBe(1);
    body.dispose();
    phys.dispose();
  });

  it('exits water without false ground state or stale vertical velocity', () => {
    for (const initialVy of [5, -3]) {
      const phys = new PhysicsWorld();
      phys.addStaticBox(0, -0.25, 0, 4, 0.25, 4, 0, 'stone');
      phys.flush();
      const body = new CharBody(phys, 93, 0, CAPSULE_CENTER_OFFSET + 0.05, -0.45);
      const actor = new Actor('SWIM EXIT TEST', body, 0x5fd0ff);
      const movement = movementFor(phys);
      for (let frame = 0; frame < 12; frame++) {
        movement.update(actor, emptyCommand(), 1 / 60);
        phys.fixedStep(1 / 60);
      }
      expect(body.grounded).toBe(true);
      actor.state = 'swim';
      actor.inWater = true;
      actor.waterSurfaceY = 2;
      body.velocity.y = initialVy;
      movement.waterAt = (_x, y, z) => z < 0 && y <= 2.2
        ? { minX: -4, maxX: 4, minZ: -4, maxZ: 0, surfaceY: 2, depth: 3 }
        : null;

      const command = emptyCommand();
      command.moveZ = 1;
      command.yaw = Math.PI;
      for (let frame = 0; frame < 90 && actor.state === 'swim'; frame++) {
        movement.update(actor, command, 1 / 60);
        phys.fixedStep(1 / 60);
        expect(phys.characterPenetrationsAt(
          body.position.x,
          body.position.y,
          body.position.z,
          body.body,
        )).toEqual([]);
        const observedState: string = actor.state;
        if (observedState === 'ground') {
          expect(body.grounded).toBe(true);
          expect(body.velocity.y).toBe(0);
          expect(feetYFromBodyCenter(body.position.y)).toBeCloseTo(0, 2);
        }
      }
      if (initialVy > 0) {
        expect(actor.state).toBe('air');
        expect(body.grounded).toBe(false);
        expect(body.velocity.y).toBeGreaterThan(0);
      } else {
        expect(actor.state).toBe('ground');
        expect(body.grounded).toBe(true);
        expect(body.velocity.y).toBe(0);
        expect(feetYFromBodyCenter(body.position.y)).toBeCloseTo(0, 2);
      }
      body.dispose();
      phys.dispose();
    }
  });

  it('publishes a finite water surface before emitting the entry splash', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 4, 0.25, 4, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 95, 0, CAPSULE_CENTER_OFFSET + 0.05, 0);
    const actor = new Actor('SPLASH SURFACE TEST', body, 0x5fd0ff);
    let emittedSurface = -Infinity;
    const movement = movementFor(phys, (entering) => { emittedSurface = entering.waterSurfaceY; });
    movement.waterAt = () => ({ minX: -4, maxX: 4, minZ: -4, maxZ: 4, surfaceY: 2, depth: 3 });
    movement.update(actor, emptyCommand(), 1 / 60);
    expect(Number.isFinite(emittedSurface)).toBe(true);
    expect(emittedSurface).toBe(2);
    body.dispose();
    phys.dispose();
  });

  it('clears swim velocity when a supported actor starts the tick outside water', () => {
    const phys = new PhysicsWorld();
    phys.addStaticBox(0, -0.25, 0, 4, 0.25, 4, 0, 'stone');
    phys.flush();
    const body = new CharBody(phys, 94, 0, CAPSULE_CENTER_OFFSET + 0.05, 0.5);
    const actor = new Actor('PRE-TICK SWIM EXIT TEST', body, 0x5fd0ff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    actor.state = 'swim';
    actor.inWater = true;
    body.velocity.y = 5;
    movement.waterAt = (_x, y, z) => z < 0 && y <= 2.2
      ? { minX: -4, maxX: 4, minZ: -4, maxZ: 0, surfaceY: 2, depth: 3 }
      : null;
    movement.update(actor, emptyCommand(), 1 / 60);
    phys.fixedStep(1 / 60);
    expect(actor.state).toBe('ground');
    expect(body.grounded).toBe(true);
    expect(body.velocity.y).toBe(0);
    expect(phys.characterPenetrationsAt(body.position.x, body.position.y, body.position.z, body.body)).toEqual([]);
    body.dispose();
    phys.dispose();
  });

  it('lets the real character controller follow a normalized stair run without floating or embedding', () => {
    const builder = new WorldBuilder('stairs', 'Stairs', 'Traversal fixture', 100);
    builder.slab(0, 0, -3, 5, 6, 0.5, 'concreteDark');
    const stair = builder.stairs(0, 0, 0, 0, 10, 0.6, 0.6, 1.6, 'concreteDark');
    builder.slab(0, stair.totalRise, stair.run + 3, 5, 6, 0.5, 'concreteDark');
    const phys = new PhysicsWorld();
    buildColliders(builder.def, phys);
    phys.flush();
    const body = new CharBody(phys, 1, 0, CAPSULE_CENTER_OFFSET + 0.05, -2);
    const actor = new Actor('STAIR TEST', body, 0x5fd0ff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    expect(body.grounded).toBe(true);
    expect(feetYFromBodyCenter(body.position.y)).toBeCloseTo(0, 3);

    let reachedTop = false;
    for (let frame = 0; frame < 360; frame++) {
      const command = emptyCommand();
      command.moveZ = 1;
      command.yaw = Math.PI;
      movement.update(actor, command, 1 / 60);
      phys.fixedStep(1 / 60);
      const feetY = body.position.y - CAPSULE_CENTER_OFFSET;
      expect(feetY).toBeGreaterThan(-0.08);
      expect(feetY).toBeLessThan(stair.totalRise + 0.18);
      if (body.position.z > stair.run + 1) {
        reachedTop = true;
        expect(feetY).toBeCloseTo(stair.totalRise, 1);
        break;
      }
    }
    expect(reachedTop, JSON.stringify(body.position)).toBe(true);
  });

  it('lets the real character controller descend a normalized stair run without gaps or embedding', () => {
    const builder = new WorldBuilder('stairs-down', 'Stairs down', 'Traversal fixture', 100);
    const planned = builder.stairs(0, 6, 0, 0, 10, -0.6, 0.6, 1.6, 'concreteDark');
    builder.slab(0, 6, -3, 5, 6, 0.5, 'concreteDark');
    builder.slab(0, 0, planned.run + 3, 5, 6, 0.5, 'concreteDark');
    const phys = new PhysicsWorld();
    buildColliders(builder.def, phys);
    phys.flush();
    const body = new CharBody(phys, 2, 0, 6 + CAPSULE_CENTER_OFFSET + 0.05, -2);
    const actor = new Actor('STAIR DOWN TEST', body, 0x5fd0ff);
    const movement = movementFor(phys);
    for (let frame = 0; frame < 12; frame++) {
      movement.update(actor, emptyCommand(), 1 / 60);
      phys.fixedStep(1 / 60);
    }
    expect(body.grounded).toBe(true);
    expect(feetYFromBodyCenter(body.position.y)).toBeCloseTo(6, 3);

    let reachedBottom = false;
    for (let frame = 0; frame < 360; frame++) {
      const command = emptyCommand();
      command.moveZ = 1;
      command.yaw = Math.PI;
      movement.update(actor, command, 1 / 60);
      phys.fixedStep(1 / 60);
      const feetY = feetYFromBodyCenter(body.position.y);
      expect(feetY).toBeGreaterThan(-0.08);
      expect(feetY).toBeLessThan(6.08);
      if (body.position.z > planned.run + 1) {
        reachedBottom = true;
        expect(body.grounded).toBe(true);
        expect(feetY).toBeCloseTo(0, 1);
        break;
      }
    }
    expect(reachedBottom, JSON.stringify(body.position)).toBe(true);
  });

  for (const id of ['oldfront', 'eden', 'ashara'] satisfies MapId[]) {
    it(`${id} keeps the heightfield sampler aligned with physical contact`, () => {
      const loaded = loadMap(id);
      const phys = new PhysicsWorld();
      buildColliders(loaded.def, phys);
      phys.flush();

      let samples = 0;
      let worstError = 0;
      for (let z = -220; z <= 220; z += 31) {
        for (let x = -220; x <= 220; x += 29) {
          if (occupiedAt(loaded.def, x, z)) continue;
          const visualY = loaded.terrainHeight(x, z);
          const physicalY = phys.terrainSurfaceAt(x, z, 20, 50);
          if (physicalY === null) continue;
          worstError = Math.max(worstError, Math.abs(visualY - physicalY!));
          samples++;
        }
      }

      expect(samples).toBeGreaterThan(70);
      expect(worstError).toBeLessThan(0.002);
    }, 30_000);

    it(`${id} seats every building foundation through the slope without terrain piercing the floor`, () => {
      const loaded = loadMap(id);
      const foundations = loaded.def.geo.filter((geo) => (
        geo.kind === 'box'
        && Math.abs(geo.sy - 2.2) < 1e-6
        && geo.sx > 5
        && geo.sz > 5
      ));
      expect(foundations.length).toBeGreaterThan(0);
      for (const foundation of foundations) {
        if (foundation.kind !== 'box') continue;
        let lowTerrain = Infinity;
        let highTerrain = -Infinity;
        for (let iz = 0; iz <= 8; iz++) {
          for (let ix = 0; ix <= 8; ix++) {
            const x = foundation.x - foundation.sx / 2 + foundation.sx * ix / 8;
            const z = foundation.z - foundation.sz / 2 + foundation.sz * iz / 8;
            const y = loaded.terrainHeight(x, z);
            lowTerrain = Math.min(lowTerrain, y);
            highTerrain = Math.max(highTerrain, y);
          }
        }
        const bottom = foundation.y - foundation.sy / 2;
        const top = foundation.y + foundation.sy / 2;
        expect(bottom, JSON.stringify(foundation)).toBeLessThan(lowTerrain);
        expect(top, JSON.stringify(foundation)).toBeGreaterThan(highTerrain);
      }
    });
  }

  for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
    it(`${id} emits only finite, non-degenerate world records`, () => {
      const { def } = loadMap(id);
      const allGeometry = [...def.geo, ...def.destructibles.map((item) => item.geo)];
      for (const geo of allGeometry) {
        expect(Object.values(geo).filter((value) => typeof value === 'number')
          .every(Number.isFinite), JSON.stringify(geo)).toBe(true);
        if (geo.kind === 'box') {
          expect(geo.sx, JSON.stringify(geo)).toBeGreaterThan(0);
          expect(geo.sy, JSON.stringify(geo)).toBeGreaterThan(0);
          expect(geo.sz, JSON.stringify(geo)).toBeGreaterThan(0);
        } else if (geo.kind === 'cyl') {
          expect(geo.r, JSON.stringify(geo)).toBeGreaterThan(0);
          expect(geo.h, JSON.stringify(geo)).toBeGreaterThan(0);
        } else {
          expect(geo.r, JSON.stringify(geo)).toBeGreaterThan(0);
        }
      }
      for (const record of [
        ...def.trees, ...def.rocks, ...def.vehicles, ...def.lamps,
        ...def.chests, ...def.loot, ...def.lights, ...def.pois,
      ]) {
        expect(Object.values(record).filter((value) => typeof value === 'number')
          .every(Number.isFinite), JSON.stringify(record)).toBe(true);
      }
      for (const tree of def.trees) expect(tree.scale).toBeGreaterThan(0);
      for (const rock of def.rocks) expect(rock.scale).toBeGreaterThan(0);
      for (const lamp of def.lamps) {
        expect(lamp.h).toBeGreaterThan(0);
        expect(lamp.range).toBeGreaterThan(0);
      }
      for (const light of def.lights) expect(light.range).toBeGreaterThan(0);
      for (const poi of def.pois) expect(poi.radius).toBeGreaterThan(0);
      for (const platform of def.platforms) {
        expect(platform.minX).toBeLessThanOrEqual(platform.maxX);
        expect(platform.minZ).toBeLessThanOrEqual(platform.maxZ);
        expect([platform.minX, platform.maxX, platform.minZ, platform.maxZ, platform.y]
          .every(Number.isFinite), JSON.stringify(platform)).toBe(true);
      }
      for (const path of def.surfacePaths) {
        expect(path.points.length, JSON.stringify(path)).toBeGreaterThan(1);
        expect(Number.isFinite(path.yOffset), JSON.stringify(path)).toBe(true);
        for (const point of path.points) {
          expect([point.x, point.z, point.width].every(Number.isFinite), JSON.stringify(point)).toBe(true);
          expect(point.width, JSON.stringify(point)).toBeGreaterThan(0);
        }
      }
      for (const water of def.water) {
        const half = def.size / 2;
        expect(water.minX).toBeGreaterThanOrEqual(-half);
        expect(water.maxX).toBeLessThanOrEqual(half);
        expect(water.minZ).toBeGreaterThanOrEqual(-half);
        expect(water.maxZ).toBeLessThanOrEqual(half);
        expect(water.depth).toBeGreaterThan(0);
      }
    });

    it(`${id} snaps every chest base to a real nearby support surface`, () => {
      const loaded = loadMap(id);
      const phys = new PhysicsWorld();
      buildColliders(loaded.def, phys);
      phys.flush();
      const resolved = resolveSupportedChests(loaded.def, phys);

      expect(resolved).toHaveLength(loaded.def.chests.length);
      for (const chest of resolved) {
        expect(isChestPlacementClear(loaded.def, chest)).toBe(true);
        const hit = phys.raycast(chest.x, chest.y + 0.7, chest.z, 0, -1, 0, 1.45);
        expect(hit, `${id} chest at ${chest.x},${chest.z} has no support`).not.toBeNull();
        expect(hit?.dist).toBeGreaterThan(0.05);
        expect(hit?.normal.y).toBeGreaterThan(0.65);
        expect(hit?.point.y).toBeCloseTo(chest.y, 4);
      }
    });

    it(`${id} keeps vegetation separated from structures, water and other trunks`, () => {
      const loaded = loadMap(id);
      loaded.def.trees.forEach((tree, index) => {
        const otherTrees = loaded.def.trees.filter((_, otherIndex) => otherIndex !== index);
        expect(isTreePlacementClear({ ...loaded.def, trees: otherTrees }, tree),
          `${id} tree at ${tree.x},${tree.z} overlaps the world`).toBe(true);
      });
    });

    it(`${id} supports trees, loose props, vehicles and lamps on the finished world`, () => {
      const loaded = loadMap(id);
      const phys = new PhysicsWorld();
      buildColliders({
        ...loaded.def,
        geo: loaded.def.geo.filter((g) => !g.noRender),
        trees: [],
        rocks: [],
        vehicles: [],
        chests: [],
      }, phys);
      phys.flush();

      for (const tree of loaded.def.trees) {
        const hit = phys.raycast(tree.x, tree.y + 0.7, tree.z, 0, -1, 0, 1.4);
        expect(hit, `${id} tree at ${tree.x},${tree.z} has no support`).not.toBeNull();
        expect(Math.abs((hit?.point.y ?? Infinity) - tree.y)).toBeLessThan(0.16);
      }
      for (const vehicle of loaded.def.vehicles) {
        const hit = phys.raycast(vehicle.x, vehicle.y + 0.8, vehicle.z, 0, -1, 0, 1.6);
        expect(hit, `${id} vehicle at ${vehicle.x},${vehicle.z} has no support`).not.toBeNull();
        expect(Math.abs((hit?.point.y ?? Infinity) - vehicle.y)).toBeLessThanOrEqual(0.25);
      }
      for (const lamp of loaded.def.lamps) {
        const hit = phys.raycast(lamp.x, lamp.y + 0.5, lamp.z, 0, -1, 0, 1);
        expect(hit, `${id} lamp at ${lamp.x},${lamp.z} has no support`).not.toBeNull();
        expect(hit?.point.y).toBeCloseTo(lamp.y, 3);
      }

      groundCrates(loaded.def, phys);
      filterInvalidCrates(loaded.def);
      for (const prop of loaded.def.destructibles) {
        if (prop.type !== 'crate' || prop.geo.kind !== 'box') continue;
        const baseY = prop.geo.y - prop.geo.sy / 2;
        const hit = phys.raycast(prop.geo.x, baseY + 0.5, prop.geo.z, 0, -1, 0, 0.9);
        expect(hit, `${id} crate at ${prop.geo.x},${prop.geo.z} has no support`).not.toBeNull();
        expect(hit?.point.y).toBeCloseTo(baseY, 3);
      }
    });
  }

  it('keeps every Eden water volume connected to a real terrain basin', () => {
    const loaded = loadMap('eden');
    for (const water of loaded.def.water) {
      let submerged = 0;
      let total = 0;
      for (let iz = 0; iz <= 12; iz++) {
        for (let ix = 0; ix <= 12; ix++) {
          const x = water.minX + (water.maxX - water.minX) * ix / 12;
          const z = water.minZ + (water.maxZ - water.minZ) * iz / 12;
          if (loaded.terrainHeight(x, z) < water.surfaceY - 0.05) submerged++;
          total++;
        }
      }
      expect(submerged / total, JSON.stringify(water)).toBeGreaterThan(0.18);
    }
    // Regression for the old sign error: the pond basin belongs at +205 Z.
    expect(loaded.terrainHeight(-220, 205)).toBeLessThan(-3.8);
    expect(loaded.terrainHeight(-220, -205)).toBeGreaterThan(-2);
  });

  it('keeps both Water Treatment chest anchors on their authored floors', () => {
    const { def } = loadMap('eden');
    const treatmentChests = def.chests.filter((chest) =>
      Math.abs(chest.x + 165) < 0.01
      && (Math.abs(chest.z + 116) < 0.01 || Math.abs(chest.z + 124) < 0.01));

    expect(treatmentChests).toHaveLength(2);
    expect(treatmentChests.some((chest) => chest.y > -1)).toBe(true);
    expect(treatmentChests.some((chest) => chest.y < -4)).toBe(true);
  });

  it('gives the Eden Watch Rock a physical deck and a connected exterior stair', () => {
    const { def } = loadMap('eden');
    const rock = def.rocks.find((candidate) => (
      Math.abs(candidate.x - 60) < 0.01 && Math.abs(candidate.z + 60) < 0.01
    ));
    expect(rock).toEqual(expect.objectContaining({ scale: 1 }));
    if (!rock) throw new Error('Eden Watch Rock missing');
    const deck = def.geo.find((g) => (
      g.kind === 'box'
      && g.mat === 'rock'
      && Math.abs(g.x - 60) < 0.01
      && Math.abs(g.z + 60) < 0.01
      && Math.abs(g.sx - 5) < 0.01
      && Math.abs(g.sz - 5) < 0.01
    ));
    expect(deck?.kind).toBe('box');
    if (!deck || deck.kind !== 'box') throw new Error('Eden Watch Rock deck missing');
    const deckTop = deck.y + deck.sy / 2;
    const rockProfile = rockColliderProfile(rock.variant);
    const rockTop = rock.y + (rockProfile.height - 0.22) * rock.scale;
    // The measured crown may sit up to ~12 cm shy of the former coarse
    // envelope; the deck itself stays solid so no capsule-sized gap remains.
    expect(rockTop).toBeGreaterThanOrEqual(deck.y - deck.sy / 2 - 0.12);
    expect(rockTop).toBeLessThan(deckTop);

    const treads = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'rock'
      && Math.abs(g.z + 60) < 0.01
      && Math.abs(g.sz - 2.2) < 0.01
      && g.sx < 1
    ));
    expect(treads.length).toBeGreaterThan(5);
    const topTread = [...treads].sort((a, b) => b.y - a.y)[0];
    expect(topTread?.kind).toBe('box');
    if (!topTread || topTread.kind !== 'box') throw new Error('Eden Watch Rock stair missing');
    expect(topTread.y + topTread.sy / 2).toBeCloseTo(deckTop, 6);
    expect(topTread.x - topTread.sx / 2).toBeCloseTo(deck.x + deck.sx / 2, 6);
  });

  it('clamps terrain sampling at map bounds instead of extrapolating edge cells', () => {
    const loaded = loadMap('eden');
    expect(loaded.terrainHeight(-500, 40)).toBeCloseTo(loaded.terrainHeight(-250, 40), 8);
    expect(loaded.terrainHeight(500, -30)).toBeCloseTo(loaded.terrainHeight(250, -30), 8);
  });

  it('keeps Neo City parking and overpass walls on their authored elevated decks', () => {
    const { def } = loadMap('neocity');
    const elevatedWalls = def.geo.filter((g) => g.kind === 'box' && g.mat === 'concrete' && g.sy > 1);
    expect(elevatedWalls.some((g) => g.kind === 'box' && Math.abs(g.y - 5.4) < 0.01)).toBe(true);
    expect(elevatedWalls.filter((g) => g.kind === 'box' && Math.abs(g.y - 6.95) < 0.01)).toHaveLength(2);
  });

  it('opens the Neo City parking deck around its ramp and joins both elevations', () => {
    const { def } = loadMap('neocity');
    const treads = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'concreteDark'
      && Math.abs(g.x - 40) < 0.01
      && g.z > 156 && g.z < 167
      && Math.abs(g.sx - 3) < 0.01
      && g.sz < 1
    )).sort((a, b) => a.z - b.z);
    expect(treads).toHaveLength(11);
    const first = treads[0];
    const last = treads.at(-1);
    expect(first?.kind).toBe('box');
    expect(last?.kind).toBe('box');
    if (!first || first.kind !== 'box' || !last || last.kind !== 'box') {
      throw new Error('Neo City parking ramp missing');
    }
    expect(first.z - first.sz / 2).toBeCloseTo(157, 6);
    expect(last.z + last.sz / 2).toBeCloseTo(165.58, 6);
    expect(last.y + last.sy / 2).toBeCloseTo(4, 6);

    const upperDeck = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'concreteDark'
      && Math.abs(g.y + g.sy / 2 - 4) < 0.01
      && Math.abs(g.sy - 0.4) < 0.01
      && g.x > 14 && g.x < 46
      && g.z > 154 && g.z < 176
    ));
    expect(upperDeck.length).toBeGreaterThan(2);
    for (const slab of upperDeck) {
      if (slab.kind !== 'box') continue;
      // Ignore exact shared edges; only positive-area intrusion closes the hole.
      const overlapsRampX = slab.x + slab.sx / 2 > 38.04 && slab.x - slab.sx / 2 < 41.96;
      const overlapsRampZ = slab.z + slab.sz / 2 > 156.54 && slab.z - slab.sz / 2 < 165.56;
      expect(overlapsRampX && overlapsRampZ, JSON.stringify(slab)).toBe(false);
    }
  });

  it('runs both Neo City overpass stairs along the bridge axis into its end faces', () => {
    const { def } = loadMap('neocity');
    const flights = [
      def.geo.filter((g) => g.kind === 'box' && g.mat === 'concreteDark'
        && Math.abs(g.z - 233.2) < 0.01 && g.x < -60 && Math.abs(g.sz - 2.6) < 0.01),
      def.geo.filter((g) => g.kind === 'box' && g.mat === 'concreteDark'
        && Math.abs(g.z - 233.2) < 0.01 && g.x > 0 && Math.abs(g.sz - 2.6) < 0.01),
    ];
    for (const [index, flight] of flights.entries()) {
      expect(flight).toHaveLength(20);
      const top = [...flight].sort((a, b) => b.y - a.y)[0];
      expect(top?.kind).toBe('box');
      if (!top || top.kind !== 'box') throw new Error('Neo City overpass stair missing');
      expect(top.y + top.sy / 2).toBeCloseTo(6.8, 6);
      const bridgeFacingEdge = index === 0 ? top.x + top.sx / 2 : top.x - top.sx / 2;
      expect(bridgeFacingEdge).toBeCloseTo(index === 0 ? -60 : 0, 6);
    }
  });

  it('seats every Old Front cathedral buttress into its local slope', () => {
    const loaded = loadMap('oldfront');
    const buttresses = loaded.def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'stoneBrick'
      && Math.abs(Math.abs(g.x - 20) - 11.4) < 0.01
      && [-67, -55, -43].some((z) => Math.abs(g.z - z) < 0.01)
      && Math.abs(g.sx - 1.6) < 0.01
      && Math.abs(g.sz - 1.6) < 0.01
    ));
    expect(buttresses).toHaveLength(6);
    for (const buttress of buttresses) {
      if (buttress.kind !== 'box') continue;
      let lowestTerrain = Infinity;
      for (const dx of [-0.8, 0, 0.8]) {
        for (const dz of [-0.8, 0, 0.8]) {
          lowestTerrain = Math.min(
            lowestTerrain,
            loaded.terrainHeight(buttress.x + dx, buttress.z + dz),
          );
        }
      }
      expect(buttress.y - buttress.sy / 2, JSON.stringify(buttress))
        .toBeLessThanOrEqual(lowestTerrain - 0.1);
    }
  });

  it('connects the Neo City Cyberdome ramp to the ring with supported treads', () => {
    const { def } = loadMap('neocity');
    const treads = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'metalDark'
      && Math.abs(g.z - 110) < 0.01
      && g.x > -95 && g.x < -80
      && Math.abs(g.sz - 3.2) < 0.01
      && g.sx < 1
    )).sort((a, b) => b.x - a.x);
    expect(treads).toHaveLength(14);
    for (let i = 0; i < treads.length; i++) {
      const tread = treads[i]!;
      if (tread.kind !== 'box') continue;
      expect(tread.y - tread.sy / 2).toBeCloseTo(0, 6);
      expect(tread.y + tread.sy / 2).toBeCloseTo(8.8 * (i + 1) / 14, 6);
      if (i > 0) {
        const prior = treads[i - 1]!;
        if (prior.kind !== 'box') throw new Error('Cyberdome ramp tread is not a box');
        expect(Math.abs(prior.x - tread.x)).toBeLessThanOrEqual((prior.sx + tread.sx) / 2 + 0.01);
      }
    }
    const highest = treads.at(-1)!;
    if (highest.kind !== 'box') throw new Error('Cyberdome ramp tread is not a box');
    expect(Math.abs(highest.x + 130) - highest.sx / 2).toBeLessThanOrEqual(36.5 + 0.01);
    expect(highest.y + highest.sy / 2).toBeCloseTo(8.8, 6);
  });

  it('embeds every Old Front keep curtain-wall segment into the hill', () => {
    const loaded = loadMap('oldfront');
    const walls = loaded.def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'stoneBrick'
      && g.x >= -176.1 && g.x <= -123.9
      && g.z >= -176.1 && g.z <= -123.9
      && Math.abs(Math.min(g.sx, g.sz) - 1.6) < 0.01
      && (Math.abs(g.x + 176) < 0.01 || Math.abs(g.x + 124) < 0.01
        || Math.abs(g.z + 176) < 0.01 || Math.abs(g.z + 124) < 0.01)
    ));
    expect(walls.length).toBeGreaterThan(5);
    for (const wall of walls) {
      if (wall.kind !== 'box') continue;
      const bottom = wall.y - wall.sy / 2;
      for (let i = 0; i <= 8; i++) {
        const x = wall.x - wall.sx / 2 + wall.sx * i / 8;
        const z = wall.z - wall.sz / 2 + wall.sz * i / 8;
        expect(bottom, JSON.stringify(wall)).toBeLessThanOrEqual(loaded.terrainHeight(x, wall.z) + 0.01);
        expect(bottom, JSON.stringify(wall)).toBeLessThanOrEqual(loaded.terrainHeight(wall.x, z) + 0.01);
      }
    }
  });

  it('keeps Old Front quarry boulders supported outside its terrain cutouts', () => {
    const loaded = loadMap('oldfront');
    const quarryCutouts = (loaded.def.terrainCutouts ?? []).filter((cutout) => (
      cutout.minX >= -102 && cutout.maxX <= -67
      && cutout.minZ >= -49 && cutout.maxZ <= -31
    ));
    expect(quarryCutouts).toHaveLength(2);
    const quarryRocks = loaded.def.rocks.filter((rock) => Math.hypot(rock.x + 90, rock.z + 40) < 34);
    expect(quarryRocks.length).toBeGreaterThanOrEqual(8);
    for (const rock of quarryRocks) {
      const radius = ROCK_CLEARANCE_RADIUS * rock.scale;
      for (const cutout of quarryCutouts) {
        const dx = Math.max(cutout.minX - rock.x, 0, rock.x - cutout.maxX);
        const dz = Math.max(cutout.minZ - rock.z, 0, rock.z - cutout.maxZ);
        expect(dx * dx + dz * dz, JSON.stringify({ rock, cutout })).toBeGreaterThanOrEqual(radius * radius);
      }
      expect(rock.y).toBeCloseTo(loaded.terrainHeight(rock.x, rock.z), 6);
    }
  });

  it('seats both Old Front bridge parapets directly on the deck', () => {
    const { def } = loadMap('oldfront');
    const deck = def.geo.find((g) => (
      g.kind === 'box'
      && g.mat === 'stoneBrick'
      && Math.abs(g.x) < 0.01
      && Math.abs(g.z - 120) < 0.01
      && Math.abs(g.sx - 8) < 0.01
      && Math.abs(g.sz - 26) < 0.01
    ));
    expect(deck?.kind).toBe('box');
    if (!deck || deck.kind !== 'box') throw new Error('Old Front bridge deck missing');
    const deckTop = deck.y + deck.sy / 2;
    const parapets = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'stoneBrick'
      && Math.abs(Math.abs(g.x) - 4) < 0.01
      && Math.abs(g.z - 120) < 0.01
      && Math.abs(g.sz - 26) < 0.01
    ));
    expect(parapets).toHaveLength(2);
    for (const parapet of parapets) {
      if (parapet.kind !== 'box') continue;
      expect(parapet.y - parapet.sy / 2).toBeCloseTo(deckTop, 6);
    }
  });

  it('anchors both Old Front stone-bridge approaches to the deck', () => {
    const loaded = loadMap('oldfront');
    const deck = loaded.def.geo.find((g) => g.kind === 'box' && g.mat === 'stoneBrick'
      && Math.abs(g.x) < 0.01 && Math.abs(g.z - 120) < 0.01
      && Math.abs(g.sx - 8) < 0.01 && Math.abs(g.sz - 26) < 0.01);
    expect(deck?.kind).toBe('box');
    if (!deck || deck.kind !== 'box') throw new Error('Old Front stone bridge missing');
    const deckTop = deck.y + deck.sy / 2;
    const flights = [
      loaded.def.geo.filter((g) => g.kind === 'box' && g.mat === 'stoneBrick'
        && Math.abs(g.x) < 0.01 && Math.abs(g.sx - 8) < 0.01 && g.z < 107),
      loaded.def.geo.filter((g) => g.kind === 'box' && g.mat === 'stoneBrick'
        && Math.abs(g.x) < 0.01 && Math.abs(g.sx - 8) < 0.01 && g.z > 133),
    ];
    for (const [index, flight] of flights.entries()) {
      expect(flight.length).toBeGreaterThan(8);
      const top = [...flight].sort((a, b) => b.y - a.y)[0];
      expect(top?.kind).toBe('box');
      if (!top || top.kind !== 'box') throw new Error('Old Front bridge stair missing');
      expect(top.y + top.sy / 2).toBeCloseTo(deckTop, 6);
      const bridgeFacingEdge = index === 0 ? top.z + top.sz / 2 : top.z - top.sz / 2;
      expect(bridgeFacingEdge).toBeCloseTo(index === 0 ? 107 : 133, 6);
    }
  });

  it('joins the Old Front watchtower stairs, deck and guards without vertical gaps', () => {
    const { def } = loadMap('oldfront');
    const deck = def.geo.find((g) => (
      g.kind === 'box'
      && g.mat === 'woodDark'
      && Math.abs(g.x + 184) < 0.01
      && Math.abs(g.z - 80) < 0.01
      && Math.abs(g.sx - 6) < 0.01
      && Math.abs(g.sz - 6) < 0.01
    ));
    expect(deck?.kind).toBe('box');
    if (!deck || deck.kind !== 'box') throw new Error('Old Front watchtower deck missing');
    const deckTop = deck.y + deck.sy / 2;
    const guards = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'woodDark'
      && Math.abs(g.sy - 1.1) < 0.01
      && Math.hypot(g.x + 184, g.z - 80) < 5
    ));
    expect(guards.length).toBeGreaterThanOrEqual(4);
    expect(guards.every((guard) => guard.kind === 'box'
      && Math.abs(guard.y - guard.sy / 2 - deckTop) < 1e-6)).toBe(true);
    const topTread = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'woodDark'
      && Math.abs(g.x + 184) < 0.01
      && Math.abs(g.sx - 2.2) < 0.01
      && Math.abs(g.sz - 0.78) < 0.01
    )).sort((a, b) => b.y - a.y)[0];
    expect(topTread?.kind).toBe('box');
    if (!topTread || topTread.kind !== 'box') throw new Error('Old Front watchtower stair missing');
    expect(topTread.y + topTread.sy / 2).toBeCloseTo(deckTop, 6);
    expect(topTread.z + topTread.sz / 2).toBeCloseTo(deck.z - deck.sz / 2, 6);
    const southGuardBlocksOpening = guards.some((guard) => guard.kind === 'box'
      && Math.abs(guard.z - (deck.z - deck.sz / 2)) < 0.01
      && Math.abs(guard.x - topTread.x) < guard.sx / 2 + topTread.sx / 2);
    expect(southGuardBlocksOpening).toBe(false);
  });

  it('embeds every Ashara compound-wall segment into its rolling perimeter', () => {
    const loaded = loadMap('ashara');
    const compounds = [
      { x: -158, z: 86, w: 52, d: 42 },
      { x: 184, z: 150, w: 44, d: 36 },
    ];
    for (const compound of compounds) {
      const walls = loaded.def.geo.filter((g) => (
        g.kind === 'box'
        && g.mat === 'concrete'
        && Math.abs(Math.min(g.sx, g.sz) - 0.55) < 0.001
        && g.sy > 3.2
        && g.x >= compound.x - compound.w / 2 - 0.01
        && g.x <= compound.x + compound.w / 2 + 0.01
        && g.z >= compound.z - compound.d / 2 - 0.01
        && g.z <= compound.z + compound.d / 2 + 0.01
      ));
      expect(walls.length).toBeGreaterThanOrEqual(4);
      for (const wall of walls) {
        if (wall.kind !== 'box') continue;
        const bottom = wall.y - wall.sy / 2;
        for (let i = 0; i <= 12; i++) {
          const x = wall.x - wall.sx / 2 + wall.sx * i / 12;
          const z = wall.z - wall.sz / 2 + wall.sz * i / 12;
          expect(bottom, JSON.stringify(wall)).toBeLessThanOrEqual(loaded.terrainHeight(x, wall.z) + 0.01);
          expect(bottom, JSON.stringify(wall)).toBeLessThanOrEqual(loaded.terrainHeight(wall.x, z) + 0.01);
        }
      }
    }
  });

  it('keeps Ashara road boxes for collision while reserving the welded surface for rendering', () => {
    const { def } = loadMap('ashara');
    const roadColliders = def.geo.filter((g) => g.kind === 'box' && g.mat === 'asphaltDesert');
    const segmentedShoulders = def.geo.filter((g) => (
      g.kind === 'box' && g.mat === 'dirt' && Math.abs(g.sy - 0.045) < 0.001
    ));
    expect(roadColliders.length).toBeGreaterThan(20);
    expect(roadColliders.every((road) => road.noRender === true)).toBe(true);
    expect(segmentedShoulders.length).toBe(roadColliders.length);
    expect(segmentedShoulders.every((shoulder) => shoulder.noRender === true)).toBe(true);
    for (const road of roadColliders) {
      if (road.kind !== 'box') continue;
      expect(def.platforms.some((platform) => (
        platform.minX <= road.x && platform.maxX >= road.x
        && platform.minZ <= road.z && platform.maxZ >= road.z
        && Math.abs(platform.y - (road.y + road.sy / 2)) < 0.001
      ))).toBe(true);
    }
  });

  it('keeps Ashara scatter rocks out of both authored road corridors', () => {
    const { def } = loadMap('ashara');
    for (const rock of def.rocks) {
      const radius = ROCK_CLEARANCE_RADIUS * rock.scale;
      const insideHighway = rock.x >= -250 && rock.x <= 250
        && Math.abs(rock.z + 5) < 4.5 + radius;
      const insideFeeder = rock.z >= 62 && rock.z <= 248
        && Math.abs(rock.x - 42) < 3.5 + radius;
      expect(insideHighway || insideFeeder, JSON.stringify(rock)).toBe(false);
    }
  });

  it('seats every Ashara Dry Canals bed on its local terrain sample', () => {
    const loaded = loadMap('ashara');
    const beds = loaded.def.geo.filter((g) => (
      g.kind === 'box' && g.mat === 'concreteDark'
      && Math.abs(g.sx - 4.7) < 0.01 && Math.abs(g.sz - 2) < 0.01
      && g.x > -220 && g.x < -150 && g.z > 145 && g.z < 215
    ));
    expect(beds).toHaveLength(91);
    for (const bed of beds) {
      if (bed.kind !== 'box') continue;
      expect(
        Math.abs((bed.y + bed.sy / 2) - loaded.terrainHeight(bed.x, bed.z)),
        JSON.stringify(bed),
      ).toBeLessThan(0.2);
    }
  });

  it('seats each Eden meadow tent on its own local terrain height', () => {
    const loaded = loadMap('eden');
    const tents = loaded.def.geo.filter((g) => (
      g.kind === 'box' && g.mat === 'plasterOld'
      && Math.abs(g.sx - 2.6) < 0.01 && Math.abs(g.sy - 1.8) < 0.01
      && g.x > 215 && g.x < 235 && g.z > 90 && g.z < 110
    ));
    expect(tents).toHaveLength(3);
    for (const tent of tents) {
      if (tent.kind !== 'box') continue;
      expect(tent.y - tent.sy / 2).toBeCloseTo(loaded.terrainHeight(tent.x, tent.z), 2);
    }
  });

  it('keeps the normalized Old Front quarry flight inside its terrain opening', () => {
    const { def } = loadMap('oldfront');
    const treads = def.geo.filter((g) => (
      g.kind === 'box' && g.mat === 'dirt' && Math.abs(g.z + 40) < 0.01
      && g.x > -82 && g.x < -60 && Math.abs(g.sz - 4) < 0.01
    ));
    expect(treads).toHaveLength(10);
    const upperEdge = Math.max(...treads.map((tread) => (
      tread.kind === 'box' ? tread.x + tread.sx / 2 : -Infinity
    )));
    expect(upperEdge).toBeLessThanOrEqual(-67.4);
  });

  it('removes positive-volume crate overlaps from every production map', () => {
    for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
      const { def } = loadMap(id);
      filterInvalidCrates(def);
      for (let i = 0; i < def.destructibles.length; i++) {
        for (let j = i + 1; j < def.destructibles.length; j++) {
          const a = def.destructibles[i]!;
          const b = def.destructibles[j]!;
          if (a.type !== 'crate' || b.type !== 'crate' || a.geo.kind !== 'box' || b.geo.kind !== 'box') continue;
          const overlaps = Math.abs(a.geo.x - b.geo.x) < (a.geo.sx + b.geo.sx) / 2 - 0.01
            && Math.abs(a.geo.y - b.geo.y) < (a.geo.sy + b.geo.sy) / 2 - 0.01
            && Math.abs(a.geo.z - b.geo.z) < (a.geo.sz + b.geo.sz) / 2 - 0.01;
          expect(overlaps, `${id} crates ${i}/${j}`).toBe(false);
        }
      }
    }
  });

  it('authors Old Front and Eden roads as continuous terrain ribbons', () => {
    const oldFront = loadMap('oldfront').def.surfacePaths;
    expect(oldFront).toHaveLength(9);
    expect(oldFront.every((path) => path.mat === 'dirt')).toBe(true);

    const eden = loadMap('eden').def.surfacePaths;
    expect(eden).toHaveLength(19);
    expect(eden.filter((path) => path.mat === 'dirt')).toHaveLength(9);
    expect(eden.filter((path) => path.mat === 'concrete')).toHaveLength(7);
    expect(eden.filter((path) => path.mat === 'metalDark')).toHaveLength(2);
    expect(eden.filter((path) => path.mat === 'concreteDark')).toHaveLength(1);
  });
});
