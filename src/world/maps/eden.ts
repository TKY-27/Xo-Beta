/**
 * EDEN FACILITY — overgrown nature reclaiming a research site, bright day.
 * Lake + river swimming routes, research complex, dormitories, water
 * treatment with underground level, cliffs, greenhouses, docks.
 */

import { planStairs, WorldBuilder } from '../builder';
import type { MapDef } from '../types';
import { Rng } from '../../core/rng';
import { addBuilding, hardenExposedFlanks, scatterRocks, scatterTrees, structureBaseY } from './common';

const S = 500;

function terrainH(x: number, z: number): number {
  let h = Math.sin(x * 0.018) * 0.4 + Math.cos(z * 0.02) * 0.35;
  // Lake basin (water volume handles the surface; bed sits below). The old
  // 6 m depression exposed only a tiny patch of a 145x150 m water volume;
  // broaden/deepen it so the visible shoreline matches the advertised lake.
  const ld = Math.hypot(x - 140, z - 60);
  if (ld < 100) {
    h -= (1 - ld / 100) * 8;
  }

  // The authored river water used to sit four metres below completely flat
  // terrain, making the whole channel invisible and non-traversable. Carve a
  // real bed for the exact rectangular water volume, with a 12 m outer bank.
  const rdx = Math.max(150 - x, 0, x - 190);
  const rdz = Math.max(135 - z, 0, z - 165);
  const riverOutside = Math.hypot(rdx, rdz);
  const inRiver = x >= 150 && x <= 190 && z >= 135 && z <= 165;
  if (inRiver) {
    h = Math.min(h, -5.35 + Math.sin(x * 0.11 + z * 0.07) * 0.12);
  } else if (riverOutside < 12) {
    const t = 1 - riverOutside / 12;
    const bed = -5.35 + Math.sin(x * 0.11 + z * 0.07) * 0.12;
    h = Math.min(h, h + (bed - h) * t * t * (3 - 2 * t));
  }

  // Pond water is in the south-west quadrant at z=+205. The old basin used
  // z=-205, so the visible water plane sat over flat land while an unrelated
  // dry crater appeared on the opposite side of the map.
  const pondD = Math.hypot(x + 220, z - 205);
  if (pondD < 52) {
    h -= (1 - pondD / 52) * 6.5;
  }
  return h;
}

export function buildEdenFacility(): MapDef {
  const rng = new Rng(0x3d3e + 11);
  const b = new WorldBuilder('eden', 'EDEN FACILITY', 'A lakeside research station swallowed by green. Daylight, water, and long sightlines.', S);

  // Ground surface is rendered by src/render/vista.ts (terrain mesh matching
  // this map's heightfield + beyond-bounds landscape).
  buildHeightfield(b);

  // Water: lake + river to the south
  b.water(70, 215, -15, 135, -4.2, 6, { kind: 'lake' });
  b.water(150, 190, 135, 165, -4.0, 5, { kind: 'river' });
  b.water(-248, -180, 180, 230, -3.8, 4, { kind: 'pond' });

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
  b.chest(-126, structureBaseY(terrainH, -130, 5, 20, 15) + 8.2, 2, 'elite');
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
  b.chest(-126, structureBaseY(terrainH, -125, 95, 22, 14) + 7.6, 97, 'elite');

  // ------------------------------------------------------------------
  // POI: WATER TREATMENT (underground facility, north-west)
  // ------------------------------------------------------------------
  b.poi('Water Treatment', -170, -120, 45);
  treatmentPlant(b, -170, -120);

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

  // Extra anchored chests — every minor site gets a reason to visit.
  b.chest(58, terrainH(58, 178) + 0.3, 178, 'standard');          // ranger cabin porch
  b.chest(-4, terrainH(-4, 29) + 0.3, 29, 'elite');               // greenhouse service path
  b.chest(146, terrainH(146, 68) + 0.3, 68, 'standard');          // dock shore path
  b.chest(-104, terrainH(-104, 118) + 0.3, 118, 'standard');      // dorm courtyard
  b.chest(-166, terrainH(-166, -128) + 0.3, -128, 'elite');       // treatment yard
  b.chest(224, terrainH(224, 96) + 0.3, 96, 'vault');             // meadow camp tents
  b.chest(158, terrainH(158, 152) + 0.3, 152, 'standard');        // south ford bank
  b.chest(-238, terrainH(-238, -62) + 0.3, -62, 'standard');      // pump house
  b.chest(-214, terrainH(-214, 36) + 0.3, 36, 'elite');           // generator yard

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

  forestLife(b, rng);

  decorateEden(b, rng);

  hardenExposedFlanks(b, { mat: 'concreteDark', maxProps: 36 });

  return b.finish(
    {
      preset: 'day',
      atmosphere: {
        // Readable daytime: blue zenith, lighter horizon, coherent sun disc,
        // soft cumulus, restrained aerial perspective.
        zenith: 0x2f6cb3, horizon: 0xa9c2d4,
        discSize: 0.036, discColor: 0xfff2d4, discGlow: 0.55,
        cloudCover: 0.42, cloudTint: 0xf2f5f7, cloudShade: 0x9fb2c4,
        windSpeed: 0.01, starOpacity: 0.0,
        hazeColor: 0xb9cdd8, hazeStrength: 0.34,
      },
      hdri: 'qwantani_puresky_2k.hdr',
      fogColor: 0xa9c2d4,
      fogDensity: 0.0013,
      sunDirection: [0.45, -0.8, 0.35],
      sunColor: 0xfff2dd,
      sunIntensity: 2.25,
      ambientColor: 0xb6ccd8,
      ambientIntensity: 0.46,
      hemisphereSky: 0xa8d4f0,
      hemisphereGround: 0x55663f,
      hemisphereIntensity: 1.2,
      exposure: 0.98,
      envIntensity: 0.9,
      backgroundBlurriness: 0.045,
      backgroundIntensity: 0.52,
      grade: {
        vignette: 0.28,
        saturation: 0.96,
        contrast: 1.02,
        lift: [0.004, 0.004, 0.002],
      },
    },
    { from: [-330, -140], to: [330, 130] },
  );
}

