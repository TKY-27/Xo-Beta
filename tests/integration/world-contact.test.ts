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

describe('rendered terrain and physics ground alignment', () => {
  it('lets the real character controller follow a normalized stair run without floating or embedding', () => {
    const builder = new WorldBuilder('stairs', 'Stairs', 'Traversal fixture', 100);
    builder.slab(0, 0, -3, 5, 6, 0.5, 'concreteDark');
    const stair = builder.stairs(0, 0, 0, 0, 10, 0.6, 0.6, 1.6, 'concreteDark');
    builder.slab(0, stair.totalRise, stair.run + 3, 5, 6, 0.5, 'concreteDark');
    const phys = new PhysicsWorld();
    buildColliders(builder.def, phys);
    phys.flush();
    const body = new CharBody(phys, 1, 0, CAPSULE_CENTER_OFFSET + 0.05, -2);
    const actor = new Actor('STAIR TEST', true, body, 0x5fd0ff);
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
    const actor = new Actor('STAIR DOWN TEST', true, body, 0x5fd0ff);
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

  for (const id of ['oldfront', 'eden'] satisfies MapId[]) {
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
          const physicalY = phys.surfaceAt(x, z, 10, 30);
          expect(physicalY).not.toBeNull();
          worstError = Math.max(worstError, Math.abs(visualY - physicalY!));
          samples++;
        }
      }

      expect(samples).toBeGreaterThan(70);
      expect(worstError).toBeLessThan(0.1);
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

  for (const id of ['neocity', 'oldfront', 'eden'] satisfies MapId[]) {
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
});
