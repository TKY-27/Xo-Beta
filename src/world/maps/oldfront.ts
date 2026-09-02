/**
 * OLD FRONT — weathered historical European-style town at late afternoon.
 * Cathedral landmark, old town streets, keep ruins, farmstead, military
 * checkpoint, forest edge, tunnel. Rolling terrain.
 */

import { planStairs, STAIR_MAX_RISE, WorldBuilder } from '../builder';
import { ROCK_CLEARANCE_RADIUS, type MapDef, type MatKey } from '../types';
import { Rng } from '../../core/rng';
import { addBuilding, scatterRocks, scatterTrees, structureBaseY } from './common';

const S = 500;

/** Gentle terrain — small undulation only (collision-safe for all structures). */
function terrainH(x: number, z: number): number {
  let h = Math.sin(x * 0.02) * 0.45 + Math.cos(z * 0.023) * 0.4 + Math.sin((x + z) * 0.008) * 0.25;
  // South forest dip (shallow, no structures there)
  const forestD = Math.hypot(x - 100, z - 195);
  if (forestD < 60) h -= (1 - forestD / 60) * 0.8;
  // The quarry is a real terrain depression, not a solid box disguised as a
  // pit. This lets render terrain, physics, stairs and props share one surface.
  const quarryD = Math.hypot(x + 90, z + 40);
  if (quarryD < 30) h -= (1 - quarryD / 30) * 4.6;
  return h;
}

export function buildOldFront(): MapDef {
  const rng = new Rng(0x01f7 + 3);
  const b = new WorldBuilder('oldfront', 'OLD FRONT', 'A worn frontier town under an overcast sky. Stone streets, a cathedral, and war remnants.', S);

  // Ground surface is rendered by src/render/vista.ts (terrain mesh matching
  // this map's heightfield + beyond-bounds landscape).

  // Heightfield terrain (visual + collider)
  buildHeightfield(b);

  // ------------------------------------------------------------------
  // POI: CATHEDRAL SQUARE (center-north of town)
  // ------------------------------------------------------------------
  b.poi('Cathedral Square', 20, -30, 60);
  cathedral(b, 20, -55);
  // Square paving
  b.box(20, terrainH(20, -10) + 0.06, -10, 56, 0.16, 44, 'sidewalk', 0, { floor: true });
  fountain(b, 20, -8);
  // Row houses framing the square
  townHouse(b, -18, -28, 0);
  townHouse(b, 58, -28, 0);
  townHouse(b, -18, 12, 2);
  b.chest(34, terrainH(34, -22) + 0.3, -22, 'elite');
  b.chest(6, terrainH(6, -50) + 0.3, -50, 'standard');

  // ------------------------------------------------------------------
  // POI: OLD TOWN (dense housing east)
  // ------------------------------------------------------------------
  b.poi('Old Town', 110, 30, 65);
  townHouse(b, 88, 12, 1);
  townHouse(b, 122, 12, 3);
  townHouse(b, 88, 48, 1);
  townHouse(b, 124, 50, 3);
  townHouse(b, 106, 78, 0);
  shopHouse(b, 108, 32);
  b.chest(104, terrainH(104, 30) + 0.3, 30, 'standard');
  b.chest(126, terrainH(126, 66) + 0.3, 66, 'elite');
  well(b, 106, 58);
  crates(b, rng, 96, 40, 5);

  // ------------------------------------------------------------------
  // POI: THE KEEP (ruined fortress on NW hill)
  // ------------------------------------------------------------------
  b.poi('The Keep', -150, -150, 60);
  keepRuins(b, -150, -150);
  b.chest(-142, terrainH(-142, -142) + 0.3, -142, 'vault');
  b.chest(-160, terrainH(-160, -158) + 0.3, -158, 'standard');
  scatterRocks(b, rng, 12, { minX: -200, maxX: -100, minZ: -200, maxZ: -100 }, [{ x: -150, z: -150, r: 45 }], terrainH);

  // ------------------------------------------------------------------
  // POI: FARMSTEAD (south-east fields)
  // ------------------------------------------------------------------
  b.poi('Farmstead', 150, 170, 55);
  barn(b, 138, 158);
  farmhouse(b, 168, 182);
  silo(b, 152, 196);
  fences(b, rng, 130, 150, 60, 40);
  b.vehicle(146, 172, terrainH(146, 172) + 0.2, 0.7, 'truck', 0x4a3d2a);
  b.chest(140, terrainH(140, 162) + 0.3, 162, 'standard');
  b.chest(170, terrainH(170, 186) + 0.3, 186, 'elite');
  hayCarts(b, rng, 155, 165);

  // ------------------------------------------------------------------
  // POI: CHECKPOINT (military remnant, west road)
  // ------------------------------------------------------------------
  b.poi('Checkpoint', -170, 60, 45);
  bunker(b, -178, 52);
  bunker(b, -156, 74);
  sandbagLine(b, -170, 62, 24, 0.3);
  sandbagLine(b, -166, 76, 18, 1.8);
  watchtower(b, -184, 80);
  b.vehicle(-164, 58, terrainH(-164, 58) + 0.2, 1.9, 'wrecked', 0x33302a);
  b.chest(-176, terrainH(-176, 54) + 0.3, 54, 'elite');
  b.chest(-168, terrainH(-168, 70) + 0.3, 70, 'standard');
  crates(b, rng, -160, 66, 4);

  // ------------------------------------------------------------------
  // POI: FOREST CAMP (south woods)
  // ------------------------------------------------------------------
  b.poi('Forest Camp', 90, 195, 45);
  logCabins(b, rng, 82, 188);
  lumberPile(b, rng, 102, 202);
  campfire(b, 92, 198);
  b.chest(86, terrainH(86, 190) + 0.3, 190, 'standard');
  b.loot(96, terrainH(96, 200) + 0.4, 200);

  // ------------------------------------------------------------------
  // POI: TUNNEL (through east hill)
  // ------------------------------------------------------------------
  b.poi('Hill Tunnel', 205, -90, 35);
  tunnel(b, 205, -90);
  b.chest(212, terrainH(212, -90) + 0.3, -90, 'elite');
  b.loot(198, terrainH(198, -96) + 0.4, -96);

  // ------------------------------------------------------------------
  // Small POIs
  // ------------------------------------------------------------------
  b.poi('Chapel', -60, 130, 26);
  chapel(b, -60, 130);
  b.poi('Bridge', 0, 120, 24);
  stoneBridge(b, 0, 120);
  b.poi('Quarry', -90, -40, 30);
  quarry(b, rng, -90, -40);
  b.poi('Roadside Shrine', 60, -120, 16);
  shrine(b, 60, -120);
  b.poi('Water Mill', -30, 210, 28);
  waterMill(b, -30, 210);
  b.poi('Orchard', 190, 60, 30);
  orchard(b, rng, 190, 60);
  b.poi('Broken Column', -220, -30, 18);
  ruinsSpot(b, -220, -30);
  b.poi('Crossroads', 30, 80, 22);
  crossroads(b, 30, 80);

  // Forest belt south + scattered oaks
  scatterTrees(b, rng, 90, { minX: -240, maxX: 240, minZ: 140, maxZ: 245 }, 'oak',
    [{ x: 90, z: 195, r: 30 }, { x: -30, z: 210, r: 25 }, { x: 150, z: 170, r: 45 }], terrainH);
  scatterTrees(b, rng, 40, { minX: -240, maxX: 240, minZ: -245, maxZ: -140 }, 'dead',
    [{ x: -150, z: -150, r: 50 }], terrainH);
  scatterTrees(b, rng, 30, { minX: 150, maxX: 245, minZ: -140, maxZ: 40 }, 'oak', [], terrainH);
  scatterRocks(b, rng, 25, { minX: -245, maxX: 245, minZ: -245, maxZ: 245 },
    [
      { x: 20, z: -30, r: 70 },
      { x: 110, z: 30, r: 60 },
      { x: 150, z: 170, r: 50 },
      // Keep the excavated descent and its turning room clear. The old
      // undersized rock proxies let a visible boulder occupy this route.
      { x: -90, z: -40, r: 38 },
    ], terrainH);

  decorateOldFront(b, rng);
  hedgerowsAndWalls(b, rng);
  edgeHomesteads(b, rng);

  return b.finish(
    {
      preset: 'overcast',
      atmosphere: {
        // Overcast war-torn ceiling: multiple cloud scales, a soft sun
        // smeared behind cover, cold horizon variation.
        zenith: 0x5b6672, horizon: 0x8b949c,
        discSize: 0.06, discColor: 0xd8dde2, discGlow: 0.22,
        cloudCover: 0.88, cloudTint: 0x9aa3ac, cloudShade: 0x59636d,
        windSpeed: 0.008, starOpacity: 0.0,
        hazeColor: 0x8f99a2, hazeStrength: 0.62,
      },
      hdri: 'kloofendal_overcast_puresky_2k.hdr',
      fogColor: 0x8b949c,
      fogDensity: 0.00115,
      sunDirection: [-0.55, -0.75, 0.35],
      sunColor: 0xe8ded0,
      sunIntensity: 1.3,
      ambientColor: 0xaeb9c6,
      ambientIntensity: 0.42,
      hemisphereSky: 0xc2cbd6,
      hemisphereGround: 0x6a685c,
      hemisphereIntensity: 0.82,
      exposure: 0.79,
      envIntensity: 0.46,
      backgroundBlurriness: 0.12,
      backgroundIntensity: 0.34,
      grade: {
        vignette: 0.34,
        saturation: 0.88,
        contrast: 1.07,
        lift: [0.006, 0.005, 0.004],
      },
    },
    { from: [-330, 120], to: [330, -110] },
  );
}

