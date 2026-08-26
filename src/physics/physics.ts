/**
 * Physics layer wrapping Rapier (WASM).
 *
 * - Static world geometry: cuboids (+ optional heightfields).
 * - Characters: kinematic-position bodies with Rapier's KinematicCharacterController.
 * - Projectiles do NOT use rigid bodies; they integrate analytically and query
 *   swept raycasts each substep (robust CCD with full control over hit regions).
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { HitRegion } from '../core/balance';
import { MOVE } from '../core/balance';

export const CG = {
  WORLD: 1 << 0,
  ACTOR: 1 << 1,
  PROP: 1 << 2,
} as const;

/** Build an InteractionGroups value: (memberships << 16) | filterMask. */
function grp(membership: number, filter: number): number {
  return ((membership << 16) | filter) >>> 0;
}

export const GROUPS = {
  worldStatic: grp(CG.WORLD, 0xffff),
  /** Actors collide with the world but pass through each other (soft player collision). */
  actor: grp(CG.ACTOR, CG.WORLD),
  prop: grp(CG.PROP, 0xffff),
  /** Rays that should hit anything solid. */
  rayAll: grp(0xffff, CG.WORLD | CG.ACTOR | CG.PROP),
  /** Rays that ignore actors (line-of-sight checks against scenery only). */
  rayWorldOnly: grp(0xffff, CG.WORLD | CG.PROP),
};

/**
 * Authoritative character-space contract.
 *
 * Rapier stores `CharBody.position.y` at the capsule centre, while authored
 * world heights, character models and gameplay height constants are measured
 * from the soles. Keep every conversion here so render, camera, movement and
 * interaction systems cannot silently disagree about what a Y value means.
 */
/** Gap Rapier's character controller deliberately keeps around its capsule. */
export const CHARACTER_CONTROLLER_OFFSET = 0.02;

export const CAPSULE_CENTER_OFFSET =
  MOVE.capsuleHalfHeight + MOVE.capsuleRadius + CHARACTER_CONTROLLER_OFFSET;

export function feetYFromBodyCenter(bodyCenterY: number): number {
  return bodyCenterY - CAPSULE_CENTER_OFFSET;
}

export function eyeYFromBodyCenter(bodyCenterY: number, crouched: boolean): number {
  return feetYFromBodyCenter(bodyCenterY) + (crouched ? MOVE.crouchEyeHeight : MOVE.eyeHeight);
}

export function bodyYFromFeet(feetY: number): number {
  return feetY + CAPSULE_CENTER_OFFSET;
}

export interface RayHit {
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  dist: number;
  collider: RAPIER.Collider;
}

export interface ActorHitMeta {
  kind: 'actor';
  actorId: number;
  region: HitRegion;
}
export interface WorldHitMeta {
  kind: 'world';
  material?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'water' | 'foliage';
}
export interface DestructibleHitMeta {
  kind: 'destructible';
  id: number;
  material: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'water' | 'foliage';
}
export type ColliderMeta = ActorHitMeta | WorldHitMeta | DestructibleHitMeta;

let rapierReady: Promise<void> | null = null;

export async function initPhysics(): Promise<void> {
  if (!rapierReady) {
    rapierReady = RAPIER.init();
  }
  await rapierReady;
}

export class PhysicsWorld {
  readonly world: RAPIER.World;
  private meta = new WeakMap<RAPIER.Collider, ColliderMeta>();
  private disposed = false;

  constructor(gravityY = -MOVE.gravity) {
    this.world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
    this.world.timestep = 1 / 60;
    // Rapier's query pipeline is populated during step(); run one empty step
    // so raycasts/shape queries work immediately after construction.
    this.world.step();
  }

  setTimestep(dt: number): void {
    this.world.timestep = dt;
  }

  step(): void {
    this.world.step();
  }

  private setMeta(collider: RAPIER.Collider, meta: ColliderMeta): void {
    this.meta.set(collider, meta);
  }

  metaOf(collider: RAPIER.Collider): ColliderMeta | undefined {
    return this.meta.get(collider);
  }

  // -------------------------------------------------------------------------
  // Static geometry
  // -------------------------------------------------------------------------

