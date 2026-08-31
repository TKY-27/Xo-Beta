/**
 * Guest-local movement prediction backed by the exact authoritative movement
 * rules and Rapier character controller.
 *
 * This world intentionally contains one Actor and static movement collision
 * only. It never constructs Match, CombatSystem, Bot controllers, loot,
 * storm, results, or any other gameplay authority.
 */

import type { WeaponId } from '../core/balance';
import { Actor, type MoveState } from '../sim/actor';
import { emptyCommand, type InputCommand } from '../sim/input';
import { MovementSystem, type MovementEvents } from '../sim/movement';
import { CharBody, PhysicsWorld } from '../physics/physics';
import {
  buildColliders,
  filterInvalidCrates,
  groundCrates,
  resolveSupportedChests,
} from '../world/builder';
import { ensureWorldReady, loadMap, type MapId } from '../world';
import type { DestructibleSpec, MapDef, WaterVolume } from '../world/types';
import type { ChestView } from '../sim/gameStateView';
import type { MovementStep, PredictionState, PredictionVector3 } from './prediction';

const FIXED_STEP = 1 / 60;
const PITCH_LIMIT = Math.PI / 2 - 0.02;

export interface ClientMovementPredictionState extends PredictionState {
  position: PredictionVector3;
  velocity: PredictionVector3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  state: MoveState;
  movementEnabled: boolean;
  deployed: boolean;
  crouched: boolean;
  groundNormalY: number;
  hitCeiling: boolean;
  slidAlongWall: boolean;
  slideTimer: number;
  slideDirX: number;
  slideDirZ: number;
  slideCooldown: number;
  wallrunTimer: number;
  wallSide: number;
  wallNormalX: number;
  wallNormalZ: number;
  mantleTimer: number;
  mantleCooldown: number;
  mantleFrom: PredictionVector3;
  mantleTo: PredictionVector3;
  grappleActive: boolean;
  grapplePoint: PredictionVector3;
  grappleCooldown: number;
  dashCharges: number;
  dashRegen: number;
  dashTimer: number;
  dashDirX: number;
  dashDirZ: number;
  jumpsUsed: number;
  coyote: number;
  jumpBuffered: number;
  bhopWindow: number;
  wallrunCooldown: number;
  wallrunLanded: boolean;
  wallrunChains: number;
  lastWallNx: number;
  lastWallNz: number;
  peakFallSpeed: number;
  airborneGroundTime: number;
  poundTimer: number;
  footstepAccum: number;
  inWater: boolean;
  submerged: boolean;
  waterSurfaceY: number;
  /** Read-only mobility context copied from authority, never selected locally. */
  equippedWeapon: WeaponId | null;
  /** Read-only ADS blend copied from authority. */
  adsAmount: number;
  /** Read-only healing slowdown copied from authority. */
  healingMovementPenalty: boolean;
}

export interface ClientDestructibleMovementState {
  readonly id: string;
  readonly revision: number;
  readonly destroyed: boolean;
}

export interface ClientMovementPredictionOptions {
  readonly mapId?: MapId;
  /** A fresh MapDef may be supplied by deterministic tests and start-payload loaders. */
  readonly mapDef?: MapDef;
  readonly actorId: number;
  readonly initialState: ClientMovementPredictionState;
  readonly displayName?: string;
  readonly accentColor?: number;
}

interface DestructibleColliderState {
  readonly numericId: number;
  readonly spec: DestructibleSpec;
  revision: number;
  destroyed: boolean;
  collider: ReturnType<PhysicsWorld['addDestructibleBox']> | null;
}

/** Actor variant that preserves movement behavior but cannot predict damage. */
class PredictionActor extends Actor {
  override applyDamage(_amount: number): number {
    return 0;
  }
}

function vector(value: Readonly<PredictionVector3>): PredictionVector3 {
  return { x: value.x, y: value.y, z: value.z };
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`Invalid movement prediction ${label}`);
  return value;
}

