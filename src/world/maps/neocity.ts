/**
 * NEO CITY — near-future neon metropolis at night.
 * Dense urban grid, enterable towers, rooftops, plaza, transit hub with
 * underground level, alleys, vehicle cover, strong colored lighting.
 */

import { planStairs, WorldBuilder } from '../builder';
import type { MapDef, MatKey } from '../types';
import { Rng } from '../../core/rng';
import { addBuilding as addBaseBuilding, addGround, hardenExposedFlanks, slabWithHole, type BuildingOpts } from './common';

const S = 500; // map size
const TRANSIT_CUTOUT = { minX: 117.7, maxX: 121.3, minZ: -140, maxZ: -127, surfaceY: 0 };

function addBuilding(b: WorldBuilder, o: BuildingOpts): void {
  addBaseBuilding(b, o);
  const height = (o.floors ?? 1) * (o.floorHeight ?? 3.6);
  const baseY = o.baseY ?? 0;
  const yaw = o.yaw ?? 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  for (const localX of [-o.w / 2 - 0.08, o.w / 2 + 0.08]) {
    for (const localZ of [-o.d / 2 - 0.08, o.d / 2 + 0.08]) {
      const x = o.x + localX * c - localZ * s;
      const z = o.z + localX * s + localZ * c;
      b.box(x, baseY + height / 2, z, 0.22, height, 0.22, 'metalExterior', yaw, {
        noCollide: true,
        castShadow: false,
      });
    }
  }
}

