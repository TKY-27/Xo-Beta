/**
 * EDEN FACILITY — overgrown nature reclaiming a research site, bright day.
 * Lake + river swimming routes, research complex, dormitories, water
 * treatment with underground level, cliffs, greenhouses, docks.
 */

import { WorldBuilder } from '../builder';
import type { MapDef } from '../types';
import { Rng } from '../../core/rng';
import { addBuilding, scatterRocks, scatterTrees } from './common';

const S = 500;

function terrainH(x: number, z: number): number {
  let h = Math.sin(x * 0.018) * 0.4 + Math.cos(z * 0.02) * 0.35;
  // Lake basin (water volume handles the surface; bed sits below)
  const ld = Math.hypot(x - 140, z - 60);
  if (ld < 85) {
    h -= (1 - ld / 85) * 6;
  }
  const pondD = Math.hypot(x + 220, z + 205);
  if (pondD < 40) {
    h -= (1 - pondD / 40) * 4;
  }
  return h;
}

export function buildEdenFacility(): MapDef {
  const rng = new Rng(0x3d3e + 11);
  const b = new WorldBuilder('eden', 'EDEN FACILITY', 'A lakeside research station swallowed by green. Daylight, water, and long sightlines.', S);

  b.box(0, -1, 0, S + 200, 2, S + 200, 'grass', 0, { noCollide: true });
  buildHeightfield(b);

  // Water: lake + river to the south
  b.water(70, 215, -15, 135, -4.2, 6);          // lake basin
  b.water(150, 190, 135, 165, -4.0, 5);         // river mouth heading south-east... simplified channel
  b.water(-260, -180, 180, 230, -3.8, 4);       // small pond SW

  // ------------------------------------------------------------------
  // POI: RESEARCH COMPLEX (main labs, west plateau)
  // ------------------------------------------------------------------
  b.poi('Research Complex', -90, -20, 65);
  labMain(b, -95, -30);
  labWing(b, -130, 5, 1);
  labWing(b, -55, 12, 3);
  atriumLink(b, -92, 8);
  helipad(b, -60, -55);
  b.chest(-88, terrainH(-88, -22) + 0.3, -22, 'vault');
  b.chest(-118, terrainH(-118, 2) + 7.6, 2, 'elite');
  b.chest(-58, terrainH(-58, 16) + 0.3, 16, 'standard');
  b.vehicle(-75, -50, terrainH(-75, -50) + 0.2, 0.5, 'van', 0xdde3e8);

  // ------------------------------------------------------------------
  // POI: DORMITORIES (south of complex)
  // ------------------------------------------------------------------
  b.poi('Dormitories', -110, 105, 45);
  dormitory(b, -125, 95);
  dormitory(b, -92, 112);
  serviceHouse(b, -122, 128);
  courtyardGreen(b, rng, -108, 108);
  b.chest(-100, terrainH(-100, 106) + 0.3, 106, 'standard');
  b.chest(-126, terrainH(-126, 97) + 7.6, 97, 'elite');

  // ------------------------------------------------------------------
  // POI: WATER TREATMENT (underground facility, north-west)
  // ------------------------------------------------------------------
  b.poi('Water Treatment', -170, -120, 45);
  treatmentPlant(b, -170, -120);
  b.chest(-162, terrainH(-162, -112) + 0.3, -112, 'elite');
  b.chest(-176, -9.7, -124, 'vault');

  // ------------------------------------------------------------------
  // POI: LAKESIDE DOCK (east shore)
  // ------------------------------------------------------------------
  b.poi('Lakeside Dock', 120, 40, 40);
  dock(b, rng, 118, 42);
  boathouse(b, 96, 22);
  b.chest(116, terrainH(116, 44) + 0.3, 44, 'standard');
  b.chest(98, terrainH(98, 24) + 0.3, 24, 'vault');
  b.loot(126, terrainH(126, 52) + 0.4, 52);

  // ------------------------------------------------------------------
  // POI: CLIFF OVERLOOK (north heights)
  // ------------------------------------------------------------------
  b.poi('Cliff Overlook', 10, -195, 45);
  overlookPlatform(b, 10, -200);
  antennaArray(b, rng, -18, -185);
  b.chest(14, terrainH(14, -198) + 0.3, -198, 'elite');
  b.loot(-14, terrainH(-14, -182) + 0.4, -182);

  // ------------------------------------------------------------------
  // POI: GREENHOUSES (between complex and lake)
  // ------------------------------------------------------------------
  b.poi('Greenhouses', 10, 30, 40);
  greenhouse(b, -4, 22);
  greenhouse(b, 28, 38);
  planterRows(b, rng, 12, 56);
  b.chest(12, terrainH(12, 34) + 0.3, 34, 'standard');
  b.loot(-2, terrainH(-2, 26) + 0.4, 26);

  // ------------------------------------------------------------------
  // Small POIs
  // ------------------------------------------------------------------
  b.poi('Generator Yard', -210, 40, 26);
  generatorYard(b, -210, 40);
  b.poi('Test Field', -30, -120, 32);
  testField(b, rng, -30, -120);
  b.poi('Ranger Cabin', 60, 175, 20);
  cabin(b, 60, 175);
  b.poi('South Ford', 160, 150, 26);
  ford(b, 160, 150);
  b.poi('Boulder Field', 200, -80, 30);
  scatterRocks(b, rng, 16, { minX: 170, maxX: 235, minZ: -110, maxZ: -50 }, [], terrainH);
  b.chest(202, terrainH(202, -78) + 0.3, -78, 'standard');
  b.poi('East Meadow', 225, 100, 28);
  meadowCamp(b, rng, 225, 100);
  b.poi('Pump House', -240, -60, 20);
  pumpHouse(b, -240, -60);
  b.poi('Watch Rock', 60, -60, 18);
  watchRock(b, 60, -60);

  // Vegetation — dense pines across map
  scatterTrees(b, rng, 110, { minX: -245, maxX: 245, minZ: -245, maxZ: 245 }, 'pine',
    [
      { x: -90, z: -20, r: 62 }, { x: -110, z: 105, r: 42 }, { x: -170, z: -120, r: 42 },
      { x: 120, z: 40, r: 36 }, { x: 10, z: -195, r: 40 }, { x: 10, z: 30, r: 34 },
      { x: 140, z: 60, r: 90 }, { x: -210, z: 40, r: 24 }, { x: 60, z: 175, r: 18 },
    ],
    terrainH);
  scatterTrees(b, rng, 25, { minX: -100, maxX: 245, minZ: 120, maxZ: 245 }, 'oak',
    [{ x: 160, z: 150, r: 24 }], terrainH);
  scatterRocks(b, rng, 30, { minX: -245, maxX: 245, minZ: -245, maxZ: 245 },
    [{ x: -90, z: -20, r: 60 }, { x: 120, z: 40, r: 40 }, { x: 10, z: 30, r: 30 }], terrainH);

  return b.finish(
    {
      preset: 'day',
      fogColor: 0xbfd6e4,
      fogDensity: 0.0016,
      sunDirection: [0.45, -0.8, 0.35],
      sunColor: 0xfff2dd,
      sunIntensity: 3.4,
      ambientColor: 0xb6ccd8,
      ambientIntensity: 1.55,
      hemisphereSky: 0xa8d4f0,
      hemisphereGround: 0x55663f,
      hemisphereIntensity: 1.45,
    },
    { from: [-330, -140], to: [330, 130] },
  );
}

