import { MOVE, type HitRegion } from '../core/balance';
import { eyeYFromBodyCenter, GROUPS, type PhysicsWorld } from '../physics/physics';
import type { Actor } from '../sim/actor';
import type {
  AuthoritativeShotPose,
  DestructibleRef,
  ProjectileCollisionHit,
  ProjectileCollisionQuery,
} from '../sim/combat';
import type { Match } from '../sim/match';

export const LAG_COMPENSATION_TICK_RATE = 60;
export const LAG_COMPENSATION_MAX_REWIND_MS = 250;

const UINT32_MAX = 0xffff_ffff;
const UINT32_HALF_RANGE = 0x8000_0000;
const PROJECTILE_SUBSTEPS_PER_TICK = 2;
const QUERY_EPSILON = 0.02;
const MAX_WORLD_SKIP_PASSES = 64;

export type LagCompensationRejectedReason =
  | 'invalid-tick'
  | 'invalid-dt'
  | 'future-shot'
  | 'excessive-rewind'
  | 'history-unavailable'
  | 'actor-unavailable'
  | 'fire-denied';

export interface ResolveAcceptedShotInput {
  /** Current authoritative actor. No target, damage, aim, or muzzle is accepted. */
  actor: Actor;
  currentHostTick: number;
  /** The sole client-provided shot timing field (validated as uint32). */
  requestedShotTick: number;
  /** Host fixed-step duration. Catch-up itself uses the configured host tick rate. */
  dt: number;
}

export interface LagCompensationTelemetry {
  accepted: boolean;
  acceptedTick: number | null;
  rewindTicks: number;
  clamped: boolean;
  rejectedReason?: LagCompensationRejectedReason;
  catchupSubsteps: number;
  /** Historical-to-live canonical muzzle displacement at receipt time. */
  errorDistance?: number;
}

interface HistoricalHitRegionPose {
  region: HitRegion;
  x: number;
  y: number;
  z: number;
  halfHeight: number;
  radius: number;
}

interface HistoricalActorPose {
  actorId: number;
  alive: boolean;
  bodyPosition: { x: number; y: number; z: number };
  crouched: boolean;
  aimDirection: { x: number; y: number; z: number };
  spread: number;
  regions: readonly HistoricalHitRegionPose[];
}

interface HistoricalDestructiblePose {
  id: number;
  stableId: string;
  revision: number;
  hp: number;
  alive: boolean;
  type: string;
  material: string;
  x: number;
  y: number;
  z: number;
  halfX: number;
  halfY: number;
  halfZ: number;
}

interface HistoricalFrame {
  tick: number;
  actors: ReadonlyMap<number, HistoricalActorPose>;
  destructibles: readonly HistoricalDestructiblePose[];
}

interface DestructibleRevisionState {
  id: number;
  hp: number;
  alive: boolean;
  type: string;
  revision: number;
}

interface ShapeHit {
  dist: number;
  normal: { x: number; y: number; z: number };
}

/**
 * Short, host-only history for projectile latency compensation.
 *
 * `recordTick` is called after `Match.fixedUpdate` completes. Late shots are
 * authorized against the actor's live weapon state, spawned from the stored
 * shooter pose, then advanced through immutable world geometry plus pure
 * historical actor/destructible shapes. Live actor bodies, Rapier state, and
 * RNG state are never rewound, so there are no poses to leak or restore.
 */
export class HostLagCompensation {
  readonly tickRate: number;
  readonly maxRewindMs: number;
  readonly maxRewindTicks: number;

  private readonly tickDuration: number;
  private match: Match | null = null;
  private frames: HistoricalFrame[] = [];
  private readonly framesByTick = new Map<number, HistoricalFrame>();
  private readonly destructibleRevisions = new Map<string, DestructibleRevisionState>();

  constructor(
    tickRate = LAG_COMPENSATION_TICK_RATE,
    maxRewindMs = LAG_COMPENSATION_MAX_REWIND_MS,
  ) {
    if (!Number.isFinite(tickRate) || tickRate <= 0
      || !Number.isFinite(maxRewindMs) || maxRewindMs <= 0) {
      throw new RangeError('Lag compensation timing must be positive and finite');
    }
    this.tickRate = tickRate;
    this.maxRewindMs = maxRewindMs;
    this.tickDuration = 1 / tickRate;
    this.maxRewindTicks = Math.max(1, Math.round((tickRate * maxRewindMs) / 1000));
  }