// ---------------------------------------------------------------------------
// Terrain heightfield registration
// ---------------------------------------------------------------------------

/**
 * Believable forest life: species-clustered woodland (pines on high ground,
 * oaks near water, dead snags in damp hollows), age/size variation, fallen
 * logs, stumps and boulder micro-outcrops. Cluster centers keep the forest
 * reading as grown, not scattered.
 */
function forestLife(b: WorldBuilder, rng: Rng): void {
  const clusters: Array<{ x: number; z: number; r: number; mix: Array<'pine' | 'oak' | 'dead'> }> = [
    { x: -220, z: -200, r: 70, mix: ['pine', 'pine', 'oak'] },
    { x: -30, z: -190, r: 60, mix: ['pine', 'oak', 'dead'] },
    { x: 90, z: -140, r: 65, mix: ['pine', 'pine', 'dead'] },
    { x: 210, z: 20, r: 55, mix: ['oak', 'oak', 'pine'] },
    { x: -230, z: 130, r: 60, mix: ['oak', 'pine'] },
    { x: 40, z: 120, r: 50, mix: ['oak', 'oak', 'pine'] },
    { x: 190, z: 215, r: 45, mix: ['oak', 'dead'] },
    { x: -160, z: 210, r: 40, mix: ['pine', 'oak', 'dead'] },
    // Infill: the west/center meadows between the original clusters read as
    // empty lawn; these smaller groves break up the open sightlines.
    { x: -150, z: 30, r: 46, mix: ['pine', 'oak'] },
    { x: -60, z: -75, r: 44, mix: ['pine', 'oak', 'dead'] },
    { x: 150, z: -35, r: 42, mix: ['oak', 'pine'] },
    { x: 60, z: 195, r: 38, mix: ['oak', 'oak', 'dead'] },
  ];
  for (const c of clusters) {
    const n = Math.round(c.r / 3.2);
    for (let i = 0; i < n; i++) {
      const a = rng.angle();
      const d = Math.sqrt(rng.next()) * c.r;
      const x = c.x + Math.cos(a) * d;
      const z = c.z + Math.sin(a) * d;
      if (Math.abs(x) > 244 || Math.abs(z) > 244) continue;
      // Keep out of water and facility cores.
      if (terrainH(x, z) < -2.5) continue;
      if (Math.hypot(x + 90, z + 20) < 55 || Math.hypot(x - 120, z - 40) < 34) continue;
      const variant = c.mix[rng.int(0, c.mix.length - 1)]!;
      // Age variation: saplings to old growth.
      b.tree({ x, z, y: terrainH(x, z), scale: rng.range(0.7, 1.7), variant });
    }
  }

  // Fallen logs (mossy horizontal trunks — real cover at waist height)
  for (let i = 0; i < 20; i++) {
    const lx = rng.range(-235, 235);
    const lz = rng.range(-235, 235);
    if (terrainH(lx, lz) < -1.5 || Math.hypot(lx + 90, lz + 20) < 58) continue;
    b.box(lx, terrainH(lx, lz) + 0.42, lz, rng.range(3.4, 5.6), 0.72, 0.78,
      rng.bool(0.6) ? 'woodDark' : 'wood', rng.angle());
    if (rng.bool(0.35)) b.loot(lx + rng.range(-2, 2), terrainH(lx, lz) + 0.4, lz + rng.range(-2, 2));
  }
  // Stumps from old logging
  for (let i = 0; i < 16; i++) {
    const sx = rng.range(-235, 235);
    const sz = rng.range(-235, 235);
    if (terrainH(sx, sz) < -1.5) continue;
    b.cyl(sx, terrainH(sx, sz) + 0.32, sz, rng.range(0.38, 0.6), rng.range(0.5, 0.85), 'woodDark');
  }
}

function buildHeightfield(b: WorldBuilder): void {
  // River banks and the lake shelf need finer triangles than the old ~8 m
  // grid; 128 keeps visual and Rapier contact within a few centimetres.
  const n = 128;
  const heights = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c / (n - 1)) * S - S / 2;
      const z = (r / (n - 1)) * S - S / 2;
      heights[r * n + c] = terrainH(x, z);
    }
  }
  b.def.heightfield = { n, heights };
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

