import { beforeAll, describe, expect, it } from 'vitest';
import {
  CAPSULE_CENTER_OFFSET,
  CharBody,
  feetYFromBodyCenter,
  PhysicsWorld,
} from '../../src/physics/physics';
import { buildColliders, WorldBuilder } from '../../src/world/builder';
import { addBuilding, addGround } from '../../src/world/maps/common';
import { loadMap, type MapId } from '../../src/world';
import { NavGraph } from '../../src/world/nav';
import { RAPIER_READY } from '../../src/world/rapierReady';
import { Match } from '../../src/sim/match';
import { MOVE } from '../../src/core/balance';
import { emptyCommand } from '../../src/sim/input';

beforeAll(async () => {
  await RAPIER_READY();
});

interface Penetration {
  node: { id: number; x: number; y: number; z: number };
  collider: number;
  depth: number;
}

function materiallyPenetratingNavNodes(id: MapId): Penetration[] {
  const loaded = loadMap(id);
  const phys = new PhysicsWorld();
  buildColliders(loaded.def, phys);
  phys.flush();
  const nav = new NavGraph();
  nav.build(loaded.def, phys);
  const failures: Penetration[] = [];

  for (const node of nav.nodes) {
    const position = {
      x: node.x,
      y: node.water ? node.y - MOVE.swimSurfaceCenterDepth : node.y + CAPSULE_CENTER_OFFSET,
      z: node.z,
    };
    for (const penetration of phys.characterPenetrationsAt(position.x, position.y, position.z)) {
      failures.push({
        node: { id: node.id, x: node.x, y: node.y, z: node.z },
        collider: penetration.collider.handle,
        depth: penetration.depth,
      });
    }
  }

  phys.dispose();
  return failures;
}