  /** Capture one completed authoritative simulation tick by value. */
  recordTick(match: Match, hostTick: number): void {
    if (!isUint32(hostTick)) throw new RangeError('hostTick must be uint32');
    if (this.match !== match) this.resetForMatch(match);

    const previous = this.frames.at(-1);
    if (previous && previous.tick !== hostTick) {
      const forward = uint32Distance(hostTick, previous.tick);
      if (forward === 0 || forward >= UINT32_HALF_RANGE) {
        throw new RangeError('Completed host ticks must be recorded monotonically');
      }
    }

    const actors = new Map<number, HistoricalActorPose>();
    for (const actor of match.actors) {
      actors.set(actor.id, captureActorPose(actor, match));
    }

    const destructibles: HistoricalDestructiblePose[] = [];
    for (const destructible of match.combat.destructibleList()) {
      destructibles.push(this.captureDestructible(destructible));
    }
    destructibles.sort((a, b) => a.id - b.id || a.stableId.localeCompare(b.stableId));

    const frame: HistoricalFrame = { tick: hostTick, actors, destructibles };
    if (previous?.tick === hostTick) {
      this.frames[this.frames.length - 1] = frame;
    } else {
      this.frames.push(frame);
    }
    this.framesByTick.set(hostTick, frame);

    const capacity = this.maxRewindTicks + 1;
    while (this.frames.length > capacity) {
      const removed = this.frames.shift();
      if (removed && this.framesByTick.get(removed.tick) === removed) {
        this.framesByTick.delete(removed.tick);
      }
    }
  }

  /** Resolve one already rate-limited remote fire edge on the host. */
  resolveAcceptedShot(input: ResolveAcceptedShotInput): LagCompensationTelemetry {
    const base = {
      accepted: false,
      acceptedTick: null,
      rewindTicks: 0,
      clamped: false,
      catchupSubsteps: 0,
    } satisfies LagCompensationTelemetry;

    if (!isUint32(input.currentHostTick) || !isUint32(input.requestedShotTick)) {
      return { ...base, rejectedReason: 'invalid-tick' };
    }
    if (!Number.isFinite(input.dt) || input.dt <= 0) {
      return { ...base, rejectedReason: 'invalid-dt' };
    }

    const rewindTicks = uint32Distance(input.currentHostTick, input.requestedShotTick);
    if (rewindTicks >= UINT32_HALF_RANGE) {
      return { ...base, rewindTicks: 0, rejectedReason: 'future-shot' };
    }
    if (rewindTicks > this.maxRewindTicks) {
      return { ...base, rewindTicks, rejectedReason: 'excessive-rewind' };
    }
    if (!this.match || !this.match.actors.includes(input.actor)) {
      return { ...base, rewindTicks, rejectedReason: 'actor-unavailable' };
    }

    const historicalFrames: HistoricalFrame[] = [];
    for (let offset = 0; offset <= rewindTicks; offset++) {
      const tick = (input.requestedShotTick + offset) >>> 0;
      const frame = this.framesByTick.get(tick);
      if (!frame) {
        return { ...base, rewindTicks, rejectedReason: 'history-unavailable' };
      }
      historicalFrames.push(frame);
    }

    const shotFrame = historicalFrames[0]!;
    const shooterPose = shotFrame.actors.get(input.actor.id);
    if (!shooterPose?.alive) {
      return { ...base, rewindTicks, rejectedReason: 'actor-unavailable' };
    }

    const pose: AuthoritativeShotPose = {
      bodyPosition: shooterPose.bodyPosition,
      crouched: shooterPose.crouched,
      aimDirection: shooterPose.aimDirection,
      spread: shooterPose.spread,
    };
    const projectiles = this.match.combat.tryFireFromAuthoritativePose(input.actor, input.dt, pose, true);
    if (!projectiles) {
      return {
        ...base,
        rewindTicks,
        rejectedReason: 'fire-denied',
        errorDistance: canonicalMuzzleError(shooterPose, input.actor),
      };
    }

    const removedDuringCatchup = new Set<string>();
    let catchupSubsteps = 0;
    for (let tickOffset = 0; tickOffset < rewindTicks; tickOffset++) {
      const frame = historicalFrames[tickOffset]!;
      const query = this.historicalQuery(frame, input.actor, removedDuringCatchup);
      for (let substep = 0; substep < PROJECTILE_SUBSTEPS_PER_TICK; substep++) {
        for (const projectile of projectiles) {
          if (projectile.active) {
            this.match.combat.stepProjectileWithQuery(
              projectile,
              this.tickDuration / PROJECTILE_SUBSTEPS_PER_TICK,
              this.match.actors,
              query,
            );
          }
        }
        catchupSubsteps++;
        if (!projectiles.some((projectile) => projectile.active)) break;
      }
      if (!projectiles.some((projectile) => projectile.active)) break;
    }

    return {
      accepted: true,
      acceptedTick: input.requestedShotTick,
      rewindTicks,
      clamped: false,
      catchupSubsteps,
      errorDistance: canonicalMuzzleError(shooterPose, input.actor),
    };
  }

