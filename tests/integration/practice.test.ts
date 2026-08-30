import { beforeAll, describe, expect, it } from 'vitest';
import { Match, type ActorController } from '../../src/sim/match';
import type { Actor } from '../../src/sim/actor';
import { emptyCommand } from '../../src/sim/input';
import { loadMap } from '../../src/world';
import { RAPIER_READY } from '../../src/world/rapierReady';
import { CAPSULE_CENTER_OFFSET } from '../../src/sim/movement';
import { HEAL_ITEMS } from '../../src/core/balance';
import { buildSoloRoster } from '../../src/sim/roster';

beforeAll(async () => {
  await RAPIER_READY();
});

function makePractice(seed: number): Match {
  const loaded = loadMap('eden');
  return new Match({
    mapDef: loaded.def,
    seed,
    difficulty: 'normal',
    mode: 'solo',
    roster: buildSoloRoster(seed, { practice: true }),
    practice: true,
  });
}

class JumpController implements ActorController {
  jumpQueued = false;
  sprint = false;

  updateCommand(_actor: Actor, _dt: number): ReturnType<typeof emptyCommand> {
    const cmd = emptyCommand();
    cmd.sprint = this.sprint;
    if (this.jumpQueued) {
      cmd.jumpPressed = true;
      this.jumpQueued = false;
    }
    return cmd;
  }
}

class CrouchController implements ActorController {
  held = false;

  updateCommand(_actor: Actor, _dt: number): ReturnType<typeof emptyCommand> {
    const cmd = emptyCommand();
    cmd.crouchHeld = this.held;
    return cmd;
  }
}

class FireOnceController implements ActorController {
  firePressed = true;

  updateCommand(_actor: Actor, _dt: number): ReturnType<typeof emptyCommand> {
    const cmd = emptyCommand();
    cmd.firePressed = this.firePressed;
    cmd.fireHeld = true;
    this.firePressed = false;
    return cmd;
  }
}

describe('practice starts', () => {
  it('routes deterministic QA elimination through placement, loot and alive-count processing', () => {
    const match = makePractice(94991);
    const player = match.localActor!;
    player.inv.add({ kind: 'weapon', weaponId: 'pistol', rarity: 'common', ammoInMag: 3 }, 0);
    expect(match.eliminateActor(player)).toBe(true);
    expect(match.eliminateActor(player)).toBe(false);
    match.fixedUpdate(1 / 60);

    expect(match.aliveCount).toBe(0);
    expect(player.placement).toBe(1);
    expect(player.deathTime).toBeGreaterThanOrEqual(0);
    expect(match.loot.items.some((item) => item.weapon?.weaponId === 'pistol')).toBe(true);
    match.dispose();
  }, 30_000);

  it('uses a selected heal stack from a left-click edge and HEAL_ITEMS timing/amount', () => {
    const match = makePractice(95001);
    const player = match.localActor!;
    const controller = new FireOnceController();
    player.shield = 50;
    player.inv.add({ kind: 'heal', itemId: 'shieldpot', count: 1 });
    player.inv.select(0);
    match.controllers.set(player.id, controller);

    match.fixedUpdate(1 / 60);
    expect(player.healing?.itemId).toBe('shieldpot');
    expect(player.healing?.total).toBe(HEAL_ITEMS.shieldpot.useTime);
    expect(player.inv.selectedItem).toBeNull();
    expect(player.punchTimer).toBe(0);

    for (let i = 1; i < Math.ceil(HEAL_ITEMS.shieldpot.useTime * 60) + 2; i++) {
      match.fixedUpdate(1 / 60);
    }
    expect(player.healing).toBeNull();
    expect(player.shield).toBe(50 + HEAL_ITEMS.shieldpot.amount);
  }, 30_000);

  it('selects a deterministic, validated dry navigation node', () => {
    const first = makePractice(840776);
    const repeat = makePractice(840776);
    const start = first.practiceStart!;

    expect(repeat.practiceStart).toEqual(start);
    expect(first.localActor?.body.position.x).toBeCloseTo(start.x);
    expect(first.localActor?.body.position.y).toBeCloseTo(start.y);
    expect(first.localActor?.body.position.z).toBeCloseTo(start.z);

    const node = first.nav.nodes.find((candidate) => (
      Math.abs(candidate.x - start.x) < 0.01
      && Math.abs(candidate.z - start.z) < 0.01
      && !candidate.water
    ));
    expect(node).toBeDefined();
    expect(start.y).toBeCloseTo(node!.y + CAPSULE_CENTER_OFFSET + 0.05);
  }, 30_000);

  it('varies the selected route between seeds', () => {
    const first = makePractice(840776).practiceStart!;
    const second = makePractice(840777).practiceStart!;
    expect([second.poi, second.x, second.z]).not.toEqual([first.poi, first.x, first.z]);
  }, 30_000);

  it('runs the configured normal and sprint jump arcs through real movement', () => {
    const heights: number[] = [];
    for (const sprint of [false, true]) {
      const match = makePractice(sprint ? 92002 : 92001);
      const player = match.localActor!;
      const controller = new JumpController();
      controller.sprint = sprint;
      match.controllers.set(player.id, controller);

      // Let the kinematic controller establish ground contact at the seeded
      // navigation node, then send one real jump edge through fixedUpdate.
      for (let i = 0; i < 12; i++) match.fixedUpdate(1 / 60);
      const groundY = player.body.position.y;
      controller.jumpQueued = true;
      let maxY = groundY;
      let leftGround = false;
      let landedFrame = -1;
      for (let frame = 0; frame < 120; frame++) {
        match.fixedUpdate(1 / 60);
        maxY = Math.max(maxY, player.body.position.y);
        if (!player.body.grounded) leftGround = true;
        if (leftGround && player.body.grounded) {
          landedFrame = frame;
          break;
        }
      }
      expect(leftGround).toBe(true);
      expect(landedFrame).toBeGreaterThanOrEqual(38);
      expect(landedFrame).toBeLessThan(58);
      heights.push(maxY - groundY);
    }

    expect(heights[0]).toBeGreaterThan(1.55);
    expect(heights[0]).toBeLessThan(2.15);
    expect(heights[1]).toBeGreaterThan(heights[0]!);
  }, 30_000);

  it('stands after crouch is released in open terrain', () => {
    const match = makePractice(94001);
    const player = match.localActor!;
    const controller = new CrouchController();
    match.controllers.set(player.id, controller);

    for (let i = 0; i < 12; i++) match.fixedUpdate(1 / 60);
    controller.held = true;
    match.fixedUpdate(1 / 60);
    expect(player.crouched).toBe(true);

    controller.held = false;
    match.fixedUpdate(1 / 60);
    expect(player.crouched).toBe(false);
  }, 30_000);
});