function finiteVector(value: Readonly<PredictionVector3>, label: string): void {
  finite(value.x, `${label}.x`);
  finite(value.y, `${label}.y`);
  finite(value.z, `${label}.z`);
}

function clampPitch(value: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, value));
}

function movementOnlyCommand(input: Readonly<InputCommand>): InputCommand {
  const command = emptyCommand();
  command.moveX = input.moveX;
  command.moveZ = input.moveZ;
  command.yaw = input.yaw;
  command.pitch = input.pitch;
  command.jumpPressed = input.jumpPressed;
  command.jumpHeld = input.jumpHeld;
  command.sprint = input.sprint;
  command.crouchHeld = input.crouchHeld;
  command.crouchPressed = input.crouchPressed;
  command.dashPressed = input.dashPressed;
  command.grapplePressed = input.grapplePressed;
  command.grappleRelease = input.grappleRelease;
  command.poundPressed = input.poundPressed;
  return command;
}

function waterAt(volumes: readonly WaterVolume[], x: number, y: number, z: number): WaterVolume | null {
  for (const volume of volumes) {
    if (x >= volume.minX && x <= volume.maxX && z >= volume.minZ && z <= volume.maxZ
      && y >= volume.surfaceY - volume.depth - 0.5 && y <= volume.surfaceY + 2) {
      return volume;
    }
  }
  return null;
}

function destructibleMaterial(type: DestructibleSpec['type']): 'stone' | 'metal' | 'wood' | 'glass' {
  switch (type) {
    case 'glass': return 'glass';
    case 'crate':
    case 'fence':
    case 'furniture': return 'wood';
    case 'lamp':
    case 'sign': return 'metal';
    case 'vegetation': return 'stone';
  }
}

function noMovementEvents(): MovementEvents {
  return {
    onFootstep: () => undefined,
    onLand: () => undefined,
    onJump: () => undefined,
    onSlide: () => undefined,
    onWallrunStart: () => undefined,
    onMantle: () => undefined,
    onGrappleAttach: () => undefined,
    onGrappleRelease: () => undefined,
    onPoundImpact: () => undefined,
    onDash: () => undefined,
    onSplash: () => undefined,
  };
}

export function createClientMovementPredictionState(
  position: Readonly<PredictionVector3>,
  overrides: Partial<ClientMovementPredictionState> = {},
): ClientMovementPredictionState {
  const zero = { x: 0, y: 0, z: 0 };
  return {
    position: vector(position),
    velocity: vector(overrides.velocity ?? zero),
    yaw: overrides.yaw ?? 0,
    pitch: overrides.pitch ?? 0,
    grounded: overrides.grounded ?? false,
    state: overrides.state ?? 'air',
    movementEnabled: overrides.movementEnabled ?? true,
    deployed: overrides.deployed ?? true,
    crouched: overrides.crouched ?? false,
    groundNormalY: overrides.groundNormalY ?? 1,
    hitCeiling: overrides.hitCeiling ?? false,
    slidAlongWall: overrides.slidAlongWall ?? false,
    slideTimer: overrides.slideTimer ?? 0,
    slideDirX: overrides.slideDirX ?? 0,
    slideDirZ: overrides.slideDirZ ?? 0,
    slideCooldown: overrides.slideCooldown ?? 0,
    wallrunTimer: overrides.wallrunTimer ?? 0,
    wallSide: overrides.wallSide ?? 0,
    wallNormalX: overrides.wallNormalX ?? 0,
    wallNormalZ: overrides.wallNormalZ ?? 0,
    mantleTimer: overrides.mantleTimer ?? 0,
    mantleCooldown: overrides.mantleCooldown ?? 0,
    mantleFrom: vector(overrides.mantleFrom ?? position),
    mantleTo: vector(overrides.mantleTo ?? position),
    grappleActive: overrides.grappleActive ?? false,
    grapplePoint: vector(overrides.grapplePoint ?? zero),
    grappleCooldown: overrides.grappleCooldown ?? 0,
    dashCharges: overrides.dashCharges ?? 2,
    dashRegen: overrides.dashRegen ?? 0,
    dashTimer: overrides.dashTimer ?? 0,
    dashDirX: overrides.dashDirX ?? 0,
    dashDirZ: overrides.dashDirZ ?? 0,
    jumpsUsed: overrides.jumpsUsed ?? 0,
    coyote: overrides.coyote ?? 0,
    jumpBuffered: overrides.jumpBuffered ?? 0,
    bhopWindow: overrides.bhopWindow ?? 0,
    wallrunCooldown: overrides.wallrunCooldown ?? 0,
    wallrunLanded: overrides.wallrunLanded ?? true,
    wallrunChains: overrides.wallrunChains ?? 0,
    lastWallNx: overrides.lastWallNx ?? 0,
    lastWallNz: overrides.lastWallNz ?? 0,
    peakFallSpeed: overrides.peakFallSpeed ?? 0,
    airborneGroundTime: overrides.airborneGroundTime ?? 0,
    poundTimer: overrides.poundTimer ?? 0,
    footstepAccum: overrides.footstepAccum ?? 0,
    inWater: overrides.inWater ?? false,
    submerged: overrides.submerged ?? false,
    waterSurfaceY: overrides.waterSurfaceY ?? Number.NEGATIVE_INFINITY,
    equippedWeapon: overrides.equippedWeapon ?? null,
    adsAmount: overrides.adsAmount ?? 0,
    healingMovementPenalty: overrides.healingMovementPenalty ?? false,
  };
}

