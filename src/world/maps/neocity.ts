/**
 * NEO CITY — near-future neon metropolis at night.
 * Dense urban grid, enterable towers, rooftops, plaza, transit hub with
 * underground level, alleys, vehicle cover, strong colored lighting.
 */

import { WorldBuilder } from '../builder';
import type { MapDef, MatKey } from '../types';
import { Rng } from '../../core/rng';
import { addBuilding, addGround } from './common';

const S = 500; // map size

export function buildNeoCity(): MapDef {
  const rng = new Rng(0x0c17 + 7);
  const b = new WorldBuilder('neocity', 'NEO CITY', 'A rain-slicked neon district. Fight through streets, arcologies and rooftops.', S);

  addGround(b, S, 'asphalt');

  // Street grid: roads every 100u (visual strips), sidewalks
  for (let i = -2; i <= 2; i++) {
    const c = i * 100;
    b.box(c, 0.06, 0, 14, 0.12, S, 'concreteDark', 0, { noCollide: true });
    b.box(0, 0.06, c, S, 0.12, 14, 'concreteDark', 0, { noCollide: true });
    // sidewalks
    b.box(c, 0.1, 0, 20, 0.2, S, 'sidewalk', 0, { floor: true });
    b.box(0, 0.1, c, S, 0.2, 20, 'sidewalk', 0, { floor: true });
  }

  // ------------------------------------------------------------------
  // POI: SPIRE PLAZA (center) — fountain, surrounding arcade, tall spire
  // ------------------------------------------------------------------
  b.poi('Spire Plaza', 0, 0, 55);
  b.cyl(0, 0.5, 0, 9, 1, 'marble');
  b.cyl(0, 1.4, 0, 3.2, 2.6, 'marble');
  b.sphere(0, 3.4, 0, 1.4, 'neonCyan', { noCollide: true });
  b.light(0, 5, 0, 0x66e0ff, 3.2, 40);
  // Arcade ring (pillars + roof)
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const px = Math.cos(a) * 26;
    const pz = Math.sin(a) * 26;
    b.cyl(px, 3, pz, 0.8, 6, 'concrete');
    if (i % 3 === 0) b.lampPost(px * 1.15, pz * 1.15, 0, 5.4, 0x88ccff, 2.4, 24);
  }
  b.cyl(0, 6.35, 0, 28.5, 0.7, 'concreteDark');
  b.platform(-28.5, 28.5, -28.5, 28.5, 6.7);
  // The Spire tower (landmark, enterable, roof access)
  addBuilding(b, {
    x: 0, z: -52, w: 22, d: 22, floors: 4, wallMat: 'facadeA', trimMat: 'metalDark',
    doors: [[0, 8, 2.4], [2, 8, 2.4]], roofAccess: true,
  });
  b.loot(0, 0.4, -38);
  b.chest(6, 0.3, -44, 'elite');
  b.chest(-4, 14.6, -56, 'standard');

  // ------------------------------------------------------------------
  // POI: NEON MARKET (NE quadrant)
  // ------------------------------------------------------------------
  b.poi('Neon Market', 120, 120, 60);
  addBuilding(b, { x: 105, z: 105, w: 30, d: 18, floors: 2, wallMat: 'facadeB', doors: [[0, 6, 2.6], [0, 20, 2.6], [2, 12, 2.6]], interiorDividers: false });
  addBuilding(b, { x: 145, z: 108, w: 18, d: 16, floors: 3, wallMat: 'facadeC', doors: [[3, 6, 2.2]] });
  addBuilding(b, { x: 112, z: 142, w: 24, d: 14, floors: 1, wallMat: 'plaster', doors: [[1, 5, 2.4], [3, 5, 2.4]], interiorDividers: false });
  // Market stalls
  for (let i = 0; i < 6; i++) {
    const sx = 122 + (i % 3) * 12;
    const sz = 124 + Math.floor(i / 3) * 10;
    b.box(sx, 1.1, sz, 4.4, 0.25, 2.4, 'metal');
    b.cyl(sx - 2, 0.55, sz, 0.09, 1.1, 'metalDark');
    b.cyl(sx + 2, 0.55, sz, 0.09, 1.1, 'metalDark');
    b.box(sx, 2.5, sz, 5, 0.18, 3, i % 2 ? 'neonMagenta' : 'neonCyan', 0, { noCollide: true });
    b.crate(sx + 1.4, 0.2, sz + 1.6, 0.9);
    b.loot(sx - 1.5, 1.45, sz);
  }
  b.chest(130, 0.3, 132, 'standard');
  b.chest(148, 0.3, 140, 'vault');
  neonSigns(b, rng, [
    [108, 96, 0xff4fd8], [126, 150, 0x53ffe0], [152, 118, 0x7a5cff],
  ]);

  // ------------------------------------------------------------------
  // POI: CYBERDOME ARENA (NW)
  // ------------------------------------------------------------------
  b.poi('Cyberdome', -130, 110, 55);
  // Arena bowl: ring walls + inner field + elevated walkway
  b.cyl(-130, 0.4, 110, 34, 0.8, 'concrete');
  b.platform(-164, -96, 76, 144, 0.8);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    b.box(-130 + Math.cos(a) * 33, 4, 110 + Math.sin(a) * 33, 3, 8, 3, 'facadeA', a);
  }
  b.cyl(-130, 8.4, 110, 36.5, 0.8, 'metalDark');
  b.platform(-166.5, -93.5, 73.5, 146.5, 8.8);
  // ramps onto walkway
  rampTo(b, -130, 110, 36.5, 8.8, 0);
  b.chest(-130, 1.2, 110, 'elite');
  b.chest(-118, 9.2, 98, 'vault');
  b.loot(-138, 1.2, 118);
  b.loot(-124, 1.2, 102);
  b.vehicle(-158, 128, 0.2, 0.4, 'van', 0x27313d);

  // ------------------------------------------------------------------
  // POI: RESIDENTIAL BLOCKS (SW)
  // ------------------------------------------------------------------
  b.poi('Resident Blocks', -120, -120, 65);
  addBuilding(b, { x: -135, z: -105, w: 20, d: 16, floors: 3, wallMat: 'facadeB', doors: [[0, 8, 2.2], [1, 6, 2.2]] });
  addBuilding(b, { x: -105, z: -108, w: 18, d: 18, floors: 2, wallMat: 'facadeC', doors: [[0, 7, 2.2], [3, 7, 2.2]] });
  addBuilding(b, { x: -132, z: -138, w: 22, d: 18, floors: 4, wallMat: 'facadeA', doors: [[0, 9, 2.4]], roofAccess: true });
  addBuilding(b, { x: -102, z: -136, w: 16, d: 14, floors: 2, wallMat: 'plaster', doors: [[0, 6, 2.2], [2, 6, 2.2]] });
  courtyardProps(b, rng, -118, -122);
  b.chest(-112, 0.3, -120, 'standard');
  b.chest(-134, 11.2, -140, 'elite');

  // ------------------------------------------------------------------
  // POI: TRANSIT HUB (SE) — station + underground platform
  // ------------------------------------------------------------------
  b.poi('Transit Hub', 125, -125, 55);
  addBuilding(b, {
    x: 125, z: -115, w: 34, d: 20, floors: 1, wallMat: 'facadeA', trimMat: 'metal',
    doors: [[0, 10, 3], [0, 24, 3], [2, 10, 3], [2, 24, 3]], interiorDividers: false,
  });
  // Underground platform via stairwell shafts
  underpassStation(b, 125, -125);
  b.chest(118, 0.3, -112, 'standard');
  b.chest(133, -5.2, -127, 'vault');
  b.vehicle(108, -132, 0.2, 1.2, 'truck', 0x3a2f28);
  b.vehicle(140, -104, 0.2, 2.4, 'sedan', 0x1f2733);

  // ------------------------------------------------------------------
  // POI: INDUSTRIAL YARD (W)
  // ------------------------------------------------------------------
  b.poi('Industrial Yard', -160, 0, 50);
  addBuilding(b, { x: -170, z: -12, w: 26, d: 20, floors: 1, wallMat: 'rust', trimMat: 'metalDark', doors: [[1, 7, 3], [3, 7, 3], [0, 10, 3]], interiorDividers: false });
  addBuilding(b, { x: -168, z: 18, w: 14, d: 12, floors: 2, wallMat: 'metalDark', doors: [[0, 5, 2.4]] });
  // Storage tanks & containers
  b.cyl(-145, 3, -18, 5, 6, 'rust');
  b.cyl(-145, 3, -4, 5, 6, 'metalDark');
  for (let i = 0; i < 5; i++) {
    b.box(-150 + i * 6, 1.3, 8 + (i % 2) * 7, 5.2, 2.6, 2.4, i % 2 ? 'rust' : 'metalDark', i * 0.13);
    b.platform(-152.6 + i * 6, -147.4 + i * 6, 6.8 + (i % 2) * 7, 9.2 + (i % 2) * 7, 2.6);
  }
  b.chest(-162, 0.3, 2, 'elite');
  b.chest(-146, 0.3, -10, 'standard');
  b.loot(-155, 0.4, 14);
  b.vehicle(-176, 30, 0.2, 0.2, 'wrecked', 0x2a2118);

  // ------------------------------------------------------------------
  // POI: ROOFTOP GARDENS (N)
  // ------------------------------------------------------------------
  b.poi('Sky Gardens', 20, -180, 45);
  addBuilding(b, { x: 8, z: -185, w: 26, d: 20, floors: 2, wallMat: 'facadeC', doors: [[0, 10, 2.6], [2, 10, 2.6]], roofAccess: true });
  addBuilding(b, { x: 42, z: -178, w: 18, d: 16, floors: 3, wallMat: 'facadeB', doors: [[3, 6, 2.2]] });
  // Garden planters on first roof
  for (let i = 0; i < 4; i++) {
    b.box(0 + (i % 2) * 14 - 7, 7.6, -190 + Math.floor(i / 2) * 10, 5, 0.8, 3, 'concrete');
    b.tree({ x: (i % 2) * 14 - 7, z: -190 + Math.floor(i / 2) * 10, y: 8, scale: 0.7, variant: 'palm' });
  }
  b.chest(8, 7.6, -182, 'elite');
  b.chest(44, 11.2, -180, 'standard');

  // ------------------------------------------------------------------
  // Small POIs / fillers
  // ------------------------------------------------------------------
  b.poi('East Kiosks', 185, 20, 25);
  kioskRow(b, 185, 20);
  b.poi('West Alley', -80, 60, 20);
  alleyFill(b, -80, 60);
  b.poi('South Garage', 30, 165, 30);
  parkingGarage(b, 30, 165);
  b.poi('North Plaza', -40, -220, 30);
  miniPlaza(b, -40, -220);
  b.poi('Server Bunker', 200, -60, 22);
  serverBunker(b, 200, -60);
  b.poi('Fountain Court', -210, -70, 26);
  miniPlaza(b, -210, -70);
  b.poi('Freight Depot', 70, 205, 28);
  freightDepot(b, 70, 205);
  b.poi('Overpass', -30, 230, 24);
  overpass(b, -30, 230);
  b.poi('Cooling Yard', 215, 175, 26);
  coolingYard(b, 215, 175);
  b.poi('Old Billboard', -225, 175, 20);
  billboardSpot(b, -225, 175);

  // Street vehicles scattered
  const carSpots: Array<[number, number, number]> = [
    [60, 40, 0.3], [-60, -40, 2.2], [40, -70, 1.1], [-40, 90, 0.1],
    [90, -20, 1.8], [-95, 25, 2.9], [20, 95, 0.6], [-20, -95, 2.5],
    [160, 60, 1.4], [-160, -60, 0.9], [75, 160, 2.0], [-75, -160, 0.4],
  ];
  for (const [cx, cz, cyaw] of carSpots) {
    b.vehicle(cx, cz, 0.2, cyaw, rng.bool(0.3) ? 'van' : 'sedan', [0x27313d, 0x503030, 0x2e3a2f, 0x33384a][rng.int(0, 3)]!);
  }

  // Street lamps along roads (intersections + mid-block)
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      if (i === 0 && j === 0) continue;
      b.lampPost(i * 100 + 12, j * 100 + 12, 0, 5.6, 0x9fd8ff, 3.4, 42);
      b.lampPost(i * 100 - 12, j * 100 - 12, 0, 5.6, 0xffb98a, 2.6, 28);
      b.lampPost(i * 100 + 12, j * 100 + 55, 0, 5.6, 0x9fd8ff, 2.6, 30);
      b.lampPost(i * 100 + 55, j * 100 + 12, 0, 5.6, 0xffc9a0, 2.4, 28);
      b.lampPost(i * 100 - 55, j * 100 - 12, 0, 5.6, 0x9fd8ff, 2.6, 30);
      b.lampPost(i * 100 - 12, j * 100 - 55, 0, 5.6, 0xffc9a0, 2.4, 28);
    }
  }

  // Ambient neon lights
  b.light(120, 8, 120, 0xff4fd8, 2.4, 46);
  b.light(-130, 10, 110, 0x53c8ff, 2.6, 50);
  b.light(125, 6, -125, 0x53ffe0, 2.2, 44);
  b.light(-160, 6, 0, 0xffa04f, 2.0, 40);
  b.light(20, 9, -180, 0x9d6bff, 2.2, 42);

  litWindows(b, rng);

  return b.finish(
    {
      preset: 'night',
      fogColor: 0x232e48,
      fogDensity: 0.0026,
      sunDirection: [-0.3, -1, -0.2],
      sunColor: 0x8fa4cc,
      sunIntensity: 2.0,
      ambientColor: 0xa8b8d8,
      ambientIntensity: 2.4,
      hemisphereSky: 0x7688b8,
      hemisphereGround: 0x3a4050,
      hemisphereIntensity: 2.1,
    },
    { from: [-330, -80], to: [330, 60] },
  );
}

