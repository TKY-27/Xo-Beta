/**
 * WorldBuilder: constructs map geometry records, walkable platform records,
 * loot/chest spawns and POIs. Renderer-independent.
 *
 * Colliders are built later from `def.geo` via buildColliders(); visuals are
 * built by the render pass consuming the same specs.
 */

import type { MapDef, MatKey, ChestSpawn, LootSpawn } from './types';
import { PhysicsWorld } from '../physics/physics';

export class WorldBuilder {
  readonly def: MapDef;

  constructor(id: string, name: string, description: string, size: number) {
    this.def = {
      id, name, description, size,
      sky: null as never,
      geo: [],
      destructibles: [],
      vehicles: [],
      trees: [],
      rocks: [],
      lamps: [],
      lights: [],
      water: [],
      chests: [],
      loot: [],
      pois: [],
      platforms: [],
      transportRoute: { from: [-size / 2 - 60, 0], to: [size / 2 + 60, 0] },
    };
  }

  // -- primitives ------------------------------------------------------------

  box(
    x: number, y: number, z: number, sx: number, sy: number, sz: number,
    mat: MatKey, yaw = 0,
    opts?: { noCollide?: boolean; hint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage'; floor?: boolean },
  ): void {
    this.def.geo.push({ kind: 'box', x, y, z, sx, sy, sz, yaw, mat, noCollide: opts?.noCollide, materialHint: opts?.hint });
    if (opts?.floor && !opts.noCollide) {
      this.platform(x - sx / 2, x + sx / 2, z - sz / 2, z + sz / 2, y + sy / 2);
    }
  }

  /** Floor slab: registers a walkable platform on its top surface. */
  slab(x: number, yTop: number, z: number, sx: number, sz: number, thickness: number, mat: MatKey): void {
    this.box(x, yTop - thickness / 2, z, sx, thickness, sz, mat, 0, { floor: true });
  }

  cyl(x: number, y: number, z: number, r: number, h: number, mat: MatKey, opts?: { segments?: number; noCollide?: boolean }): void {
    this.def.geo.push({ kind: 'cyl', x, y, z, r, h, mat, segments: opts?.segments, noCollide: opts?.noCollide });
  }

  sphere(x: number, y: number, z: number, r: number, mat: MatKey, opts?: { noCollide?: boolean }): void {
    this.def.geo.push({ kind: 'sphere', x, y, z, r, mat, noCollide: opts?.noCollide });
  }

  platform(minX: number, maxX: number, minZ: number, maxZ: number, y: number, water = false): void {
    this.def.platforms.push({ minX, maxX, minZ, maxZ, y, water });
  }

  // -- composite helpers -----------------------------------------------------

  /**
   * Wall along X or Z with optional door/window gaps.
   * gaps: [startOffset, width][] measured along wall axis from wall start.
   */
  wallWithGaps(
    x0: number, z0: number, length: number, height: number, thickness: number,
    axis: 'x' | 'z', mat: MatKey,
    gaps: Array<[number, number]> = [], sillHeight = 0,
    baseY = 0,
  ): void {
    const segs: Array<[number, number]> = [];
    let cursor = 0;
    const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
    for (const [start, width] of sorted) {
      if (start > cursor) segs.push([cursor, start - cursor]);
      cursor = start + width;
    }
    if (cursor < length) segs.push([cursor, length - cursor]);

    for (const [off, len] of segs) {
      if (len < 0.05) continue;
      if (axis === 'x') {
        this.box(x0 + off + len / 2, baseY + sillHeight + height / 2, z0, len, height, thickness, mat);
      } else {
        this.box(x0, baseY + sillHeight + height / 2, z0 + off + len / 2, thickness, height, len, mat);
      }
    }
    if (sillHeight > 0.05) {
      for (const [start, width] of sorted) {
        if (axis === 'x') {
          this.box(x0 + start + width / 2, baseY + sillHeight / 2, z0, width, sillHeight, thickness, mat);
        } else {
          this.box(x0, baseY + sillHeight / 2, z0 + start + width / 2, thickness, sillHeight, width, mat);
        }
      }
    }
  }

  /** Straight staircase rising along dir (0:+z 1:+x 2:-z 3:-x) from baseY. */
  stairs(
    x: number, y: number, z: number,
    dir: 0 | 1 | 2 | 3, steps: number, stepH: number, stepD: number, width: number, mat: MatKey,
  ): void {
    for (let i = 0; i < steps; i++) {
      const h = stepH * (i + 1);
      const off = stepD * (i + 0.5);
      let cx = x, cz = z, sx = width, sz = stepD;
      if (dir === 0) cz = z + off;
      else if (dir === 1) { cx = x + off; sx = stepD; sz = width; }
      else if (dir === 2) cz = z - off;
      else { cx = x - off; sx = stepD; sz = width; }
      this.box(cx, y + h / 2, cz, sx, h, sz, mat);
      this.platform(cx - sx / 2, cx + sx / 2, cz - sz / 2, cz + sz / 2, y + h);
    }
  }

  crate(x: number, y: number, z: number, scale = 1, mat: MatKey = 'wood'): void {
    const s = 1.4 * scale;
    this.def.destructibles.push({
      hp: 30,
      type: 'crate',
      geo: { kind: 'box', x, y: y + s / 2, z, sx: s, sy: s, sz: s, yaw: 0, mat },
    });
  }

  glassPane(x: number, y: number, z: number, sx: number, sy: number, axis: 'x' | 'z'): void {
    this.def.destructibles.push({
      hp: 5,
      type: 'glass',
      geo: { kind: 'box', x, y, z, sx: axis === 'x' ? sx : 0.08, sy, sz: axis === 'z' ? sx : 0.08, yaw: 0, mat: 'glass', materialHint: 'glass' },
    });
  }

  lampPost(x: number, z: number, y: number, h: number, color: number, intensity = 2.2, range = 26): void {
    this.cyl(x, y + h / 2, z, 0.14, h, 'metalDark');
    this.box(x, y + h, z, 0.9, 0.18, 0.35, 'metalDark');
    this.def.lamps.push({ x, z, y: y + h - 0.15, h, color, intensity, range });
  }

  tree(spec: { x: number; z: number; y: number; scale: number; variant: 'pine' | 'oak' | 'palm' | 'dead' }): void {
    this.def.trees.push(spec);
  }

  rock(x: number, z: number, y: number, scale: number): void {
    this.def.rocks.push({ x, z, y, scale });
  }

  vehicle(x: number, z: number, y: number, yaw: number, variant: 'sedan' | 'van' | 'truck' | 'wrecked', color: number): void {
    this.def.vehicles.push({ x, z, y, yaw, variant, color, explodable: true });
  }

  chest(x: number, y: number, z: number, kind: ChestSpawn['kind']): void {
    this.def.chests.push({ x, y, z, kind });
  }

  loot(x: number, y: number, z: number, bias?: LootSpawn['bias']): void {
    this.def.loot.push({ x, y, z, bias });
  }

  poi(name: string, x: number, z: number, radius: number): void {
    this.def.pois.push({ name, x, z, radius });
  }

  light(x: number, y: number, z: number, color: number, intensity: number, range: number): void {
    this.def.lights.push({ x, y, z, color, intensity, range });
  }

  water(minX: number, maxX: number, minZ: number, maxZ: number, surfaceY: number, depth: number): void {
    this.def.water.push({ minX, maxX, minZ, maxZ, surfaceY, depth });
    this.platform(minX, maxX, minZ, maxZ, surfaceY, true);
  }

  finish(sky: MapDef['sky'], transportRoute: MapDef['transportRoute']): MapDef {
    this.def.sky = sky;
    this.def.transportRoute = transportRoute;
    return this.def;
  }
}

// ---------------------------------------------------------------------------
// Collider construction
// ---------------------------------------------------------------------------

interface HeightfieldExt {
  heightfield?: { n: number; heights: Float32Array };
}

/** Build ALL static colliders for a MapDef (geometry + heightfield) into a PhysicsWorld. */
export function buildColliders(def: MapDef, phys: PhysicsWorld): void {
  for (const g of def.geo) {
    if (g.kind === 'box') {
      if (g.noCollide) continue;
      let ex = g.sx, ez = g.sz;
      if (g.yaw !== 0) {
        const c = Math.abs(Math.cos(g.yaw)), s = Math.abs(Math.sin(g.yaw));
        ex = g.sx * c + g.sz * s;
        ez = g.sx * s + g.sz * c;
      }
      phys.addStaticBox(g.x, g.y, g.z, ex / 2, g.sy / 2, ez / 2, g.yaw, g.materialHint ?? matToHint(g.mat));
    } else if (g.kind === 'cyl') {
      if (g.noCollide) continue;
      phys.addStaticBox(g.x, g.y, g.z, g.r * 0.85, g.h / 2, g.r * 0.85, 0, g.materialHint ?? matToHint(g.mat));
    } else if (g.kind === 'sphere') {
      if (g.noCollide) continue;
      phys.addStaticBox(g.x, g.y, g.z, g.r * 0.7, g.r * 0.7, g.r * 0.7, 0, g.materialHint ?? matToHint(g.mat));
    }
  }
  const hf = (def as MapDef & HeightfieldExt).heightfield;
  if (hf) {
    phys.addHeightfield(-def.size / 2, -def.size / 2, def.size / 2, def.size / 2, hf.heights, hf.n, hf.n, 'dirt');
  }
}

export function matToHint(mat: MatKey): 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage' {
  switch (mat) {
    case 'metal': case 'metalDark': case 'rust': case 'corrugated': return 'metal';
    case 'wood': case 'woodDark': return 'wood';
    case 'glass': return 'glass';
    case 'grass': case 'dirt': return 'dirt';
    default: return 'stone';
  }
}
