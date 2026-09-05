import { describe, expect, it } from 'vitest';
import { loadMap, type MapId } from '../../src/world';
import type { GeoBox, GeoCylinder, GeoSphere } from '../../src/world/types';

/**
 * Z-fighting regression guard.
 *
 * Two rendered boxes whose top faces share a plane and overlap on the ground
 * plane flicker wherever the shared height sits inside depth precision —
 * the dominant artifact class in v0.4 (road-grid crossings, container tops,
 * platform seams). Authoring rules enforced here:
 *
 *  - no two visible boxes may share a coplanar top over a >30 cm x >30 cm
 *    ground overlap;
 *  - the same rule applies to vertical cylinders and spheres (tops are
 *    y + h/2 and y + r) and to cyl/sphere × box pairs, over a >30 cm
 *    radial/penetration overlap;
 *  - identical material + footprint + orientation is exempt (both candidates
 *    shade identically, so depth order cannot change a pixel);
 *  - a seam fully buried inside a third shape's body is exempt (occluded);
 *  - seams inside a stair flight's swept envelope are exempt: flights meet
 *    their surrounding floors by construction and the stair-traversal
 *    movement harness pins those heights — nudge nothing there.
 */

interface OBB {
  x: number; z: number; yaw: number; hx: number; hz: number;
}

const EPS_TOP = 1e-3;
const MIN_OVERLAP = 0.3;

function obb(g: { x: number; z: number; sx: number; sz: number; yaw: number }): OBB {
  const c = Math.abs(Math.cos(g.yaw));
  const s = Math.abs(Math.sin(g.yaw));
  return { x: g.x, z: g.z, yaw: g.yaw, hx: (g.sx * c + g.sz * s) / 2, hz: (g.sx * s + g.sz * c) / 2 };
}

/** True per-axis overlap extent, clamped so containment reports the inner box. */
function overlap(a: OBB, b: OBB): [number, number] {
  const ox = Math.min(a.hx + b.hx - Math.abs(a.x - b.x), 2 * a.hx, 2 * b.hx);
  const oz = Math.min(a.hz + b.hz - Math.abs(a.z - b.z), 2 * a.hz, 2 * b.hz);
  return [Math.max(0, ox), Math.max(0, oz)];
}

/** Penetration depth of a disc (centre + radius) into an oriented box. */
function discBoxPenetration(cx: number, cz: number, r: number, box: OBB): number {
  const cos = Math.cos(-box.yaw);
  const sin = Math.sin(-box.yaw);
  const dx = cx - box.x;
  const dz = cz - box.z;
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const qx = Math.max(-box.hx, Math.min(box.hx, lx));
  const qz = Math.max(-box.hz, Math.min(box.hz, lz));
  return r - Math.hypot(lx - qx, lz - qz);
}

/**
 * Stair flights and their landings interface with surrounding floors by
 * construction — treads meet street level and platform slabs exactly, and
 * the stair-traversal movement harness pins those heights. Seams inside a
 * flight's swept envelope are movement-critical and exempt here.
 */
function nearStairFlight(def: { stairs: Array<{ x: number; z: number; dir: number; run: number; width: number }> }, a: OBB, b: OBB): boolean {
  for (const flight of def.stairs) {
    let minX = flight.x - flight.width / 2;
    let maxX = flight.x + flight.width / 2;
    let minZ = flight.z - flight.width / 2;
    let maxZ = flight.z + flight.width / 2;
    if (flight.dir === 0) maxZ += flight.run;
    else if (flight.dir === 1) maxX += flight.run;
    else if (flight.dir === 2) minZ -= flight.run;
    else minX -= flight.run;
    const pad = 1;
    minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
    for (const o of [a, b]) {
      if (o.x + o.hx > minX && o.x - o.hx < maxX && o.z + o.hz > minZ && o.z - o.hz < maxZ) return true;
    }
  }
  return false;
}

