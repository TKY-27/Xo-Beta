/**
 * Shared map construction helpers: terrain, generic buildings, interiors,
 * scatter props. Deterministic per-map seeds keep layouts stable.
 */

import { planStairs, WorldBuilder } from '../builder';
import { sampleTerrainHeightfield } from '../terrainMesh';
import { ROCK_CLEARANCE_RADIUS, type MapDef, type MatKey, type TerrainCutout } from '../types';
import { Rng } from '../../core/rng';

export interface BuildingOpts {
  x: number;
  z: number;
  /** World-space ground height at the building anchor. */
  baseY?: number;
  w: number;
  d: number;
  yaw?: number;
  floors?: number;
  floorHeight?: number;
  wallMat: MatKey;
  trimMat?: MatKey;
  floorMat?: MatKey;
  roofMat?: MatKey;
  /** Door gaps per side: [side(0:+z 1:+x 2:-z 3:-x), offset, width][] */
  doors?: Array<[0 | 1 | 2 | 3, number, number]>;
  windows?: boolean;
  roofAccess?: boolean;
  interiorDividers?: boolean;
  parapet?: boolean;
  /** Cosmetic pitched shell over the flat gameplay roof (silhouette only). */
  roofStyle?: 'flat' | 'gable';
  /** Decorative brick chimney on the gable ridge (deterministic per call). */
  chimney?: boolean;
  /** Material for the exterior fire-escape stair flights (default metal). */
  stairMat?: MatKey;
  /**
   * Facade flavour for the depth dressing (window sills/lintels/reveals,
   * plinth, door portals, cornice, rooftop plant). Derived automatically from
   * the map id, then the wall material, so map files need no changes.
   */
  facadeStyle?: 'city' | 'heritage' | 'facility' | 'desert';
}

type FacadeStyle = NonNullable<BuildingOpts['facadeStyle']>;

const FACADE_STYLE_BY_MAP: Partial<Record<string, FacadeStyle>> = {
  neocity: 'city',
  oldfront: 'heritage',
  eden: 'facility',
  ashara: 'desert',
};

/** Facade flavour for a building: explicit opt, then map id, then wall material. */
function resolveFacadeStyle(mapId: string, wallMat: MatKey, override?: FacadeStyle): FacadeStyle {
  if (override) return override;
  const byMap = FACADE_STYLE_BY_MAP[mapId];
  if (byMap) return byMap;
  if (wallMat === 'mudbrick') return 'desert';
  if (wallMat === 'stoneBrick' || wallMat === 'bricksOld' || wallMat === 'marble') return 'heritage';
  if (wallMat === 'concrete' || wallMat === 'concreteDark' || wallMat === 'facilityFloor') return 'facility';
  return 'city';
}

/**
 * Pick a stable construction pad for a building on sampled terrain.
 * Using only the centre point lets an uphill corner pierce the floor while a
 * downhill corner appears unsupported. The deep foundation handles the low
 * side; this highest-footprint sample keeps the finished floor above the high
 * side. A small clearance absorbs analytic-to-heightfield interpolation.
 */
export function structureBaseY(
  heightAt: (x: number, z: number) => number,
  x: number,
  z: number,
  width: number,
  depth: number,
): number {
  const sampleDivisions = 8;
  const halfW = width / 2 + 0.4;
  const halfD = depth / 2 + 0.4;
  let highest = -Infinity;
  for (let iz = 0; iz <= sampleDivisions; iz++) {
    for (let ix = 0; ix <= sampleDivisions; ix++) {
      const sx = x - halfW + (2 * halfW * ix) / sampleDivisions;
      const sz = z - halfD + (2 * halfD * iz) / sampleDivisions;
      highest = Math.max(highest, heightAt(sx, sz));
    }
  }
  return highest + 0.12;
}

/**
 * Deterministic combat-cover hardening pass (v0.4 QA task 5.2).
 *
 * Replays the QA exposure analysis against the half-built map and drops a
 * bounded number of low crouch barriers at the most exposed cells, so open
 * fields gain reachable cover without filling deliberate long sightlines.
 * Deterministic: the same map build always produces the same placements.
 * Placement avoids stair flights (plus approach margin), loot, chests,
 * nav-relevant doorways and previously added barriers.
 */
const coverCache = new Map<string, Array<{ x: number; z: number; yaw: number }>>();

export function hardenExposedFlanks(b: WorldBuilder, opts: { mat: MatKey; maxProps: number }): void {
  const def = b.def;
  const heightAt = def.terrainHeight ?? ((x: number, z: number): number => (
    def.heightfield ? sampleTerrainHeightfield(def.heightfield, def.size, x, z) : 0
  ));
  const addCover = (x: number, z: number, yaw: number): void => {
    const sx = yaw === 0 ? 1.6 : 0.55;
    const sz = yaw === 0 ? 0.55 : 1.6;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let iz = 0; iz <= 8; iz++) {
      for (let ix = 0; ix <= 8; ix++) {
        const height = heightAt(x - sx / 2 + sx * ix / 8, z - sz / 2 + sz * iz / 8);
        lowest = Math.min(lowest, height);
        highest = Math.max(highest, height);
      }
    }
    const top = highest + 0.56;
    b.box(x, (lowest + top) / 2, z, sx, top - lowest, sz, opts.mat, 0, { hint: 'stone' });
  };
  // The analysis is deterministic per map build; cache it so repeated
  // loadMap calls (tests, replicas, reconnects) replay the placements
  // instantly instead of re-running the exposure sweep.
  const cacheKey = `${def.id}:${def.geo.length}:${def.rocks.length}:${def.trees.length}`;
  const cached = coverCache.get(cacheKey);
  if (cached) {
    for (const placement of cached) {
      addCover(placement.x, placement.z, placement.yaw);
    }
    return;
  }
  {
    const half = def.size / 2 - 18;
    // 24 m sampling keeps the worst-cell ranking stable at a third of the
    // sweep cost; cover still spreads across the whole map via the 9 m
    // spacing rule.
    const step = 24;
    interface Cell { x: number; z: number; exposure: number }
    const cells: Cell[] = [];
    for (let x = -half; x <= half; x += step) {
      for (let z = -half; z <= half; z += step) {
        if (def.water.some((w) => x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ)) continue;
        let blocked = 0;
        let insideSolid = false;
        for (const g of def.geo) {
          if (g.noCollide || g.noRender || g.kind !== 'box') continue;
          if (g.sy <= 2.2 && g.y + g.sy / 2 <= 2.5) continue;
          const c = Math.abs(Math.cos(g.yaw));
          const s = Math.abs(Math.sin(g.yaw));
          const hx = (g.sx * c + g.sz * s) / 2;
          const hz = (g.sx * s + g.sz * c) / 2;
          if (Math.abs(x - g.x) < hx + 0.5 && Math.abs(z - g.z) < hz + 0.5) insideSolid = true;
        }
        if (insideSolid) continue;
        for (let k = 0; k < 8; k++) {
          const angle = (k / 8) * Math.PI * 2;
          // Crouch-height rays: the pass adds crouch barriers, so it targets
          // cells where even crouching finds no cover. Pure 2D occlusion —
          // map building must never depend on initialised physics.
          if (segmentBlocked2D(def, x, z, Math.cos(angle), Math.sin(angle), 30)) blocked++;
        }
        const exposure = (8 - blocked) / 8;
        if (exposure >= 0.875) cells.push({ x, z, exposure });
      }
    }
    // Worst first; deterministic tiebreak by coordinates.
    cells.sort((a, b2) => (b2.exposure - a.exposure) || (a.x - b2.x) || (a.z - b2.z));

    const nearStair = (x: number, z: number): boolean => def.stairs.some((f) => {
      const dirX = f.dir === 1 ? 1 : f.dir === 3 ? -1 : 0;
      const dirZ = f.dir === 0 ? 1 : f.dir === 2 ? -1 : 0;
      const cx = f.x + dirX * f.run / 2;
      const cz = f.z + dirZ * f.run / 2;
      const rx = Math.abs(dirX) * (f.run / 2 + 3) + Math.abs(dirZ) * (f.width / 2 + 3);
      const rz = Math.abs(dirZ) * (f.run / 2 + 3) + Math.abs(dirX) * (f.width / 2 + 3);
      return Math.abs(x - cx) < rx && Math.abs(z - cz) < rz;
    });
    const nearLoot = (x: number, z: number): boolean =>
      def.loot.some((l) => Math.hypot(l.x - x, l.z - z) < 4.5)
      || def.chests.some((c) => Math.hypot(c.x - x, c.z - z) < 4.5)
      || def.pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius * 0.2 && false);
    const added: Array<{ x: number; z: number; yaw: number }> = [];
    for (const cell of cells) {
      if (added.length >= opts.maxProps) break;
      if (nearStair(cell.x, cell.z) || nearLoot(cell.x, cell.z)) continue;
      if (added.some((a) => Math.hypot(a.x - cell.x, a.z - cell.z) < 9)) continue;
      // Alternate orientation for variety; 0.55 m tall crouch cover that bots
      // can also step over (below the stepHeight nav gate).
      const yaw = added.length % 2 === 0 ? 0 : Math.PI / 2;
      addCover(cell.x, cell.z, yaw);
      added.push({ x: cell.x, z: cell.z, yaw });
      if (added.length === opts.maxProps) coverCache.set(cacheKey, added.slice());
    }
  }
}

/**
 * True when the horizontal segment from (x,z) along (dx,dz) up to `dist`
 * crosses solid map geometry: yawed collider boxes (walls, props, vehicles,
 * barriers, tree trunks) or rock/tile footprints. 2D only — terrain relief
 * is intentionally ignored so the metric stays cheap and pure.
 */
function segmentBlocked2D(
  def: MapDef,
  x: number, z: number,
  dx: number, dz: number,
  dist: number,
): boolean {
  for (const g of def.geo) {
    if (g.noCollide || g.noRender) continue;
    if (g.kind !== 'box') {
      // Cylinders/spheres (tanks, drums): conservative circle test.
      const r = g.r;
      const ox = g.x - x, oz = g.z - z;
      const t = ox * dx + oz * dz;
      if (t < 0 || t > dist + r) continue;
      const perp = Math.abs(ox * dz - oz * dx);
      if (perp < r) return true;
      continue;
    }
    const isGroundLayer = g.sy <= 2.2 && g.y + g.sy / 2 <= 2.5;
    if (isGroundLayer) continue;
    // Cheap broad-phase reject before any trig: the sweep radius is `dist`.
    const gdx = g.x - x;
    const gdz = g.z - z;
    if (gdx * dx + gdz * dz < -4 || Math.abs(gdx) > dist + 8 || Math.abs(gdz) > dist + 8) continue;
    const c = Math.abs(Math.cos(g.yaw));
    const s = Math.abs(Math.sin(g.yaw));
    const hx = (g.sx * c + g.sz * s) / 2;
    const hz = (g.sx * s + g.sz * c) / 2;
    if (rayIntersectsRotatedBox(x, z, dx, dz, g.x, g.z, hx + 0.2, hz + 0.2, g.yaw, dist)) return true;
  }
  for (const rock of def.rocks) {
    const ox = rock.x - x, oz = rock.z - z;
    const t = ox * dx + oz * dz;
    const r = ROCK_CLEARANCE_RADIUS * rock.scale;
    if (t < 0 || t > dist + r) continue;
    if (Math.abs(ox * dz - oz * dx) < r * 0.82) return true;
  }
  for (const tree of def.trees) {
    const ox = tree.x - x, oz = tree.z - z;
    const t = ox * dx + oz * dz;
    const r = 0.3 * tree.scale + 0.25;
    if (t < 0 || t > dist + r) continue;
    if (Math.abs(ox * dz - oz * dx) < r) return true;
  }
  return false;
}