/**
 * One-actor movement world suitable for LocalMovementPrediction.movementStep.
 * All mutable gameplay state lives outside this class on the host.
 */
export class ClientMovementPredictionWorld {
  static async create(options: ClientMovementPredictionOptions): Promise<ClientMovementPredictionWorld> {
    await ensureWorldReady();
    const mapDef = options.mapDef ?? (options.mapId ? loadMap(options.mapId).def : null);
    if (!mapDef) throw new Error('Client movement prediction requires mapId or mapDef');
    return new ClientMovementPredictionWorld(mapDef, options);
  }

  readonly movementStep: MovementStep<ClientMovementPredictionState>;
  /** Deterministic presentation seed matching Match's supported chest order. */
  readonly supportedChests: readonly ChestView[];

  private readonly phys: PhysicsWorld;
  private readonly actor: PredictionActor;
  private readonly movement: MovementSystem;
  private readonly destructibles = new Map<string, DestructibleColliderState>();
  private transportDeploymentAllowed = false;
  private disposed = false;

  private constructor(mapDef: MapDef, options: ClientMovementPredictionOptions) {
    this.phys = new PhysicsWorld();
    buildColliders(mapDef, this.phys);
    this.phys.flush();

    // Mirror Match's canonical movement-collider preparation order.
    groundCrates(mapDef, this.phys);
    filterInvalidCrates(mapDef);
    const chests = resolveSupportedChests(mapDef, this.phys);
    this.supportedChests = Object.freeze(chests.map((chest, index) => Object.freeze({
      id: index + 1,
      kind: chest.kind,
      x: chest.x,
      y: chest.y,
      z: chest.z,
      opened: false,
    })));
    for (const chest of chests) {
      this.phys.addStaticBox(chest.x, chest.y + 0.4, chest.z, 0.55, 0.4, 0.38, 0, 'wood');
    }

    let numericId = 1;
    for (const spec of mapDef.destructibles) {
      const entry: DestructibleColliderState = {
        numericId,
        spec,
        revision: 0,
        destroyed: false,
        collider: null,
      };
      entry.collider = this.createDestructibleCollider(entry);
      this.destructibles.set(spec.stableId, entry);
      numericId += 1;
    }
    this.phys.flush();

    const initial = options.initialState;
    finiteVector(initial.position, 'position');
    const body = new CharBody(
      this.phys,
      options.actorId,
      initial.position.x,
      initial.position.y,
      initial.position.z,
    );
    this.actor = new PredictionActor(
      options.displayName ?? 'LOCAL PREDICTION',
      body,
      options.accentColor ?? 0x5fd0ff,
    );
    this.movement = new MovementSystem(this.phys, noMovementEvents());
    this.movement.bounds = { half: mapDef.size / 2 - 8 };
    this.movement.waterAt = (x, y, z) => waterAt(mapDef.water, x, y, z);
    this.restoreState(initial);
    this.movementStep = (state, input, dt) => this.step(state, input, dt);
  }