// ---------------------------------------------------------------------------
// Terrain heightfield registration
// ---------------------------------------------------------------------------

function buildHeightfield(b: WorldBuilder): void {
  const n = 64;
  const heights = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c / (n - 1)) * S - S / 2;
      const z = (r / (n - 1)) * S - S / 2;
      heights[r * n + c] = terrainH(x, z);
    }
  }
  (b.def as MapDef & { heightfield?: unknown }).heightfield = { n, heights };
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

function labMain(b: WorldBuilder, cx: number, cz: number): void {
  addBuilding(b, {
    x: cx, z: cz, w: 34, d: 24, floors: 2, floorHeight: 4.2, wallMat: 'facadeA', trimMat: 'metal',
    doors: [[0, 10, 2.8], [0, 24, 2.8], [2, 17, 2.8], [1, 9, 2.8]], roofAccess: true,
  });
  const gy = terrainH(cx, cz);
  // Rooftop units
  b.box(cx + 8, gy + 9.4, cz - 4, 4, 1.6, 3, 'metalDark');
  b.loot(cx - 8, gy + 0.4, cz + 4);
  b.loot(cx + 6, gy + 0.4, cz - 6);
}

function labWing(b: WorldBuilder, cx: number, cz: number, doorSide: 0 | 1 | 2 | 3): void {
  addBuilding(b, {
    x: cx, z: cz, w: 20, d: 15, floors: 2, floorHeight: 4, wallMat: 'facadeC', trimMat: 'metalDark',
    doors: [[doorSide, 8, 2.4]],
  });
  const gy = terrainH(cx, cz);
  b.loot(cx + 3, gy + 0.4, cz + 2);
}