// ---------------------------------------------------------------------------
// Terrain heightfield
// ---------------------------------------------------------------------------

/**
 * Old-European field boundaries: dry-stone walls + hedgerow copses dividing
 * the meadow bands, plus haystacks. Fills the "empty field" reads and gives
 * the outskirts the same authored attention as the town center.
 */
function hedgerowsAndWalls(b: WorldBuilder, rng: Rng): void {
  const wallSeg = (x1: number, z1: number, x2: number, z2: number) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(2, Math.round(len / 3.2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x1 + (x2 - x1) * t;
      const pz = z1 + (z2 - z1) * t;
      if (rng.bool(0.12)) continue; // gaps as passages
      b.box(px, terrainH(px, pz) + 0.45, pz, 3.4, 0.9, 0.7,
        'stoneBrick', Math.atan2(z2 - z1, x2 - x1));
    }
  };
  // Perimeter field walls just inside the boundary band
  wallSeg(-238, -180, -120, -226);
  wallSeg(60, -232, 200, -214);
  wallSeg(-230, 90, -228, 210);
  wallSeg(226, -40, 222, 130);
  // Interior hedgerow lines between fields (SW + SE meadows)
  const hedge = (x1: number, z1: number, x2: number, z2: number) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(2, Math.round(len / 5));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x1 + (x2 - x1) * t;
      const pz = z1 + (z2 - z1) * t;
      b.tree({ x: px, z: pz, y: terrainH(px, pz), scale: rng.range(0.55, 0.85),
        variant: rng.bool(0.75) ? 'oak' : 'dead' });
      if (rng.bool(0.4)) {
        b.box(px + rng.range(-1.5, 1.5), terrainH(px, pz) + 0.35, pz + rng.range(-1.5, 1.5),
          2.6, 0.7, 0.6, rng.bool(0.5) ? 'dirt' : 'stoneBrick', rng.range(-0.3, 0.3));
      }
    }
  };
  hedge(-80, 160, -140, 220);
  hedge(-190, 150, -150, 225);
  hedge(30, 170, -40, 235);
  hedge(210, 110, 160, 215);

  // Haystacks in the open meadows. The former single spheres read as giant
  // smooth balloons; offset rectangular bales establish scale, stacking and
  // believable ground contact with the same low-cost authored primitives.
  for (let i = 0; i < 14; i++) {
    const hx = rng.range(-230, 230);
    const hz = rng.range(-60, 130);
    if (Math.hypot(hx - 20, hz + 10) < 70 || Math.hypot(hx - 110, hz - 30) < 70) continue;
    const gy = terrainH(hx, hz);
    hayBaleStack(b, hx, gy, hz, rng.angle(), true);
    if (rng.bool(0.25)) b.loot(hx + rng.range(-3, 3), gy + 0.4, hz + rng.range(-3, 3));
  }
}

/**
 * Edge homesteads: small ruined farms/camps near the map rim so every
 * approach lane has cover, loot and a reason to exist.
 */
function edgeHomesteads(b: WorldBuilder, rng: Rng): void {
  const spots: Array<[number, number]> = [
    [-205, -60], [200, 195], [-60, -205], [95, -195], [-215, 175],
  ];
  let idx = 0;
  for (const [sx, sz] of spots) {
    idx++;
    const gy = structureBaseY(terrainH, sx, sz, 9, 8);
    // Broken cottage shell
    addBuilding(b, {
      x: sx, z: sz, baseY: gy, w: 9, d: 8, floors: 1, wallMat: idx % 2 ? 'stoneBrick' : 'plasterOld',
      trimMat: 'woodDark', doors: [[idx % 2 ? 0 : 1, 3.5, 1.8]],
      interiorDividers: false, windows: false, parapet: false,
    });
    // Collapsed barn hint: leaning beams + rubble
    for (let i = 0; i < 3; i++) {
      const bx = sx + rng.range(-8, 8);
      const bz = sz + rng.range(-8, 8);
      b.box(bx, terrainH(bx, bz) + 0.35, bz, 0.4, 2.4, 0.4, 'woodDark', rng.range(0, Math.PI));
    }
    b.crate(sx + rng.range(-5, 5), terrainH(sx, sz) + 0.2, sz + rng.range(-5, 5), 1);
    b.chest(sx + rng.range(-4, 4), terrainH(sx + 2, sz + 4) + 0.3, sz + rng.range(-4, 4),
      idx === 3 ? 'vault' : rng.bool(0.4) ? 'elite' : 'standard');
    b.loot(sx + rng.range(-5, 5), gy + 0.4, sz + rng.range(-5, 5));
    scatterRocks(b, rng, 4, { minX: sx - 14, maxX: sx + 14, minZ: sz - 14, maxZ: sz + 14 }, [], terrainH);
  }
}

