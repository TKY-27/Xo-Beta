/**
 * WorldBuilder: constructs map geometry records, walkable platform records,
 * loot/chest spawns and POIs. Renderer-independent.
 *
 * Colliders are built later from `def.geo` via buildColliders(); visuals are
 * built by the render pass consuming the same specs.
 */

import { vehicleColliderBox, type MapDef, type MatKey, type ChestSpawn, type LootSpawn } from './types';
import { GROUPS, PhysicsWorld } from '../physics/physics';

/** Human-scale stair limits shared by every authored map. */
export const STAIR_MAX_RISE = 0.34;
export const STAIR_MIN_TREAD = 0.78;
export const STAIR_MIN_WIDTH = 2.2;
export const TREE_MIN_SPACING = 4.5;

export interface StairPlan {
  steps: number;
  /** Signed rise per tread. Negative values describe a descending run. */
  stepH: number;
  stepD: number;
  width: number;
  totalRise: number;
  run: number;
}

const CHEST_SUPPORT_PROBE_ABOVE = 0.75;
const CHEST_SUPPORT_MAX_DROP = 1.5;
const CHEST_SUPPORT_TOLERANCE = 0.75;
const PROP_SUPPORT_TOLERANCE = 0.65;

/**
 * Normalize authored stairs without changing their requested total elevation.
 * The old maps allowed 0.55-0.60 m risers and 0.60 m treads, right at the
 * character-controller limit. Resampling the whole run keeps landings at the
 * same height while giving the controller and camera a stable safety margin.
 */
export function planStairs(steps: number, stepH: number, stepD: number, width: number): StairPlan {
  if (!Number.isFinite(steps) || !Number.isFinite(stepH) || steps <= 0 || Math.abs(stepH) < 1e-4) {
    throw new Error('stairs require a positive step count and non-zero finite rise');
  }
  const requestedSteps = Math.max(1, Math.round(steps));
  const totalRise = requestedSteps * stepH;
  const safeSteps = Math.max(requestedSteps, Math.ceil(Math.abs(totalRise) / STAIR_MAX_RISE));
  const safeStepH = totalRise / safeSteps;
  const safeStepD = Math.max(STAIR_MIN_TREAD, Number.isFinite(stepD) ? stepD : 0);
  const safeWidth = Math.max(STAIR_MIN_WIDTH, Number.isFinite(width) ? width : 0);
  return {
    steps: safeSteps,
    stepH: safeStepH,
    stepD: safeStepD,
    width: safeWidth,
    totalRise,
    run: safeSteps * safeStepD,
  };
}

/**
 * Snap authored chest bases to a nearby physical support surface. Chests with
 * stale coordinates are rejected instead of being left suspended in space or
 * teleported onto an unrelated roof several metres away.
 */
export function resolveSupportedChests(def: MapDef, phys: PhysicsWorld): ChestSpawn[] {
  const half = def.size / 2 - 2;
  const resolved: ChestSpawn[] = [];
  for (const chest of def.chests) {
    if (![chest.x, chest.y, chest.z].every(Number.isFinite)) continue;
    if (Math.abs(chest.x) > half || Math.abs(chest.z) > half) continue;
    const hit = phys.raycast(
      chest.x,
      chest.y + CHEST_SUPPORT_PROBE_ABOVE,
      chest.z,
      0,
      -1,
      0,
      CHEST_SUPPORT_MAX_DROP,
      GROUPS.rayWorldOnly,
    );
    // A zero-distance ray starts inside a wall/prop rather than above a floor.
    // A steep normal is likewise not a usable support plane.
    if (!hit || hit.dist < 0.05 || hit.normal.y < 0.65) continue;
    if (Math.abs(hit.point.y - chest.y) > CHEST_SUPPORT_TOLERANCE) continue;
    resolved.push({ ...chest, y: hit.point.y });
  }
  return resolved;
}

/**
 * Ground crate bases against the completed world before their own colliders
 * exist. Map call sites historically added an arbitrary +0.2/+0.35 m to the
 * support height, leaving every loose crate visibly suspended. Shifting the
 * centre by the measured base error preserves elevated/indoor crates too.
 */
