/**
 * ASHARA REACH — a fictional contemporary arid conflict landscape.
 *
 * The layout is original and deliberately avoids real flags, insignia,
 * factions, incidents, or copied game geography. A broad wadi separates
 * close-quarter settlements from long-range ridges while roads, bridges,
 * compounds and service corridors keep every combat band connected.
 */

import { Rng } from '../../core/rng';
import { WorldBuilder } from '../builder';
import type { MapDef, MatKey } from '../types';
import { addBuilding, hardenExposedFlanks, scatterRocks, structureBaseY } from './common';

const S = 500;

function gaussian(x: number, z: number, cx: number, cz: number, radius: number, height: number): number {
  const d = Math.hypot(x - cx, z - cz) / radius;
  return Math.exp(-d * d * 2.2) * height;
}

/** Analytic source sampled into the render/physics heightfield. */
function terrainH(x: number, z: number): number {
  let h = Math.sin(x * 0.018) * 0.55 + Math.cos(z * 0.021) * 0.42
    + Math.sin((x - z) * 0.008) * 0.65;
  h += gaussian(x, z, 154, -154, 72, 9.5);   // relay mesa
  h += gaussian(x, z, -188, -146, 85, 6.5);  // western ridge
  h += gaussian(x, z, 184, 176, 95, 7.2);    // south-east escarpment
  h += gaussian(x, z, -205, 184, 80, 4.5);   // irrigation high bank

  // Dry riverbed: a winding, readable depression with broad shoulders.
  const wadiZ = 42 + Math.sin(x * 0.018) * 18 + Math.sin(x * 0.006 + 1.2) * 9;
  const wadiD = Math.abs(z - wadiZ);
  if (wadiD < 24) {
    const t = 1 - wadiD / 24;
    h -= t * t * 3.8;
  }
  return h;
}

export function buildAsharaReach(): MapDef {
  const rng = new Rng(0xa54a42);
  const b = new WorldBuilder(
    'ashara',
    'ASHARA REACH',
    'A wind-cut frontier of dense compounds, dry wadis, industrial yards and high desert ridges.',
    S,
  );

  buildHeightfield(b);
  highway(b);

  b.poi('Sunwall Market', -34, -30, 62);
  sunwallMarket(b, rng, -34, -30);

  b.poi('Relay Mesa', 154, -154, 48);
  relayMesa(b, 154, -154);

  b.poi('Dustline Works', 142, 32, 58);
  dustlineWorks(b, rng, 142, 32);

  b.poi('Wadi Crossing', 0, 44, 38);
  wadiCrossing(b, 0, 44);

  b.poi('Kestrel Compound', -158, 86, 52);
  kestrelCompound(b, -158, 86);

  b.poi('Dry Canals', -188, 178, 52);
  dryCanals(b, rng, -188, 178);

  b.poi('Fuel Court', 184, 150, 42);
  fuelCourt(b, 184, 150);

  b.poi('South Checkpoint', 42, 202, 38);
  southCheckpoint(b, 42, 202);

  b.poi('Ridge Bunkers', -190, -150, 45);
  ridgeBunkers(b, -190, -150);

  b.poi('Old Caravanserai', 58, -202, 38);
  caravanserai(b, 58, -202);

  roadsideInfrastructure(b, rng);
  desertScatter(b, rng);

  hardenExposedFlanks(b, { mat: 'concreteDark', maxProps: 20 });

  return b.finish({
    preset: 'day',
    atmosphere: {
      // Dry bright desert: high cirrus, dust at the horizon, stronger but
      // controlled sun glare with clear depth to the ridges.
      zenith: 0x3a76b8, horizon: 0xd8c9a8,
      discSize: 0.033, discColor: 0xfff6dd, discGlow: 0.7,
      cloudCover: 0.22, cloudTint: 0xf7f2e6, cloudShade: 0xc0b49a,
      windSpeed: 0.014, starOpacity: 0.0,
      hazeColor: 0xcbb896, hazeStrength: 0.58,
    },

    hdri: 'qwantani_puresky_2k.hdr',
    fogColor: 0xc7b99f,
    fogDensity: 0.00125,
    sunDirection: [-0.48, -0.82, -0.3],
    sunColor: 0xffe2b7,
    sunIntensity: 3.35,
    ambientColor: 0xb8c4d0,
    ambientIntensity: 0.62,
    hemisphereSky: 0x9fb9ce,
    hemisphereGround: 0x8b6f4e,
    hemisphereIntensity: 1.02,
    exposure: 1.04,
    envIntensity: 0.68,
    backgroundBlurriness: 0.2,
    backgroundIntensity: 0.72,
    grade: {
      vignette: 0.26,
      saturation: 0.92,
      contrast: 1.1,
      lift: [0.012, 0.008, 0.002],
    },
  }, {
    from: [-345, -120],
    to: [345, 150],
  });
}

function buildHeightfield(b: WorldBuilder): void {
  const n = 96;
  const heights = new Float32Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = col / (n - 1) * S - S / 2;
      const z = row / (n - 1) * S - S / 2;
      heights[row * n + col] = terrainH(x, z);
    }
  }
  b.def.heightfield = { n, heights };
}

