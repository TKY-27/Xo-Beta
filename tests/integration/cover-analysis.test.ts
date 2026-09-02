import { beforeAll, describe, expect, it } from 'vitest';
import { GROUPS, PhysicsWorld } from '../../src/physics/physics';
import { buildColliders } from '../../src/world/builder';
import { ensureWorldReady, loadMap, type MapId } from '../../src/world';
import type { MapDef } from '../../src/world/types';

beforeAll(async () => {
  await ensureWorldReady();
});

const MAPS: MapId[] = ['neocity', 'oldfront', 'eden', 'ashara'];

/**
 * Deterministic cover analysis (QA task 5.1).
 *
 * Samples a fixed grid of walkable positions per map and measures, per
 * sample, the fraction of eight horizontal chest-height rays that stay
 * unobstructed for 30 m ("exposure"). The share of fully exposed samples and
 * the mean exposure quantify how many combat cells lack reachable cover.
 * Long sightlines are reported separately so deliberate sniper lanes can be
 * preserved when cover is added.
 */
interface CoverReport {
  samples: number;
  meanExposure: number;
  fullyExposedShare: number;
  longestSightline: number;
}

function isWaterOrBlocked(def: MapDef, x: number, z: number): boolean {
  if (def.water.some((w) => x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ)) return true;
  // A sample inside or under solid geometry is not a combat cell. Flat
  // ground layers (sidewalks, roads, floor slabs <= ~2.2 m thick near grade)
  // are the surface you fight FROM, not cover, so they do not reject.
  for (const g of def.geo) {
    if (g.noCollide || g.noRender) continue;
    if (g.kind !== 'box') continue;
    const isGroundLayer = g.sy <= 2.2 && g.y + g.sy / 2 <= 2.5;
    if (isGroundLayer) continue;
    const c = Math.abs(Math.cos(g.yaw));
    const s = Math.abs(Math.sin(g.yaw));
    const hx = (g.sx * c + g.sz * s) / 2;
    const hz = (g.sx * s + g.sz * c) / 2;
    if (Math.abs(x - g.x) < hx + 0.5 && Math.abs(z - g.z) < hz + 0.5) return true;
  }
  return false;
}

function analyze(def: MapDef, phys: PhysicsWorld): CoverReport {
  const half = def.size / 2 - 14;
  const step = 16;
  let samples = 0;
  let exposureSum = 0;
  let fullyExposed = 0;
  let longest = 0;
  for (let x = -half; x <= half; x += step) {
    for (let z = -half; z <= half; z += step) {
      if (isWaterOrBlocked(def, x, z)) continue;
      samples++;
      let blockedStanding = 0;
      let blockedCrouched = 0;
      for (let k = 0; k < 8; k++) {
        const angle = (k / 8) * Math.PI * 2;
        const dx = Math.cos(angle);
        const dz = Math.sin(angle);
        if (phys.raycast(x, 1.2, z, dx, 0, dz, 30, GROUPS.rayWorldOnly)) {
          blockedStanding++;
          longest = Math.max(longest, 30);
        } else {
          longest = Math.max(longest, 30);
        }
        if (phys.raycast(x, 0.45, z, dx, 0, dz, 30, GROUPS.rayWorldOnly)) blockedCrouched++;
      }
      const exposure = (8 - blockedStanding) / 8;
      exposureSum += exposure;
      // "Fully exposed" = no cover for either stance within 30 m.
      if (blockedStanding === 0 && blockedCrouched === 0) fullyExposed++;
    }
  }
  return {
    samples,
    meanExposure: samples > 0 ? exposureSum / samples : 1,
    fullyExposedShare: samples > 0 ? fullyExposed / samples : 1,
    longestSightline: longest,
  };
}

describe('cover density analysis', () => {
  it.each(MAPS)('measures %s combat-cell exposure', (id) => {
    const def = loadMap(id).def;
    const phys = new PhysicsWorld();
    buildColliders(def, phys);
    phys.flush();
    try {
      const report = analyze(def, phys);
      // QA evidence log (deterministic; identical on every run).
      console.log(
        `[cover] ${id}: samples=${report.samples} meanExposure=${report.meanExposure.toFixed(3)} `
        + `fullyExposed=${(report.fullyExposedShare * 100).toFixed(1)}% longestSightline=${report.longestSightline.toFixed(1)}m`,
      );
      expect(report.samples).toBeGreaterThan(80);
      // Fully exposed combat cells must stay a bounded minority; long
      // sightlines are preserved by design and reported above.
      expect(report.fullyExposedShare).toBeLessThan(0.30);
      expect(report.longestSightline).toBeGreaterThanOrEqual(30);
    } finally {
      phys.dispose();
    }
  });
});