function labMain(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 34, 24);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 34, d: 24, floors: 2, floorHeight: 4.2, wallMat: 'facadeA', trimMat: 'metal',
    floorMat: 'facilityFloor',
    doors: [[0, 10, 2.8], [0, 24, 2.8], [2, 17, 2.8], [1, 9, 2.8]], roofAccess: true,
  });
  // addBuilding's deep metal foundation remains the exterior plinth. Give the
  // occupied ground floor its own inset physical surface so the interior does
  // not inherit a metallic foundation top and its implausible reflection.
  b.slab(cx, gy + 0.1, cz, 33.2, 23.2, 0.04, 'facilityFloor');
  // Interior architectural services: the previous lab was an unlit empty box
  // with no visible reason for its scale. Ceiling luminaires, perimeter cable
  // trays, vertical utility risers and two real work benches establish a
  // maintained research space while preserving the door/stair circulation.
  for (let floor = 0; floor < 2; floor++) {
    const levelY = gy + floor * 4.2;
    for (const z of [cz - 6.5, cz, cz + 6.5]) {
      b.box(cx, levelY + 3.82, z, 7.2, 0.08, 0.22, 'signDimCyan', 0, { noCollide: true });
      b.light(cx, levelY + 3.55, z, 0xcfe8ff, 0.82, 10.5);
    }
    for (const wallZ of [cz - 11.65, cz + 11.65]) {
      b.box(cx, levelY + 2.72, wallZ, 27, 0.16, 0.18, 'metalDark', 0, { noCollide: true });
      b.box(cx, levelY + 0.18, wallZ, 32.2, 0.22, 0.16, 'metalDark', 0, { noCollide: true });
    }
    for (const x of [cx - 15.65, cx + 15.65]) {
      b.cyl(x, levelY + 1.45, cz - 8.8, 0.13, 2.9, 'metal', { segments: 10, noCollide: true });
      b.cyl(x, levelY + 1.45, cz + 8.8, 0.13, 2.9, 'metal', { segments: 10, noCollide: true });
    }
  }
  for (const benchX of [cx - 7, cx + 7]) {
    b.box(benchX, gy + 0.86, cz, 5.2, 0.16, 1.35, 'metal');
    for (const dx of [-2.25, 2.25]) {
      for (const dz of [-0.48, 0.48]) {
        b.box(benchX + dx, gy + 0.43, cz + dz, 0.18, 0.86, 0.18, 'metalDark');
      }
    }
    // Drawers, instrument screens and sample canisters turn each bare table
    // into a working laboratory station. They sit inside the physical bench
    // footprint and remain presentation-only, so the accepted circulation
    // lane and capsule clearance are unchanged.
    b.box(benchX, gy + 0.45, cz, 4.35, 0.62, 1.02, 'metalDark', 0, { noCollide: true });
    for (const monitorX of [benchX - 1.25, benchX + 1.25]) {
      b.box(monitorX, gy + 1.18, cz + 0.2, 0.12, 0.55, 0.12, 'metalDark', 0, { noCollide: true });
      b.box(monitorX, gy + 1.55, cz + 0.24, 1.22, 0.72, 0.1, 'metalDark', 0, { noCollide: true });
      b.box(monitorX, gy + 1.55, cz + 0.175, 0.98, 0.5, 0.035, 'signDimCyan', 0, { noCollide: true });
    }
    for (const sampleX of [benchX - 0.4, benchX, benchX + 0.4]) {
      b.cyl(sampleX, gy + 1.16, cz - 0.34, 0.09, 0.44, 'glass', { segments: 10, noCollide: true });
    }
  }
  // Four wall-side equipment cabinets provide scale and service logic while
  // leaving every doorway, stair and central route unobstructed.
  for (const wallX of [cx - 14.7, cx + 14.7]) {
    for (const cabinetZ of [cz - 6.5, cz + 6.5]) {
      b.box(wallX, gy + 1.05, cabinetZ, 1.25, 2.1, 2.4, 'metalDark', 0, { noCollide: true });
      b.box(wallX + (wallX < cx ? 0.64 : -0.64), gy + 1.42, cabinetZ, 0.035, 0.5, 0.9, 'signDimCyan', 0, {
        noCollide: true,
      });
    }
  }
  // Thin floor-zone markings define the central circulation lane and make the
  // room's scale readable from eye height without adding collision or glow.
  for (const x of [cx - 3.1, cx + 3.1]) {
    b.box(x, gy + 0.135, cz, 0.1, 0.015, 18, 'paint', 0, { noCollide: true });
  }
  for (const z of [cz - 5.5, cz + 5.5]) {
    b.box(cx, gy + 0.135, z, 6.3, 0.015, 0.1, 'paint', 0, { noCollide: true });
  }
  // Rooftop units
  b.box(cx + 8, gy + 9.4, cz - 4, 4, 1.6, 3, 'metalDark');
  b.loot(cx - 8, gy + 0.4, cz + 4);
  b.loot(cx + 6, gy + 0.4, cz - 6);
}

function labWing(b: WorldBuilder, cx: number, cz: number, doorSide: 0 | 1 | 2 | 3): void {
  const gy = structureBaseY(terrainH, cx, cz, 20, 15);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 20, d: 15, floors: 2, floorHeight: 4, wallMat: 'facadeC', trimMat: 'metalDark',
    doors: [[doorSide, 8, 2.4]],
  });
  // Deterministic exterior plant on the courtyard-facing elevation ties the
  // building to the apron drain below. The shallow cabinet, louvres, header
  // and downpipes add operational scale without narrowing circulation or
  // changing the proven building collider.
  const serviceZ = cz + 7.64;
  b.box(cx + 5.7, gy + 1.42, serviceZ, 2.25, 1.9, 0.14, 'metalDark', 0, { noCollide: true });
  for (const yOffset of [-0.58, -0.28, 0.02, 0.32, 0.62]) {
    b.box(cx + 5.7, gy + 1.42 + yOffset, serviceZ + 0.085, 1.78, 0.09, 0.06, 'metal', 0, {
      noCollide: true,
    });
  }
  b.box(cx, gy + 3.15, serviceZ + 0.03, 15.2, 0.16, 0.16, 'rust', 0, { noCollide: true });
  for (const pipeX of [cx - 6.2, cx + 3.6]) {
    b.cyl(pipeX, gy + 1.62, serviceZ + 0.04, 0.1, 3.2, 'metalDark', {
      segments: 8,
      noCollide: true,
    });
  }
  b.loot(cx + 3, gy + 0.4, cz + 2);
}