function buildHeightfield(b: WorldBuilder): void {
  const n = 64;
  const heights = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c / (n - 1)) * S - S / 2;
      const z = (r / (n - 1)) * S - S / 2;
      heights[r * n + c] = terrainH(x, z); // ground slab top at -1.5+... align to ground plane top y=-1.5? ground box top is at y=0-? 
    }
  }
  b.def.heightfield = { n, heights };
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

function cathedral(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 20, 42);
  // Nave
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 20, d: 42, floors: 1, floorHeight: 9, wallMat: 'stoneBrick', trimMat: 'marble',
    doors: [[0, 8, 3], [0, 12, 3], [2, 9, 3]], interiorDividers: false, parapet: false,
  });
  // Bell tower
  const towerBaseY = structureBaseY(terrainH, cx, cz - 27, 10, 10);
  addBuilding(b, {
    x: cx, z: cz - 27, baseY: towerBaseY, w: 10, d: 10, floors: 3, floorHeight: 4.6, wallMat: 'stoneBrick', trimMat: 'marble',
    doors: [[0, 3.5, 2]], roofAccess: true, interiorDividers: false,
  });
  const towerRoofY = towerBaseY + 3 * 4.6 + 0.2;
  b.cyl(cx, towerRoofY + 1.5, cz - 27, 3.4, 3, 'roofTile');
  b.sphere(cx, towerRoofY + 4.4, cz - 27, 1.6, 'gold');
  // Buttresses
  for (let i = -1; i <= 1; i += 2) {
    for (let j = 0; j < 3; j++) {
      const buttressX = cx + i * 11.4;
      const buttressZ = cz - 12 + j * 12;
      let terrainFloor = Infinity;
      for (const dx of [-0.8, 0, 0.8]) {
        for (const dz of [-0.8, 0, 0.8]) {
          terrainFloor = Math.min(terrainFloor, terrainH(buttressX + dx, buttressZ + dz));
        }
      }
      const bottom = terrainFloor - 0.12;
      const top = gy + 6;
      b.box(buttressX, (bottom + top) / 2, buttressZ, 1.6, top - bottom, 1.6, 'stoneBrick');
    }
  }
  b.loot(cx, gy + 0.4, cz + 8);
  b.loot(cx - 5, gy + 0.4, cz - 6);
}

function fountain(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  // Tiered stone fountain with real basin water
  b.cyl(cx, gy + 0.42, cz, 5.2, 0.84, 'stoneBrick');
  b.cyl(cx, gy + 0.78, cz, 4.5, 0.16, 'metalDark');           // water surface ring
  b.def.water.push({ minX: cx - 4.3, maxX: cx + 4.3, minZ: cz - 4.3, maxZ: cz + 4.3, surfaceY: gy + 0.86, depth: 0.6 });
  b.platform(cx - 5.2, cx + 5.2, cz - 5.2, cz + 5.2, gy + 0.84);
  b.cyl(cx, gy + 1.35, cz, 1.15, 1.7, 'stoneBrick');           // pedestal
  b.cyl(cx, gy + 2.25, cz, 1.7, 0.22, 'marble');               // upper bowl
  b.cyl(cx, gy + 2.62, cz, 0.28, 0.75, 'marble');              // finial column
  // water jet
  b.def.geo.push({ kind: 'cyl', x: cx, y: gy + 3.15, z: cz, r: 0.16, h: 0.9, mat: 'glass', noCollide: true });
  b.light(cx, gy + 3.4, cz, 0xbfe4ff, 0.7, 9);
  b.chest(cx + 7, gy + 0.3, cz + 5, 'standard');
}

function townHouse(b: WorldBuilder, cx: number, cz: number, doorSide: 0 | 1 | 2 | 3): void {
  const mats: Array<'plaster' | 'plasterOld' | 'stoneBrick' | 'woodDark'> = ['plaster', 'plasterOld', 'stoneBrick', 'woodDark'];
  const mat = mats[Math.abs((cx * 7 + cz * 13) >> 2) % 4]!;
  const gy = structureBaseY(terrainH, cx, cz, 13, 15);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 13, d: 15, floors: 2, wallMat: mat, trimMat: 'woodDark', roofMat: 'roofTile',
    doors: [[doorSide, 5, 1.9]],
  });
  b.loot(cx + 3, gy + 0.4, cz + 3);
  // Chest tucked against the door wall of some homes — never mid-street.
  const r = new Rng(hash2(cx, cz));
  if (r.bool(0.45)) {
    const offX = doorSide === 1 ? 8.8 : doorSide === 3 ? -8.8 : r.range(-4, 4);
    const offZ = doorSide === 0 ? 8.8 : doorSide === 2 ? -8.8 : r.range(-4, 4);
    b.chest(cx + offX, terrainH(cx + offX, cz + offZ) + 0.3, cz + offZ,
      r.bool(0.25) ? 'elite' : 'standard');
  }
}

function hash2(x: number, z: number): number {
  return ((x * 73856093) ^ (z * 19349663)) >>> 0;
}

function shopHouse(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 16, 14);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 16, d: 14, floors: 1, wallMat: 'plasterOld', trimMat: 'woodDark', roofMat: 'roofTile',
    doors: [[0, 4, 2.6], [0, 11, 2.6]], interiorDividers: false,
  });
  // The enterable shop used to be a bare plaster room containing only loot.
  // Shallow wall shelves and a warm suspended service light add purpose while
  // remaining outside the movement capsule and interaction routes.
  for (const shelfX of [cx - 4.2, cx, cx + 4.2]) {
    b.box(shelfX, gy + 1.45, cz - 6.72, 3.1, 0.13, 0.34, 'wood', 0, { noCollide: true });
    for (const bracketX of [-1.2, 1.2]) {
      b.box(shelfX + bracketX, gy + 1.08, cz - 6.68, 0.1, 0.75, 0.14, 'metalDark', 0, { noCollide: true });
    }
  }
  b.cyl(cx, gy + 4.15, cz, 0.18, 0.52, 'metalDark', { segments: 10, noCollide: true });
  b.box(cx, gy + 3.88, cz, 3.2, 0.09, 0.22, 'windowWarm', 0, { noCollide: true });
  b.light(cx, gy + 3.75, cz, 0xffc58a, 0.75, 12);
  // Awning
  b.box(cx, gy + 3.1, cz + 7.6, 15, 0.2, 2.2, 'woodDark');
  for (let i = 0; i < 3; i++) b.crate(cx - 5 + i * 5, gy + 0.2, cz + 9.5, 1);
  b.chest(cx, gy + 0.3, cz - 3, 'standard');
}