/** 2D slab test of a ray against a yaw-aligned box (half extents hx/hz). */
function rayIntersectsRotatedBox(
  ox: number, oz: number,
  dx: number, dz: number,
  cx: number, cz: number,
  hx: number, hz: number,
  yaw: number,
  dist: number,
): boolean {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // World -> box local (rotate by -yaw).
  const lx = (ox - cx) * c - (oz - cz) * s;
  const lz = (ox - cx) * s + (oz - cz) * c;
  const ldx = dx * c - dz * s;
  const ldz = dx * s + dz * c;
  let tMin = -Infinity;
  let tMax = Infinity;
  for (const [o, d, h] of [[lx, ldx, hx], [lz, ldz, hz]] as Array<[number, number, number]>) {
    if (Math.abs(d) < 1e-8) {
      if (o < -h || o > h) return false;
      continue;
    }
    let t1 = (-h - o) / d;
    let t2 = (h - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return tMax >= 0 && tMin <= dist;
}

/**
 * Generic enterable multi-floor building.
 * - Ground floor with door gaps, window sills
 * - Interior divider wall with doorway
 * - Stairwell to upper floors + optional roof access
 * - Registers walkable platforms for nav
 */
export function addBuilding(b: WorldBuilder, o: BuildingOpts): void {
  const fh = o.floorHeight ?? 3.6;
  const floors = o.floors ?? 1;
  const t = 0.4; // wall thickness
  const x = o.x, z = o.z;
  const baseY = o.baseY ?? 0;
  const hw = o.w / 2, hd = o.d / 2;
  const trim = o.trimMat ?? o.wallMat;
  const stairMat = o.stairMat ?? 'metalExterior';
  const floorMat = o.floorMat ?? 'concreteDark';
  const roofMat = o.roofMat ?? trim;
  const requestedStairSteps = Math.ceil(fh / 0.55);
  const interiorStair = planStairs(requestedStairSteps, fh / requestedStairSteps, 0.62, 1.7);
  const hasInteriorStair = floors > 1 && interiorStair.run < o.d - 2;
  const stairX = x - hw + 1.4;
  // Leave a real standing-capsule landing behind the first tread. At 0.8 m
  // from the back wall, the stair builder's 0.55 m lower anchor sat only
  // 0.25 m from the wall centre and was necessarily embedded for a 0.42 m
  // radius actor. The disconnected flight was previously masked by false
  // long-distance jump edges across the room.
  const stairZ = z - hd + 1.55;
  const gapsOverlap = ([aStart, aWidth]: [number, number], [bStart, bWidth]: [number, number]): boolean =>
    aStart < bStart + bWidth && bStart < aStart + aWidth;
  const windowsWithoutDoorOverlap = (
    windows: Array<[number, number]>,
    doors: Array<[number, number]>,
  ): Array<[number, number]> => windows.filter((window) =>
    !doors.some((door) => gapsOverlap(window, door)));
  const navDoorway = (doorX: number, doorZ: number, tx: number, tz: number, y: number) => {
    const half = 0.05;
    for (const side of [-0.75, 0, 0.75]) {
      // Sample across the opening, not through the wall normal. The previous
      // anchors all shared one lateral coordinate, so path selection could
      // aim bots at a jamb even though the doorway centre itself was clear.
      const px = doorX + tx * side;
      const pz = doorZ + tz * side;
      b.platform(px - half, px + half, pz - half, pz + half, y);
    }
  };
  /**
   * Deterministic per-window family. The old facade pasted the same
   * centre-mullioned unit on every opening; families now vary per window
   * while pane geometry, stableId order and destructible mechanics stay
   * byte-identical.
   */
  const windowFamily = (side: number, offset: number, floor: number): 'single' | 'dual' | 'transom' | 'dark' => {
    const h = Math.imul(Math.round((x + z) * 100) ^ Math.round(offset * 37) ^ (side * 7) ^ (floor * 13), 2654435761) >>> 0;
    const bucket = h % 10;
    if (floor === 0 && bucket < 3) return 'dark';
    if (bucket < 5) return 'single';
    if (bucket < 8) return 'dual';
    return 'transom';
  };
  const windowMaterial = (family: 'single' | 'dual' | 'transom' | 'dark', side = 0, offset = 0, floor = 0): MatKey => {
    if (family !== 'dark') return 'windowCool';
    // Occupied-dark glazing: pure-dark panes read as holes punched in the
    // facade. Heritage (OldFront) gets dim warm interiors at a hash so the
    // town reads inhabited; other styles keep the dark pane.
    if (style === 'heritage') {
      const h = Math.imul(Math.round((x + z) * 173) ^ Math.round(offset * 91) ^ (side * 17) ^ (floor * 29), 2654435761) >>> 0;
      return h % 3 === 0 ? 'windowWarmDim' : 'windowDark';
    }
    return 'windowDark';
  };

  // --- Facade depth system (W7) -------------------------------------------
  // Turns the flat wall/glass compositions into authored elevations: every
  // dressed window gains a proud sill ledge and a lintel band (plus recessed
  // reveal jambs on heritage/desert styles), the footprint gains a plinth
  // course, each door a portal with a real stoop, the wall top a projecting
  // cornice, and flat roofs bounded rooftop plant. Placement follows the
  // file's offset discipline: pieces bury into the wall body, protrude a few
  // centimetres, and never share a top plane with neighbouring geometry
  // (z-fighting guard). Everything derives from position hashes so repeated
  // map builds stay byte-identical, and decorations are noCollide except the
  // deliberately walkable stoops.
  const style = resolveFacadeStyle(b.def.id, o.wallMat, o.facadeStyle);
  const darkTrim: MatKey = style === 'heritage' || style === 'desert' ? 'stoneBrick' : 'concreteDark';
  const windowTrim: MatKey = trim !== o.wallMat
    ? trim
    : style === 'desert' ? 'woodDark'
    : style === 'facility' ? 'metalDark'
    : darkTrim;
  const facadeHash = (side: number, along: number, floor: number, salt: number): number => {
    let h = hashOf(o.x, o.z) ^ 0x9e3779b9;
    h = Math.imul(h ^ Math.imul(side + 1, 0x9e3779b9), 2654435761);
    h = Math.imul(h ^ Math.round(along * 61.7), 2654435761);
    h = Math.imul(h ^ Math.imul(floor + 1, 0x85ebca6b), 2654435761);
    h = Math.imul(h ^ Math.imul(salt + 1, 0xc2b2ae35), 2654435761);
    return h >>> 0;
  };
  /**
   * Trim band on one facade. `along` is the piece centre relative to the
   * building centre along the wall axis; `offset` is the piece's outer face
   * relative to the wall's outer face (positive proud, negative recessed
   * into the reveal). Pieces always bury into the wall body so no seam is
   * coplanar, and runs clamp to the wall span so edge trims never overhang
   * a corner. Decoration by default; pass noCollide:false for walkable pieces.
   */
  const facePiece = (
    side: 0 | 1 | 2 | 3,
    along: number,
    y: number,
    len: number,
    sy: number,
    depth: number,
    offset: number,
    mat: MatKey,
    opts?: { noCollide?: boolean; pitch?: number; roll?: number },
  ): void => {
    const alongX = side === 0 || side === 2;
    const s = side === 0 || side === 1 ? 1 : -1;
    const maxAlong = (alongX ? hw : hd) - 0.06;
    const lo = Math.max(along - len / 2, -maxAlong);
    const hi = Math.min(along + len / 2, maxAlong);
    if (hi - lo < 0.1) return;
    const centre = (alongX ? hd : hw) + 0.2 + offset - depth / 2;
    const mid = (lo + hi) / 2;
    if (alongX) {
      b.box(x + mid, y, z + s * centre, hi - lo, sy, depth, mat, 0, {
        noCollide: opts?.noCollide ?? true,
        pitch: opts?.pitch,
        roll: opts?.roll,
      });
    } else {
      b.box(x + s * centre, y, z + mid, depth, sy, hi - lo, mat, 0, {
        noCollide: opts?.noCollide ?? true,
        pitch: opts?.pitch,
        roll: opts?.roll,
      });
    }
  };
  /** Sill ledge + lintel band (+ reveal jambs / AC unit by style) per window. */
  const dressWindow = (
    side: 0 | 1 | 2 | 3,
    along: number,
    floor: number,
    width: number,
    glassLo: number,
    glassHi: number,
  ): void => {
    const heritage = style === 'heritage';
    const headH = heritage ? 0.18 : 0.14;
    facePiece(side, along, glassLo - 0.085, width + 0.26, 0.1, 0.34, 0.12, windowTrim);
    facePiece(side, along, glassHi + 0.04 + headH / 2, width + 0.26, headH, 0.3, heritage ? 0.12 : 0.08, windowTrim);
    if (heritage || style === 'desert') {
      // Reveal jambs recessed 6 cm into the opening shadow: heritage stone
      // toe-lines and desert sun-shading depth.
      for (const edge of [-1, 1]) {
        facePiece(side, along + edge * (width / 2 + 0.045), (glassLo + glassHi) / 2, 0.09, glassHi - glassLo, 0.16, -0.06, windowTrim);
      }
    }
    if (style === 'city' && facadeHash(side, along, floor, 1) % 10 < 3) {
      // Bracket-mounted AC unit under the sill on some city openings.
      facePiece(side, along, glassLo - 0.36, 0.55, 0.28, 0.42, 0.3, 'metalExterior');
    }
  };

  const addGroundFacadeWindow = (
    side: 1 | 2 | 3,
    offset: number,
    width: number,
    y0: number,
    sillH: number,
  ) => {
    const paneH = 1.42;
    const paneY = y0 + sillH + paneH / 2;
    // Recessed reveal: the pane sits just inside the outer wall face so the
    // opening casts a real shadow line instead of a pasted-on card.
    const paneOffset = t / 2 - 0.06;
    const frameOffset = t / 2 - 0.02;
    const family = windowFamily(side, offset, 0);
    const mat = windowMaterial(family, side, offset, 0);
    if (side === 2) {
      const paneX = x - hw + offset + width / 2;
      const paneZ = z - hd - paneOffset;
      const frameZ = z - hd - frameOffset;
      b.box(paneX, paneY, paneZ, width, paneH, 0.05, mat, 0, { noCollide: true });
      // Head and sill trims every window shares.
      b.box(paneX, paneY, frameZ, width + 0.08, 0.075, t + 0.08, trim, 0, { noCollide: true });
      b.box(paneX, paneY - paneH / 2 - 0.02, frameZ, width + 0.08, 0.075, t + 0.08, trim, 0, { noCollide: true });
      if (family === 'dual') {
        // Mullion split into two sashes.
        b.box(paneX, paneY, paneZ, 0.075, paneH + 0.08, 0.055, trim, 0, { noCollide: true });
      } else if (family === 'transom') {
        // Horizontal transom bar at two-thirds height.
        b.box(paneX, paneY + paneH / 6, paneZ, width + 0.08, 0.06, 0.055, trim, 0, { noCollide: true });
      }
      // 'single': one uninterrupted pane.
    } else {
      const paneX = x + (side === 1 ? hw + paneOffset : -hw - paneOffset);
      const frameX = x + (side === 1 ? hw + frameOffset : -hw - frameOffset);
      const paneZ = z - hd + offset + width / 2;
      b.box(paneX, paneY, paneZ, 0.05, paneH, width, mat, 0, { noCollide: true });
      b.box(frameX, paneY, paneZ, t + 0.08, 0.075, width + 0.08, trim, 0, { noCollide: true });
      b.box(frameX, paneY - paneH / 2 - 0.02, paneZ, t + 0.08, 0.075, width + 0.08, trim, 0, { noCollide: true });
      if (family === 'dual') {
        b.box(paneX, paneY, paneZ, 0.055, paneH + 0.08, 0.075, trim, 0, { noCollide: true });
      } else if (family === 'transom') {
        b.box(paneX, paneY + paneH / 6, paneZ, 0.055, 0.06, width + 0.08, trim, 0, { noCollide: true });
      }
    }
  };
  const addUpperWindowGlass = (
    side: 0 | 1 | 2 | 3,
    offset: number,
    width: number,
    y0: number,
    sillH: number,
  ) => {
    const paneH = Math.max(0.8, fh - sillH - 0.5);
    const paneY = y0 + sillH + paneH / 2;
    const inset = t / 2 + 0.045;
    // Glass dressing only: the destructible pane call (and its stableId
    // position) is untouched by the family choice.
    const family = windowFamily(side, offset, 1);
    if (side === 0 || side === 2) {
      const paneX = x - hw + offset + width / 2;
      const paneZ = z + (side === 0 ? hd - inset : -hd + inset);
      b.glassPane(paneX, paneY, paneZ, Math.max(0.08, width - 0.08), paneH, 'x');
      if (family === 'dual') {
        b.box(paneX, paneY, paneZ + (side === 0 ? 0.022 : -0.022), 0.055, paneH, 0.045, trim, 0, { noCollide: true });
      } else if (family === 'transom') {
        b.box(paneX, paneY + paneH / 6, paneZ + (side === 0 ? 0.022 : -0.022), width, 0.055, 0.045, trim, 0, { noCollide: true });
      }
    } else {
      const paneX = x + (side === 1 ? hw - inset : -hw + inset);
      const paneZ = z - hd + offset + width / 2;
      b.glassPane(paneX, paneY, paneZ, Math.max(0.08, width - 0.08), paneH, 'z');
      if (family === 'dual') {
        b.box(paneX + (side === 1 ? 0.022 : -0.022), paneY, paneZ, 0.045, paneH, 0.055, trim, 0, { noCollide: true });
      } else if (family === 'transom') {
        b.box(paneX + (side === 1 ? 0.022 : -0.022), paneY + paneH / 6, paneZ, 0.045, 0.055, width, trim, 0, { noCollide: true });
      }
    }
  };

  // Foundation slab — extends deep below grade so buildings on sloping
  // terrain (eden/oldfront heightfields) never show a floating downhill edge;
  // buried portion reads as a plinth.
  b.slab(x, baseY + 0.08, z, o.w + 0.8, o.d + 0.8, 2.2, trim);

  for (let f = 0; f < floors; f++) {
    const y0 = baseY + f * fh;

    // Floor slab (skip ground — foundation serves)
    if (f > 0) {
      const stairHole = {
        minX: stairX - interiorStair.width / 2 - 0.28,
        maxX: stairX + interiorStair.width / 2 + 0.28,
        minZ: stairZ - 0.18,
        maxZ: stairZ + interiorStair.run + 0.35,
      };
      if (hasInteriorStair) {
        slabWithHole(b, x, y0 + 0.18, z, o.w, o.d, 0.35, floorMat, stairHole);
        slabWithHole(b, x, y0 - 0.18, z, o.w - 0.5, o.d - 0.5, 0.04, 'interiorCeiling', stairHole, {
          noCollide: true,
        });
      } else {
        b.slab(x, y0 + 0.18, z, o.w, o.d, 0.35, floorMat);
        b.box(x, y0 - 0.2, z, o.w - 0.5, 0.04, o.d - 0.5, 'interiorCeiling', 0, {
          noCollide: true,
        });
      }
    }

    const sillH = f === 0 ? 1.1 : 0.9;

    // Walls with gaps: sides 0:+z(front) 1:+x(right) 2:-z(back) 3:-x(left)
    const frontDoors = (o.doors ?? []).filter((dd) => dd[0] === 0).map((dd) => [dd[1], dd[2]] as [number, number]);
    const backDoors = (o.doors ?? []).filter((dd) => dd[0] === 2).map((dd) => [dd[1], dd[2]] as [number, number]);
    const rightDoors = (o.doors ?? []).filter((dd) => dd[0] === 1).map((dd) => [dd[1], dd[2]] as [number, number]);
    const leftDoors = (o.doors ?? []).filter((dd) => dd[0] === 3).map((dd) => [dd[1], dd[2]] as [number, number]);
    const windowGapsFront: Array<[number, number]> = [];
    const windowGapsBack: Array<[number, number]> = [];
    const step = Math.max(3, o.w / 4);
    for (let wx = step / 2; wx < o.w - 0.5; wx += step) {
      windowGapsFront.push([wx, 1.4]);
      windowGapsBack.push([wx, 1.4]);
    }
    const windowGapsRight: Array<[number, number]> = [];
    const windowGapsLeft: Array<[number, number]> = [];
    const stepD = Math.max(3, o.d / 4);
    for (let wz = stepD / 2; wz < o.d - 0.5; wz += stepD) {
      windowGapsRight.push([wz, 1.4]);
      windowGapsLeft.push([wz, 1.4]);
    }
    const groundWindowGapsFront: Array<[number, number]> = [
      [o.w * 0.28 - 0.75, 1.5],
      [o.w * 0.72 - 0.75, 1.5],
    ];
    if (f === 0) {
      // Ground-floor glazing must be a real opening. Previously the opaque
      // front wall and glass pane occupied the same depth, causing
      // z-fighting and flickering highlights. Keep the sill as wall geometry,
      // then place glass just inside the opening below.
      b.wallWithGaps(x - hw, z + hd, o.w, fh, t, 'x', o.wallMat,
        o.windows === false ? frontDoors : [...frontDoors, ...groundWindowGapsFront],
        o.windows === false ? 0 : sillH, y0,
        o.windows === false ? undefined : windowsWithoutDoorOverlap(groundWindowGapsFront, frontDoors));
      b.wallWithGaps(x - hw, z - hd, o.w, fh, t, 'x', o.wallMat, backDoors, 0, y0);
      b.wallWithGaps(x + hw, z - hd, o.d, fh, t, 'z', o.wallMat, rightDoors, 0, y0);
      b.wallWithGaps(x - hw, z - hd, o.d, fh, t, 'z', o.wallMat, leftDoors, 0, y0);
      if (o.windows !== false) {
        // Ground-floor side and rear walls remain structurally solid to avoid
        // changing indoor collision/nav, but receive shallow, non-colliding
        // glazing and mullions. This removes the repeated blank-box facade
        // without implying a new traversable opening.
        for (const [offset, width] of windowsWithoutDoorOverlap(groundWindowGapsFront, backDoors)) {
          addGroundFacadeWindow(2, offset, width, y0, sillH);
        }
        const sideWindows: Array<[number, number]> = [
          [o.d * 0.28 - 0.75, 1.5],
          [o.d * 0.72 - 0.75, 1.5],
        ];
        for (const [offset, width] of windowsWithoutDoorOverlap(sideWindows, rightDoors)) {
          addGroundFacadeWindow(1, offset, width, y0, sillH);
        }
        for (const [offset, width] of windowsWithoutDoorOverlap(sideWindows, leftDoors)) {
          addGroundFacadeWindow(3, offset, width, y0, sillH);
        }
      }
      const floorY = y0 + 0.08;
      for (const [side, offset, width] of o.doors ?? []) {
        if (side === 0) navDoorway(x - hw + offset + width / 2, z + hd, 1, 0, floorY);
        else if (side === 2) navDoorway(x - hw + offset + width / 2, z - hd, 1, 0, floorY);
        else if (side === 1) navDoorway(x + hw, z - hd + offset + width / 2, 0, 1, floorY);
        else navDoorway(x - hw, z - hd + offset + width / 2, 0, 1, floorY);
      }
    } else {
      // Upper floors: windows (sill gaps) all around
      b.wallWithGaps(x - hw, z + hd, o.w, fh, t, 'x', o.wallMat,
        windowGapsFront, sillH, y0, windowGapsFront);
      b.wallWithGaps(x - hw, z - hd, o.w, fh, t, 'x', o.wallMat,
        windowGapsBack, sillH, y0, windowGapsBack);
      b.wallWithGaps(x + hw, z - hd, o.d, fh, t, 'z', o.wallMat,
        windowGapsRight, sillH, y0, windowGapsRight);
      b.wallWithGaps(x - hw, z - hd, o.d, fh, t, 'z', o.wallMat,
        windowGapsLeft, sillH, y0, windowGapsLeft);
      if (o.windows !== false) {
        const upperPaneH = Math.max(0.8, fh - sillH - 0.5);
        const glassHi = y0 + sillH + upperPaneH;
        for (const [offset, width] of windowGapsFront) {
          addUpperWindowGlass(0, offset, width, y0, sillH);
          dressWindow(0, offset + width / 2 - hw, f, width, y0 + sillH, glassHi);
        }
        for (const [offset, width] of windowGapsBack) {
          addUpperWindowGlass(2, offset, width, y0, sillH);
          dressWindow(2, offset + width / 2 - hw, f, width, y0 + sillH, glassHi);
        }
        for (const [offset, width] of windowGapsRight) {
          addUpperWindowGlass(1, offset, width, y0, sillH);
          dressWindow(1, offset + width / 2 - hd, f, width, y0 + sillH, glassHi);
        }
        for (const [offset, width] of windowGapsLeft) {
          addUpperWindowGlass(3, offset, width, y0, sillH);
          dressWindow(3, offset + width / 2 - hd, f, width, y0 + sillH, glassHi);
        }
      }
    }

    // Interior divider with doorway (alternating orientation per floor)
    if (o.interiorDividers !== false && o.w > 9 && o.d > 9) {
      const divOffset = f % 2 === 0 ? o.w * 0.33 : o.w * 0.66;
      const gapStart = o.d * 0.42;
      if (f % 2 === 0) {
        b.wallWithGaps(x - hw + divOffset, z - hd + t, o.d - t * 2, fh, 0.3, 'z', trim, [[gapStart, 1.6]], 0, y0);
        navDoorway(
          x - hw + divOffset,
          z - hd + t + gapStart + 0.8,
          1,
          0,
          y0 + (f > 0 ? 0.18 : 0.08),
        );
      } else {
        // The odd-floor divider runs straight across the stairwell. Without a
        // passage it formed a 3.6 m wall crossing the flight at mid-height:
        // real KCC ascent stalled against it and descent from the floor above
        // was impossible. Give the stairwell a full-height opening that clears
        // the whole flight width.
        const stairGapEnd = hasInteriorStair
          ? (stairX + interiorStair.width / 2 + 0.12) - (x - hw + t)
          : 0;
        b.wallWithGaps(x - hw + t, z - hd + divOffset, o.w - t * 2, fh, 0.3, 'x', trim,
          [[gapStart, 1.6], [0, Math.max(0, stairGapEnd)]], 0, y0);
        navDoorway(
          x - hw + t + gapStart + 0.8,
          z - hd + divOffset,
          0,
          1,
          y0 + (f > 0 ? 0.18 : 0.08),
        );
      }
    }

    // Stairs to next level (stairwell against back-left corner)
    if (f < floors - 1 && hasInteriorStair) {
      b.stairs(stairX, y0 + (f > 0 ? 0.18 : 0.08), stairZ, 0,
        interiorStair.steps, interiorStair.stepH, interiorStair.stepD, interiorStair.width, 'concreteDark');
    }
  }

  // Plinth course: a slightly proud base band wrapping the footprint,
  // split around every door so entrances stay visually and physically
  // clear. It grounds the mass against the ground plane and breaks the
  // wall/ground seam (bottom buried, so sloping terrain never floats it).
  const plinthSegments = (length: number, doors: Array<[number, number]>): Array<[number, number]> => {
    const segs: Array<[number, number]> = [];
    let cursor = 0;
    for (const [start, width] of doors.map(([dOff, dW]) => [dOff - 0.18, dW + 0.36] as [number, number]).sort((m, n) => m[0] - n[0])) {
      const lo = Math.max(0, start);
      const hi = Math.min(length, start + Math.max(0, width));
      if (lo > cursor + 0.05) segs.push([cursor, lo]);
      cursor = Math.max(cursor, hi);
    }
    if (length > cursor + 0.05) segs.push([cursor, length]);
    return segs;
  };
  for (const side of [0, 1, 2, 3] as const) {
    const sideLen = side === 0 || side === 2 ? o.w : o.d;
    const sideDoors = (o.doors ?? []).filter((dd) => dd[0] === side).map((dd) => [dd[1], dd[2]] as [number, number]);
    for (const [a, bEnd] of plinthSegments(sideLen, sideDoors)) {
      facePiece(side, (a + bEnd) / 2 - sideLen / 2, baseY - 0.01, bEnd - a, 0.58, 0.52, 0.06, darkTrim);
    }
  }

  // Entrance portals: proud jamb pilasters and a header define each door
  // (walls leave doors full-storey height, so the header reads as the
  // lintel over a real opening). Two low collidable stoop steps ground the
  // approach — actors stand on them, and both stay far below the KCC step
  // gate so door navigation is untouched. Some deterministically chosen
  // doors also get a pitched canopy.
  const canopyMat: MatKey = style === 'heritage' ? 'roofTile'
    : style === 'desert' ? 'woodDark'
    : style === 'facility' ? 'metalExterior'
    : 'metalDark';
  for (const [side, offset, width] of o.doors ?? []) {
    const alongX = side === 0 || side === 2;
    const along = offset + width / 2 - (alongX ? hw : hd);
    for (const edge of [-1, 1]) {
      facePiece(side, along + edge * (width / 2 + 0.09), baseY + fh / 2, 0.18, fh, 0.52, 0.06, windowTrim);
    }
    const doorHead = Math.min(2.25, fh - 0.85);
    facePiece(side, along, baseY + doorHead + 0.1, width + 0.36, 0.2, 0.56, 0.1, windowTrim);
    // Transom glazing over the header: walls leave doors full-storey height,
    // so the slot above the portal would otherwise read as open sky. Fixed
    // dark glazing fills the transom; it is noCollide like the rest of the
    // dressing, so sightline-blocking stays exactly as authored.
    // Transom glazing: heritage doors get a deterministic dim warm interior
    // so the portal reads inhabited; other styles keep the dark pane.
    const transomMat: MatKey = style === 'heritage' && facadeHash(side, along, 0, 7) % 3 === 0
      ? 'windowWarmDim'
      : 'windowDark';
    facePiece(side, along, baseY + doorHead + 0.2 + Math.max(0.1, fh - doorHead - 0.55) / 2, width + 0.04, Math.max(0.2, fh - doorHead - 0.55), 0.06, -0.01, transomMat);
    const s = side === 0 || side === 1 ? 1 : -1;
    const face = (alongX ? hd : hw) + 0.2;
    for (let stepIdx = 0; stepIdx < 2; stepIdx++) {
      const top = baseY + 0.22 - stepIdx * 0.08;
      const centreDist = face + 0.25 + stepIdx * 0.5;
      b.box(
        alongX ? x + along : x + s * centreDist,
        top - 0.35,
        alongX ? z + s * centreDist : z + along,
        alongX ? width + 0.7 : 0.5,
        0.7,
        alongX ? 0.5 : width + 0.7,
        darkTrim,
        0,
        // Visual grounding only: collidable stoops blocked the doorway
        // character sweep and snapped chests under them, so navigation and
        // loot rules stay authored — the steps render, physics walks through.
        { noCollide: true },
      );
    }
    if (facadeHash(side, along, 0, 3) % 10 < 5) {
      facePiece(side, along, baseY + doorHead + 0.5, width + 0.5, 0.09, 1.0, 1.06, canopyMat, {
        pitch: alongX ? s * 0.3 : 0,
        roll: alongX ? 0 : -s * 0.3,
      });
    }
  }

  // Roof
  const roofY = baseY + floors * fh + 0.2;
  b.slab(x, roofY, z, o.w + 0.5, o.d + 0.5, 0.35, roofMat);
  // The exterior roof material used to remain visible on its underside,
  // giving occupied rooms a black repeated tile/grid instead of an interior
  // ceiling. Keep the physical roof untouched and add an inset finish with
  // shallow non-colliding beams for indoor scale and material separation.
  // roofY is the slab's top surface (WorldBuilder.slab), not its centre.
  // Place the finish below the 0.35 m roof volume with a small separation;
  // the previous centre-style offset embedded both finish and beams inside
  // the roof and left the exterior roof texture visible from the room.
  const ceilingY = roofY - 0.38;
  b.box(x, ceilingY, z, Math.max(1, o.w - 0.5), 0.04, Math.max(1, o.d - 0.5), 'interiorCeiling', 0, {
    noCollide: true,
  });
  if (o.w >= 8 && o.d >= 8) {
    const beamY = roofY - 0.47;
    const beamCount = Math.max(2, Math.min(5, Math.round(o.d / 3.8)));
    for (let i = 1; i <= beamCount; i++) {
      const bz = z - hd + (o.d * i) / (beamCount + 1);
      b.box(x, beamY, bz, o.w - 0.65, 0.12, 0.14, trim, 0, { noCollide: true });
    }
  }
  if (o.parapet !== false) {
    const ph = 0.8;
    b.box(x, roofY + ph / 2, z + hd + 0.25, o.w + 0.5, ph, 0.25, trim);
    b.box(x, roofY + ph / 2, z - hd - 0.25, o.w + 0.5, ph, 0.25, trim);
    b.box(x + hw + 0.25, roofY + ph / 2, z, 0.25, ph, o.d + 0.5, trim);
    if (!o.roofAccess) {
      // Left parapet is handled by the exterior-stair block when present.
      b.box(x - hw - 0.25, roofY + ph / 2, z, 0.25, ph, o.d + 0.5, trim);
    }
    b.platform(x - hw - 0.4, x + hw + 0.4, z - hd - 0.4, z + hd + 0.4, roofY);
    // Parapet caps: proud weathering strips topping every straight run
    // (the fire-escape side keeps its gated opening uncapped).
    const capY = roofY + 0.815;
    b.box(x, capY, z + hd + 0.25, o.w + 0.5, 0.09, 0.35, darkTrim, 0, { noCollide: true });
    b.box(x, capY, z - hd - 0.25, o.w + 0.5, 0.09, 0.35, darkTrim, 0, { noCollide: true });
    b.box(x + hw + 0.25, capY, z, 0.35, 0.09, o.d + 0.5, darkTrim, 0, { noCollide: true });
    if (!o.roofAccess) {
      b.box(x - hw - 0.25, capY, z, 0.35, 0.09, o.d + 0.5, darkTrim, 0, { noCollide: true });
    }
  }

  // Cornice: a projecting band wrapping the wall top, slightly darker than
  // the wall so the roofline reads as a finished edge instead of a cut box.
  // Runs overlap the corners only within the z-fighting guard's exemption
  // (side runs stop short; front/back runs carry the corner return).
  const wallTop = baseY + floors * fh;
  facePiece(0, 0, wallTop - 0.02, o.w + 0.64, 0.2, 0.64, 0.12, darkTrim);
  facePiece(2, 0, wallTop - 0.02, o.w + 0.64, 0.2, 0.64, 0.12, darkTrim);
  facePiece(1, 0, wallTop - 0.02, o.d - 0.8, 0.2, 0.64, 0.12, darkTrim);
  facePiece(3, 0, wallTop - 0.02, o.d - 0.8, 0.2, 0.64, 0.12, darkTrim);

  // Pitched-roof shell: pure silhouette dressing floated above the flat
  // gameplay roof — traversal, nav and roof platforms are untouched.
  if (o.roofStyle === 'gable') {
    const ridgeAlongX = o.w >= o.d;
    const span = ridgeAlongX ? o.d : o.w;
    const half = span / 2 + 0.35;
    const rise = Math.min(2.2, span * 0.42);
    const run = half;
    const slopeLen = Math.hypot(run, rise) + 0.3;
    const slopeAngle = Math.atan2(rise, run);
    const longLen = (ridgeAlongX ? o.w : o.d) + 0.55;
    const shellY = roofY + 0.22;
    // Gable ends: stacked shrinking slabs approximate the triangle.
    const gableSlabs = 5;
    for (const endSide of [-1, 1]) {
      const endX = ridgeAlongX ? x + endSide * (o.w / 2 + 0.16) : x;
      const endZ = ridgeAlongX ? z : z + endSide * (o.d / 2 + 0.16);
      for (let i = 0; i < gableSlabs; i++) {
        const f = (i + 0.5) / gableSlabs;
        const slabW = (span + 0.3) * (1 - f);
        const slabY = shellY + rise * f;
        const sizeX = ridgeAlongX ? 0.32 : slabW;
        const sizeZ = ridgeAlongX ? slabW : 0.32;
        b.box(endX, slabY, endZ, sizeX, rise / gableSlabs + 0.06, sizeZ, trim, 0, {
          noCollide: true,
        });
      }
    }
    // Two slopes as rotated slabs.
    for (const side of [-1, 1] as const) {
      const slopeY = shellY + rise / 2;
      const off = side * (half / 2);
      if (ridgeAlongX) {
        b.box(x, slopeY, z + off, longLen, 0.14, slopeLen, roofMat, 0, {
          noCollide: true, pitch: side * slopeAngle,
        });
      } else {
        b.box(x + off, slopeY, z, slopeLen, 0.14, longLen, roofMat, 0, {
          noCollide: true, roll: -side * slopeAngle,
        });
      }
    }
    // Ridge cap.
    if (ridgeAlongX) {
      b.box(x, shellY + rise + 0.05, z, longLen, 0.1, 0.24, trim, 0, { noCollide: true });
    } else {
      b.box(x, shellY + rise + 0.05, z, 0.24, 0.1, longLen, trim, 0, { noCollide: true });
    }
    // Brick chimney with cap.
    if (o.chimney) {
      const chX = ridgeAlongX ? x + o.w * 0.22 : x + o.d * 0.18;
      const chZ = ridgeAlongX ? z + o.d * 0.18 : z + o.d * 0.22;
      const chH = rise + 0.85;
      b.box(chX, shellY + chH / 2, chZ, 0.55, chH, 0.55, 'bricksOld', 0, { noCollide: true });
      b.box(chX, shellY + chH + 0.06, chZ, 0.72, 0.14, 0.72, trim, 0, { noCollide: true });
    }
  }

  // Rooftop plant (flat roofs, larger footprints): deterministic HVAC/vent/
  // pipe clusters kept in the right half of the roof, clear of the back-left
  // interior stairwell and the exterior-stair landing on the left edge.
  // Decoration only — the roof platform stays fully walkable.
  if (o.roofStyle !== 'gable') {
    const roofArea = o.w * o.d;
    const gearBudget = style === 'city'
      ? roofArea >= 320 ? 3 : roofArea >= 180 ? 2 : roofArea >= 90 ? 1 : 0
      : style === 'facility'
        ? roofArea >= 200 ? 2 : roofArea >= 90 ? 1 : 0
        : roofArea >= 150 ? 1 : 0;
    const gearSpots: Array<[number, number]> = [
      [x + hw * 0.45, z + hd * 0.42],
      [x + hw * 0.45, z - hd * 0.42],
      [x, z + hd * 0.42],
    ];
    const gearSeed = facadeHash(9, 0, floors, 5);
    for (let gi = 0; gi < gearBudget; gi++) {
      const [gx, gz] = gearSpots[(gearSeed + gi) % 3]!;
      const kind = facadeHash(9, gx, gz, 6) % 3;
      if (kind === 0) {
        // HVAC pack with a roof-mounted fan and a supply duct beside it.
        b.box(gx, roofY + 0.29, gz, 0.95, 0.65, 0.7, 'metalExterior', 0, { noCollide: true });
        b.cyl(gx, roofY + 0.69, gz, 0.22, 0.14, 'metalDark', { segments: 10, noCollide: true });
        b.box(gx + 0.78, roofY + 0.19, gz, 0.5, 0.38, 0.4, 'metalDark', 0, { noCollide: true });
      } else if (kind === 1) {
        // Staggered vent stack pair joined by a low crossover pipe.
        b.cyl(gx, roofY + 0.245, gz, 0.2, 0.55, 'metalDark', { segments: 10, noCollide: true });
        b.cyl(gx + 0.55, roofY + 0.395, gz, 0.15, 0.85, 'rust', { segments: 10, noCollide: true });
        b.box(gx + 0.27, roofY + 0.36, gz, 0.55, 0.12, 0.12, 'metalDark', 0, { noCollide: true });
      } else {
        // Low pipe run on stanchions with one rising stack.
        for (const px of [gx - 1.1, gx, gx + 1.1]) {
          b.box(px, roofY + 0.145, gz, 0.11, 0.35, 0.11, 'metalDark', 0, { noCollide: true });
        }
        b.box(gx, roofY + 0.375, gz, 2.4, 0.14, 0.14, 'metalExterior', 0, { noCollide: true });
        b.cyl(gx + 1.2, roofY + 0.67, gz, 0.16, 0.5, 'rust', { segments: 10, noCollide: true });
      }
    }
    if (style === 'facility') {
      // Service conduit dropping down one facade corner with a clip band
      // per storey — the industrial tell that the elevations are serviced.
      const cs = facadeHash(8, 0, 0, 7) % 4;
      const faceSide = cs < 2 ? 0 : 2;
      const offSign = cs % 2 === 0 ? 1 : -1;
      const fromStart = offSign > 0 ? o.w - 0.4 : 0.4;
      const blockedByDoor = (o.doors ?? []).some(([dSide, dOff, dW]) => (
        dSide === faceSide && dOff - 0.3 < fromStart + 0.3 && fromStart - 0.3 < dOff + dW + 0.3
      ));
      const conduitH = floors * fh - 1.3;
      if (conduitH > 1 && !blockedByDoor) {
        const conduitAlong = offSign * (hw - 0.4);
        facePiece(faceSide, conduitAlong, baseY + 0.3 + conduitH / 2, 0.15, conduitH, 0.16, 0.09, 'metalExterior');
        for (let fl = 0; fl < floors; fl++) {
          facePiece(faceSide, conduitAlong, baseY + fl * fh + fh - 0.55, 0.34, 0.07, 0.2, 0.13, 'metalExterior');
        }
      }
    }
  }

  // Exterior access staircase to the roof (along the left wall)
  if (o.roofAccess) {
    // structureBaseY levels the building to its highest footprint sample;
    // exterior stair posts can stand on the downhill side. Give every visible
    // support a common embedded footing instead of stopping at that level pad.
    const fireEscapeFoundationDepth = 1.6;
    const fireEscapeFoundationY = baseY - fireEscapeFoundationDepth;
    const ph = o.parapet === false ? 0 : 0.8;
    const totalRise = roofY - baseY;
    const steps = Math.ceil(totalRise / 0.52);
    const stepH = totalRise / steps;
    const stair = planStairs(steps, stepH, 0.64, 1.9);
    // Fit every flight between the building's front/back edges. Tall or
    // shallow buildings use switchbacks instead of letting a single run end
    // in empty space far beyond the roof.
    const frontZ = z + hd - 1.8;
    const usableRun = Math.max(3.2, o.d - 3.6);
    const maxStepsPerFlight = Math.max(3, Math.floor(usableRun / stair.stepD));
    const flightCount = Math.ceil(stair.steps / maxStepsPerFlight);
    const innerStairX = x - hw - stair.width / 2 - 0.35;
    const outerStairX = innerStairX - stair.width - 0.55;
    const landingCenterX = (innerStairX + outerStairX) / 2;
    const landingWidth = innerStairX - outerStairX + stair.width + 0.4;
    // A real bottom landing gives the stair sampler a capsule-clear node that
    // connects to the surrounding ground grid instead of an isolated point
    // trapped between the first riser and the fire-escape posts. It extends
    // 0.4 m under the first tread: a slab edge exactly at the riser line left
    // the approaching capsule half-supported there and its autostep never
    // completed.
    b.slab(outerStairX, baseY + 0.04, frontZ + 0.8, stair.width + 0.5, 2.4, 0.2, stairMat);
    let remainingSteps = stair.steps;
    let currentY = baseY;
    let currentZ = frontZ;
    let topStairX = outerStairX;
    for (let flight = 0; flight < flightCount; flight++) {
      const flightsLeft = flightCount - flight;
      const flightSteps = Math.ceil(remainingSteps / flightsLeft);
      const dir = flight % 2 === 0 ? 2 : 0;
      const flightX = flight % 2 === 0 ? outerStairX : innerStairX;
      topStairX = flightX;
      const flightPlan = b.stairs(
        flightX,
        currentY,
        currentZ,
        dir,
        flightSteps,
        stair.stepH,
        stair.stepD,
        stair.width,
        'metalExterior',
      );
      const railSide = flight % 2 === 0 ? -1 : 1;
      const railX = flightX + railSide * (stair.width / 2 + 0.055);
      const travelSign = dir === 0 ? 1 : -1;
      const railPostSteps = new Set<number>();
      for (let step = 0; step <= flightSteps; step += 3) railPostSteps.add(step);
      railPostSteps.add(flightSteps);
      for (const step of [...railPostSteps].sort((a, b2) => a - b2)) {
        const railZ = currentZ + travelSign * step * stair.stepD;
        const railY = currentY + step * stair.stepH + 0.58;
        b.box(railX, railY, railZ, 0.085, 1.05, 0.085, 'metalExterior', 0, { noCollide: true });
      }
      // One true sloped handrail joins the posts. Horizontal per-step bars
      // read as detached floating strips at close range.
      const railRise = flightSteps * stair.stepH;
      const railRun = flightSteps * stair.stepD;
      b.box(
        railX,
        currentY + railRise / 2 + 1.1,
        currentZ + travelSign * railRun / 2,
        0.09,
        0.09,
        Math.hypot(railRun, railRise) + 0.08,
        'metalExterior',
        0,
        {
          noCollide: true,
          pitch: -travelSign * Math.atan2(railRise, railRun),
        },
      );
      // Continuous guard envelope behind the visible rail line: the
      // presentation-only posts and handrail now actually stop a capsule.
      b.guardRail(
        { x: railX, z: currentZ },
        { x: railX, z: currentZ + travelSign * railRun },
        currentY - 0.15,
        currentY + railRise + 1.2,
      );
      currentZ += (dir === 0 ? 1 : -1) * flightPlan.run;
      currentY += flightPlan.totalRise;
      remainingSteps -= flightSteps;
      if (flight < flightCount - 1) {
        // Bias the switchback landing FORWARD along the arrival direction. A
        // slab centred on the flight boundary hung 1.2 m back over the last
        // treads with only ~0.15 m of headroom, and real KCC ascent stalled
        // against its edge one riser below every switchback.
        const arriveSign = dir === 0 ? 1 : -1;
        const landingNear = currentZ - arriveSign * 0.25;
        const landingFar = currentZ + arriveSign * 2.15;
        b.slab(
          landingCenterX,
          currentY + 0.05,
          (landingNear + landingFar) / 2,
          landingWidth,
          Math.abs(landingFar - landingNear),
          0.25,
          'metalExterior',
        );
        // The switchback opens toward the next flight. Guard the far edge so
        // the rail alternates with the stair direction.
        const guardedZ = landingFar - arriveSign * 0.2;
        b.box(landingCenterX, currentY + 1.05, guardedZ, landingWidth, 0.09, 0.09, 'metalExterior', 0, { noCollide: true });
        for (const landingX of [landingCenterX - landingWidth / 2 + 0.08, landingCenterX + landingWidth / 2 - 0.08]) {
          b.box(landingX, currentY + 0.55, guardedZ, 0.085, 1.05, 0.085, 'metalExterior', 0, { noCollide: true });
        }
        b.guardRail(
          { x: landingCenterX - landingWidth / 2, z: guardedZ },
          { x: landingCenterX + landingWidth / 2, z: guardedZ },
          currentY - 0.1,
          currentY + 1.12,
        );
        const supportHeight = currentY - fireEscapeFoundationY;
        if (supportHeight > 0.4) {
          b.box(outerStairX, fireEscapeFoundationY + supportHeight / 2, currentZ, 0.14, supportHeight, 0.14, 'metalExterior', 0, { noCollide: true });
        }
      }
    }
    const zLand = currentZ;
    // Top landing bridges the wall gap and physically overlaps the roof edge.
    // It is biased forward along the arriving flight's direction (like the
    // switchback landings): a centred bridge hung 1.3 m back over the top
    // treads with ~0.15 m of headroom and blocked the last steps of every
    // fire escape.
    const arriveSign = (flightCount - 1) % 2 === 0 ? -1 : 1;
    const bridgeLo = arriveSign === 1
      ? zLand - 0.25
      : Math.max(zLand - 2.35, z - hd - 0.25);
    const bridgeHi = arriveSign === 1
      ? Math.min(zLand + 2.35, z + hd + 0.25)
      : zLand + 0.25;
    const roofLandingInnerEdge = x - hw + 0.25;
    const roofLandingOuterEdge = topStairX - stair.width / 2 - 0.2;
    b.slab(
      (roofLandingInnerEdge + roofLandingOuterEdge) / 2,
      roofY + 0.05,
      (bridgeLo + bridgeHi) / 2,
      roofLandingInnerEdge - roofLandingOuterEdge,
      Math.abs(bridgeHi - bridgeLo),
      0.25,
      'metalExterior',
    );
    // Guard and support the exposed outer edge of the roof bridge. These are
    // visual-only so the authored traversal width remains unchanged.
    b.box(
      roofLandingOuterEdge,
      roofY + 1.05,
      (bridgeLo + bridgeHi) / 2,
      0.09,
      0.09,
      Math.abs(bridgeHi - bridgeLo),
      'metalExterior',
      0,
      { noCollide: true },
    );
    for (const postZ of [bridgeLo + 0.2, (bridgeLo + bridgeHi) / 2, bridgeHi - 0.2]) {
      b.box(roofLandingOuterEdge, roofY + 0.55, postZ, 0.085, 1.05, 0.085, 'metalExterior', 0, { noCollide: true });
    }
    b.guardRail(
      { x: roofLandingOuterEdge, z: bridgeLo },
      { x: roofLandingOuterEdge, z: bridgeHi },
      roofY - 0.1,
      roofY + 1.15,
    );
    const topSupportHeight = roofY - fireEscapeFoundationY;
    b.box(
      roofLandingOuterEdge,
      fireEscapeFoundationY + topSupportHeight / 2,
      zLand,
      0.14,
      topSupportHeight,
      0.14,
      'metalExterior',
      0,
      { noCollide: true },
    );
    if (ph > 0) {
      b.wallWithGaps(x - hw - 0.25, z - hd - 0.25, o.d + 0.5, ph, 0.25, 'z', trim,
        [[Math.max(0, zLand - 1.5 - (z - hd - 0.25)), 3]], 0, roofY);
    }
    // Exterior fire-escape posts make every landing visibly supported.
    const postHeight = totalRise + fireEscapeFoundationDepth;
    for (const postZ of [frontZ, z - hd + 1.8]) {
      b.box(outerStairX - stair.width / 2, fireEscapeFoundationY + postHeight / 2, postZ, 0.18, postHeight, 0.18, 'metalExterior');
      b.box(innerStairX + stair.width / 2, fireEscapeFoundationY + postHeight / 2, postZ, 0.18, postHeight, 0.18, 'metalExterior');
    }
  }

  // Roof access hatch gap: leave a hole by splitting roof when requested
  if (o.roofAccess) {
    // simple approach: low parapet opening on back side (climb over)
    // (stairs already reach top floor; final hop is a mantle link)
  }

  // Windows glass on ground floor front
  if (o.windows !== false) {
    const gy = baseY + 1.1 + (fh - 1.1) / 2;
    const frontDoors = (o.doors ?? [])
      .filter((door) => door[0] === 0)
      .map((door) => [door[1], door[2]] as [number, number]);
    for (let i = 0; i < 2; i++) {
      const windowGap: [number, number] = [o.w * (0.28 + i * 0.44) - 0.75, 1.5];
      if (frontDoors.some((door) => gapsOverlap(windowGap, door))) continue;
      const wx = x - hw + o.w * (0.28 + i * 0.44);
      b.glassPane(wx, gy, z + hd - t / 2 - 0.08, 1.5, fh - 1.6, 'x');
      dressWindow(0, o.w * (0.28 + i * 0.44) - hw, 0, 1.5, gy - (fh - 1.6) / 2, gy + (fh - 1.6) / 2);
    }
  }

  // Interior loot anchors
  const rng = new Rng(hashOf(o.x, o.z));
  b.loot(x + rng.range(-hw * 0.5, hw * 0.5), baseY + 0.35, z + rng.range(-hd * 0.5, hd * 0.5));
  if (floors > 1) {
    b.loot(x + rng.range(-hw * 0.4, hw * 0.4), baseY + fh + 0.55, z + rng.range(-hd * 0.4, hd * 0.4));
  }
}

export function slabWithHole(
  b: WorldBuilder,
  x: number,
  yTop: number,
  z: number,
  width: number,
  depth: number,
  thickness: number,
  mat: MatKey,
  hole: { minX: number; maxX: number; minZ: number; maxZ: number },
  opts?: { noCollide?: boolean },
): void {
  const minX = x - width / 2;
  const maxX = x + width / 2;
  const minZ = z - depth / 2;
  const maxZ = z + depth / 2;
  const hx0 = Math.max(minX, Math.min(maxX, hole.minX));
  const hx1 = Math.max(hx0, Math.min(maxX, hole.maxX));
  const hz0 = Math.max(minZ, Math.min(maxZ, hole.minZ));
  const hz1 = Math.max(hz0, Math.min(maxZ, hole.maxZ));
  const add = (x0: number, x1: number, z0: number, z1: number) => {
    if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
    if (opts?.noCollide) {
      b.box(
        (x0 + x1) / 2,
        yTop - thickness / 2,
        (z0 + z1) / 2,
        x1 - x0,
        thickness,
        z1 - z0,
        mat,
        0,
        { noCollide: true },
      );
    } else {
      b.slab((x0 + x1) / 2, yTop, (z0 + z1) / 2, x1 - x0, z1 - z0, thickness, mat);
    }
  };
  add(minX, hx0, minZ, maxZ);
  add(hx1, maxX, minZ, maxZ);
  add(hx0, hx1, minZ, hz0);
  add(hx0, hx1, hz1, maxZ);
}

function hashOf(x: number, z: number): number {
  return ((x * 73856093) ^ (z * 19349663)) >>> 0;
}

/** Flat ground plane with walkable platform registration. */
export function addGround(
  b: WorldBuilder,
  size: number,
  mat: MatKey,
  y = 0,
  registerPlatform = true,
  cutouts: TerrainCutout[] = [],
): void {
  if (cutouts.length === 0) {
    b.box(0, y - 1, 0, size + 200, 2, size + 200, mat, 0, { terrain: true });
    if (registerPlatform) b.platform(-size / 2, size / 2, -size / 2, size / 2, y);
    return;
  }
  for (const cutout of cutouts) b.terrainCutout(cutout);
  const half = (size + 200) / 2;
  const uniqueSorted = (values: number[]) => [...new Set(values)]
    .filter((value) => value >= -half && value <= half)
    .sort((a, b) => a - b);
  const xs = uniqueSorted([-half, ...cutouts.flatMap((hole) => [hole.minX, hole.maxX]), half]);
  const zs = uniqueSorted([-half, ...cutouts.flatMap((hole) => [hole.minZ, hole.maxZ]), half]);
  for (let xi = 0; xi < xs.length - 1; xi++) {
    for (let zi = 0; zi < zs.length - 1; zi++) {
      const minX = xs[xi]!;
      const maxX = xs[xi + 1]!;
      const minZ = zs[zi]!;
      const maxZ = zs[zi + 1]!;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      if (cutouts.some((hole) => cx >= hole.minX && cx <= hole.maxX && cz >= hole.minZ && cz <= hole.maxZ)) continue;
      b.box(cx, y - 1, cz, maxX - minX, 2, maxZ - minZ, mat, 0, { terrain: true });
    }
  }
  if (registerPlatform) b.platform(-size / 2, size / 2, -size / 2, size / 2, y);
}

/** Scatter trees avoiding building rectangles (simple min-distance check). */
export function scatterTrees(
  b: WorldBuilder, rng: Rng, count: number,
  area: { minX: number; maxX: number; minZ: number; maxZ: number },
  variant: 'pine' | 'oak' | 'palm' | 'dead',
  avoid: Array<{ x: number; z: number; r: number }> = [],
  heightAt?: (x: number, z: number) => number,
): void {
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts++ < count * 12) {
    const x = rng.range(area.minX, area.maxX);
    const z = rng.range(area.minZ, area.maxZ);
    if (avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
    const y = heightAt ? heightAt(x, z) : 0;
    if (b.tree({ x, z, y, scale: rng.range(0.8, 1.5), variant })) placed++;
  }
}

export function scatterRocks(
  b: WorldBuilder, rng: Rng, count: number,
  area: { minX: number; maxX: number; minZ: number; maxZ: number },
  avoid: Array<{ x: number; z: number; r: number }> = [],
  heightAt?: (x: number, z: number) => number,
): void {
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts++ < count * 20) {
    const x = rng.range(area.minX, area.maxX);
    const z = rng.range(area.minZ, area.maxZ);
    const scale = rng.range(0.6, 2.4);
    const radius = ROCK_CLEARANCE_RADIUS * scale;
    if (avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r + radius)) continue;
    if (b.def.rocks.some((rock) => (
      Math.hypot(rock.x - x, rock.z - z)
        < (ROCK_CLEARANCE_RADIUS * rock.scale + radius) * 0.82
    ))) continue;
    b.rock(x, z, heightAt ? heightAt(x, z) : 0, scale);
    placed++;
  }
}