function atriumLink(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  // Glass corridor
  b.slab(cx, gy + 0.2, cz, 10, 26, 0.35, 'concreteDark');
  b.glassPane(cx - 5, gy + 2.4, cz, 26, 4.4, 'z');
  b.glassPane(cx + 5, gy + 2.4, cz, 26, 4.4, 'z');
  // Structural mullions: the roof must visibly land on something, especially
  // at distance where the glass panes fade into the fog.
  for (let i = 0; i < 7; i++) {
    const z = cz - 13 + i * (26 / 6);
    b.box(cx - 4.7, gy + 2.4, z, 0.5, 4.8, 0.5, 'metalDark');
    b.box(cx + 4.7, gy + 2.4, z, 0.5, 4.8, 0.5, 'metalDark');
    b.box(cx, gy + 4.35, z, 9.4, 0.18, 0.24, 'metalDark', 0, { noCollide: true });
  }
  b.slab(cx, gy + 4.8, cz, 10.6, 26.6, 0.4, 'metalDark');
  // Perimeter beam under the slab edge — keeps the roof visually connected to
  // the mullions even when the glass is washed out by daylight.
  b.box(cx, gy + 4.55, cz - 13.3, 10.6, 0.3, 0.4, 'metalDark');
  b.box(cx, gy + 4.55, cz + 13.3, 10.6, 0.3, 0.4, 'metalDark');
  b.box(cx - 5.3, gy + 4.55, cz, 0.4, 0.3, 26.6, 'metalDark');
  b.box(cx + 5.3, gy + 4.55, cz, 0.4, 0.3, 26.6, 'metalDark');
  // Roof edge trim — breaks the bright slab silhouette into a framed roof.
  b.box(cx, gy + 5.1, cz - 13.3, 11, 0.42, 0.55, 'metalDark');
  b.box(cx, gy + 5.1, cz + 13.3, 11, 0.42, 0.55, 'metalDark');
  b.box(cx - 5.3, gy + 5.1, cz, 0.55, 0.42, 26.6, 'metalDark');
  b.box(cx + 5.3, gy + 5.1, cz, 0.55, 0.42, 26.6, 'metalDark');
  // The glazed link is a working circulation spine, not an empty dark tube.
  // Recessed luminaires, a restrained floor guide and low service trunking
  // repeat the facility language used inside the main laboratory.
  for (const z of [cz - 10.5, cz - 6.3, cz - 2.1, cz + 2.1, cz + 6.3, cz + 10.5]) {
    b.box(cx, gy + 4.28, z, 2.8, 0.08, 0.28, 'signDimCyan', 0, { noCollide: true });
    b.light(cx, gy + 4.02, z, 0xcfe8ff, 0.62, 7.5);
  }
  for (const lineZ of [cz - 10.5, cz - 7.5, cz - 4.5, cz - 1.5, cz + 1.5, cz + 4.5, cz + 7.5, cz + 10.5]) {
    b.box(cx, gy + 0.42, lineZ, 0.12, 0.018, 1.45, 'paint', 0, { noCollide: true });
  }
  for (const side of [-1, 1]) {
    b.box(cx + side * 4.45, gy + 0.82, cz, 0.2, 0.28, 24.8, 'metalDark', 0, { noCollide: true });
  }
  b.platform(cx - 5, cx + 5, cz - 13, cz + 13, gy + 0.4);
}

function helipad(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  b.cyl(cx, gy + 0.15, cz, 8, 0.3, 'concreteDark');
  b.platform(cx - 8, cx + 8, cz - 8, cz + 8, gy + 0.3);
  b.box(cx, gy + 0.32, cz, 5, 0.06, 0.7, 'neonOrange', 0, { noCollide: true });
  b.chest(cx + 10, gy + 0.3, cz + 6, 'standard');
}

function dormitory(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 22, 14);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 22, d: 14, floors: 2, floorHeight: 3.6, wallMat: 'plaster', trimMat: 'woodDark', roofMat: 'roofTile',
    doors: [[0, 8, 2.2], [2, 8, 2.2]],
  });
  // The generic building keeps ground-floor side walls solid. On these long
  // dormitory elevations that produced a scale-less white slab at spawn
  // distance, so add shallow framed panes and a continuous rain plinth. They
  // are presentation-only and do not alter the proven capsule clearance.
  for (const side of [-1, 1]) {
    const x = cx + side * 11.22;
    for (const oz of [-4.2, 0, 4.2]) {
      b.box(x, gy + 1.9, cz + oz, 0.07, 1.55, 1.85, 'glass', 0, { noCollide: true });
      b.box(x + side * 0.035, gy + 1.9, cz + oz, 0.09, 1.9, 0.12, 'metalDark', 0, { noCollide: true });
      b.box(x + side * 0.035, gy + 1.9, cz + oz, 0.09, 0.12, 2.1, 'metalDark', 0, { noCollide: true });
    }
    b.box(x + side * 0.025, gy + 0.42, cz, 0.1, 0.62, 14.1, 'woodDark', 0, { noCollide: true });
  }
  b.loot(cx - 4, gy + 0.4, cz + 2);
}