describe('character capsule penetration invariants', () => {
  for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
    it(`${id} keeps every navigation node clear for its standing or swimming capsule`, () => {
      const failures = materiallyPenetratingNavNodes(id);
      expect(failures, JSON.stringify(failures.slice(0, 20), null, 2)).toEqual([]);
    }, 30_000);
  }

  it('keeps seeded practice spawns clear and connected on every map', () => {
    for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
      const loaded = loadMap(id);
      for (const seed of [840776, 840777, 840778, 840779, 840780, 840781]) {
        const match = new Match({
          mapDef: loaded.def,
          seed,
          difficulty: 'normal',
          withPlayer: true,
          practice: true,
        });
        const player = match.player!;
        const position = player.body.position;
        expect(match.phys.characterPenetrationsAt(
          position.x,
          position.y,
          position.z,
          player.body.body,
        ), `${id} seed ${seed}`).toEqual([]);
        const node = match.nav.nearest(
          position.x,
          feetYFromBodyCenter(position.y),
          position.z,
          1,
        );
        expect(node, `${id} seed ${seed}`).not.toBeNull();
        expect(node!.edges.length, `${id} seed ${seed}`).toBeGreaterThan(0);
        match.dispose();
      }
    }
  // This intentionally builds 24 complete matches (including four full Nav
  // graphs). On the shared full-suite worker pool that takes roughly two
  // minutes; retain the coverage instead of dropping map/seed cases.
  }, 180_000);

  it('keeps every chest reachable from a clear same-floor line of sight', () => {
    for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
      const loaded = loadMap(id);
      const match = new Match({
        mapDef: loaded.def,
        seed: 901244,
        difficulty: 'normal',
        withPlayer: true,
        practice: true,
      });
      const body = match.player!.body;
      const inaccessible = match.chests.filter((chest) => {
        for (const radius of [3, 2.5, 2, 1.5]) {
          for (let i = 0; i < 16; i++) {
            const angle = i * Math.PI / 8;
            const x = chest.x + Math.cos(angle) * radius;
            const z = chest.z + Math.sin(angle) * radius;
            const support = match.phys.surfaceAt(x, z, chest.y + 1.8, 4);
            if (support === null || Math.abs(support - chest.y) > 1.2) continue;
            const placement = match.phys.findClearStandingPlacement(x, support, z, body.body);
            if (!placement) continue;
            const eyeY = feetYFromBodyCenter(placement.y) + MOVE.eyeHeight;
            if (match.chestHasLineOfSightFrom(placement.x, eyeY, placement.z, chest)) return false;
          }
        }
        return true;
      });
      expect(inaccessible, `${id}: ${JSON.stringify(inaccessible)}`).toEqual([]);
      match.dispose();
    }
  }, 30_000);

  it('connects a three-storey building from its exterior through every stair flight', () => {
    const builder = new WorldBuilder('nav-building', 'Nav building', 'Traversal fixture', 500);
    addGround(builder, 500, 'concreteDark');
    addBuilding(builder, {
      x: 0,
      z: 0,
      w: 16,
      d: 14,
      floors: 3,
      wallMat: 'concrete',
      // Deliberately overlaps the generated ground-floor window gap. A door
      // must never inherit the window's 1.1 m sill collider.
      doors: [[0, 10.7, 2.4]],
    });
    const phys = new PhysicsWorld();
    buildColliders(builder.def, phys);
    phys.flush();
    const nav = new NavGraph();
    nav.build(builder.def, phys);
    const doorwayY = 0.08 + CAPSULE_CENTER_OFFSET + 0.05;
    expect(phys.isCharacterSweepClear(
      { x: 3.9, y: doorwayY, z: 8 },
      { x: 3.9, y: doorwayY, z: 6 },
    )).toBe(true);
    const top = nav.nodes.find((node) => !node.water && node.y > 7 && node.edges.length > 0);
    expect(top).toBeDefined();
    expect(nav.findPath(0, 0, 12, top!.x, top!.y, top!.z)).not.toBeNull();
    phys.dispose();
  });

  it('rejects a walk edge whose centre ray fits but whose capsule clips doorway jambs', () => {
    const buildDoorway = (gap: number) => {
      const builder = new WorldBuilder('nav-doorway', 'Nav doorway', 'Capsule corridor fixture', 20);
      // One physical floor, but only two deliberately sampled navigation
      // islands. The prospective edge crosses the wall at its narrow opening.
      builder.box(0, -0.2, 0, 12, 0.4, 12, 'concreteDark');
      builder.platform(-0.05, 0.05, -2.05, -1.95, 0);
      builder.platform(-0.05, 0.05, 1.95, 2.05, 0);
      const sideLength = (10 - gap) / 2;
      const sideOffset = gap / 2 + sideLength / 2;
      builder.box(-sideOffset, 1.5, 0, sideLength, 3, 0.3, 'concrete');
      builder.box(sideOffset, 1.5, 0, sideLength, 3, 0.3, 'concrete');
      const phys = new PhysicsWorld();
      buildColliders(builder.def, phys);
      phys.flush();
      const nav = new NavGraph();
      nav.build(builder.def, phys);
      return { nav, phys };
    };

    const blocked = buildDoorway(MOVE.capsuleRadius * 2 - 0.06);
    // This is the exact check the old graph used: the centre ray sees air.
    expect(blocked.phys.raycast(0, 1.25, -2, 0, 0, 1, 3.9)).toBeNull();
    expect(blocked.nav.nodes).toHaveLength(2);
    expect(blocked.nav.nodes.every((node) => node.edges.length === 0)).toBe(true);
    blocked.phys.dispose();

    const clear = buildDoorway(MOVE.capsuleRadius * 2 + 0.32);
    expect(clear.nav.nodes).toHaveLength(2);
    expect(clear.nav.nodes.every((node) => node.edges.some((edge) => edge.type === 'walk'))).toBe(true);
    clear.phys.dispose();
  });

  it('publishes mantle, drop and shore edges only in their physical direction', () => {
    let shoreEdges = 0;
    for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
      const loaded = loadMap(id);
      const phys = new PhysicsWorld();
      buildColliders(loaded.def, phys);
      phys.flush();
      const nav = new NavGraph();
      nav.build(loaded.def, phys);
      for (const node of nav.nodes) {
        if (node.water) {
          const terrainY = phys.terrainSurfaceAt(node.x, node.z, node.y + 20, 40);
          if (terrainY !== null) {
            expect(terrainY, `${id} submerged nav node ${node.id}`).toBeLessThanOrEqual(
              node.y - MOVE.swimSurfaceCenterDepth - CAPSULE_CENTER_OFFSET + 0.05,
            );
          }
        }
        for (const edge of node.edges) {
          const target = nav.nodes[edge.to]!;
          if (edge.type === 'mantle') expect(target.y, `${id} mantle ${node.id}->${edge.to}`).toBeGreaterThan(node.y);
          if (edge.type === 'drop') expect(target.y, `${id} drop ${node.id}->${edge.to}`).toBeLessThan(node.y);
          if (edge.type === 'shore') {
            shoreEdges++;
            expect(node.water, `${id} shore origin ${node.id}`).toBe(true);
            expect(target.water, `${id} shore target ${edge.to}`).toBe(false);
          }
          if (node.water !== target.water && edge.type === 'walk') {
            expect(node.water, `${id} dry-entry origin ${node.id}`).toBe(false);
            expect(target.water, `${id} dry-entry target ${edge.to}`).toBe(true);
          }
        }
      }
      phys.dispose();
    }
    expect(shoreEdges).toBeGreaterThan(0);
  }, 30_000);

  it('replays a generated Eden shore edge through the actor movement state machine', () => {
    const match = new Match({
      mapDef: loadMap('eden').def,
      seed: 904243,
      difficulty: 'normal',
      withPlayer: true,
      practice: true,
    });
    const player = match.player!;
    const candidates = match.nav.nodes.flatMap((source) => {
      if (!source.water) return [];
      return source.edges
        .filter((edge) => edge.type === 'shore')
        .map((edge) => ({ source, target: match.nav.nodes[edge.to]! }));
    }).sort((a, b) => {
      const aDist = Math.hypot(a.target.x - a.source.x, a.target.z - a.source.z);
      const bDist = Math.hypot(b.target.x - b.source.x, b.target.z - b.source.z);
      return Math.abs(a.target.y - a.source.y) + aDist * 0.08
        - Math.abs(b.target.y - b.source.y) - bDist * 0.08;
    });
    expect(candidates.length).toBeGreaterThan(0);
    const { source, target } = candidates[0]!;
    const placement = match.phys.findClearSwimmingPlacement(
      source.x,
      source.y,
      source.z,
      player.body.body,
    );
    expect(placement).not.toBeNull();
    player.body.teleport(placement!.x, placement!.y, placement!.z);
    player.body.velocity.x = 0;
    player.body.velocity.y = 0;
    player.body.velocity.z = 0;
    player.state = 'swim';
    player.inWater = true;
    player.submerged = false;
    player.waterSurfaceY = source.y;
    player.deployed = true;

    const dx = target.x - source.x;
    const dz = target.z - source.z;
    const distance = Math.hypot(dx, dz);
    const command = emptyCommand();
    command.moveZ = 1;
    command.jumpHeld = true;
    command.yaw = Math.atan2(-dx, -dz);
    let progress = 0;
    let retainedWaterOnFirstTick = false;
    for (let frame = 0; frame < 360; frame++) {
      match.movement.update(player, command, 1 / 60);
      match.phys.fixedStep(1 / 60);
      if (frame === 0) retainedWaterOnFirstTick = player.inWater;
      progress = Math.max(progress, (
        (player.body.position.x - source.x) * dx
        + (player.body.position.z - source.z) * dz
      ) / distance);
      expect(match.phys.characterPenetrationsAt(
        player.body.position.x,
        player.body.position.y,
        player.body.position.z,
        player.body.body,
      ), `shore frame ${frame}`).toEqual([]);
      const observedState: string = player.state;
      if (observedState === 'ground') {
        expect(player.body.grounded, `false ground at shore frame ${frame}`).toBe(true);
        expect(player.body.velocity.y).toBe(0);
        break;
      }
    }
    expect(retainedWaterOnFirstTick).toBe(true);
    expect(progress).toBeGreaterThan(2);
    expect(player.state as string).toBe('ground');
    expect(player.body.grounded).toBe(true);
    expect(player.inWater).toBe(false);
    match.dispose();
  }, 30_000);

  it('classifies only unsupported, full-capsule-clear traversal corridors as jump or mantle links', () => {
    const buildVertical = (blocked: boolean) => {
      const builder = new WorldBuilder('nav-vertical', 'Nav vertical', 'Traversal direction fixture', 40);
      builder.box(0, -0.2, -5, 4, 0.4, 4, 'concrete');
      builder.platform(-0.05, 0.05, -5.05, -4.95, 0);
      builder.box(0, 1.8, -2, 4, 0.4, 2, 'concrete');
      builder.platform(-0.05, 0.05, -2.05, -1.95, 2);
      if (blocked) {
        // The old centre ray at x=0 sees air; the capsule radius clips this
        // off-axis overhead bar during the raised mantle/drop segment.
        builder.box(0.5, 3, -3.4, 0.2, 2, 0.2, 'concrete');
      }
      const phys = new PhysicsWorld();
      buildColliders(builder.def, phys);
      phys.flush();
      const nav = new NavGraph();
      nav.build(builder.def, phys);
      return { nav, phys };
    };

    const vertical = buildVertical(false);
    const lower = vertical.nav.nodes.find((node) => node.y < 1)!;
    const higher = vertical.nav.nodes.find((node) => node.y > 1)!;
    expect(lower.edges).toContainEqual(expect.objectContaining({ to: higher.id, type: 'mantle' }));
    expect(higher.edges).toContainEqual(expect.objectContaining({ to: lower.id, type: 'drop' }));
    vertical.phys.dispose();

    const blockedVertical = buildVertical(true);
    expect(blockedVertical.nav.nodes.every((node) => node.edges.length === 0)).toBe(true);
    blockedVertical.phys.dispose();

    const buildGap = (mode: 'gap' | 'blocked' | 'continuous') => {
      const builder = new WorldBuilder('nav-gap', 'Nav gap', 'Jump corridor fixture', 40);
      builder.box(0, -0.2, -5, 4, 0.4, 4, 'concrete');
      builder.platform(-0.05, 0.05, -5.05, -4.95, 0);
      builder.box(0, -0.2, 5, 4, 0.4, 4, 'concrete');
      builder.platform(-0.05, 0.05, 4.95, 5.05, 0);
      if (mode === 'blocked') builder.box(0.5, 2.8, 0, 0.2, 2, 0.3, 'concrete');
      if (mode === 'continuous') builder.box(0, -0.2, 0, 4, 0.4, 8, 'concrete');
      const phys = new PhysicsWorld();
      buildColliders(builder.def, phys);
      phys.flush();
      const nav = new NavGraph();
      nav.build(builder.def, phys);
      return { nav, phys };
    };

    const gap = buildGap('gap');
    expect(gap.nav.nodes.every((node) => node.edges.some((edge) => edge.type === 'jump'))).toBe(true);
    gap.phys.dispose();

    for (const mode of ['blocked', 'continuous'] as const) {
      const rejected = buildGap(mode);
      expect(rejected.nav.nodes.every((node) => node.edges.every((edge) => edge.type !== 'jump'))).toBe(true);
      rejected.phys.dispose();
    }
  });

  it('connects clear neighbours across every spatial cell within walk range', () => {
    const builder = new WorldBuilder('nav-cell-boundary', 'Nav cell boundary', 'Spatial hash fixture', 100);
    builder.box(12, -0.2, 0, 12, 0.4, 4, 'concrete');
    builder.platform(7.85, 7.95, -0.05, 0.05, 0);
    builder.platform(16.05, 16.15, -0.05, 0.05, 0);
    const phys = new PhysicsWorld();
    buildColliders(builder.def, phys);
    phys.flush();
    const nav = new NavGraph();
    nav.build(builder.def, phys);

    expect(nav.nodes).toHaveLength(2);
    const [left, right] = nav.nodes;
    expect(Math.floor(left!.x / 8)).toBe(0);
    expect(Math.floor(right!.x / 8)).toBe(2);
    expect(left!.edges).toContainEqual(expect.objectContaining({ to: right!.id, type: 'walk' }));
    expect(right!.edges).toContainEqual(expect.objectContaining({ to: left!.id, type: 'walk' }));
    phys.dispose();
  });

  it('never exposes pruned navigation islands through spatial queries', () => {
    for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
      const loaded = loadMap(id);
      const phys = new PhysicsWorld();
      buildColliders(loaded.def, phys);
      phys.flush();
      const nav = new NavGraph();
      nav.build(loaded.def, phys);
      const isolated = nav.nodes.filter((node) => node.edges.length === 0);
      expect(isolated.length, `${id} should exercise pruned-island filtering`).toBeGreaterThan(0);
      for (const node of isolated) {
        const nearest = nav.nearest(node.x, node.y, node.z, 0.5);
        expect(nearest?.edges.length ?? 1, `${id} orphan ${node.id} leaked through nearest`).toBeGreaterThan(0);
        expect(
          nav.nodesWithin(node.x, node.z, 0.1, node.y, 0.1).some((candidate) => candidate.id === node.id),
          `${id} orphan ${node.id} leaked through nodesWithin`,
        ).toBe(false);
      }
      phys.dispose();
    }
  }, 60_000);

  it('keeps underground and quarry entrances open to a real character capsule', () => {
    const routes = [
      { name: 'neocity-centre', id: 'neocity' as const, x: 119.5, z: -140.5, dx: 0, dy: -0.18, dz: 0.12, entered: (body: CharBody) => body.position.z > -128, finalFeet: (feet: number) => feet < -4 },
      { name: 'neocity-jamb-margin', id: 'neocity' as const, x: 120.25, z: -140.5, dx: 0, dy: -0.18, dz: 0.12, entered: (body: CharBody) => body.position.z > -128, finalFeet: (feet: number) => feet < -4 },
      { name: 'oldfront-quarry-descent', id: 'oldfront' as const, x: -66, z: -40, dx: -0.12, dy: -0.18, dz: 0, probeY: 5, entered: (body: CharBody) => body.position.x < -87, finalFeet: (feet: number) => feet < -4.8 },
      { name: 'oldfront-quarry-ascent', id: 'oldfront' as const, x: -86, z: -40, dx: 0.12, dy: 0, dz: 0, probeY: -3, entered: (body: CharBody) => body.position.x > -67, finalFeet: (feet: number) => feet > -2 },
      { name: 'eden-descent', id: 'eden' as const, x: -197, z: -124, dx: 0.12, dy: -0.18, dz: 0, entered: (body: CharBody) => body.position.x > -180, finalFeet: (feet: number) => feet < -4 },
      { name: 'eden-ascent', id: 'eden' as const, x: -179, z: -124, dx: -0.12, dy: 0, dz: 0, probeY: -3, entered: (body: CharBody) => body.position.x < -195, finalFeet: (feet: number) => feet > -1 },
    ];
    for (const route of routes) {
      const loaded = loadMap(route.id);
      const phys = new PhysicsWorld();
      buildColliders(loaded.def, phys);
      phys.flush();
      const support = phys.surfaceAt(route.x, route.z, route.probeY ?? 3, 12);
      expect(support, route.name).not.toBeNull();
      const body = new CharBody(
        phys,
        route.id === 'neocity' ? 301 : route.id === 'oldfront' ? 302 : 303,
        route.x,
        support! + CAPSULE_CENTER_OFFSET + 0.05,
        route.z,
      );
      phys.fixedStep(1 / 60);
      for (let frame = 0; frame < 180; frame++) {
        body.move(route.dx, route.dy, route.dz);
        phys.fixedStep(1 / 60);
        expect(phys.characterPenetrationsAt(
          body.position.x,
          body.position.y,
          body.position.z,
          body.body,
        ), `${route.name} frame ${frame}`).toEqual([]);
      }
      expect(route.entered(body), JSON.stringify(body.position)).toBe(true);
      expect(route.finalFeet(feetYFromBodyCenter(body.position.y)), JSON.stringify(body.position)).toBe(true);
      expect(body.grounded, `${route.name} ${JSON.stringify(body.position)}`).toBe(true);
      body.dispose();
      phys.dispose();
    }
  });

  it('connects a shallow four-storey roof with supported switchback flights', () => {
    const builder = new WorldBuilder('roof-access', 'Roof access', 'Switchback fixture', 100);
    addGround(builder, 100, 'concreteDark');
    addBuilding(builder, {
      x: 0,
      z: 0,
      w: 12,
      d: 10,
      floors: 4,
      wallMat: 'concrete',
      doors: [[0, 5, 2]],
      roofAccess: true,
    });
    const phys = new PhysicsWorld();
    buildColliders(builder.def, phys);
    phys.flush();
    const nav = new NavGraph();
    nav.build(builder.def, phys);
    const roofNode = nav.nodes.find((node) => node.y > 14 && node.edges.length > 0);
    expect(roofNode).toBeDefined();
    const path = nav.findPath(0, 0, 8, roofNode!.x, roofNode!.y, roofNode!.z);
    expect(path).not.toBeNull();
    expect(path!.points.some((point) => point.y > 14)).toBe(true);
    for (const point of path!.points) {
      expect(phys.isCharacterPositionClear(
        point.x,
        point.y + CAPSULE_CENTER_OFFSET,
        point.z,
      ), JSON.stringify(point)).toBe(true);
    }
    phys.dispose();
  });
});