// ---------------------------------------------------------------------------
// POI density helpers (W8 street-level dressing). Appended for the maps that
// share a prop family; existing helpers above are untouched.
// ---------------------------------------------------------------------------

export interface MarketStallOpts {
  x: number;
  z: number;
  /** World-space support surface (ground/paving) under the stall. */
  baseY: number;
  /** Table run direction (radians). 0 = table runs along X. */
  yaw?: number;
  w?: number;
  d?: number;
  tableMat?: MatKey;
  postMat?: MatKey;
  awningMat?: MatKey;
  /** Ground cloth under the stall (market rug). */
  rugMat?: MatKey;
  /** Small goods boxes on the table top. */
  goods?: boolean;
}

/**
 * One market stall: timber table, four posts, sloped fabric awning and an
 * optional rug. The table is the only collidable piece (waist-high cover);
 * posts, awning, rug and goods are presentation-only so lanes stay clear.
 * Tops are deliberately non-coincident with the common paving/curb planes.
 */
export function addMarketStall(b: WorldBuilder, o: MarketStallOpts): void {
  const w = o.w ?? 3.6;
  const d = o.d ?? 1.9;
  const yaw = o.yaw ?? 0;
  const tableMat = o.tableMat ?? 'wood';
  const postMat = o.postMat ?? 'woodDark';
  const baseY = o.baseY;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (lx: number, lz: number): { x: number; z: number } => ({
    x: o.x + lx * c - lz * s,
    z: o.z + lx * s + lz * c,
  });
  // Rug first so the table legs read as standing on it.
  if (o.rugMat) {
    const rug = at(0, 0);
    b.box(rug.x, baseY + 0.045, rug.z, w + 1.1, 0.02, d + 1.3, o.rugMat, yaw, {
      noCollide: true,
      castShadow: false,
    });
  }
  // Table top (collidable, waist height).
  const top = at(0, 0);
  b.box(top.x, baseY + 0.95, top.z, w, 0.16, d, tableMat, yaw);
  // Four corner legs.
  for (const lx of [-w / 2 + 0.14, w / 2 - 0.14]) {
    for (const lz of [-d / 2 + 0.12, d / 2 - 0.12]) {
      const leg = at(lx, lz);
      b.box(leg.x, baseY + 0.44, leg.z, 0.12, 0.86, 0.12, postMat, 0, {
        noCollide: true,
        castShadow: false,
      });
    }
  }
  // Awning: sloped cloth on two rear posts over the table.
  for (const lx of [-w / 2 + 0.2, w / 2 - 0.2]) {
    const post = at(lx, -d / 2 - 0.25);
    b.box(post.x, baseY + 1.15, post.z, 0.11, 2.3, 0.11, postMat, 0, {
      noCollide: true,
      castShadow: false,
    });
  }
  const awning = at(0, -d / 4);
  b.box(awning.x, baseY + 2.42, awning.z, w + 0.7, 0.09, d + 1.5, o.awningMat ?? 'plasterOld', yaw, {
    noCollide: true,
    castShadow: false,
    pitch: 0.14,
  });
  // A couple of goods boxes on the table.
  if (o.goods) {
    for (const [lx, lz, gw, gd] of [[-w * 0.22, 0.1, 0.5, 0.4], [w * 0.2, -0.15, 0.42, 0.34]] as Array<[number, number, number, number]>) {
      const good = at(lx, lz);
      b.box(good.x, baseY + 1.2, good.z, gw, 0.28, gd, 'woodDark', yaw + 0.2, {
        noCollide: true,
        castShadow: false,
      });
    }
  }
}

