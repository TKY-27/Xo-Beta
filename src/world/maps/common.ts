/**
 * Shared map construction helpers: terrain, generic buildings, interiors,
 * scatter props. Deterministic per-map seeds keep layouts stable.
 */

import { WorldBuilder } from '../builder';
import type { MatKey } from '../types';
import { Rng } from '../../core/rng';

export interface BuildingOpts {
  x: number;
  z: number;
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
  const hw = o.w / 2, hd = o.d / 2;
  const trim = o.trimMat ?? o.wallMat;
  const floorMat = o.floorMat ?? 'concreteDark';
  const roofMat = o.roofMat ?? trim;

  // Foundation slab
  b.slab(x, 0.15, z, o.w + 0.8, o.d + 0.8, 0.3, trim);

  for (let f = 0; f < floors; f++) {
    const y0 = f * fh;

    // Floor slab (skip ground — foundation serves)
    if (f > 0) {
      b.slab(x, y0 + 0.18, z, o.w, o.d, 0.35, floorMat);
    }

    const sillH = f === 0 ? 1.1 : 0.9;

    // Walls with gaps: sides 0:+z(front) 1:+x(right) 2:-z(back) 3:-x(left)
    const frontDoors = (o.doors ?? []).filter((dd) => dd[0] === 0).map((dd) => [dd[1], dd[2]] as [number, number]);
    const backDoors = (o.doors ?? []).filter((dd) => dd[0] === 2).map((dd) => [dd[1], dd[2]] as [number, number]);
    const rightDoors = (o.doors ?? []).filter((dd) => dd[0] === 1).map((dd) => [dd[1], dd[2]] as [number, number]);
    const leftDoors = (o.doors ?? []).filter((dd) => dd[0] === 3).map((dd) => [dd[1], dd[2]] as [number, number]);

    if (f === 0) {
      b.wallWithGaps(x - hw, z + hd, o.w, fh, t, 'x', o.wallMat, frontDoors);
      b.wallWithGaps(x - hw, z - hd, o.w, fh, t, 'x', o.wallMat, backDoors);
      b.wallWithGaps(x + hw, z - hd, o.d, fh, t, 'z', o.wallMat, rightDoors);
      b.wallWithGaps(x - hw, z - hd, o.d, fh, t, 'z', o.wallMat, leftDoors);
    } else {
      // Upper floors: windows (sill gaps) all around
      const winGapsFront: Array<[number, number]> = [];
      const winGapsBack: Array<[number, number]> = [];
      const step = Math.max(3, o.w / 4);
      for (let wx = step / 2; wx < o.w - 0.5; wx += step) {
        winGapsFront.push([wx, 1.4]);
        winGapsBack.push([wx, 1.4]);
      }
      const winGapsRight: Array<[number, number]> = [];
      const winGapsLeft: Array<[number, number]> = [];
      const stepD = Math.max(3, o.d / 4);
      for (let wz = stepD / 2; wz < o.d - 0.5; wz += stepD) {
        winGapsRight.push([wz, 1.4]);
        winGapsLeft.push([wz, 1.4]);
      }
      b.wallWithGaps(x - hw, z + hd, o.w, fh, t, 'x', o.wallMat, [...frontDoors, ...winGapsFront], sillH);
      b.wallWithGaps(x - hw, z - hd, o.w, fh, t, 'x', o.wallMat, [...backDoors, ...winGapsBack], sillH);
      b.wallWithGaps(x + hw, z - hd, o.d, fh, t, 'z', o.wallMat, [...rightDoors, ...winGapsRight], sillH);
      b.wallWithGaps(x - hw, z - hd, o.d, fh, t, 'z', o.wallMat, [...leftDoors, ...winGapsLeft], sillH);
    }

    // Interior divider with doorway (alternating orientation per floor)
    if (o.interiorDividers !== false && o.w > 9 && o.d > 9) {
      const divOffset = f % 2 === 0 ? o.w * 0.33 : o.w * 0.66;
      const gapStart = o.d * 0.42;
      if (f % 2 === 0) {
        b.wallWithGaps(x - hw + divOffset, z - hd + t, o.d - t * 2, fh, 0.3, 'z', trim, [[gapStart, 1.6]]);
      } else {
        b.wallWithGaps(x - hw + t, z - hd + divOffset, o.w - t * 2, fh, 0.3, 'x', trim, [[gapStart, 1.6]]);
      }
    }

    // Stairs to next level (stairwell against back-left corner)
    if (f < floors - 1 || o.roofAccess) {
      const steps = Math.ceil(fh / 0.55);
      const stepH = fh / steps;
      const stairLen = steps * 0.62;
      if (stairLen < o.d - 2) {
        b.stairs(x - hw + 1.4, y0 + (f > 0 ? 0.18 : 0), z - hd + 0.8, 0, steps, stepH, 0.62, 1.7, 'concreteDark');
        // Landing cut in next floor handled by slab overlap (stairs punch through visually acceptable)
      }
    }
  }