// ---------------------------------------------------------------------------
// Local structure helpers
// ---------------------------------------------------------------------------

function rampTo(b: WorldBuilder, cx: number, cz: number, startR: number, topY: number, yaw: number): void {
  const steps = 14;
  const rise = topY / steps;
  for (let i = 0; i < steps; i++) {
    const d = startR + 0.4 + i * 0.85;
    b.box(cx + Math.cos(yaw) * d, rise * (i + 0.5), cz + Math.sin(yaw) * d, 3.2, rise * (i + 1), 0.9, 'metalDark', yaw);
    b.platform(cx + Math.cos(yaw) * d - 1.6, cx + Math.cos(yaw) * d + 1.6, cz + Math.sin(yaw) * d - 0.5, cz + Math.sin(yaw) * d + 0.5, rise * (i + 1));
  }
}

function neonSigns(b: WorldBuilder, rng: Rng, spots: Array<[number, number, number]>): void {
  const signMats: Record<number, MatKey> = { 0xff4fd8: 'neonMagenta', 0x53ffe0: 'neonGreen', 0x7a5cff: 'neonBlue' };
  for (const [x, z, color] of spots) {
    const h = rng.range(7, 11);
    b.box(x, h, z, 0.5, 3.2, 6.5, 'metalDark');
    b.box(x + 0.4, h, z, 0.2, 2.4, 5.4, signMats[color] ?? 'neonCyan', 0, { noCollide: true });
    b.light(x + 1, h, z, color, 2.4, 30);
  }
}

