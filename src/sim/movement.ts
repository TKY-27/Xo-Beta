/**
 * Shared character movement simulation (player + bots use identical rules).
 *
 * States: ground / air / slide / wallrun / mantle / grapple / poundWindup /
 * poundFall / swim / freefall / glide.
 */

import { MATCH, MOVE } from '../core/balance';
import type { Actor, MoveState } from './actor';
import type { InputCommand } from './input';
import type { PhysicsWorld } from '../physics/physics';
import type { WaterVolume } from '../world/types';

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

const FWD = { x: 0, z: 1 };

/** CharBody.position is the capsule CENTER; surfaces are at feet level. */
export const CAPSULE_CENTER_OFFSET = MOVE.capsuleHalfHeight + MOVE.capsuleRadius + 0.04;

function yawDir(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
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
        return;
      case 'poundWindup':
        this.updatePoundWindup(a, dt);
        return;
      case 'poundFall':
        this.updatePoundFall(a, dt);
        return;
      case 'freefall':
        this.updateFreefall(a, cmd, dt);
        return;
      case 'glide':
        this.updateGlide(a, cmd, dt);
        return;
      case 'swim':
        this.updateSwim(a, cmd, dt);
        return;
      case 'wallrun':
        this.updateWallrun(a, cmd, dt);
        return;
      case 'slide':
        this.updateSlide(a, cmd, dt);
        return;
      default:
        this.updateGroundAir(a, cmd, dt);
    }
  }

  private updateTimers(a: Actor, cmd: InputCommand, dt: number): void {
    if (a.grappleCooldown > 0) a.grappleCooldown -= dt;
    if (a.slideCooldown > 0) a.slideCooldown -= dt;
    if (a.coyote > 0) a.coyote -= dt;
    if (a.jumpBuffered > 0) a.jumpBuffered -= dt;
    if (a.bhopWindow > 0) a.bhopWindow -= dt;
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
      const hit = this.phys.raycast(p.x, p.y + 1.4, p.z, 0, 1, 0, 0.75);
      if (hit) a.crouched = true;
    }
  }

  private updateWaterState(a: Actor): void {
    const p = a.body.position;
    const vol = this.waterAt(p.x, p.y + 1.0, p.z);
    if (vol && p.y + 1.0 < vol.surfaceY - 0.55) {
      if (!a.inWater && a.state !== 'freefall' && a.state !== 'glide') {
        this.events.onSplash(a, Math.hypot(a.body.velocity.x, a.body.velocity.z, a.body.velocity.y) > 14);
      }
      a.inWater = true;
      a.submerged = p.y + 1.9 < vol.surfaceY;
      a.waterSurfaceY = vol.surfaceY;
      if (a.state !== 'swim' && a.state !== 'freefall' && a.state !== 'glide' &&
          a.state !== 'mantle' && a.state !== 'poundFall') {
        this.enterSwim(a);
      }
    } else {
      const shallow = vol !== null;
      a.inWater = false;
      a.submerged = false;
      if (shallow) a.waterSurfaceY = vol!.surfaceY;
      if (a.state === 'swim' && !shallow) a.state = a.body.grounded ? 'ground' : 'air';
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
    if (cmd.crouchPressed && !a.crouched) {
      this.tryStartSlide(a);
    }

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
    const right = { x: fwd.z, z: -fwd.x };
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
      // Bhop: skip friction if within window after landing and jumping
      const justLanded = !wasGrounded;
      if (justLanded) {
        a.jumpsUsed = 0;
        if (a.peakFallSpeed > MOVE.fallDamageMinSpeed) {
          this.applyLanding(a);
        }
        a.peakFallSpeed = 0;
      }
      if (!(justLanded && a.bhopWindow > 0 && a.jumpBuffered > 0)) {
        this.applyFriction(v, dt, MOVE.frictionGround);
      }
      this.accelerate(v, wx, wz, wishSpeed, MOVE.accelGround, dt);

      // Soft speed cap (anti infinite-bhop exploit)
      const hs = Math.hypot(v.x, v.z);
      if (hs > MOVE.softSpeedCap) {
        const excess = hs - MOVE.softSpeedCap;
        const damp = Math.max(0, 1 - (excess / MOVE.softSpeedCap) * dt * 3);
        v.x *= damp; v.z *= damp;
      }

      if (v.y <= 0) v.y = Math.min(v.y, 0) - 0; // grounded, controller handles snap
      v.y -= MOVE.gravity * dt * 0.25; // light stick force
    } else {
      a.coyote = Math.max(0, a.coyote - 0); // decremented in timers
      if (a.peakFallSpeed < -v.y) a.peakFallSpeed = -v.y;
      this.accelerate(v, wx, wz, wishSpeed, MOVE.accelAir, dt);
      if (a.grappleActive) {
        this.applyGrapplePull(a, dt);
      } else {
        v.y -= MOVE.gravity * dt;
      }
    }

    // Integrate
    const preY = v.y;
    b.move(v.x * dt, v.y * dt, v.z * dt);
    if (b.hitCeiling && preY > 0) v.y = 0;
    if (b.grounded && v.y < 0) v.y = 0;
    if (!b.grounded && wasGrounded) a.coyote = MOVE.coyoteTime;
    a.state = b.grounded ? 'ground' : 'air';

    // Footsteps
    if (b.grounded) {
      const hs = Math.hypot(v.x, v.z);
      if (hs > 2.2) {
        a.footstepAccum += hs * dt;
        const stride = cmd.sprint ? 3.1 : 2.6;
        if (a.footstepAccum > stride) {
          a.footstepAccum = 0;
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
      v.y = MOVE.jumpVel;
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
    const right = { x: fwd.z, z: -fwd.x };
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
    const right = { x: fwd.z, z: -fwd.x };
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
    const fwd = yawDir(a.yaw);
    const right = { x: fwd.z, z: -fwd.x };
    const rx = right.x * side, rz = right.z * side;
    const hit = this.phys.raycast(p.x, p.y + 1.2, p.z, rx, 0, rz, 0.95);
    if (!hit) return null;
    const ny = hit.normal.y;
    if (Math.abs(ny) > 0.35) return null;
    return { nx: hit.normal.x, nz: hit.normal.z, dist: hit.dist };
  }

  private tryWallrunEntry(a: Actor, cmd: InputCommand): void {
    if (cmd.crouchHeld) return;
    const v = a.body.velocity;
    const hs = Math.hypot(v.x, v.z);
    if (hs < MOVE.wallRunMinSpeed) return;
    if (v.y < -12) return;
    const p = a.body.position;
    // Must be off the ground somewhat
    const groundDist = this.phys.groundBelow(p.x, p.y + 0.5, p.z, MOVE.wallRunMinHeight + 0.6);
    if (groundDist !== null && groundDist < MOVE.wallRunMinHeight) return;

    for (const side of [-1, 1] as const) {
      const wall = this.probeWall(a, side);
      if (wall) {
        a.state = 'wallrun';
        a.wallSide = side;
        a.wallNormalX = wall.nx;
        a.wallNormalZ = wall.nz;
        a.wallrunTimer = 0;
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

    const hs = Math.hypot(v.x, v.z);
    const targetSpeed = Math.max(hs, MOVE.wallRunMinSpeed + 2.5);
    // Blend velocity toward tangent direction
    const blend = Math.min(1, dt * 10);
    v.x += (dirX * targetSpeed - v.x) * blend;
    v.z += (dirZ * targetSpeed - v.z) * blend;

    // Reduced gravity + initial upward carry
    v.y -= MOVE.gravity * MOVE.wallRunGravityScale * dt;
    if (a.wallrunTimer < 0.22) v.y = Math.max(v.y, 1.6);

    // Stick to wall
    v.x += -wall.nx * MOVE.wallRunStickAccel * dt;
    v.z += -wall.nz * MOVE.wallRunStickAccel * dt;

    // Wall jump
    if (a.jumpBuffered > 0) {
      a.jumpBuffered = 0;
      v.x = wall.nx * MOVE.wallJumpOutVel + dirX * Math.max(hs * 0.72, 7);
      v.z = wall.nz * MOVE.wallJumpOutVel + dirZ * Math.max(hs * 0.72, 7);
      v.y = MOVE.wallJumpUpVel;
      a.jumpsUsed = 1;
      a.state = 'air';
      this.events.onJump(a, 'wall');
      return;
    }

    b.move(v.x * dt, v.y * dt, v.z * dt);
    if (b.grounded) {
      a.state = 'ground';
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
    const eye = p.y + (a.crouched ? 1.35 : 2.05);

    // Wall ahead?
    const wallHit = this.phys.raycast(p.x, eye - 0.7, p.z, fwd.x, 0, fwd.z, 1.0);
    if (!wallHit || Math.abs(wallHit.normal.y) > 0.4) return false;

    // Ledge above and beyond the wall face?
    const probeX = wallHit.point.x + fwd.x * 0.45;
    const probeZ = wallHit.point.z + fwd.z * 0.45;
    const topHit = this.phys.raycast(probeX, eye + 1.1, probeZ, 0, -1, 0, 3.4);
    if (!topHit) return false;
    const ledgeY = topHit.point.y;
    const feetY = p.y - CAPSULE_CENTER_OFFSET;
    const climb = ledgeY - feetY;
    if (climb < 0.55 || climb > MOVE.mantleMaxLedge) return false;

    // Clearance above ledge
    const clear = this.phys.raycast(probeX, ledgeY + 0.3, probeZ, 0, 1, 0, 2.2);
    if (clear) return false;

    a.state = 'mantle';
    a.mantleFrom = { ...p };
    a.mantleTo = { x: probeX, y: ledgeY + CAPSULE_CENTER_OFFSET, z: probeZ };
    a.mantleTimer = 0;
    a.body.velocity.x = 0; a.body.velocity.y = 0; a.body.velocity.z = 0;
    this.events.onMantle(a);
    return true;
  }

  private updateMantle(a: Actor, dt: number): void {
    a.mantleTimer += dt;
    const t = Math.min(1, a.mantleTimer / MOVE.mantleDuration);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const p = a.body.position;
    const fx = a.mantleFrom.x + (a.mantleTo.x - a.mantleFrom.x) * ease;
    const fy = a.mantleFrom.y + (a.mantleTo.y - a.mantleFrom.y) * Math.min(1, ease * 1.35);
    const fz = a.mantleFrom.z + (a.mantleTo.z - a.mantleFrom.z) * ease;
    a.body.teleport(fx, fy, fz);
    if (t >= 1) {
      a.state = 'ground';
      const fwd = yawDir(a.yaw);
      a.body.velocity.x = fwd.x * 3.4;
      a.body.velocity.z = fwd.z * 3.4;
      a.body.velocity.y = 0;
      a.jumpsUsed = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Grapple
  // -------------------------------------------------------------------------

  tryGrapple(a: Actor): boolean {
    if (a.grappleCooldown > 0 || a.grappleActive) return false;
    if (a.state === 'freefall' || a.state === 'glide' || a.state === 'swim') return false;
    const p = a.body.position;
    const eyeY = p.y + (a.crouched ? 1.35 : 2.05);
    const dir = this.lookDir(a);
    const hit = this.phys.raycast(p.x, eyeY, p.z, dir.x, dir.y, dir.z, MOVE.grappleRange, undefined);
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
    let tx = a.grapplePoint.x - p.x;
    let ty = a.grapplePoint.y - (p.y + 1.6);
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
      this.events.onPoundImpact(a, a.body.position.x, a.body.position.y, a.body.position.z);
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
    a.grappleActive = false;
    a.peakFallSpeed = 0;
  }

  private updateSwim(a: Actor, cmd: InputCommand, dt: number): void {
    const b = a.body;
    const v = b.velocity;
    const p = b.position;

    const fwd = yawDir(cmd.yaw);
    const right = { x: fwd.z, z: -fwd.x };
    let wx = fwd.x * cmd.moveZ + right.x * cmd.moveX;
    let wz = fwd.z * cmd.moveZ + right.z * cmd.moveX;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) { wx /= wl; wz /= wl; }

    const diving = cmd.crouchHeld;
    const surfacing = cmd.jumpHeld;
    const depthBelowSurface = a.waterSurfaceY - (p.y + 1.0);

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
    if (!this.waterAt(p.x, p.y + 1.0, p.z)) {
      const ground = this.phys.surfaceAt(p.x, p.z, p.y + 2.4, 4);
      if (ground !== null && ground <= p.y + 0.6) {
        a.state = 'ground';
        return;
      }
      // ledge nearby? try mantle assist
      const fwdOnly = yawDir(a.yaw);
      const ledge = this.phys.raycast(p.x + fwdOnly.x * 0.8, p.y + 1.6, p.z + fwdOnly.z * 0.8, 0, -1, 0, 2.2);
      if (ledge && ledge.point.y > p.y + 0.4 && ledge.point.y < p.y + 2.6) {
        a.state = 'mantle';
        a.mantleFrom = { ...p };
        a.mantleTo = { x: p.x + fwdOnly.x * 0.8, y: ledge.point.y + CAPSULE_CENTER_OFFSET, z: p.z + fwdOnly.z * 0.8 };
        a.mantleTimer = 0;
        return;
      }
      a.state = 'air';
    }

    if (b.grounded) a.state = 'ground';

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
    a.deployed = false;
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
    const right = { x: fwd.z, z: -fwd.x };
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
    const right = { x: fwd.z, z: -fwd.x };
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
      if (surf !== null) {
        b.teleport(p.x, surf + CAPSULE_CENTER_OFFSET, p.z);
      }
      a.state = 'ground';
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
    this.events.onLand(a, speed, dmg);
    if (dmg > 0) {
      a.lastAttackerId = -1;
      const dealt = a.applyDamage(dmg);
      void dealt;
    }
  }

  lookDir(a: Actor): { x: number; y: number; z: number } {
    const cp = Math.cos(a.pitch);
    return { x: Math.sin(a.yaw) * cp, y: Math.sin(a.pitch), z: Math.cos(a.yaw) * cp };
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
