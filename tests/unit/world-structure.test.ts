import { describe, expect, it } from 'vitest';
import { CAPSULE_CENTER_OFFSET, feetYFromBodyCenter } from '../../src/sim/movement';
import {
  planStairs,
  STAIR_MAX_RISE,
  STAIR_MIN_TREAD,
  STAIR_MIN_WIDTH,
  WorldBuilder,
} from '../../src/world/builder';
import { addBuilding } from '../../src/world/maps/common';

describe('world-space structure contracts', () => {
  it('places every building floor at its own elevation and connects the roof', () => {
    const b = new WorldBuilder('test', 'Test', 'Test', 100);
    const baseY = 2.25;
    const floorHeight = 4;
    addBuilding(b, {
      x: 0,
      z: 0,
      baseY,
      w: 20,
      d: 16,
      floors: 2,
      floorHeight,
      wallMat: 'facadeA',
      trimMat: 'metalDark',
      roofMat: 'roofTile',
      interiorDividers: false,
      windows: false,
    });

    const walls = b.def.geo.filter((g) => g.kind === 'box' && g.mat === 'facadeA');
    const wallCentres = [...new Set(walls
      .filter((g) => g.kind === 'box' && g.sy === floorHeight)
      .map((g) => Number(g.y.toFixed(3))))].sort((a, b2) => a - b2);
    expect(wallCentres).toEqual([
      Number((baseY + floorHeight / 2).toFixed(3)),
      Number((baseY + floorHeight * 1.5).toFixed(3)),
    ]);

    const roof = b.def.geo.find((g) => (
      g.kind === 'box'
      && g.mat === 'roofTile'
      && Math.abs(g.sx - 20.5) < 0.01
      && Math.abs(g.sz - 16.5) < 0.01
    ));
    expect(roof?.kind).toBe('box');
    if (!roof || roof.kind !== 'box') throw new Error('roof slab missing');
    const upperWallTop = Math.max(...walls.map((g) => g.kind === 'box' ? g.y + g.sy / 2 : -Infinity));
    const roofBottom = roof.y - roof.sy / 2;
    expect(roofBottom).toBeLessThanOrEqual(upperWallTop + 0.01);
    expect(upperWallTop - roofBottom).toBeLessThan(0.3);

    const foundation = b.def.geo.find((g) => g.kind === 'box' && g.sy === 2.2);
    expect(foundation?.kind).toBe('box');
    if (!foundation || foundation.kind !== 'box') throw new Error('foundation slab missing');
    expect(foundation.y + foundation.sy / 2).toBeCloseTo(baseY + 0.08, 5);

    const stair = planStairs(Math.ceil(floorHeight / 0.55), floorHeight / Math.ceil(floorHeight / 0.55), 0.62, 1.7);
    const stairX = -20 / 2 + 1.4;
    const stairZ = -16 / 2 + 0.8 + stair.run / 2;
    const upperFloor = b.def.geo.filter((g) => (
      g.kind === 'box'
      && Math.abs(g.sy - 0.35) < 0.001
      && Math.abs(g.y + g.sy / 2 - (baseY + floorHeight + 0.18)) < 0.001
    ));
    expect(upperFloor.length).toBeGreaterThan(1);
    expect(upperFloor.some((g) => g.kind === 'box'
      && Math.abs(stairX - g.x) < g.sx / 2
      && Math.abs(stairZ - g.z) < g.sz / 2)).toBe(false);
  });

  it('anchors visual soles at the physical capsule bottom', () => {
    const groundY = 7.5;
    const bodyCenterY = groundY + CAPSULE_CENTER_OFFSET;
    expect(feetYFromBodyCenter(bodyCenterY)).toBeCloseTo(groundY, 8);
  });

  it('resamples every stair run to a stable human-scale contract', () => {
    const plan = planStairs(10, 0.6, 0.6, 1.6);
    expect(plan.stepH).toBeLessThanOrEqual(STAIR_MAX_RISE);
    expect(plan.stepD).toBeGreaterThanOrEqual(STAIR_MIN_TREAD);
    expect(plan.width).toBeGreaterThanOrEqual(STAIR_MIN_WIDTH);
    expect(plan.totalRise).toBeCloseTo(6, 8);

    const b = new WorldBuilder('stairs', 'Stairs', 'Stairs', 100);
    const down = b.stairs(0, 4, 0, 0, 8, -0.6, 0.62, 1.7, 'concreteDark');
    const boxes = b.def.geo.filter((g) => g.kind === 'box');
    expect(boxes).toHaveLength(down.steps);
    expect(down.stepH).toBeGreaterThanOrEqual(-STAIR_MAX_RISE);
    expect(down.totalRise).toBeCloseTo(-4.8, 8);
    expect(boxes.every((g) => g.kind === 'box' && g.sy > 0)).toBe(true);
    expect(boxes.some((g) => g.kind === 'box'
      && Math.abs(g.y + g.sy / 2 - (4 + down.totalRise)) < 1e-8)).toBe(true);
    expect(Math.max(...b.def.platforms.map((p) => p.y))).toBeLessThan(4);
    expect(Math.min(...b.def.platforms.map((p) => p.y))).toBeCloseTo(-0.8, 8);
  });

  it('clips malformed wall gaps to the authored wall span', () => {
    const b = new WorldBuilder('walls', 'Walls', 'Walls', 100);
    b.wallWithGaps(10, 20, 12, 3, 0.4, 'x', 'concrete', [[-4, 6], [10, 8]]);
    const boxes = b.def.geo.filter((g) => g.kind === 'box');
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      if (box.kind !== 'box') continue;
      expect(box.x - box.sx / 2).toBeGreaterThanOrEqual(10);
      expect(box.x + box.sx / 2).toBeLessThanOrEqual(22);
    }
  });

  it('stores lamp bases at their support height and renders only the detailed fixture', () => {
    const b = new WorldBuilder('lamps', 'Lamps', 'Lamps', 100);
    b.lampPost(4, -7, 3.25, 5.4, 0xffffff);
    expect(b.def.lamps).toEqual([expect.objectContaining({ x: 4, y: 3.25, z: -7, h: 5.4 })]);
    const proxy = b.def.geo.find((g) => g.noRender);
    expect(proxy?.kind).toBe('box');
    if (!proxy || proxy.kind !== 'box') throw new Error('lamp collision proxy missing');
    expect(proxy.y - proxy.sy / 2).toBeCloseTo(3.25, 8);
    expect(proxy.noCollide).not.toBe(true);
  });

  it('cuts ground-floor glazing openings before placing glass inside the wall', () => {
    const b = new WorldBuilder('windows', 'Windows', 'Windows', 100);
    addBuilding(b, {
      x: 0, z: 0, w: 12, d: 10, floors: 1, floorHeight: 3.6,
      wallMat: 'concrete', windows: true, interiorDividers: false,
    });
    const frontGlass = b.def.destructibles.filter((d) => d.type === 'glass' && d.geo.kind === 'box');
    expect(frontGlass).toHaveLength(2);
    const frontWalls = b.def.geo.filter((g) => g.kind === 'box' && g.mat === 'concrete' && Math.abs(g.z - 5) < 0.01);
    expect(frontWalls.length).toBeGreaterThan(1);
    for (const glass of frontGlass) {
      const glassGeo = glass.geo;
      if (glassGeo.kind !== 'box') continue;
      expect(glassGeo.z).toBeLessThan(5 - 0.15);
      expect(frontWalls.every((wall) => {
        if (wall.kind !== 'box') return true;
        return wall.x + wall.sx / 2 <= glassGeo.x - glassGeo.sx / 2
          || wall.x - wall.sx / 2 >= glassGeo.x + glassGeo.sx / 2
          || wall.y + wall.sy / 2 <= glassGeo.y - glassGeo.sy / 2
          || wall.y - wall.sy / 2 >= glassGeo.y + glassGeo.sy / 2;
      })).toBe(true);
    }
  });
});
