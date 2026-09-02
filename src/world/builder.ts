/**
 * WorldBuilder: constructs map geometry records, walkable platform records,
 * loot/chest spawns and POIs. Renderer-independent.
 *
 * Colliders are built later from `def.geo` via buildColliders(); visuals are
 * built by the render pass consuming the same specs.
 */

import {
  vehicleColliderCenter,
  vehicleColliderBox,
  type MapDef,
  type MatKey,
  type ChestSpawn,
  type LootSpawn,
  type TerrainCutout,
  type WaterVisualProfile,
} from './types';
import { rockColliderProfile, type RockVariant } from './rockProfiles';
import { GROUPS, PhysicsWorld } from '../physics/physics';
import { buildTerrainGridMesh, sampleTerrainHeightfield } from './terrainMesh';

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
const PROP_SUPPORT_TOLERANCE = 0.78;

interface FlatRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function subtractRect(rect: FlatRect, hole: FlatRect): FlatRect[] {
  const ix0 = Math.max(rect.minX, hole.minX);
  const ix1 = Math.min(rect.maxX, hole.maxX);
  const iz0 = Math.max(rect.minZ, hole.minZ);
  const iz1 = Math.min(rect.maxZ, hole.maxZ);
  if (ix1 <= ix0 || iz1 <= iz0) return [rect];
  const pieces: FlatRect[] = [];
  if (ix0 - rect.minX > 0.05) pieces.push({ ...rect, maxX: ix0 });
  if (rect.maxX - ix1 > 0.05) pieces.push({ ...rect, minX: ix1 });
  if (iz0 - rect.minZ > 0.05) pieces.push({ minX: ix0, maxX: ix1, minZ: rect.minZ, maxZ: iz0 });
  if (rect.maxZ - iz1 > 0.05) pieces.push({ minX: ix0, maxX: ix1, minZ: iz1, maxZ: rect.maxZ });
  return pieces;
}

/** Apply terrain openings to later-authored pavement/floor strips and nav. */
function applyTerrainCutouts(def: MapDef): void {
  const cutouts = def.terrainCutouts ?? [];
  if (cutouts.length === 0) return;
  def.geo = def.geo.flatMap((geo) => {
    if (geo.kind !== 'box' || geo.preserveInTerrainCutout ||
        Math.abs(geo.yaw) > 1e-5 || geo.sy > 2.1) return [geo];
    const topY = geo.y + geo.sy / 2;
    const relevant = cutouts.filter((hole) => Math.abs(topY - hole.surfaceY) <= 0.55);
    if (relevant.length === 0) return [geo];
    let pieces: FlatRect[] = [{
      minX: geo.x - geo.sx / 2,
      maxX: geo.x + geo.sx / 2,
      minZ: geo.z - geo.sz / 2,
      maxZ: geo.z + geo.sz / 2,
    }];
    for (const hole of relevant) pieces = pieces.flatMap((piece) => subtractRect(piece, hole));
    return pieces.map((piece) => ({
      ...geo,
      x: (piece.minX + piece.maxX) / 2,
      z: (piece.minZ + piece.maxZ) / 2,
      sx: piece.maxX - piece.minX,
      sz: piece.maxZ - piece.minZ,
    }));
  });
  def.platforms = def.platforms.flatMap((platform) => {
    if (platform.preserveInTerrainCutout) return [platform];
    const relevant = cutouts.filter((hole) => Math.abs(platform.y - hole.surfaceY) <= 0.55);
    if (relevant.length === 0) return [platform];
    let pieces: FlatRect[] = [{
      minX: platform.minX,
      maxX: platform.maxX,
      minZ: platform.minZ,
      maxZ: platform.maxZ,
    }];
    for (const hole of relevant) pieces = pieces.flatMap((piece) => subtractRect(piece, hole));
    return pieces.map((piece) => ({ ...piece, y: platform.y, water: platform.water }));
  });
}

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
    // crate's support. Fall back to the local ground around the authored base;
    // the reach covers the support tolerance plus the probe offset.
    const nearHit = phys.raycast(geo.x, baseY + 0.6, geo.z, 0, -1, 0, 0.6 + PROP_SUPPORT_TOLERANCE + 0.1, GROUPS.rayWorldOnly);
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
  const accepted: MapDef['destructibles'] = [];
  for (const prop of def.destructibles) {
    if (!isCratePlacementClear(def, prop)) continue;
    if (prop.type === 'crate' && prop.geo.kind === 'box') {
      const crate = prop.geo;
      const overlapsAccepted = accepted.some((other) => {
        if (other.type !== 'crate' || other.geo.kind !== 'box') return false;
        const box = other.geo;
        // Crates are axis-aligned today. Shared faces and deliberate stacked
        // contact are valid; only reject positive-volume intersections.
        return Math.abs(crate.x - box.x) < (crate.sx + box.sx) / 2 - 0.01
          && Math.abs(crate.y - box.y) < (crate.sy + box.sy) / 2 - 0.01
          && Math.abs(crate.z - box.z) < (crate.sz + box.sz) / 2 - 0.01;
      });
      if (overlapsAccepted) continue;
    }
    accepted.push(prop);
  }
  def.destructibles = accepted;
}

