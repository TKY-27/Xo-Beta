import { describe, expect, it } from 'vitest';
import { loadMap, type MapId } from '../../src/world';
import type { GeoBox } from '../../src/world/types';

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
 *  - identical material + footprint + orientation is exempt (both candidates
 *    shade identically, so depth order cannot change a pixel);
 *  - a seam fully buried inside a third box's body is exempt (occluded).
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
          fights.push({
            a: { at: [a.x, a.z], top: +top.toFixed(3), dims: [a.sx, a.sy, a.sz], mat: a.mat },
            b: { at: [b.x, b.z], top: +tops[j]!.toFixed(3), dims: [b.sx, b.sy, b.sz], mat: b.mat },
            overlap: [+ox.toFixed(2), +oz.toFixed(2)],
          });
        }
      }
      expect(fights, JSON.stringify(fights.slice(0, 6))).toEqual([]);
    });
  }
});