function keepRuins(b: WorldBuilder, cx: number, cz: number): void {
  const wallBase = (axis: 'x' | 'z', fixed: number): number => {
    let lowest = Infinity;
    for (let i = 0; i <= 26; i++) {
      const along = -26 + i * 2;
      for (const across of [-0.8, 0, 0.8]) {
        const x = axis === 'x' ? cx + along : fixed + across;
        const z = axis === 'x' ? fixed + across : cz + along;
        lowest = Math.min(lowest, terrainH(x, z));
      }
    }
    return lowest - 0.12;
  };
  const gy = terrainH(cx, cz);
  // Broken curtain walls
  b.wallWithGaps(cx - 26, cz - 26, 52, 6, 1.6, 'x', 'stoneBrick', [[20, 6], [38, 8]], 0, wallBase('x', cz - 26));
  b.wallWithGaps(cx - 26, cz + 26, 52, 5, 1.6, 'x', 'stoneBrick', [[6, 7], [30, 9]], 0, wallBase('x', cz + 26));
  b.wallWithGaps(cx - 26, cz - 26, 52, 6, 1.6, 'z', 'stoneBrick', [[8, 5], [36, 10]], 0, wallBase('z', cx - 26));
  b.wallWithGaps(cx + 26, cz - 26, 52, 4.5, 1.6, 'z', 'stoneBrick', [[14, 8]], 0, wallBase('z', cx + 26));
  // Central donjon — broken tower with climbable interior stairs
  const donjonY = structureBaseY(terrainH, cx, cz, 14, 14);
  addBuilding(b, {
    x: cx, z: cz, baseY: donjonY, w: 14, d: 14, floors: 2, floorHeight: 4.4, wallMat: 'stoneBrick', trimMat: 'stoneBrick',
    doors: [[0, 5.5, 2.2]], roofAccess: true, interiorDividers: false,
  });
  // Rubble
  const r = new Rng(99);
  for (let i = 0; i < 14; i++) {
    const a = r.angle();
    const d = r.range(8, 24);
    b.rock(cx + Math.cos(a) * d, cz + Math.sin(a) * d, terrainH(cx + Math.cos(a) * d, cz + Math.sin(a) * d), r.range(0.5, 1.6));
  }
  b.loot(cx + 4, gy + 0.4, cz + 4);
  b.loot(cx - 12, gy + 0.4, cz - 10);
}

function barn(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 18, 24);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 18, d: 24, floors: 1, floorHeight: 6.5, wallMat: 'woodDark', trimMat: 'wood',
    doors: [[0, 7, 3.4], [2, 7, 3.4]], interiorDividers: false, parapet: false,
  });
  for (let i = 0; i < 5; i++) b.crate(cx - 5 + (i % 3) * 5, gy + 0.2, cz - 6 + Math.floor(i / 3) * 4, 1.2);
  b.loot(cx + 4, gy + 0.4, cz + 6);
}

function farmhouse(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 14, 12);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 14, d: 12, floors: 2, wallMat: 'plasterOld', trimMat: 'woodDark', roofMat: 'roofTile',
    doors: [[0, 6, 2]],
  });
  b.loot(cx - 3, gy + 0.4, cz + 2);
}

function silo(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  b.cyl(cx, gy + 6, cz, 3.4, 12, 'rust');
  b.cyl(cx, gy + 12.4, cz, 3.8, 0.8, 'metalDark');
  b.platform(cx - 3.4, cx + 3.4, cz - 3.4, cz + 3.4, gy + 12.8);
  b.loot(cx + 4.5, gy + 0.4, cz);
}

function fences(b: WorldBuilder, rng: Rng, cx: number, cz: number, w: number, d: number): void {
  for (let i = 0; i < 6; i++) {
    const fx = cx - w / 2 + (i / 5) * w;
    b.def.destructibles.push({
      stableId: `${b.def.id}:fence:${i.toString(36).padStart(4, '0')}`,
      hp: 20, type: 'fence',
      geo: { kind: 'box', x: fx, y: terrainH(fx, cz) + 0.6, z: cz - d / 2, sx: 2.4, sy: 1.2, sz: 0.18, yaw: 0, mat: 'wood' },
    });
  }
  void rng;
}

function hayCarts(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  for (let i = 0; i < 3; i++) {
    const hx = cx + rng.range(-14, 14);
    const hz = cz + rng.range(-10, 14);
    const gy = terrainH(hx, hz);
    b.box(hx, gy + 0.9, hz, 3.4, 1.4, 2.6, 'wood');
    hayBaleStack(b, hx, gy + 1.6, hz, rng.range(-0.12, 0.12), false);
  }
}

function hayBaleStack(
  b: WorldBuilder,
  cx: number,
  baseY: number,
  cz: number,
  yaw: number,
  collide: boolean,
): void {
  const bales: Array<[number, number, number]> = [
    [-0.76, 0.38, 0], [0.76, 0.38, 0], [0, 1.12, 0],
  ];
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  for (const [localX, localY, localZ] of bales) {
    const x = cx + localX * cos - localZ * sin;
    const z = cz + localX * sin + localZ * cos;
    b.box(x, baseY + localY, z, 1.38, 0.72, 2.05, 'hay', yaw, {
      noCollide: !collide,
    });
    // A dark binding line gives each otherwise simple cuboid a recognisable
    // bale scale and keeps the stack from reading as unfinished wall blocks.
    b.box(x, baseY + localY + 0.365, z, 0.12, 0.035, 2.08, 'woodDark', yaw, {
      noCollide: true,
    });
  }
}

function bunker(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  b.slab(cx, gy + 0.08, cz, 10, 8, 0.5, 'concreteDark');
  b.slab(cx, gy + 3.2, cz, 10.8, 8.8, 0.5, 'concrete');
  b.wallWithGaps(cx - 5, cz - 4, 10, 3, 0.5, 'x', 'concrete', [[3.5, 2.4]], 0, gy);
  b.wallWithGaps(cx - 5, cz + 4, 10, 3, 0.5, 'x', 'concrete', [], 0, gy);
  b.wallWithGaps(cx - 5, cz - 4, 8, 3, 0.5, 'z', 'concrete', [], 0, gy);
  b.wallWithGaps(cx + 5, cz - 4, 8, 3, 0.5, 'z', 'concrete', [], 0, gy);
  b.loot(cx, gy + 0.4, cz + 1);
}

function sandbagLine(b: WorldBuilder, cx: number, cz: number, len: number, yaw: number): void {
  const segs = Math.floor(len / 2.2);
  for (let i = 0; i < segs; i++) {
    const off = (i - segs / 2) * 2.2;
    const sx = cx + Math.cos(yaw) * off;
    const sz = cz + Math.sin(yaw) * off;
    b.box(sx, terrainH(sx, sz) + 0.55, sz, 2.2, 1.1, 0.9, 'sandbag', yaw);
  }
}