function roadSegment(
  b: WorldBuilder,
  x: number,
  z: number,
  length: number,
  width: number,
  yaw: number,
  mat: MatKey = 'asphaltDesert',
): void {
  // A dusty shoulder separates the paved route from the pale terrain and
  // prevents the road from reading as a floating black card at grazing view.
  b.box(x, terrainH(x, z) + 0.025, z, length + 0.35, 0.045, width + 1.8, 'dirt', yaw, {
    noCollide: true,
    noRender: true,
  });
  // Keep segmented boxes for terrain-following collision/nav only. WorldView
  // renders one welded strip per road, avoiding overlapping coplanar tops and
  // the black cross-road seams they produced at every segment boundary.
  b.box(x, terrainH(x, z) + 0.055, z, length, 0.11, width, mat, yaw, { floor: true, noRender: true });
}

function chestPad(
  b: WorldBuilder,
  x: number,
  z: number,
  baseY: number,
  kind: 'standard' | 'elite' | 'vault',
): void {
  b.slab(x, baseY + 0.08, z, 3, 2.4, 0.28, 'concreteDark');
  b.chest(x, baseY + 0.38, z, kind);
}

function highway(b: WorldBuilder): void {
  // East-west logistics road, segmented so it follows the rolling surface.
  for (let x = -240; x <= 240; x += 20) roadSegment(b, x, -5, 20.4, 9, 0);
  // Southern feeder road toward the checkpoint.
  for (let z = 72; z <= 238; z += 18) roadSegment(b, 42, z, 18.4, 7, Math.PI / 2);
  // Broken lane paint keeps the route readable at range. Dashes are authored
  // as terrain-sampled surface paths so they hug the welded asphalt ribbon
  // exactly; the former flat boxes pierced or submerged under it wherever
  // the road rolled across a segment boundary.
  for (let x = -232; x <= 232; x += 16) {
    b.surfacePath([
      { x: x - 3, z: -5, width: 0.16 },
      { x: x + 3, z: -5, width: 0.16 },
    ], 'paint', 0.146);
  }

  // Shallow terrain-following drains replace the former ruler-straight hard
  // shoulder. Dark stone inverts the crown visually and periodic headwalls
  // explain where storm water passes beneath the logistics road. These are
  // presentation details outside the driven surface and do not add collision.
  for (const z of [-11.7, 1.7]) {
    const points: Array<{ x: number; z: number; width: number }> = [];
    for (let x = -248; x <= 248; x += 8) {
      points.push({ x, z: z + Math.sin((x + z) * 0.035) * 0.28, width: 1.55 });
    }
    b.surfacePath(points, 'dirt', 0.012);
    b.surfacePath(points.map((point) => ({ ...point, width: 0.42 })), 'rock', 0.026);
  }
  for (const x of [-192, -128, -64, 64, 128, 192]) {
    for (const z of [-12.05, 2.05]) {
      const y = terrainH(x, z);
      b.box(x, y + 0.2, z, 1.9, 0.52, 0.24, 'concreteDark', 0, { noCollide: true });
      b.box(x, y + 0.17, z + (z < 0 ? 0.02 : -0.02), 0.78, 0.28, 0.255, 'metalDark', 0, {
        noCollide: true,
      });
      for (const side of [-1, 1]) {
        b.box(x + side * 1.02, y + 0.15, z, 0.18, 0.42, 0.72, 'concreteDark', 0, { noCollide: true });
      }
    }
  }
}

