import { describe, expect, it, vi } from 'vitest';
import { CAPSULE_CENTER_OFFSET, feetYFromBodyCenter } from '../../src/sim/movement';
import {
  planStairs,
  STAIR_MAX_RISE,
  STAIR_MIN_TREAD,
  STAIR_MIN_WIDTH,
  isVehiclePlacementClear,
  WorldBuilder,
} from '../../src/world/builder';
import { addBuilding } from '../../src/world/maps/common';
import {
  buildTerrainRibbonIndices,
  sampleTerrainGridMeshHeight,
} from '../../src/world/terrainMesh';
import { buildVista, sampleDesertHighwayHeight, sampleVistaGroundHeight } from '../../src/render/vista';
import { buildWaterlineRibbonPositions, traceWaterline } from '../../src/render/worldView';
import { loadMap, type MapId } from '../../src/world';
import {
  VEHICLE_ASSET_BOUNDS,
  vehicleColliderBox,
  vehicleRenderSpec,
} from '../../src/world/types';

describe('world-space structure contracts', () => {
  it('supports every horizontal Old Front lumber and firewood log at its local terrain', () => {
    const loaded = loadMap('oldfront');
    const logs = loaded.def.geo.filter((geo) => (
      geo.kind === 'cyl'
      && Math.abs(geo.roll ?? 0) > 1
      && (Math.abs(geo.h - 4) < 1e-6 || Math.abs(geo.h - 2.2) < 1e-6)
    ));
    expect(logs).toHaveLength(28);
    for (const log of logs) {
      if (log.kind !== 'cyl') continue;
      const terrain = loaded.terrainHeight(log.x, log.z);
      expect(log.y - log.r, JSON.stringify(log)).toBeGreaterThanOrEqual(terrain - 0.05);
      expect(log.noCollide).toBe(true);
      expect(loaded.def.geo.some((geo) => (
        geo.kind === 'box' && geo.noRender
        && Math.abs(geo.x - log.x) < 1e-6
        && Math.abs(geo.y - log.y) < 1e-6
        && Math.abs(geo.z - log.z) < 1e-6
      )), JSON.stringify(log)).toBe(true);
    }
  });

  it('derives every vehicle collider from the exact rendered GLB envelope', () => {
    for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
      const { def } = loadMap(id);
      for (const vehicle of def.vehicles) {
        const render = vehicleRenderSpec(vehicle.variant, vehicle.x, vehicle.z);
        const bounds = VEHICLE_ASSET_BOUNDS[render.asset]!;
        const collider = vehicleColliderBox(vehicle.variant, vehicle.x, vehicle.z);
        const visualHalfX = (bounds.maxX - bounds.minX) * render.scale / 2;
        const visualHalfZ = (bounds.maxZ - bounds.minZ) * render.scale / 2;
        const visualHeight = (bounds.maxY - bounds.minY) * render.scale;
        expect(vehicle.y + render.yOffset + bounds.minY * render.scale).toBeCloseTo(vehicle.y, 8);
        expect(collider.ex).toBeGreaterThanOrEqual(visualHalfX);
        expect(collider.ez).toBeGreaterThanOrEqual(visualHalfZ);
        expect(collider.h).toBeCloseTo(visualHeight, 4);
      }
    }
  });

  it('rejects scenery intersecting the visible vehicle roof envelope', () => {
    const b = new WorldBuilder('vehicle-envelope', 'Vehicle envelope', 'Vehicle envelope', 100);
    const vehicle = { x: 0, z: 0, y: 0, yaw: 0, variant: 'truck' as const, color: 0xffffff, explodable: true };
    const collider = vehicleColliderBox(vehicle.variant, vehicle.x, vehicle.z);
    // A thin member just below the measured GLB roof was previously hidden by
    // the placement check's 0.1 m vertical inset.
    b.box(0, collider.h - 0.04, 0, 0.5, 0.04, 0.5, 'metalDark');
    expect(isVehiclePlacementClear(b.def, vehicle)).toBe(false);
  });

  it('traces shoreline detail from the terrain-water intersection rather than volume bounds', () => {
    const segments = traceWaterline(
      (x) => x + 0.37,
      { minX: -5, maxX: 5, minZ: -5, maxZ: 5, surfaceY: 0, depth: 4 },
      2.5,
    );
    expect(segments).toHaveLength(4);
    expect(segments.every((segment) => (
      Math.abs(segment.ax + 0.37) < 1e-6
      && Math.abs(segment.bx + 0.37) < 1e-6
      && segment.y === 0
    ))).toBe(true);
    const totalLength = segments.reduce((sum, segment) => (
      sum + Math.hypot(segment.bx - segment.ax, segment.bz - segment.az)
    ), 0);
    expect(totalLength).toBeCloseTo(10, 6);

    const positions = buildWaterlineRibbonPositions([segments[0]!], 1, 0.1);
    const ax = positions[0]!, az = positions[2]!;
    const bx = positions[3]!, bz = positions[5]!;
    const cx = positions[6]!, cz = positions[8]!;
    const abx = bx - ax, abz = bz - az;
    const acx = cx - ax, acz = cz - az;
    const normalY = abz * acx - abx * acz;
    expect(normalY).toBeGreaterThan(0);
  });

  it('renders the playable heightfield on the exact physical triangle lattice', () => {
    for (const id of ['oldfront', 'eden', 'ashara'] satisfies MapId[]) {
      const { def, terrainHeight } = loadMap(id);
      const mesh = def.terrainMesh;
      if (!mesh) throw new Error(`${id} compiled terrain mesh missing`);
      let worst = 0;
      for (let z = -243; z <= 243; z += 7.3) {
        for (let x = -241; x <= 241; x += 6.7) {
          if ((def.terrainCutouts ?? []).some((hole) => (
            x >= hole.minX && x <= hole.maxX && z >= hole.minZ && z <= hole.maxZ
          ))) continue;
          worst = Math.max(worst, Math.abs(sampleTerrainGridMeshHeight(mesh, x, z) - terrainHeight(x, z)));
        }
      }
      expect(worst, `${id} render/heightfield parity`).toBeLessThan(0.002);
    }
  });

  it('builds the rural vista without redundant geometry conversion warnings', () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const vista = buildVista(loadMap('oldfront').def);
    try {
      expect(warnings.mock.calls.flat().join('\n')).not.toContain('toNonIndexed');
    } finally {
      vista.dispose();
      warnings.mockRestore();
    }
  });

  it('keeps boundary-detail ground finite and continuous on every production map', () => {
    for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
      const def = loadMap(id).def;
      const half = def.size / 2;
      for (const [x, z] of [
        [half + 1, 0], [half + 70, 90], [0, half + 1], [-80, half + 120],
      ] as Array<[number, number]>) {
        const ground = sampleVistaGroundHeight(def, x, z);
        const neighbour = sampleVistaGroundHeight(def, x + 0.1, z + 0.1);
        expect(Number.isFinite(ground), `${id} at ${x},${z}`).toBe(true);
        expect(Math.abs(neighbour - ground), `${id} continuity at ${x},${z}`).toBeLessThan(0.5);
        expect(sampleVistaGroundHeight(def, x, z)).toBe(ground);
      }
    }
  });

  it('joins Ashara highway ribbons to authored terrain before blending into the vista', () => {
    const def = loadMap('ashara').def;
    const join = def.size / 2 + 0.2;
    for (const sign of [-1, 1]) {
      const edgeX = sign * join;
      expect(sampleDesertHighwayHeight(def, edgeX, -5))
        .toBeCloseTo(def.terrainHeight!(edgeX, -5), 8);
      const vistaX = sign * (join + 24);
      expect(sampleDesertHighwayHeight(def, vistaX, -5))
        .toBeCloseTo(sampleVistaGroundHeight(def, vistaX, -5), 8);
      let previous = sampleDesertHighwayHeight(def, edgeX, -5);
      for (let metre = 1; metre <= 24; metre++) {
        const x = sign * (join + metre);
        const next = sampleDesertHighwayHeight(def, x, -5);
        expect(Math.abs(next - previous), `highway grade at x=${x}`).toBeLessThan(0.35);
        previous = next;
      }
    }
  });

  it('builds Old Front hay as grounded bale stacks instead of smooth spheres', async () => {
    const { buildOldFront } = await import('../../src/world/maps/oldfront');
    const def = buildOldFront();
    expect(def.geo.filter((geo) => geo.kind === 'sphere' && geo.mat === 'hay')).toHaveLength(0);
    const bales = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.mat === 'hay'
      && Math.abs(geo.sy - 0.72) < 0.001
      && Math.abs(geo.sz - 2.05) < 0.001
    ));
    expect(bales.length).toBeGreaterThanOrEqual(9);
  });

  it('frames the Neo City market approach without narrowing its clear road', () => {
    const def = loadMap('neocity').def;
    const posts = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.mat === 'metalExterior'
      && Math.abs(Math.abs(geo.x - 120) - 9) < 0.01
      && Math.abs(geo.z - 92) < 0.01
      && Math.abs(geo.sx - 0.48) < 0.01
      && Math.abs(geo.sy - 4.3) < 0.01
    ));
    const header = def.geo.find((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'metalExterior'
      && Math.abs(geo.x - 120) < 0.01
      && Math.abs(geo.z - 92) < 0.01
      && Math.abs(geo.sx - 18.5) < 0.01
      && Math.abs(geo.sy - 0.34) < 0.01
    ));
    expect(posts).toHaveLength(2);
    expect(posts.every((post) => post.kind === 'box' && !post.noCollide)).toBe(true);
    expect(header).toBeDefined();
  });

  it('furnishes the Old Front shop with shallow shelves and a suspended light', () => {
    const def = loadMap('oldfront').def;
    const shelves = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'wood'
      && Math.abs(geo.z - 25.28) < 0.01
      && Math.abs(geo.sx - 3.1) < 0.01
      && Math.abs(geo.sy - 0.13) < 0.01
      && Math.abs(geo.sz - 0.34) < 0.01
    ));
    const fixture = def.geo.find((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'windowWarm'
      && Math.abs(geo.x - 108) < 0.01
      && Math.abs(geo.z - 32) < 0.01
      && Math.abs(geo.sx - 3.2) < 0.01
      && Math.abs(geo.sy - 0.09) < 0.01
    ));
    expect(shelves).toHaveLength(3);
    expect(fixture).toBeDefined();
  });

  it('articulates the Eden boathouse facade with eaves and clerestory glazing', () => {
    const def = loadMap('eden').def;
    const eaves = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'metalExterior'
      && geo.x > 89 && geo.x < 103
      && geo.z > 14 && geo.z < 30
      && (
        (Math.abs(geo.sx - 12.7) < 0.01 && Math.abs(geo.sz - 0.3) < 0.01)
        || (Math.abs(geo.sx - 0.3) < 0.01 && Math.abs(geo.sz - 14.2) < 0.01)
      )
    ));
    const clerestory = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'windowCool'
      && Math.abs(geo.z - 14.77) < 0.01
      && Math.abs(geo.sx - 2.45) < 0.01
      && Math.abs(geo.sy - 1.12) < 0.01
    ));
    const serviceHood = def.geo.find((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'metalExterior'
      && Math.abs(geo.x - 102.62) < 0.01
      && Math.abs(geo.z - 21.3) < 0.01
      && Math.abs(geo.sx - 1.28) < 0.01
      && Math.abs(geo.sz - 3.3) < 0.01
    ));
    const clerestoryFrames = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'metalExterior'
      && Math.abs(geo.z - 14.7) < 0.01
      && (
        (Math.abs(geo.sx - 0.1) < 0.01 && Math.abs(geo.sy - 1.34) < 0.01)
        || (Math.abs(geo.sx - 2.66) < 0.01 && Math.abs(geo.sy - 0.1) < 0.01)
      )
    ));
    const downpipe = def.geo.find((geo) => (
      geo.kind === 'cyl'
      && geo.noCollide
      && geo.mat === 'metalDark'
      && Math.abs(geo.x - 101.45) < 0.01
      && Math.abs(geo.z - 14.58) < 0.01
      && Math.abs(geo.r - 0.07) < 0.01
      && Math.abs(geo.h - 4.55) < 0.01
    ));
    expect(eaves).toHaveLength(4);
    expect(clerestory).toHaveLength(3);
    expect(clerestoryFrames).toHaveLength(12);
    expect(downpipe).toBeDefined();
    expect(serviceHood).toBeDefined();
  });

  it('bridges the Ashara Fuel Court tanks with guarded service decks', () => {
    const def = loadMap('ashara').def;
    const decks = def.geo.filter((geo) => (
      geo.kind === 'box'
      && !geo.noCollide
      && geo.mat === 'metalExterior'
      && Math.abs(geo.z - 143) < 0.01
      && Math.abs(geo.sx - 4.15) < 0.01
      && Math.abs(geo.sy - 0.18) < 0.01
      && Math.abs(geo.sz - 1) < 0.01
    ));
    const rails = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'metalDark'
      && Math.abs(Math.abs(geo.z - 143) - 0.5) < 0.01
      && Math.abs(geo.sx - 4.15) < 0.01
      && Math.abs(geo.sy - 0.08) < 0.01
      && Math.abs(geo.sz - 0.08) < 0.01
    ));
    const posts = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'metalDark'
      && Math.abs(Math.abs(geo.z - 143) - 0.5) < 0.01
      && Math.abs(geo.sx - 0.08) < 0.01
      && Math.abs(geo.sy - 0.54) < 0.01
      && Math.abs(geo.sz - 0.08) < 0.01
    ));
    expect(decks).toHaveLength(2);
    expect(rails).toHaveLength(4);
    expect(posts).toHaveLength(12);
  });

  it('articulates Eden dormitory services with supported utility fixtures', async () => {
    const { buildEdenFacility } = await import('../../src/world/maps/eden');
    const def = buildEdenFacility();
    const canopy = def.geo.find((geo) => (
      geo.kind === 'box'
      && Math.abs(geo.x + 122) < 0.01
      && Math.abs(geo.z - 133.05) < 0.01
      && Math.abs(geo.sx - 3.4) < 0.01
      && Math.abs(geo.sy - 0.18) < 0.01
    ));
    const canopyPosts = def.geo.filter((geo) => (
      geo.kind === 'box'
      && Math.abs(geo.z - 133.55) < 0.01
      && Math.abs(geo.sy - 2.55) < 0.01
    ));
    const louvers = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.mat === 'metal'
      && Math.abs(Math.abs(geo.x + 122) - 5.285) < 0.01
      && Math.abs(geo.z - 128) < 0.01
      && Math.abs(geo.sy - 0.1) < 0.01
    ));
    expect(canopy).toBeDefined();
    expect(canopyPosts).toHaveLength(2);
    expect(louvers).toHaveLength(8);
  });

  it('builds Eden greenhouse vines on supported trellises instead of rock lollipops', async () => {
    const { buildEdenFacility } = await import('../../src/world/maps/eden');
    const def = buildEdenFacility();
    const inGreenhouse = (x: number, z: number): boolean => x >= -9 && x <= 35 && z >= 17 && z <= 45;
    const rockCrowns = def.geo.filter((geo) => (
      geo.kind === 'sphere' && geo.mat === 'rock' && inGreenhouse(geo.x, geo.z)
    ));
    const trellisPosts = def.geo.filter((geo) => (
      geo.kind === 'cyl'
      && geo.mat === 'metalDark'
      && Math.abs(geo.r - 0.045) < 0.001
      && Math.abs(geo.h - 2.1) < 0.001
      && inGreenhouse(geo.x, geo.z)
    ));
    const vinePanels = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.mat === 'grass'
      && geo.noCollide === true
      && geo.sz === 0.09
      && inGreenhouse(geo.x, geo.z)
    ));
    expect(rockCrowns).toHaveLength(0);
    expect(trellisPosts).toHaveLength(20);
    expect(vinePanels).toHaveLength(30);
  });

  it('routes a visible grated drain across the Eden research apron', async () => {
    const { buildEdenFacility } = await import('../../src/world/maps/eden');
    const def = buildEdenFacility();
    const drain = def.surfacePaths.find((path) => (
      path.mat === 'metalDark'
      && path.points.length >= 12
      && path.points.every((point) => point.x >= -146 && point.x <= -42)
      && path.points.every((point) => point.z >= 25.5 && point.z <= 27.5)
    ));
    const accessCovers = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.mat === 'metalDark'
      && Math.abs(geo.sx - 1.45) < 0.01
      && Math.abs(geo.sz - 0.78) < 0.01
      && geo.noCollide
    ));
    const wingServiceCabinets = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.mat === 'metalDark'
      && Math.abs(geo.sx - 2.25) < 0.01
      && Math.abs(geo.sy - 1.9) < 0.01
      && geo.noCollide
    ));
    const wingHeaders = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.mat === 'rust'
      && Math.abs(geo.sx - 15.2) < 0.01
      && Math.abs(geo.sy - 0.16) < 0.01
      && geo.noCollide
    ));
    expect(drain).toBeDefined();
    expect(accessCovers).toHaveLength(5);
    expect(wingServiceCabinets).toHaveLength(2);
    expect(wingHeaders).toHaveLength(2);
  });

  it('drains both Ashara highway shoulders through repeated headwalls', async () => {
    const { buildAsharaReach } = await import('../../src/world/maps/desert');
    const def = buildAsharaReach();
    const drains = def.surfacePaths.filter((path) => (
      path.mat === 'rock'
      && path.points.length >= 60
      && path.points.every((point) => Math.abs(point.z + 11.7) < 0.4 || Math.abs(point.z - 1.7) < 0.4)
    ));
    const headwalls = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.mat === 'concreteDark'
      && Math.abs(geo.sx - 1.9) < 0.01
      && Math.abs(geo.sy - 0.52) < 0.01
      && geo.noCollide
    ));
    expect(drains).toHaveLength(2);
    expect(headwalls).toHaveLength(12);
  });

  it('authors a human-scale service threshold on the Neo north boulevard', async () => {
    const { buildNeoCity } = await import('../../src/world/maps/neocity');
    const def = buildNeoCity();
    const rainGardens = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'concreteDark'
      && Math.abs(geo.sx - 4.8) < 0.01
      && Math.abs(geo.sy - 0.72) < 0.01
      && (Math.abs(geo.z + 232) < 0.01 || Math.abs(geo.z + 214) < 0.01)
    ));
    const guideLights = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'signDimCyan'
      && Math.abs(geo.sx - 0.28) < 0.01
      && Math.abs(geo.sy - 0.08) < 0.01
    ));
    expect(rainGardens).toHaveLength(4);
    expect(guideLights.length).toBeGreaterThanOrEqual(4);
  });

  it('articulates the Old Front bridge with four relieving arch rings', async () => {
    const { buildOldFront } = await import('../../src/world/maps/oldfront');
    const def = buildOldFront();
    const archBlocks = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'marble'
      && Math.abs(geo.sx - 0.46) < 0.01
      && Math.abs(geo.sy - 0.34) < 0.01
      && Math.abs(geo.sz - 1.08) < 0.01
      && geo.pitch !== undefined
    ));
    expect(archBlocks).toHaveLength(36);
    expect(archBlocks.every((block) => block.kind === 'box' && Number.isFinite(block.pitch))).toBe(true);
  });

  it('joins Eden wing services with an inspectable maintenance spine', async () => {
    const { buildEdenFacility } = await import('../../src/world/maps/eden');
    const def = buildEdenFacility();
    const spine = def.surfacePaths.find((path) => (
      path.mat === 'concreteDark'
      && path.points.length >= 10
      && path.points.every((point) => point.z > 17 && point.z < 19)
    ));
    const cabinets = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'metalDark'
      && Math.abs(geo.sx - 1.6) < 0.01
      && Math.abs(geo.sy - 1.16) < 0.01
    ));
    expect(spine).toBeDefined();
    expect(cabinets).toHaveLength(5);
    const joints = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'metalDark'
      && Math.abs(geo.sx - 0.055) < 0.001
      && Math.abs(geo.sz - 1.45) < 0.01
    ));
    expect(joints.length).toBeGreaterThanOrEqual(10);
  });

  it('supports a five-module service canopy inside Ashara Fuel Court', async () => {
    const { buildAsharaReach } = await import('../../src/world/maps/desert');
    const def = buildAsharaReach();
    const modules = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'windowCool'
      && Math.abs(geo.sx - 4.4) < 0.01
      && Math.abs(geo.sy - 0.12) < 0.01
      && Math.abs(geo.z - 164) < 0.01
    ));
    const cabinets = def.geo.filter((geo) => (
      geo.kind === 'box'
      && geo.noCollide
      && geo.mat === 'metalDark'
      && Math.abs(geo.sx - 1.65) < 0.01
      && Math.abs(geo.sy - 2.1) < 0.01
    ));
    const tankFootings = def.geo.filter((geo) => (
      geo.kind === 'cyl'
      && !geo.noCollide
      && geo.mat === 'concreteDark'
      && Math.abs(geo.r - 3.95) < 0.01
      && geo.x >= 173 && geo.x <= 195
      && geo.z >= 143 && geo.z <= 157
    ));
    const tankBands = def.geo.filter((geo) => (
      geo.kind === 'cyl'
      && geo.noCollide
      && geo.mat === 'metalExterior'
      && Math.abs(geo.r - 3.64) < 0.01
      && Math.abs(geo.h - 0.12) < 0.01
    ));
    expect(modules).toHaveLength(5);
    expect(modules.every((module) => module.kind === 'box' && module.pitch === -0.11)).toBe(true);
    expect(cabinets).toHaveLength(2);
    expect(tankFootings).toHaveLength(5);
    expect(tankBands).toHaveLength(10);
  });

  it('winds terrain ribbons upward so roads render from gameplay cameras', () => {
    const indices = [...buildTerrainRibbonIndices(1)];
    expect(indices).toEqual([0, 1, 2, 2, 1, 3]);
    // Right/left vertices at z=0 followed by right/left at z=1. The first
    // triangle's cross product must point upward, not into the terrain.
    const positions = [
      [1, 0, 0], [-1, 0, 0], [1, 0, 1], [-1, 0, 1],
    ];
    const a = positions[indices[0]!]!;
    const b = positions[indices[1]!]!;
    const c = positions[indices[2]!]!;
    const crossY = (b[2]! - a[2]!) * (c[0]! - a[0]!)
      - (b[0]! - a[0]!) * (c[2]! - a[2]!);
    expect(crossY).toBeGreaterThan(0);
  });

  it('keeps the Old Front crossroads terrain-following instead of stacking flat dirt slabs', async () => {
    const { buildOldFront } = await import('../../src/world/maps/oldfront');
    const def = buildOldFront();
    const nearCrossroads = (x: number, z: number) => Math.hypot(x - 30, z - 80) < 24;
    const flatDirtSlabs = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'dirt'
      && nearCrossroads(g.x, g.z)
      && g.sx > 5
      && g.sz > 5
    ));
    const crossingPaths = def.surfacePaths.filter((path) => (
      path.mat === 'dirt'
      && path.points.some((point) => Math.hypot(point.x - 30, point.z - 80) < 0.1)
    ));
    expect(flatDirtSlabs).toHaveLength(0);
    expect(crossingPaths).toHaveLength(2);
  });

  it('gives the Eden research lab dedicated non-foundation floor surfaces', async () => {
    const { buildEdenFacility } = await import('../../src/world/maps/eden');
    const def = buildEdenFacility();
    const labFloors = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'facilityFloor'
      && Math.abs(g.x + 95) < 17
      && Math.abs(g.z + 30) < 12
    ));
    expect(labFloors.length).toBeGreaterThanOrEqual(2);
    expect(labFloors.some((floor) => floor.kind === 'box' && floor.sy <= 0.05)).toBe(true);
    expect(labFloors.some((floor) => floor.kind === 'box' && floor.y > 3)).toBe(true);
  });

  it('authors visible services and work surfaces inside the Eden research lab', async () => {
    const { buildEdenFacility } = await import('../../src/world/maps/eden');
    const def = buildEdenFacility();
    const ceilingFixtures = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'signDimCyan'
      && Math.abs(g.x + 95) < 0.1
      && Math.abs(g.z + 30) < 8
    ));
    const benches = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'metal'
      && Math.abs(g.sx - 5.2) < 0.01
      && Math.abs(g.sy - 0.16) < 0.01
      && Math.abs(g.z + 30) < 0.1
    ));
    const labLights = def.lights.filter((light) => (
      Math.abs(light.x + 95) < 0.1 && Math.abs(light.z + 30) <= 6.5
    ));
    const instrumentScreens = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'signDimCyan'
      && Math.abs(g.sy - 0.5) < 0.01
      && Math.abs(g.sz - 0.035) < 0.01
      && Math.abs(g.z + 29.825) < 0.01
    ));
    expect(ceilingFixtures).toHaveLength(6);
    expect(benches).toHaveLength(2);
    expect(labLights.length).toBeGreaterThanOrEqual(6);
    expect(instrumentScreens).toHaveLength(4);
  });

  it('carries the Old Front stone bridge on paired masonry bents', async () => {
    const { buildOldFront } = await import('../../src/world/maps/oldfront');
    const def = buildOldFront();
    const piers = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'stoneBrick'
      && Math.abs(g.sx - 1.1) < 0.01
      && Math.abs(g.sz - 1.55) < 0.01
      && Math.abs(g.z - 120) <= 8.5
    ));
    const caps = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'stoneBrick'
      && Math.abs(g.sx - 8.4) < 0.01
      && Math.abs(g.sy - 0.44) < 0.01
      && Math.abs(g.z - 120) <= 8.5
    ));
    const sidePilasters = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'stoneBrick'
      && g.noCollide
      && Math.abs(g.sx - 0.38) < 0.01
      && Math.abs(g.sz - 1.8) < 0.01
    ));
    expect(piers).toHaveLength(6);
    expect(caps).toHaveLength(3);
    expect(piers.every((pier) => pier.kind === 'box' && pier.sy > 0.4)).toBe(true);
    expect(sidePilasters).toHaveLength(6);
    const deckBottom = caps[0]?.kind === 'box' ? caps[0].y + caps[0].sy / 2 : NaN;
    expect(sidePilasters.every((pilaster) => (
      pilaster.kind === 'box' && Math.abs(pilaster.y + pilaster.sy / 2 - deckBottom) < 1e-6
    ))).toBe(true);
  });

  it('supports the Old Front checkpoint stair flight on grounded trestles', async () => {
    const { buildOldFront } = await import('../../src/world/maps/oldfront');
    const def = buildOldFront();
    const stairTrestlePosts = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'woodDark'
      && g.noCollide
      && Math.abs(g.x + 184) < 1.2
      && g.z > 50 && g.z < 77
      && Math.abs(g.sx - 0.22) < 0.01
      && Math.abs(g.sz - 0.22) < 0.01
    ));
    const stairTrestleCaps = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'woodDark'
      && g.noCollide
      && Math.abs(g.x + 184) < 0.1
      && g.z > 50 && g.z < 77
      && g.sx > 1.6
      && Math.abs(g.sy - 0.18) < 0.01
    ));
    expect(stairTrestlePosts).toHaveLength(4);
    expect(stairTrestleCaps).toHaveLength(2);
    expect(stairTrestlePosts.every((post) => post.kind === 'box' && post.sy >= 0.4)).toBe(true);
    const handrails = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'woodDark'
      && g.noCollide
      && Math.abs(g.x + 184) < 1.2
      && Math.abs(g.sx - 0.1) < 0.01
      && Math.abs(g.sy - 0.1) < 0.01
      && g.sz > 20
      && g.pitch !== undefined
    ));
    const handrailPosts = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'woodDark'
      && g.noCollide
      && Math.abs(g.x + 184) < 1.2
      && Math.abs(g.sx - 0.11) < 0.01
      && Math.abs(g.sy - 0.94) < 0.01
      && g.z > 50 && g.z < 80
    ));
    expect(handrails).toHaveLength(4);
    expect(handrailPosts).toHaveLength(14);
  });

  it('supports and guards the exposed Eden Watch Rock stair flight', async () => {
    const { buildEdenFacility } = await import('../../src/world/maps/eden');
    const def = buildEdenFacility();
    const soffits = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'rock'
      && g.noCollide
      && g.pitch !== undefined
      && g.x > 62 && g.x < 80
      && Math.abs(g.z + 60) < 0.1
      && g.sz > 4
    ));
    const handrails = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'metalDark'
      && g.noCollide
      && g.pitch !== undefined
      && g.x > 62 && g.x < 80
      && Math.abs(Math.abs(g.z + 60) - 1.14) < 0.01
      && Math.abs(g.sx - 0.1) < 0.01
      && Math.abs(g.sy - 0.1) < 0.01
      && g.sz > 4
    ));
    const handrailPosts = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'metalDark'
      && g.noCollide
      && g.x > 62 && g.x < 80
      && Math.abs(Math.abs(g.z + 60) - 1.14) < 0.01
      && Math.abs(g.sx - 0.1) < 0.01
      && Math.abs(g.sy - 0.9) < 0.01
      && Math.abs(g.sz - 0.1) < 0.01
    ));
    expect(soffits).toHaveLength(1);
    expect(handrails).toHaveLength(4);
    expect(handrailPosts).toHaveLength(12);
  });

  it('guards the Neo City parking stairwell without narrowing its collider lane', async () => {
    const { buildNeoCity } = await import('../../src/world/maps/neocity');
    const def = buildNeoCity();
    const handrails = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'metalDark'
      && g.noCollide
      && g.pitch !== undefined
      && Math.abs(Math.abs(g.x - 40) - 1.54) < 0.01
      && g.z > 156 && g.z < 167
      && Math.abs(g.sx - 0.1) < 0.01
      && Math.abs(g.sy - 0.1) < 0.01
      && g.sz > 6
    ));
    const handrailPosts = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'metalDark'
      && g.noCollide
      && Math.abs(Math.abs(g.x - 40) - 1.54) < 0.01
      && g.z > 156 && g.z < 167
      && Math.abs(g.sx - 0.1) < 0.01
      && Math.abs(g.sy - 0.9) < 0.01
      && Math.abs(g.sz - 0.1) < 0.01
    ));
    expect(handrails).toHaveLength(4);
    expect(handrailPosts).toHaveLength(10);
  });

  it('marks Ashara Sunwall Market with a grounded service gateway', async () => {
    const { buildAsharaReach } = await import('../../src/world/maps/desert');
    const def = buildAsharaReach();
    const sign = def.geo.find((g) => (
      g.kind === 'box'
      && g.mat === 'rust'
      && Math.abs(g.x + 47) < 0.1
      && Math.abs(g.z + 57.4) < 0.1
      && Math.abs(g.sx - 2.7) < 0.01
    ));
    const marketTanks = def.geo.filter((g) => (
      g.kind === 'cyl'
      && g.mat === 'metal'
      && g.x > -70 && g.x < 5
      && g.z > -65 && g.z < 15
      && g.r > 0.8
    ));
    const blockedGatewayCrates = def.destructibles.filter((item) => (
      item.type === 'crate'
      && Math.abs(item.geo.x + 47) < 3.2
      && item.geo.z > -59
      && item.geo.z < -35
    ));
    expect(sign).toBeDefined();
    expect(sign?.noCollide).toBe(true);
    expect(marketTanks.length).toBeGreaterThanOrEqual(3);
    expect(blockedGatewayCrates).toHaveLength(0);
  });

  it('seats and structurally articulates the Ashara relay mast', async () => {
    const { buildAsharaReach } = await import('../../src/world/maps/desert');
    const def = buildAsharaReach();
    const retainingCourses = def.geo.filter((g) => (
      g.kind === 'box'
      && g.noCollide
      && Math.abs(g.x - 154) < 0.01
      && Math.abs(g.z + 154) < 0.01
      && (Math.abs(g.sx - 25) < 0.01 || Math.abs(g.sx - 28) < 0.01)
    ));
    const mastLegs = def.geo.filter((g) => (
      g.kind === 'box'
      && g.noCollide
      && Math.abs(Math.abs(g.x - 154) - 1.15) < 0.01
      && Math.abs(Math.abs(g.z + 154) - 1.15) < 0.01
      && Math.abs(g.sx - 0.22) < 0.01
      && Math.abs(g.sy - 14.8) < 0.01
    ));
    const entryCanopy = def.geo.find((g) => (
      g.kind === 'box'
      && g.noCollide
      && Math.abs(g.x - 153.3) < 0.01
      && Math.abs(g.z + 142.55) < 0.01
      && Math.abs(g.sx - 5.8) < 0.01
    ));
    expect(retainingCourses).toHaveLength(2);
    expect(mastLegs).toHaveLength(4);
    expect(entryCanopy).toBeDefined();
  });

  it('frames the Ashara fuel-court entrance without narrowing its clear gate', async () => {
    const { buildAsharaReach } = await import('../../src/world/maps/desert');
    const def = buildAsharaReach();
    const gatePylons = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'concreteDark'
      && Math.abs(g.z - 131.75) < 0.01
      && Math.abs(Math.abs(g.x - 184) - 5.2) < 0.01
      && Math.abs(g.sx - 1.15) < 0.01
    ));
    const gateCanopy = def.geo.find((g) => (
      g.kind === 'box'
      && g.noCollide
      && Math.abs(g.x - 184) < 0.01
      && Math.abs(g.z - 131.8) < 0.01
      && Math.abs(g.sx - 12.2) < 0.01
    ));
    const transferPipes = def.geo.filter((g) => (
      g.kind === 'box'
      && g.noCollide
      && g.mat === 'rust'
      && Math.abs(g.z - 131.35) < 0.01
      && Math.abs(g.sx - 10.5) < 0.01
    ));
    const approach = def.surfacePaths.find((path) => (
      path.mat === 'asphaltDesert'
      && path.points.length === 2
      && Math.abs(path.points[0]!.x - 184) < 0.01
      && Math.abs(path.points[0]!.z - 104) < 0.01
      && Math.abs(path.points[0]!.width - 13) < 0.01
      && Math.abs(path.points[1]!.z - 130.8) < 0.01
    ));
    const approachLamps = def.lamps.filter((lamp) => (
      Math.abs(lamp.z - 119) < 0.01
      && Math.abs(Math.abs(lamp.x - 184) - 8.4) < 0.01
      && Math.abs(lamp.h - 7.2) < 0.01
    ));
    const statusPylon = def.geo.find((g) => (
      g.kind === 'box'
      && g.mat === 'metalDark'
      && g.noCollide
      && Math.abs(g.x - 194.2) < 0.01
      && Math.abs(g.z - 120.5) < 0.01
      && Math.abs(g.sx - 3.1) < 0.01
      && Math.abs(g.sy - 2.15) < 0.01
    ));
    const pylonInnerEdges = gatePylons
      .map((pylon) => pylon.kind === 'box' ? Math.abs(pylon.x - 184) - pylon.sx / 2 : 0);
    expect(gatePylons).toHaveLength(2);
    expect(Math.min(...pylonInnerEdges) * 2).toBeGreaterThan(4);
    expect(gateCanopy).toBeDefined();
    expect(transferPipes).toHaveLength(2);
    expect(approach).toBeDefined();
    expect(approachLamps).toHaveLength(2);
    expect(statusPylon).toBeDefined();
  });

  it('lights and services the full Eden atrium circulation spine', async () => {
    const { buildEdenFacility } = await import('../../src/world/maps/eden');
    const def = buildEdenFacility();
    const atriumLights = def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'signDimCyan'
      && Math.abs(g.x + 92) < 0.01
      && Math.abs(g.sx - 2.8) < 0.01
      && Math.abs(g.sy - 0.08) < 0.01
      && g.z >= -2.5 && g.z <= 18.5
    ));
    const floorGuide = def.geo.filter((g) => (
      g.kind === 'box'
      && g.noCollide
      && g.mat === 'paint'
      && Math.abs(g.x + 92) < 0.01
      && g.z >= -2.5 && g.z <= 18.5
      && Math.abs(g.sz - 1.45) < 0.01
    ));
    expect(atriumLights).toHaveLength(6);
    expect(floorGuide).toHaveLength(8);
  });

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
    const stairZ = -16 / 2 + 1.55 + stair.run / 2;
    const upperFloor = b.def.geo.filter((g) => (
      g.kind === 'box'
      && Math.abs(g.sy - 0.35) < 0.001
      && Math.abs(g.y + g.sy / 2 - (baseY + floorHeight + 0.18)) < 0.001
    ));
    expect(upperFloor.length).toBeGreaterThan(1);
    expect(upperFloor.some((g) => g.kind === 'box'
      && Math.abs(stairX - g.x) < g.sx / 2
      && Math.abs(stairZ - g.z) < g.sz / 2)).toBe(false);

    const ceilingFinish = b.def.geo.find((g) => (
      g.kind === 'box'
      && g.noCollide
      && g.mat === 'interiorCeiling'
      && Math.abs(g.sx - 19.5) < 0.01
      && Math.abs(g.sz - 15.5) < 0.01
      && Math.abs(g.sy - 0.04) < 0.001
      && Math.abs(g.y - (baseY + 2 * floorHeight + 0.2 - 0.38)) < 0.001
    ));
    const ceilingBeams = b.def.geo.filter((g) => (
      g.kind === 'box'
      && g.noCollide
      && Math.abs(g.sx - 19.35) < 0.01
      && Math.abs(g.sy - 0.12) < 0.001
      && Math.abs(g.sz - 0.14) < 0.001
      && Math.abs(g.y - (baseY + 2 * floorHeight + 0.2 - 0.47)) < 0.001
    ));
    const intermediateCeiling = b.def.geo.filter((g) => (
      g.kind === 'box'
      && g.noCollide
      && g.mat === 'interiorCeiling'
      && Math.abs(g.y - (baseY + floorHeight - 0.2)) < 0.001
      && Math.abs(g.sy - 0.04) < 0.001
    ));
    expect(ceilingFinish).toBeDefined();
    expect(ceilingBeams.length).toBeGreaterThanOrEqual(2);
    expect(intermediateCeiling.length).toBeGreaterThan(1);
    expect(intermediateCeiling.some((g) => g.kind === 'box'
      && Math.abs(stairX - g.x) < g.sx / 2
      && Math.abs(stairZ - g.z) < g.sz / 2)).toBe(false);
  });

  it('spans doorway navigation anchors across the clear opening', () => {
    const { def } = loadMap('neocity');
    // Spire front door centre is (-1.8, -41). Its three tiny doorway anchor
    // platforms must cover the lateral X opening instead of marching through
    // the wall normal along Z.
    const anchors = def.platforms.filter((platform) => {
      const cx = (platform.minX + platform.maxX) / 2;
      const cz = (platform.minZ + platform.maxZ) / 2;
      return Math.abs(platform.y - 0.08) < 0.001
        && Math.abs(cz + 41) < 0.1
        && Math.abs(cx + 1.8) < 1;
    });
    expect(anchors).toHaveLength(3);
    const xs = anchors.map((platform) => (platform.minX + platform.maxX) / 2);
    const zs = anchors.map((platform) => (platform.minZ + platform.maxZ) / 2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1.5, 6);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.01);
  });

  it('does not project Neo City road paint through building foundations', () => {
    const { def } = loadMap('neocity');
    const foundations = def.geo.filter((geo) => (
      geo.kind === 'box'
      && Math.abs(geo.sy - 2.2) < 1e-6
      && geo.sx > 5
      && geo.sz > 5
    ));
    const roadPaint = def.geo.filter((geo) => geo.kind === 'box' && geo.mat === 'paint');
    expect(foundations.length).toBeGreaterThan(20);
    expect(roadPaint.length).toBeGreaterThan(500);
    for (const paint of roadPaint) {
      if (paint.kind !== 'box') continue;
      for (const foundation of foundations) {
        if (foundation.kind !== 'box') continue;
        const overlapsFootprint = Math.abs(paint.x - foundation.x) < (paint.sx + foundation.sx) / 2
          && Math.abs(paint.z - foundation.z) < (paint.sz + foundation.sz) / 2;
        const protrudesAboveFloor = paint.y + paint.sy / 2 > foundation.y + foundation.sy / 2 + 1e-4;
        expect(overlapsFootprint && protrudesAboveFloor, JSON.stringify({ paint, foundation })).toBe(false);
      }
    }
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
    const boxes = b.def.geo.filter((g) => g.kind === 'box' && !g.noCollide);
    const supports = b.def.geo.filter((g) => g.kind === 'box' && g.noCollide && g.pitch !== undefined);
    expect(boxes).toHaveLength(down.steps);
    expect(supports).toHaveLength(1);
    expect(supports[0]).toEqual(expect.objectContaining({
      sx: down.width - 0.08,
      sy: 0.14,
      sz: Math.hypot(down.run, down.totalRise),
    }));
    expect(supports[0]?.kind === 'box' ? supports[0].pitch : undefined)
      .toBeCloseTo(-Math.atan2(down.totalRise, down.run), 8);
    expect(down.stepH).toBeGreaterThanOrEqual(-STAIR_MAX_RISE);
    expect(down.totalRise).toBeCloseTo(-4.8, 8);
    expect(boxes.every((g) => g.kind === 'box' && g.sy > 0)).toBe(true);
    expect(boxes.some((g) => g.kind === 'box'
      && Math.abs(g.y + g.sy / 2 - (4 + down.totalRise)) < 1e-8)).toBe(true);
    expect(Math.max(...b.def.platforms.map((p) => p.y))).toBeCloseTo(4, 8);
    expect(Math.min(...b.def.platforms.map((p) => p.y))).toBeCloseTo(-0.8, 8);

    const metal = new WorldBuilder('metal-stairs', 'Metal stairs', 'Metal stairs', 100);
    metal.stairs(0, 0, 0, 1, 8, 0.3, 0.8, 2.2, 'metalExterior');
    const stringers = metal.def.geo.filter((g) => g.kind === 'box' && g.noCollide && g.pitch !== undefined);
    expect(stringers).toHaveLength(2);
  });

  it('registers a rotated floor on the same world-space footprint as its collider', () => {
    const b = new WorldBuilder('rotated-floor', 'Rotated floor', 'Rotated floor', 100);
    b.box(4, 0.2, 7, 18.4, 0.4, 7, 'concreteDark', Math.PI / 2, { floor: true });
    expect(b.def.platforms).toHaveLength(1);
    const platform = b.def.platforms[0]!;
    expect(platform.minX).toBeCloseTo(0.5, 8);
    expect(platform.maxX).toBeCloseTo(7.5, 8);
    expect(platform.minZ).toBeCloseTo(-2.2, 8);
    expect(platform.maxZ).toBeCloseTo(16.2, 8);
    expect(platform.y).toBeCloseTo(0.4, 8);
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

  it('aligns exterior fire-escape rails with every flight and switchback', () => {
    const b = new WorldBuilder('fire-escape', 'Fire Escape', 'Fire Escape', 100);
    addBuilding(b, {
      x: 0, z: 0, baseY: 0, w: 16, d: 12, floors: 4, floorHeight: 3.6,
      wallMat: 'concrete', roofAccess: true, interiorDividers: false, windows: false,
    });

    const visualRails = b.def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'metalExterior'
      && g.noCollide
      && (g.sx < 0.1 || g.sy < 0.1)
    ));
    const railPosts = visualRails.filter((g) => g.kind === 'box' && g.sx < 0.1 && g.sz < 0.1);
    const landingRails = visualRails.filter((g) => g.kind === 'box' && g.sy < 0.1 && g.sz < 0.1 && g.sx > 1);
    const flightHandrails = visualRails.filter((g) => (
      g.kind === 'box'
      && g.sx < 0.1
      && g.sy < 0.1
      && g.sz > 2
      && Math.abs(g.pitch ?? 0) > 0.05
    ));
    const structuralPosts = b.def.geo.filter((g) => (
      g.kind === 'box'
      && g.mat === 'metalExterior'
      && g.noCollide
      && g.sx <= 0.14
      && g.sz <= 0.14
      && g.sy > 1.5
    ));
    expect(railPosts.length).toBeGreaterThan(8);
    expect(landingRails.length).toBeGreaterThan(1);
    expect(flightHandrails.length).toBeGreaterThan(1);
    expect(structuralPosts.length).toBeGreaterThan(1);
    expect(structuralPosts.every((post) => (
      post.kind === 'box' && post.y - post.sy / 2 <= -1.59
    ))).toBe(true);

    const landingDirections = landingRails.map((rail) => Math.sign(rail.z)).filter((sign) => sign !== 0);
    expect(new Set(landingDirections)).toEqual(new Set([-1, 1]));
    expect(visualRails.every((rail) => rail.noCollide === true)).toBe(true);
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
