import { beforeAll, describe, expect, it } from 'vitest';
import { GROUPS, initPhysics, PhysicsWorld } from '../../src/physics/physics';
import { loadMap, type MapId } from '../../src/world';
import { buildColliders, normalizeMapForMatch, WorldBuilder } from '../../src/world/builder';
import { hardenExposedFlanks } from '../../src/world/maps/common';
import { sampleTerrainHeightfield } from '../../src/world/terrainMesh';
import type { GeoSpec, MapDef } from '../../src/world/types';

type Box = Extract<GeoSpec, { kind: 'box' }>;

function coverBoxes(def: MapDef): Box[] {
  return def.geo.filter((geo): geo is Box => geo.kind === 'box'
    && geo.materialHint === 'stone' && geo.yaw === 0
    && ((Math.abs(geo.sx - 1.6) < 1e-6 && Math.abs(geo.sz - 0.55) < 1e-6)
      || (Math.abs(geo.sx - 0.55) < 1e-6 && Math.abs(geo.sz - 1.6) < 1e-6)));
}

function fixture(id: string, heightAt?: (x: number, z: number) => number): WorldBuilder {
  const b = new WorldBuilder(id, id, id, 100);
  if (heightAt) {
    b.def.heightfield = {
      n: 2,
      heights: new Float32Array([
        heightAt(-50, -50), heightAt(50, -50),
        heightAt(-50, 50), heightAt(50, 50),
      ]),
    };
  }
  return b;
}

function footprint(box: Box, heightAt: (x: number, z: number) => number): number[] {
  const heights: number[] = [];
  for (let iz = 0; iz <= 8; iz++) {
    for (let ix = 0; ix <= 8; ix++) {
      heights.push(heightAt(box.x - box.sx / 2 + box.sx * ix / 8,
        box.z - box.sz / 2 + box.sz * iz / 8));
    }
  }
  return heights;
}

function expectGrounded(box: Box, heightAt: (x: number, z: number) => number): void {
  const heights = footprint(box, heightAt);
  expect(box.y - box.sy / 2).toBeCloseTo(Math.min(...heights), 4);
  expect(box.y + box.sy / 2).toBeCloseTo(Math.max(...heights) + 0.56, 4);
  expect(box.noCollide).not.toBe(true);
  expect(box.noRender).not.toBe(true);
  expect(box.pitch).toBeUndefined();
  expect(box.roll).toBeUndefined();
}

beforeAll(async () => initPhysics());

describe('generated flank cover grounding', () => {
  it('preserves the original flat-map cover dimensions and placement', () => {
    const b = fixture('cover-flat');
    hardenExposedFlanks(b, { mat: 'concrete', maxProps: 2 });
    const boxes = coverBoxes(b.def);
    expect(boxes).toHaveLength(2);
    expect(boxes.map(({ x, y, z, sx, sy, sz }) => ({ x, y, z, sx, sy, sz }))).toEqual([
      { x: -32, y: 0.28, z: -32, sx: 1.6, sy: 0.56, sz: 0.55 },
      { x: -32, y: 0.28, z: -8, sx: 0.55, sy: 0.56, sz: 1.6 },
    ]);
    expect(b.def.platforms).toEqual([]);
    expect(b.def.destructibles).toEqual([]);
  });

  it.each([3, -3])('grounds fresh and cached cover on a flat heightfield at %s', (height) => {
    for (let pass = 0; pass < 2; pass++) {
      const b = fixture(`cover-flat-${height}`, () => height);
      expect(b.def.terrainHeight).toBeUndefined();
      hardenExposedFlanks(b, { mat: 'sandbag', maxProps: 2 });
      const boxes = coverBoxes(b.def);
      expect(boxes).toHaveLength(2);
      for (const box of boxes) expectGrounded(box, () => height);
    }
  });

  it.each([1, -1])('supports both orientations across the entire sloping footprint (%s)', (direction) => {
    let original: Box[] | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const b = fixture(`cover-slope-${direction}`, (x, z) => 4 + direction * (0.2 * x + 0.1 * z));
      hardenExposedFlanks(b, { mat: 'sandbag', maxProps: 2 });
      const boxes = coverBoxes(b.def);
      expect(boxes).toHaveLength(2);
      const hf = b.def.heightfield!;
      for (const box of boxes) {
        expectGrounded(box, (x, z) => sampleTerrainHeightfield(hf, b.def.size, x, z));
        expect(box.sy).toBeGreaterThan(0.56);
      }
      if (original) expect(boxes).toEqual(original);
      original = boxes;
    }
  });

  it('uses anti-diagonal terrain interpolation rather than a bilinear approximation', () => {
    const b = fixture('cover-triangles', () => 0);
    b.def.heightfield!.heights[3] = 40;
    hardenExposedFlanks(b, { mat: 'sandbag', maxProps: 9 });
    const boxes = coverBoxes(b.def);
    expect(boxes).toHaveLength(9);
    for (const box of boxes) {
      expectGrounded(box, (x, z) => sampleTerrainHeightfield(b.def.heightfield!, b.def.size, x, z));
    }
  });

  it('resamples height rather than caching stale elevations', () => {
    for (const height of [2, -4]) {
      const b = fixture('cover-cache-height', () => height);
      hardenExposedFlanks(b, { mat: 'sandbag', maxProps: 2 });
      for (const box of coverBoxes(b.def)) expectGrounded(box, () => height);
    }
  });

  it.each(['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[])(
    'keeps %s cover grounded, deterministic and shared with physics after normalization',
    (id) => {
      const first = loadMap(id);
      const second = loadMap(id);
      const boxes = coverBoxes(first.def);
      expect(boxes).toHaveLength({ neocity: 12, oldfront: 30, eden: 36, ashara: 20 }[id]);
      expect(coverBoxes(second.def)).toEqual(boxes);
      const snapshot = boxes.map((box) => ({ ...box }));
      normalizeMapForMatch(first.def);
      expect(coverBoxes(first.def)).toEqual(snapshot);
      const phys = new PhysicsWorld();
      try {
        buildColliders(first.def, phys);
        phys.flush();
        for (const box of boxes) {
          expectGrounded(box, first.terrainHeight);
          const top = box.y + box.sy / 2;
          const hit = phys.raycast(box.x, top + 0.2, box.z, 0, -1, 0, 0.4, GROUPS.rayWorldOnly);
          expect(hit?.point.y).toBeCloseTo(top, 4);
        }
      } finally {
        phys.dispose();
      }
    },
    15_000,
  );
});