function watchtower(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  for (const [lx, lz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]] as const) {
    b.box(cx + lx, gy + 5, cz + lz, 0.4, 10, 0.4, 'woodDark');
  }
  b.slab(cx, gy + 10.2, cz, 6, 6, 0.4, 'woodDark');
  // Leave a capsule-width opening where the stair meets the south edge.
  b.wallWithGaps(cx - 3, cz - 3, 6, 1.1, 0.25, 'x', 'woodDark', [[1.8, 2.4]], 0, gy + 10.2);
  b.wallWithGaps(cx - 3, cz + 3, 6, 1.1, 0.25, 'x', 'woodDark', [], 0, gy + 10.2);
  b.wallWithGaps(cx - 3, cz - 3, 6, 1.1, 0.25, 'z', 'woodDark', [], 0, gy + 10.2);
  b.wallWithGaps(cx + 3, cz - 3, 6, 1.1, 0.25, 'z', 'woodDark', [], 0, gy + 10.2);
  // Recalculate the low end after stair normalization. The original 17 steep
  // steps expanded to a 23 m safe run while keeping their old tower-adjacent
  // start, so the staircase climbed away from the deck. Anchor the high edge
  // to the deck and derive the low end from the local terrain instead.
  const stairX = cx;
  const deckEdgeZ = cz - 3;
  const deckTop = gy + 10.2;
  let stairPlan = planStairs(17, 0.6, 0.62, 1.6);
  let stairStartZ = deckEdgeZ - stairPlan.run;
  let stairStartY = terrainH(stairX, stairStartZ);
  for (let pass = 0; pass < 3; pass++) {
    const rise = deckTop - stairStartY;
    const steps = Math.max(1, Math.ceil(rise / 0.34));
    stairPlan = planStairs(steps, rise / steps, 0.62, 1.6);
    stairStartZ = deckEdgeZ - stairPlan.run;
    stairStartY = terrainH(stairX, stairStartZ);
  }
  const finalRise = deckTop - stairStartY;
  b.stairs(
    stairX, stairStartY, stairStartZ, 0,
    stairPlan.steps, finalRise / stairPlan.steps, stairPlan.stepD, stairPlan.width,
    'woodDark',
  );
  // The long exposed flight needs a visible fall edge and repeated vertical
  // load rhythm. Continuous sloped rails sit 0.9 m above the tread line and
  // seven paired posts tie them back into the steps; all remain visual-only
  // so the proven capsule-clear stair width is unchanged.
  const stairSlope = Math.atan2(finalRise, stairPlan.run);
  const stairSlopeLength = Math.hypot(stairPlan.run, finalRise);
  const railCentreZ = stairStartZ + stairPlan.run / 2;
  for (const side of [-1, 1]) {
    const railX = stairX + side * (stairPlan.width / 2 + 0.04);
    // The guard envelope sits a hand-width outside the visible rail line so
    // the walking lane keeps full clearance beside the rail: a capsule hugging
    // the outer corner of the base riser must still autostep cleanly.
    b.guardRail(
      { x: railX + side * 0.1, z: stairStartZ },
      { x: railX + side * 0.1, z: stairStartZ + stairPlan.run },
      stairStartY - 0.15,
      stairStartY + finalRise + 1.0,
    );
    for (const railHeight of [0.52, 0.94]) {
      b.box(
        railX,
        stairStartY + finalRise / 2 + railHeight,
        railCentreZ,
        0.1,
        0.1,
        stairSlopeLength,
        'woodDark',
        0,
        { noCollide: true, pitch: -stairSlope },
      );
    }
    for (let post = 0; post <= 6; post++) {
      const t = post / 6;
      const postBaseY = stairStartY + finalRise * t;
      b.box(
        railX,
        postBaseY + 0.47,
        stairStartZ + stairPlan.run * t,
        0.11,
        0.94,
        0.11,
        'woodDark',
        0,
        { noCollide: true },
      );
    }
  }
  // The normalized safe flight is over twenty metres long. End-supported
  // stringers alone read as a floating ladder from the checkpoint approach,
  // so carry both rails on two terrain-grounded trestles. They are visual
  // supports only and do not narrow the playable stair corridor.
  for (const t of [0.34, 0.68]) {
    const supportZ = stairStartZ + stairPlan.run * t;
    const supportTop = stairStartY + finalRise * t - 0.25;
    const supportGround = terrainH(stairX, supportZ);
    const supportHeight = Math.max(0.4, supportTop - supportGround);
    for (const side of [-1, 1]) {
      b.box(
        stairX + side * (stairPlan.width / 2 - 0.14),
        supportGround + supportHeight / 2,
        supportZ,
        0.22,
        supportHeight,
        0.22,
        'woodDark',
        0,
        { noCollide: true },
      );
    }
    b.box(
      stairX,
      supportTop - 0.16,
      supportZ,
      stairPlan.width + 0.22,
      0.18,
      0.24,
      'woodDark',
      0,
      { noCollide: true },
    );
  }
  b.chest(cx, gy + 10.6, cz, 'vault');
  b.loot(cx + 1.5, gy + 10.7, cz - 1.5);
}

function logCabins(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  for (let i = 0; i < 2; i++) {
    const lx = cx + i * 22;
    const lz = cz + (i % 2) * 14;
    const gy = structureBaseY(terrainH, lx, lz, 10, 9);
    addBuilding(b, {
      x: lx, z: lz, baseY: gy, w: 10, d: 9, floors: 1, wallMat: 'woodDark', trimMat: 'wood',
      doors: [[0, 4, 1.8]], interiorDividers: false, windows: false,
    });
    b.loot(lx + 2, gy + 0.4, lz + 2);
  }
  void rng;
}

function lumberPile(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  for (let i = 0; i < 8; i++) {
    const x = cx + rng.range(-3, 3);
    const z = cz + rng.range(-2, 2);
    const radius = 0.42;
    const length = 4;
    const yaw = rng.range(-0.16, 0.16);
    const y = terrainH(x, z) + radius + Math.floor(i / 4) * radius * 1.9;
    b.cyl(x, y, z, radius, length, 'woodDark', { noCollide: true, yaw, roll: Math.PI / 2 });
    b.box(x, y, z, length, radius * 2, radius * 2, 'woodDark', yaw, { noRender: true });
  }
}

function campfire(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.rock(cx + Math.cos(a) * 1.4, cz + Math.sin(a) * 1.4, gy, 0.4);
  }
  b.light(cx, gy + 1, cz, 0xff8a4f, 2.2, 18);
}

function tunnel(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  // Split the hill into two shoulders and a cap. A single solid hill box made
  // the apparent bore physically impassable and swallowed its loot.
  b.box(cx, gy + 9, cz - 9.25, 46, 18, 11.5, 'rock');
  b.box(cx, gy + 9, cz + 9.25, 46, 18, 11.5, 'rock');
  b.box(cx, gy + 11.3, cz, 46, 13.4, 7, 'rock');
  // Tunnel walls: two side walls + roof slab, open ends
  b.wallWithGaps(cx - 20, cz - 3.5, 40, 4.4, 1, 'x', 'stoneBrick', [], 0, gy);
  b.wallWithGaps(cx - 20, cz + 3.5, 40, 4.4, 1, 'x', 'stoneBrick', [], 0, gy);
  b.slab(cx, gy + 4.6, cz, 42, 9, 0.8, 'stoneBrick');
  b.light(cx - 8, gy + 3.6, cz, 0xffd9a0, 1.4, 16);
  b.light(cx + 8, gy + 3.6, cz, 0xffd9a0, 1.4, 16);
  b.loot(cx, gy + 0.4, cz);
  b.crate(cx - 6, gy + 0.2, cz + 1.5, 1);
}

function chapel(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 10, 16);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 10, d: 16, floors: 1, floorHeight: 5.5, wallMat: 'stoneBrick', trimMat: 'marble',
    doors: [[0, 4, 1.8]], interiorDividers: false, parapet: false,
  });
  b.cyl(cx, gy + 7.5, cz - 6, 1.4, 3, 'roofTile');
  b.sphere(cx, gy + 9.6, cz - 6, 0.8, 'gold');
  b.loot(cx, gy + 0.4, cz + 2);
}