function atriumLink(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  // Glass corridor
  b.slab(cx, gy + 0.2, cz, 10, 26, 0.35, 'concreteDark');
  b.glassPane(cx - 5, gy + 2.4, cz, 26, 4.4, 'z');
  b.glassPane(cx + 5, gy + 2.4, cz, 26, 4.4, 'z');
  b.slab(cx, gy + 4.8, cz, 10.6, 26.6, 0.4, 'metalDark');
  b.platform(cx - 5, cx + 5, cz - 13, cz + 13, gy + 0.4);
  b.light(cx, gy + 4, cz, 0xcfe8ff, 1.4, 20);
}

function helipad(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  b.cyl(cx, gy + 0.15, cz, 8, 0.3, 'concreteDark');
  b.platform(cx - 8, cx + 8, cz - 8, cz + 8, gy + 0.3);
  b.box(cx, gy + 0.32, cz, 5, 0.06, 0.7, 'neonOrange', 0, { noCollide: true });
  b.chest(cx + 10, gy + 0.3, cz + 6, 'standard');
}

function dormitory(b: WorldBuilder, cx: number, cz: number): void {
  addBuilding(b, {
    x: cx, z: cz, w: 22, d: 14, floors: 2, floorHeight: 3.6, wallMat: 'plaster', trimMat: 'woodDark', roofMat: 'roofTile',
    doors: [[0, 8, 2.2], [2, 8, 2.2]],
  });
  const gy = terrainH(cx, cz);
  b.loot(cx - 4, gy + 0.4, cz + 2);
}

function serviceHouse(b: WorldBuilder, cx: number, cz: number): void {
  addBuilding(b, {
    x: cx, z: cz, w: 10, d: 9, floors: 1, wallMat: 'woodDark', doors: [[0, 4, 1.8]],
    interiorDividers: false, windows: false,
  });
  const gy = terrainH(cx, cz);
  b.loot(cx + 1, gy + 0.4, cz + 1);
}

function courtyardGreen(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.5;
    b.tree({ x: cx + Math.cos(a) * 10, z: cz + Math.sin(a) * 10, y: terrainH(cx + Math.cos(a) * 10, cz + Math.sin(a) * 10), scale: rng.range(0.9, 1.3), variant: 'oak' });
  }
  b.cyl(cx, gy + 0.5, cz, 3, 1, 'concrete');
  b.crate(cx + 4, gy + 0.2, cz - 4, 1);
  b.loot(cx - 3, gy + 0.4, cz + 3);
}

function treatmentPlant(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  // Ground building
  addBuilding(b, {
    x: cx, z: cz, w: 24, d: 18, floors: 1, floorHeight: 5, wallMat: 'facadeB', trimMat: 'metalDark',
    doors: [[0, 9, 2.8], [2, 9, 2.8]], interiorDividers: false,
  });
  // Clarifier tanks outside
  b.cyl(cx + 18, gy + 2.5, cz + 8, 5, 5, 'concrete');
  b.cyl(cx + 18, gy + 2.5, cz - 6, 5, 5, 'rust');
  // Underground pump room via stairs shaft
  b.stairs(cx - 8, gy, cz + 6, 2, 9, 0.55, 0.62, 2.2, 'concreteDark');
  const py = gy - 5;
  b.slab(cx, py, cz - 6, 20, 14, 0.5, 'concreteDark');
  b.slab(cx, py + 4.2, cz - 6, 20, 14, 0.5, 'concreteDark');
  b.wallWithGaps(cx - 10, cz - 13, 20, 4.2, 0.5, 'x', 'concrete', []);
  b.wallWithGaps(cx - 10, cz + 1, 20, 4.2, 0.5, 'x', 'concrete', [[8, 2.4]]);
  b.wallWithGaps(cx - 10, cz - 13, 14, 4.2, 0.5, 'z', 'concrete', []);
  b.wallWithGaps(cx + 10, cz - 13, 14, 4.2, 0.5, 'z', 'concrete', []);
  for (let i = 0; i < 3; i++) {
    b.cyl(cx - 6 + i * 6, py + 1.4, cz - 9, 1.4, 2.8, 'metalDark');
  }
  b.light(cx, py + 3.4, cz - 6, 0x9fe8ff, 1.6, 22);
  b.loot(cx + 4, py + 0.4, cz - 4);
}