function sunwallMarket(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  const blocks: Array<[number, number, number, number, number]> = [
    [-23, -20, 15, 14, 2], [-4, -20, 13, 15, 2], [18, -18, 16, 13, 3],
    [-22, 7, 14, 16, 2], [2, 8, 16, 14, 2], [23, 8, 12, 16, 2],
    [-9, 30, 18, 12, 1], [16, 31, 14, 12, 2],
  ];
  for (let i = 0; i < blocks.length; i++) {
    const [ox, oz, w, d, floors] = blocks[i]!;
    const x = cx + ox;
    const z = cz + oz;
    const baseY = structureBaseY(terrainH, x, z, w, d);
    addBuilding(b, {
      x, z, baseY, w, d, floors,
      wallMat: i % 3 === 0 ? 'plasterOld' : i % 3 === 1 ? 'plaster' : 'concrete',
      trimMat: 'woodDark', floorMat: 'concreteDark', roofMat: 'concrete',
      doors: [[i % 2 ? 1 : 0, Math.max(3, (i % 2 ? d : w) * 0.45), 2.4]],
      roofAccess: floors > 1,
      interiorDividers: floors > 1,
    });
    // Rooftop water/service silhouettes and facade drainage make the compact
    // blocks read as maintained market buildings rather than repeated boxes.
    if (i % 2 === 0) {
      const roofY = baseY + floors * 3.6;
      b.box(x + w * 0.22, roofY + 0.16, z - d * 0.18, 2.8, 0.32, 2.2, 'metalDark');
      b.cyl(x + w * 0.22, roofY + 1.05, z - d * 0.18, 0.85, 1.65, 'metal', { segments: 14 });
    }
    b.cyl(x + w / 2 + 0.16, baseY + 1.65, z + d * 0.22, 0.08, 3.3, 'metalDark', {
      segments: 8,
      noCollide: true,
    });
  }
  // A framed southern gateway marks the only five-metre gap between the first
  // row of buildings. Previously the approach terminated in a blank plaster
  // wall with no visual cue toward the market lanes behind it.
  const entryX = cx - 13;
  const entryZ = cz - 27.4;
  const entryY = terrainH(entryX, entryZ);
  for (const side of [-1, 1]) {
    b.box(entryX + side * 2.15, entryY + 1.65, entryZ, 0.22, 3.3, 0.28, 'woodDark', 0, { noCollide: true });
  }
  b.box(entryX, entryY + 3.18, entryZ, 4.6, 0.24, 0.32, 'woodDark', 0, { noCollide: true });
  b.box(entryX, entryY + 2.83, entryZ - 0.04, 2.7, 0.5, 0.12, 'rust', 0, { noCollide: true });
  // Original geometric market mark; avoids a featureless glowing rectangle
  // while remaining language-neutral and legible at combat distance.
  b.box(entryX - 0.72, entryY + 2.83, entryZ - 0.108, 0.16, 0.3, 0.035, 'paint', 0, { noCollide: true });
  b.box(entryX - 0.4, entryY + 2.92, entryZ - 0.108, 0.48, 0.09, 0.035, 'paint', 0, { noCollide: true });
  b.box(entryX - 0.4, entryY + 2.73, entryZ - 0.108, 0.48, 0.09, 0.035, 'paint', 0, { noCollide: true });
  b.box(entryX + 0.48, entryY + 2.83, entryZ - 0.108, 0.82, 0.09, 0.035, 'signDimOrange', 0, { noCollide: true });
  b.box(entryX, entryY + 3.05, entryZ + 1.2, 5.1, 0.12, 2.5, 'corrugated', 0, { noCollide: true });
  b.light(entryX, entryY + 2.65, entryZ + 0.3, 0xffc07a, 0.85, 9);
  // Overhead service cables and alternating shade panels add depth cues along
  // the inner market lane without obstructing player or projectile movement.
  for (let i = -2; i <= 2; i++) {
    const laneZ = cz - 12 + i * 6;
    b.box(cx, terrainH(cx, laneZ) + 3.65, laneZ, 34, 0.045, 0.045, 'metalDark', 0, { noCollide: true });
    if (i % 2 === 0) {
      b.box(cx - 3, terrainH(cx - 3, laneZ) + 3.35, laneZ, 11, 0.08, 3.3, i === 0 ? 'rust' : 'corrugated', 0, {
        noCollide: true,
      });
    }
  }
  // Market arcade: shaded stalls, fabric-like awnings and waist-high cover.
  for (let i = -3; i <= 3; i++) {
    const x = cx + i * 5.2;
    const y = terrainH(x, cz + 2);
    b.box(x, y + 1.45, cz + 2, 4.4, 0.14, 3.2, i % 2 ? 'rust' : 'corrugated', 0, { noCollide: true });
    b.box(x - 1.9, y + 0.7, cz + 2, 0.18, 1.4, 0.18, 'woodDark');
    b.box(x + 1.9, y + 0.7, cz + 2, 0.18, 1.4, 0.18, 'woodDark');
    if (i % 2 === 0) b.crate(x, y + 0.1, cz + 3.4, 0.75);
  }
  b.chest(cx + 5, terrainH(cx + 5, cz + 2) + 0.3, cz + 2, 'vault');
  b.chest(cx - 25, terrainH(cx - 25, cz - 2) + 0.3, cz - 2, 'standard');
  b.loot(cx + 24, terrainH(cx + 24, cz + 14) + 0.4, cz + 14, 'weapon');
  b.loot(cx - 7, terrainH(cx - 7, cz - 14) + 0.4, cz - 14, 'heal');
  // Keep storage against the district perimeter. Random scatter previously
  // put a full-size crate in the only southern gateway, turning the landmark
  // cue into an obstacle and blocking the first view down the market lane.
  const storage: Array<[number, number, number]> = [
    [-34, -27, 0.68], [32, -24, 0.76],
    [-30, -7, 0.58], [31, -7, 0.72],
    [-33, 20, 0.8], [32, 20, 0.62],
    [-28, 39, 0.7], [27, 39, 0.66],
  ];
  for (const [ox, oz, scale] of storage) {
    const x = cx + ox;
    const z = cz + oz;
    b.crate(x, terrainH(x, z) + 0.1, z, scale);
  }
  void rng;
}