  private resetForMatch(match: Match): void {
    this.match = match;
    this.frames = [];
    this.framesByTick.clear();
    this.destructibleRevisions.clear();
  }

  private captureDestructible(destructible: DestructibleRef): HistoricalDestructiblePose {
    const previous = this.destructibleRevisions.get(destructible.stableId);
    const changed = previous !== undefined && (
      previous.id !== destructible.id
      || previous.hp !== destructible.hp
      || previous.alive !== destructible.alive
      || previous.type !== destructible.type
    );
    const revision = previous ? previous.revision + (changed ? 1 : 0) : 0;
    this.destructibleRevisions.set(destructible.stableId, {
      id: destructible.id,
      hp: destructible.hp,
      alive: destructible.alive,
      type: destructible.type,
      revision,
    });

    const geo = destructible.geo;
    const halfX = geo.kind === 'box' ? geo.sx / 2 : (geo.r ?? 0.5) * 0.85;
    const halfY = geo.kind === 'box' ? geo.sy / 2 : (geo.kind === 'cyl' ? geo.h : 1) / 2;
    const halfZ = geo.kind === 'box' ? geo.sz / 2 : (geo.r ?? 0.5) * 0.85;
    return {
      id: destructible.id,
      stableId: destructible.stableId,
      revision,
      hp: destructible.hp,
      alive: destructible.alive,
      type: destructible.type,
      material: destructibleMaterial(destructible.type),
      x: geo.x,
      y: geo.y,
      z: geo.z,
      halfX,
      halfY,
      halfZ,
    };
  }

  private historicalQuery(
    frame: HistoricalFrame,
    shooter: Actor,
    removedDuringCatchup: Set<string>,
  ): ProjectileCollisionQuery {
    return {
      raycast: (ox, oy, oz, dx, dy, dz, maxDist) => {
        let nearest = immutableWorldRaycast(this.match!.phys, ox, oy, oz, dx, dy, dz, maxDist);

        for (const destructible of frame.destructibles) {
          if (!destructible.alive || removedDuringCatchup.has(destructible.stableId)) continue;
          const shapeHit = rayAabb(
            ox, oy, oz, dx, dy, dz, maxDist,
            destructible.x - destructible.halfX,
            destructible.y - destructible.halfY,
            destructible.z - destructible.halfZ,
            destructible.x + destructible.halfX,
            destructible.y + destructible.halfY,
            destructible.z + destructible.halfZ,
          );
          if (!shapeHit || !isCloser(shapeHit.dist, nearest)) continue;
          nearest = {
            kind: 'destructible',
            destructibleId: destructible.id,
            stableId: destructible.stableId,
            destructibleType: destructible.type,
            material: destructible.material,
            point: pointAlongRay(ox, oy, oz, dx, dy, dz, shapeHit.dist),
            normal: shapeHit.normal,
            dist: shapeHit.dist,
          };
        }

        for (const actorPose of frame.actors.values()) {
          if (!actorPose.alive || actorPose.actorId === shooter.id) continue;
          const liveTarget = this.match!.actors.find((actor) => actor.id === actorPose.actorId);
          if (!liveTarget?.alive || !this.match!.combat.canAffectActor(shooter, liveTarget)) continue;
          for (const region of actorPose.regions) {
            const shapeHit = rayVerticalCapsule(
              ox, oy, oz, dx, dy, dz, maxDist,
              region.x, region.y, region.z, region.halfHeight, region.radius,
            );
            if (!shapeHit || !isCloser(shapeHit.dist, nearest)) continue;
            nearest = {
              kind: 'actor',
              actorId: actorPose.actorId,
              region: region.region,
              point: pointAlongRay(ox, oy, oz, dx, dy, dz, shapeHit.dist),
              normal: shapeHit.normal,
              dist: shapeHit.dist,
            };
          }
        }
        return nearest;
      },
      onDestructibleResolved: (hit, removed) => {
        if (removed) removedDuringCatchup.add(hit.stableId);
      },
    };
  }
}

