/**
 * Bot combat execution: fair aim model (reaction delay, tracking speed,
 * gaussian error, projectile leading/drop compensation), burst discipline,
 * range management. Uses exactly the same weapon rules as the player.
 */

import { WEAPONS } from '../core/balance';
import { gameNext, gameGauss } from '../core/rng';
import type { Actor } from '../sim/actor';
import type { WeaponInstance } from '../sim/inventory';

export interface AimParams {
  reaction: number;
  aimError: number;
  trackSpeed: number;
}

export class BotCombat {
  target: Actor | null = null;
  /** Current simulated aim (lags behind true direction like a human's). */
  aimYaw = 0;
  aimPitch = 0;
  private reactionLeft = 0;
  private errX = 0;
  private errY = 0;
  private errTimer = 0;
  private burstLeft = 0;
  private burstPause = 0;

  constructor(private self: Actor, private params: AimParams) {
    this.aimYaw = self.yaw;
    this.aimPitch = self.pitch;
  }

  acquire(target: Actor): void {
    if (this.target !== target) {
      this.target = target;
      this.reactionLeft = this.params.reaction * (0.75 + gameNext() * 0.5);
      this.resampleError();
    }
  }

  clearTarget(): void {
    this.target = null;
  }

  private resampleError(): void {
    this.errX = gameGauss() * this.params.aimError;
    this.errY = gameGauss() * this.params.aimError * 0.6;
    this.errTimer = 0.22 + gameNext() * 0.2;
  }

  /**
   * Update aim toward the target. Returns fire intent for this tick.
   * `visible` must reflect genuine current line of sight.
   */
  update(
    dt: number,
    visible: boolean,
    losClear: boolean,
    projSpeedFor: (w: WeaponInstance) => number,
  ): { yaw: number; pitch: number; fire: boolean } {
    const t = this.target;
    if (!t || !t.alive) {
      this.target = null;
      return { yaw: this.aimYaw, pitch: this.aimPitch, fire: false };
    }

    // Error wobble re-sample
    this.errTimer -= dt;
    if (this.errTimer <= 0) this.resampleError();

    const tp = t.body.position;
    const sp = this.self.body.position;
    let dx = tp.x - sp.x;
    let dy = tp.y + 1.35 - (sp.y + 2.05);
    let dz = tp.z - sp.z;
    const dist = Math.hypot(dx, dy, dz);

    // Lead the target based on our projectile speed
    const w = this.self.inv.selectedWeapon;
    if (w) {
      const pspeed = projSpeedFor(w);
      const tof = dist / Math.max(50, pspeed);
      dx += t.body.velocity.x * tof;
      dy += t.body.velocity.y * tof * 0.85;
      dz += t.body.velocity.z * tof;
      // Gravity compensation
      const def = WEAPONS[w.weaponId];
      dy += 0.5 * 26 * def.dropGravity * tof * tof;
    }

    const wantYaw = Math.atan2(dx, dz) + this.errX * (0.5 + dist / 80);
    const wantPitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)) + this.errY * (0.5 + dist / 80), -1.45, 1.45);

    // Rotate aim toward desired with limited speed
    const maxYawStep = this.params.trackSpeed * dt;
    const dYaw = angleDiff(wantYaw, this.aimYaw);
    this.aimYaw += clamp(dYaw, -maxYawStep, maxYawStep);
    const dPitch = wantPitch - this.aimPitch;
    this.aimPitch += clamp(dPitch, -maxYawStep, maxYawStep);

    if (this.reactionLeft > 0) this.reactionLeft -= dt;

    // Fire control
    let fire = false;
    const angularErr = Math.abs(angleDiff(wantYaw, this.aimYaw)) + Math.abs(dPitch) * 0.6;
    const canFire = visible && losClear && this.reactionLeft <= 0 && angularErr < 0.055 && dist < 220;

    if (canFire && w) {
      const def = WEAPONS[w.weaponId];
      if (this.burstPause > 0) {
        this.burstPause -= dt;
      } else {
        if (def.fireMode === 'auto') {
          if (this.burstLeft <= 0) this.burstLeft = 3 + gameNext() * 5;
          fire = true;
          this.burstLeft -= dt * (def.rpm / 60);
          if (this.burstLeft <= 0) {
            this.burstPause = 0.16 + gameNext() * 0.3;
          }
        } else {
          fire = true;
          this.burstPause = (60 / def.rpm) * (0.95 + gameNext() * 0.25);
        }
      }
    } else if (!canFire) {
      this.burstLeft = 0;
    }

    return { yaw: this.aimYaw, pitch: this.aimPitch, fire };
  }
}

export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