function courtyardProps(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  for (let i = 0; i < 5; i++) {
    const a = rng.angle();
    const r = rng.range(4, 16);
    b.crate(cx + Math.cos(a) * r, 0.2, cz + Math.sin(a) * r, rng.range(0.8, 1.3));
  }
  b.lampPost(cx, cz, 0, 5, 0xffd9a0, 2.2, 26);
  b.loot(cx + 3, 0.4, cz - 3);
}

function underpassStation(b: WorldBuilder, cx: number, cz: number): void {
  // Shaft down to platform at y=-5
  const depth = 5;
  b.stairs(cx - 8, 0, cz - 3, 0, 10, depth / 10, 0.62, 2.2, 'concreteDark');
  // Platform box (hollow room underground)
  const py = -depth;
  b.slab(cx, py, cz, 30, 16, 0.5, 'concreteDark');
  b.slab(cx, py + 4.4, cz, 30, 16, 0.5, 'concreteDark'); // ceiling
  b.wallWithGaps(cx - 15, cz - 8, 32, 4.4, 0.5, 'x', 'concrete', [[14, 2.4]]);
  b.wallWithGaps(cx - 15, cz + 8, 32, 4.4, 0.5, 'x', 'concrete', []);
  b.wallWithGaps(cx - 15, cz - 8, 16, 4.4, 0.5, 'z', 'concrete', []);
  b.wallWithGaps(cx + 15, cz - 8, 16, 4.4, 0.5, 'z', 'concrete', []);
  // Rails hint
  b.box(cx, py + 0.25, cz - 5.5, 26, 0.3, 1.2, 'metalDark');
  b.box(cx, py + 0.25, cz + 5.5, 26, 0.3, 1.2, 'metalDark');
  b.light(cx, py + 3.6, cz, 0x8affff, 1.8, 26);
  b.chest(cx + 6, py + 0.3, cz, 'elite');
  b.loot(cx - 6, py + 0.4, cz + 3);
  b.loot(cx, py + 0.4, cz - 3);
}

