import { beforeAll, describe, expect, it } from 'vitest';
import { MOVE } from '../../src/core/balance';
import {
  ClientMovementPredictionWorld,
  createClientMovementPredictionState,
  type ClientMovementPredictionState,
} from '../../src/net/clientMovementPrediction';
import { CAPSULE_CENTER_OFFSET, feetYFromBodyCenter } from '../../src/sim/movement';
import { emptyCommand, type InputCommand } from '../../src/sim/input';
import { ensureWorldReady } from '../../src/world';
import { WorldBuilder } from '../../src/world/builder';

const DT = 1 / 60;

beforeAll(async () => {
  await ensureWorldReady();
});

function command(input: Partial<InputCommand> = {}): InputCommand {
  return Object.assign(emptyCommand(), input);
}

function advance(
  world: ClientMovementPredictionWorld,
  initial: ClientMovementPredictionState,
  input: Partial<InputCommand>,
  frames = 1,
): ClientMovementPredictionState {
  let state = initial;
  for (let frame = 0; frame < frames; frame++) {
    const next = world.movementStep(state, command(input), DT);
    if (!next) throw new Error('movement step returned no state');
    state = next;
  }
  return state;
}

function flatBuilder(id: string): WorldBuilder {
  const builder = new WorldBuilder(id, id, 'Local movement prediction fixture', 100);
  builder.slab(0, 0, 0, 70, 70, 0.5, 'concreteDark');
  return builder;
}

function groundState(
  overrides: Partial<ClientMovementPredictionState> = {},
): ClientMovementPredictionState {
  return createClientMovementPredictionState(
    overrides.position ?? { x: 0, y: CAPSULE_CENTER_OFFSET + 0.05, z: 0 },
    { state: 'air', deployed: true, ...overrides },
  );
}

async function createFlatWorld(
  id: string,
  initialState = groundState(),
): Promise<ClientMovementPredictionWorld> {
  return ClientMovementPredictionWorld.create({
    mapDef: flatBuilder(id).def,
    actorId: 7001,
    initialState,
  });
}