const HIT_REGION_LAYOUT: ReadonlyArray<Readonly<{
  region: HitRegion;
  y: number;
  halfHeight: number;
  radius: number;
}>> = Object.freeze([
  // The movement capsule is also projectile-hittable and tagged as chest.
  { region: 'chest', y: 0, halfHeight: MOVE.capsuleHalfHeight, radius: MOVE.capsuleRadius },
  // Mirrors the authoritative CharBody hit-region layout in physics.ts.
  { region: 'head', y: 0.98, halfHeight: 0.06, radius: 0.24 },
  { region: 'chest', y: 0.52, halfHeight: 0.16, radius: 0.34 },
  { region: 'abdomen', y: 0.12, halfHeight: 0.14, radius: 0.32 },
  { region: 'arms', y: 0.42, halfHeight: 0.3, radius: 0.16 },
  { region: 'legs', y: -0.62, halfHeight: 0.28, radius: 0.26 },
]);

function captureActorPose(actor: Actor, match: Match): HistoricalActorPose {
  const bodyPosition = {
    x: actor.body.position.x,
    y: actor.body.position.y,
    z: actor.body.position.z,
  };
  return {
    actorId: actor.id,
    alive: actor.alive,
    bodyPosition,
    crouched: actor.crouched,
    aimDirection: lookDirection(actor.yaw, actor.pitch),
    spread: match.combat.currentSpread(actor),
    regions: HIT_REGION_LAYOUT.map((region) => ({
      region: region.region,
      x: bodyPosition.x,
      y: bodyPosition.y + region.y,
      z: bodyPosition.z,
      halfHeight: region.halfHeight,
      radius: region.radius,
    })),
  };
}

function canonicalMuzzleError(historical: HistoricalActorPose, live: Actor): number {
  const oldMuzzle = canonicalMuzzle(
    historical.bodyPosition,
    historical.crouched,
    historical.aimDirection,
  );
  const liveMuzzle = canonicalMuzzle(
    live.body.position,
    live.crouched,
    lookDirection(live.yaw, live.pitch),
  );
  return Math.hypot(
    oldMuzzle.x - liveMuzzle.x,
    oldMuzzle.y - liveMuzzle.y,
    oldMuzzle.z - liveMuzzle.z,
  );
}

function canonicalMuzzle(
  bodyPosition: Readonly<{ x: number; y: number; z: number }>,
  crouched: boolean,
  aim: Readonly<{ x: number; y: number; z: number }>,
): { x: number; y: number; z: number } {
  return {
    x: bodyPosition.x + aim.x * 0.7,
    y: eyeYFromBodyCenter(bodyPosition.y, crouched) + aim.y * 0.7 - 0.12,
    z: bodyPosition.z + aim.z * 0.7,
  };
}