export interface DrumClusterOpts {
  /** Support surface under the drums. */
  baseY: number;
  count?: number;
  uprightMat?: MatKey;
  /** One drum stacked on the cluster when true. */
  stack?: boolean;
}

/**
 * True when an axis-aligned dressing footprint (hx/hz half extents, spanning
 * yLow..yHigh) has no meaningful overlap with authored world content: visible
 * or proxy geometry, destructible props and (optionally) parked vehicles.
 * Used by the late street/POI density passes so decoration can never bury a
 * chest, snag a doorway or interpenetrate a parked car. `margin` grows every
 * solid by the same amount (metres).
 */
export function dressingSpotClear(
  def: MapDef,
  x: number,
  z: number,
  hx: number,
  hz: number,
  yLow: number,
  yHigh: number,
  opts?: { crates?: boolean; vehicles?: boolean; margin?: number },
): boolean {
  const m = opts?.margin ?? 0;
  const overlapsY = (lo: number, hi: number): boolean => hi > yLow - m && lo < yHigh + m;
  for (const g of def.geo) {
    // A shape whose top is at/below the dressing support surface IS the floor
    // the prop stands on (ground slab, road strip, paving, raised sidewalk)
    // — not an obstacle. 26 cm covers the sidewalk table above nominal ground
    // while still treating kerb lips and plinths as real obstacles.
    const top = g.kind === 'box' ? g.y + g.sy / 2 : g.kind === 'cyl' ? g.y + g.h / 2 : g.y + g.r;
    if (top <= yLow + 0.26) continue;
    if (g.kind === 'box') {
      const c = Math.abs(Math.cos(g.yaw));
      const s = Math.abs(Math.sin(g.yaw));
      const ghx = (g.sx * c + g.sz * s) / 2;
      const ghz = (g.sx * s + g.sz * c) / 2;
      if (Math.abs(x - g.x) < hx + ghx + m && Math.abs(z - g.z) < hz + ghz + m
        && overlapsY(g.y - g.sy / 2, top)) return false;
    } else {
      const r = g.r;
      const lo = g.kind === 'cyl' ? g.y - g.h / 2 : g.y - g.r;
      if (Math.hypot(x - g.x, z - g.z) < hx + r + m && overlapsY(lo, top)) return false;
    }
  }
  if (opts?.crates) {
    for (const d of def.destructibles) {
      const g = d.geo;
      const radius = g.kind === 'box' ? Math.hypot(g.sx, g.sz) / 2 : g.r;
      const lo = g.kind === 'box' ? g.y - g.sy / 2 : g.kind === 'cyl' ? g.y - g.h / 2 : g.y - g.r;
      const hi = g.kind === 'box' ? g.y + g.sy / 2 : g.kind === 'cyl' ? g.y + g.h / 2 : g.y + g.r;
      if (Math.hypot(x - g.x, z - g.z) < hx + radius + m && overlapsY(lo, hi)) return false;
    }
  }
  // Chests are not props: a dressing piece in a chest column either deletes
  // the chest at finish() or becomes the support the chest support-snap
  // resolves onto (both break the loot placement guarantees). Keep a
  // capsule-scale vertical exclusion around every authored chest.
  for (const chest of def.chests) {
    if (Math.abs(x - chest.x) < hx + 0.7 + m && Math.abs(z - chest.z) < hz + 0.7 + m
      && yHigh > chest.y - 1.7 && yLow < chest.y + 1.3) return false;
  }
  if (opts?.vehicles) {
    for (const v of def.vehicles) {
      if (Math.abs(x - v.x) < hx + 3.4 + m && Math.abs(z - v.z) < hz + 3.4 + m
        && overlapsY(v.y, v.y + 2.4)) return false;
    }
  }
  return true;
}