  // Roof
  const roofY = floors * fh + 0.2;
  b.slab(x, roofY, z, o.w + 0.5, o.d + 0.5, 0.35, roofMat);
  if (o.parapet !== false) {
    const ph = 0.8;
    b.box(x, roofY + ph / 2, z + hd + 0.25, o.w + 0.5, ph, 0.25, trim);
    b.box(x, roofY + ph / 2, z - hd - 0.25, o.w + 0.5, ph, 0.25, trim);
    b.box(x + hw + 0.25, roofY + ph / 2, z, 0.25, ph, o.d + 0.5, trim);
    if (!(o.roofAccess && floors > 1)) {
      // Left parapet is handled by the exterior-stair block when present.
      b.box(x - hw - 0.25, roofY + ph / 2, z, 0.25, ph, o.d + 0.5, trim);
    }
    b.platform(x - hw - 0.4, x + hw + 0.4, z - hd - 0.4, z + hd + 0.4, roofY);
  }

  // Exterior access staircase to the roof (along the left wall)
  if (o.roofAccess && floors > 1) {
    const ph = o.parapet === false ? 0 : 0.8;
    const totalRise = roofY;
    const steps = Math.ceil(totalRise / 0.52);
    const stepH = totalRise / steps;
    const runLen = steps * 0.64;
    if (runLen < o.d + 30) {
      // straight run alongside left wall, front -> back
      const zStart = z + hd - 0.5;
      b.stairs(x - hw - 1.35, 0, zStart, 2, steps, stepH, 0.64, 1.9, 'metalDark');
      // landing bridging the parapet gap where the stair meets the roof
      const zLand = zStart - runLen;
      b.slab(x - hw - 0.6, roofY + 0.05, zLand, 2.4, 2.4, 0.25, 'metalDark');
      // cut the left parapet around the landing (or leave open edge)
      if (ph > 0) {
        b.wallWithGaps(x - hw - 0.25, z - hd - 0.25, o.d + 0.5, ph, 0.25, 'z', trim,
          [[Math.max(0, zLand - 1.4 - (z - hd - 0.25)), 2.8]], 0, roofY);
      }
    }
  }

  // Roof access hatch gap: leave a hole by splitting roof when requested
  if (o.roofAccess) {
    // simple approach: low parapet opening on back side (climb over)
    // (stairs already reach top floor; final hop is a mantle link)
  }

  // Windows glass on ground floor front
  if (o.windows !== false) {
    const gy = 1.1 + (fh - 1.1) / 2;
    for (let i = 0; i < 2; i++) {
      const wx = x - hw + o.w * (0.28 + i * 0.44);
      b.glassPane(wx, gy, z + hd, 1.5, fh - 1.6, 'x');
    }
  }

  // Interior loot anchors
  const rng = new Rng(hashOf(o.x, o.z));
  b.loot(x + rng.range(-hw * 0.5, hw * 0.5), 0.35, z + rng.range(-hd * 0.5, hd * 0.5));
  if (floors > 1) {
    b.loot(x + rng.range(-hw * 0.4, hw * 0.4), fh + 0.55, z + rng.range(-hd * 0.4, hd * 0.4));
  }
}

function hashOf(x: number, z: number): number {
  return ((x * 73856093) ^ (z * 19349663)) >>> 0;
}

/** Flat ground plane with walkable platform registration. */
export function addGround(b: WorldBuilder, size: number, mat: MatKey, y = 0, registerPlatform = true): void {
  b.box(0, y - 1, 0, size + 200, 2, size + 200, mat, 0, { floor: registerPlatform });
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
    b.tree({ x, z, y, scale: rng.range(0.8, 1.5), variant });
    placed++;
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
  while (placed < count && attempts++ < count * 10) {
    const x = rng.range(area.minX, area.maxX);
    const z = rng.range(area.minZ, area.maxZ);
    if (avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
    b.rock(x, z, heightAt ? heightAt(x, z) : 0, rng.range(0.6, 2.4));
    placed++;
  }
}