function stoneBridge(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  const deckTop = gy + 3.4;
  b.slab(cx, deckTop, cz, 8, 26, 0.8, 'stoneBrick');
  b.wallWithGaps(cx - 4, cz - 13, 26, 1, 0.5, 'z', 'stoneBrick', [], 0, deckTop);
  b.wallWithGaps(cx + 4, cz - 13, 26, 1, 0.5, 'z', 'stoneBrick', [], 0, deckTop);
  // The former 26 m deck was a single unsupported beam floating several
  // metres over the floodplain. Three paired masonry bents now carry it into
  // local terrain, with visible footings and cap stones at each load path.
  const deckBottom = deckTop - 0.4;
  for (const pierZ of [cz - 8.5, cz, cz + 8.5]) {
    for (const pierX of [cx - 2.55, cx + 2.55]) {
      const ground = terrainH(pierX, pierZ);
      const pierHeight = Math.max(0.4, deckBottom - ground);
      b.box(pierX, ground + 0.18, pierZ, 1.75, 0.36, 2.3, 'stoneBrick');
      b.box(pierX, ground + pierHeight / 2, pierZ, 1.1, pierHeight, 1.55, 'stoneBrick');
    }
    b.box(cx, deckBottom - 0.22, pierZ, 8.4, 0.44, 2, 'stoneBrick');
  }
  // Carry the physical bent rhythm onto both visible elevations. The first
  // curved-block experiment read as floating sawteeth in a real gameplay
  // frame, so the accepted treatment uses grounded pilaster faces and stepped
  // caps aligned exactly with the authoritative supports.
  for (const pierZ of [cz - 8.5, cz, cz + 8.5]) {
    for (const sideX of [cx - 4.26, cx + 4.26]) {
      const ground = terrainH(sideX, pierZ);
      const pilasterHeight = Math.max(0.5, deckBottom - ground);
      b.box(sideX, ground + pilasterHeight / 2, pierZ, 0.38, pilasterHeight, 1.8, 'stoneBrick', 0, { noCollide: true });
      b.box(sideX, deckBottom - 0.36, pierZ, 0.56, 0.38, 2.65, 'marble', 0, { noCollide: true });
    }
  }
  // Continuous string and coping courses terminate the side wall and
  // parapets without changing their collision profile.
  for (const sideX of [cx - 4.26, cx + 4.26]) {
    b.box(sideX, deckBottom + 0.02, cz, 0.4, 0.18, 26.4, 'marble', 0, { noCollide: true });
  }
  for (const sideX of [cx - 4, cx + 4]) {
    b.box(sideX, deckTop + 1.02, cz, 0.72, 0.16, 26.4, 'marble', 0, { noCollide: true });
  }
  // Four shallow relieving arches finally give the long box girder a readable
  // masonry load path. Each ring follows an elliptical tangent in the Y/Z
  // plane; it is presentation-only because the paired bents remain the honest
  // physical support and the floodplain openings must stay traversable.
  for (const spanZ of [cz - 4.25, cz + 4.25]) {
    for (const sideX of [cx - 4.27, cx + 4.27]) {
      const radiusZ = 3.45;
      const radiusY = 2.35;
      const centreY = deckBottom - radiusY - 0.18;
      for (let i = 0; i < 9; i++) {
        const theta = 0.12 + (Math.PI - 0.24) * i / 8;
        const z = spanZ + Math.cos(theta) * radiusZ;
        const y = centreY + Math.sin(theta) * radiusY;
        const tangentZ = -radiusZ * Math.sin(theta);
        const tangentY = radiusY * Math.cos(theta);
        const pitch = -Math.atan2(tangentY, tangentZ);
        b.box(sideX, y, z, 0.46, 0.34, 1.08, 'marble', 0, { noCollide: true, pitch });
      }
    }
  }
  // Anchor each high edge to the bridge. Normalization lengthens the run, so
  // retaining the old bridge-adjacent low coordinates made both flights climb
  // away from the deck and terminate in open terrain.
  for (const side of [-1, 1] as const) {
    let stairPlan = planStairs(6, 0.57, 0.6, 8);
    let stairStartZ = cz + side * (13 + stairPlan.run);
    let stairStartY = terrainH(cx, stairStartZ);
    for (let pass = 0; pass < 3; pass++) {
      const rise = deckTop - stairStartY;
      const steps = Math.max(1, Math.ceil(Math.abs(rise) / 0.34));
      stairPlan = planStairs(steps, rise / steps, 0.6, 8);
      stairStartZ = cz + side * (13 + stairPlan.run);
      stairStartY = terrainH(cx, stairStartZ);
    }
    const finalRise = deckTop - stairStartY;
    b.stairs(
      cx, stairStartY, stairStartZ, side === 1 ? 2 : 0,
      stairPlan.steps, finalRise / stairPlan.steps, stairPlan.stepD, stairPlan.width,
      'stoneBrick',
    );
  }
  b.chest(cx, gy + 3.8, cz, 'standard');
}