/**
 * Apply the deterministic map mutations that Match performs before assigning
 * destructible IDs. Online peers must run this before hashing the canonical
 * start payload so the host encoder, guest decoder, renderer, and prediction
 * world all share the same stable-ID dictionary.
 *
 * Match repeats these operations against its long-lived PhysicsWorld; both
 * grounding and filtering are intentionally idempotent.
 */
export function normalizeMapForMatch(def: MapDef): MapDef {
  const phys = new PhysicsWorld();
  try {
    buildColliders(def, phys);
    phys.flush();
    groundCrates(def, phys);
    filterInvalidCrates(def);
    return def;
  } finally {
    phys.dispose();
  }
}

/** Keep authored/parked vehicle cover out of buildings and other solids. */
export function isVehiclePlacementClear(
  def: MapDef,
  vehicle: MapDef['vehicles'][number],
  ignore?: MapDef['vehicles'][number],
): boolean {
  const box = vehicleColliderBox(vehicle.variant, vehicle.x, vehicle.z);
  const center = vehicleColliderCenter(vehicle);
  const vc = Math.abs(Math.cos(vehicle.yaw));
  const vs = Math.abs(Math.sin(vehicle.yaw));
  const vhx = box.ex * vc + box.ez * vs;
  const vhz = box.ex * vs + box.ez * vc;
  // Match the full shared render/physics envelope. Only ignore the support
  // face itself so a parked vehicle may rest on its authored ground plane;
  // the old 0.05/0.1 inset could accept thin geometry clipping into the
  // visible roof or underbody.
  const minY = vehicle.y + 0.01;
  const maxY = vehicle.y + box.h - 0.01;
  const overlapsY = (lo: number, hi: number) => hi > minY && lo < maxY;
  for (const geo of def.geo) {
    if (geo.noCollide) continue;
    if (geo.kind === 'box') {
      const c = Math.abs(Math.cos(geo.yaw));
      const s = Math.abs(Math.sin(geo.yaw));
      const hx = (geo.sx * c + geo.sz * s) / 2;
      const hz = (geo.sx * s + geo.sz * c) / 2;
      if (Math.abs(center.x - geo.x) < vhx + hx
        && Math.abs(center.z - geo.z) < vhz + hz
        && overlapsY(geo.y - geo.sy / 2, geo.y + geo.sy / 2)) return false;
    } else if (geo.kind === 'cyl') {
      if (Math.hypot(center.x - geo.x, center.z - geo.z) < Math.max(vhx, vhz) + geo.r
        && overlapsY(geo.y - geo.h / 2, geo.y + geo.h / 2)) return false;
    } else if (Math.hypot(center.x - geo.x, center.z - geo.z) < Math.max(vhx, vhz) + geo.r
      && overlapsY(geo.y - geo.r, geo.y + geo.r)) return false;
  }
  for (const other of def.vehicles) {
    if (other === vehicle || other === ignore) continue;
    const otherBox = vehicleColliderBox(other.variant, other.x, other.z);
    const otherCenter = vehicleColliderCenter(other);
    if (Math.hypot(center.x - otherCenter.x, center.z - otherCenter.z)
      < Math.max(vhx, vhz) + Math.max(otherBox.ex, otherBox.ez)) return false;
  }
  return true;
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
    const profile = rockColliderProfile(rock.variant);
    if (Math.hypot(chest.x - rock.x, chest.z - rock.z) < profile.footprintRadius * rock.scale + 0.55
      && overlapsY(rock.y, rock.y + profile.height * rock.scale)) return false;
  }
  for (const vehicle of def.vehicles) {
    const box = vehicleColliderBox(vehicle.variant, vehicle.x, vehicle.z);
    const center = vehicleColliderCenter(vehicle);
    if (Math.abs(chest.x - center.x) < Math.max(box.ex, box.ez) + 0.55
      && Math.abs(chest.z - center.z) < Math.max(box.ex, box.ez) + 0.38
      && overlapsY(vehicle.y, vehicle.y + box.h)) return false;
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
    const profile = rockColliderProfile(rock.variant);
    if (Math.hypot(tree.x - rock.x, tree.z - rock.z) < profile.footprintRadius * rock.scale + trunkRadius
      && overlapsY(rock.y, rock.y + profile.height * rock.scale)) return false;
  }
  for (const vehicle of def.vehicles) {
    const box = vehicleColliderBox(vehicle.variant, vehicle.x, vehicle.z);
    const center = vehicleColliderCenter(vehicle);
    if (Math.abs(tree.x - center.x) < Math.max(box.ex, box.ez) + trunkRadius
      && Math.abs(tree.z - center.z) < Math.max(box.ex, box.ez) + trunkRadius
      && overlapsY(vehicle.y, vehicle.y + box.h)) return false;
  }
  return true;
}