  addStaticBox(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    yaw = 0,
    material: WorldHitMeta['material'] = 'stone',
  ): RAPIER.Collider {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz).setRotation(quatFromYaw(yaw)),
    );
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setFriction(1.0)
      .setRestitution(0)
      .setCollisionGroups(GROUPS.worldStatic);
    const collider = this.world.createCollider(desc, body);
    this.setMeta(collider, { kind: 'world', material });
    return collider;
  }

  addDestructibleBox(
    id: number,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    material: DestructibleHitMeta['material'],
  ): RAPIER.Collider {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz));
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.9).setCollisionGroups(GROUPS.worldStatic),
      body,
    );
    this.setMeta(collider, { kind: 'destructible', id, material });
    return collider;
  }

  removeCollider(collider: RAPIER.Collider): void {
    this.world.removeCollider(collider, true);
    // Refresh the query pipeline so the removed collider stops blocking rays.
    this.world.step();
  }

  /** Rebuild query pipelines after batch collider construction. */
  flush(): void {
    this.world.step();
  }

  /**
   * Add a static heightfield. heights grid is row-major, rows along +Z, cols along +X,
   * spanning [minX,maxX] x [minZ,maxZ]. Returns nothing; used for terrain.
   */
  addHeightfield(
    minX: number, minZ: number, maxX: number, maxZ: number,
    heights: Float32Array, nRows: number, nCols: number,
    material: WorldHitMeta['material'] = 'dirt',
  ): void {
    // Rapier heightfield scale is the TOTAL world extent of the grid.
    const scaleX = maxX - minX;
    const scaleZ = maxZ - minZ;
    // Rapier expects column-major heights (columns along local X, rows along local Z).
    const colMajor = new Float32Array(nRows * nCols);
    for (let r = 0; r < nRows; r++) {
      for (let c = 0; c < nCols; c++) {
        colMajor[c * nRows + r] = heights[r * nCols + c]!;
      }
    }
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(centerX, 0, centerZ));
    const desc = RAPIER.ColliderDesc.heightfield(nCols - 1, nRows - 1, colMajor, { x: scaleX, y: 1, z: scaleZ })
      .setFriction(1.0)
      .setCollisionGroups(GROUPS.worldStatic);
    const collider = this.world.createCollider(desc, body);
    this.setMeta(collider, { kind: 'world', material });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    groups: number = GROUPS.rayAll,
  ): RayHit | null {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, groups);
    if (!hit) return null;
    return {
      point: { x: ox + dx * hit.timeOfImpact, y: oy + dy * hit.timeOfImpact, z: oz + dz * hit.timeOfImpact },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      dist: hit.timeOfImpact,
      collider: hit.collider,
    };
  }

  /** True if segment origin->origin+dir*maxDist hits world-only geometry. */
  losBlocked(
    ox: number, oy: number, oz: number,
    tx: number, ty: number, tz: number,
  ): boolean {
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return false;
    const hit = this.raycast(ox, oy, oz, dx / len, dy / len, dz / len, len - 0.05, GROUPS.rayWorldOnly);
    return hit !== null;
  }

  /** Distance to ground directly below point (or null). */
  groundBelow(x: number, y: number, z: number, maxDist = 200): number | null {
    const hit = this.raycast(x, y, z, 0, -1, 0, maxDist, GROUPS.rayWorldOnly);
    return hit ? y - hit.point.y : null;
  }

  /** First solid surface height at/below given y at (x,z); returns top surface Y. */
  surfaceAt(x: number, z: number, fromY: number, maxDrop = 300): number | null {
    const hit = this.raycast(x, fromY, z, 0, -1, 0, maxDrop, GROUPS.rayWorldOnly);
    return hit ? hit.point.y : null;
  }

  // -------------------------------------------------------------------------
  // Step
  // -------------------------------------------------------------------------

  fixedStep(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.free();
  }
}

export function quatFromYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  const h = yaw / 2;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

// ---------------------------------------------------------------------------
// Character body (kinematic capsule + hit-region colliders + KCC)
// ---------------------------------------------------------------------------