describe('no visible coplanar box tops (z-fighting guard)', () => {
  for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
    it(`${id} has no flickering coplanar surface pairs`, () => {
      const { def } = loadMap(id);
      const boxes = def.geo.filter((g): g is GeoBox => g.kind === 'box' && !g.noRender);
      const obbs = boxes.map(obb);
      const tops = boxes.map((g) => g.y + g.sy / 2);
      const fights: object[] = [];

      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          if (Math.abs(tops[i]! - tops[j]!) > EPS_TOP) continue;
          const a = boxes[i]!;
          const b = boxes[j]!;
          const [ox, oz] = overlap(obbs[i]!, obbs[j]!);
          if (ox <= MIN_OVERLAP || oz <= MIN_OVERLAP) continue;
          // Identical shading on both candidates: depth order is invisible.
          if (a.mat === b.mat
            && Math.abs(a.sx - b.sx) < 1e-3 && Math.abs(a.sz - b.sz) < 1e-3
            && Math.abs(a.yaw - b.yaw) < 1e-3) continue;
          // Occluded seam: a third box containing the overlap region whose
          // body spans the coplanar plane hides the fight entirely.
          const A = obbs[i]!;
          const B = obbs[j]!;
          const seamX = (Math.max(A.x - A.hx, B.x - B.hx) + Math.min(A.x + A.hx, B.x + B.hx)) / 2;
          const seamZ = (Math.max(A.z - A.hz, B.z - B.hz) + Math.min(A.z + A.hz, B.z + B.hz)) / 2;
          const top = tops[i]!;
          const occluded = boxes.some((c, k) => {
            if (k === i || k === j) return false;
            const C = obbs[k]!;
            return tops[k]! > top + 0.05
              && tops[k]! - boxes[k]!.sy < top - 0.05
              && Math.abs(seamX - C.x) <= C.hx
              && Math.abs(seamZ - C.z) <= C.hz;
          });
          if (occluded) continue;
          if (nearStairFlight(def, A, B)) continue;
          fights.push({
            a: { at: [a.x, a.z], top: +top.toFixed(3), dims: [a.sx, a.sy, a.sz], mat: a.mat },
            b: { at: [b.x, b.z], top: +tops[j]!.toFixed(3), dims: [b.sx, b.sy, b.sz], mat: b.mat },
            overlap: [+ox.toFixed(2), +oz.toFixed(2)],
          });
        }
      }
      expect(fights, JSON.stringify(fights.slice(0, 6))).toEqual([]);
    });

    it(`${id} has no coplanar tops between round shapes and boxes`, () => {
      const { def } = loadMap(id);
      const cyls = def.geo.filter((g): g is GeoCylinder =>
        g.kind === 'cyl' && !g.noRender && !g.pitch && !g.roll);
      const spheres = def.geo.filter((g): g is GeoSphere => g.kind === 'sphere' && !g.noRender);
      const boxes = def.geo.filter((g): g is GeoBox => g.kind === 'box' && !g.noRender);
      const boxObbs = boxes.map(obb);

      interface Round {
        x: number; z: number; top: number; bottom: number; r: number; mat: string;
        label: string;
      }
      const rounds: Round[] = [
        ...cyls.map((c) => ({
          x: c.x, z: c.z, top: c.y + c.h / 2, bottom: c.y - c.h / 2, r: c.r, mat: c.mat,
          label: `cyl@(${c.x.toFixed(1)},${c.z.toFixed(1)})`,
        })),
        ...spheres.map((s) => ({
          x: s.x, z: s.z, top: s.y + s.r, bottom: s.y - s.r, r: s.r, mat: s.mat,
          label: `sphere@(${s.x.toFixed(1)},${s.z.toFixed(1)})`,
        })),
      ];
      const fights: object[] = [];

      const radialOverlap = (a: Round, b: Round): number =>
        (a.r + b.r) - Math.hypot(a.x - b.x, a.z - b.z);

      const seamOccluded = (seamX: number, seamZ: number, top: number, skipA: object, skipB: object): boolean => {
        // Third box rising through the seam?
        const boxHides = boxes.some((c, k) => {
          if (skipA === c || skipB === c) return false;
          const C = boxObbs[k]!;
          return c.y + c.sy / 2 > top + 0.05
            && c.y - c.sy / 2 < top - 0.05
            && Math.abs(seamX - C.x) <= C.hx
            && Math.abs(seamZ - C.z) <= C.hz;
        });
        if (boxHides) return true;
        // Third round shape enveloping the seam?
        return rounds.some((c) => {
          if (c === skipA || c === skipB) return false;
          return c.top > top + 0.05
            && c.bottom < top - 0.05
            && Math.hypot(seamX - c.x, seamZ - c.z) <= c.r;
        });
      };

      for (let i = 0; i < rounds.length; i++) {
        const a = rounds[i]!;
        // Round vs box tops
        for (let k = 0; k < boxes.length; k++) {
          const box = boxes[k]!;
          if (Math.abs(a.top - (box.y + box.sy / 2)) > EPS_TOP) continue;
          const B = boxObbs[k]!;
          const pen = discBoxPenetration(a.x, a.z, a.r, B);
          if (pen <= MIN_OVERLAP) continue;
          if (a.mat === box.mat
            && Math.abs(2 * a.r - box.sx) < 1e-3
            && Math.abs(2 * a.r - box.sz) < 1e-3) continue;
          fights.push({
            a: { label: a.label, top: +a.top.toFixed(3), mat: a.mat },
            b: { at: [box.x, box.z], top: +(box.y + box.sy / 2).toFixed(3), mat: box.mat },
            penetration: +pen.toFixed(2),
          });
        }
        // Round vs round tops
        for (let j = i + 1; j < rounds.length; j++) {
          const b = rounds[j]!;
          if (Math.abs(a.top - b.top) > EPS_TOP) continue;
          const ov = radialOverlap(a, b);
          if (ov <= MIN_OVERLAP) continue;
          if (a.mat === b.mat && Math.abs(a.r - b.r) < 1e-3) continue;
          const seamX = (Math.max(a.x - a.r, b.x - b.r) + Math.min(a.x + a.r, b.x + b.r)) / 2;
          const seamZ = (Math.max(a.z - a.r, b.z - b.r) + Math.min(a.z + a.r, b.z + b.r)) / 2;
          if (seamOccluded(seamX, seamZ, a.top, a, b)) continue;
          fights.push({
            a: { label: a.label, top: +a.top.toFixed(3), mat: a.mat },
            b: { label: b.label, top: +b.top.toFixed(3), mat: b.mat },
            overlap: +ov.toFixed(2),
          });
        }
      }
      expect(fights, JSON.stringify(fights.slice(0, 6))).toEqual([]);
    });
  }
});