export class WorldBuilder {
  readonly def: MapDef;

  constructor(id: string, name: string, description: string, size: number) {
    this.def = {
      id, name, description, size,
      sky: null as never,
      surfacePaths: [],
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
      stairs: [],
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
      stairRamp?: boolean;
      stairTread?: boolean;
      castShadow?: boolean;
      hint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage';
      floor?: boolean;
      terrain?: boolean;
      preserveInTerrainCutout?: boolean;
      /** Tilt for collidable sloped proxies (stair movement ramps). */
      pitch?: number;
      roll?: number;
    },
  ): void {
    this.def.geo.push({
      kind: 'box', x, y, z, sx, sy, sz, yaw, mat,
      pitch: opts?.pitch,
      roll: opts?.roll,
      noCollide: opts?.noCollide,
      noRender: opts?.noRender,
      stairRamp: opts?.stairRamp,
      stairTread: opts?.stairTread,
      castShadow: opts?.castShadow,
      terrain: opts?.terrain,
      preserveInTerrainCutout: opts?.preserveInTerrainCutout,
      materialHint: opts?.hint,
    });
    if (opts?.floor && !opts.noCollide) {
      const c = Math.abs(Math.cos(yaw));
      const s = Math.abs(Math.sin(yaw));
      const halfX = (sx * c + sz * s) / 2;
      const halfZ = (sx * s + sz * c) / 2;
      this.platform(
        x - halfX, x + halfX, z - halfZ, z + halfZ, y + sy / 2,
        false,
        opts.preserveInTerrainCutout,
      );
    }
  }

  /** Floor slab: registers a walkable platform on its top surface. */
  slab(x: number, yTop: number, z: number, sx: number, sz: number, thickness: number, mat: MatKey): void {
    this.box(x, yTop - thickness / 2, z, sx, thickness, sz, mat, 0, { floor: true });
  }

  cyl(
    x: number, y: number, z: number, r: number, h: number, mat: MatKey,
    opts?: { segments?: number; noCollide?: boolean; yaw?: number; pitch?: number; roll?: number },
  ): void {
    this.def.geo.push({
      kind: 'cyl', x, y, z, r, h, mat,
      segments: opts?.segments,
      noCollide: opts?.noCollide,
      yaw: opts?.yaw,
      pitch: opts?.pitch,
      roll: opts?.roll,
    });
  }

  sphere(x: number, y: number, z: number, r: number, mat: MatKey, opts?: { noCollide?: boolean }): void {
    this.def.geo.push({ kind: 'sphere', x, y, z, r, mat, noCollide: opts?.noCollide });
  }

  platform(
    minX: number, maxX: number, minZ: number, maxZ: number, y: number,
    water = false,
    preserveInTerrainCutout = false,
  ): void {
    this.def.platforms.push({ minX, maxX, minZ, maxZ, y, water, preserveInTerrainCutout });
  }

  terrainCutout(cutout: TerrainCutout): void {
    (this.def.terrainCutouts ??= []).push(cutout);
  }

  /** Record a continuous visual road/path without adding duplicate collision. */
  surfacePath(points: Array<{ x: number; z: number; width: number }>, mat: MatKey, yOffset = 0.04): void {
    if (points.length < 2) return;
    this.def.surfacePaths.push({ points, mat, yOffset });
  }