function dock(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  // Wooden pier into the lake
  const surfaceY = -4.2;
  for (let i = 0; i < 5; i++) {
    const pz = cz + i * 6;
    b.slab(cx, surfaceY + 1.1, pz, 5, 6, 0.3, 'woodDark');
    if (i > 0) {
      b.cyl(cx - 2, surfaceY + 0.4, pz, 0.22, 1.6, 'woodDark');
      b.cyl(cx + 2, surfaceY + 0.4, pz, 0.22, 1.6, 'woodDark');
    }
  }
  b.platform(cx - 2.5, cx + 2.5, cz, cz + 30, surfaceY + 1.25);
  b.crate(cx, surfaceY + 1.4, cz + 8, 1);
  for (let i = 0; i < 3; i++) {
    b.cyl(cx + 1.5 + (i % 2) * 1.1, surfaceY + 0.55 + Math.floor(i / 2) * 1.1, cz + 20, 0.55, 1.1, 'rust');
  }
  b.loot(cx, surfaceY + 1.6, cz + 14);
}

function boathouse(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  addBuilding(b, {
    x: cx, z: cz, w: 12, d: 14, floors: 1, floorHeight: 5, wallMat: 'woodDark', trimMat: 'wood',
    doors: [[1, 5, 2.6]], interiorDividers: false, windows: false,
  });
  b.loot(cx - 2, gy + 0.4, cz + 2);
}

function overlookPlatform(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  b.slab(cx, gy + 0.3, cz, 16, 12, 0.5, 'woodDark');
  b.wallWithGaps(cx - 8, cz - 6, 16, 1.1, 0.25, 'x', 'woodDark', [], 0, gy + 0.55);
  b.wallWithGaps(cx - 8, cz + 6, 16, 1.1, 0.25, 'x', 'woodDark', [[6, 3]], 0, gy + 0.55);
  b.wallWithGaps(cx - 8, cz - 6, 12, 1.1, 0.25, 'z', 'woodDark', [], 0, gy + 0.55);
  b.wallWithGaps(cx + 8, cz - 6, 12, 1.1, 0.25, 'z', 'woodDark', [], 0, gy + 0.55);
  b.platform(cx - 8, cx + 8, cz - 6, cz + 6, gy + 0.55);
  b.loot(cx + 3, gy + 0.7, cz + 2);
}

function antennaArray(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  b.cyl(cx, gy + 7, cz, 0.3, 14, 'metalDark');
  b.box(cx, gy + 13.6, cz, 2.4, 0.3, 0.3, 'metalDark');
  for (let i = 0; i < 3; i++) {
    const ax = cx + rng.range(-8, 8);
    const az = cz + rng.range(-8, 8);
    b.cyl(ax, gy + 2.5, az, 0.2, 5, 'metalDark');
  }
  b.light(cx, gy + 13, cz, 0xff5f5f, 1.6, 20);
}

function greenhouse(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  // Frame
  b.slab(cx, gy + 0.2, cz, 14, 10, 0.3, 'concreteDark');
  for (const sx of [-1, 1]) {
    b.box(cx + sx * 7, gy + 2, cz, 0.3, 4, 10, 'metalDark');
  }
  b.box(cx, gy + 4.2, cz, 14.4, 0.3, 10.4, 'metalDark');
  // Glass panels (destructible)
  b.glassPane(cx - 6.85, gy + 2.2, cz, 10, 3.8, 'z');
  b.glassPane(cx + 6.85, gy + 2.2, cz, 10, 3.8, 'z');
  b.glassPane(cx, gy + 2.2, cz - 4.85, 14, 3.8, 'x');
  b.glassPane(cx, gy + 2.2, cz + 4.85, 14, 3.8, 'x');
  b.platform(cx - 7, cx + 7, cz - 5, cz + 5, gy + 0.35);
  // Plant benches
  b.box(cx - 3, gy + 1, cz, 4, 0.9, 6, 'woodDark');
  b.box(cx + 3, gy + 1, cz, 4, 0.9, 6, 'woodDark');
  b.loot(cx, gy + 0.6, cz);
}