function kioskRow(b: WorldBuilder, cx: number, cz: number): void {
  for (let i = 0; i < 3; i++) {
    const kx = cx + i * 9;
    b.box(kx, 1.5, cz, 5, 3, 4, 'facadeB');
    b.platform(kx - 2.5, kx + 2.5, cz - 2, cz + 2, 3.05);
    b.box(kx, 3.3, cz, 5.6, 0.3, 4.6, 'neonOrange', 0, { noCollide: true });
    b.loot(kx, 0.4, cz + 3);
  }
  b.chest(cx + 9, 0.3, cz - 6, 'standard');
}

function alleyFill(b: WorldBuilder, cx: number, cz: number): void {
  // Two facing walls forming an alley with crates and a fire escape
  b.box(cx - 4, 4, cz, 1, 8, 26, 'facadeC');
  b.box(cx + 4, 4, cz, 1, 8, 26, 'facadeA');
  for (let i = 0; i < 4; i++) b.crate(cx + (i % 2 ? 2 : -2), 0.2, cz - 8 + i * 5, 1);
  // fire escape platforms
  for (let f = 1; f <= 2; f++) {
    b.box(cx + 3, f * 3.4, cz + 6, 3, 0.2, 2.4, 'metalDark');
    b.platform(cx + 1.5, cx + 4.5, cz + 4.8, cz + 7.2, f * 3.4 + 0.1);
  }
  b.loot(cx, 0.4, cz + 4);
  b.chest(cx, 0.3, cz - 10, 'standard');
}