  /**
   * Invisible continuous guard envelope matching an authored rail line.
   *
   * Handrails and guardrails across the maps are presentation-only geo; this
   * proxy is the shared collision strategy that makes them functional without
   * turning every post into its own physics actor. One thin yaw-aligned box
   * spans the rail's horizontal run and its full vertical envelope (from the
   * guarded floor line up to the rail top), so a capsule can neither walk nor
   * slide through the visually closed guard, while bullets still pass the
   * open gaps between posts and rails. Place it exactly along the visible
   * rail line — never as an unexplained invisible wall.
   */
  guardRail(
    from: { x: number; z: number },
    to: { x: number; z: number },
    yLow: number,
    yHigh: number,
    thickness = 0.16,
  ): void {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (!(len >= 0.05) || !(yHigh - yLow >= 0.05)) return;
    this.box(
      (from.x + to.x) / 2,
      (yLow + yHigh) / 2,
      (from.z + to.z) / 2,
      thickness,
      yHigh - yLow,
      len,
      'metalDark',
      Math.atan2(dx, dz),
      { noRender: true, hint: 'metal', castShadow: false },
    );
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
    sillGaps?: Array<[number, number]>,
  ): void {
    const normalizeGaps = (source: Array<[number, number]>): Array<[number, number]> => source
      .map(([start, width]) => {
        const clampedStart = Math.max(0, Math.min(length, start));
        const clampedEnd = Math.max(clampedStart, Math.min(length, start + Math.max(0, width)));
        return [clampedStart, clampedEnd - clampedStart] as [number, number];
      })
      .filter(([, width]) => width >= 0.05)
      .sort((a, b) => a[0] - b[0]);
    const segs: Array<[number, number]> = [];
    let cursor = 0;
    const sorted = normalizeGaps(gaps);
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
      for (const [start, width] of normalizeGaps(sillGaps ?? gaps)) {
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
    this.def.stairs.push({
      x, y, z, dir,
      steps: plan.steps,
      stepH: plan.stepH,
      stepD: plan.stepD,
      width: plan.width,
      totalRise: plan.totalRise,
      run: plan.run,
    });
    // Each tread includes one riser and a small overlap with its neighbour.
    // Building every tread down to the flight's base created a solid stepped
    // pyramid; on stacked flights that mass occupied the headroom of the
    // staircase below and made upper floors unreachable to a human capsule.
    const treadHeight = Math.abs(plan.stepH) + 0.06;
    for (let i = 0; i < plan.steps; i++) {
      const topY = y + plan.stepH * (i + 1);
      const off = plan.stepD * (i + 0.5);
      let cx = x, cz = z, sx = plan.width, sz = plan.stepD;
      if (dir === 0) cz = z + off;
      else if (dir === 1) cx = x + off;
      else if (dir === 2) cz = z - off;
      else cx = x - off;
      if (dir === 1 || dir === 3) { sx = plan.stepD; sz = plan.width; }
      // Ascending flights carry the movement ramp: every tread the ramp
      // covers is a CG.STEP body (solid to cameras/projectiles/probes,
      // skipped by character movement) so the KCC never snaps between the
      // ramp and the tread below it, and both end treads stay fully solid as
      // arrival surfaces. Descending flights keep the shipped solid-tread
      // behaviour: their street/ground lip exits interact with adjacent
      // ground geometry in ways the ramp wedge must not overlap.
      const ascending = plan.stepH > 0;
      this.box(cx, topY - treadHeight / 2, cz, sx, treadHeight, sz, mat, 0, {
        preserveInTerrainCutout: true,
        stairTread: ascending && i > 0 && i < plan.steps - 1,
      });
      let navMinX = cx - sx / 2;
      let navMaxX = cx + sx / 2;
      let navMinZ = cz - sz / 2;
      let navMaxZ = cz + sz / 2;
      // A capsule centred on a minimum-depth tread can overlap the next
      // riser by a few centimetres (tread 0.78 vs capsule diameter 0.84).
      // Bias the navigation sample down-run while keeping the rendered and
      // physical stair geometry unchanged.
      const navBackoff = Math.min(0.08, plan.stepD * 0.2);
      if (dir === 0) navMaxZ -= navBackoff;
      else if (dir === 1) navMaxX -= navBackoff;
      else if (dir === 2) navMinZ += navBackoff;
      else navMinX += navBackoff;
      this.platform(navMinX, navMaxX, navMinZ, navMaxZ, topY, false, true);
    }
    // Shared flight-axis vectors and yaw (treads, ramp and soffit all use them).
    const dirX = dir === 1 ? 1 : dir === 3 ? -1 : 0;
    const dirZ = dir === 0 ? 1 : dir === 2 ? -1 : 0;
    const yaw = dir === 0 ? 0 : dir === 1 ? Math.PI / 2 : dir === 2 ? Math.PI : -Math.PI / 2;
    // Invisible movement ramp along the flight's nosing line (the surface
    // through every tread's top-front edge). Character capsules that hug a
    // side wall or overhang a tread's outer edge get the KCC's autostep
    // refused mid-flight — the reported diagonal/edge stair snagging. The
    // ramp gives movement one smooth <=24-degree surface while the visible
    // treads and their risers remain full colliders for cameras and
    // projectiles, and clearance queries (nav, spawns, QA) skip the ramp via
    // its stairRamp marker. The ramp spans exactly from the first nosing to
    // the last, so total elevation, landings and walking-through-adjacent-
    // wall behaviour are unchanged; only the base riser remains a step, as
    // before. The surface is 0.3 m wider than the flight so a capsule hugging
    // the outer tread edge keeps full ramp support instead of jamming on the
    // ramp's side edge.
    if (plan.steps >= 2 && plan.stepH > 0) {
      // Ascending flights only (see the tread note above). The ramp spans
      // from tread 0's nosing to the top tread's nosing: every mid-flight
      // riser disappears under a smooth surface, while the base riser (an
      // autostep that always worked) and both solid end treads remain.
      // The leading face stays exactly coplanar with tread 0's riser: one
      // flat wall for the approaching capsule (a buried face instead creates
      // a tiny convex edge whose diagonal contact normal makes the KCC slide
      // sideways rather than autostep).
      const rampStartS = 0;
      const rampEndS = plan.stepD * (plan.steps - 1);
      const rampRun = rampEndS - rampStartS;
      const rampAngle = Math.atan2(plan.stepH, plan.stepD);
      const rampLength = Math.hypot(rampRun, rampRun * Math.tan(rampAngle));
      const rampThickness = 0.3;
      // The ramp rides 2 cm above the exact nosing line so it is strictly the
      // topmost surface across the whole flight: no coplanar seam with the
      // tread tops exists for the KCC to snap through, and a capsule can
      // never wedge itself between a tread and the ramp above it.
      const rampLift = 0.02;
      // Offset the centre by half the thickness along the surface normal
      // n = (0, cos a, 0) - sin a * travel.
      const midS = (rampStartS + rampEndS) / 2;
      const midX = x + dirX * midS;
      const midY = y + plan.stepH + midS * (plan.stepH / plan.stepD) + rampLift;
      const midZ = z + dirZ * midS;
      const rampX = midX + (rampThickness / 2) * Math.sin(rampAngle) * dirX;
      const rampY = midY - (rampThickness / 2) * Math.cos(rampAngle);
      const rampZ = midZ + (rampThickness / 2) * Math.sin(rampAngle) * dirZ;
      const rampSx = plan.width + 0.3;
      const rampSz = rampLength;
      this.box(rampX, rampY, rampZ, rampSx, rampThickness, rampSz, mat, yaw, {
        noRender: true,
        pitch: -rampAngle,
        preserveInTerrainCutout: true,
        stairRamp: true,
      });
    }
    // Thin independent treads expose a jagged underside that reads as
    // floating geometry indoors. Give masonry flights a continuous soffit and
    // metal flights two real side stringers. These are visual supports only;
    // the KCC continues to use the exact tread/riser colliders above.
    const slopeAngle = Math.atan2(plan.totalRise, plan.run);
    const slopeLength = Math.hypot(plan.run, plan.totalRise);
    const supportY = y + plan.totalRise / 2 - Math.abs(plan.stepH) / 2 - 0.11;
    const supportX = x + dirX * plan.run / 2;
    const supportZ = z + dirZ * plan.run / 2;
    const solidSoffit = mat === 'concrete' || mat === 'concreteDark' || mat === 'stoneBrick'
      || mat === 'marble' || mat === 'rock';
    const supportOffsets = solidSoffit
      ? [0]
      : [-(plan.width / 2 - 0.12), plan.width / 2 - 0.12];
    const supportWidth = solidSoffit ? Math.max(0.12, plan.width - 0.08) : 0.12;
    for (const offset of supportOffsets) {
      const crossX = -dirZ * offset;
      const crossZ = dirX * offset;
      this.box(
        supportX + crossX,
        supportY,
        supportZ + crossZ,
        supportWidth,
        0.14,
        slopeLength,
        mat,
        yaw,
        { noCollide: true, pitch: -slopeAngle },
      );
    }
    // Explicit landing anchors keep a narrow stair connected to the room
    // grids at both ends even when their unrelated sampling phases do not
    // happen to place a point beside the first or last tread.
    const anchorHalf = 0.05;
    // Keep anchor capsules outside the first/last riser volume. The former
    // 0.15 m offset was smaller than the 0.42 m character radius, so the
    // anchor was rejected and every otherwise-valid stair component pruned.
    const landingOffset = 0.55;
    const lowerX = x - dirX * landingOffset;
    const lowerZ = z - dirZ * landingOffset;
    const upperX = x + dirX * (plan.run + landingOffset);
    const upperZ = z + dirZ * (plan.run + landingOffset);
    this.platform(lowerX - anchorHalf, lowerX + anchorHalf, lowerZ - anchorHalf, lowerZ + anchorHalf, y, false, true);
    // A narrow flight can consume the room grid's nearest floor sample. Give
    // the lower landing two lateral approach anchors outside the stair width;
    // wall-side candidates are rejected by NavGraph, while the room-side one
    // preserves a real capsule-clear connection into the floor network.
    const sideLandingOffset = plan.width / 2 + landingOffset;
    const crossX = -dirZ;
    const crossZ = dirX;
    for (const side of [-1, 1]) {
      const approachX = lowerX + crossX * sideLandingOffset * side;
      const approachZ = lowerZ + crossZ * sideLandingOffset * side;
      this.platform(
        approachX - anchorHalf,
        approachX + anchorHalf,
        approachZ - anchorHalf,
        approachZ + anchorHalf,
        y,
        false,
        true,
      );
    }
    this.platform(
      upperX - anchorHalf, upperX + anchorHalf, upperZ - anchorHalf, upperZ + anchorHalf,
      y + plan.totalRise,
      false,
      true,
    );
    return plan;
  }

  crate(x: number, y: number, z: number, scale = 1, mat: MatKey = 'wood'): void {
    const s = 1.4 * scale;
    this.def.destructibles.push({
      stableId: `${this.def.id}:crate:${this.def.destructibles.length.toString(36).padStart(4, '0')}`,
      hp: 30,
      type: 'crate',
      geo: { kind: 'box', x, y: y + s / 2, z, sx: s, sy: s, sz: s, yaw: 0, mat },
    });
  }

  glassPane(x: number, y: number, z: number, sx: number, sy: number, axis: 'x' | 'z'): void {
    this.def.destructibles.push({
      stableId: `${this.def.id}:glass:${this.def.destructibles.length.toString(36).padStart(4, '0')}`,
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

  /**
   * Author one rock. Variant and yaw are derived here from the same position
   * phases the renderer previously used for model selection, so physics
   * compound colliders and rendered instances always resolve the identical
   * rock shape at the identical orientation.
   */
  rock(x: number, z: number, y: number, scale: number): void {
    const phase = x * 7.7 + z * 3.3;
    const index = this.def.rocks.length;
    const variant: RockVariant = Math.abs(Math.round(phase * 1.73 + index * 2.31)) % 2 === 0
      ? 'medium-1'
      : 'medium-2';
    this.def.rocks.push({ x, z, y, scale, variant, yaw: phase });
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

  water(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    surfaceY: number,
    depth: number,
    visual?: WaterVisualProfile,
  ): void {
    this.def.water.push({ minX, maxX, minZ, maxZ, surfaceY, depth, ...(visual ? { visual } : {}) });
    this.platform(minX, maxX, minZ, maxZ, surfaceY, true);
  }

  finish(sky: MapDef['sky'], transportRoute: MapDef['transportRoute'], opts: { wetGround?: boolean } = {}): MapDef {
    this.def.sky = sky;
    this.def.transportRoute = transportRoute;
    if (opts.wetGround) this.def.wetGround = true;
    applyTerrainCutouts(this.def);
    const authoredTrees = this.def.trees;
    this.def.trees = [];
    for (const tree of authoredTrees) {
      if (isTreePlacementClear(this.def, tree)) this.def.trees.push(tree);
    }
    // Late street dressing can place a car before a subsequently-authored
    // kiosk, planter or stair. Resolve the finished scene, not insertion order.
    this.def.vehicles = this.def.vehicles.filter((vehicle) => isVehiclePlacementClear(this.def, vehicle));
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

/** Build ALL static colliders for a MapDef (geometry + heightfield) into a PhysicsWorld. */
export function buildColliders(def: MapDef, phys: PhysicsWorld): void {
  for (const g of def.geo) {
    if (g.kind === 'box') {
      if (g.noCollide) continue;
      // `sx`/`sz` are local dimensions. Rapier rotates the fixed body by the
      // authored yaw, matching the rendered box exactly; pre-expanding to a
      // world AABB here would make diagonal walls and roofs far too thick.
      phys.addStaticBox(
        g.x, g.y, g.z,
        g.sx / 2, g.sy / 2, g.sz / 2,
        g.yaw,
        g.materialHint ?? matToHint(g.mat),
        g.terrain === true,
        g.pitch ?? 0,
        g.roll ?? 0,
        g.stairRamp === true,
        g.stairTread === true ? GROUPS.step : GROUPS.worldStatic,
      );
    } else if (g.kind === 'cyl') {
      if (g.noCollide) continue;
      phys.addStaticCylinder(g.x, g.y, g.z, g.h / 2, g.r, g.materialHint ?? matToHint(g.mat));
    } else if (g.kind === 'sphere') {
      if (g.noCollide) continue;
      phys.addStaticSphere(g.x, g.y, g.z, g.r, g.materialHint ?? matToHint(g.mat));
    }
  }
  const hf = def.heightfield;
  if (hf) {
    const cutouts = def.terrainCutouts ?? [];
    if (cutouts.length === 0) {
      phys.addHeightfield(-def.size / 2, -def.size / 2, def.size / 2, def.size / 2, hf.heights, hf.n, hf.n, 'dirt');
    } else {
      const min = -def.size / 2;
      const mesh = def.terrainMesh ?? buildTerrainGridMesh({
        minX: min,
        maxX: -min,
        minZ: min,
        maxZ: -min,
        segmentsX: hf.n - 1,
        segmentsZ: hf.n - 1,
        heightAt: (x, z) => sampleTerrainHeightfield(hf, def.size, x, z),
        removals: cutouts,
      });
      phys.addStaticTrimesh(mesh.positions, mesh.indices, 'dirt', true);
    }
  }

  // Tree trunks and rocks are solid: actors, bots and projectiles must not
  // phase through visible cover. Thin trunk boxes keep doorways/paths open.
  for (const t of def.trees) {
    const s = t.scale;
    phys.addStaticBox(t.x, t.y + 1.25 * s, t.z, 0.26 * s, 1.25 * s, 0.26 * s, 0, 'wood');
  }
  for (const r of def.rocks) {
    // Measured per-variant compound profile (see ./rockProfiles): 2-3 yawed
    // boxes approximating the actual licensed mesh, uniformly scaled and
    // buried by the same 0.22 * scale the renderer uses to seat the model.
    const profile = rockColliderProfile(r.variant);
    const cos = Math.cos(r.yaw);
    const sin = Math.sin(r.yaw);
    for (const box of profile.boxes) {
      const ox = box.x * cos + box.z * sin;
      const oz = -box.x * sin + box.z * cos;
      phys.addStaticBox(
        r.x + ox * r.scale,
        r.y + (box.y - 0.22) * r.scale,
        r.z + oz * r.scale,
        box.hx * r.scale,
        box.hy * r.scale,
        box.hz * r.scale,
        r.yaw + box.yaw,
        'stone',
      );
    }
  }

  // Vehicles are real cover: static collider boxes matching the scaled
  // presentation models (see VEHICLE_SCALE in types.ts).
  for (const v of def.vehicles) {
    const box = vehicleColliderBox(v.variant, v.x, v.z);
    const center = vehicleColliderCenter(v);
    // v.y is the shared visual/physical support plane. The collider encloses
    // the exact scaled GLB bounds selected for this authored position.
    phys.addStaticBox(center.x, v.y + box.h / 2, center.z, box.ex, box.h / 2, box.ez, v.yaw, 'metal');
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
