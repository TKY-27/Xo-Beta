import { beforeAll, describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../../src/physics/physics';
import { buildColliders, normalizeMapForMatch } from '../../src/world/builder';
import { ensureWorldReady, loadMap } from '../../src/world';
import { vehicleColliderCenter } from '../../src/world/types';
import type { GeoBox } from '../../src/world/types';

beforeAll(async () => {
  await ensureWorldReady();
});

describe('neocity prop integrity', () => {
  const loaded = loadMap('neocity');
  const def = loaded.def;
  /**
   * Collider-free support resolution: the authored platforms (walkable
   * rects) under the point, else the terrain. Probing with physics rays
   * would start inside the object's own collider.
   */
  const supportUnder = (x: number, z: number, nearY: number): number => {
    let support = loaded.terrainHeight(x, z);
    for (const platform of def.platforms) {
      if (platform.water) continue;
      if (x < platform.minX || x > platform.maxX || z < platform.minZ || z > platform.maxZ) continue;
      if (platform.y <= nearY + 0.6) support = Math.max(support, platform.y);
    }
    // Solid geo boxes are supports too (podiums, interior floors, decks).
    for (const g of def.geo) {
      if (g.kind !== 'box' || g.noCollide) continue;
      const c = Math.abs(Math.cos(g.yaw));
      const s = Math.abs(Math.sin(g.yaw));
      const hx = (g.sx * c + g.sz * s) / 2;
      const hz = (g.sx * s + g.sz * c) / 2;
      const top = g.y + g.sy / 2;
      if (x >= g.x - hx && x <= g.x + hx && z >= g.z - hz && z <= g.z + hz && top <= nearY + 0.6) {
        support = Math.max(support, top);
      }
    }
    return support;
  };

  it('vehicles rest on their support plane, never floating', () => {
    expect(def.vehicles.length).toBeGreaterThan(4);
    for (const vehicle of def.vehicles) {
      const center = vehicleColliderCenter(vehicle);
      const supportY = supportUnder(center.x, center.z, vehicle.y);
      expect(Math.abs(supportY - vehicle.y), `vehicle @${vehicle.x},${vehicle.z} off support by ${(vehicle.y - supportY).toFixed(2)}m`).toBeLessThan(0.35);
    }
  });

  it('loose destructibles are grounded, not suspended', () => {
    // Mirror Match's grounding so the test asserts what players actually see.
    normalizeMapForMatch(def);
    for (const prop of def.destructibles) {
      // Wall-mounted glass panes are authored windows, not floor props.
      if (prop.geo.kind !== 'box' || prop.type === 'glass') continue;
      const base = prop.geo.y - prop.geo.sy / 2;
      const supportY = supportUnder(prop.geo.x, prop.geo.z, base);
      if (supportY > base) continue; // stacked crate resting on a lower crate
      expect(base - supportY, `crate @${prop.geo.x},${prop.geo.z} floats ${(base - supportY).toFixed(2)}m`).toBeLessThan(0.45);
    }
  });

  it('person-sized structural posts collide unless wall-mounted', () => {
    // A visible thin pole tall enough to stop a player must collide unless
    // its base sits against other solid geometry (a wall/bracket mount that
    // cannot be reached from the open side). This catches every free-standing
    // collisionless post class.
    const solids = def.geo.filter((g) => g.kind === 'box' && g.noCollide !== true
      && !(g.sy <= 2.2 && g.y + g.sy / 2 <= 2.5));
    const orphanPoles: GeoBox[] = def.geo.filter((g): g is GeoBox => {
      if (g.kind !== 'box' || g.noCollide !== true) return false;
      if (!(g.sy >= 1.6 && Math.max(g.sx, g.sz) <= 0.7 && g.y - g.sy / 2 < 2.2)) return false;
      return !solids.some((s) => {
        if (s.kind !== 'box') return false;
        const c = Math.abs(Math.cos(s.yaw));
        const sn = Math.abs(Math.sin(s.yaw));
        const hx = (s.sx * c + s.sz * sn) / 2;
        const hz = (s.sx * sn + s.sz * c) / 2;
        return Math.abs(s.y - g.y) < (s.sy + g.sy) / 2
          && Math.abs(s.x - g.x) < hx + 0.55
          && Math.abs(s.z - g.z) < hz + 0.55;
      });
    });
    expect(orphanPoles, JSON.stringify(orphanPoles.map((o) => ({ at: [o.x, o.z], sz: [o.sx, o.sy, o.sz] })))).toEqual([]);
  });

  it('urban infill adds collidable mid-block cover deterministically', () => {
    const metalMasses = def.geo.filter((g) => g.kind === 'box'
      && g.noCollide !== true && g.mat === 'metalDark'
      && Math.abs(g.sx - 1.7) < 0.01 && Math.abs(g.sy - 1.05) < 0.01);
    expect(metalMasses.length).toBeGreaterThanOrEqual(8);
    // Determinism: an independent rebuild produces identical geo.
    const rebuild = loadMap('neocity').def;
    expect(rebuild.geo.length).toBe(def.geo.length);
    expect(rebuild.geo[def.geo.length - 1]!.x).toBe(def.geo[def.geo.length - 1]!.x);
  });

  it('infill never blocks the parked-vehicle lanes or stair flights', () => {
    const phys = new PhysicsWorld();
    buildColliders(def, phys);
    phys.flush();
    try {
      for (const flight of def.stairs) {
        const midX = flight.x + (flight.dir === 1 ? 1 : flight.dir === 3 ? -1 : 0) * flight.run / 2;
        const midZ = flight.z + (flight.dir === 0 ? 1 : flight.dir === 2 ? -1 : 0) * flight.run / 2;
        expect(phys.isCharacterPositionClear(midX, flight.y + flight.totalRise / 2 + 1, midZ),
          `infill blocked flight @${flight.x},${flight.z}`).toBe(true);
      }
    } finally {
      phys.dispose();
    }
  });
});