export function buildNeoCity(): MapDef {
  const rng = new Rng(0x0c17 + 7);
  const b = new WorldBuilder('neocity', 'NEO CITY', 'A rain-slicked neon district. Fight through streets, arcologies and rooftops.', S);

  addGround(b, S, 'asphalt', 0, true, [TRANSIT_CUTOUT]);

  // Street grid: roads every 100u. Along-Z strips stay continuous; along-X
  // strips are segmented between crossings so no two rendered tops share a
  // plane — the previous full-span strips stacked coplanar road/curb faces at
  // all 25 intersections and flickered from any distance.
  const S2 = S / 2;
  const CROSSINGS = [-200, -100, 0, 100, 200];
  /** Free intervals between [c-h, c+h] bands across the full map span. */
  const gapsBetween = (h: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let cursor = -S2;
    for (const c of CROSSINGS) {
      if (c - h > cursor + 1e-6) out.push([cursor, c - h]);
      cursor = c + h;
    }
    if (S2 > cursor + 1e-6) out.push([cursor, S2]);
    return out;
  };
  const roadSegs = gapsBetween(7);
  const curbSegs = gapsBetween(7.24);
  // Sidewalks split only at perpendicular sidewalk bands so each strip keeps
  // bridging the road as the existing raised crossing table.
  const walkSegs: Array<[number, number]> = [];
  {
    const bands: Array<[number, number]> = [];
    for (const c of CROSSINGS) bands.push([c - 27, c - 7], [c + 7, c + 27]);
    let cursor = -S2;
    for (const [lo, hi] of bands) {
      if (lo > cursor + 1e-6) walkSegs.push([cursor, lo]);
      cursor = Math.max(cursor, hi);
    }
    if (S2 > cursor + 1e-6) walkSegs.push([cursor, S2]);
  }
  const segBox = (
    seg: [number, number], fixed: number, alongX: boolean,
    sx: number, sy: number, sz: number, mat: MatKey, y: number,
    opts?: Parameters<WorldBuilder['box']>[8],
  ): void => {
    const mid = (seg[0] + seg[1]) / 2;
    const len = seg[1] - seg[0];
    if (alongX) b.box(mid, y, fixed, len, sy, sz, mat, 0, opts);
    else b.box(fixed, y, mid, sx, sy, len, mat, 0, opts);
  };

  for (let i = -2; i <= 2; i++) {
    const c = i * 100;
    // Along-Z road: continuous, owns every intersection surface. Along-X
    // roads: segmented so tops only ever abut, never overlap.
    b.box(c, 0.06, 0, 14, 0.12, S, 'concreteDark', 0, { noCollide: true });
    for (const seg of roadSegs) segBox(seg, c, true, 14, 0.12, 14, 'concreteDark', 0.06, { noCollide: true });
    // sidewalk slabs FLANK the 14w road (20w each side, 7..27 from centerline)
    b.box(c + 17, 0.1, 0, 20, 0.2, S, 'paving', 0, { floor: true });
    b.box(c - 17, 0.1, 0, 20, 0.2, S, 'paving', 0, { floor: true });
    for (const seg of walkSegs) {
      segBox(seg, c + 17, true, 20, 0.2, 20, 'paving', 0.1, { floor: true });
      segBox(seg, c - 17, true, 20, 0.2, 20, 'paving', 0.1, { floor: true });
    }
    // Continuous curb lips define the road edge without adding collision
    // snags; the walkable sidewalk slab remains the sole gameplay surface.
    // Both axes break at the perpendicular road (+curb width) so no curb
    // strip crosses an intersection and corner tops never share a plane.
    for (const side of [-1, 1]) {
      for (const seg of curbSegs) {
        segBox(seg, c + side * 7.1, true, 0.28, 0.18, 0.28, 'metalExterior', 0.19, { noCollide: true, castShadow: false });
        segBox(seg, c + side * 7.1, false, 0.28, 0.18, 0.28, 'metalExterior', 0.19, { noCollide: true, castShadow: false });
      }
    }
    // road lane markings (dashed centerline both directions). Every decor box
    // sinks well into the road body (top ~2cm proud of road top 0.12) so no
    // bottom face sits millimetres above the surface and flickers at range.
    // Dashes stop short of intersections — perpendicular dashes crossing in
    // the junction shared one plane (and real streets break the line there).
    const inIntersection = (d: number): boolean =>
      CROSSINGS.some((k) => Math.abs(d - k) < 7 + 1.7);
    for (let d = -S / 2 + 6; d < S / 2 - 6; d += 9) {
      if (!inIntersection(d)) {
        b.box(c, 0.11, d, 0.35, 0.06, 3.4, 'paint', 0, { noCollide: true });
        b.box(d, 0.11, c, 3.4, 0.06, 0.35, 'paint', 0, { noCollide: true });
      }
    }
    // crosswalks near each intersection — striped across the raised sidewalk
    // table (top 0.2), sunken 2cm into it so they read from any distance.
    for (const s of [-1, 1]) {
      for (let k = -6; k <= 6; k += 2.4) {
        b.box(c + k * 0.28, 0.21, c + s * 11.5, 0.5, 0.06, 5.2, 'paint', 0, { noCollide: true });
        b.box(c + s * 11.5, 0.21, c + k * 0.28, 5.2, 0.06, 0.5, 'paint', 0, { noCollide: true });
      }
    }
    // manhole covers + storm drains for street credibility
    for (let d = -S / 2 + 22; d < S / 2 - 22; d += 47) {
      b.cyl(c + 4.2, 0.13, d + ((i + 2) % 3) * 13, 0.55, 0.04, 'metalDark');
      b.cyl(d + ((i + 3) % 4) * 11, 0.13, c - 4.2, 0.55, 0.04, 'metalDark');
      b.box(c + 6.1, 0.12, d, 0.7, 0.06, 1.35, 'metalDark', 0, { noCollide: true, castShadow: false });
      b.box(d, 0.12, c - 6.1, 1.35, 0.06, 0.7, 'metalDark', 0, { noCollide: true, castShadow: false });
      b.box(c - 2.8, 0.1, d + 9, 3.8, 0.086, 6.2, 'concreteDark', ((i * 17 + d) % 5) * 0.045 - 0.09, {
        noCollide: true,
        castShadow: false,
      });
    }
    // A sparse bollard pair protects each outer crossing while leaving the
    // full pedestrian and vehicle lane clear.
    for (const side of [-1, 1]) {
      b.box(c + side * 9.2, 0.52, c + 10.5, 0.18, 0.84, 0.18, 'metalExterior', 0, {
        noCollide: true,
        castShadow: false,
      });
    }
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
  addBuilding(b, { x: 105, z: 105, w: 30, d: 18, floors: 2, wallMat: 'facadeA', doors: [[0, 6, 2.6], [0, 20, 2.6], [2, 12, 2.6]], interiorDividers: false });
  addBuilding(b, { x: 145, z: 108, w: 18, d: 16, floors: 3, wallMat: 'facadeC', doors: [[3, 6, 2.2]] });
  addBuilding(b, { x: 112, z: 142, w: 24, d: 14, floors: 1, wallMat: 'facadeA', doors: [[1, 5, 2.4], [3, 5, 2.4]], interiorDividers: false });
  // Market stalls
  for (let i = 0; i < 6; i++) {
    const sx = 122 + (i % 3) * 12;
    const sz = 124 + Math.floor(i / 3) * 10;
    b.box(sx, 1.1, sz, 4.4, 0.25, 2.4, 'metal');
    b.cyl(sx - 2, 1.25, sz, 0.09, 2.5, 'metalDark');
    b.cyl(sx + 2, 1.25, sz, 0.09, 2.5, 'metalDark');
    b.box(sx, 2.5, sz, 5, 0.18, 3, i % 2 ? 'neonMagenta' : 'neonCyan', 0, {
      noCollide: true,
      castShadow: false,
    });
    b.crate(sx + 1.4, 0.2, sz + 1.6, 0.9);
    b.loot(sx - 1.5, 1.45, sz);
  }
  b.chest(130, 0.3, 132, 'standard');
  b.chest(148, 0.3, 140, 'vault');
  neonSigns(b, [
    [108, 96, 0xff4fd8], [126, 150, 0x53ffe0], [152, 118, 0x7a5cff],
  ]);
  // Mark the broad southern approach as an actual market threshold. The
  // posts sit outside the clear road; the header and luminous inserts are
  // presentation-only so the landmark gains scale without an overhead snag.
  const marketGateZ = 92;
  for (const side of [-1, 1]) {
    const gateX = 120 + side * 9;
    b.box(gateX, 2.15, marketGateZ, 0.48, 4.3, 0.48, 'metalExterior');
    b.box(gateX, 0.22, marketGateZ, 1.1, 0.44, 1.1, 'concreteDark');
    for (const bandY of [1.25, 2.15, 3.05]) {
      b.box(gateX, bandY, marketGateZ - 0.27, 0.72, 0.12, 0.08,
        side < 0 ? 'neonMagenta' : 'neonCyan', 0, { noCollide: true });
    }
  }
  b.box(120, 4.18, marketGateZ, 18.5, 0.34, 0.62, 'metalExterior', 0, { noCollide: true });
  // Luminous insert mounts through the header face (2cm embedded, 2cm proud);
  // the previous 1cm standoff left it flickering against the front face.
  b.box(120, 4.2, marketGateZ - 0.33, 7.4, 0.13, 0.08, 'signDimCyan', 0, { noCollide: true });
  b.light(120, 4.25, marketGateZ - 0.6, 0x67dfff, 1.15, 18);

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
  // Arena field is elevated to y=0.8; rest the van on that deck.
  b.vehicle(-158, 128, 0.2, 0.4, 'van', 0x27313d);

  // ------------------------------------------------------------------
  // POI: RESIDENTIAL BLOCKS (SW)
  // ------------------------------------------------------------------
  b.poi('Resident Blocks', -120, -120, 65);
  addBuilding(b, { x: -135, z: -105, w: 20, d: 16, floors: 3, wallMat: 'facadeA', doors: [[0, 8, 2.2], [1, 6, 2.2]] });
  addBuilding(b, { x: -105, z: -108, w: 18, d: 18, floors: 2, wallMat: 'facadeC', doors: [[0, 7, 2.2], [3, 7, 2.2]] });
  addBuilding(b, { x: -132, z: -138, w: 22, d: 18, floors: 4, wallMat: 'facadeA', doors: [[0, 9, 2.4]], roofAccess: true });
  addBuilding(b, { x: -102, z: -136, w: 16, d: 14, floors: 2, wallMat: 'facadeA', doors: [[0, 6, 2.2], [2, 6, 2.2]] });
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
  addBuilding(b, { x: 42, z: -178, w: 18, d: 16, floors: 3, wallMat: 'facadeA', doors: [[3, 6, 2.2]] });
  // Garden planters on first roof. The grid is centred on the building, not
  // the map origin: laid out from x=0 the west pair hung over the roof's west
  // edge, straight above the fire-escape flight, and its 0.8 m planter box
  // beheaded real KCC ascent one riser below the roof.
  for (let i = 0; i < 4; i++) {
    b.box(8 + (i % 2) * 14 - 7, 7.6, -190 + Math.floor(i / 2) * 10, 5, 0.8, 3, 'concrete');
    b.tree({ x: 8 + (i % 2) * 14 - 7, z: -190 + Math.floor(i / 2) * 10, y: 8, scale: 0.7, variant: 'palm' });
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

  // Street lamps along roads — dense enough that no street segment is dark.
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      if (i === 0 && j === 0) continue;
      const bx = i * 100;
      const bz = j * 100;
      // intersection corners
      b.lampPost(bx + 12, bz + 12, 0, 5.6, 0x9fd8ff, 3.4, 42);
      b.lampPost(bx - 12, bz - 12, 0, 5.6, 0xffb98a, 2.8, 30);
      b.lampPost(bx + 12, bz + 55, 0, 5.6, 0x9fd8ff, 2.8, 32);
      b.lampPost(bx + 55, bz + 12, 0, 5.6, 0xffc9a0, 2.8, 32);
      b.lampPost(bx - 55, bz - 12, 0, 5.6, 0x9fd8ff, 2.8, 32);
      b.lampPost(bx - 12, bz - 55, 0, 5.6, 0xffc9a0, 2.8, 32);
      // mid-block fillers so streets stay readable between intersections
      b.lampPost(bx + 12, bz + 33, 0, 5.4, 0xffd9a0, 2.4, 26);
      b.lampPost(bx + 12, bz - 33, 0, 5.4, 0xffd9a0, 2.4, 26);
      b.lampPost(bx + 33, bz + 12, 0, 5.4, 0xffd9a0, 2.4, 26);
      b.lampPost(bx - 33, bz + 12, 0, 5.4, 0xffd9a0, 2.4, 26);
    }
  }

  // Ambient neon lights
  b.light(120, 8, 120, 0xff4fd8, 2.4, 46);
  b.light(-130, 10, 110, 0x53c8ff, 2.6, 50);
  b.light(125, 6, -125, 0x53ffe0, 2.2, 44);
  b.light(-160, 6, 0, 0xffa04f, 2.0, 40);
  b.light(20, 9, -180, 0x9d6bff, 2.2, 42);

  streetwallFiller(b, rng);
  perimeterBand(b, rng);
  litWindows(b, rng);
  streetDressing(b, rng);
  lotDressing(b, rng);
  applyNeoCityShadowBudget(b);
  removeRoadPaintUnderFoundations(b);

  urbanInfill(b);
  solidifyStructuralPoles(b);
  // Residual exposure only: authored infill above is the primary dressing.
  hardenExposedFlanks(b, { mat: 'concrete', maxProps: 12 });

  return b.finish(
    {
      preset: 'bluehour',
      atmosphere: {
        // Deep blue-hour rain sky: layered low clouds, subdued stars in the
        // gaps, distant urban glow at the horizon. No nebula, no giant moon.
        zenith: 0x0e1730, horizon: 0x27354f,
        discSize: 0.031, discColor: 0xcfd8e6, discGlow: 0.32,
        cloudCover: 0.74, cloudTint: 0x39465c, cloudShade: 0x171d29,
        windSpeed: 0.012, starOpacity: 0.34,
        hazeColor: 0x43536b, hazeStrength: 0.5,
      },
      // Bright blue-hour: authored sky provides both backdrop and IBL, so
      // combat stays readable while everything still reads as night.
      fogColor: 0x33456a,
      fogDensity: 0.0032,
      sunDirection: [-0.45, -0.75, -0.3],
      sunColor: 0xa8c0e8,
      sunIntensity: 2.6,
      ambientColor: 0x93a9d4,
      ambientIntensity: 1.08,
      hemisphereSky: 0x5f7cb8,
      hemisphereGround: 0x2e3646,
      hemisphereIntensity: 1.9,
      exposure: 1.16,
      envIntensity: 0.95,
      backgroundIntensity: 1.0,
      grade: {
        vignette: 0.34,
        saturation: 1.03,
        contrast: 1.02,
        lift: [0.012, 0.015, 0.025],
      },
    },
    { from: [-330, -80], to: [330, 60] },
    { wetGround: true },
  );
}