function lookDirection(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

function immutableWorldRaycast(
  phys: PhysicsWorld,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): ProjectileCollisionHit | null {
  let travelled = 0;
  for (let pass = 0; pass < MAX_WORLD_SKIP_PASSES && travelled <= maxDist; pass++) {
    const hit = phys.raycast(
      ox + dx * travelled,
      oy + dy * travelled,
      oz + dz * travelled,
      dx, dy, dz,
      Math.max(0, maxDist - travelled),
      GROUPS.rayWorldOnly,
    );
    if (!hit) return null;
    const totalDist = travelled + hit.dist;
    const meta = phys.metaOf(hit.collider);
    if (meta?.kind === 'destructible') {
      travelled = totalDist + QUERY_EPSILON;
      continue;
    }
    return {
      kind: 'world',
      material: meta?.kind === 'world' ? meta.material ?? 'stone' : 'stone',
      point: hit.point,
      normal: hit.normal,
      dist: totalDist,
    };
  }

  // An adversarial corridor of more than the bounded skip count fails closed.
  if (travelled <= maxDist) {
    return {
      kind: 'world',
      material: 'stone',
      point: pointAlongRay(ox, oy, oz, dx, dy, dz, travelled),
      normal: oppositeDirection(dx, dy, dz),
      dist: travelled,
    };
  }
  return null;
}

function rayAabb(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): ShapeHit | null {
  let near = 0;
  let far = maxDist;
  let normal = oppositeDirection(dx, dy, dz);
  const axes = [
    { origin: ox, direction: dx, min: minX, max: maxX, nx: -1, ny: 0, nz: 0 },
    { origin: oy, direction: dy, min: minY, max: maxY, nx: 0, ny: -1, nz: 0 },
    { origin: oz, direction: dz, min: minZ, max: maxZ, nx: 0, ny: 0, nz: -1 },
  ] as const;
  for (const axis of axes) {
    if (Math.abs(axis.direction) < 1e-9) {
      if (axis.origin < axis.min || axis.origin > axis.max) return null;
      continue;
    }
    let enter = (axis.min - axis.origin) / axis.direction;
    let exit = (axis.max - axis.origin) / axis.direction;
    let enterNormal: { x: number; y: number; z: number } = {
      x: axis.nx,
      y: axis.ny,
      z: axis.nz,
    };
    if (enter > exit) {
      [enter, exit] = [exit, enter];
      enterNormal = { x: -axis.nx, y: -axis.ny, z: -axis.nz };
    }
    if (enter > near) {
      near = enter;
      normal = enterNormal;
    }
    far = Math.min(far, exit);
    if (near > far) return null;
  }
  return near <= maxDist && far >= 0 ? { dist: Math.max(0, near), normal } : null;
}

function rayVerticalCapsule(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  cx: number, cy: number, cz: number,
  halfHeight: number,
  radius: number,
): ShapeHit | null {
  const closestY = Math.max(cy - halfHeight, Math.min(cy + halfHeight, oy));
  const insideX = ox - cx;
  const insideY = oy - closestY;
  const insideZ = oz - cz;
  if (insideX * insideX + insideY * insideY + insideZ * insideZ <= radius * radius) {
    return { dist: 0, normal: oppositeDirection(dx, dy, dz) };
  }

  let best: ShapeHit | null = null;
  const horizontalA = dx * dx + dz * dz;
  if (horizontalA > 1e-12) {
    const relX = ox - cx;
    const relZ = oz - cz;
    const b = 2 * (relX * dx + relZ * dz);
    const c = relX * relX + relZ * relZ - radius * radius;
    const discriminant = b * b - 4 * horizontalA * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const candidates = [
        (-b - root) / (2 * horizontalA),
        (-b + root) / (2 * horizontalA),
      ];
      for (const dist of candidates) {
        if (dist < 0 || dist > maxDist) continue;
        const hitY = oy + dy * dist;
        if (hitY < cy - halfHeight || hitY > cy + halfHeight) continue;
        const hitX = ox + dx * dist;
        const hitZ = oz + dz * dist;
        const length = Math.hypot(hitX - cx, hitZ - cz) || 1;
        best = {
          dist,
          normal: { x: (hitX - cx) / length, y: 0, z: (hitZ - cz) / length },
        };
        break;
      }
    }
  }

  for (const sphereY of [cy - halfHeight, cy + halfHeight]) {
    const sphereHit = raySphere(ox, oy, oz, dx, dy, dz, maxDist, cx, sphereY, cz, radius);
    if (sphereHit && (!best || sphereHit.dist < best.dist)) best = sphereHit;
  }
  return best;
}

function raySphere(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  cx: number, cy: number, cz: number,
  radius: number,
): ShapeHit | null {
  const rx = ox - cx;
  const ry = oy - cy;
  const rz = oz - cz;
  const b = rx * dx + ry * dy + rz * dz;
  const c = rx * rx + ry * ry + rz * rz - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const dist = -b - Math.sqrt(discriminant);
  if (dist < 0 || dist > maxDist) return null;
  const hit = pointAlongRay(ox, oy, oz, dx, dy, dz, dist);
  const length = Math.hypot(hit.x - cx, hit.y - cy, hit.z - cz) || 1;
  return {
    dist,
    normal: {
      x: (hit.x - cx) / length,
      y: (hit.y - cy) / length,
      z: (hit.z - cz) / length,
    },
  };
}

function pointAlongRay(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  dist: number,
): { x: number; y: number; z: number } {
  return { x: ox + dx * dist, y: oy + dy * dist, z: oz + dz * dist };
}

function oppositeDirection(dx: number, dy: number, dz: number): { x: number; y: number; z: number } {
  const length = Math.hypot(dx, dy, dz) || 1;
  return { x: -dx / length, y: -dy / length, z: -dz / length };
}

function isCloser(dist: number, current: ProjectileCollisionHit | null): boolean {
  return dist >= 0 && (!current || dist < current.dist - 1e-7);
}

function destructibleMaterial(type: string): string {
  switch (type) {
    case 'glass': return 'glass';
    case 'crate':
    case 'fence':
    case 'furniture': return 'wood';
    case 'lamp':
    case 'sign': return 'metal';
    default: return 'stone';
  }
}

function isUint32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX;
}

function uint32Distance(later: number, earlier: number): number {
  return (later - earlier) >>> 0;
}