function serviceHouse(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 10, 9);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 10, d: 9, floors: 1, wallMat: 'woodDark', doors: [[0, 4, 1.8]],
    interiorDividers: false, windows: false,
  });
  // Make the utility use legible from every courtyard approach. The old
  // windowless shell was an unarticulated brown cube: louver banks, a real
  // supported entrance canopy, roof exhaust and a downpipe give it scale and
  // explain why the service building is closed while keeping routes clear.
  for (const side of [-1, 1]) {
    const x = cx + side * 5.23;
    b.box(x, gy + 1.85, cz, 0.08, 1.5, 2.8, 'metalDark', 0, { noCollide: true });
    for (const yOffset of [-0.45, -0.15, 0.15, 0.45]) {
      b.box(x + side * 0.055, gy + 1.85 + yOffset, cz, 0.08, 0.1, 2.25, 'metal', 0, {
        noCollide: true,
      });
    }
  }
  b.box(cx, gy + 2.62, cz + 5.05, 3.4, 0.18, 1.7, 'metalDark');
  for (const postX of [cx - 1.45, cx + 1.45]) {
    b.box(postX, gy + 1.28, cz + 5.55, 0.16, 2.55, 0.16, 'metalDark');
  }
  b.cyl(cx + 2.7, gy + 4.65, cz - 1.8, 0.42, 1.7, 'metalDark', {
    segments: 12,
    noCollide: true,
  });
  b.box(cx - 4.7, gy + 1.75, cz - 4.62, 0.16, 3.5, 0.16, 'metalDark', 0, {
    noCollide: true,
  });
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
  const gy = structureBaseY(terrainH, cx, cz, 24, 18);
  // Ground building
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 24, d: 18, floors: 1, floorHeight: 5, wallMat: 'facadeB', trimMat: 'metalDark',
    doors: [[0, 9, 2.8], [2, 9, 2.8]], interiorDividers: false,
  });
  // Clarifier tanks outside
  b.cyl(cx + 18, gy + 2.5, cz + 8, 5, 5, 'concrete');
  b.cyl(cx + 18, gy + 2.5, cz - 6, 5, 5, 'rust');
  // Open retaining-wall ramp into the underground room from the west. The
  // old flight sat under an unbroken heightfield and the building foundation.
  const entryX = cx - 24.7;
  const entryZ = cz - 4;
  const pumpCutout = {
    minX: entryX,
    maxX: cx - 8.5,
    minZ: cz - 9,
    maxZ: cz + 1,
    surfaceY: gy,
  };
  b.terrainCutout(pumpCutout);
  // Start at the actual coarse-mesh hole edge and keep the lower tread west
  // of the building foundation. Otherwise descending worked, but an actor
  // climbing out raised its capsule into the foundation before clearing the
  // west edge.
  const py = gy - 5;
  // The cut heightfield follows its coarse grid at the boundary. Bridge that
  // small edge explicitly, then descend from the real approach surface to the
  // pump-room floor with every riser inside the KCC snap distance.
  const entrySurfaceY = terrainH(entryX - 2, entryZ);
  b.box(entryX - 1.3, entrySurfaceY - 0.15, entryZ, 3, 0.3, 3.2, 'concreteDark', 0, {
    floor: true,
    preserveInTerrainCutout: true,
  });
  // Use the safe 0.34 m maximum here rather than over-sampling the flight:
  // the actor must be below the building foundation before its capsule
  // reaches the west edge. A shallower, longer flight collides with that
  // overhead foundation even though every individual tread is walkable.
  const stairSteps = Math.ceil(Math.abs(entrySurfaceY - py) / 0.34);
  const stair = b.stairs(
    entryX, entrySurfaceY, entryZ, 1, stairSteps,
    (py - entrySurfaceY) / stairSteps,
    0.78, 2.6, 'concreteDark',
  );
  const retainingLength = stair.run + 1.4;
  const retainingX = entryX + stair.run / 2;
  b.box(retainingX, (entrySurfaceY + py) / 2, entryZ - 1.7, retainingLength, entrySurfaceY - py, 0.3, 'concreteDark');
  b.box(retainingX, (entrySurfaceY + py) / 2, entryZ + 1.7, retainingLength, entrySurfaceY - py, 0.3, 'concreteDark');
  b.slab(cx - 12.5, py, entryZ, 7, 3.2, 0.35, 'concreteDark');
  b.slab(cx, py, cz - 6, 20, 14, 0.5, 'concreteDark');
  b.slab(cx, py + 4.2, cz - 6, 20, 14, 0.5, 'concreteDark');
  b.wallWithGaps(cx - 10, cz - 13, 20, 4.2, 0.5, 'x', 'concrete', [], 0, py);
  b.wallWithGaps(cx - 10, cz + 1, 20, 4.2, 0.5, 'x', 'concrete', [[8, 2.4]], 0, py);
  b.wallWithGaps(cx - 10, cz - 13, 14, 4.2, 0.5, 'z', 'concrete', [[7.7, 2.6]], 0, py);
  b.wallWithGaps(cx + 10, cz - 13, 14, 4.2, 0.5, 'z', 'concrete', [], 0, py);
  for (let i = 0; i < 3; i++) {
    b.cyl(cx - 6 + i * 6, py + 1.4, cz - 9, 1.4, 2.8, 'metalDark');
  }
  b.light(cx, py + 3.4, cz - 6, 0x9fe8ff, 1.6, 22);
  b.loot(cx + 4, py + 0.4, cz - 4);
  // Author against the structure's measured floors. The former map-level
  // guesses used terrainH and sat one chest in the north wall and the other
  // below the pump floor, so finish-time placement validation removed both.
  b.chest(cx + 5, gy + 0.3, cz + 4, 'elite');
  b.chest(cx + 5, py + 0.3, cz - 4, 'vault');
}

function dock(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  // Wooden pier: shore landing at terrain grade, stairs down to lake level,
  // then a flat deck on posts over the water.
  const surfaceY = -4.2;
  const deckY = surfaceY + 1.1;
  // A small built-up landing creates a credible dry shoreline even where the
  // smoothed lake basin is deeper than the rectangular water edge.
  const shoreY = Math.max(terrainH(cx, cz), surfaceY + 0.15);
  // Shore landing platform
  b.slab(cx, shoreY + 0.06, cz - 2.4, 5, 4.6, 0.3, 'woodDark');
  // Stairs join the two actual elevations. The old code always forced a
  // 1.6 m descent, even when the deck was above the shore, leaving the run
  // disconnected from the deck.
  const rise = deckY - shoreY;
  const stairSteps = Math.max(3, Math.ceil(Math.abs(rise) / 0.3));
  const stepH = rise / stairSteps;
  const stairZ = cz - 0.1;
  const stair = b.stairs(cx, shoreY, stairZ, 0, stairSteps, stepH, 0.62, 4.6, 'woodDark');
  // Flat lake-level deck on posts
  const deckStart = stairZ + stair.run;
  const deckEnd = cz + 30;
  const segs = Math.max(2, Math.round((deckEnd - deckStart) / 6));
  const segLen = (deckEnd - deckStart) / segs;
  for (let i = 0; i < segs; i++) {
    const pz = deckStart + segLen * (i + 0.5);
    b.slab(cx, deckY, pz, 5, segLen + 0.3, 0.3, 'woodDark');
    const bedY = terrainH(cx, pz);
    if (bedY < deckY - 0.5) {
      b.cyl(cx - 2, (bedY + deckY) / 2 - 0.15, pz, 0.22, deckY - bedY, 'woodDark');
      b.cyl(cx + 2, (bedY + deckY) / 2 - 0.15, pz, 0.22, deckY - bedY, 'woodDark');
    }
  }
  b.platform(cx - 2.5, cx + 2.5, deckStart, deckEnd, deckY + 0.15);
  b.crate(cx, deckY + 0.3, cz + 8, 1);
  for (let i = 0; i < 3; i++) {
    b.cyl(cx + 1.5 + (i % 2) * 1.1, deckY + 0.55 + Math.floor(i / 2) * 1.1, cz + 20, 0.55, 1.1, 'rust');
  }
  b.loot(cx, deckY + 0.5, cz + 14);
}