export function groundCrates(def: MapDef, phys: PhysicsWorld): void {
  for (const prop of def.destructibles) {
    if (prop.type !== 'crate' || prop.geo.kind !== 'box') continue;
    const geo = prop.geo;
    const baseY = geo.y - geo.sy / 2;
    // Probe from above the whole prop. Starting only 0.55 m above a stale
    // analytic base can begin below a steep interpolated bank and incorrectly
    // snap to a buried surface underneath the visible ground.
    const probeAbove = geo.sy + 0.65;
    const highHit = phys.raycast(geo.x, baseY + probeAbove, geo.z, 0, -1, 0,
      probeAbove + 0.75, GROUPS.rayWorldOnly);
    const highError = highHit ? highHit.point.y - baseY : Infinity;
    if (highHit && highHit.dist >= 0.05 && highHit.normal.y >= 0.65
      && Math.abs(highError) <= PROP_SUPPORT_TOLERANCE + 0.55) {
      geo.y += highError;
      continue;
    }

    // A stair/awning can be the first high probe hit even though it is not the
    // crate's support. Fall back to the local ground around the authored base.
    const nearHit = phys.raycast(geo.x, baseY + 0.6, geo.z, 0, -1, 0, 1.25, GROUPS.rayWorldOnly);
    if (!nearHit || nearHit.dist < 0.05 || nearHit.normal.y < 0.65) continue;
    const nearError = nearHit.point.y - baseY;
    if (Math.abs(nearError) <= PROP_SUPPORT_TOLERANCE) geo.y += nearError;
  }
}

/** Reject a grounded crate that still intersects a wall, roof or other solid. */
export function isCratePlacementClear(def: MapDef, prop: MapDef['destructibles'][number]): boolean {
  if (prop.type !== 'crate' || prop.geo.kind !== 'box') return true;
  const crate = prop.geo;
  const minY = crate.y - crate.sy / 2 + 0.04;
  const maxY = crate.y + crate.sy / 2;
  const overlapsY = (lo: number, hi: number) => hi > minY && lo < maxY;
  for (const geo of def.geo) {
    if (geo.kind === 'box') {
      const c = Math.abs(Math.cos(geo.yaw));
      const s = Math.abs(Math.sin(geo.yaw));
      const hx = (geo.sx * c + geo.sz * s) / 2;
      const hz = (geo.sx * s + geo.sz * c) / 2;
      if (Math.abs(crate.x - geo.x) < crate.sx / 2 + hx
        && Math.abs(crate.z - geo.z) < crate.sz / 2 + hz
        && overlapsY(geo.y - geo.sy / 2, geo.y + geo.sy / 2)) return false;
    } else if (geo.kind === 'cyl') {
      if (Math.hypot(crate.x - geo.x, crate.z - geo.z) < Math.max(crate.sx, crate.sz) / 2 + geo.r
        && overlapsY(geo.y - geo.h / 2, geo.y + geo.h / 2)) return false;
    } else if (Math.hypot(crate.x - geo.x, crate.z - geo.z) < Math.max(crate.sx, crate.sz) / 2 + geo.r
      && overlapsY(geo.y - geo.r, geo.y + geo.r)) return false;
  }
  return true;
}

export function filterInvalidCrates(def: MapDef): void {
  def.destructibles = def.destructibles.filter((prop) => isCratePlacementClear(def, prop));
}

/** A street fixture may touch its support but must not grow through solids. */
export function isLampPlacementClear(def: MapDef, lamp: MapDef['lamps'][number]): boolean {
  const minY = lamp.y + 0.05;
  const maxY = lamp.y + lamp.h;
  const overlapsY = (lo: number, hi: number) => hi > minY && lo < maxY;
  for (const geo of def.geo) {
    if (geo.noRender) continue; // its own collision proxy
    if (geo.kind === 'box') {
      const c = Math.abs(Math.cos(geo.yaw));
      const s = Math.abs(Math.sin(geo.yaw));
      const hx = (geo.sx * c + geo.sz * s) / 2;
      const hz = (geo.sx * s + geo.sz * c) / 2;
      if (Math.abs(lamp.x - geo.x) < hx + 0.18
        && Math.abs(lamp.z - geo.z) < hz + 0.18
        && overlapsY(geo.y - geo.sy / 2, geo.y + geo.sy / 2)) return false;
    } else if (geo.kind === 'cyl') {
      if (Math.hypot(lamp.x - geo.x, lamp.z - geo.z) < geo.r + 0.18
        && overlapsY(geo.y - geo.h / 2, geo.y + geo.h / 2)) return false;
    } else if (Math.hypot(lamp.x - geo.x, lamp.z - geo.z) < geo.r + 0.18
      && overlapsY(geo.y - geo.r, geo.y + geo.r)) return false;
  }
  return true;
}