function relayMesa(b: WorldBuilder, cx: number, cz: number): void {
  const baseY = structureBaseY(terrainH, cx, cz, 22, 20);
  // Two buried terrace courses seat the relay into the mesa. They are visual
  // retaining work rather than an extra walk surface, so they cannot alter
  // the already validated door, stair or capsule route.
  b.box(cx, baseY - 0.3, cz, 25, 0.65, 23, 'concreteDark', 0, { noCollide: true });
  b.box(cx, baseY - 0.82, cz, 28, 0.45, 26, 'stoneBrick', 0, { noCollide: true });
  addBuilding(b, {
    x: cx, z: cz, baseY, w: 22, d: 20, floors: 2, floorHeight: 3.8,
    wallMat: 'concrete', trimMat: 'metalDark', roofMat: 'concreteDark',
    doors: [[0, 9, 2.6]], roofAccess: true, interiorDividers: true,
  });
  // Communications mast, dish and guyed service frame — no faction marks.
  b.box(cx, baseY + 15, cz, 0.7, 22, 0.7, 'metalDark');
  // A four-leg service frame, maintenance stages and sector panels make the
  // mast read as a supported communications structure instead of one black
  // pole intersecting a generic roof slab.
  for (const dx of [-1.15, 1.15]) {
    for (const dz of [-1.15, 1.15]) {
      b.box(cx + dx, baseY + 15.7, cz + dz, 0.22, 14.8, 0.22, 'metal', 0, { noCollide: true });
    }
  }
  for (const levelY of [baseY + 9.1, baseY + 13.4, baseY + 17.7, baseY + 22]) {
    b.box(cx, levelY, cz - 1.15, 2.55, 0.16, 0.16, 'metal', 0, { noCollide: true });
    b.box(cx, levelY, cz + 1.15, 2.55, 0.16, 0.16, 'metal', 0, { noCollide: true });
    b.box(cx - 1.15, levelY, cz, 0.16, 0.16, 2.55, 'metal', 0, { noCollide: true });
    b.box(cx + 1.15, levelY, cz, 0.16, 0.16, 2.55, 'metal', 0, { noCollide: true });
  }
  for (const yaw of [0, Math.PI / 2]) {
    b.box(cx, baseY + 17, cz, 8, 0.18, 0.18, 'metal', yaw, { noCollide: true });
  }
  for (const [ox, oz, yaw] of [[-2.1, 0, 0], [2.1, 0, 0], [0, -2.1, Math.PI / 2]] as Array<[number, number, number]>) {
    b.box(cx + ox, baseY + 19.6, cz + oz, 1.35, 2.7, 0.16, 'metal', yaw, { noCollide: true });
    b.box(cx + ox, baseY + 19.6, cz + oz, 0.12, 3.05, 1.65, 'metalDark', yaw, { noCollide: true });
  }
  b.cyl(cx + 4.8, baseY + 10.5, cz - 1.5, 2.4, 0.35, 'metal', { segments: 16, noCollide: true });
  b.box(cx + 4.8, baseY + 9.2, cz - 1.5, 0.35, 3, 0.35, 'metalDark');
  // Ground-floor entry canopy and two service cabinets establish the public
  // face seen from the southeast approach without narrowing the 2.6 m door.
  const entryX = cx - 0.7;
  const entryZ = cz + 10.9;
  b.box(entryX, baseY + 3.05, entryZ + 0.55, 5.8, 0.24, 3.1, 'metalDark', 0, { noCollide: true });
  for (const side of [-1, 1]) {
    b.box(entryX + side * 2.45, baseY + 1.48, entryZ + 0.8, 0.2, 2.95, 0.2, 'metal', 0, { noCollide: true });
  }
  b.box(cx - 7.6, baseY + 1.1, cz + 10.65, 2.5, 2.2, 0.85, 'metalDark', 0, { noCollide: true });
  b.box(cx + 7.2, baseY + 1.1, cz + 10.65, 2.5, 2.2, 0.85, 'metalDark', 0, { noCollide: true });
  for (let i = -2; i <= 2; i++) {
    b.box(cx + i * 4.5, baseY + 0.7, cz + 14, 3.5, 1.4, 1.1, 'concreteDark');
  }
  b.chest(cx - 6, baseY + 7.5, cz + 4, 'vault');
  b.loot(cx + 5, baseY + 0.5, cz + 4, 'weapon');
  b.vehicle(cx + 19, cz + 8, terrainH(cx + 19, cz + 8) + 0.2, -0.7, 'van', 0x6e705e);
}

function dustlineWorks(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  const warehouses: Array<[number, number, number, number]> = [
    [-22, -13, 24, 14], [10, -14, 26, 16], [-46, -2, 20, 14], [18, 48, 22, 14],
  ];
  for (let i = 0; i < warehouses.length; i++) {
    const [ox, oz, w, d] = warehouses[i]!;
    const x = cx + ox;
    const z = cz + oz;
    addBuilding(b, {
      x, z, baseY: structureBaseY(terrainH, x, z, w, d), w, d, floors: 1, floorHeight: 5.4,
      wallMat: i % 2 ? 'corrugated' : 'plasterOld', trimMat: 'rust',
      doors: [[0, w / 2 - 2, 4.2], [2, 2, 2.6]], windows: false, interiorDividers: false,
    });
  }
  // Gantry and stacked service pipes establish medium-range industrial lanes.
  b.box(cx, terrainH(cx, cz) + 5.2, cz, 34, 0.5, 1.2, 'rust');
  for (const x of [cx - 15, cx, cx + 15]) b.box(x, terrainH(x, cz) + 2.6, cz, 0.7, 5.2, 0.7, 'metalDark');
  for (let i = 0; i < 9; i++) {
    const x = cx + rng.range(-32, 32);
    const z = cz + rng.range(-30, 30);
    b.crate(x, terrainH(x, z) + 0.1, z, rng.range(0.65, 1));
  }
  b.chest(cx + 13, terrainH(cx + 13, cz + 4) + 0.3, cz + 4, 'elite');
  b.chest(cx - 30, terrainH(cx - 30, cz + 23) + 0.3, cz + 23, 'standard');
  b.loot(cx - 4, terrainH(cx - 4, cz - 3) + 0.4, cz - 3, 'ammo');
  b.vehicle(cx + 34, cz - 8, terrainH(cx + 34, cz - 8) + 0.2, Math.PI / 2, 'truck', 0x70563b);
  b.vehicle(cx - 35, cz + 4, terrainH(cx - 35, cz + 4) + 0.2, -0.4, 'wrecked', 0x403a31);
}