function parkingGarage(b: WorldBuilder, cx: number, cz: number): void {
  // Two open levels with ramps
  for (let lvl = 0; lvl < 2; lvl++) {
    const y = lvl * 3.6;
    b.slab(cx, y + 0.2, cz, 30, 20, 0.4, 'concreteDark');
    for (const sx of [-1, 1]) {
      b.box(cx + sx * 15, y + 1.9, cz, 0.4, 3.6, 20, 'concrete');
    }
    b.box(cx, y + 1.9, cz - 10, 30, 3.6, 0.4, 'concrete');
    b.wallWithGaps(cx - 15, cz + 10, 30, 3.6, 0.4, 'x', 'concrete', lvl === 0 ? [[12, 6]] : [[12, 6]]);
    b.platform(cx - 15, cx + 15, cz - 10, cz + 10, y + 0.4);
    // ramp between levels
    if (lvl === 0) {
      b.stairs(cx + 10, y + 0.4, cz - 8, 0, 8, 0.45, 0.65, 3, 'concreteDark');
    }
    for (let i = 0; i < 2; i++) {
      b.vehicle(cx - 8 + i * 12, cz + 4, y + 0.4, i % 2 ? 0 : Math.PI, 'sedan', 0x2b3038);
    }
  }
  b.chest(cx - 10, 0.6, cz - 6, 'standard');
  b.chest(cx + 8, 4.2, cz + 6, 'elite');
  b.loot(cx, 0.6, cz);
}