function boathouse(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 12, 14);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 12, d: 14, floors: 1, floorHeight: 5, wallMat: 'woodDark', trimMat: 'wood',
    doors: [[1, 5, 2.6]], interiorDividers: false, windows: false,
  });
  // Break up the plain lake-facing box with a continuous eave, framed
  // clerestory panes and grounded corner trim. All additions are shallow
  // presentation pieces; the existing wall/door collider remains canonical.
  const eaveY = gy + 4.82;
  b.box(cx, eaveY, cz - 7.24, 12.7, 0.28, 0.3, 'metalExterior', 0, { noCollide: true });
  b.box(cx, eaveY, cz + 7.24, 12.7, 0.28, 0.3, 'metalExterior', 0, { noCollide: true });
  b.box(cx - 6.24, eaveY, cz, 0.3, 0.28, 14.2, 'metalExterior', 0, { noCollide: true });
  b.box(cx + 6.24, eaveY, cz, 0.3, 0.28, 14.2, 'metalExterior', 0, { noCollide: true });
  for (const paneX of [cx - 3.5, cx, cx + 3.5]) {
    b.box(paneX, gy + 3.35, cz - 7.23, 2.45, 1.12, 0.06, 'windowCool', 0, { noCollide: true });
    b.box(paneX, gy + 3.35, cz - 7.28, 0.1, 1.3, 0.08, 'metalExterior', 0, { noCollide: true });
    for (const side of [-1, 1]) {
      b.box(paneX + side * 1.28, gy + 3.35, cz - 7.3, 0.1, 1.34, 0.1,
        'metalExterior', 0, { noCollide: true });
      b.box(paneX, gy + 3.35 + side * 0.62, cz - 7.3, 2.66, 0.1, 0.1,
        'metalExterior', 0, { noCollide: true });
    }
  }
  // Fine battens stop the broad timber panel from reading as one stretched
  // texture, while a real gutter/downpipe gives the lakeside wall a plausible
  // weathering and drainage path.
  for (const battenX of [cx - 5.1, cx - 1.75, cx + 1.75, cx + 5.1]) {
    b.box(battenX, gy + 2.12, cz - 7.29, 0.055, 3.72, 0.07, 'wood', 0, { noCollide: true });
  }
  b.box(cx, gy + 4.58, cz - 7.38, 11.55, 0.12, 0.16, 'metalDark', 0, { noCollide: true });
  b.cyl(cx + 5.45, gy + 2.3, cz - 7.42, 0.07, 4.55, 'metalDark', { segments: 10, noCollide: true });
  b.box(cx + 5.45, gy + 0.16, cz - 7.08, 0.14, 0.14, 0.72, 'metalDark', 0, { noCollide: true });
  for (const side of [-1, 1]) {
    b.box(cx + side * 5.72, gy + 2.45, cz - 7.3, 0.24, 4.75, 0.24, 'wood', 0, { noCollide: true });
  }
  b.light(cx, gy + 4.1, cz - 7.6, 0x9fdfff, 0.72, 12);
  // The east-wall door previously read as an unexplained grey cutout from
  // the shore approach. A shallow, supported hood marks the service entry
  // without changing the canonical doorway clearance.
  const serviceDoorZ = cz - 0.7;
  b.box(cx + 6.62, gy + 3.06, serviceDoorZ, 1.28, 0.16, 3.3, 'metalExterior', 0, { noCollide: true });
  for (const side of [-1, 1]) {
    b.box(cx + 6.28, gy + 2.57, serviceDoorZ + side * 1.36, 0.12, 0.98, 0.12,
      'metalDark', 0, { noCollide: true });
  }
  b.box(cx + 6.7, gy + 2.88, serviceDoorZ, 0.08, 0.12, 1.25, 'windowCool', 0, { noCollide: true });
  b.light(cx + 6.9, gy + 2.8, serviceDoorZ, 0x9fdfff, 0.58, 9);
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
  const gy = structureBaseY(terrainH, cx, cz, 9, 8);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 9, d: 8, floors: 1, wallMat: 'woodDark', doors: [[0, 3.5, 1.7]],
    interiorDividers: false, windows: false,
  });
  b.loot(cx + 1, gy + 0.4, cz + 1);
  b.crate(cx - 3, gy + 0.2, cz + 3, 0.9);
}

function ford(b: WorldBuilder, cx: number, cz: number): void {
  // Shallow river crossing with stepping stones
  const sy = -4.0;
  for (let i = 0; i < 6; i++) {
    // Sink each base below the water plane; the upper rock still protrudes
    // enough to read and collide as a stepping stone without floating.
    b.rock(cx - 8 + i * 3.2, cz + Math.sin(i) * 2, sy - 0.75, 1.1);
  }
  b.loot(cx, sy + 0.8, cz);
  b.loot(cx + 6, sy + 0.8, cz + 2);
}

function meadowCamp(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  for (let i = 0; i < 3; i++) {
    const tx = cx + rng.range(-8, 8);
    const tz = cz + rng.range(-8, 8);
    const tentY = terrainH(tx, tz);
    b.box(tx, tentY + 0.9, tz, 2.6, 1.8, 2.6, 'plasterOld', rng.angle());
    b.platform(tx - 1.3, tx + 1.3, tz - 1.3, tz + 1.3, tentY + 1.8);
  }
  b.chest(cx + 10, terrainH(cx + 10, cz - 10) + 0.3, cz - 10, 'standard');
  b.loot(cx - 4, terrainH(cx - 4, cz + 5) + 0.4, cz + 5);
}

function pumpHouse(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 8, 8);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 8, d: 8, floors: 1, wallMat: 'bricksOld', doors: [[0, 3.5, 1.8]],
    interiorDividers: false, windows: false,
  });
  b.cyl(cx + 6, gy + 1, cz, 0.8, 2, 'rust');
  b.loot(cx, gy + 0.4, cz + 2);
}