function wadiCrossing(b: WorldBuilder, cx: number, cz: number): void {
  const deckY = Math.max(terrainH(cx, cz - 25), terrainH(cx, cz + 25)) + 0.7;
  b.slab(cx, deckY, cz, 13, 55, 0.8, 'concrete');
  for (const z of [cz - 20, cz, cz + 20]) {
    // Pier tops stop 4 cm under the deck surface so the flush concrete faces
    // never z-fight across the 1x1 pier footprints.
    b.box(cx - 5, deckY - 3.02, z, 1, 5.96, 1, 'concrete');
    b.box(cx + 5, deckY - 3.02, z, 1, 5.96, 1, 'concrete');
  }
  for (const x of [cx - 6, cx + 6]) b.box(x, deckY + 0.55, cz, 0.35, 1.1, 55, 'concrete');
  b.chest(cx - 3, deckY + 0.3, cz + 12, 'elite');
  b.loot(cx + 3, deckY + 0.4, cz - 11, 'weapon');
  // Debris and abandoned crossing traffic.
  b.vehicle(cx + 3, cz + 26, deckY + 0.15, 0.1, 'wrecked', 0x4b443a);
  b.box(cx - 11, terrainH(cx - 11, cz + 4) + 0.6, cz + 4, 5, 1.2, 1.1, 'sandbag', 0.2);
}

function compoundWall(
  b: WorldBuilder,
  cx: number,
  cz: number,
  w: number,
  d: number,
  y: number,
  mat: MatKey,
): void {
  // The construction pad is levelled to the footprint's high point. Extend
  // the perimeter below that pad so rolling terrain cannot expose a metre-wide
  // air gap beneath the wall; keep the authored wall top and doorway height.
  let lowestPerimeter = Infinity;
  const perimeterSamples = 24;
  for (let i = 0; i <= perimeterSamples; i++) {
    const t = i / perimeterSamples;
    const x = cx - w / 2 + w * t;
    const z = cz - d / 2 + d * t;
    lowestPerimeter = Math.min(
      lowestPerimeter,
      terrainH(x, cz - d / 2),
      terrainH(x, cz + d / 2),
      terrainH(cx - w / 2, z),
      terrainH(cx + w / 2, z),
    );
  }
  const foundationDepth = Math.max(1.35, y - lowestPerimeter + 0.35);
  const wallHeight = 3.2 + foundationDepth;
  const wallBase = y - foundationDepth;
  b.wallWithGaps(cx - w / 2, cz - d / 2, w, wallHeight, 0.55, 'x', mat, [[w / 2 - 2, 4]], 0, wallBase);
  b.wallWithGaps(cx - w / 2, cz + d / 2, w, wallHeight, 0.55, 'x', mat, [], 0, wallBase);
  b.wallWithGaps(cx - w / 2, cz - d / 2, d, wallHeight, 0.55, 'z', mat, [], 0, wallBase);
  b.wallWithGaps(cx + w / 2, cz - d / 2, d, wallHeight, 0.55, 'z', mat, [[d / 2 - 1.5, 3]], 0, wallBase);
}

function kestrelCompound(b: WorldBuilder, cx: number, cz: number): void {
  const y = structureBaseY(terrainH, cx, cz, 44, 40);
  // 52 m wide, not 46: the main building's outer fire-escape flight hangs on
  // the west facade at cx-23.2, and the former wall line ran straight through
  // the flight, leaving its top ridge as the only descent surface.
  compoundWall(b, cx, cz, 52, 42, y, 'concrete');
  addBuilding(b, {
    x: cx - 10, z: cz - 6, baseY: y, w: 18, d: 16, floors: 2,
    wallMat: 'concrete', trimMat: 'metalDark', doors: [[0, 8, 2.6]], roofAccess: true,
  });
  addBuilding(b, {
    x: cx + 12, z: cz + 9, baseY: y, w: 14, d: 12, floors: 1,
    wallMat: 'plasterOld', trimMat: 'concrete', doors: [[2, 5, 2.4]], interiorDividers: false,
  });
  for (let i = -3; i <= 3; i++) b.box(cx + i * 4.6, y + 0.55, cz + 18, 3.7, 1.1, 0.8, 'sandbag');
  chestPad(b, cx - 4, cz + 8, y, 'vault');
  b.loot(cx + 14, y + 0.4, cz - 8, 'heal');
  b.vehicle(cx + 28, cz - 13, terrainH(cx + 28, cz - 13) + 0.2, 0.2, 'van', 0x66685a);
}

function dryCanals(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  // Abandoned concrete irrigation channels and broken field partitions.
  for (let i = -3; i <= 3; i++) {
    const z = cz + i * 8;
    // Short overlapping beds follow the rolling field. The former single
    // 58 m slab inherited only its centre height and floated by over 2 m at
    // the east end.
    for (let x = cx - 27; x <= cx + 27; x += 4.5) {
      b.box(x, terrainH(x, z) + 0.03, z, 4.7, 0.18, 2, 'concreteDark', 0, { floor: true });
    }
    for (const x of [cx - 29, cx + 29]) b.box(x, terrainH(x, z) + 0.45, z, 0.5, 0.9, 2.2, 'concrete');
  }
  const shedY = structureBaseY(terrainH, cx - 18, cz - 22, 16, 12);
  addBuilding(b, {
    x: cx - 18, z: cz - 22, baseY: shedY, w: 16, d: 12, floors: 1,
    wallMat: 'plasterOld', trimMat: 'woodDark', doors: [[0, 6, 2.6]], interiorDividers: false,
  });
  // Date-palm remnants cluster along the old water line rather than scatter uniformly.
  for (let cluster = 0; cluster < 4; cluster++) {
    const bx = cx - 24 + cluster * 16;
    for (let i = 0; i < 5; i++) {
      const x = bx + rng.range(-4, 4);
      const z = cz + rng.range(-26, 26);
      b.tree({ x, z, y: terrainH(x, z), scale: rng.range(0.8, 1.25), variant: i % 4 === 0 ? 'dead' : 'palm' });
    }
  }
  chestPad(
    b,
    cx + 16,
    cz + 18,
    structureBaseY(terrainH, cx + 16, cz + 18, 3, 2.4),
    'elite',
  );
  b.loot(cx - 12, terrainH(cx - 12, cz + 8) + 0.4, cz + 8, 'heal');
  b.vehicle(cx + 23, cz - 25, terrainH(cx + 23, cz - 25) + 0.2, 1.2, 'truck', 0x786145);
}

