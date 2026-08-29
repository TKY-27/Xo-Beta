/**
 * Shared character movement simulation (player + bots use identical rules).
 *
 * States: ground / air / slide / wallrun / mantle / grapple / poundWindup /
 * poundFall / swim / freefall / glide.
 */

import { MATCH, MOVE } from '../core/balance';
import type { Actor, MoveState } from './actor';
import type { InputCommand } from './input';
import {
  CAPSULE_CENTER_OFFSET,
  feetYFromBodyCenter,
  GROUPS,
  type PhysicsWorld,
} from '../physics/physics';
import type { WaterVolume } from '../world/types';

// Compatibility exports for existing simulation and test imports. The
// definitions live beside CharBody, which owns the coordinate contract.
export { CAPSULE_CENTER_OFFSET, feetYFromBodyCenter } from '../physics/physics';

export interface MovementEvents {
  onFootstep(actor: Actor, running: boolean): void;
  onLand(actor: Actor, impactSpeed: number, fallDamage: number): void;
  onJump(actor: Actor, kind: 'jump' | 'double' | 'wall' | 'slide' | 'bhop'): void;
  onSlide(actor: Actor): void;
  onWallrunStart(actor: Actor): void;
  onMantle(actor: Actor): void;
  onGrappleAttach(actor: Actor): void;
  onGrappleRelease(actor: Actor): void;
  onPoundImpact(actor: Actor, x: number, y: number, z: number): void;
  onDash(actor: Actor): void;
  onSplash(actor: Actor, heavy: boolean): void;
}

const FWD = { x: 0, z: -1 };

/**
 * Yaw convention matches the render camera (three.js Euler YXZ): forward =
 * (-sin yaw, -cos yaw) so yaw 0 faces -Z. The right axis is (cos, -sin).
 */