function planterRows(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  for (let i = 0; i < 4; i++) {
    b.box(cx - 9 + i * 6, gy + 0.5, cz, 4, 1, 1.6, 'woodDark');
    b.tree({ x: cx - 9 + i * 6, z: cz, y: gy + 1, scale: 0.55, variant: 'oak' });
  }
  b.crate(cx + 8, gy + 0.2, cz + 4, 1);
  void rng;
}

function generatorYard(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  for (let i = 0; i < 3; i++) {
    b.box(cx - 8 + i * 8, gy + 1.4, cz, 5, 2.8, 3.4, 'rust');
    b.box(cx - 8 + i * 8, gy + 2.9, cz, 4.4, 0.2, 2.8, 'metalDark');
  }
  b.platform(cx - 10.5, cx + 10.5, cz - 1.7, cz + 1.7, gy + 2.8);
  b.chest(cx, gy + 0.3, cz + 6, 'elite');
  b.loot(cx - 6, gy + 0.4, cz - 4);
}

function testField(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  // Target walls and obstacles
  for (let i = 0; i < 5; i++) {
    const wx = cx + rng.range(-14, 14);
    const wz = cz + rng.range(-14, 14);
    b.box(wx, gy + 1.2, wz, 3.4, 2.4, 0.4, 'concrete', rng.angle());
  }
  b.vehicle(cx + 8, cz + 6, gy + 0.2, 1.2, 'wrecked', 0x3a4038);
  b.chest(cx - 6, gy + 0.3, cz - 6, 'standard');
  b.loot(cx + 2, gy + 0.4, cz + 10);
}

function cabin(b: WorldBuilder, cx: number, cz: number): void {
  addBuilding(b, {
    x: cx, z: cz, w: 9, d: 8, floors: 1, wallMat: 'woodDark', doors: [[0, 3.5, 1.7]],
    interiorDividers: false, windows: false,
  });
  const gy = terrainH(cx, cz);
  b.loot(cx + 1, gy + 0.4, cz + 1);
  b.crate(cx - 3, gy + 0.2, cz + 3, 0.9);
}

function ford(b: WorldBuilder, cx: number, cz: number): void {
  // Shallow river crossing with stepping stones
  const sy = -4.0;
  for (let i = 0; i < 6; i++) {
    b.rock(cx - 8 + i * 3.2, cz + Math.sin(i) * 2, sy + 0.4, 1.1);
  }
  b.loot(cx, sy + 0.8, cz);
  b.loot(cx + 6, sy + 0.8, cz + 2);
}

function meadowCamp(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  for (let i = 0; i < 3; i++) {
    const tx = cx + rng.range(-8, 8);
    const tz = cz + rng.range(-8, 8);
    b.box(tx, gy + 0.9, tz, 2.6, 1.8, 2.6, 'plasterOld', rng.angle());
    b.platform(tx - 1.3, tx + 1.3, tz - 1.3, tz + 1.3, gy + 1.8);
  }
  b.chest(cx + 6, gy + 0.3, cz - 6, 'standard');
  b.loot(cx - 4, gy + 0.4, cz + 5);
}

function pumpHouse(b: WorldBuilder, cx: number, cz: number): void {
  addBuilding(b, {
    x: cx, z: cz, w: 8, d: 8, floors: 1, wallMat: 'brick' as never, doors: [[0, 3.5, 1.8]],
    interiorDividers: false, windows: false,
  });
  const gy = terrainH(cx, cz);
  b.cyl(cx + 6, gy + 1, cz, 0.8, 2, 'rust');
  b.loot(cx, gy + 0.4, cz + 2);
}

function watchRock(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  b.rock(cx, cz, gy, 4.2);
  b.stairs(cx + 4.5, gy, cz, 3, 5, 0.6, 0.7, 2.2, 'rock');
  b.platform(cx - 2.5, cx + 2.5, cz - 2.5, cz + 2.5, gy + 3.2);
  b.chest(cx, gy + 3.5, cz, 'elite');
}