/**
 * Fuel/water drum cluster: upright cylinders spaced so equal-height tops
 * never overlap radially, plus one deterministic stacked pair. All drums are
 * collidable, crouch-height cover.
 */
export function addDrumCluster(b: WorldBuilder, x: number, z: number, o: DrumClusterOpts): void {
  const count = o.count ?? 3;
  const mat = o.uprightMat ?? 'rust';
  const r = 0.32;
  const h = 0.92;
  const offsets: Array<[number, number]> = [[0, 0], [0.86, 0.12], [0.34, 0.84], [-0.72, 0.5], [0.1, -0.88]];
  for (let i = 0; i < count && i < offsets.length; i++) {
    const [ox, oz] = offsets[i]!;
    b.cyl(x + ox, o.baseY + h / 2, z + oz, r, h, mat, { segments: 10 });
  }
  if (o.stack) {
    // Stacked pair: the lower top plane is unique because nothing else that
    // overlaps this footprint shares it (neighbours are offset 0.86+ away).
    b.cyl(x + 1.72, o.baseY + h / 2, z - 0.2, r, h, mat, { segments: 10 });
    b.cyl(x + 1.78, o.baseY + h + h / 2, z - 0.14, r, h, mat, { segments: 10, noCollide: true });
  }
}

// ---------------------------------------------------------------------------
// Ground-decay micro-scatter (connective-tissue pass). Appended after the W8
// density helpers; the helpers above are untouched.
// ---------------------------------------------------------------------------

