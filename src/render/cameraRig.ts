/**
 * Camera rig: first-person and third-person shoulder view, camera collision,
 * ADS zoom, recoil offsets, shake, spectator following.
 */

import * as THREE from 'three';
import type { Actor } from '../sim/actor';
import { getSettings } from '../core/settings';
import { MATCH, MOVE } from '../core/balance';

const CAPSULE_CENTER_OFFSET = MOVE.capsuleHalfHeight + MOVE.capsuleRadius + 0.04;

/** Vertical distance from transport center to the drop-rig hang position. */
const TRANSPORT_HANG_OFFSET = MATCH.transportHangOffset;

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
  private blendFrom: THREE.Vector3 | null = null;
  private blendT = 1;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.08, 900);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  toggleMode(): void {
    this.mode = this.mode === 'fps' ? 'tps' : 'fps';
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

    // ADS FOV zoom
    const adsZoom = actor.wpn.adsAmount;
    this.currentAds += (adsZoom - this.currentAds) * Math.min(1, dt * 10);
    const sniperScoped = actor.inv.selectedWeapon?.weaponId === 'sniper' && this.currentAds > 0.85;
    const targetFov = this.baseFov - this.currentAds * (sniperScoped ? this.baseFov * 0.62 : 14);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 12);
      this.camera.updateProjectionMatrix();
    }

    // Shake decay
    this.shakeAmount *= Math.exp(-dt * 5.5);
    const shX = (Math.sin(this.shakeSeed + this.t2() * 47.3)) * 0.012 * this.shakeAmount;
    const shY = (Math.sin(this.shakeSeed * 1.7 + this.t2() * 39.1)) * 0.012 * this.shakeAmount;

    const p = actor.body.position;
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
        p.y + this.smoothEye + shY,
        p.z,
      );
      this.camera.quaternion.setFromEuler(new THREE.Euler(pitch + shY * 0.5, yaw + shX * 0.5, 0, 'YXZ'));
    } else {
      const pivot = new THREE.Vector3(p.x, p.y + this.smoothEye + 0.25, p.z);
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
    const pivot = new THREE.Vector3(p.x, p.y + CAPSULE_CENTER_OFFSET + 0.3, p.z);
    const back = dir.clone().multiplyScalar(-1);
    this.camera.position.copy(pivot).addScaledVector(back, 5);
    this.camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    void dt;
  }

  /**
   * Transport-phase presentation. FP: the player rides the drop rig under the
   * hull with free look. TPS: slow cinematic orbit framing the transport
   * against the map below.
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
    const hangY = pos.y - TRANSPORT_HANG_OFFSET + slot.y;
    if (this.mode === 'fps') {
      // Eye at the hang slot; slight sway from flight turbulence
      const swayX = Math.sin(t * 1.7) * 0.06 + Math.sin(t * 0.53) * 0.1;
      const swayY = Math.sin(t * 1.13) * 0.05;
      this.camera.position.set(pos.x + slot.x + swayX, hangY + 1.6 + swayY, pos.z + slot.z);
      this.camera.quaternion.setFromEuler(new THREE.Euler(playerPitch * 0.7, playerYaw, 0, 'YXZ'));
    } else {
      // Slow orbit around the transport, slightly above, transport centered
      const a = t * 0.08 + Math.PI * 0.35;
      const r = 24;
      this.camera.position.set(
        pos.x + Math.sin(a) * r,
        pos.y + 6.5 + Math.sin(t * 0.11) * 1.2,
        pos.z + Math.cos(a) * r,
      );
      this.camera.lookAt(pos.x, pos.y - 2.2, pos.z);
    }
    void dt;
  }

  /** Begin blending the camera back to gameplay after the transport jump. */
  beginGameplayBlend(from: THREE.Vector3): void {
    this.blendFrom = from.clone();
    this.blendT = 0;
  }
}