function fuelCourt(b: WorldBuilder, cx: number, cz: number): void {
  const y = structureBaseY(terrainH, cx, cz, 42, 34);
  // Give the isolated compound a readable public/service approach. These
  // terrain-following ribbons add no collision shelf and retain the full
  // vehicle/player gate width while breaking up the otherwise empty sand.
  const approachSouthZ = cz - 46;
  const approachGateZ = cz - 19.2;
  b.surfacePath([
    { x: cx, z: approachSouthZ, width: 13 },
    { x: cx, z: approachGateZ, width: 13 },
  ], 'asphaltDesert', 0.065);
  for (const side of [-1, 1]) {
    b.surfacePath([
      { x: cx + side * 5.35, z: approachSouthZ + 1, width: 0.14 },
      { x: cx + side * 5.35, z: approachGateZ - 0.5, width: 0.14 },
    ], 'paint', 0.082);
  }

  // Paired approach lights sit beyond the paved edges. Their physical pole
  // proxies are narrow and deliberately outside the clear carriageway.
  for (const side of [-1, 1]) {
    const lampX = cx + side * 8.4;
    const lampZ = cz - 31;
    b.lampPost(lampX, lampZ, terrainH(lampX, lampZ), 7.2, 0xffc27a, 1.75, 24);
  }

  // Grounded, non-branded status pylon: a concrete footing carries the
  // actual silhouette while thin display inserts remain presentation-only.
  const statusX = cx + 10.2;
  const statusZ = cz - 29.5;
  const statusY = terrainH(statusX, statusZ);
  b.box(statusX, statusY + 0.22, statusZ, 1.25, 0.44, 1.25, 'concreteDark');
  b.box(statusX, statusY + 2.35, statusZ, 0.28, 4.25, 0.28, 'metalDark', 0, { noCollide: true });
  b.box(statusX, statusY + 3.55, statusZ, 3.1, 2.15, 0.24, 'metalDark', 0, { noCollide: true });
  for (const [offsetY, mat] of [[4.05, 'neonOrange'], [3.52, 'windowCool'], [2.99, 'neonOrange']] as Array<[number, MatKey]>) {
    b.box(statusX, statusY + offsetY, statusZ - 0.14, 2.45, 0.16, 0.06, mat, 0, { noCollide: true });
  }
  compoundWall(b, cx, cz, 44, 36, y, 'concrete');
  for (const [ox, oz] of [[-11, -7], [0, -7], [11, -7], [-6, 7], [7, 7]] as Array<[number, number]>) {
    const tankX = cx + ox;
    const tankZ = cz + oz;
    let footingBottom = terrainH(tankX, tankZ);
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      footingBottom = Math.min(
        footingBottom,
        terrainH(tankX + Math.cos(angle) * 4.1, tankZ + Math.sin(angle) * 4.1),
      );
    }
    footingBottom -= 0.18;
    // The court is levelled to the highest point of its full footprint. On
    // the downhill row that left tanks hovering up to ~1.8 m above terrain.
    // A stepped physical footing reaches the local low point, while the wider
    // thin cap keeps the authored tank silhouette and sheds the terrain seam.
    b.cyl(tankX, (footingBottom + y) / 2, tankZ, 3.95, y - footingBottom, 'concreteDark', { segments: 18 });
    b.cyl(tankX, y + 2.6, tankZ, 3.6, 5.2, 'rust', { segments: 18 });
    for (const bandY of [y + 1.2, y + 4.15]) {
      b.cyl(tankX, bandY, tankZ, 3.64, 0.12, 'metalExterior', { segments: 18, noCollide: true });
    }
    b.box(tankX + 3.66, y + 2.55, tankZ, 0.14, 4.25, 0.18, 'metalExterior', 0, { noCollide: true });
    b.box(tankX, y + 5.5, tankZ, 4.5, 0.2, 0.35, 'metalDark', 0, { noCollide: true });
    b.cyl(tankX, y + 0.18, tankZ, 4.25, 0.36, 'concreteDark', { segments: 18, noCollide: true });
  }
  // Short service bridges join the three front-row tanks at their reinforced
  // top band. They span only the real gap between shells and carry thin
  // guardrails, avoiding the unsupported floating beam silhouette.
  for (const bridgeX of [cx - 5.5, cx + 5.5]) {
    // The deck is visible and presented as traversable, so it must remain a
    // real support collider. Only the sub-capsule handrail detail is visual.
    b.box(bridgeX, y + 5.34, cz - 7, 4.15, 0.18, 1.0, 'metalExterior');
    for (const railZ of [cz - 7.5, cz - 6.5]) {
      b.box(bridgeX, y + 5.92, railZ, 4.15, 0.08, 0.08, 'metalDark', 0, { noCollide: true });
      for (const postX of [bridgeX - 1.8, bridgeX, bridgeX + 1.8]) {
        b.box(postX, y + 5.69, railZ, 0.08, 0.54, 0.08, 'metalDark', 0, { noCollide: true });
      }
      // Guard envelope along each visible rail so the tank-top walkway cannot
      // be walked off sideways.
      b.guardRail(
        { x: bridgeX - 4.15 / 2, z: railZ },
        { x: bridgeX + 4.15 / 2, z: railZ },
        y + 5.3,
        y + 5.95,
      );
    }
  }
  // The southern opening now reads as an industrial gate: grounded jambs,
  // overhead service canopy and inset hazard bands frame the proven 4 m clear
  // route. Thin presentation members never become invisible collision snags.
  for (const side of [-1, 1]) {
    const px = cx + side * 5.2;
    b.box(px, y + 2.1, cz - 18.25, 1.15, 4.2, 1.25, 'concreteDark');
    b.box(px, y + 3.05, cz - 18.92, 0.72, 0.28, 0.08, 'neonOrange', 0, { noCollide: true });
    b.box(px, y + 2.35, cz - 18.92, 0.72, 0.28, 0.08, 'metalDark', 0, { noCollide: true });
    b.box(px, y + 1.65, cz - 18.92, 0.72, 0.28, 0.08, 'neonOrange', 0, { noCollide: true });
  }
  b.box(cx, y + 4.25, cz - 18.2, 12.2, 0.42, 2.5, 'metalDark', 0, { noCollide: true });
  b.box(cx, y + 4.05, cz - 19.48, 7.2, 0.22, 0.16, 'neonOrange', 0, { noCollide: true });
  // External transfer pipes and valve risers make the blank perimeter wall
  // communicate the compound's purpose while staying outside the doorway.
  for (const side of [-1, 1]) {
    const pipeX = cx + side * 12.5;
    b.box(pipeX, y + 1.12, cz - 18.65, 10.5, 0.28, 0.28, 'rust', 0, { noCollide: true });
    for (const dx of [-4.2, 0, 4.2]) {
      b.cyl(pipeX + dx, y + 1.28, cz - 18.65, 0.24, 2.15, 'metal', { segments: 10, noCollide: true });
      b.cyl(pipeX + dx, y + 2.42, cz - 18.65, 0.5, 0.12, 'neonOrange', { segments: 12, noCollide: true });
    }
  }
  b.box(cx, y + 5.8, cz + 14, 27, 0.45, 2, 'metalDark');
  for (const x of [cx - 12, cx, cx + 12]) b.box(x, y + 3, cz + 14, 0.45, 6, 0.45, 'metalDark');
  // A supported solar/service canopy turns the rear pipe rack into a legible
  // maintenance bay. Tilted reflective modules, cross-bracing and local
  // control cabinets add silhouette and purpose without changing circulation.
  for (const offset of [-10, -5, 0, 5, 10]) {
    b.box(cx + offset, y + 6.18, cz + 14, 4.4, 0.12, 2.45, 'windowCool', 0, {
      noCollide: true,
      pitch: -0.11,
    });
  }
  for (const side of [-1, 1]) {
    b.box(cx + side * 6, y + 3.05, cz + 13.78, 0.18, 5.45, 0.18, 'metal', 0, { noCollide: true });
    b.box(cx + side * 6, y + 3.25, cz + 14.18, 0.12, 5.8, 0.12, 'rust', 0, {
      noCollide: true,
      roll: side * 0.38,
    });
  }
  for (const x of [cx - 8.4, cx + 8.4]) {
    b.box(x, y + 1.05, cz + 12.85, 1.65, 2.1, 0.72, 'metalDark', 0, { noCollide: true });
    for (const louverY of [0.55, 0.95, 1.35]) {
      b.box(x, y + louverY, cz + 12.46, 1.1, 0.08, 0.05, 'metal', 0, { noCollide: true });
    }
  }
  chestPad(b, cx + 15, cz + 13, y, 'vault');
  b.loot(cx - 15, y + 0.4, cz + 12, 'ammo');
}