export interface RegionOffset {
  region: HitRegion;
  /** Capsule (halfHeight along Y, radius) centered at offset. */
  y: number;
  halfHeight: number;
  radius: number;
  z?: number;
}

const REGION_LAYOUT: RegionOffset[] = [
  { region: 'head', y: 0.98, halfHeight: 0.06, radius: 0.24 },
  { region: 'chest', y: 0.52, halfHeight: 0.16, radius: 0.34 },
  { region: 'abdomen', y: 0.12, halfHeight: 0.14, radius: 0.32 },
  { region: 'arms', y: 0.42, halfHeight: 0.3, radius: 0.16 },
  { region: 'legs', y: -0.62, halfHeight: 0.28, radius: 0.26 },
];

export class CharBody {
  readonly body: RAPIER.RigidBody;
  readonly capsule: RAPIER.Collider;
  readonly controller: RAPIER.KinematicCharacterController;
  readonly actorId: number;
  position = { x: 0, y: 0, z: 0 };
  velocity = { x: 0, y: 0, z: 0 };
  grounded = false;
  groundNormalY = 1;
  hitCeiling = false;
  slidAlongWall = false;

  constructor(private phys: PhysicsWorld, actorId: number, x: number, y: number, z: number) {
    this.actorId = actorId;
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(x, y, z)
      .setCcdEnabled(true);
    this.body = phys.world.createRigidBody(bodyDesc);
    this.position = { x, y, z };

    const capDesc = RAPIER.ColliderDesc.capsule(MOVE.capsuleHalfHeight, MOVE.capsuleRadius)
      .setFriction(0.6)
      .setCollisionGroups(GROUPS.actor);
    this.capsule = phys.world.createCollider(capDesc, this.body);
    phys['setMeta'](this.capsule, { kind: 'actor', actorId, region: 'chest' });

    // Gameplay hit volumes (invisible; excluded from movement collisions by
    // the KCC's own group filter, but hittable by projectile rays).
    for (const ro of REGION_LAYOUT) {
      const desc = RAPIER.ColliderDesc.capsule(ro.halfHeight, ro.radius)
        .setTranslation(0, ro.y, ro.z ?? 0)
        .setCollisionGroups(grp(CG.ACTOR, 0xffff));
      const col = phys.world.createCollider(desc, this.body);
      phys['setMeta'](col, { kind: 'actor', actorId, region: ro.region });
    }

    this.controller = phys.world.createCharacterController(CHARACTER_CONTROLLER_OFFSET);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(MOVE.stepHeight, 0.18, false);
    this.controller.enableSnapToGround(0.4);
    this.controller.setSlideEnabled(true);
    this.controller.setMaxSlopeClimbAngle((48 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((50 * Math.PI) / 180);
  }

  /**
   * Move by desired displacement using the character controller.
   * Updates position/velocity contact state. Call once per fixed tick.
   */
  move(dx: number, dy: number, dz: number): void {
    this.hitCeiling = false;
    this.slidAlongWall = false;
    this.controller.computeColliderMovement(this.capsule, { x: dx, y: dy, z: dz }, undefined, GROUPS.actor);
    const mv = this.controller.computedMovement();
    this.position.x += mv.x;
    this.position.y += mv.y;
    this.position.z += mv.z;
    this.grounded = this.controller.computedGrounded();
    const colEvts = this.controller.numComputedCollisions();
    for (let i = 0; i < colEvts; i++) {
      const ev = this.controller.computedCollision(i);
      if (!ev) continue;
      const ny = ev.normal1?.y ?? 0;
      if (ny < -0.5) this.hitCeiling = true;
      else if (Math.abs(ny) < 0.5) this.slidAlongWall = true;
    }
    this.groundNormalY = this.grounded ? 1 : this.groundNormalY;
    this.body.setNextKinematicTranslation(this.position);
  }

  teleport(x: number, y: number, z: number): void {
    this.position.x = x;
    this.position.y = y;
    this.position.z = z;
    this.body.setNextKinematicTranslation(this.position);
    this.body.setTranslation(this.position, true);
  }

  dispose(): void {
    this.phys.world.removeCharacterController(this.controller);
    this.phys.world.removeRigidBody(this.body);
  }
}