  setTransportDeploymentAllowed(allowed: boolean): void {
    this.assertUsable();
    this.transportDeploymentAllowed = allowed;
  }

  /** Restore a complete host-authoritative movement baseline. */
  syncAuthoritative(state: Readonly<ClientMovementPredictionState>): ClientMovementPredictionState {
    this.assertUsable();
    this.restoreState(state);
    return this.captureState();
  }

  /**
   * Apply a full or delta destructible projection by stable ID and revision.
   * No local input path can call this, so glass never becomes guest authority.
   */
  syncDestructibles(states: readonly ClientDestructibleMovementState[]): number {
    this.assertUsable();
    let changed = 0;
    let addedCollider = false;
    for (const state of states) {
      if (!Number.isSafeInteger(state.revision) || state.revision < 0) continue;
      const entry = this.destructibles.get(state.id);
      if (!entry || state.revision <= entry.revision) continue;
      entry.revision = state.revision;
      if (entry.destroyed === state.destroyed) continue;
      entry.destroyed = state.destroyed;
      if (state.destroyed) {
        if (entry.collider) this.phys.removeCollider(entry.collider);
        entry.collider = null;
      } else if (!entry.collider) {
        entry.collider = this.createDestructibleCollider(entry);
        addedCollider = true;
      }
      changed += 1;
    }
    if (addedCollider) this.phys.flush();
    return changed;
  }

  destructibleState(id: string): ClientDestructibleMovementState | null {
    const entry = this.destructibles.get(id);
    return entry ? Object.freeze({ id, revision: entry.revision, destroyed: entry.destroyed }) : null;
  }

  captureState(): ClientMovementPredictionState {
    this.assertUsable();
    const actor = this.actor;
    const body = actor.body;
    return {
      position: vector(body.position),
      velocity: vector(body.velocity),
      yaw: actor.yaw,
      pitch: actor.pitch,
      grounded: body.grounded,
      state: actor.state,
      movementEnabled: actor.alive,
      deployed: actor.deployed,
      crouched: actor.crouched,
      groundNormalY: body.groundNormalY,
      hitCeiling: body.hitCeiling,
      slidAlongWall: body.slidAlongWall,
      slideTimer: actor.slideTimer,
      slideDirX: actor.slideDirX,
      slideDirZ: actor.slideDirZ,
      slideCooldown: actor.slideCooldown,
      wallrunTimer: actor.wallrunTimer,
      wallSide: actor.wallSide,
      wallNormalX: actor.wallNormalX,
      wallNormalZ: actor.wallNormalZ,
      mantleTimer: actor.mantleTimer,
      mantleCooldown: actor.mantleCooldown,
      mantleFrom: vector(actor.mantleFrom),
      mantleTo: vector(actor.mantleTo),
      grappleActive: actor.grappleActive,
      grapplePoint: vector(actor.grapplePoint),
      grappleCooldown: actor.grappleCooldown,
      dashCharges: actor.dashCharges,
      dashRegen: actor.dashRegen,
      dashTimer: actor.dashTimer,
      dashDirX: actor.dashDirX,
      dashDirZ: actor.dashDirZ,
      jumpsUsed: actor.jumpsUsed,
      coyote: actor.coyote,
      jumpBuffered: actor.jumpBuffered,
      bhopWindow: actor.bhopWindow,
      wallrunCooldown: actor.wallrunCooldown,
      wallrunLanded: actor.wallrunLanded,
      wallrunChains: actor.wallrunChains,
      lastWallNx: actor.lastWallNx,
      lastWallNz: actor.lastWallNz,
      peakFallSpeed: actor.peakFallSpeed,
      airborneGroundTime: actor.airborneGroundTime,
      poundTimer: actor.poundTimer,
      footstepAccum: actor.footstepAccum,
      inWater: actor.inWater,
      submerged: actor.submerged,
      waterSurfaceY: actor.waterSurfaceY,
      equippedWeapon: actor.inv.selectedWeapon?.weaponId ?? null,
      adsAmount: actor.wpn.adsAmount,
      healingMovementPenalty: actor.healing !== null,
    };
  }