function southCheckpoint(b: WorldBuilder, cx: number, cz: number): void {
  const y = terrainH(cx, cz);
  for (const x of [cx - 14, cx + 14]) {
    b.box(x, y + 1.6, cz, 8, 3.2, 5, 'plasterOld');
    b.box(x, y + 3.5, cz, 9, 0.35, 6, 'corrugated');
  }
  for (let i = -4; i <= 4; i++) {
    if (Math.abs(i) <= 1) continue;
    b.box(cx + i * 3.2, y + 0.5, cz - 8, 3, 1, 0.9, 'sandbag', i * 0.02);
  }
  b.box(cx, y + 4.8, cz + 4, 0.5, 9.6, 0.5, 'metalDark');
  b.box(cx, y + 8.8, cz + 4, 7, 0.3, 0.3, 'metal', 0, { noCollide: true });
  b.chest(cx + 12, y + 0.3, cz + 7, 'elite');
  b.loot(cx - 11, y + 0.4, cz + 8, 'weapon');
  b.vehicle(cx + 2, cz + 14, terrainH(cx + 2, cz + 14) + 0.2, Math.PI / 2, 'wrecked', 0x453d34);
}

function ridgeBunkers(b: WorldBuilder, cx: number, cz: number): void {
  const sites: Array<[number, number, number]> = [[-14, -5, 0], [10, 7, Math.PI], [1, 25, Math.PI / 2]];
  for (let i = 0; i < sites.length; i++) {
    const [ox, oz] = sites[i]!;
    const x = cx + ox;
    const z = cz + oz;
    const y = structureBaseY(terrainH, x, z, 14, 10);
    addBuilding(b, {
      x, z, baseY: y, w: 14, d: 10, floors: 1, floorHeight: 3,
      wallMat: 'concreteDark', trimMat: 'concrete', roofMat: 'concreteDark',
      doors: [[i % 2 ? 2 : 0, 5, 2.4]], windows: false, interiorDividers: false, parapet: true,
    });
    b.box(x, y + 3.45, z, 16, 0.65, 12, 'dirt', 0, { noCollide: true });
  }
  // Zig-zag trench cover between bunkers.
  const trench: Array<[number, number, number]> = [[-11, 15, 0.25], [-2, 17, -0.25], [7, 18, 0.22], [15, 19, -0.2]];
  for (const [ox, oz, yaw] of trench) {
    b.box(cx + ox, terrainH(cx + ox, cz + oz) + 0.48, cz + oz, 9.5, 0.95, 0.7, 'sandbag', yaw);
  }
  b.chest(cx + 10, terrainH(cx + 10, cz + 7) + 0.3, cz + 7, 'vault');
  b.loot(cx - 8, terrainH(cx - 8, cz + 14) + 0.4, cz + 14, 'ammo');
}