function applyNeoCityShadowBudget(b: WorldBuilder): void {
  const emissiveMats = new Set<MatKey>([
    'neonCyan', 'neonMagenta', 'neonOrange', 'neonGreen', 'neonBlue',
    'windowWarm', 'windowCool', 'signDimCyan', 'signDimMagenta', 'signDimOrange',
  ]);
  for (const geo of b.def.geo) {
    if (geo.kind !== 'box' || !geo.noCollide) continue;
    if (emissiveMats.has(geo.mat) || Math.min(geo.sx, geo.sy, geo.sz) <= 0.18) {
      geo.castShadow = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Local structure helpers
// ---------------------------------------------------------------------------

/**
 * Streetwall filler: mid-rise blocks lining the street grid in every cell
 * not occupied by a POI. Turns the road grid into a real city — continuous
 * facades, lit windows, occasional towers for skyline variety. Blocks are
 * enterable (street-facing doors) so they add combat routes, not just
 * backdrops.
 */
function streetwallFiller(b: WorldBuilder, rng: Rng): void {
  const pois = b.def.pois;
  const tooClose = (x: number, z: number, margin: number): boolean =>
    pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + margin);

  const facades: MatKey[] = ['facadeA', 'facadeC', 'facadeA'];
  // Grid cells between the -200..200 roads; cell centers at ±50 offsets.
  for (let gx = -2; gx <= 1; gx++) {
    for (let gz = -2; gz <= 1; gz++) {
      const cx = gx * 100 + 50;
      const cz = gz * 100 + 50;
      if (tooClose(cx, cz, 26)) continue;

      // 2–3 blocks per cell on a loose 2x2 sub-grid with jitter
      const subSpots: Array<[number, number]> = [
        [cx - 17, cz - 17], [cx + 16, cz - 15],
        [cx - 15, cz + 17], [cx + 17, cz + 15],
      ];
      const count = rng.int(2, 3);
      const picks = new Set<number>();
      while (picks.size < count) picks.add(rng.int(0, 3));
      for (const idx of picks) {
        const [bx, bz] = subSpots[idx]!;
        const jx = bx + rng.range(-4, 4);
        const jz = bz + rng.range(-4, 4);
        if (tooClose(jx, jz, 12)) continue;
        const tower = rng.bool(0.28);
        const w = tower ? rng.range(15, 20) : rng.range(16, 26);
        const d = tower ? rng.range(15, 20) : rng.range(14, 22);
        const floors = tower ? rng.int(6, 9) : rng.int(2, 5);
        const mat = facades[rng.int(0, facades.length - 1)]!;
        // Doors face the nearest street (cell edge)
        const doorSide = (jx - cx > 8 ? 1 : jx - cx < -8 ? 3 : jz - cz > 8 ? 0 : 2) as 0 | 1 | 2 | 3;
        const doorWallLength = doorSide === 0 || doorSide === 2 ? w : d;
        const nearDoor = 3;
        const farDoor = doorWallLength - nearDoor - 2.2;
        addBuilding(b, {
          x: jx, z: jz, w, d, floors, wallMat: mat,
          doors: [[doorSide, nearDoor, 2.2], [doorSide, farDoor, 2.2]],
          interiorDividers: rng.bool(0.6),
          roofAccess: tower && rng.bool(0.5),
        });
        if (tower) {
          // Rooftop beacon on tall blocks
          b.light(jx, floors * 3.6 + 2.2, jz, rng.bool(0.5) ? 0xff5a5a : 0x5fd0ff, 1.2, 14);
        }
        // Anchored chest beside the entry of some blocks (never in open lots).
        if (rng.bool(0.3)) {
          const off = doorSide === 1 ? w / 2 + 1.6 : doorSide === 3 ? -(w / 2 + 1.6) : rng.range(-w / 3, w / 3);
          const offZ = doorSide === 0 ? d / 2 + 1.6 : doorSide === 2 ? -(d / 2 + 1.6) : rng.range(-d / 3, d / 3);
          b.chest(jx + off, 0.3, jz + offZ, rng.bool(0.2) ? 'elite' : 'standard');
        }
      }
      // Empty sub-lots become small parking lots so cells never read barren.
      for (let sIdx = 0; sIdx < 4; sIdx++) {
        if (picks.has(sIdx) || !rng.bool(0.45)) continue;
        const [lx, lz] = subSpots[sIdx]!;
        const along = rng.bool(0.5);
        for (let k = 0; k < 3; k++) {
          const vx = along ? lx - 6 + k * 6 : lx + rng.range(-2, 2);
          const vz = along ? lz + rng.range(-2, 2) : lz - 6 + k * 6;
          b.vehicle(vx, vz, 0.2, along ? 0 : Math.PI / 2,
            rng.bool(0.3) ? 'van' : 'sedan', [0x27313d, 0x503030, 0x2e3a2f, 0x33384a, 0x6a6f78][rng.int(0, 4)]!);
        }
        b.crate(lx + (along ? 9 : 2), 0.2, lz + (along ? 2 : 9), rng.range(0.9, 1.4));
        if (rng.bool(0.5)) b.loot(lx, 0.4, lz);
      }

      // Alley props between blocks
      if (rng.bool(0.7)) {
        const ax = cx + rng.range(-24, 24);
        const az = cz + rng.range(-24, 24);
        b.crate(ax, 0.2, az, rng.range(0.8, 1.3));
        if (rng.bool(0.5)) b.crate(ax + 1.6, 0.2, az + 1.2, rng.range(0.7, 1.1));
        b.loot(ax - 1.4, 0.4, az + 0.6);
      }
    }
  }
}

/**
 * Outskirt development ring between the outermost roads (±200) and the
 * playable boundary (~±247). Low warehouses, container yards, lots and
 * street clutter so the map edge reads as continuing city, not a void.
 */
function perimeterBand(b: WorldBuilder, rng: Rng): void {
  const pois = b.def.pois;
  const tooClose = (x: number, z: number, margin: number): boolean =>
    pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + margin);

  const spots: Array<[number, number]> = [];
  for (let t = -216; t <= 216; t += 48) {
    spots.push([t, 224], [t, -224], [224, t], [-224, t]);
    if (rng.bool(0.5)) spots.push([t + 24, 222], [t + 24, -222]);
  }

  for (const [sx, sz] of spots) {
    if (tooClose(sx, sz, 16)) continue;
    const roll = rng.next();
    if (roll < 0.42) {
      // Low warehouse / workshop block, door facing the map interior.
      const w = rng.range(18, 26);
      const d = rng.range(14, 20);
      const doorSide = Math.abs(sx) > Math.abs(sz)
        ? (sx > 0 ? 3 : 1)
        : (sz > 0 ? 2 : 0);
      const doorWallLength = doorSide === 0 || doorSide === 2 ? w : d;
      addBuilding(b, {
        x: sx, z: sz, w, d, floors: rng.bool(0.3) ? 2 : 1,
        wallMat: rng.bool(0.5) ? 'rust' : 'metalDark',
        doors: [[doorSide, doorWallLength / 2 - 1.5, 3] as [0 | 1 | 2 | 3, number, number]],
        interiorDividers: false,
      });
      if (rng.bool(0.45)) b.chest(sx + rng.range(-6, 6), 0.3, sz + rng.range(-5, 5), rng.bool(0.25) ? 'elite' : 'standard');
      b.loot(sx + rng.range(-7, 7), 0.4, sz + rng.range(-6, 6));
    } else if (roll < 0.68) {
      // Container / crate yard with cover lanes. Containers sink 2–10 cm by
      // stack index: random yards overlap neighbours, and equal-height tops
      // z-fought across every crossing pair. The invisible walkable platform
      // follows each sink so feet stay on the visible container top.
      const stacks = rng.int(3, 5);
      for (let i = 0; i < stacks; i++) {
        const bx = sx + rng.range(-10, 10);
        const bz = sz + rng.range(-10, 10);
        const sink = 0.02 + i * 0.02;
        b.box(bx, 1.3 - sink, bz, 5.2, 2.6, 2.4, rng.bool(0.5) ? 'rust' : 'metalDark', rng.range(0, Math.PI));
        if (rng.bool(0.35)) b.box(bx + rng.range(-1, 1), 3.9 - sink, bz + rng.range(-1, 1), 5, 2.6, 2.3, 'rust', rng.range(0, Math.PI));
        b.platform(bx - 2.6, bx + 2.6, bz - 1.2, bz + 1.2, 2.6 - sink);
      }
      b.loot(sx + rng.range(-8, 8), 0.4, sz + rng.range(-8, 8));
      if (rng.bool(0.3)) b.chest(sx + rng.range(-9, 9), 0.3, sz + rng.range(-9, 9), 'standard');
    } else if (roll < 0.85) {
      // Parking lot with a couple of cars + light pole
      b.vehicle(sx, sz, 0.2, rng.range(0, Math.PI), rng.bool(0.5) ? 'sedan' : 'van',
        [0x27313d, 0x503030, 0x33384a][rng.int(0, 2)]!);
      if (rng.bool(0.6)) b.vehicle(sx + 7, sz + 4, 0.2, rng.range(0, Math.PI), 'sedan', 0x2e3a2f);
      b.lampPost(sx + 4, sz - 4, 0, 5.4, 0xffd9a0, 2.2, 24);
      b.loot(sx - 4, 0.4, sz + 2);
    } else {
      // Small kiosk cluster + vending alcove
      b.box(sx, 1.5, sz, 4.5, 3, 3.5, 'facadeA');
      b.platform(sx - 2.25, sx + 2.25, sz - 1.75, sz + 1.75, 3.05);
      b.box(sx, 3.2, sz, 5, 0.25, 4, rng.bool(0.5) ? 'neonCyan' : 'neonOrange', 0, { noCollide: true });
      b.light(sx, 3.4, sz + 1.5, 0xffd9a0, 1.2, 14);
      b.crate(sx + 2.4, 0.2, sz + 1.8, 0.95);
      b.loot(sx, 0.4, sz + 3);
    }
  }
}

function rampTo(b: WorldBuilder, cx: number, cz: number, startR: number, topY: number, yaw: number): void {
  const steps = 14;
  const rise = topY / steps;
  const treadD = 0.85;
  const width = 3.2;
  for (let i = 0; i < steps; i++) {
    // Start low on the outside and finish flush with the arena ring. The old
    // ordering climbed away from the destination and also swapped stair width
    // with tread depth, leaving a narrow, disconnected strip.
    const d = startR + (steps - i - 0.5) * treadD;
    const x = cx + Math.cos(yaw) * d;
    const z = cz + Math.sin(yaw) * d;
    const treadTop = rise * (i + 1);
    const alongX = Math.abs(Math.cos(yaw)) > 0.5;
    const sx = alongX ? treadD + 0.05 : width;
    const sz = alongX ? width : treadD + 0.05;
    // Solid risers visually and physically support the exposed arena ramp.
    b.box(x, treadTop / 2, z, sx, treadTop, sz, 'metalDark', 0, { preserveInTerrainCutout: true });
    b.platform(x - sx / 2, x + sx / 2, z - sz / 2, z + sz / 2, treadTop, false, true);
    if (i % 3 === 0 || i === steps - 1) {
      const sideX = alongX ? 0 : width / 2 + 0.08;
      const sideZ = alongX ? width / 2 + 0.08 : 0;
      b.box(x + sideX, treadTop + 0.5, z + sideZ, 0.1, 1, 0.1, 'metalExterior', 0, { noCollide: true });
      b.box(x - sideX, treadTop + 0.5, z - sideZ, 0.1, 1, 0.1, 'metalExterior', 0, { noCollide: true });
    }
  }
}

/**
 * Deterministic mid-block urban infill (v0.4.1): recognizable street
 * furniture families — dumpsters, utility cabinets, planters and delivery
 * crates — at fixed offsets inside the sparse inner blocks between POIs.
 * All placements are collidable, share the batched material system, cast no
 * small-part shadows, and stay clear of the road corridors.
 */
/**
 * v0.4.1 integrity pass: free-standing person-sized poles (light masts, sign
 * posts, awning supports) must stop actors. Poles whose base sits against
 * other solid geometry (wall brackets) stay decorative — they cannot be
 * reached from the open side, and solidifying them would snag movement.
 * Runs before finish() so placement re-checks see the final collidable set.
 */
function solidifyStructuralPoles(b: WorldBuilder): void {
  const geo = b.def.geo;
  const isPole = (g: (typeof geo)[number]): g is Extract<(typeof geo)[number], { kind: 'box' }> =>
    g.kind === 'box' && g.noCollide === true && g.sy >= 1.6
    && Math.max(g.sx, g.sz) <= 0.7 && g.y - g.sy / 2 < 2.2;
  const poles = geo.filter(isPole);
  // Ground layers (streets, sidewalks, floor slabs) are what poles stand ON,
  // not what they attach to — including them made every pole "attached".
  const solids = geo.filter((g) => g.kind === 'box' && g.noCollide !== true
    && !(g.sy >= 1.6 && Math.max(g.sx, g.sz) <= 0.7)
    && !(g.sy <= 2.2 && g.y + g.sy / 2 <= 2.5));
  for (const pole of poles) {
    if (pole.kind !== 'box') continue;
    const attached = solids.some((s) => {
      if (s.kind !== 'box') return false;
      const c = Math.abs(Math.cos(s.yaw));
      const sn = Math.abs(Math.sin(s.yaw));
      const hx = (s.sx * c + s.sz * sn) / 2;
      const hz = (s.sx * sn + s.sz * c) / 2;
      const verticalOverlap = Math.abs(s.y - pole.y) < (s.sy + pole.sy) / 2;
      return verticalOverlap
        && Math.abs(s.x - pole.x) < hx + 0.55
        && Math.abs(s.z - pole.z) < hz + 0.55;
    });
    if (!attached) {
      pole.noCollide = false;
      pole.materialHint = 'metal';
    }
  }
}

function urbanInfill(b: WorldBuilder): void {
  const sites: Array<[number, number]> = [
    [60, 60], [-60, 60], [60, -60], [-64, -56],
    [120, 40], [-40, 128], [96, -60], [-96, 64],
  ];
  for (const [x, z] of sites) {
    // Dumpster: solid mass with a lid lip.
    b.box(x, 0.62, z, 1.7, 1.05, 1.1, 'metalDark', 0, { hint: 'metal' });
    b.box(x, 1.2, z, 1.78, 0.1, 1.16, 'metalDark', 0, { noCollide: true, castShadow: false });
    // Utility cabinet against a short plinth.
    b.box(x + 3.2, 0.7, z + 1.6, 0.95, 1.4, 0.6, 'metalExterior', 0, { hint: 'metal' });
    // Paired planters with a concrete body.
    for (const dz of [-3.4, -1.9]) {
      b.box(x - 2.6, 0.42, z + dz, 1.3, 0.84, 1.1, 'concrete', 0, { hint: 'stone' });
    }
    // Delivery crate pair (destructible, like the rest of the map's crates).
    b.crate(x - 0.4, 0.12, z + 4.6, 1);
    b.crate(x + 0.9, 0.12, z + 4.9, 0.8);
  }
}

function neonSigns(b: WorldBuilder, spots: Array<[number, number, number]>): void {
  const signMats: Record<number, MatKey> = { 0xff4fd8: 'neonMagenta', 0x53ffe0: 'neonGreen', 0x7a5cff: 'neonBlue' };
  for (let index = 0; index < spots.length; index++) {
    const [x, z, color] = spots[index]!;
    const h = index === 0 ? 6.4 : 5.4;
    const postHeight = h + 1.1;
    // Posts and footings are person-sized structural members of a 5-6 m sign
    // assembly: they must stop actors and projectiles. Sign faces and beams
    // above head height remain presentation-only.
    for (const offset of [-2.2, 2.2]) {
      b.box(x + 0.18, 0.18, z + offset, 1.05, 0.36, 1.15, 'concreteDark', 0, {
        castShadow: false,
      });
      b.box(x + 0.18, postHeight / 2, z + offset, 0.3, postHeight, 0.3, 'metalDark', 0, {
        castShadow: false,
      });
    }
    b.box(x, h - 1.45, z, 0.34, 0.28, 5.6, 'metalDark', 0, { noCollide: true, castShadow: false });
    b.box(x + 0.18, h, z, 0.3, 2.9, 6, 'metalDark', 0, { noCollide: true, castShadow: false });
    b.box(x + 0.42, h, z, 0.18, 2.4, 5.4, signMats[color] ?? 'neonCyan', 0, {
      noCollide: true,
      castShadow: false,
    });
    const landmark = index === 0;
    b.light(x + 0.42, h, z, color, landmark ? 2.2 : 1.2, landmark ? 26 : 18);
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
  // Open cut-and-cover entrance west of the room. The former staircase sat
  // below the unbroken global ground slab and intersected the room ceiling.
  const depth = 5;
  const entryX = cx - 5.5;
  const entryZ = cz - 15;
  b.stairs(entryX, 0, entryZ, 0, 10, -depth / 10, 0.78, 2.6, 'concreteDark');
  b.box(entryX - 1.7, -2.5, entryZ + 4, 0.3, 5, 9.2, 'concreteDark');
  b.box(entryX + 1.7, -2.5, entryZ + 4, 0.3, 5, 9.2, 'concreteDark');
  b.slab(entryX, -depth, cz - 6.5, 3.2, 3.8, 0.35, 'concreteDark');
  // Platform box (hollow room underground)
  const py = -depth;
  b.slab(cx, py, cz, 30, 16, 0.5, 'concreteDark');
  slabWithHole(b, cx, py + 4.4, cz, 30, 16, 0.5, 'concreteDark', {
    minX: entryX - 1.8,
    maxX: entryX + 1.8,
    minZ: cz - 9,
    maxZ: cz - 2.5,
  });
  // Give the 2.6 m stair lane a full capsule margin at the room threshold.
  // A 2.4 m gap was technically passable on centre but caught ordinary
  // third-person movement only 2 cm from either jamb.
  b.wallWithGaps(cx - 15, cz - 8, 32, 4.4, 0.5, 'x', 'concrete', [[8, 3]], 0, py);
  b.wallWithGaps(cx - 15, cz + 8, 32, 4.4, 0.5, 'x', 'concrete', [], 0, py);
  b.wallWithGaps(cx - 15, cz - 8, 16, 4.4, 0.5, 'z', 'concrete', [], 0, py);
  b.wallWithGaps(cx + 15, cz - 8, 16, 4.4, 0.5, 'z', 'concrete', [], 0, py);
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
    b.box(kx, 1.5, cz, 5, 3, 4, 'facadeA');
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
  const ramp = planStairs(8, 0.45, 0.65, 3);
  const rampX = cx + 10;
  const rampStartZ = cz - 8;
  const rampEndZ = rampStartZ + ramp.run;
  for (let lvl = 0; lvl < 2; lvl++) {
    const y = lvl * 3.6;
    if (lvl === 0) {
      b.slab(cx, y + 0.4, cz, 30, 20, 0.4, 'concreteDark');
    } else {
      // Keep the complete normalized ramp volume open. The former continuous
      // upper slab crossed the flight at head height, so the access looked
      // plausible from outside but the character capsule hit a solid ceiling.
      slabWithHole(b, cx, y + 0.4, cz, 30, 20, 0.4, 'concreteDark', {
        minX: rampX - ramp.width / 2 - 0.48,
        maxX: rampX + ramp.width / 2 + 0.48,
        minZ: rampStartZ - 0.48,
        maxZ: rampEndZ,
      });
    }
    for (const sx of [-1, 1]) {
      b.box(cx + sx * 15, y + 1.9, cz, 0.4, 3.6, 20, 'concrete');
    }
    b.box(cx, y + 1.9, cz - 10, 30, 3.6, 0.4, 'concrete');
    b.wallWithGaps(cx - 15, cz + 10, 30, 3.6, 0.4, 'x', 'concrete', [[12, 6]], 0, y);
    // ramp between levels
    if (lvl === 0) {
      b.stairs(rampX, y + 0.4, rampStartZ, 0, ramp.steps, ramp.stepH, ramp.stepD, ramp.width, 'concreteDark');
      // The open stairwell needs a readable fall edge. Keep the rails visual-only
      // and just outside the three-metre walking lane so the existing capsule
      // clearance and combat flow remain unchanged.
      const rampSlope = Math.atan2(ramp.totalRise, ramp.run);
      const railLength = Math.hypot(ramp.run, ramp.totalRise);
      const railCentreZ = rampStartZ + ramp.run / 2;
      for (const side of [-1, 1]) {
        const railX = rampX + side * (ramp.width / 2 + 0.04);
        // Continuous guard envelope behind the visible rails: the open
        // stairwell's presentation-only rails must stop a capsule.
        b.guardRail(
          { x: railX, z: rampStartZ },
          { x: railX, z: rampStartZ + ramp.run },
          y + 0.25,
          y + 0.4 + ramp.totalRise + 1.0,
        );
        for (const railHeight of [0.5, 0.9]) {
          b.box(
            railX,
            y + 0.4 + ramp.totalRise / 2 + railHeight,
            railCentreZ,
            0.1,
            0.1,
            railLength,
            'metalDark',
            0,
            { noCollide: true, pitch: -rampSlope },
          );
        }
        for (let post = 0; post <= 4; post++) {
          const t = post / 4;
          b.box(
            railX,
            y + 0.4 + ramp.totalRise * t + 0.45,
            rampStartZ + ramp.run * t,
            0.1,
            0.9,
            0.1,
            'metalDark',
            0,
            { noCollide: true },
          );
        }
      }
    }
    for (let i = 0; i < 2; i++) {
      b.vehicle(cx - 8 + i * 12, cz + 4, y + 0.4, i % 2 ? 0 : Math.PI, 'sedan', 0x2b3038);
    }
  }
  // The upper deck blocks the sky/IBL from the lower level. Give that enclosed
  // combat space authored ceiling fixtures instead of raising the whole map's
  // exposure (which would wash out the streets and neon). The emissive strips
  // make the light sources legible while the nearby point lights reveal cars,
  // loot and opponents without turning the garage into a flat bright box.
  for (const ox of [-9, 0, 9]) {
    b.box(cx + ox, 3.52, cz, 5.4, 0.08, 0.34, 'windowWarm', 0, { noCollide: true });
    b.light(cx + ox, 3.18, cz, 0xffddb0, 1.55, 12.5);
  }
  // A cooler entrance fill preserves the blue-hour palette and prevents the
  // open ramp/door threshold from collapsing to black at oblique camera angles.
  b.box(cx, 3.5, cz + 7.4, 4.6, 0.08, 0.28, 'neonCyan', 0, { noCollide: true });
  b.light(cx, 3.15, cz + 6.5, 0x8fdcff, 0.9, 10);
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
  b.slab(cx, 0.08, cz, 16, 12, 0.5, 'concreteDark');
  b.slab(cx, 3.2, cz, 16.8, 12.8, 0.5, 'concrete');
  // Walls stop 4 cm under the roof surface — flush tops z-fought along the
  // whole parapet when the bunker roof was viewed from neighbouring towers.
  b.wallWithGaps(cx - 8, cz - 6, 16, 3.16, 0.4, 'x', 'concrete', [[6, 2.2]]);
  b.wallWithGaps(cx - 8, cz + 6, 16, 3.16, 0.4, 'x', 'concrete', []);
  b.wallWithGaps(cx - 8, cz - 6, 12, 3.16, 0.4, 'z', 'concrete', []);
  b.wallWithGaps(cx + 8, cz - 6, 12, 3.16, 0.4, 'z', 'concrete', []);
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
  b.wallWithGaps(cx - 30, cz - 5, 60, 1.1, 0.3, 'x', 'concrete', [], 0, 6.4);
  b.wallWithGaps(cx - 30, cz + 5, 60, 1.1, 0.3, 'x', 'concrete', [], 0, 6.4);
  // Access stairs climb along the bridge axis and meet its open end faces.
  // The old flights started at the ends but climbed across the road width,
  // finishing beside the deck instead of on it after stair normalization.
  const access = planStairs(11, 6.8 / 11, 0.6, 2.6);
  // Keep the north-side flights clear of the neighbouring upper-floor slabs.
  // At z=cz the left flight passed through a building ceiling at x≈-74 and
  // the right flight met another floor near x≈12, blocking real KCC ascent.
  // Keep the north-side flights clear of the neighbouring upper-floor slabs.
  // At z=cz the left flight passed through a building ceiling at x=-74 and
  // the right flight met another floor near x=12, blocking real KCC ascent.
  // z=cz+3.2 additionally keeps the 2.6 m lanes clear of the deck parapet
  // band (cz+5), whose end caps otherwise block the top treads' exit lane.
  const accessZ = cz + 3.2;
  b.stairs(cx - 30 - access.run, 0, accessZ, 1, access.steps, access.stepH, access.stepD, access.width, 'concreteDark');
  b.stairs(cx + 30 + access.run, 0, accessZ, 3, access.steps, access.stepH, access.stepD, access.width, 'concreteDark');
  // Exposed 6.8 m flights need readable edges: slim rails on both sides of
  // each access flight, each backed by a continuous guard envelope so the
  // visual rail line actually stops a capsule.
  for (const flightX of [cx - 30 - access.run, cx + 30 + access.run]) {
    // West flight ascends +x, east flight ascends -x.
    const sign = flightX < cx ? 1 : -1;
    for (const side of [-1, 1]) {
      const railZ = accessZ + side * (access.width / 2 + 0.06);
      const slope = Math.atan2(access.totalRise, access.run);
      // Length sits in the box's local z axis with yaw = pi/2 so the sloped
      // handrail runs along the world x axis.
      b.box(
        flightX + sign * access.run / 2,
        access.totalRise / 2 + 0.95,
        railZ,
        0.09,
        0.09,
        Math.hypot(access.run, access.totalRise),
        'metalDark',
        Math.PI / 2,
        { noCollide: true, pitch: -sign * slope },
      );
      for (let post = 0; post <= 8; post++) {
        const t = post / 8;
        b.box(
          flightX + sign * access.run * t,
          access.totalRise * t + 0.5,
          railZ,
          0.09,
          1.0,
          0.09,
          'metalDark',
          0,
          { noCollide: true },
        );
      }
      b.guardRail(
        { x: flightX, z: railZ },
        { x: flightX + sign * access.run, z: railZ },
        -0.15,
        access.totalRise + 1.05,
      );
    }
  }
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
 * Scatters dense emissive window grids over building facades — the core of
 * the night-city look. Windows are laid out floor-by-floor with per-window
 * variety (warm/cool/off), plus occasional full-lit floors and storefront
 * glow strips at street level. Pure decoration (noCollide).
 */
function litWindows(b: WorldBuilder, rng: Rng): void {
  const facadeMats: MatKey[] = ['facadeA', 'facadeB', 'facadeC', 'plasterOld'];
  const warmMats: MatKey[] = [
    'windowWarm', 'windowWarm', 'windowWarm', 'windowWarm',
    'windowWarm', 'windowWarm', 'windowCool', 'windowCool',
  ];
  const geo = b.def.geo;
  let windowIndex = 0;
  let storefrontIndex = 0;
  const pushWindow = (x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: MatKey) => {
    // A sampled deep reveal is enough to break the flat facade silhouette;
    // framing every lit pane would add thousands of world specs and slow
    // headless physics/map setup even though the frames are non-colliding.
    if (windowIndex % 12 === 0) {
      const thinX = sx < sz;
      geo.push({
        kind: 'box', x, y, z,
        sx: thinX ? Math.max(0.04, sx - 0.02) : sx + 0.2,
        sy: sy + 0.2,
        sz: thinX ? sz + 0.2 : Math.max(0.04, sz - 0.02),
        yaw: 0,
        mat: 'metalDark',
        noCollide: true,
        castShadow: false,
      });
    }
    windowIndex++;
    geo.push({ kind: 'box', x, y, z, sx, sy, sz, yaw: 0, mat, noCollide: true, castShadow: false });
  };

  for (const g of b.def.geo) {
    if (g.kind !== 'box') continue;
    if (!facadeMats.includes(g.mat)) continue;
    
    // Walls are emitted per-floor as segmented boxes (wallWithGaps); min dim
    // is the wall thickness — eligibility uses the LONG horizontal axis.
    const longSpan = Math.max(g.sx, g.sz);
    if (longSpan < 1.1 || g.sy < 2.2) continue;
    const faces: Array<{ axis: 'x' | 'z'; sign: number; span: number }> = g.sx >= g.sz
      ? [{ axis: 'z', sign: 1, span: g.sx }, { axis: 'z', sign: -1, span: g.sx }]
      : [{ axis: 'x', sign: 1, span: g.sz }, { axis: 'x', sign: -1, span: g.sz }];

      const rows = Math.max(1, Math.floor((g.sy - 1.1) / 2.6));
      const rowH = g.sy / (rows + 0.6);
    for (const face of faces) {
      const span = face.span;
      const colsF = Math.max(1, Math.floor(span / 2.1));
      const step = span / colsF;
      // A fully-lit "office" row now and then
      const litRow = rng.bool(0.18) ? rng.int(0, rows - 1) : -1;
      for (let f = 0; f < rows; f++) {
        const wy = g.y - g.sy / 2 + rowH * (f + 0.75);
        for (let cIdx = 0; cIdx < colsF; cIdx++) {
          const along = -span / 2 + step * (cIdx + 0.5);
          const roll = rng.next();
          let on = roll < 0.55;
          if (f === litRow) on = roll < 0.94;
          if (!on) continue;
          const mat = warmMats[rng.int(0, warmMats.length - 1)]!;
          const wW = Math.min(1.15, step * 0.62);
          const wH = Math.min(1.3, rowH * 0.55);
          if (face.axis === 'x') {
            pushWindow(g.x + face.sign * (g.sx / 2 + 0.07), wy, g.z + along, 0.07, wH, wW, mat);
          } else {
            pushWindow(g.x + along, wy, g.z + face.sign * (g.sz / 2 + 0.07), wW, wH, 0.07, mat);
          }
        }
      }
      // Street-level storefront band on one face (ground-adjacent walls only)
      if (g.y - g.sy / 2 < 1.4 && rng.bool(0.6)) {
        const wy = g.y - g.sy / 2 + 1.35;
        const bandLen = span * 0.62;
        const addAwning = storefrontIndex++ % 6 === 0;
        if (face.axis === 'x') {
          pushWindow(g.x + face.sign * (g.sx / 2 + 0.09), wy, g.z, 0.1, 0.85, bandLen, rng.bool(0.5) ? 'neonOrange' : 'neonMagenta');
          if (addAwning) {
            b.box(g.x + face.sign * (g.sx / 2 + 0.36), wy + 0.72, g.z, 0.72, 0.14, bandLen + 0.45, 'metalExterior', 0, {
              noCollide: true,
              castShadow: false,
            });
          }
        } else {
          pushWindow(g.x, wy, g.z + face.sign * (g.sz / 2 + 0.09), bandLen, 0.85, 0.1, rng.bool(0.5) ? 'neonOrange' : 'neonMagenta');
          if (addAwning) {
            b.box(g.x, wy + 0.72, g.z + face.sign * (g.sz / 2 + 0.36), bandLen + 0.45, 0.14, 0.72, 'metalExterior', 0, {
              noCollide: true,
              castShadow: false,
            });
          }
        }
      }
    }
  }
}

/**
 * Roadside/lot dressing: the space between building blocks previously read as
 * vast empty lots. Parked cars, planters, transit shelters, dumpsters and
 * barricades now line every road so streets read as a lived-in city.
 */
function lotDressing(b: WorldBuilder, rng: Rng): void {
  const carCols = [0x27313d, 0x503030, 0x2e3a2f, 0x33384a, 0x3a2f28];
  const roadCs = [-200, -100, 0, 100, 200];
  for (let i = -2; i <= 2; i++) {
    const c = i * 100;
    for (let d = -226; d <= 226; d += 24) {
      if (i === 0 && Math.abs(d) < 64) continue; // Spire Plaza
      if (roadCs.some((o) => Math.abs(d - o) < 18)) continue; // intersections
      for (const side of [-1, 1]) {
        if (!rng.bool(0.44)) continue;
        const along = d + rng.range(-5, 5);
        const roll = rng.next();
        for (const flip of [0, 1]) {
          if (flip === 1 && !rng.bool(0.85)) continue;
          const px = flip === 0 ? c + side * 8.4 : along;
          const pz = flip === 0 ? along : c + side * 8.4;
          const yaw = flip === 0 ? 0 : Math.PI / 2;
          if (roll < 0.3) {
            b.vehicle(px, pz, 0.2, yaw + (rng.bool(0.15) ? rng.range(-0.14, 0.14) : 0),
              rng.bool(0.25) ? 'van' : 'sedan', carCols[rng.int(0, carCols.length - 1)]!);
          } else if (roll < 0.5) {
            for (const o of [-2.2, 2.2]) {
              const bx = flip === 0 ? c + side * 12.6 : along + o;
              const bz = flip === 0 ? along + o : c + side * 12.6;
              b.box(bx, 0.55, bz, 2.6, 0.9, 1.4, 'concreteDark');
              b.box(bx, 1.08, bz, 2.2, 0.4, 1.0, 'grass', 0, { noCollide: true });
            }
          } else if (roll < 0.66) {
            const gx = flip === 0 ? c + side * 12.8 : along;
            const gz = flip === 0 ? along : c + side * 12.8;
            b.box(gx, 1.35, gz, flip === 0 ? 0.18 : 4.6, 2.7, flip === 0 ? 4.6 : 0.18, 'glass', yaw, { noCollide: true, hint: 'glass' });
            b.box(gx, 2.82, gz, flip === 0 ? 1.7 : 5.2, 0.16, flip === 0 ? 5.2 : 1.7, 'metalDark', yaw, { noCollide: true });
            b.box(gx, 0.5, gz, flip === 0 ? 0.5 : 3.6, 1.0, flip === 0 ? 3.6 : 0.5, 'metalDark', yaw, { noCollide: true });
          } else if (roll < 0.82) {
            const dx = flip === 0 ? c + side * 12.2 : along;
            const dz = flip === 0 ? along : c + side * 12.2;
            b.box(dx, 0.78, dz, flip === 0 ? 2.4 : 1.3, 1.55, flip === 0 ? 1.3 : 2.4, 'metalDark', yaw);
            b.crate(dx + (flip === 0 ? -side * 1.9 : 1.6), 0.35, dz + (flip === 0 ? 1.6 : -side * 1.9), 1);
            if (rng.bool(0.5)) b.crate(dx + (flip === 0 ? -side * 1.9 : 2.9), 0.35, dz + (flip === 0 ? 2.9 : -side * 1.9), 1);
          } else {
            const wx = flip === 0 ? c + side * 9.6 : along;
            const wz = flip === 0 ? along : c + side * 9.6;
            b.box(wx, 0.55, wz, flip === 0 ? 0.25 : 2.2, 1.0, flip === 0 ? 2.2 : 0.25, 'rust', yaw);
            b.cyl(wx + (flip === 0 ? 0 : 1.8), 0.3, wz + (flip === 0 ? 1.8 : 0), 0.22, 0.6, 'neonOrange', { noCollide: true });
          }
        }
      }
    }
  }
}

/**
 * Road markings are thin decals above the asphalt. Buildings are authored
 * later, so without this visibility pass those decals protrude through the
 * lower foundation surface and continue across lobby floors. Remove only
 * decal boxes actually covered by a building foundation; street segments and
 * doorway collision remain untouched.
 */
function removeRoadPaintUnderFoundations(b: WorldBuilder): void {
  const foundations = b.def.geo.filter((geo) => (
    geo.kind === 'box'
    && Math.abs(geo.sy - 2.2) < 1e-6
    && geo.sx > 5
    && geo.sz > 5
  ));
  b.def.geo = b.def.geo.filter((geo) => {
    if (geo.kind !== 'box' || geo.mat !== 'paint' || !geo.noCollide) return true;
    const paintTop = geo.y + geo.sy / 2;
    return !foundations.some((foundation) => {
      if (foundation.kind !== 'box') return false;
      const foundationTop = foundation.y + foundation.sy / 2;
      return paintTop > foundationTop + 1e-4
        && Math.abs(geo.x - foundation.x) < (geo.sx + foundation.sx) / 2
        && Math.abs(geo.z - foundation.z) < (geo.sz + foundation.sz) / 2;
    });
  });
}

/**
 * Street-level dressing: hanging cables between poles/buildings, neon
 * blade signs, AC units and rooftop clutter, traffic signal boxes,
 * barricades and debris piles. All noCollide decoration.
 */
function streetDressing(b: WorldBuilder, rng: Rng): void {
  const S = 500;
  // Cables across streets at intersections (catenary approximated by 3 sag segments)
  const cableMat: MatKey = 'metalDark';
  const addCable = (x1: number, z1: number, x2: number, z2: number, y: number, sag: number) => {
    const segs = 5;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const y0 = y - Math.sin(t0 * Math.PI) * sag;
      const y1 = y - Math.sin(t1 * Math.PI) * sag;
      const mx = x1 + ((x2 - x1) * (t0 + t1)) / 2;
      const mz = z1 + ((z2 - z1) * (t0 + t1)) / 2;
      const len = Math.hypot(x2 - x1, z2 - z1) / segs;
      const yaw = Math.atan2(z1 - z2, x1 - x2);
      b.box(mx, (y0 + y1) / 2, mz, len, 0.06, 0.06, cableMat, yaw, { noCollide: true });
    }
  };
  for (let i = -2; i <= 2; i++) {
    for (const j of [-1, 0, 1]) {
      if (i === 0 && j === 0) continue;
      const cx = i * 100;
      const cz = j * 100;
      if (rng.bool(0.7)) addCable(cx + 10, cz + 10, cx + 10, cz - 10, 5.35, 0.55);
      if (rng.bool(0.7)) addCable(cx + 10, cz + 10, cx - 10, cz + 10, 5.35, 0.55);
    }
  }

  // Neon blade signs near intersections on random corners
  const signMats: MatKey[] = ['neonCyan', 'neonMagenta', 'neonGreen', 'neonBlue', 'neonOrange'];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      if (i === 0 && j === 0) continue;
      if (!rng.bool(0.65)) continue;
      const sx = i * 100 + (rng.bool(0.5) ? 11.2 : -11.2);
      const sz = j * 100 + rng.range(-8, 8);
      const h = rng.range(4.2, 7.5);
      const mat = signMats[rng.int(0, signMats.length - 1)]!;
      // Grounded post + mounting bracket + vertical double-sided blade. These
      // remain visual-only so the street corner's movement lane is unchanged.
      const postHeight = h + 1.3;
      b.box(sx, 0.16, sz, 0.62, 0.32, 0.62, 'concreteDark', 0, { noCollide: true, castShadow: false });
      b.box(sx, postHeight / 2, sz, 0.16, postHeight, 0.16, 'metalDark', 0, {
        noCollide: true,
        castShadow: false,
      });
      b.box(sx, h, sz, 0.16, 0.16, 1.4, 'metalDark', 0, { noCollide: true, castShadow: false });
      b.box(sx + 0.14, h, sz, 0.22, 2.6, 1.05, mat, 0, { noCollide: true, castShadow: false });
      if (Math.abs(i * 5 + j) % 3 === 0) {
        b.light(sx + 0.14, h, sz, NEON_HEX[mat] ?? 0x53e0ff, 0.85, 12);
      }
    }
  }

  // The north service boulevard is a common boundary approach, but the broad
  // pavement previously reached the skyline without a single human-scale
  // stopping point. Paired rain gardens, benches and low guide lights create
  // a deliberate threshold while keeping the road and combat sightline open.
  for (const z of [-232, -214]) {
    for (const side of [-1, 1]) {
      const planterX = side * 19;
      b.box(planterX, 0.42, z, 4.8, 0.72, 1.15, 'concreteDark', 0, { noCollide: true });
      b.box(planterX, 0.81, z, 4.25, 0.16, 0.72, 'grass', 0, { noCollide: true });
      b.box(side * 14.8, 0.58, z, 3.2, 0.16, 0.72, 'woodDark', 0, { noCollide: true });
      for (const offset of [-1.25, 1.25]) {
        b.box(side * 14.8 + offset, 0.31, z, 0.12, 0.62, 0.52, 'metalDark', 0, { noCollide: true });
      }
      const lightX = side * 10.4;
      b.cyl(lightX, 0.48, z, 0.1, 0.96, 'metalDark', { segments: 10, noCollide: true });
      b.box(lightX, 0.98, z, 0.28, 0.08, 0.28, 'signDimCyan', 0, { noCollide: true });
    }
  }

  // Rooftop clutter on flat-roofed mid buildings (AC units, vents, water tanks)
  // Snapshot the authored structures before appending rooftop detail. Iterating
  // the live array recursively treated newly added posts/rails as buildings.
  for (const g of [...b.def.geo]) {
    if (g.kind !== 'box') continue;
    if (g.sy < 6.5 || g.sy > 20) continue;
    if (Math.min(g.sx, g.sz) < 3) continue;
    const topY = g.y + g.sy / 2;
    const units = rng.int(1, 3);
    for (let u = 0; u < units; u++) {
      const ux = g.x + rng.range(-g.sx * 0.32, g.sx * 0.32);
      const uz = g.z + rng.range(-g.sz * 0.32, g.sz * 0.32);
      const kind = rng.next();
      if (kind < 0.45) {
        // AC unit with fan grill
        b.box(ux, topY + 0.55, uz, 1.7, 1.1, 1.7, 'metalDark', 0, { noCollide: true });
        b.cyl(ux, topY + 1.16, uz, 0.55, 0.12, 'rust');
      } else if (kind < 0.72) {
        // vent pipe cluster
        b.cyl(ux, topY + 0.7, uz, 0.28, 1.4, 'rust');
        b.cyl(ux + 0.7, topY + 0.55, uz + 0.3, 0.2, 1.1, 'metalDark');
      } else {
        // water tank
        b.cyl(ux, topY + 1.15, uz, 0.95, 2.3, 'rust');
        b.box(ux, topY + 0.18, uz, 1.7, 0.36, 1.7, 'metalDark', 0, { noCollide: true });
      }
    }
    // roof edge safety rail hints on taller structures
    if (g.sy >= 10) {
      const railMat: MatKey = 'metalDark';
      b.box(g.x, topY + 0.42, g.z - g.sz / 2 + 0.15, g.sx - 0.6, 0.06, 0.06, railMat, 0, { noCollide: true });
      b.box(g.x, topY + 0.42, g.z + g.sz / 2 - 0.15, g.sx - 0.6, 0.06, 0.06, railMat, 0, { noCollide: true });
    }
  }

  // Barricades & construction corners scattered along roads
  for (let k = 0; k < 26; k++) {
    const onX = rng.bool(0.5);
    const road = (rng.int(-2, 2)) * 100 + (rng.bool(0.5) ? 8.5 : -8.5);
    const along = rng.range(-S / 2 + 30, S / 2 - 30);
    const bx = onX ? road : along;
    const bz = onX ? along : road;
    const yaw = onX ? 0 : Math.PI / 2;
    // striped barrier
    b.box(bx, 0.55, bz, 2.4, 0.14, 0.34, 'paving', yaw, { noCollide: true });
    b.box(bx, 1.02, bz, 2.4, 0.24, 0.1, 'paving', yaw, { noCollide: true });
    for (const s of [-1, 1]) b.box(bx + s * (onX ? 1.0 : 0.0), 0.5, bz + s * (onX ? 0.0 : 1.0), 0.12, 1.0, 0.12, 'metalDark', 0, { noCollide: true });
    // orange beacon light
    b.light(bx, 1.25, bz, 0xff9040, 0.9, 9);
    if (rng.bool(0.4)) {
      // trash bags / debris pile beside it
      b.sphere(bx + rng.range(-2, 2), 0.28, bz + rng.range(-2, 2), rng.range(0.3, 0.5), 'concreteDark', { noCollide: true });
    }
  }
}

const NEON_HEX: Partial<Record<MatKey, number>> = {
  neonCyan: 0x53e0ff, neonMagenta: 0xff53c8, neonGreen: 0x54ff9f,
  neonBlue: 0x5f8cff, neonOrange: 0xff9040,
};