function miniPlaza(b: WorldBuilder, cx: number, cz: number): void {
  b.cyl(cx, 0.4, cz, 6, 0.8, 'marble');
  b.cyl(cx, 1.2, cz, 2, 1.6, 'marble');
  b.sphere(cx, 2.6, cz, 1, 'neonCyan', { noCollide: true });
  b.light(cx, 4, cz, 0x66e0ff, 2.4, 30);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.crate(cx + Math.cos(a) * 9, 0.2, cz + Math.sin(a) * 9, 1);
  }
  b.chest(cx + 8, 0.3, cz + 8, 'standard');
  b.loot(cx - 6, 0.4, cz + 4);
}

function serverBunker(b: WorldBuilder, cx: number, cz: number): void {
  b.box(cx, 1.6, cz, 16, 3.2, 12, 'concrete');
  b.platform(cx - 8, cx + 8, cz - 6, cz + 6, 3.2);
  b.wallWithGaps(cx - 8, cz - 6, 16, 3.2, 0.4, 'x', 'concrete', [[6, 2.2]]);
  b.wallWithGaps(cx - 8, cz + 6, 16, 3.2, 0.4, 'x', 'concrete', []);
  b.wallWithGaps(cx - 8, cz - 6, 12, 3.2, 0.4, 'z', 'concrete', []);
  b.wallWithGaps(cx + 8, cz - 6, 12, 3.2, 0.4, 'z', 'concrete', []);
  // Server racks inside
  for (let i = 0; i < 4; i++) {
    b.box(cx - 5 + i * 3.4, 1.1, cz - 2, 1.4, 2.2, 3, 'metalDark');
    b.box(cx - 5 + i * 3.4, 2.25, cz - 2, 1.2, 0.12, 2.6, 'neonGreen', 0, { noCollide: true });
  }
  b.light(cx, 2.8, cz, 0x54ff9f, 1.6, 22);
  b.chest(cx, 0.3, cz + 3, 'vault');
  b.loot(cx + 4, 0.4, cz - 3);
}

function freightDepot(b: WorldBuilder, cx: number, cz: number): void {
  addBuilding(b, { x: cx, z: cz, w: 24, d: 16, floors: 1, wallMat: 'rust', doors: [[0, 9, 3.2], [2, 9, 3.2]], interiorDividers: false });
  for (let i = 0; i < 6; i++) {
    b.crate(cx - 8 + (i % 3) * 7, 0.2, cz + 12 + Math.floor(i / 3) * 3, 1.1);
  }
  b.vehicle(cx + 16, cz - 4, 0.2, 0.2, 'truck', 0x3a3128);
  b.chest(cx, 0.3, cz, 'standard');
  b.loot(cx - 6, 0.4, cz + 4);
}