function caravanserai(b: WorldBuilder, cx: number, cz: number): void {
  const y = structureBaseY(terrainH, cx, cz, 38, 34);
  compoundWall(b, cx, cz, 40, 36, y, 'bricksOld');
  for (const [ox, oz, side] of [[-12, -11, 0], [10, -11, 0], [-12, 10, 2], [10, 10, 2]] as Array<[number, number, 0 | 2]>) {
    addBuilding(b, {
      x: cx + ox, z: cz + oz, baseY: y, w: 13, d: 9, floors: 1,
      wallMat: 'plasterOld', trimMat: 'woodDark', doors: [[side, 4, 2.2]],
      windows: false, interiorDividers: false,
    });
  }
  b.cyl(cx, y + 0.55, cz, 4.2, 1.1, 'stoneBrick', { segments: 18 });
  b.chest(cx, y + 1.4, cz, 'elite');
  b.loot(cx + 14, y + 0.4, cz + 2, 'heal');
}

function roadsideInfrastructure(b: WorldBuilder, rng: Rng): void {
  // Utility poles follow the highway; conductors are visual-only dark spans.
  for (let x = -220; x <= 220; x += 28) {
    const z = -17;
    const y = terrainH(x, z);
    b.box(x, y + 4.2, z, 0.35, 8.4, 0.35, 'woodDark');
    b.box(x, y + 7.9, z, 5.4, 0.22, 0.22, 'woodDark', 0, { noCollide: true });
  }
  for (let i = 0; i < 10; i++) {
    const x = rng.range(-220, 220);
    const z = rng.bool() ? rng.range(-105, -28) : rng.range(70, 225);
    const y = terrainH(x, z);
    b.box(x, y + 1.1, z, 3.2, 2.2, 0.3, 'rust', rng.range(-0.4, 0.4));
    b.box(x, y + 2.3, z, 0.25, 2.6, 0.25, 'metalDark');
  }
  for (const [x, z, yaw, variant] of [
    [-118, -12, 0.1, 'wrecked'], [78, -13, -0.2, 'sedan'], [220, -18, 0.4, 'truck'],
    [-232, 86, 1.3, 'van'], [108, 188, -0.8, 'wrecked'],
  ] as Array<[number, number, number, 'sedan' | 'van' | 'truck' | 'wrecked']>) {
    b.vehicle(x, z, terrainH(x, z) + 0.2, yaw, variant, variant === 'wrecked' ? 0x3c342d : 0x756148);
  }
}

function desertScatter(b: WorldBuilder, rng: Rng): void {
  const exclusions = b.def.pois.map((poi) => ({ x: poi.x, z: poi.z, r: poi.radius + 7 }));
  // Keep the authored travel corridors readable and physically traversable.
  // POI-only exclusions previously allowed large deterministic scatter rocks
  // to land in the highway carriageway (including directly on its centre
  // line), even though the road itself is a registered walkable platform.
  for (let x = -240; x <= 240; x += 12) exclusions.push({ x, z: -5, r: 6.4 });
  for (let z = 72; z <= 240; z += 12) exclusions.push({ x: 42, z, r: 5.4 });
  scatterRocks(b, rng, 105, { minX: -242, maxX: 242, minZ: -242, maxZ: 242 }, exclusions, terrainH);

  // Sparse ecological clusters: palms near dry canals, dead scrub in wadis,
  // and exposed ridges left bare for long-range readability.
  for (let cluster = 0; cluster < 12; cluster++) {
    const bx = rng.range(-225, 225);
    const wadiZ = 42 + Math.sin(bx * 0.018) * 18 + Math.sin(bx * 0.006 + 1.2) * 9;
    const bz = wadiZ + rng.range(-10, 10);
    if (exclusions.some((e) => Math.hypot(bx - e.x, bz - e.z) < e.r)) continue;
    for (let i = 0; i < rng.int(2, 5); i++) {
      const x = bx + rng.range(-5, 5);
      const z = bz + rng.range(-5, 5);
      b.tree({ x, z, y: terrainH(x, z), scale: rng.range(0.55, 0.95), variant: 'dead' });
    }
  }
}