  /** Read-only camera collision query for replica presentation. */
  cameraCast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    radius = 0.2,
  ): { dist: number } | null {
    this.assertUsable();
    return this.phys.cameraCast(ox, oy, oz, dx, dy, dz, maxDist, radius);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.actor.body.dispose();
    this.phys.dispose();
    this.destructibles.clear();
  }

  private step(
    state: ClientMovementPredictionState,
    input: InputCommand,
    dt: number,
  ): ClientMovementPredictionState {
    this.assertUsable();
    if (!Number.isFinite(dt) || Math.abs(dt - FIXED_STEP) > 1e-6) {
      throw new Error('Client movement prediction must step at 60 Hz');
    }
    this.restoreState(state);
    const command = movementOnlyCommand(input);
    finite(command.moveX, 'input.moveX');
    finite(command.moveZ, 'input.moveZ');
    finite(command.yaw, 'input.yaw');
    finite(command.pitch, 'input.pitch');

    if (!this.actor.alive) return this.captureState();
    this.actor.yaw = command.yaw;
    this.actor.pitch = clampPitch(command.pitch);

    if (!this.actor.deployed) {
      if (this.transportDeploymentAllowed && command.jumpPressed) {
        // Match performs this handoff in updateTransport and begins movement
        // on the next fixed tick; preserve that exact one-tick boundary.
        this.movement.beginFreefall(this.actor);
      }
      this.phys.fixedStep(dt);
      return this.captureState();
    }

    if (command.grapplePressed) {
      if (this.actor.grappleActive) this.movement.releaseGrapple(this.actor);
      else this.movement.tryGrapple(this.actor);
    }
    if (command.grappleRelease) this.movement.releaseGrapple(this.actor);
    this.movement.update(this.actor, command, dt);
    this.phys.fixedStep(dt);
    return this.captureState();
  }

  private restoreState(state: Readonly<ClientMovementPredictionState>): void {
    finiteVector(state.position, 'position');
    finiteVector(state.velocity, 'velocity');
    finiteVector(state.mantleFrom, 'mantleFrom');
    finiteVector(state.mantleTo, 'mantleTo');
    finiteVector(state.grapplePoint, 'grapplePoint');
    const actor = this.actor;
    const body = actor.body;
    body.teleport(state.position.x, state.position.y, state.position.z);
    body.velocity.x = state.velocity.x;
    body.velocity.y = state.velocity.y;
    body.velocity.z = state.velocity.z;
    body.grounded = state.grounded;
    body.groundNormalY = finite(state.groundNormalY, 'groundNormalY');
    body.hitCeiling = state.hitCeiling;
    body.slidAlongWall = state.slidAlongWall;
    actor.alive = state.movementEnabled;
    actor.yaw = finite(state.yaw, 'yaw');
    actor.pitch = clampPitch(finite(state.pitch, 'pitch'));
    actor.state = state.state;
    actor.deployed = state.deployed;
    actor.crouched = state.crouched;
    actor.slideTimer = finite(state.slideTimer, 'slideTimer');
    actor.slideDirX = finite(state.slideDirX, 'slideDirX');
    actor.slideDirZ = finite(state.slideDirZ, 'slideDirZ');
    actor.slideCooldown = finite(state.slideCooldown, 'slideCooldown');
    actor.wallrunTimer = finite(state.wallrunTimer, 'wallrunTimer');
    actor.wallSide = finite(state.wallSide, 'wallSide');
    actor.wallNormalX = finite(state.wallNormalX, 'wallNormalX');
    actor.wallNormalZ = finite(state.wallNormalZ, 'wallNormalZ');
    actor.mantleTimer = finite(state.mantleTimer, 'mantleTimer');
    actor.mantleCooldown = finite(state.mantleCooldown, 'mantleCooldown');
    actor.mantleFrom = vector(state.mantleFrom);
    actor.mantleTo = vector(state.mantleTo);
    actor.grappleActive = state.grappleActive;
    actor.grapplePoint = vector(state.grapplePoint);
    actor.grappleCooldown = finite(state.grappleCooldown, 'grappleCooldown');
    actor.dashCharges = finite(state.dashCharges, 'dashCharges');
    actor.dashRegen = finite(state.dashRegen, 'dashRegen');
    actor.dashTimer = finite(state.dashTimer, 'dashTimer');
    actor.dashDirX = finite(state.dashDirX, 'dashDirX');
    actor.dashDirZ = finite(state.dashDirZ, 'dashDirZ');
    actor.jumpsUsed = finite(state.jumpsUsed, 'jumpsUsed');
    actor.coyote = finite(state.coyote, 'coyote');
    actor.jumpBuffered = finite(state.jumpBuffered, 'jumpBuffered');
    actor.bhopWindow = finite(state.bhopWindow, 'bhopWindow');
    actor.wallrunCooldown = finite(state.wallrunCooldown, 'wallrunCooldown');
    actor.wallrunLanded = state.wallrunLanded;
    actor.wallrunChains = finite(state.wallrunChains, 'wallrunChains');
    actor.lastWallNx = finite(state.lastWallNx, 'lastWallNx');
    actor.lastWallNz = finite(state.lastWallNz, 'lastWallNz');
    actor.peakFallSpeed = finite(state.peakFallSpeed, 'peakFallSpeed');
    actor.airborneGroundTime = finite(state.airborneGroundTime, 'airborneGroundTime');
    actor.poundTimer = finite(state.poundTimer, 'poundTimer');
    actor.footstepAccum = finite(state.footstepAccum, 'footstepAccum');
    actor.inWater = state.inWater;
    actor.submerged = state.submerged;
    actor.waterSurfaceY = state.waterSurfaceY;

    // These values are authoritative movement context only. Input slot/heal
    // requests were stripped above and can never mutate them locally.
    actor.inv.slots.fill(null);
    actor.inv.selected = -1;
    if (state.equippedWeapon !== null) {
      actor.inv.slots[0] = {
        kind: 'weapon',
        weaponId: state.equippedWeapon,
        rarity: 'common',
        ammoInMag: 0,
      };
      actor.inv.selected = 0;
    }
    actor.wpn.adsAmount = Math.max(0, Math.min(1, finite(state.adsAmount, 'adsAmount')));
    actor.healing = state.healingMovementPenalty
      ? { itemId: 'medkit', remaining: 1, total: 1 }
      : null;
  }

  private createDestructibleCollider(entry: DestructibleColliderState): ReturnType<PhysicsWorld['addDestructibleBox']> {
    const geo = entry.spec.geo;
    const material = destructibleMaterial(entry.spec.type);
    if (geo.kind === 'box') {
      return this.phys.addDestructibleBox(
        entry.numericId,
        geo.x,
        geo.y,
        geo.z,
        geo.sx / 2,
        geo.sy / 2,
        geo.sz / 2,
        material,
      );
    }
    const radius = geo.r * 0.85;
    // Keep the non-box approximation byte-for-byte equivalent to Match's
    // collider dimensions so a guest cannot traverse a different shape.
    const halfHeight = geo.kind === 'cyl' ? geo.h / 2 : 0.5;
    return this.phys.addDestructibleBox(
      entry.numericId,
      geo.x,
      geo.y,
      geo.z,
      radius,
      halfHeight,
      radius,
      material,
    );
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Client movement prediction world is disposed');
  }
}