function quarry(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  const bottomY = terrainH(cx, cz);
  // The working floor and east access used to sit underneath the continuous
  // heightfield. That buried the elite chest and made the authored stair-ramp
  // decorative only. Cut the same exact openings used by render and physics,
  // then explicitly retain the floor, steps and quarry walls.
  b.terrainCutout({
    minX: cx - 11,
    maxX: cx + 11,
    minZ: cz - 8,
    maxZ: cz + 8,
    surfaceY: bottomY,
  });
  b.terrainCutout({
    minX: cx + 8.4,
    maxX: cx + 22.6,
    minZ: cz - 2.45,
    maxZ: cz + 2.45,
    surfaceY: bottomY,
  });
  b.box(cx, bottomY - 0.12, cz, 22, 0.4, 16, 'dirt', 0, {
    floor: true,
    preserveInTerrainCutout: true,
  });
  const retainingH = Math.max(3.2, terrainH(cx - 12, cz) - bottomY + 0.8);
  b.box(cx - 11.35, bottomY + retainingH / 2, cz, 0.7, retainingH, 16.7, 'stoneBrick', 0, {
    preserveInTerrainCutout: true,
  });
  for (const z of [cz - 8.35, cz + 8.35]) {
    b.box(cx, bottomY + retainingH / 2, z, 22, retainingH, 0.7, 'stoneBrick', 0, {
      preserveInTerrainCutout: true,
    });
  }
  let quarryRocks = 0;
  const circleIntersectsRect = (
    x: number, z: number, radius: number,
    minX: number, maxX: number, minZ: number, maxZ: number,
  ) => {
    const dx = Math.max(minX - x, 0, x - maxX);
    const dz = Math.max(minZ - z, 0, z - maxZ);
    return dx * dx + dz * dz < radius * radius;
  };
  for (let attempt = 0; quarryRocks < 10 && attempt < 300; attempt++) {
    const rx = cx + rng.range(-26, 26);
    const rz = cz + rng.range(-20, 20);
    const scale = rng.range(0.8, 2);
    const radius = ROCK_CLEARANCE_RADIUS * scale;
    // The removed analytic surface is not a valid support. Keep the entire
    // visible/collision footprint outside both the pit and its stair cut so a
    // boulder cannot float over the finished floor or intersect a retaining wall.
    const blocksExcavation = circleIntersectsRect(
      rx, rz, radius, cx - 11, cx + 11, cz - 8, cz + 8,
    ) || circleIntersectsRect(
      rx, rz, radius, cx + 8.4, cx + 22.6, cz - 2.45, cz + 2.45,
    );
    // Preserve one continuous circulation lane from the east ramp across the
    // working floor, not merely the ramp mouth.
    const blocksAccess = rx + radius > cx - 10 && rx - radius < cx + 23
      && rz + radius > cz - 3.4 && rz - radius < cz + 3.4;
    const blocksChest = Math.hypot(rx - (cx - 6), rz - (cz - 4)) < radius + 1.8;
    const overlapsRock = b.def.rocks.some((rock) => (
      Math.hypot(rock.x - rx, rock.z - rz)
        < (ROCK_CLEARANCE_RADIUS * rock.scale + radius) * 0.82
    ));
    if (blocksExcavation || blocksAccess || blocksChest || overlapsRock) continue;
    b.rock(rx, rz, terrainH(rx, rz), scale);
    quarryRocks++;
  }
  // Broad stair-ramp follows the east cut from the flat floor to the rim.
  const rimX = cx + 22;
  const rise = terrainH(rimX, cz) - (bottomY + 0.08);
  // Normalize the count before deriving tread depth. Otherwise WorldBuilder
  // adds steps but preserves the old wide tread, extending past the cutout.
  const steps = Math.max(4, Math.ceil(Math.abs(rise) / STAIR_MAX_RISE));
  b.stairs(cx + 9, bottomY + 0.08, cz, 1, steps, rise / steps, 13 / steps, 4, 'dirt');
  // Low stepped parapets make the cut legible and keep the capsule away from
  // the raw terrain edge without closing the approach corridor.
  for (let i = 0; i < steps; i++) {
    const stepD = 13 / steps;
    const x = cx + 9 + stepD * (i + 0.5);
    const topY = bottomY + 0.08 + rise * (i + 1) / steps;
    for (const z of [cz - 2.25, cz + 2.25]) {
      b.box(x, topY + 0.45, z, stepD + 0.08, 0.9, 0.35, 'stoneBrick', 0, {
        preserveInTerrainCutout: true,
      });
    }
  }
  b.chest(cx - 6, bottomY + 0.08, cz - 4, 'elite');
  b.loot(cx + 4, bottomY + 0.12, cz + 5);
}

function shrine(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  b.box(cx, gy + 1, cz, 3, 2, 3, 'stoneBrick');
  b.box(cx, gy + 2.4, cz, 3.6, 0.4, 3.6, 'marble');
  b.loot(cx + 2, gy + 0.4, cz + 2);
  b.crate(cx - 2.5, gy + 0.2, cz + 1, 0.9);
}

function waterMill(b: WorldBuilder, cx: number, cz: number): void {
  const gy = structureBaseY(terrainH, cx, cz, 12, 12);
  addBuilding(b, {
    x: cx, z: cz, baseY: gy, w: 12, d: 12, floors: 2, wallMat: 'stoneBrick', trimMat: 'woodDark', roofMat: 'roofTile',
    doors: [[0, 5, 2]],
  });
  // Wheel
  b.cyl(cx + 7.4, gy + 3, cz, 3, 1, 'woodDark', { segments: 12 });
  b.loot(cx - 3, gy + 0.4, cz + 3);
  b.chest(cx + 2, gy + 0.3, cz - 2, 'standard');
}

function orchard(b: WorldBuilder, rng: Rng, cx: number, cz: number): void {
  for (let ix = 0; ix < 4; ix++) {
    for (let iz = 0; iz < 4; iz++) {
      const tx = cx - 18 + ix * 12;
      const tz = cz - 18 + iz * 12;
      b.tree({ x: tx, z: tz, y: terrainH(tx, tz), scale: rng.range(0.8, 1.1), variant: 'oak' });
    }
  }
  b.crate(cx, terrainH(cx, cz) + 0.2, cz, 1.1);
  b.loot(cx + 4, terrainH(cx + 4, cz) + 0.4, cz + 4);
}

function ruinsSpot(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const h = 2 + (i % 3);
    b.cyl(cx + Math.cos(a) * 5, gy + h / 2, cz + Math.sin(a) * 5, 0.8, h, 'marble');
  }
  b.chest(cx, gy + 0.3, cz, 'standard');
}

function crossroads(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  // Project the crossing onto the rolling terrain. The former 30 m floor slab
  // and eight independently levelled dirt boxes floated at their corners and
  // read as stacked tiles from gameplay cameras.
  b.surfacePath([
    { x: cx - 20, z: cz + 0.8, width: 10.2 },
    { x: cx - 10, z: cz - 0.5, width: 11.4 },
    { x: cx, z: cz, width: 13.2 },
    { x: cx + 10, z: cz + 0.6, width: 11.2 },
    { x: cx + 20, z: cz - 0.9, width: 9.8 },
  ], 'dirt', 0.04);
  b.surfacePath([
    { x: cx - 0.7, z: cz - 20, width: 9.6 },
    { x: cx + 0.5, z: cz - 10, width: 11.3 },
    { x: cx, z: cz, width: 13.2 },
    { x: cx - 0.6, z: cz + 10, width: 11.1 },
    { x: cx + 0.8, z: cz + 20, width: 9.7 },
  ], 'dirt', 0.041);
  // signpost
  b.cyl(cx + 4, gy + 1.6, cz + 4, 0.14, 3.2, 'woodDark');
  b.box(cx + 4, gy + 2.9, cz + 4.4, 1.6, 0.3, 0.08, 'wood');
  b.crate(cx - 5, gy + 0.2, cz - 3, 1);
  b.loot(cx + 2, gy + 0.4, cz - 5);
}

function crates(b: WorldBuilder, rng: Rng, cx: number, cz: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = cx + rng.range(-6, 6);
    const z = cz + rng.range(-6, 6);
    b.crate(x, terrainH(x, z) + 0.2, z, rng.range(0.8, 1.3));
  }
}

function well(b: WorldBuilder, cx: number, cz: number): void {
  const gy = terrainH(cx, cz);
  b.cyl(cx, gy + 0.7, cz, 1.6, 1.4, 'stoneBrick');
  b.box(cx - 1.2, gy + 2.4, cz, 0.2, 2.4, 0.2, 'woodDark');
  b.box(cx + 1.2, gy + 2.4, cz, 0.2, 2.4, 0.2, 'woodDark');
  b.box(cx, gy + 3.6, cz, 3, 0.3, 2.4, 'roofTile');
}

// ---------------------------------------------------------------------------
// Environment dressing: worn roads, lanterns, banners, window glow, clutter
// ---------------------------------------------------------------------------