describe('shared-rules client movement prediction world', () => {
  it('uses the real shared acceleration rules for walking', async () => {
    const world = await createFlatWorld('predict-walk');
    let state = advance(world, groundState(), {}, 12);
    expect(state.grounded).toBe(true);

    state = advance(world, state, { moveZ: 1, yaw: 0 }, 60);
    expect(state.position.z).toBeLessThan(-4);
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeCloseTo(MOVE.walkSpeed, 1);
    world.dispose();
  });

  it('uses the shared sprint speed instead of a parallel guest constant', async () => {
    const walkWorld = await createFlatWorld('predict-walk-compare');
    const sprintWorld = await createFlatWorld('predict-sprint');
    let walk = advance(walkWorld, groundState(), {}, 12);
    let sprint = advance(sprintWorld, groundState(), {}, 12);
    walk = advance(walkWorld, walk, { moveZ: 1, yaw: 0 }, 60);
    sprint = advance(sprintWorld, sprint, { moveZ: 1, yaw: 0, sprint: true }, 60);

    expect(-sprint.position.z).toBeGreaterThan(-walk.position.z + 2);
    expect(Math.hypot(sprint.velocity.x, sprint.velocity.z)).toBeCloseTo(MOVE.sprintSpeed, 1);
    walkWorld.dispose();
    sprintWorld.dispose();
  });

  it('runs the real jump arc and preserves its movement bookkeeping', async () => {
    const world = await createFlatWorld('predict-jump');
    let state = advance(world, groundState(), {}, 12);
    const groundY = state.position.y;
    state = advance(world, state, { jumpPressed: true, jumpHeld: true }, 1);
    expect(state.jumpsUsed).toBe(1);
    expect(state.velocity.y).toBeGreaterThan(0);
    state = advance(world, state, { jumpHeld: true }, 12);
    expect(state.position.y).toBeGreaterThan(groundY + 0.5);
    expect(state.state).toBe('air');
    world.dispose();
  });

  it('consumes a shared dash charge and applies the canonical dash velocity', async () => {
    const world = await createFlatWorld('predict-dash');
    let state = advance(world, groundState(), {}, 12);
    state = advance(world, state, { moveZ: 1, yaw: 0, dashPressed: true });

    expect(state.dashCharges).toBe(1);
    expect(state.dashTimer).toBeGreaterThan(0);
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeGreaterThan(MOVE.sprintSpeed);
    expect(state.position.z).toBeLessThan(-0.1);
    world.dispose();
  });

  it('enters and advances the real shared slide state after sprinting', async () => {
    const world = await createFlatWorld('predict-slide');
    let state = advance(world, groundState(), {}, 12);
    state = advance(world, state, { moveZ: 1, yaw: 0, sprint: true }, 60);
    const entrySpeed = Math.hypot(state.velocity.x, state.velocity.z);
    state = advance(world, state, {
      moveZ: 1,
      yaw: 0,
      sprint: true,
      crouchPressed: true,
      crouchHeld: true,
    });

    expect(state.state).toBe('slide');
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeGreaterThan(entrySpeed);
    state = advance(world, state, { moveZ: 1, yaw: 0, crouchHeld: true }, 10);
    expect(state.slideTimer).toBeGreaterThan(0.1);
    world.dispose();
  });

  it('uses Rapier wall contact and never tunnels the predicted capsule through scenery', async () => {
    const builder = flatBuilder('predict-wall');
    builder.box(0, 2, -3, 8, 4, 0.4, 'stoneBrick');
    const initial = groundState();
    const world = await ClientMovementPredictionWorld.create({
      mapDef: builder.def,
      actorId: 7002,
      initialState: initial,
    });
    let state = advance(world, initial, {}, 12);
    state = advance(world, state, { moveZ: 1, yaw: 0, sprint: true }, 120);

    expect(state.position.z).toBeGreaterThan(-2.4);
    expect(state.position.z).toBeLessThan(-1.8);
    expect(Math.abs(state.velocity.z)).toBeLessThan(0.2);
    world.dispose();
  });

  it('mantles with the shared capsule sweeps and captured mantle state', async () => {
    const builder = new WorldBuilder('predict-mantle', 'predict-mantle', 'Mantle fixture', 100);
    builder.slab(0, 0, -1, 8, 8, 0.5, 'stoneBrick');
    builder.box(0, 0.9, -1, 4, 1.8, 0.9, 'stoneBrick');
    const initial = groundState();
    const world = await ClientMovementPredictionWorld.create({
      mapDef: builder.def,
      actorId: 7003,
      initialState: initial,
    });
    let state = advance(world, initial, {}, 12);
    state = advance(world, state, { moveZ: 1, yaw: 0, jumpPressed: true });
    expect(state.state).toBe('mantle');
    expect(state.mantleTo.z).toBeLessThan(-0.8);

    state = advance(world, state, { moveZ: 1, yaw: 0 }, 32);
    expect(feetYFromBodyCenter(state.position.y)).toBeCloseTo(1.8, 1);
    expect(state.position.z).toBeLessThan(-0.8);
    world.dispose();
  });

  it('attaches and pulls through the exact shared grapple query and movement path', async () => {
    const builder = flatBuilder('predict-grapple');
    builder.box(0, 5, -14, 10, 10, 0.5, 'concreteDark');
    const initial = groundState({
      position: { x: 0, y: CAPSULE_CENTER_OFFSET + 2.5, z: 0 },
      state: 'air',
      grounded: false,
      velocity: { x: 0, y: -1, z: 0 },
    });
    const world = await ClientMovementPredictionWorld.create({
      mapDef: builder.def,
      actorId: 7004,
      initialState: initial,
    });
    let state = advance(world, initial, { yaw: 0, pitch: 0.1, grapplePressed: true });
    expect(state.grappleActive).toBe(true);
    expect(state.grapplePoint.z).toBeLessThan(-13);
    const startZ = state.position.z;
    state = advance(world, state, { yaw: 0, pitch: 0.1, moveZ: 1 }, 30);
    expect(state.position.z).toBeLessThan(startZ - 1);
    expect(state.grappleActive).toBe(true);
    world.dispose();
  });

  it('keeps an onboard actor locked until the host-authorized deployment handoff', async () => {
    const initial = groundState({
      position: { x: 4, y: 30, z: 6 },
      state: 'ground',
      grounded: false,
      deployed: false,
    });
    const world = await createFlatWorld('predict-transport', initial);
    let state = advance(world, initial, { jumpPressed: true });
    expect(state.deployed).toBe(false);
    expect(state.position).toEqual(initial.position);

    world.setTransportDeploymentAllowed(true);
    state = advance(world, state, { jumpPressed: true });
    expect(state.deployed).toBe(true);
    expect(state.state).toBe('freefall');
    expect(state.position).toEqual(initial.position);
    state = advance(world, state, {});
    expect(state.position.y).toBeLessThan(initial.position.y);
    world.dispose();
  });

  it('climbs authored stairs through the canonical map collider builder', async () => {
    const builder = new WorldBuilder('predict-stairs', 'predict-stairs', 'Stair fixture', 100);
    builder.slab(0, 0, -3, 5, 6, 0.5, 'concreteDark');
    const stair = builder.stairs(0, 0, 0, 0, 10, 0.6, 0.6, 1.6, 'concreteDark');
    builder.slab(0, stair.totalRise, stair.run + 3, 5, 6, 0.5, 'concreteDark');
    const initial = groundState({ position: { x: 0, y: CAPSULE_CENTER_OFFSET + 0.05, z: -2 } });
    const world = await ClientMovementPredictionWorld.create({
      mapDef: builder.def,
      actorId: 7005,
      initialState: initial,
    });
    let state = advance(world, initial, {}, 12);
    let reachedTop = false;
    for (let frame = 0; frame < 360; frame++) {
      state = advance(world, state, { moveZ: 1, yaw: Math.PI });
      if (state.position.z > stair.run + 1) {
        reachedTop = true;
        break;
      }
    }

    expect(reachedTop).toBe(true);
    expect(feetYFromBodyCenter(state.position.y)).toBeCloseTo(stair.totalRise, 1);
    world.dispose();
  });

  it('blocks an intact stable window and traverses only after a newer authoritative break revision', async () => {
    const builder = flatBuilder('predict-window');
    builder.glassPane(0, 1.1, -2.5, 5, 2.2, 'x');
    const glassId = builder.def.destructibles[0]!.stableId;
    const initial = groundState();
    const world = await ClientMovementPredictionWorld.create({
      mapDef: builder.def,
      actorId: 7006,
      initialState: initial,
    });
    let intact = advance(world, initial, {}, 12);
    intact = advance(world, intact, { moveZ: 1, yaw: 0, sprint: true }, 90);
    expect(intact.position.z).toBeGreaterThan(-2.1);
    expect(world.destructibleState(glassId)).toEqual({ id: glassId, revision: 0, destroyed: false });

    expect(world.syncDestructibles([{ id: glassId, revision: 1, destroyed: true }])).toBe(1);
    expect(world.syncDestructibles([{ id: glassId, revision: 1, destroyed: true }])).toBe(0);
    // A stale intact claim cannot resurrect a pane. A newer keyframe can.
    expect(world.syncDestructibles([{ id: glassId, revision: 0, destroyed: false }])).toBe(0);
    let broken = world.syncAuthoritative(initial);
    broken = advance(world, broken, {}, 12);
    broken = advance(world, broken, { moveZ: 1, yaw: 0, sprint: true }, 90);
    expect(broken.position.z).toBeLessThan(-3);

    expect(world.syncDestructibles([{ id: glassId, revision: 2, destroyed: false }])).toBe(1);
    let restored = world.syncAuthoritative(initial);
    restored = advance(world, restored, {}, 12);
    restored = advance(world, restored, { moveZ: 1, yaw: 0, sprint: true }, 90);
    expect(restored.position.z).toBeGreaterThan(-2.1);
    world.dispose();
  });

  it('round-trips every traversal field while excluding combat and inventory authority', async () => {
    const initial = groundState({
      position: { x: 1, y: CAPSULE_CENTER_OFFSET + 0.05, z: 2 },
      velocity: { x: 3, y: 4, z: 5 },
      state: 'grapple',
      grounded: false,
      crouched: true,
      grappleActive: true,
      grapplePoint: { x: 10, y: 12, z: -8 },
      mantleFrom: { x: 1, y: 2, z: 3 },
      mantleTo: { x: 4, y: 5, z: 6 },
      slideTimer: 0.3,
      wallrunTimer: 0.4,
      mantleTimer: 0.5,
      dashCharges: 1,
      jumpsUsed: 1,
      inWater: true,
      waterSurfaceY: 7,
      equippedWeapon: 'sniper',
      adsAmount: 0.7,
      healingMovementPenalty: true,
    });
    const world = await createFlatWorld('predict-round-trip', initial);
    const captured = world.syncAuthoritative(initial);

    expect(captured).toEqual(initial);
    expect(captured).not.toHaveProperty('health');
    expect(captured).not.toHaveProperty('shield');
    expect(captured).not.toHaveProperty('inventory');
    const ignored = advance(world, captured, {
      fireHeld: true,
      firePressed: true,
      interactPressed: true,
      medkitPressed: true,
      slotRequest: 3,
    });
    expect(ignored.equippedWeapon).toBe('sniper');
    expect(ignored.healingMovementPenalty).toBe(true);
    world.dispose();
    expect(() => world.captureState()).toThrow(/disposed/);
  });
});