export interface GroundDecayCorridor {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** Full paved/corridor width; marks hug the margins and the wheel lines. */
  width: number;
}

export interface GroundDecayOpts {
  /** Terrain sampler for the map (flat maps pass () => 0). */
  heightAt: (x: number, z: number) => number;
  /** Road spines / path runs the decay distributes along. */
  corridors: GroundDecayCorridor[];
  /** Metres of corridor per decay family. Default 9. */
  spacing?: number;
  /** Shared-library material for damp stain patches (a dark key). */
  stainMat?: MatKey;
  /** Shared-library material for tyre-track strips on the wheel lines. */
  trackMat?: MatKey;
  /** Marks far from every POI are thinned to this fraction (0..1). Default 0.4. */
  offPoiKeep?: number;
  /**
   * Hard cap on geo pieces this layer may emit (the <=2% added-triangle gate).
   * Marks are planned for every corridor, then emitted round-robin until the
   * budget is spent, so thinning stays even across the network. Default 120.
   */
  maxPieces?: number;
  /**
   * Optional 0..1 bias forcing this fraction of marks to the single-piece
   * stain family (cheapest per mark) before the normal mix rolls in. Budget
   * starved maps raise it to stretch coverage.
   */
  stainBias?: number;
}

/**
 * Deterministic ground-decay layer for the connective tissue between POIs:
 * damp stain patches, gravel/pebble clusters, scattered litter and tyre-track
 * strips along road approaches, plus decay rings around existing ground props.
 *
 * Distribution concentrates near POIs (spawn views, approaches) and thins
 * off-corridor map edges, while any walked stretch still picks up marks. Every
 * placement is gated by dressingSpotClear so doors, chests, crates and props
 * stay clear, and each mark is a thin noCollide, castShadow:false plate that
 * sits a couple of centimetres proud of the local paved surface (the road-paint
 * idiom), with per-mark height jitter so overlapping plates never share a top
 * plane. The layer runs after roads and props exist; placement replays
 * byte-identically per build from its own fixed seed.
 */