/** True when the chest volume does not overlap authored solid geometry. */
export function isChestPlacementClear(def: MapDef, chest: ChestSpawn): boolean {
  const minY = chest.y + 0.04;
  const maxY = chest.y + 0.8;
  const overlapsY = (lo: number, hi: number) => hi > minY && lo < maxY;

  for (const g of def.geo) {
    if (g.noCollide) continue;
    if (g.kind === 'box') {
      const c = Math.abs(Math.cos(g.yaw));
      const s = Math.abs(Math.sin(g.yaw));
      const hx = (g.sx * c + g.sz * s) / 2;
      const hz = (g.sx * s + g.sz * c) / 2;
      if (Math.abs(chest.x - g.x) < hx + 0.55
        && Math.abs(chest.z - g.z) < hz + 0.38
        && overlapsY(g.y - g.sy / 2, g.y + g.sy / 2)) return false;
    } else if (g.kind === 'cyl') {
      if (Math.hypot(chest.x - g.x, chest.z - g.z) < g.r + 0.55
        && overlapsY(g.y - g.h / 2, g.y + g.h / 2)) return false;
    } else if (Math.hypot(chest.x - g.x, chest.z - g.z) < g.r + 0.55
      && overlapsY(g.y - g.r, g.y + g.r)) return false;
  }
  for (const d of def.destructibles) {
    const g = d.geo;
    const radius = g.kind === 'box' ? Math.hypot(g.sx, g.sz) / 2 : g.r;
    const lo = g.kind === 'box' ? g.y - g.sy / 2 : g.kind === 'cyl' ? g.y - g.h / 2 : g.y - g.r;
    const hi = g.kind === 'box' ? g.y + g.sy / 2 : g.kind === 'cyl' ? g.y + g.h / 2 : g.y + g.r;
    if (Math.hypot(chest.x - g.x, chest.z - g.z) < radius + 0.55 && overlapsY(lo, hi)) return false;
  }
  for (const tree of def.trees) {
    if (Math.hypot(chest.x - tree.x, chest.z - tree.z) < 0.26 * tree.scale + 0.55
      && overlapsY(tree.y, tree.y + 2.5 * tree.scale)) return false;
  }
  for (const rock of def.rocks) {
    if (Math.hypot(chest.x - rock.x, chest.z - rock.z) < 0.7 * rock.scale + 0.55
      && overlapsY(rock.y, rock.y + 0.9 * rock.scale)) return false;
  }
  for (const vehicle of def.vehicles) {
    const box = vehicleColliderBox(vehicle.variant);
    if (Math.abs(chest.x - vehicle.x) < Math.max(box.ex, box.ez) + 0.55
      && Math.abs(chest.z - vehicle.z) < Math.max(box.ex, box.ez) + 0.38
      && overlapsY(vehicle.y - 0.1, vehicle.y + box.h - 0.1)) return false;
  }
  return true;
}