function watchRock(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  // The former 4.2x boulder enclosed the nominal lookout floor inside a
  // 10 m-tall collider, while b.platform registered navigation without any
  // physical/rendered deck. Build a supported, human-scale rock lookout.
  b.rock(cx, cz, gy, 1);
  const deckY = gy + 2.45;
  b.slab(cx, deckY, cz, 5, 5, 0.35, 'rock');

  const deckEastEdge = cx + 2.5;
  let stairPlan = planStairs(8, 0.3, 0.7, 2.2);
  let stairStartX = deckEastEdge + stairPlan.run;
  let stairStartY = terrainH(stairStartX, cz);
  for (let pass = 0; pass < 3; pass++) {
    const rise = deckY - stairStartY;
    const steps = Math.max(1, Math.ceil(rise / 0.34));
    stairPlan = planStairs(steps, rise / steps, 0.7, 2.2);
    stairStartX = deckEastEdge + stairPlan.run;
    stairStartY = terrainH(stairStartX, cz);
  }
  const finalRise = deckY - stairStartY;
  b.stairs(
    stairStartX, stairStartY, cz, 3,
    stairPlan.steps, finalRise / stairPlan.steps, stairPlan.stepD, stairPlan.width,
    'rock',
  );
  // The lookout stair is fully exposed on both sides. A continuous rock
  // soffit is supplied by WorldBuilder; slim weathered rails and repeated
  // posts make the edge/load path readable without narrowing the collider.
  const slope = Math.atan2(finalRise, stairPlan.run);
  const slopeLength = Math.hypot(stairPlan.run, finalRise);
  const railCentreX = stairStartX - stairPlan.run / 2;
  for (const side of [-1, 1]) {
    const railZ = cz + side * (stairPlan.width / 2 + 0.04);
    b.guardRail(
      { x: stairStartX, z: railZ },
      { x: stairStartX - stairPlan.run, z: railZ },
      stairStartY - 0.15,
      stairStartY + finalRise + 1.0,
    );
    for (const height of [0.5, 0.9]) {
      b.box(
        railCentreX,
        stairStartY + finalRise / 2 + height,
        railZ,
        0.1,
        0.1,
        slopeLength,
        'metalDark',
        -Math.PI / 2,
        { noCollide: true, pitch: -slope },
      );
    }
    for (let post = 0; post <= 5; post++) {
      const t = post / 5;
      b.box(
        stairStartX - stairPlan.run * t,
        stairStartY + finalRise * t + 0.45,
        railZ,
        0.1,
        0.9,
        0.1,
        'metalDark',
        0,
        { noCollide: true },
      );
    }
  }
  b.chest(cx, deckY + 0.3, cz, 'elite');
}

// ---------------------------------------------------------------------------
// Environment dressing: facility conduits, paths, dock gear, camp life
// ---------------------------------------------------------------------------