export function addGroundDecay(b: WorldBuilder, o: GroundDecayOpts): void {
  const def = b.def;
  const stainMat = o.stainMat ?? 'concreteDark';
  const trackMat = o.trackMat ?? stainMat;
  const spacing = o.spacing ?? 9;
  const offPoiKeep = o.offPoiKeep ?? 0.4;
  // Own seed (folded with the built geo count) so repeated builds of one map
  // replay identically without disturbing the caller's rng sequence.
  const rng = new Rng(0xdec4a11 ^ def.geo.length);

  const isNearPoi = (x: number, z: number): boolean =>
    def.pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + 45);
  const keepOffPoi = (x: number, z: number): boolean => {
    const h = Math.imul(Math.round(x * 12.9898) ^ Math.round(z * 78.233), 2654435761) >>> 0;
    return (h % 100) / 100 < offPoiKeep;
  };

  /**
   * Top of the paved/finished layer under a point (road strip, sidewalk,
   * curb, plinth, stoop), capped just above kerb height so furniture tops
   * never become the support plane a mark would sit on.
   */
  const surfaceTopAt = (x: number, z: number): number => {
    let best = o.heightAt(x, z);
    const cap = best + 0.85;
    for (const g of def.geo) {
      if (g.noRender) continue;
      if (g.kind === 'box') {
        const top = g.y + g.sy / 2;
        if (top > cap || top <= best) continue;
        const c = Math.abs(Math.cos(g.yaw));
        const s = Math.abs(Math.sin(g.yaw));
        if (Math.abs(x - g.x) >= (g.sx * c + g.sz * s) / 2) continue;
        if (Math.abs(z - g.z) >= (g.sx * s + g.sz * c) / 2) continue;
        best = top;
      } else {
        const top = g.kind === 'cyl' ? g.y + g.h / 2 : g.y + g.r;
        if (top > cap || top <= best) continue;
        if (Math.hypot(x - g.x, z - g.z) >= g.r) continue;
        best = top;
      }
    }
    return best;
  };

  const gated = (x: number, z: number, hx: number, hz: number, yLow: number): boolean =>
    dressingSpotClear(def, x, z, hx, hz, yLow, yLow + 0.1, { crates: true, margin: 0.12 });

  let salt = 0;

  /**
   * Marks are planned first (all rng spent up front so planning order never
   * depends on gate outcomes), then emitted round-robin across corridors under
   * a hard piece budget — the <=2% triangle gate per map. Emit functions
   * return the pieces actually placed (0 when a gate rejected the spot), so a
   * rejected mark frees budget for a later one.
   */
  interface PlannedMark {
    emit: () => number;
  }
  const planned: Array<PlannedMark[]> = [];
  const planInto = (corridorIdx: number, emit: () => number): void => {
    while (planned.length <= corridorIdx) planned.push([]);
    planned[corridorIdx]!.push({ emit });
  };

  /** One dark stain plate; a couple of centimetres proud of the surface. */
  const stain = (x: number, z: number, yaw: number, w: number, d: number, mark: number): number => {
    const gy = surfaceTopAt(x, z);
    const hx = Math.max(w, d) / 2 + 0.15;
    if (!gated(x, z, hx, hx, gy)) return 0;
    b.box(x, gy + 0.012 + (mark % 5) * 0.004, z, w, 0.03, d, stainMat, yaw, {
      noCollide: true,
      castShadow: false,
    });
    return 1;
  };

  /** Gravel/pebble cluster: a few tiny rock chips in a ~1.7 m patch. */
  const gravel = (x: number, z: number, mark: number, chips: number, a0: number, radii: number[], sizes: number[], yaws: number[]): number => {
    const gy = surfaceTopAt(x, z);
    if (!gated(x, z, 1.3, 1.3, gy)) return 0;
    for (let i = 0; i < chips; i++) {
      const s = sizes[i]!;
      b.box(
        x + Math.cos(a0 + i * 2.4) * radii[i]!,
        gy + s / 2 + 0.006 + (i % 3) * 0.004,
        z + Math.sin(a0 + i * 2.4) * radii[i]!,
        s * 1.25,
        s,
        s,
        'rock',
        yaws[i]!,
        { noCollide: true, castShadow: false },
      );
    }
    void mark;
    return chips;
  };

  /** Scattered litter: one or two small crumpled plates. */
  const litter = (x: number, z: number, mark: number, w1: number, h1: number, d1: number, w2: number, h2: number, d2: number, second: boolean): number => {
    const gy = surfaceTopAt(x, z);
    if (!gated(x, z, 0.7, 0.7, gy)) return 0;
    const mats: MatKey[] = ['woodDark', 'concreteDark', 'metalDark'];
    b.box(x, gy + 0.035 + (mark % 4) * 0.003, z, w1, h1, d1, mats[mark % mats.length]!, mark * 0.7, {
      noCollide: true,
      castShadow: false,
    });
    if (second) {
      b.box(
        x + ((mark % 3) - 1) * 0.45,
        gy + 0.028 + ((mark + 1) % 4) * 0.003,
        z + ((mark % 2) - 0.5) * 0.8,
        w2,
        h2,
        d2,
        mats[(mark + 1) % mats.length]!,
        mark * 1.3,
        { noCollide: true, castShadow: false },
      );
      return 2;
    }
    return 1;
  };

  /** Tyre-track strip pair on the wheel lines, elongated along the road. */
  const tracks = (
    cx: number, cz: number,
    ux: number, uz: number, nx: number, nz: number,
    width: number, mark: number, len: number, w2: number,
  ): number => {
    const yaw = Math.atan2(uz, ux);
    const lane = Math.max(1.1, width * 0.2);
    let placed = 0;
    for (const side of [-1, 1]) {
      const tx = cx + nx * side * lane;
      const tz = cz + nz * side * lane;
      const gy = surfaceTopAt(tx, tz);
      if (!gated(tx, tz, len / 2, len / 2, gy)) continue;
      b.box(tx, gy + 0.01 + ((mark + side + 2) % 3) * 0.004, tz, len, 0.024, w2, trackMat, yaw, {
        noCollide: true,
        castShadow: false,
      });
      placed++;
    }
    return placed;
  };

  for (let corIdx = 0; corIdx < o.corridors.length; corIdx++) {
    const cor = o.corridors[corIdx]!;
    const dx = cor.x2 - cor.x1;
    const dz = cor.z2 - cor.z1;
    const len = Math.hypot(dx, dz);
    if (len < 4) continue;
    const ux = dx / len;
    const uz = dz / len;
    const nx = -uz;
    const nz = ux;
    const count = Math.max(1, Math.round(len / spacing));
    for (let i = 0; i < count; i++) {
      const t = len * ((i + 0.5) / count) + rng.range(-spacing * 0.3, spacing * 0.3);
      if (t < 2 || t > len - 2) continue;
      const cx = cor.x1 + ux * t;
      const cz = cor.z1 + uz * t;
      if (!isNearPoi(cx, cz) && !keepOffPoi(cx, cz)) continue;
      const roll = rng.next();
      const side = rng.bool() ? 1 : -1;
      const lat = side * Math.max(0.8, cor.width / 2 - rng.range(0.5, Math.min(2.4, cor.width / 2)));
      const mx = cx + nx * lat;
      const mz = cz + nz * lat;
      const mark = salt++;
      // The optional bias widens the stain band and squeezes the rest of the
      // mix proportionally, so budget-starved maps trade cluster variety for
      // corridor coverage instead of losing marks wholesale.
      const bias = o.stainBias ?? 0;
      const stainUpTo = bias + 0.52 * (1 - bias);
      const gravelUpTo = stainUpTo + 0.22 * (1 - bias);
      const litterUpTo = gravelUpTo + 0.16 * (1 - bias);
      if (roll < stainUpTo) {
        const yaw = Math.atan2(uz, ux) + rng.range(-0.6, 0.6);
        const w = rng.range(0.7, 1.9);
        const d = rng.range(0.5, 1.3);
        planInto(corIdx, () => stain(mx, mz, yaw, w, d, mark));
      } else if (roll < gravelUpTo) {
        const chips = 3;
        const a0 = rng.angle();
        const radii = [rng.range(0.05, 0.85), rng.range(0.05, 0.85), rng.range(0.05, 0.85)];
        const sizes = [rng.range(0.06, 0.16), rng.range(0.06, 0.16), rng.range(0.06, 0.16)];
        const yaws = [rng.angle(), rng.angle(), rng.angle()];
        planInto(corIdx, () => gravel(mx, mz, mark, chips, a0, radii, sizes, yaws));
      } else if (roll < litterUpTo) {
        const w1 = rng.range(0.16, 0.42);
        const h1 = rng.range(0.06, 0.14);
        const d1 = rng.range(0.12, 0.3);
        const w2 = rng.range(0.2, 0.38);
        const h2 = rng.range(0.04, 0.09);
        const d2 = rng.range(0.16, 0.3);
        const second = rng.bool(0.45);
        planInto(corIdx, () => litter(mx, mz, mark, w1, h1, d1, w2, h2, d2, second));
      } else {
        const tLen = rng.range(4.5, 7.5);
        const tw = rng.range(0.4, 0.6);
        planInto(corIdx, () => tracks(cx, cz, ux, uz, nx, nz, cor.width, mark, tLen, tw));
      }
    }
  }

  // Decay rings around existing ground props (crates, cabinets, dumpsters,
  // drums, planters): every third eligible prop gets a stain or gravel patch
  // just off its footprint, so cluttered corners read trodden and damp. These
  // join the same round-robin pool as the corridor marks.
  const props: Array<{ x: number; z: number }> = [];
  for (const g of def.geo) {
    if (props.length >= 160) break;
    if (g.noRender) continue;
    let base: number;
    if (g.kind === 'box') {
      const span = Math.max(g.sx, g.sz);
      const thick = Math.min(g.sx, g.sz);
      if (span < 0.5 || span > 5.5 || g.sy < 0.5 || g.sy > 4.5) continue;
      if (thick <= 0.7 && span >= 4) continue; // wall run, not a prop
      base = g.y - g.sy / 2;
    } else if (g.kind === 'cyl') {
      if (g.r < 0.25 || g.r > 1.6 || g.h < 0.4 || g.h > 3.4) continue;
      base = g.y - g.h / 2;
    } else continue;
    const terr = o.heightAt(g.x, g.z);
    if (base < terr - 0.3 || base > terr + 0.6) continue;
    props.push({ x: g.x, z: g.z });
  }
  const propGroup = planned.length;
  planned.push([]);
  for (let i = 0; i < props.length; i += 3) {
    const p = props[i]!;
    const a = rng.angle();
    const r = 1.1 + rng.range(0, 0.9);
    const mx = p.x + Math.cos(a) * r;
    const mz = p.z + Math.sin(a) * r;
    const mark = salt++;
    const useStain = rng.bool(0.6);
    const w = rng.range(0.6, 1.4);
    const d = rng.range(0.5, 1.1);
    const a0 = rng.angle();
    const radii = [rng.range(0.05, 0.8), rng.range(0.05, 0.8), rng.range(0.05, 0.8)];
    const sizes = [rng.range(0.06, 0.15), rng.range(0.06, 0.15), rng.range(0.06, 0.15)];
    const yaws = [rng.angle(), rng.angle(), rng.angle()];
    planInto(propGroup, () => (useStain
      ? stain(mx, mz, a, w, d, mark)
      : gravel(mx, mz, mark, 3, a0, radii, sizes, yaws)));
  }

  // Emit round-robin: one mark per corridor group per pass, until the piece
  // budget is spent. Keeps coverage even when the budget forces thinning.
  // Each group is shuffled first (same deterministic rng) so the kept prefix
  // spreads along the whole corridor instead of clustering at its start.
  for (const list of planned) rng.shuffle(list);
  let piecesLeft = o.maxPieces ?? 120;
  const depths = planned.map((list) => list.length);
  for (let round = 0; piecesLeft > 0; round++) {
    let any = false;
    for (let g = 0; g < planned.length && piecesLeft > 0; g++) {
      if (round >= depths[g]!) continue;
      any = true;
      piecesLeft -= planned[g]![round]!.emit();
    }
    if (!any) break;
  }
}