function overpass(b: WorldBuilder, cx: number, cz: number): void {
  // Elevated road slab on pillars crossing a street
  b.slab(cx, 6.4, cz, 60, 10, 0.8, 'concrete');
  for (let i = -2; i <= 2; i++) {
    b.box(cx + i * 13, 3, cz, 2.4, 6, 2.4, 'concrete');
  }
  b.wallWithGaps(cx - 30, cz - 5, 60, 1.1, 0.3, 'x', 'concrete');
  b.wallWithGaps(cx - 30, cz + 5, 60, 1.1, 0.3, 'x', 'concrete');
  // access stairs at both ends
  b.stairs(cx - 30, 0, cz - 4.5, 0, 11, 0.58, 0.6, 2.6, 'concreteDark');
  b.stairs(cx + 30, 0, cz + 4.5, 2, 11, 0.58, 0.6, 2.6, 'concreteDark');
  b.chest(cx, 6.8, cz, 'elite');
  b.loot(cx + 12, 6.9, cz + 2);
  b.crate(cx - 12, 6.6, cz - 2, 1);
}

function coolingYard(b: WorldBuilder, cx: number, cz: number): void {
  for (let i = 0; i < 3; i++) {
    b.cyl(cx + i * 12 - 12, 3, cz, 4.4, 6, 'metalDark');
    b.cyl(cx + i * 12 - 12, 6.4, cz, 3.2, 0.8, 'rust');
  }
  b.box(cx, 1.2, cz + 10, 20, 2.4, 3, 'metal');
  b.platform(cx - 10, cx + 10, cz + 8.5, cz + 11.5, 2.4);
  b.chest(cx - 12, 0.3, cz + 6, 'standard');
  b.loot(cx + 2, 0.4, cz + 6);
  b.loot(cx - 4, 0.4, cz - 8);
}

function billboardSpot(b: WorldBuilder, cx: number, cz: number): void {
  b.box(cx, 6, cz, 1.2, 12, 1.2, 'metalDark');
  b.box(cx, 12.5, cz + 0.9, 14, 6, 0.5, 'neonMagenta', 0, { noCollide: true });
  b.light(cx, 12, cz + 2, 0xff4fd8, 2.6, 36);
  b.crate(cx + 3, 0.2, cz + 2, 1.2);
  b.loot(cx - 2, 0.4, cz + 3);
}

/**
 * Scatters emissive "lit windows" over large building facades — sells the
 * night-city look without adding real lights.
 */
function litWindows(b: WorldBuilder, rng: Rng): void {
  const facadeMats: MatKey[] = ['facadeA', 'facadeB', 'facadeC'];
  const warmMats: MatKey[] = ['neonOrange', 'neonCyan', 'neonBlue'];
  for (const g of b.def.geo) {
    if (g.kind !== 'box') continue;
    if (!facadeMats.includes(g.mat)) continue;
    const minDim = Math.min(g.sx, g.sz);
    if (minDim < 10 || g.sy < 7) continue;
    // Windows on the two largest faces
    const faces: Array<{ axis: 'x' | 'z'; sign: number }> = g.sx >= g.sz
      ? [{ axis: 'z', sign: 1 }, { axis: 'z', sign: -1 }]
      : [{ axis: 'x', sign: 1 }, { axis: 'x', sign: -1 }];
    for (const face of faces) {
      const count = Math.min(6, Math.floor((g.sx + g.sz) / 6));
      for (let i = 0; i < count; i++) {
        if (!rng.bool(0.65)) continue;
        const along = rng.range(-0.35, 0.35);
        const y = g.y + rng.range(-g.sy * 0.32, g.sy * 0.3);
        const mat = warmMats[rng.int(0, warmMats.length - 1)]!;
        const wx = face.axis === 'x' ? g.x + face.sign * (g.sx / 2 + 0.06) : g.x + along * g.sx;
        const wz = face.axis === 'z' ? g.z + face.sign * (g.sz / 2 + 0.06) : g.z + along * g.sz;
        const sx = face.axis === 'x' ? 0.05 : 0.9;
        const sz = face.axis === 'z' ? 0.05 : 0.9;
        b.def.geo.push({ kind: 'box', x: wx, y, z: wz, sx, sy: 0.55, sz, yaw: 0, mat, noCollide: true });
      }
    }
  }
}
