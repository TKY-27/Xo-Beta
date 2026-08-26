/**
 * Camera rig: first-person and third-person shoulder view, camera collision,
 * ADS zoom, recoil offsets, shake, spectator following.
 */

import * as THREE from 'three';
import type { Actor } from '../sim/actor';
import { getSettings } from '../core/settings';
import { MOVE } from '../core/balance';
import { feetYFromBodyCenter } from '../physics/physics';

const _tv = new THREE.Vector3();

export interface PhysicsQuery {
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): { dist: number } | null;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: 'fps' | 'tps' = 'fps';
  private shakeAmount = 0;
  private shakeSeed = Math.random() * 1000;
  private baseFov = 80;
  private tpsDistance = 4.6;
  private currentAds = 0;
  private sprintKick = 0;
  private blendFrom: THREE.Vector3 | null = null;
  private blendT = 1;
  /** True while the sniper scope is fully engaged. */
  scoped = false;
  onScopedChanged: ((scoped: boolean) => void) | null = null;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.08, 900);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  toggleMode(): void {
    this.mode = this.mode === 'fps' ? 'tps' : 'fps';
    this.setScoped(false);
  }

  private setScoped(v: boolean): void {
    if (this.scoped === v) return;
    this.scoped = v;
    this.onScopedChanged?.(v);
  }

  addShake(amount: number): void {
    const s = getSettings().cameraShake;
    this.shakeAmount = Math.min(1.2, this.shakeAmount + amount * s);
  }

  /**
   * Position the camera from actor state. lookYaw/pitch already include
   * recoil (the sim writes punched values into actor.yaw/pitch consumers).
   */
  update(
    actor: Actor,
    dt: number,
    phys: PhysicsQuery,
    opts: { spectating?: boolean; deathCamHeight?: number } = {},
  ): void {
    const settings = getSettings();
    this.baseFov = settings.fov;

    let yaw = actor.yaw;
    let pitch = actor.pitch;
    if (!opts.spectating) {
      // Recoil punch applied visually on top of commanded aim
      yaw += actor.wpn.recoilYaw * 0.6;
      pitch += actor.wpn.recoilPitch * 0.6;
    }

    // ADS FOV zoom + sprint FOV kick
    const adsZoom = actor.wpn.adsAmount;
    this.currentAds += (adsZoom - this.currentAds) * Math.min(1, dt * 10);
    const hsNow = Math.hypot(actor.body.velocity.x, actor.body.velocity.z);
    const sprinting = actor.body.grounded && !actor.crouched && hsNow > MOVE.walkSpeed + 0.8;
    this.sprintKick += ((sprinting ? 1 : 0) - this.sprintKick) * Math.min(1, dt * 6);
    const sniperScoped = actor.inv.selectedWeapon?.weaponId === 'sniper' && this.currentAds > 0.85;
    // Full scope: ~5x magnification (baseFov 80 -> ~22.4). Partial ADS keeps
    // the normal modest zoom so snap-scoping stays readable.
    const targetFov =
      this.baseFov - this.currentAds * (sniperScoped ? this.baseFov * 0.72 : 14) +
      this.sprintKick * this.baseFov * 0.085;
    const scopedNow = sniperScoped && this.currentAds > 0.97;
    this.setScoped(scopedNow);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 12);
      this.camera.updateProjectionMatrix();
    }

    // Shake decay
    this.shakeAmount *= Math.exp(-dt * 5.5);
    const shX = (Math.sin(this.shakeSeed + this.t2() * 47.3)) * 0.012 * this.shakeAmount;
    const shY = (Math.sin(this.shakeSeed * 1.7 + this.t2() * 39.1)) * 0.012 * this.shakeAmount;

    const p = actor.body.position;
    const feetY = feetYFromBodyCenter(p.y);
    const eyeH = actor.crouched ? MOVE.crouchEyeHeight : MOVE.eyeHeight;
    // Smooth crouch transitions
    this.smoothEye += ((eyeH - this.smoothEye)) * Math.min(1, dt * 12);

    const dir = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    );

    if (this.mode === 'fps') {
      this.camera.position.set(
        p.x + shX,
        feetY + this.smoothEye + shY,
        p.z,
      );
      this.camera.quaternion.setFromEuler(new THREE.Euler(pitch + shY * 0.5, yaw + shX * 0.5, 0, 'YXZ'));
    } else {
      const pivot = new THREE.Vector3(p.x, feetY + this.smoothEye + 0.25, p.z);
      const desiredDist = this.tpsDistance + this.currentAds * 1.1;
      // Camera collision: pull in when geometry blocks the boom
      const back = dir.clone().multiplyScalar(-1);
      const hit = phys.raycast(pivot.x, pivot.y, pivot.z, back.x, back.y, back.z, desiredDist + 0.3);
      const dist = hit ? Math.max(0.7, hit.dist - 0.35) : desiredDist;
      this.camera.position.copy(pivot).addScaledVector(back, dist);
      this.camera.position.y += shY;
      this.camera.quaternion.setFromEuler(new THREE.Euler(pitch + shY * 0.4, yaw + shX * 0.4, 0, 'YXZ'));
    }

    // Smooth transport→gameplay handoff
    if (this.blendT < 1 && this.blendFrom) {
      this.blendT = Math.min(1, this.blendT + dt / 0.7);
      const k = this.blendT * this.blendT * (3 - 2 * this.blendT);
      this.camera.position.lerpVectors(this.blendFrom, this.camera.position, k);
      if (this.blendT >= 1) this.blendFrom = null;
    }
  }
  private smoothEye = MOVE.eyeHeight;
  private clockT = 0;
  private t2(): number {
    return this.clockT;
  }
  tick(dt: number): void {
    this.clockT += dt;
  }

  /** Spectator orbit around an alive target actor. */
  updateSpectate(target: Actor, dt: number): void {
    const p = target.body.position;
    const yaw = target.yaw;
    const pitch = target.pitch;
    const dir = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    );
    const pivot = new THREE.Vector3(p.x, target.eyeY - 0.2, p.z);
    const back = dir.clone().multiplyScalar(-1);
    this.camera.position.copy(pivot).addScaledVector(back, 5);
    this.camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    void dt;
  }

  /** Azimuth toward the visible sun (set by main after sky setup); the
   * transport orbit avoids framing it so the hull never sits in glare. */
  sunAzimuth: number | null = null;

  /**
   * Transport-phase presentation: a single free-look orbit used regardless of
   * the FP/TPS preference (that choice applies once the jump starts). The
   * look input swings the camera around the transport, which therefore stays
   * framed dead-center; the orbit radius keeps the hull clear of the lens.
   */
  updateTransport(
    pos: { x: number; y: number; z: number },
    slot: { x: number; y: number; z: number },
    playerYaw: number,
    playerPitch: number,
    t: number,
    dt: number,
  ): void {
    this.smoothEye = MOVE.eyeHeight;
    void slot;
    // Bias the orbit downward so the transport is framed against the
    // landscape below (never against the sky/sun glare), while look input
    // still swings the view around the hull.
    const pitch = THREE.MathUtils.clamp(playerPitch * 0.55 + 0.52, 0.3, 1.05);
    // Pick the quadrant around the hull whose view direction stays farthest
    // from the sun azimuth (view direction is orbitYaw + PI).
    let orbitYaw = playerYaw;
    if (this.sunAzimuth !== null) {
      let best = -Infinity;
      for (const cand of [playerYaw, playerYaw + Math.PI / 2, playerYaw - Math.PI / 2, playerYaw + Math.PI]) {
        const d = Math.abs(Math.atan2(Math.sin(cand + Math.PI - this.sunAzimuth), Math.cos(cand + Math.PI - this.sunAzimuth)));
        if (d > best) {
          best = d;
          orbitYaw = cand;
        }
      }
    }
    const r = 26;
    const cy = pos.y - 1.5 + Math.sin(t * 1.13) * 0.05;
    _tv.set(
      pos.x + Math.sin(orbitYaw) * Math.cos(pitch) * r,
      cy + Math.sin(pitch) * r,
      pos.z + Math.cos(orbitYaw) * Math.cos(pitch) * r,
    );
    // Smooth pursuit so look input feels weighty, never snappy.
    this.camera.position.lerp(_tv, Math.min(1, dt * 6));
    this.camera.lookAt(pos.x, cy - 2.2, pos.z);
  }

  /** Begin blending the camera back to gameplay after the transport jump. */
  beginGameplayBlend(from: THREE.Vector3): void {
    this.blendFrom = from.clone();
    this.blendT = 0;
  }
}