/** Keep trunks out of structures/water and prevent random overlapping crowns. */
export function isTreePlacementClear(def: MapDef, tree: MapDef['trees'][number]): boolean {
  if (![tree.x, tree.y, tree.z, tree.scale].every(Number.isFinite) || tree.scale <= 0) return false;
  for (const other of def.trees) {
    const spacing = Math.max(TREE_MIN_SPACING, 1.8 * (tree.scale + other.scale));
    if (Math.hypot(tree.x - other.x, tree.z - other.z) < spacing) return false;
  }
  if (def.water.some((water) => (
    tree.x > water.minX - 0.8 && tree.x < water.maxX + 0.8
    && tree.z > water.minZ - 0.8 && tree.z < water.maxZ + 0.8
  ))) return false;

  const trunkRadius = 0.26 * tree.scale + 0.45;
  const trunkMinY = tree.y + 0.01;
  const trunkMaxY = tree.y + 2.5 * tree.scale;
  const overlapsY = (lo: number, hi: number) => hi > trunkMinY && lo < trunkMaxY;
  for (const g of def.geo) {
    if (g.kind === 'box') {
      const c = Math.abs(Math.cos(g.yaw));
      const s = Math.abs(Math.sin(g.yaw));
      const hx = (g.sx * c + g.sz * s) / 2;
      const hz = (g.sx * s + g.sz * c) / 2;
      if (Math.abs(tree.x - g.x) < hx + trunkRadius
        && Math.abs(tree.z - g.z) < hz + trunkRadius
        && overlapsY(g.y - g.sy / 2, g.y + g.sy / 2)) return false;
    } else if (g.kind === 'cyl') {
      if (Math.hypot(tree.x - g.x, tree.z - g.z) < g.r + trunkRadius
        && overlapsY(g.y - g.h / 2, g.y + g.h / 2)) return false;
    } else if (Math.hypot(tree.x - g.x, tree.z - g.z) < g.r + trunkRadius
      && overlapsY(g.y - g.r, g.y + g.r)) return false;
  }
  for (const rock of def.rocks) {
    if (Math.hypot(tree.x - rock.x, tree.z - rock.z) < 0.7 * rock.scale + trunkRadius
      && overlapsY(rock.y, rock.y + 0.9 * rock.scale)) return false;
  }
  for (const vehicle of def.vehicles) {
    const box = vehicleColliderBox(vehicle.variant);
    if (Math.abs(tree.x - vehicle.x) < Math.max(box.ex, box.ez) + trunkRadius
      && Math.abs(tree.z - vehicle.z) < Math.max(box.ex, box.ez) + trunkRadius
      && overlapsY(vehicle.y - 0.1, vehicle.y + box.h - 0.1)) return false;
  }
  return true;
}

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
      // Starts outside the playable area and crosses the boundary exactly
      // 5 s in (130 m lead-in at the transport's 26 m/s cruise speed).
      transportRoute: { from: [-size / 2 - 130, 0], to: [size / 2 + 80, 0] },
    };
  }

  // -- primitives ------------------------------------------------------------

  box(
    x: number, y: number, z: number, sx: number, sy: number, sz: number,
    mat: MatKey, yaw = 0,
    opts?: {
      noCollide?: boolean;
      noRender?: boolean;
      hint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage';
      floor?: boolean;
    },
  ): void {
    this.def.geo.push({
      kind: 'box', x, y, z, sx, sy, sz, yaw, mat,
      noCollide: opts?.noCollide,
      noRender: opts?.noRender,
      materialHint: opts?.hint,
    });
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
    const sorted = gaps
      .map(([start, width]) => {
        const clampedStart = Math.max(0, Math.min(length, start));
        const clampedEnd = Math.max(clampedStart, Math.min(length, start + Math.max(0, width)));
        return [clampedStart, clampedEnd - clampedStart] as [number, number];
      })
      .filter(([, width]) => width >= 0.05)
      .sort((a, b) => a[0] - b[0]);
    for (const [start, width] of sorted) {
      if (start > cursor) segs.push([cursor, start - cursor]);
      cursor = Math.max(cursor, start + width);
    }
    if (cursor < length) segs.push([cursor, length - cursor]);

    for (const [off, len] of segs) {
      if (len < 0.05) continue;
      if (axis === 'x') {
        this.box(x0 + off + len / 2, baseY + height / 2, z0, len, height, thickness, mat);
      } else {
        this.box(x0, baseY + height / 2, z0 + off + len / 2, thickness, height, len, mat);
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

  /** Straight staircase along dir (0:+z 1:+x 2:-z 3:-x) from startY. */
  stairs(
    x: number, y: number, z: number,
    dir: 0 | 1 | 2 | 3, steps: number, stepH: number, stepD: number, width: number, mat: MatKey,
  ): StairPlan {
    const plan = planStairs(steps, stepH, stepD, width);
    const lowerY = y + Math.min(0, plan.totalRise);
    // A descending run ends exactly at `lowerY`. Give its final tread a real
    // slab thickness; using lowerY itself as every box bottom produced a
    // zero-height final collider and an unstable gap at the lower landing.
    const boxBottomY = plan.totalRise < 0 ? lowerY - 0.18 : lowerY;
    for (let i = 0; i < plan.steps; i++) {
      const topY = y + plan.stepH * (i + 1);
      const h = topY - boxBottomY;
      const off = plan.stepD * (i + 0.5);
      let cx = x, cz = z, sx = plan.width, sz = plan.stepD;
      if (dir === 0) cz = z + off;
      else if (dir === 1) cx = x + off;
      else if (dir === 2) cz = z - off;
      else cx = x - off;
      if (dir === 1 || dir === 3) { sx = plan.stepD; sz = plan.width; }
      this.box(cx, boxBottomY + h / 2, cz, sx, h, sz, mat);
      this.platform(cx - sx / 2, cx + sx / 2, cz - sz / 2, cz + sz / 2, topY);
    }
    return plan;
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
    // One invisible collision proxy; the renderer owns the single detailed
    // fixture model. The old path rendered these boxes AND an instanced lamp,
    // while also storing the fixture-head height as the base, so the duplicate
    // detailed lamp floated another full pole-height above the street.
    this.box(x, y + h / 2, z, 0.32, h, 0.32, 'metalDark', 0, {
      noRender: true,
      hint: 'metal',
    });
    this.def.lamps.push({ x, z, y, h, color, intensity, range });
  }

  tree(spec: { x: number; z: number; y: number; scale: number; variant: 'pine' | 'oak' | 'palm' | 'dead' }): boolean {
    if (!isTreePlacementClear(this.def, spec)) return false;
    this.def.trees.push(spec);
    return true;
  }

  rock(x: number, z: number, y: number, scale: number): void {
    this.def.rocks.push({ x, z, y, scale });
  }

  vehicle(x: number, z: number, y: number, yaw: number, variant: 'sedan' | 'van' | 'truck' | 'wrecked', color: number): void {
    this.def.vehicles.push({ x, z, y, yaw, variant, color, explodable: true });
  }

  chest(x: number, y: number, z: number, kind: ChestSpawn['kind']): boolean {
    const chest = { x, y, z, kind } satisfies ChestSpawn;
    if (!isChestPlacementClear(this.def, chest)) return false;
    this.def.chests.push(chest);
    return true;
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

  finish(sky: MapDef['sky'], transportRoute: MapDef['transportRoute'], opts: { wetGround?: boolean } = {}): MapDef {
    this.def.sky = sky;
    this.def.transportRoute = transportRoute;
    if (opts.wetGround) this.def.wetGround = true;
    const authoredTrees = this.def.trees;
    this.def.trees = [];
    for (const tree of authoredTrees) {
      if (isTreePlacementClear(this.def, tree)) this.def.trees.push(tree);
    }
    // Recheck after late environment dressing so trees, rocks or vehicles
    // authored after a chest cannot silently grow through it.
    this.def.chests = this.def.chests.filter((chest) => isChestPlacementClear(this.def, chest));
    const rejectedLamps = this.def.lamps.filter((lamp) => !isLampPlacementClear(this.def, lamp));
    this.def.lamps = this.def.lamps.filter((lamp) => isLampPlacementClear(this.def, lamp));
    this.def.geo = this.def.geo.filter((geo) => {
      if (!geo.noRender || geo.kind !== 'box') return true;
      return !rejectedLamps.some((lamp) => (
        Math.abs(geo.x - lamp.x) < 0.01 && Math.abs(geo.z - lamp.z) < 0.01
        && Math.abs(geo.sy - lamp.h) < 0.01
      ));
    });
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
      // `sx`/`sz` are local dimensions. Rapier rotates the fixed body by the
      // authored yaw, matching the rendered box exactly; pre-expanding to a
      // world AABB here would make diagonal walls and roofs far too thick.
      phys.addStaticBox(g.x, g.y, g.z, g.sx / 2, g.sy / 2, g.sz / 2, g.yaw, g.materialHint ?? matToHint(g.mat));
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

  // Tree trunks and rocks are solid: actors, bots and projectiles must not
  // phase through visible cover. Thin trunk boxes keep doorways/paths open.
  for (const t of def.trees) {
    const s = t.scale;
    phys.addStaticBox(t.x, t.y + 1.25 * s, t.z, 0.26 * s, 1.25 * s, 0.26 * s, 0, 'wood');
  }
  for (const r of def.rocks) {
    phys.addStaticBox(r.x, r.y + 0.45 * r.scale, r.z, 0.7 * r.scale, 0.45 * r.scale, 0.7 * r.scale, 0, 'stone');
  }

  // Vehicles are real cover: static collider boxes matching the scaled
  // presentation models (see VEHICLE_SCALE in types.ts).
  for (const v of def.vehicles) {
    const box = vehicleColliderBox(v.variant);
    // v.y is the render spawn height; rest the box on it.
    phys.addStaticBox(v.x, v.y + box.h / 2 - 0.1, v.z, box.ex, box.h / 2, box.ez, v.yaw, 'metal');
  }

  // Invisible world boundary: four tall slabs just inside the hard movement
  // clamp. They backstop every physics-driven escape route the clamp cannot
  // see coming in the same tick (grapple swings, dash frames, knockbacks).
  const bLim = def.size / 2 - 3;
  const bLen = def.size;
  const bY = 65;
  const bH = 85; // spans -20 .. 150
  const bT = 2;
  phys.addStaticBox(0, bY, bLim, bLen / 2, bH, bT, 0, 'stone'); // +Z
  phys.addStaticBox(0, bY, -bLim, bLen / 2, bH, bT, 0, 'stone'); // -Z
  phys.addStaticBox(bLim, bY, 0, bT, bH, bLen / 2, 0, 'stone'); // +X
  phys.addStaticBox(-bLim, bY, 0, bT, bH, bLen / 2, 0, 'stone'); // -X
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