function yawDir(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/** Local right axis for a facing produced by yawDir. */
function rightOf(fwd: { x: number; z: number }): { x: number; z: number } {
  return { x: -fwd.z, z: fwd.x };
}

export class MovementSystem {
  /** Playable bounds injected by match (soft-clamped during flight states). */
  bounds = { half: 245 };

  constructor(
    public phys: PhysicsWorld,
    public events: MovementEvents,
  ) {}

  /** Water lookup injected by match (map-dependent). */
  waterAt: (x: number, y: number, z: number) => WaterVolume | null = () => null;

  update(a: Actor, cmd: InputCommand, dt: number): void {
    if (!a.alive) return;

    this.updateTimers(a, cmd, dt);
    this.updateWaterState(a);

    switch (a.state) {
      case 'mantle':
        this.updateMantle(a, dt);
        break;
      case 'poundWindup':
        this.updatePoundWindup(a, dt);
        break;
      case 'poundFall':
        if (a.inWater) {
          this.enterSwim(a);
          break;
        }
        this.updatePoundFall(a, dt);
        break;
      case 'freefall':
        this.updateFreefall(a, cmd, dt);
        return; // flight states enforce bounds in clampFlightBounds
      case 'glide':
        this.updateGlide(a, cmd, dt);
        return; // flight states enforce bounds in clampFlightBounds
      case 'swim':
        this.updateSwim(a, cmd, dt);
        break;
      case 'wallrun':
        this.updateWallrun(a, cmd, dt);
        break;
      case 'slide':
        this.updateSlide(a, cmd, dt);
        break;
      default:
        this.updateGroundAir(a, cmd, dt);
        break;
    }
    // Hard playable-area enforcement for every grounded/traversal state.
    // (Flight states enforce their own bounds inside their updaters.)
    this.clampToBounds(a);
  }

  /**
   * Absolute map boundary: no walking, sprinting, dashing, bunny hopping,
   * sliding, wall-running or swimming out of the playable world.
   */
  private clampToBounds(a: Actor): void {
    const p = a.body.position;
    const lim = this.bounds.half;
    const v = a.body.velocity;
    let clamped = false;
    if (p.x > lim) { p.x = lim; clamped = true; }
    else if (p.x < -lim) { p.x = -lim; clamped = true; }
    if (p.z > lim) { p.z = lim; clamped = true; }
    else if (p.z < -lim) { p.z = -lim; clamped = true; }
    // Zero outward velocity on the axes that were clamped.
    if (p.x >= lim && v.x > 0) v.x = 0;
    if (p.x <= -lim && v.x < 0) v.x = 0;
    if (p.z >= lim && v.z > 0) v.z = 0;
    if (p.z <= -lim && v.z < 0) v.z = 0;
    if (clamped) {
      // move() already computed valid floor/wall contact and queued an
      // unconstrained kinematic target. Replacing that pending translation is
      // sufficient. teleport() clears the KCC contact flags; doing it on every
      // outward input tick left a supported boundary actor permanently in
      // state='air' / grounded=false even though its capsule never left the
      // floor. Preserve the just-computed contact state and locomotion state.
      a.body.body.setNextKinematicTranslation(p);
    }
    // Kill-plane failsafe: never fall forever below the world.
    if (p.y < -60) {
      const surf = this.phys.surfaceAt(p.x, p.z, 80, 200);
      v.x = 0; v.y = 0; v.z = 0;
      const placement = this.phys.findClearStandingPlacement(p.x, surf ?? 0, p.z, a.body.body);
      if (placement) a.body.teleport(placement.x, placement.y, placement.z);
      else a.body.teleport(p.x, Math.max(surf ?? 0, 0) + 30, p.z);
      a.state = 'air';
      a.peakFallSpeed = 0;
    }
  }

  private updateTimers(a: Actor, cmd: InputCommand, dt: number): void {
    if (a.grappleCooldown > 0) a.grappleCooldown -= dt;
    if (a.slideCooldown > 0) a.slideCooldown -= dt;
    if (a.coyote > 0) a.coyote -= dt;
    if (a.jumpBuffered > 0) a.jumpBuffered -= dt;
    if (a.bhopWindow > 0) a.bhopWindow -= dt;
    if (a.wallrunCooldown > 0) a.wallrunCooldown -= dt;
    if (cmd.jumpPressed) a.jumpBuffered = MOVE.jumpBufferTime;

    // Dash charge regen (grounded only)
    const maxCharges = MOVE.dashChargesGround;
    if (a.dashCharges < maxCharges && a.body.grounded) {
      a.dashRegen += dt;
      if (a.dashRegen >= MOVE.dashRegenTime) {
        a.dashRegen -= MOVE.dashRegenTime;
        a.dashCharges = Math.min(maxCharges, a.dashCharges + 1);
      }
    }
    if (a.dashTimer > 0) a.dashTimer -= dt;

    // Crouch state (hold)
    const wasCrouched = a.crouched;
    a.crouched = cmd.crouchHeld && a.state !== 'slide' && a.body.grounded;
    if (wasCrouched && !a.crouched) {
      // headroom check before standing
      const p = a.body.position;
      const feetY = feetYFromBodyCenter(p.y);
      // The probe begins inside the actor capsule, so an all-groups ray would
      // immediately hit the character's own gameplay colliders and make
      // crouch impossible to release. Only scenery can obstruct standing.
      const hit = this.phys.raycast(p.x, feetY + MOVE.crouchEyeHeight, p.z, 0, 1, 0,
        MOVE.eyeHeight - MOVE.crouchEyeHeight, GROUPS.rayWorldOnly);
      if (hit) a.crouched = true;
    }
  }

  private updateWaterState(a: Actor): void {
    const p = a.body.position;
    const feetY = feetYFromBodyCenter(p.y);
    const torsoY = feetY + 1.0;
    const vol = this.waterAt(p.x, torsoY, p.z);
    if (vol && torsoY < vol.surfaceY - 0.55) {
      // Publish the finite authored surface before emitting entry effects.
      // Actors initialize this field to -Infinity; emitting first forwarded
      // that sentinel to WebAudio's panner and threw an AudioParam exception.
      a.waterSurfaceY = vol.surfaceY;
      if (!a.inWater && a.state !== 'freefall' && a.state !== 'glide') {
        this.events.onSplash(a, Math.hypot(a.body.velocity.x, a.body.velocity.z, a.body.velocity.y) > 14);
      }
      a.inWater = true;
      a.submerged = feetY + 1.9 < vol.surfaceY;
      if (a.state !== 'swim' && a.state !== 'freefall' && a.state !== 'glide' &&
          a.state !== 'mantle' && a.state !== 'poundFall') {
        this.enterSwim(a);
      }
    } else {
      const shallow = vol !== null;
      a.inWater = false;
      a.submerged = false;
      if (shallow) a.waterSurfaceY = vol!.surfaceY;
      if (a.state === 'swim' && !shallow) {
        const ground = this.phys.surfaceAt(p.x, p.z, feetY + 2.4, 4);
        const supported = ground !== null
          && Math.abs(feetY - ground) <= 0.12
          && a.body.grounded
          && this.phys.isCharacterPositionClear(p.x, p.y, p.z, a.body.body);
        a.state = supported ? 'ground' : 'air';
        if (supported) {
          a.body.velocity.y = 0;
          a.peakFallSpeed = 0;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ground / Air
  // -------------------------------------------------------------------------

  private updateGroundAir(a: Actor, cmd: InputCommand, dt: number): void {
    const b = a.body;
    const v = b.velocity;
    const wasGrounded = b.grounded;

    // Mantle attempt (forward against ledge)
    if (this.tryMantle(a, cmd)) return;

    // Slide entry
    // A successful entry owns this tick. Continuing through ordinary ground
    // movement immediately overwrote `slide` with `ground`/`air`, leaving the
    // boost but never running the slide state on the following tick.
    if (cmd.crouchPressed && this.tryStartSlide(a)) return;

    // Jump handling
    this.handleJump(a, cmd);

    // Dash
    if (cmd.dashPressed) this.tryDash(a, cmd);

    // Ground pound
    if (cmd.poundPressed && !b.grounded && !a.grappleActive) {
      a.state = 'poundWindup';
      a.poundTimer = MOVE.poundWindup;
      v.x *= 0.05; v.z *= 0.05; v.y = Math.min(v.y, 0);
      return;
    }

    // Wall run entry (airborne only)
    if (!b.grounded && a.state === 'air') {
      this.tryWallrunEntry(a, cmd);
      if ((a.state as MoveState) === 'wallrun') return;
    }

    // Wish direction
    const fwd = yawDir(cmd.yaw);
    const right = rightOf(fwd);
    let wx = fwd.x * cmd.moveZ + right.x * cmd.moveX;
    let wz = fwd.z * cmd.moveZ + right.z * cmd.moveX;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) { wx /= wl; wz /= wl; }

    const adsFactor = 1 - a.wpn.adsAmount * (1 - MOVE.adsMoveMult);
    const healFactor = a.healing ? 0.25 : 1;
    const crouchFactor = a.crouched ? MOVE.crouchSpeed / MOVE.walkSpeed : 1;
    const mobility = this.currentMobility(a);
    let wishSpeed = (cmd.sprint && !a.crouched && cmd.moveZ > 0.1 && a.wpn.adsAmount < 0.3 ? MOVE.sprintSpeed : MOVE.walkSpeed)
      * adsFactor * healFactor * crouchFactor * mobility;
    if (a.inWater) wishSpeed *= 0.55;

    if (b.grounded) {
      this.applyFriction(v, dt, MOVE.frictionGround);
      this.accelerate(v, wx, wz, wishSpeed, MOVE.accelGround, dt);

      // Soft speed cap (anti infinite-bhop exploit)
      const hs = Math.hypot(v.x, v.z);
      if (hs > MOVE.softSpeedCap) {
        const excess = hs - MOVE.softSpeedCap;
        const damp = Math.max(0, 1 - (excess / MOVE.softSpeedCap) * dt * 3);
        v.x *= damp; v.z *= damp;
      }

      // Snap-to-ground already maintains support. Reapplying a negative
      // "stick" displacement every tick made Rapier's KCC accumulate support
      // error until grounded actors sank deeply through otherwise flat boxes.
      if (v.y <= 0) v.y = 0;
    } else {
      a.coyote = Math.max(0, a.coyote - 0); // decremented in timers
      if (a.peakFallSpeed < -v.y) a.peakFallSpeed = -v.y;
      this.accelerate(v, wx, wz, wishSpeed, MOVE.accelAir, dt);
      if (a.grappleActive) {
        this.applyGrapplePull(a, dt);
      } else {
        const gravityScale = v.y > 0 ? MOVE.jumpRiseGravityScale : MOVE.fallGravityScale;
        v.y -= MOVE.gravity * gravityScale * dt;
      }
    }

    // Integrate
    const preY = v.y;
    b.move(v.x * dt, v.y * dt, v.z * dt);
    if (b.hitCeiling && preY > 0) v.y = 0;
    if (b.grounded && v.y < 0) v.y = 0;
    if (b.grounded && !wasGrounded) {
      // Contact can only become grounded after the KCC move. The previous
      // pre-move check compared b.grounded with its own snapshot, making this
      // transition unreachable and leaving wall-run/jump state stale.
      a.jumpsUsed = 0;
      a.wallrunLanded = true;
      a.wallrunChains = 0;
      if (a.peakFallSpeed > MOVE.fallDamageMinSpeed) this.applyLanding(a);
      a.peakFallSpeed = 0;
    }
    if (!b.grounded && wasGrounded) {
      a.coyote = MOVE.coyoteTime;
      // Landing owns its own impact sample. Resetting the gait phase prevents
      // a carried pre-jump remainder from producing a second step immediately
      // after touchdown.
      a.footstepAccum = 0;
    }
    a.state = b.grounded ? 'ground' : 'air';
    // QA invariant: ground-locomotion state while physically airborne.
    a.airborneGroundTime = b.grounded ? 0 : a.airborneGroundTime + dt;

    // Footsteps
    if (b.grounded) {
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0.75) {
        a.footstepAccum += hs * dt;
        // One event represents one foot, not a complete left/right gait
        // cycle. Retain overshoot so cadence remains even across frame spikes.
        const walkStrideT = Math.min(1, hs / 6);
        const stride = cmd.sprint ? 2.55 : 1.45 + (2.15 - 1.45) * walkStrideT;
        if (a.footstepAccum > stride) {
          a.footstepAccum -= stride;
          this.events.onFootstep(a, cmd.sprint);
        }
      }
    }
  }

  private currentMobility(a: Actor): number {
    const w = a.inv.selectedWeapon;
    if (!w) return 1;
    const def = WEAPON_MOBILITY[w.weaponId];
    return def ?? 1;
  }

  private handleJump(a: Actor, cmd: InputCommand): void {
    const b = a.body;
    const v = b.velocity;
    if (a.jumpBuffered <= 0) return;

    if (a.grappleActive) {
      this.releaseGrapple(a);
      a.jumpBuffered = 0;
      return;
    }

    if (b.grounded || a.coyote > 0) {
      const hs = Math.hypot(v.x, v.z);
      const isBhop = a.bhopWindow > 0 && hs > MOVE.walkSpeed * 0.8;
      v.y = MOVE.jumpVel * (cmd.sprint ? MOVE.sprintJumpMultiplier : 1);
      if (a.state === 'slide') {
        // slide jump preserves momentum + small hop boost
        v.y = MOVE.jumpVel * 0.92;
        this.endSlide(a, false);
        this.events.onJump(a, 'slide');
      } else if (isBhop) {
        this.events.onJump(a, 'bhop');
      } else {
        this.events.onJump(a, 'jump');
      }
      a.jumpsUsed = 1;
      a.jumpBuffered = 0;
      a.coyote = 0;
      a.bhopWindow = 0;
    } else if (a.jumpsUsed < MOVE.maxJumps) {
      v.y = MOVE.doubleJumpVel;
      // Double jump refreshes a bit of horizontal control
      a.jumpsUsed++;
      a.jumpBuffered = 0;
      this.events.onJump(a, 'double');
    }
  }

  private tryDash(a: Actor, cmd: InputCommand): void {
    if (a.dashCharges <= 0 || a.dashTimer > 0) return;
    const b = a.body;
    const v = b.velocity;
    const fwd = yawDir(cmd.yaw);
    const right = rightOf(fwd);
    let dx = fwd.x * cmd.moveZ + right.x * cmd.moveX;
    let dz = fwd.z * cmd.moveZ + right.z * cmd.moveX;
    const l = Math.hypot(dx, dz);
    if (l < 0.1) { dx = fwd.x; dz = fwd.z; } else { dx /= l; dz /= l; }

    if (!b.grounded) {
      // Air dash consumes all remaining charges (max 1 available in practice)
      a.dashCharges = 0;
      v.y = Math.max(v.y * 0.25, 0);
    } else {
      a.dashCharges -= 1;
    }
    a.dashRegen = 0;
    a.dashTimer = MOVE.dashDuration;
    v.x = dx * MOVE.dashSpeed;
    v.z = dz * MOVE.dashSpeed;
    this.events.onDash(a);
  }

  // -------------------------------------------------------------------------
  // Slide
  // -------------------------------------------------------------------------

  tryStartSlide(a: Actor): boolean {
    const b = a.body;
    if (!b.grounded || a.slideCooldown > 0) return false;
    const v = b.velocity;
    const hs = Math.hypot(v.x, v.z);
    if (hs < MOVE.slideMinEntrySpeed) return false;
    a.state = 'slide';
    a.slideTimer = 0;
    const l = Math.max(hs, 1e-4);
    a.slideDirX = v.x / l;
    a.slideDirZ = v.z / l;
    const boost = Math.max(hs + MOVE.slideBoostAdd, MOVE.slideBoostMin);
    v.x = a.slideDirX * boost;
    v.z = a.slideDirZ * boost;
    this.events.onSlide(a);
    return true;
  }

  private endSlide(a: Actor, toCrouch: boolean): void {
    a.state = a.body.grounded ? 'ground' : 'air';
    a.slideCooldown = MOVE.slideCooldown;
    if (toCrouch) a.crouched = true;
  }

  private updateSlide(a: Actor, cmd: InputCommand, dt: number): void {
    const b = a.body;
    const v = b.velocity;
    a.slideTimer += dt;

    // Steering: limited lateral influence
    const fwd = yawDir(cmd.yaw);
    const right = rightOf(fwd);
    const steer = (right.x * cmd.moveX + fwd.x * cmd.moveZ * 0.25) * 6 * dt;
    v.x += steer * a.slideDirZ;
    v.z += -steer * a.slideDirX;

    this.applyFriction(v, dt, MOVE.slideFriction);
    v.y -= MOVE.gravity * dt;

    b.move(v.x * dt, v.y * dt, v.z * dt);
    if (b.grounded && v.y < 0) v.y = 0;

    const hs = Math.hypot(v.x, v.z);
    if (!cmd.crouchHeld || hs < 3.2 || !b.grounded || a.slideTimer > 2.2) {
      this.endSlide(a, cmd.crouchHeld);
      return;
    }
    if (a.jumpBuffered > 0) {
      // Slide jump: preserve slide momentum into the air
      a.jumpBuffered = 0;
      v.y = MOVE.jumpVel * 0.92;
      this.endSlide(a, false);
      this.events.onJump(a, 'slide');
      return;
    }
    this.events.onFootstep(a, true);
  }

  // -------------------------------------------------------------------------
  // Wall run
  // -------------------------------------------------------------------------

  private probeWall(a: Actor, side: number): { nx: number; nz: number; dist: number } | null {
    const p = a.body.position;
    const feetY = feetYFromBodyCenter(p.y);
    const fwd = yawDir(a.yaw);
    const right = rightOf(fwd);
    const rx = right.x * side, rz = right.z * side;
    const hit = this.phys.raycast(p.x, feetY + 1.2, p.z, rx, 0, rz, 0.95, GROUPS.rayWorldOnly);
    if (!hit) return null;
    const ny = hit.normal.y;
    if (Math.abs(ny) > 0.35) return null;
    return { nx: hit.normal.x, nz: hit.normal.z, dist: hit.dist };
  }

  private tryWallrunEntry(a: Actor, cmd: InputCommand): void {
    if (cmd.crouchHeld) return;
    // Anti-exploit: after leaving a wall there is a short cooldown, and the
    // same wall cannot be re-attached until the actor has touched ground.
    if (a.wallrunCooldown > 0) return;
    // Anti-elevator: only a limited number of consecutive wall runs per airtime.
    if (a.wallrunChains >= MOVE.wallRunMaxChains) return;
    const v = a.body.velocity;
    const hs = Math.hypot(v.x, v.z);
    if (hs < MOVE.wallRunMinSpeed) return;
    if (v.y < -12) return;
    const p = a.body.position;
    const feetY = feetYFromBodyCenter(p.y);
    // Must be off the ground somewhat
    const groundDist = this.phys.groundBelow(p.x, feetY + 0.5, p.z, MOVE.wallRunMinHeight + 0.6);
    if (groundDist !== null && groundDist < MOVE.wallRunMinHeight) return;

    for (const side of [-1, 1] as const) {
      const wall = this.probeWall(a, side);
      if (wall) {
        if (!a.wallrunLanded && wall.nx * a.lastWallNx + wall.nz * a.lastWallNz > MOVE.wallRunSameWallDot) {
          continue;
        }
        a.state = 'wallrun';
        a.wallSide = side;
        a.wallNormalX = wall.nx;
        a.wallNormalZ = wall.nz;
        a.wallrunTimer = 0;
        a.wallrunChains++;
        a.wallrunLanded = false;
        // Entering a run must not convert upward momentum into free lift.
        v.y = Math.min(v.y, 1.2);
        a.jumpsUsed = 1; // wall jump counts as first jump for chain rules
        this.events.onWallrunStart(a);
        return;
      }
    }
  }

  private updateWallrun(a: Actor, cmd: InputCommand, dt: number): void {
    const b = a.body;
    const v = b.velocity;
    a.wallrunTimer += dt;

    const wall = this.probeWall(a, a.wallSide);
    if (!wall || a.wallrunTimer > MOVE.wallRunMaxTime || cmd.crouchHeld) {
      a.state = 'air';
      a.wallrunCooldown = MOVE.wallrunReentryCooldown;
      a.lastWallNx = a.wallNormalX;
      a.lastWallNz = a.wallNormalZ;
      v.x += a.wallNormalX * 2.5;
      v.z += a.wallNormalZ * 2.5;
      return;
    }
    a.wallNormalX = wall.nx;
    a.wallNormalZ = wall.nz;

    // Tangent along wall, aligned with current motion/facing
    const tx = -wall.nz, tz = wall.nx;
    const fwd = yawDir(cmd.yaw);
    const align = tx * fwd.x + tz * fwd.z >= 0 ? 1 : -1;
    const dirX = tx * align, dirZ = tz * align;

    // Only real motion along the wall may feed the next frame's run speed.
    // The previous implementation measured hypot(vx, vz) after adding the
    // wall-stick force to velocity. Repeated wall contact could therefore
    // convert an otherwise blocked normal component into tangential speed,
    // especially while jump was spammed across land/re-entry transitions.
    const tangentSpeed = Math.abs(v.x * dirX + v.z * dirZ);
    const targetSpeed = Math.max(tangentSpeed, MOVE.wallRunMinSpeed + 2.5);
    // Blend the signed wall tangent and discard any stored into-wall velocity.
    const blend = Math.min(1, dt * 10);
    const currentTangent = v.x * dirX + v.z * dirZ;
    const blendedTangent = currentTangent + (targetSpeed - currentTangent) * blend;
    v.x = dirX * blendedTangent;
    v.z = dirZ * blendedTangent;

    // Reduced gravity that strengthens over the run (runs arc downward),
    // plus a small initial carry so runs feel fluid.
    const gScale = MOVE.wallRunGravityScale + Math.min(0.55, a.wallrunTimer * 0.4);
    v.y -= MOVE.gravity * gScale * dt;
    if (a.wallrunTimer < 0.22 && v.y < 1.6) v.y = 1.6;

    // Wall jump
    if (a.jumpBuffered > 0) {
      a.jumpBuffered = 0;
      v.x = wall.nx * MOVE.wallJumpOutVel + dirX * Math.max(targetSpeed * 0.72, 7);
      v.z = wall.nz * MOVE.wallJumpOutVel + dirZ * Math.max(targetSpeed * 0.72, 7);
      v.y = MOVE.wallJumpUpVel;
      a.jumpsUsed = 1;
      a.state = 'air';
      a.wallrunCooldown = MOVE.wallrunReentryCooldown;
      a.lastWallNx = wall.nx;
      a.lastWallNz = wall.nz;
      this.events.onJump(a, 'wall');
      return;
    }

    // Stick is a collision-controller request, not momentum. Keeping it out
    // of velocity prevents a blocked normal from becoming reusable speed.
    b.move(
      (v.x - wall.nx * MOVE.wallRunStickAccel) * dt,
      v.y * dt,
      (v.z - wall.nz * MOVE.wallRunStickAccel) * dt,
    );
    if (b.grounded) {
      a.state = 'ground';
      v.y = 0;
      a.jumpsUsed = 0;
      a.wallrunLanded = true;
      a.wallrunChains = 0;
      if (a.peakFallSpeed > MOVE.fallDamageMinSpeed) this.applyLanding(a);
      a.peakFallSpeed = 0;
      return;
    }
    if (a.peakFallSpeed < -v.y) a.peakFallSpeed = -v.y;
  }

  // -------------------------------------------------------------------------
  // Mantle
  // -------------------------------------------------------------------------

  private tryMantle(a: Actor, cmd: InputCommand): boolean {
    if (cmd.moveZ < 0.3 && a.jumpBuffered <= 0) return false;
    if (a.inWater) return false;
    const b = a.body;
    const p = b.position;
    const fwd = yawDir(cmd.yaw);
    const eye = a.eyeY;

    // Wall ahead?
    const wallHit = this.phys.raycast(p.x, eye - 0.7, p.z, fwd.x, 0, fwd.z, 1.0, GROUPS.rayWorldOnly);
    if (!wallHit || Math.abs(wallHit.normal.y) > 0.4) return false;

    // Ledge above and beyond the wall face?
    const probeX = wallHit.point.x + fwd.x * 0.45;
    const probeZ = wallHit.point.z + fwd.z * 0.45;
    const topHit = this.phys.raycast(probeX, eye + 1.1, probeZ, 0, -1, 0, 3.4, GROUPS.rayWorldOnly);
    if (!topHit) return false;
    const ledgeY = topHit.point.y;
    const feetY = feetYFromBodyCenter(p.y);
    const climb = ledgeY - feetY;
    if (climb < 0.55 || climb > MOVE.mantleMaxLedge) return false;

    // Clearance above ledge
    const clear = this.phys.raycast(probeX, ledgeY + 0.3, probeZ, 0, 1, 0, 2.2, GROUPS.rayWorldOnly);
    if (clear) return false;

    return this.startMantle(a, probeX, ledgeY + CAPSULE_CENTER_OFFSET, probeZ);
  }

  /**
   * Begin a collision-safe two-part mantle: rise beside the obstacle, then
   * cross its top. Both complete capsule sweeps are validated up front so a
   * centre ray cannot place an actor inside a ceiling, overhang or wall edge.
   */
  private startMantle(a: Actor, targetX: number, targetY: number, targetZ: number): boolean {
    const from = a.body.position;
    const raised = { x: from.x, y: targetY, z: from.z };
    const target = { x: targetX, y: targetY, z: targetZ };
    if (!this.phys.isCharacterSweepClear(from, raised, a.body.body) ||
        !this.phys.isCharacterSweepClear(raised, target, a.body.body)) {
      return false;
    }
    a.state = 'mantle';
    a.mantleFrom = { ...from };
    a.mantleTo = target;
    a.mantleTimer = 0;
    a.body.velocity.x = 0; a.body.velocity.y = 0; a.body.velocity.z = 0;
    a.jumpBuffered = 0;
    a.coyote = 0;
    a.peakFallSpeed = 0;
    this.events.onMantle(a);
    return true;
  }

  private updateMantle(a: Actor, dt: number): void {
    a.mantleTimer += dt;
    const t = Math.min(1, a.mantleTimer / MOVE.mantleDuration);
    const riseEnd = 0.55;
    let fx: number;
    let fy: number;
    let fz: number;
    if (t < riseEnd) {
      const u = t / riseEnd;
      const ease = u * u * (3 - 2 * u);
      fx = a.mantleFrom.x;
      fy = a.mantleFrom.y + (a.mantleTo.y - a.mantleFrom.y) * ease;
      fz = a.mantleFrom.z;
    } else {
      const u = (t - riseEnd) / (1 - riseEnd);
      const ease = u * u * (3 - 2 * u);
      fx = a.mantleFrom.x + (a.mantleTo.x - a.mantleFrom.x) * ease;
      fy = a.mantleTo.y;
      fz = a.mantleFrom.z + (a.mantleTo.z - a.mantleFrom.z) * ease;
    }
    const before = { ...a.body.position };
    const requested = { x: fx - before.x, y: fy - before.y, z: fz - before.z };
    a.body.move(requested.x, requested.y, requested.z);
    const requestedDistance = Math.hypot(requested.x, requested.y, requested.z);
    const movedDistance = Math.hypot(
      a.body.position.x - before.x,
      a.body.position.y - before.y,
      a.body.position.z - before.z,
    );
    if (requestedDistance > 0.02 && movedDistance < Math.min(0.01, requestedDistance * 0.2)) {
      a.state = a.body.grounded ? 'ground' : 'air';
      a.body.velocity.x = 0; a.body.velocity.y = 0; a.body.velocity.z = 0;
      return;
    }
    if (t >= 1) {
      const miss = Math.hypot(
        a.body.position.x - a.mantleTo.x,
        a.body.position.y - a.mantleTo.y,
        a.body.position.z - a.mantleTo.z,
      );
      const supportDistance = this.phys.groundBelow(
        a.body.position.x,
        a.body.position.y,
        a.body.position.z,
        CAPSULE_CENTER_OFFSET + 0.3,
      );
      const succeeded = miss <= 0.12 && supportDistance !== null
        && Math.abs(supportDistance - CAPSULE_CENTER_OFFSET) <= 0.12
        && a.body.grounded
        && this.phys.isCharacterPositionClear(
          a.body.position.x,
          a.body.position.y,
          a.body.position.z,
          a.body.body,
        );
      // Geometry may change after the preflight sweep (for example a
      // destructible transition). Never force the endpoint when KCC blocks.
      a.state = succeeded ? 'ground' : (a.body.grounded ? 'ground' : 'air');
      const fwd = yawDir(a.yaw);
      a.body.velocity.x = succeeded ? fwd.x * 3.4 : 0;
      a.body.velocity.z = succeeded ? fwd.z * 3.4 : 0;
      a.body.velocity.y = 0;
      if (succeeded) a.jumpsUsed = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Grapple
  // -------------------------------------------------------------------------

  tryGrapple(a: Actor): boolean {
    if (a.grappleCooldown > 0 || a.grappleActive) return false;
    if (a.state === 'freefall' || a.state === 'glide' || a.state === 'swim') return false;
    const p = a.body.position;
    const eyeY = a.eyeY;
    const dir = this.lookDir(a);
    const hit = this.phys.raycast(p.x, eyeY, p.z, dir.x, dir.y, dir.z, MOVE.grappleRange, GROUPS.rayWorldOnly);
    if (!hit) return false;
    a.grappleActive = true;
    a.grapplePoint = { ...hit.point };
    a.jumpsUsed = Math.max(a.jumpsUsed, 1);
    this.events.onGrappleAttach(a);
    return true;
  }

  releaseGrapple(a: Actor): void {
    if (!a.grappleActive) return;
    a.grappleActive = false;
    a.grappleCooldown = MOVE.grappleCooldown;
    this.events.onGrappleRelease(a);
  }

  private applyGrapplePull(a: Actor, dt: number): void {
    const v = a.body.velocity;
    const p = a.body.position;
    const ropeY = feetYFromBodyCenter(p.y) + 1.6;
    let tx = a.grapplePoint.x - p.x;
    let ty = a.grapplePoint.y - ropeY;
    let tz = a.grapplePoint.z - p.z;
    const dist = Math.hypot(tx, ty, tz);
    if (dist < 2.2) {
      this.releaseGrapple(a);
      return;
    }
    tx /= dist; ty /= dist; tz /= dist;

    // Swing feel: pull strongest when moving toward the point
    const toward = v.x * tx + v.y * ty + v.z * tz;
    const pull = MOVE.grapplePullAccel * (toward < 0 ? 1.15 : 0.85);
    v.x += tx * pull * dt;
    v.y += ty * pull * dt;
    v.z += tz * pull * dt;

    // Rope constraint
    const ropeMax = MOVE.grappleRange;
    if (dist > ropeMax) {
      const outX = -tx, outY = -ty, outZ = -tz;
      const outward = v.x * outX + v.y * outY + v.z * outZ;
      if (outward > 0) {
        v.x -= outX * outward;
        v.y -= outY * outward;
        v.z -= outZ * outward;
      }
    }

    // Cap speed
    const sp = Math.hypot(v.x, v.y, v.z);
    if (sp > MOVE.grappleMaxSpeed) {
      const s = MOVE.grappleMaxSpeed / sp;
      v.x *= s; v.y *= s; v.z *= s;
    }

    // Passed the anchor?
    if (dist < 6 && (v.x * tx + v.y * ty + v.z * tz) < 0.5) {
      this.releaseGrapple(a);
    }
  }

  // -------------------------------------------------------------------------
  // Ground pound
  // -------------------------------------------------------------------------

  private updatePoundWindup(a: Actor, dt: number): void {
    a.poundTimer -= dt;
    const v = a.body.velocity;
    v.x *= 0.8; v.z *= 0.8;
    v.y -= MOVE.gravity * 0.4 * dt;
    a.body.move(v.x * dt, v.y * dt, v.z * dt);
    if (a.poundTimer <= 0) {
      a.state = 'poundFall';
      v.y = -MOVE.poundFallSpeed;
    }
  }

  private updatePoundFall(a: Actor, dt: number): void {
    const v = a.body.velocity;
    v.x *= 0.9; v.z *= 0.9;
    a.body.move(v.x * dt, v.y * dt, v.z * dt);
    if (a.body.grounded) {
      a.state = 'ground';
      v.y = 0;
      a.peakFallSpeed = 0;
      this.events.onPoundImpact(a, a.body.position.x, feetYFromBodyCenter(a.body.position.y), a.body.position.z);
    }
  }

  // -------------------------------------------------------------------------
  // Swim
  // -------------------------------------------------------------------------

  private enterSwim(a: Actor): void {
    if (a.state === 'swim') return;
    const v = a.body.velocity;
    const sp = Math.hypot(v.x, v.y, v.z);
    if (sp > 13) this.events.onSplash(a, true);
    a.state = 'swim';
    this.releaseGrapple(a);
    a.peakFallSpeed = 0;
  }

  private updateSwim(a: Actor, cmd: InputCommand, dt: number): void {
    const b = a.body;
    const v = b.velocity;
    const p = b.position;
    const feetY = feetYFromBodyCenter(p.y);

    const fwd = yawDir(cmd.yaw);
    const right = rightOf(fwd);
    let wx = fwd.x * cmd.moveZ + right.x * cmd.moveX;
    let wz = fwd.z * cmd.moveZ + right.z * cmd.moveX;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) { wx /= wl; wz /= wl; }

    const diving = cmd.crouchHeld;
    const surfacing = cmd.jumpHeld;
    const depthBelowSurface = a.waterSurfaceY - (feetY + 1.0);

    let speed = depthBelowSurface > 1.2 ? MOVE.swimDiveSpeed : MOVE.swimSurfaceSpeed;
    speed *= this.currentMobility(a);
    this.accelerate(v, wx, wz, speed, 14, dt);

    if (surfacing) v.y += 16 * dt;
    else if (diving) v.y -= 16 * dt;
    else {
      // gentle buoyancy toward rest depth
      const targetY = depthBelowSurface > 0.9 ? 2.5 : depthBelowSurface > 0.35 ? 0 : -3.5;
      v.y += targetY * 6 * dt;
    }
    v.y = Math.max(-6, Math.min(6, v.y));

    // Drag
    const dragF = Math.exp(-MOVE.waterDrag * dt);
    v.x *= dragF; v.z *= dragF;

    b.move(v.x * dt, v.y * dt, v.z * dt);

    // Exit water: walk onto shore or mantle out
    const moved = b.position;
    const movedFeetY = feetYFromBodyCenter(moved.y);
    if (!this.waterAt(moved.x, movedFeetY + 1.0, moved.z)) {
      const ground = this.phys.surfaceAt(moved.x, moved.z, movedFeetY + 2.4, 4);
      const supported = ground !== null
        && Math.abs(movedFeetY - ground) <= 0.12
        && b.grounded
        && this.phys.isCharacterPositionClear(moved.x, moved.y, moved.z, b.body);
      if (supported) {
        a.state = 'ground';
        v.y = 0;
        a.peakFallSpeed = 0;
        return;
      }
      // ledge nearby? try mantle assist
      const fwdOnly = yawDir(a.yaw);
      const ledge = this.phys.raycast(
        moved.x + fwdOnly.x * 0.8, movedFeetY + 1.6, moved.z + fwdOnly.z * 0.8,
        0, -1, 0, 2.2, GROUPS.rayWorldOnly,
      );
      if (ledge && ledge.point.y > movedFeetY + 0.4 && ledge.point.y < movedFeetY + 2.6) {
        if (this.startMantle(
          a,
          moved.x + fwdOnly.x * 0.8,
          ledge.point.y + CAPSULE_CENTER_OFFSET,
          moved.z + fwdOnly.z * 0.8,
        )) return;
      }
      a.state = 'air';
    }

    // Swim footsteps (soft paddles) for AI hearing
    a.footstepAccum += Math.hypot(v.x, v.z) * dt;
    if (a.footstepAccum > 3.4) {
      a.footstepAccum = 0;
      this.events.onFootstep(a, false);
    }
  }

  // -------------------------------------------------------------------------
  // Drop phase: freefall + glide
  // -------------------------------------------------------------------------

  beginFreefall(a: Actor): void {
    a.state = 'freefall';
    // `deployed` means "has exited the transport" — set at jump, not at
    // touchdown, so a gliding actor is never treated as still aboard.
    a.deployed = true;
  }

  private updateFreefall(a: Actor, cmd: InputCommand, dt: number): void {
    const b = a.body;
    const v = b.velocity;
    const p = b.position;

    // Dive angle from pitch: looking down = faster fall
    const diveFactor = Math.max(0, -cmd.pitch); // pitch<0 looking down
    const targetVy = -(18 + diveFactor * 34);
    v.y += (targetVy - v.y) * Math.min(1, dt * 2.2);

    // Horizontal steering
    const fwd = yawDir(cmd.yaw);
    const right = rightOf(fwd);
    const steerX = fwd.x * cmd.moveZ + right.x * cmd.moveX;
    const steerZ = fwd.z * cmd.moveZ + right.z * cmd.moveX;
    v.x += steerX * 26 * dt;
    v.z += steerZ * 26 * dt;
    const hs = Math.hypot(v.x, v.z);
    const maxHs = 30;
    if (hs > maxHs) { v.x *= maxHs / hs; v.z *= maxHs / hs; }

    b.move(v.x * dt, v.y * dt, v.z * dt);
    this.clampFlightBounds(a);

    const groundDist = this.phys.groundBelow(p.x, p.y, p.z, 200);
    const agl = groundDist ?? 999;
    if (agl < MATCH.deployAltitude || cmd.jumpPressed) {
      a.state = 'glide';
      v.y = Math.max(v.y, -12);
    }
  }

  /** Keep airborne actors inside the playable area. */
  private clampFlightBounds(a: Actor): void {
    const p = a.body.position;
    const lim = this.bounds.half;
    const v = a.body.velocity;
    let clamped = false;
    if (p.x > lim) { p.x = lim; if (v.x > 0) v.x = 0; clamped = true; }
    if (p.x < -lim) { p.x = -lim; if (v.x < 0) v.x = 0; clamped = true; }
    if (p.z > lim) { p.z = lim; if (v.z > 0) v.z = 0; clamped = true; }
    if (p.z < -lim) { p.z = -lim; if (v.z < 0) v.z = 0; clamped = true; }
    if (clamped) {
      // move() already queued the unconstrained kinematic target. Replacing
      // only the presentation-space position leaves Rapier advancing beyond
      // the boundary on the next step and permanently desynchronizes both
      // coordinate copies. Flight contact state stays untouched; only replace
      // the pending x/z-constrained translation.
      a.body.body.setNextKinematicTranslation(p);
    }
    // Failsafe: fell out of the world — redeploy above safe ground.
    if (p.y < -80 || (clamped && p.y < 0)) {
      const surf = this.phys.surfaceAt(p.x, p.z, 400, 500) ?? 0;
      a.body.teleport(p.x, Math.max(surf, 0) + 30, p.z);
      a.body.velocity.x = 0;
      a.body.velocity.y = -6;
      a.body.velocity.z = 0;
      a.state = 'glide';
    }
  }

  private updateGlide(a: Actor, cmd: InputCommand, dt: number): void {
    const b = a.body;
    const v = b.velocity;
    const p = b.position;

    // Dive when still far from the steering target (pitch held down).
    const diveExtra = Math.max(0, -cmd.pitch) * 14;
    v.y += (-(MATCH.glideFallSpeed + diveExtra) - v.y) * Math.min(1, dt * 3);
    const fwd = yawDir(cmd.yaw);
    const right = rightOf(fwd);
    const targetVx = fwd.x * MATCH.glideForwardSpeed + right.x * cmd.moveX * 8;
    const targetVz = fwd.z * MATCH.glideForwardSpeed + right.z * cmd.moveX * 8;
    v.x += (targetVx - v.x) * Math.min(1, dt * 2.4);
    v.z += (targetVz - v.z) * Math.min(1, dt * 2.4);

    b.move(v.x * dt, v.y * dt, v.z * dt);
    this.clampFlightBounds(a);

    const groundDist = this.phys.groundBelow(p.x, p.y, p.z, 3.2);
    if (groundDist !== null && groundDist < 2.6) {
      // Touch down
      const surf = this.phys.surfaceAt(p.x, p.z, p.y + 1, 4);
      if (surf === null) return;
      const placement = this.phys.findClearStandingPlacement(p.x, surf, p.z, b.body);
      if (!placement) return;
      b.teleport(placement.x, placement.y, placement.z);
      // Teleport deliberately invalidates contact state. Stay airborne for
      // this frame; the next normal KCC tick establishes support before the
      // actor is allowed to report `ground`.
      a.state = 'air';
      a.deployed = true;
      v.y = 0;
      v.x *= 0.35; v.z *= 0.35;
      this.events.onLand(a, 8, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private applyFriction(v: { x: number; y: number; z: number }, dt: number, friction: number): void {
    const hs = Math.hypot(v.x, v.z);
    if (hs < 1e-4) return;
    const control = Math.max(hs, MOVE.stopSpeed);
    const drop = control * friction * dt;
    const newHs = Math.max(0, hs - drop);
    const scale = newHs / hs;
    v.x *= scale;
    v.z *= scale;
  }

  private accelerate(
    v: { x: number; y: number; z: number },
    wx: number, wz: number, wishSpeed: number, accel: number, dt: number,
  ): void {
    if (wishSpeed <= 0) return;
    const current = v.x * wx + v.z * wz;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const accelSpeed = Math.min(add, accel * wishSpeed * dt);
    v.x += wx * accelSpeed;
    v.z += wz * accelSpeed;
  }

  private applyLanding(a: Actor): void {
    const speed = a.peakFallSpeed;
    let dmg = 0;
    if (speed > MOVE.fallDamageMinSpeed) {
      const t = Math.min(1, (speed - MOVE.fallDamageMinSpeed) / (MOVE.fallDamageMaxSpeed - MOVE.fallDamageMinSpeed));
      dmg = Math.round(t * MOVE.fallDamageMax);
    }
    if (dmg > 0) {
      a.lastAttackerId = -1;
      const dealt = a.applyDamage(dmg);
      void dealt;
    }
    // Emit after damage so lethal falls are already dead when handlers run.
    this.events.onLand(a, speed, dmg);
  }

  lookDir(a: Actor): { x: number; y: number; z: number } {
    const cp = Math.cos(a.pitch);
    return { x: -Math.sin(a.yaw) * cp, y: Math.sin(a.pitch), z: -Math.cos(a.yaw) * cp };
  }

  /** Called when actor lands from any state transition detected externally. */
  notifyGrounded(a: Actor): void {
    if (a.peakFallSpeed > MOVE.fallDamageMinSpeed) this.applyLanding(a);
    a.peakFallSpeed = 0;
  }
}

// Weapon mobility table mirrors WEAPONS[].mobility (kept local to avoid import cycle cost).
const WEAPON_MOBILITY: Record<string, number> = {
  pistol: 1.0, smg: 0.98, ar: 0.94, shotgun: 0.92, sniper: 0.88,
};

export { FWD };