function decorateEden(b: WorldBuilder, rng: Rng): void {
  // Continuous terrain-following service paths replace overlapping square
  // tiles. A broad dirt shoulder seats the narrower concrete ribbon in grass.
  const path = (x1: number, z1: number, x2: number, z2: number) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(2, Math.round(len / 4.5));
    const centre: Array<{ x: number; z: number; width: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x1 + (x2 - x1) * t + Math.sin(t * 8.3) * 2.6;
      const pz = z1 + (z2 - z1) * t + Math.cos(t * 6.7) * 2.4;
      centre.push({ x: px, z: pz, width: rng.range(4.6, 6.4) });
    }
    b.surfacePath(centre.map((point) => ({ ...point, width: point.width * 1.38 })), 'dirt', 0.025);
    b.surfacePath(centre, 'concrete', 0.045);
  };
  path(-95, -30, -55, 12);      // lab main → east wing
  path(-95, -30, -110, 100);    // complex → dormitories
  path(-110, 100, 10, 30);      // dorms → greenhouses
  path(10, 30, 118, 42);        // greenhouses → dock
  path(-95, -30, -170, -120);   // complex → water treatment
  path(-60, -55, 10, -195);     // helipad → overlook
  path(60, 175, 160, 150);      // cabin → ford

  // The south apron of the research complex used to be an uninterrupted
  // grass sheet between two large laboratory wings. A terrain-following
  // grated drain now carries storm water across the low side of the site,
  // with regular access covers that make the route read as maintained civil
  // infrastructure rather than a decorative stripe.
  const facilityDrain: Array<{ x: number; z: number; width: number }> = [];
  for (let x = -146; x <= -42; x += 8) {
    facilityDrain.push({ x, z: 26.5 + Math.sin((x + 146) * 0.075) * 0.65, width: 1.65 });
  }
  b.surfacePath(facilityDrain, 'dirt', 0.018);
  b.surfacePath(facilityDrain.map((point) => ({ ...point, width: 0.34 })), 'metalDark', 0.052);
  for (const x of [-142, -117, -92, -67, -46]) {
    const z = 26.5 + Math.sin((x + 146) * 0.075) * 0.65;
    b.box(x, terrainH(x, z) + 0.085, z, 1.45, 0.1, 0.78, 'metalDark', 0, { noCollide: true });
    b.box(x, terrainH(x, z) + 0.141, z, 1.02, 0.018, 0.44, 'paint', 0, { noCollide: true });
  }

  // A narrow maintenance spine joins the two wing service systems to the
  // apron drain. Its irregular edge, inspection cabinets and marker lamps
  // replace the scale-less lawn while leaving the central combat route open.
  const serviceSpine: Array<{ x: number; z: number; width: number }> = [];
  for (let x = -136; x <= -48; x += 8) {
    serviceSpine.push({ x, z: 18 + Math.sin((x + 136) * 0.11) * 0.45, width: 1.9 });
  }
  b.surfacePath(serviceSpine.map((point) => ({ ...point, width: 2.85 })), 'dirt', 0.022);
  b.surfacePath(serviceSpine, 'concreteDark', 0.047);
  b.surfacePath(serviceSpine.map((point) => ({ ...point, width: 0.18 })), 'metalDark', 0.071);
  for (const point of serviceSpine) {
    const y = terrainH(point.x, point.z);
    b.box(point.x, y + 0.083, point.z, 0.055, 0.018, 1.45, 'metalDark', 0, { noCollide: true });
  }
  for (const x of [-130, -112, -94, -76, -58]) {
    const z = 19.8 + Math.sin((x + 136) * 0.11) * 0.45;
    const y = terrainH(x, z);
    b.box(x, y + 0.58, z, 1.6, 1.16, 0.78, 'metalDark', 0, { noCollide: true });
    for (const louverY of [0.33, 0.58, 0.83]) {
      b.box(x, y + louverY, z - 0.405, 1.15, 0.07, 0.04, 'metal', 0, { noCollide: true });
    }
    b.cyl(x + 1.2, y + 0.72, z, 0.08, 1.44, 'rust', { segments: 8, noCollide: true });
    b.box(x + 1.2, y + 1.47, z, 0.22, 0.08, 0.22, 'signDimCyan', 0, { noCollide: true });
  }

  // Rooftop solar arrays + conduit runs on facility roofs
  for (const g of [...b.def.geo]) {
    if (g.kind !== 'box') continue;
    const isFacility = g.mat === 'concrete' || g.mat === 'metal' || g.mat === 'facilityFloor';
    if (!isFacility || g.sy < 4 || g.sx < 10 || g.sz < 8) continue;
    const topY = g.y + g.sy / 2;
    // solar panel bank
    if (rng.bool(0.65)) {
      const px = g.x + rng.range(-g.sx * 0.22, g.sx * 0.22);
      const pz = g.z + rng.range(-g.sz * 0.22, g.sz * 0.22);
      b.box(px, topY + 0.5, pz, 4.6, 0.14, 2.6, 'metal', rng.range(-0.15, 0.15), { noCollide: true });
      b.box(px, topY + 0.62, pz, 4.4, 0.06, 2.4, 'neonBlue', rng.range(-0.15, 0.15), { noCollide: true });
    }
    // exterior conduit along one wall base
    if (rng.bool(0.7)) {
      b.box(g.x, g.y - g.sy / 2 + 0.35, g.z + g.sz / 2 + 0.18, g.sx * 0.86, 0.16, 0.14, 'rust', 0, { noCollide: true });
    }
    // AC condensers
    if (rng.bool(0.6)) {
      b.box(g.x + g.sx * 0.28, topY + 0.45, g.z - g.sz * 0.24, 1.6, 0.9, 1.6, 'metalDark', 0, { noCollide: true });
      b.cyl(g.x + g.sx * 0.28, topY + 0.96, g.z - g.sz * 0.24, 0.5, 0.1, 'rust');
    }
  }

  // Greenhouse interior growth: fern/flower beds are handled by scatter. Use
  // supported trellises here; the old rock sphere on a single thin post read
  // as a floating boulder rather than cultivated vegetation.
  for (let i = 0; i < 10; i++) {
    const gx = rng.range(-8, 34);
    const gz = rng.range(18, 44);
    const gy = terrainH(gx, gz);
    const trellisW = rng.range(0.9, 1.25);
    for (const side of [-1, 1]) {
      b.cyl(gx + side * trellisW / 2, gy + 1.05, gz, 0.045, 2.1, 'metalDark');
    }
    b.box(gx, gy + 2.08, gz, trellisW + 0.14, 0.07, 0.07, 'metalDark', 0, { noCollide: true });
    for (const side of [-0.3, 0, 0.3]) {
      b.box(
        gx + side * trellisW,
        gy + rng.range(0.72, 1.42),
        gz,
        rng.range(0.16, 0.25),
        rng.range(0.7, 1.25),
        0.09,
        'grass',
        0,
        { noCollide: true },
      );
    }
  }

  // Dock gear: mooring posts, fish crates, lanterns
  for (const [mx, mz] of [[112, 30], [124, 32], [130, 46], [116, 52]] as Array<[number, number]>) {
    const gy = terrainH(mx, mz);
    b.cyl(mx, gy + 0.42, mz, 0.19, 0.85, 'woodDark');
    b.light(mx, gy + 1.35, mz, 0xffd9a0, 0.9, 11);
  }
  for (let i = 0; i < 5; i++) {
    const cx2 = 108 + rng.range(-6, 16);
    const cz2 = 36 + rng.range(-6, 12);
    b.crate(cx2, terrainH(cx2, cz2) + 0.2, cz2, rng.range(0.7, 1));
  }

  // Meadow camp: tents (cloth wedges), fire ring, log seats
  for (let i = 0; i < 3; i++) {
    const tx = 222 + rng.range(-8, 8);
    const tz = 96 + rng.range(-8, 8);
    const gy = terrainH(tx, tz);
    b.box(tx, gy + 0.85, tz, 3.2, 1.5, 2.6, 'roofTile', rng.range(-0.4, 0.4));
    b.box(tx, gy + 1.62, tz, 3.4, 0.14, 2.8, 'woodDark', 0, { noCollide: true });
  }
  {
    const fx = 225; const fz = 104;
    const gy = terrainH(fx, fz);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.rock(fx + Math.cos(a) * 1.3, fz + Math.sin(a) * 1.3, gy, 0.35);
    }
    b.light(fx, gy + 0.9, fz, 0xffa04f, 1.6, 13);
  }

  // Cliff overlook rails & antenna guy-wires feel
  for (let i = 0; i < 3; i++) {
    const ax = -18 + i * 14;
    const az = -185 + rng.range(-4, 4);
    const gy = terrainH(ax, az);
    b.cyl(ax, gy + 2.6, az, 0.09, 5.2, 'metalDark');
    b.light(ax, gy + 5.3, az, 0xff5f5f, 1.1, 9);
  }

  // Water treatment exterior pipes (big industrial runs)
  {
    const px = -170; const pz = -98;
    const gy = terrainH(px, pz);
    for (let i = 0; i < 4; i++) {
      b.cyl(px - 9 + i * 6, gy + 1.6, pz, 0.55, 3.2, 'rust');
    }
    b.box(px, gy + 3.4, pz, 26, 0.5, 1.4, 'metalDark', 0, { noCollide: true });
  }

  // Warning stripes at underground entries: dark base strip with gold hazard
  // dashes so it reads as painted hazard tape instead of a floating gold plank.
  for (const [sx, sz] of [[-176, -114], [-164, -126]] as Array<[number, number]>) {
    const gy = terrainH(sx, sz);
    b.box(sx, gy + 0.045, sz, 5.6, 0.04, 3.4, 'concreteDark', 0, { noCollide: true });
    for (let i = 0; i < 4; i++) {
      b.box(sx - 1.8 + i * 1.2, gy + 0.07, sz, 0.6, 0.03, 3.4, 'gold', 0, { noCollide: true });
    }
  }
}