function decorateOldFront(b: WorldBuilder, rng: Rng): void {
  // Worn terrain-following ribbons link the main POIs. A single welded strip
  // avoids the black seams and floating corners produced by overlapping boxes.
  const road = (x1: number, z1: number, x2: number, z2: number) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(2, Math.round(len / 4.5));
    const points: Array<{ x: number; z: number; width: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x1 + (x2 - x1) * t + Math.sin(t * 9.1) * 2.6;
      const pz = z1 + (z2 - z1) * t + Math.cos(t * 7.3) * 2.4;
      points.push({ x: px, z: pz, width: rng.range(6.4, 8.4) });
    }
    b.surfacePath(points, 'dirt', 0.035);
  };
  road(20, -10, 110, 30);       // square → old town
  road(20, -10, -150, -150);    // square → keep
  road(-150, -150, -170, 60);   // keep → checkpoint
  road(20, -10, 60, -120);      // square → shrine north
  road(110, 30, 190, 60);       // old town → orchard
  road(20, -10, -30, 210);      // square → mill
  road(110, 30, 150, 170);      // old town → farmstead

  // Iron lantern posts in inhabited areas (warm pools at dusk)
  const lantern = (x: number, z: number) => {
    const gy = terrainH(x, z);
    b.cyl(x, gy + 1.35, z, 0.07, 2.7, 'metalDark');
    b.box(x + 0.16, gy + 2.72, z, 0.34, 0.4, 0.34, 'metalDark', 0, { noCollide: true });
    b.box(x + 0.16, gy + 2.66, z, 0.24, 0.26, 0.24, 'neonOrange', 0, { noCollide: true });
    b.light(x + 0.16, gy + 2.55, z, 0xffc98a, 1.15, 13);
  };
  for (let i = 0; i < 6; i++) {
    lantern(-6 + i * 11, -14);
    lantern(i * 11 + 88, 22);
    lantern(-24 + i * 9, 6);
  }
  lantern(96, 58); lantern(116, 58); lantern(20, -44); lantern(32, -40);
  lantern(138, 158); lantern(168, 178); lantern(-170, 56); lantern(-160, 78);

  // Heraldic banners on major facades (swaying cloth is faked with slight tilt)
  const bannerCols: MatKey[] = ['roofTile', 'rust'];
  const bannerAt = (x: number, y: number, z: number, yaw: number, col: MatKey) => {
    b.box(x, y, z, 1.15, 3.1, 0.07, col, yaw, { noCollide: true });
    b.box(x, y - 1.75, z, 1.25, 0.16, 0.09, 'gold', yaw, { noCollide: true });
    b.box(x, y + 1.62, z, 1.35, 0.12, 0.1, 'woodDark', yaw, { noCollide: true });
  };
  bannerAt(20, terrainH(20, -33) + 3.5, -33.6, 0, bannerCols[0]!);
  bannerAt(27, terrainH(28, -33) + 3.5, -33.6, 0, bannerCols[1]!);
  bannerAt(100, terrainH(100, 39) + 3.5, 39.4, Math.PI, bannerCols[0]!);
  bannerAt(116, terrainH(116, 39) + 3.5, 39.4, Math.PI, bannerCols[1]!);
  bannerAt(-18, terrainH(-18, -21) + 3.5, -20.4, Math.PI, bannerCols[0]!);
  bannerAt(58, terrainH(58, -21) + 3.5, -20.4, Math.PI, bannerCols[1]!);

  // Warm evening windows on stone/plaster homes (candlelight only — cyan
  // glows read as anachronistic waterfalls on medieval facades)
  const glowMats: MatKey[] = ['neonOrange', 'neonOrange'];
  for (const g of [...b.def.geo]) {
    if (g.kind !== 'box') continue;
    const m = g.mat;
    if (m !== 'plaster' && m !== 'plasterOld' && m !== 'stoneBrick') continue;
    if (Math.min(g.sx, g.sz) < 8 || g.sy < 4.5 || g.sy > 10) continue;
    for (const face of [{ axis: 'z' as const, sign: 1 }, { axis: 'z' as const, sign: -1 }]) {
      const cols = Math.max(2, Math.floor((g.sx - 3) / 2.4));
      const rows = Math.max(1, Math.floor((g.sy - 2) / 2.4));
      for (let cIdx = 0; cIdx < cols; cIdx++) {
        for (let rw = 0; rw < rows; rw++) {
          if (!rng.bool(0.34)) continue;
          const wx = g.x - g.sx / 2 + 1.6 + cIdx * ((g.sx - 3) / Math.max(1, cols - 1));
          const wy = g.y - g.sy / 2 + 1.7 + rw * 2.3;
          const wz = g.z + face.sign * (g.sz / 2 + 0.06);
          b.def.geo.push({
            kind: 'box', x: wx, y: wy, z: wz,
            sx: 0.85, sy: 0.95, sz: 0.05, yaw: 0,
            mat: glowMats[rng.int(0, 1)]!, noCollide: true,
          });
        }
      }
    }
  }

  // Storytelling clutter: barrels, firewood, wheelbarrows, clotheslines
  const barrel = (x: number, z: number) => {
    const gy = terrainH(x, z);
    b.cyl(x, gy + 0.55, z, 0.52, 1.1, 'woodDark');
    b.cyl(x, gy + 0.55, z, 0.54, 0.08, 'rust');
  };
  const firewood = (x: number, z: number) => {
    for (let i = 0; i < 5; i++) {
      const lx = x + (i % 3) * 0.5 - 0.5;
      const radius = 0.2;
      const length = 2.2;
      const y = terrainH(lx, z) + radius + Math.floor(i / 3) * radius * 1.9;
      b.cyl(lx, y, z, radius, length, 'wood', { noCollide: true, roll: Math.PI / 2 });
      b.box(lx, y, z, length, radius * 2, radius * 2, 'wood', 0, { noRender: true });
    }
  };
  barrel(30, -16); barrel(31.4, -17.2); barrel(102, 36); barrel(103.5, 37.4);
  barrel(142, 160); barrel(-164, 64); barrel(94, 192); barrel(22, -48);
  firewood(84, 16); firewood(126, 54); firewood(90, 186); firewood(-140, -136);

  // Gravestones & hedges around chapel for lived-in feel
  for (let i = 0; i < 8; i++) {
    const gx = -60 + rng.range(-9, 9);
    const gz = 130 + 8 + rng.range(-6, 8);
    const gy = terrainH(gx, gz);
    b.box(gx, gy + 0.45, gz, 0.7, 0.9, 0.16, 'stoneBrick', rng.range(-0.2, 0.2), { noCollide: true });
  }

  // Market stalls in Old Town square
  const stall = (x: number, z: number, yaw: number) => {
    const gy = terrainH(x, z);
    b.box(x, gy + 1.05, z, 3.6, 0.16, 1.9, 'wood', yaw);
    for (const s of [-1, 1]) b.box(x + Math.cos(yaw) * s * 1.7, gy + 0.53, z + Math.sin(yaw) * s * 1.7, 0.14, 1.05, 0.14, 'woodDark', 0, { noCollide: true });
    b.box(x, gy + 2.35, z, 4.1, 0.12, 2.3, 'roofTile', yaw, { noCollide: true });
    b.crate(x + 1.4, gy + 0.2, z + 1.6, 0.85);
    b.loot(x - 1.2, gy + 1.35, z);
  };
  stall(100, 24, 0.2); stall(112, 26, 0.2); stall(106, 42, Math.PI / 2 + 0.15);
}
