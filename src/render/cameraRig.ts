/**
 * Camera rig: first-person and third-person shoulder view, camera collision,
 * ADS zoom, recoil offsets, shake, spectator following.
 */

import * as THREE from 'three';
import type { Actor } from '../sim/actor';
import type { ActorView } from '../sim/gameStateView';
import { getSettings } from '../core/settings';
import { MOVE } from '../core/balance';
import { feetYFromBodyCenter } from '../physics/physics';

const _tv = new THREE.Vector3();
const _cameraOffset = new THREE.Vector3();
const _cameraLook = new THREE.Vector3();
const _cameraUp = new THREE.Vector3(0, 1, 0);
const _cameraQuat = new THREE.Quaternion();

export const TRANSPORT_CAMERA = Object.freeze({
  height: 22,
  rear: 30,
  lateral: 5.2,
  lookAhead: 6,
  lookHeight: 0.5,
});

export const SPECTATOR_CAMERA = Object.freeze({
  rear: 6.2,
  height: 2.6,
  lateral: 0.8,
  torsoHeight: 1.35,
  contractRate: 22,
  recoverRate: 2.8,
  hysteresis: 0.28,
});

export interface PhysicsQuery {
  cameraCast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, radius?: number): { dist: number } | null;
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
  private blendFromQuat: THREE.Quaternion | null = null;
  private blendFromFov = 80;
  private blendT = 1;
  private spectateInitialized = false;
  private spectateTargetId: number | null = null;
  private spectateYaw = 0;
  private spectateDistance: number = SPECTATOR_CAMERA.rear;
  private spectateObstructed = false;
  private transportInitialized = false;
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

  /** Clear presentation-only aim state when entering a non-combat camera. */
  resetAimState(resetFov = true): void {
    this.currentAds = 0;
    this.sprintKick = 0;
    this.shakeAmount = 0;
    this.setScoped(false);
    if (resetFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
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
    // The primary view keeps a modest ADS zoom. A dedicated scope camera owns
    // the ~5x optical view, preventing the old full-screen magnification hack.
    const presentationFov = this.mode === 'tps'
      ? THREE.MathUtils.clamp(this.baseFov * 0.55, 42, 60)
      : this.baseFov;
    const targetFov =
      presentationFov - this.currentAds * (this.mode === 'tps' ? 6 : 14) +
      this.sprintKick * presentationFov * 0.085;
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
      // Chest-height pivot keeps both head and feet inside the tighter TPS
      // framing instead of anchoring the boom at first-person eye height.
      const pivot = new THREE.Vector3(p.x, feetY + this.smoothEye - 0.55, p.z);
      const desiredDist = this.tpsDistance + this.currentAds * 1.1;
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      // Positive right offset places the character on the left side of the
      // image; the opposite sign supports a left-handed/right-side layout.
      const shoulder = settings.tpsCharacterSide === 'right' ? -1 : 1;
      // The TPS-specific vertical FOV allows a natural ~1 unit physical
      // shoulder offset to project the rig near 35/65% X at 16:9.
      const desired = dir.clone().multiplyScalar(-desiredDist).addScaledVector(right, shoulder * 0.95);
      const boomLength = desired.length();
      desired.multiplyScalar(1 / Math.max(boomLength, 1e-6));
      const hit = phys.cameraCast(pivot.x, pivot.y, pivot.z, desired.x, desired.y, desired.z, boomLength, 0.2);
      // Never force the camera past a near obstruction. The former 0.75 m
      // minimum could exceed the sweep hit distance beside an indoor wall,
      // placing the TPS camera inside/behind that wall and filling the frame.
      const dist = hit ? Math.max(this.camera.near + 0.02, hit.dist - 0.08) : boomLength;
      this.camera.position.copy(pivot).addScaledVector(desired, dist);
      this.camera.position.y += shY;
      this.camera.quaternion.setFromEuler(new THREE.Euler(pitch + shY * 0.4, yaw + shX * 0.4, 0, 'YXZ'));
    }

    // Smooth transport→gameplay handoff
    if (this.blendT < 1 && this.blendFrom) {
      this.blendT = Math.min(1, this.blendT + dt / 0.7);
      const k = this.blendT * this.blendT * (3 - 2 * this.blendT);
      const targetPos = this.camera.position.clone();
      const targetQuat = this.camera.quaternion.clone();
      const targetFovNow = this.camera.fov;
      this.camera.position.lerpVectors(this.blendFrom, targetPos, k);
      if (this.blendFromQuat) this.camera.quaternion.slerpQuaternions(this.blendFromQuat, targetQuat, k);
      this.camera.fov = THREE.MathUtils.lerp(this.blendFromFov, targetFovNow, k);
      this.camera.updateProjectionMatrix();
      if (this.blendT >= 1) {
        this.blendFrom = null;
        this.blendFromQuat = null;
      }
    }
  }

  /** Camera update for a replica actor. It intentionally consumes only the
   * read-only ActorView surface; recoil, ADS and movement prediction remain
   * local presentation concerns and are not reconstructed as authority. */
  updateView(
    actor: ActorView,
    dt: number,
    phys: PhysicsQuery,
    opts: { spectating?: boolean; adsAmount?: number; recoilYaw?: number; recoilPitch?: number } = {},
  ): void {
    if (opts.spectating) {
      this.updateSpectateView(actor, dt, phys);
      return;
    }
    const settings = getSettings();
    this.baseFov = settings.fov;
    const adsTarget = THREE.MathUtils.clamp(opts.adsAmount ?? 0, 0, 1);
    this.currentAds += (adsTarget - this.currentAds) * Math.min(1, dt * 10);
    const horizontalSpeed = Math.hypot(actor.velocity.x, actor.velocity.z);
    const sprinting = actor.grounded && !actor.crouched && horizontalSpeed > MOVE.walkSpeed + 0.8;
    this.sprintKick += ((sprinting ? 1 : 0) - this.sprintKick) * Math.min(1, dt * 6);
    const presentationFov = this.mode === 'tps'
      ? THREE.MathUtils.clamp(this.baseFov * 0.55, 42, 60)
      : this.baseFov;
    const targetFov = presentationFov - this.currentAds * (this.mode === 'tps' ? 6 : 14)
      + this.sprintKick * presentationFov * 0.085;
    this.setScoped(actor.equippedWeapon === 'sniper' && this.currentAds > 0.97);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 12);
    this.camera.updateProjectionMatrix();
    this.shakeAmount *= Math.exp(-dt * 5.5);
    const shakeX = Math.sin(this.shakeSeed + this.t2() * 47.3) * 0.012 * this.shakeAmount;
    const shakeY = Math.sin(this.shakeSeed * 1.7 + this.t2() * 39.1) * 0.012 * this.shakeAmount;
    const p = actor.position;
    const feetY = feetYFromBodyCenter(p.y);
    const eyeH = actor.crouched ? MOVE.crouchEyeHeight : MOVE.eyeHeight;
    this.smoothEye += (eyeH - this.smoothEye) * Math.min(1, dt * 12);
    const yaw = actor.yaw + (opts.recoilYaw ?? 0) * 0.6;
    const pitch = actor.pitch + (opts.recoilPitch ?? 0) * 0.6;
    if (this.mode === 'fps') {
      this.camera.position.set(p.x + shakeX, feetY + this.smoothEye + shakeY, p.z);
      this.camera.quaternion.setFromEuler(new THREE.Euler(pitch + shakeY * 0.5, yaw + shakeX * 0.5, 0, 'YXZ'));
      return;
    }
    const direction = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    );
    const pivot = new THREE.Vector3(p.x, feetY + this.smoothEye - 0.55, p.z);
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const shoulder = settings.tpsCharacterSide === 'right' ? -1 : 1;
    const desired = direction.multiplyScalar(-(this.tpsDistance + this.currentAds * 1.1))
      .addScaledVector(right, shoulder * 0.95);
    const boomLength = desired.length();
    desired.multiplyScalar(1 / Math.max(boomLength, 1e-6));
    const hit = phys.cameraCast(
      pivot.x, pivot.y, pivot.z,
      desired.x, desired.y, desired.z,
      boomLength,
      0.2,
    );
    const distance = hit ? Math.max(this.camera.near + 0.02, hit.dist - 0.08) : boomLength;
    this.camera.position.copy(pivot).addScaledVector(desired, distance);
    this.camera.position.y += shakeY;
    this.camera.quaternion.setFromEuler(new THREE.Euler(pitch + shakeY * 0.4, yaw + shakeX * 0.4, 0, 'YXZ'));
  }

  /** Stable spectator camera driven by interpolated replica state. */
  updateSpectateView(target: ActorView, dt: number, phys: PhysicsQuery): void {
    this.setScoped(false);
    this.baseFov = getSettings().fov;
    this.camera.fov += (this.baseFov - this.camera.fov) * Math.min(1, dt * 12);
    this.camera.updateProjectionMatrix();
    const targetChanged = this.spectateTargetId !== target.id;
    if (targetChanged) {
      this.spectateTargetId = target.id;
      this.spectateYaw = target.yaw;
      this.spectateDistance = SPECTATOR_CAMERA.rear;
      this.spectateObstructed = false;
      this.spectateInitialized = false;
    }
    const speed = Math.hypot(target.velocity.x, target.velocity.z);
    const movementYaw = speed > 0.45
      ? Math.atan2(-target.velocity.x, -target.velocity.z)
      : target.yaw;
    const yawDelta = Math.atan2(Math.sin(movementYaw - this.spectateYaw), Math.cos(movementYaw - this.spectateYaw));
    this.spectateYaw += yawDelta * (1 - Math.exp(-dt * 7));
    const feetY = feetYFromBodyCenter(target.position.y);
    const pivot = new THREE.Vector3(target.position.x, feetY + SPECTATOR_CAMERA.torsoHeight, target.position.z);
    const back = new THREE.Vector3(Math.sin(this.spectateYaw), 0, Math.cos(this.spectateYaw));
    const right = new THREE.Vector3(Math.cos(this.spectateYaw), 0, -Math.sin(this.spectateYaw));
    _cameraOffset.copy(back).multiplyScalar(SPECTATOR_CAMERA.rear)
      .addScaledVector(right, SPECTATOR_CAMERA.lateral)
      .y = SPECTATOR_CAMERA.height - SPECTATOR_CAMERA.torsoHeight;
    const boomLength = _cameraOffset.length();
    _cameraOffset.multiplyScalar(1 / Math.max(boomLength, 1e-6));
    const hit = phys.cameraCast(pivot.x, pivot.y, pivot.z, _cameraOffset.x, _cameraOffset.y, _cameraOffset.z, boomLength, 0.2);
    const hitDistance = hit ? Math.max(this.camera.near + 0.02, hit.dist - 0.08) : boomLength;
    const blocked = hit !== null && hitDistance < boomLength - SPECTATOR_CAMERA.hysteresis;
    if (blocked) {
      this.spectateObstructed = true;
      this.spectateDistance += (Math.min(this.spectateDistance, hitDistance) - this.spectateDistance)
        * (1 - Math.exp(-dt * SPECTATOR_CAMERA.contractRate));
    } else if (this.spectateObstructed && (!hit || hitDistance >= boomLength - SPECTATOR_CAMERA.hysteresis * 0.35)) {
      this.spectateObstructed = false;
      this.spectateDistance += (boomLength - this.spectateDistance) * (1 - Math.exp(-dt * SPECTATOR_CAMERA.recoverRate));
    } else if (!this.spectateObstructed) {
      this.spectateDistance = boomLength;
    }
    this.spectateDistance = THREE.MathUtils.clamp(this.spectateDistance, this.camera.near + 0.02, boomLength);
    _tv.copy(pivot).addScaledVector(_cameraOffset, this.spectateDistance);
    _cameraLook.copy(pivot);
    _cameraQuat.setFromRotationMatrix(new THREE.Matrix4().lookAt(_tv, _cameraLook, _cameraUp));
    if (!this.spectateInitialized || targetChanged) {
      this.camera.position.copy(_tv);
      this.camera.quaternion.copy(_cameraQuat);
      this.spectateInitialized = true;
    } else {
      this.camera.position.lerp(_tv, 1 - Math.exp(-dt * 10));
      this.camera.quaternion.slerp(_cameraQuat, 1 - Math.exp(-dt * 12));
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
  updateSpectate(target: Actor, dt: number, phys: PhysicsQuery): void {
    this.setScoped(false);
    this.baseFov = getSettings().fov;
    this.camera.fov += (this.baseFov - this.camera.fov) * Math.min(1, dt * 12);
    this.camera.updateProjectionMatrix();
    const p = target.body.position;
    const targetChanged = this.spectateTargetId !== target.id;
    if (targetChanged) {
      // A new target owns a new camera trail. Never carry the previous actor's
      // interpolated position, yaw or collision distance into this actor.
      this.spectateTargetId = target.id;
      this.spectateYaw = target.yaw;
      this.spectateDistance = SPECTATOR_CAMERA.rear;
      this.spectateObstructed = false;
      this.spectateInitialized = false;
    }

    const speed = Math.hypot(target.body.velocity.x, target.body.velocity.z);
    const movementYaw = speed > 0.45
      ? Math.atan2(-target.body.velocity.x, -target.body.velocity.z)
      : target.yaw;
    const yawDelta = Math.atan2(Math.sin(movementYaw - this.spectateYaw), Math.cos(movementYaw - this.spectateYaw));
    this.spectateYaw += yawDelta * (1 - Math.exp(-dt * 7));

    const feetY = feetYFromBodyCenter(p.y);
    const pivot = new THREE.Vector3(p.x, feetY + SPECTATOR_CAMERA.torsoHeight, p.z);
    const back = new THREE.Vector3(Math.sin(this.spectateYaw), 0, Math.cos(this.spectateYaw));
    const right = new THREE.Vector3(Math.cos(this.spectateYaw), 0, -Math.sin(this.spectateYaw));
    _cameraOffset.copy(back).multiplyScalar(SPECTATOR_CAMERA.rear)
      .addScaledVector(right, SPECTATOR_CAMERA.lateral)
      .y = SPECTATOR_CAMERA.height - SPECTATOR_CAMERA.torsoHeight;
    const boomLength = _cameraOffset.length();
    _cameraOffset.multiplyScalar(1 / Math.max(boomLength, 1e-6));
    const hit = phys.cameraCast(pivot.x, pivot.y, pivot.z, _cameraOffset.x, _cameraOffset.y, _cameraOffset.z, boomLength, 0.2);
    const hitDistance = hit ? Math.max(this.camera.near + 0.02, hit.dist - 0.08) : boomLength;
    const blocked = hit !== null && hitDistance < boomLength - SPECTATOR_CAMERA.hysteresis;
    if (blocked) {
      this.spectateObstructed = true;
      this.spectateDistance += (Math.min(this.spectateDistance, hitDistance) - this.spectateDistance)
        * (1 - Math.exp(-dt * SPECTATOR_CAMERA.contractRate));
    } else if (this.spectateObstructed && (!hit || hitDistance >= boomLength - SPECTATOR_CAMERA.hysteresis * 0.35)) {
      this.spectateObstructed = false;
      this.spectateDistance += (boomLength - this.spectateDistance)
        * (1 - Math.exp(-dt * SPECTATOR_CAMERA.recoverRate));
    } else if (!this.spectateObstructed) {
      this.spectateDistance = boomLength;
    }
    this.spectateDistance = THREE.MathUtils.clamp(this.spectateDistance, this.camera.near + 0.02, boomLength);
    _tv.copy(pivot).addScaledVector(_cameraOffset, this.spectateDistance);
    _cameraLook.copy(pivot);
    _cameraQuat.setFromRotationMatrix(new THREE.Matrix4().lookAt(_tv, _cameraLook, _cameraUp));
    if (!this.spectateInitialized || targetChanged) {
      this.camera.position.copy(_tv);
      this.camera.quaternion.copy(_cameraQuat);
      this.spectateInitialized = true;
    } else {
      this.camera.position.lerp(_tv, 1 - Math.exp(-dt * 10));
      this.camera.quaternion.slerp(_cameraQuat, 1 - Math.exp(-dt * 12));
    }
  }

  endSpectate(): void {
    this.spectateInitialized = false;
    this.spectateTargetId = null;
    this.spectateObstructed = false;
    this.spectateDistance = SPECTATOR_CAMERA.rear;
  }

  /**
   * Transport-phase presentation. Both view modes use one external camera
   * above and behind the interpolated hull. Free look changes only the bounded
   * look target; it can never move the camera into a hanging seat.
   */
  updateTransport(
    pos: { x: number; y: number; z: number },
    slot: { x: number; y: number; z: number },
    playerYaw: number,
    playerPitch: number,
    _t: number,
    dt: number,
  ): void {
    this.resetAimState(false);
    this.baseFov = getSettings().fov;
    const transportFov = THREE.MathUtils.clamp(this.baseFov * 0.78, 55, 72);
    this.camera.fov += (transportFov - this.camera.fov) * Math.min(1, dt * 14);
    this.camera.updateProjectionMatrix();
    this.smoothEye = MOVE.eyeHeight;
    const pitch = THREE.MathUtils.clamp(playerPitch, -1.35, 1.35);
    void slot;
    const horizontalForward = new THREE.Vector3(-Math.sin(playerYaw), 0, -Math.cos(playerYaw));
    const right = new THREE.Vector3(Math.cos(playerYaw), 0, -Math.sin(playerYaw));
    const hull = new THREE.Vector3(pos.x, pos.y - 2.5, pos.z);
    _tv.copy(hull)
      .addScaledVector(horizontalForward, -TRANSPORT_CAMERA.rear)
      .addScaledVector(right, getSettings().tpsCharacterSide === 'right' ? -TRANSPORT_CAMERA.lateral : TRANSPORT_CAMERA.lateral);
    _tv.y = pos.y + TRANSPORT_CAMERA.height;
    _cameraLook.copy(hull)
      .addScaledVector(horizontalForward, TRANSPORT_CAMERA.lookAhead)
      .y += TRANSPORT_CAMERA.lookHeight + THREE.MathUtils.clamp(pitch, -1.1, 1.1) * 4.5;
    const look = new THREE.Matrix4().lookAt(_tv, _cameraLook, _cameraUp);
    _cameraQuat.setFromRotationMatrix(look);
    if (!this.transportInitialized) {
      this.camera.position.copy(_tv);
      this.camera.quaternion.copy(_cameraQuat);
      this.transportInitialized = true;
    } else {
      this.camera.position.lerp(_tv, 1 - Math.exp(-dt * 16));
      this.camera.quaternion.slerp(_cameraQuat, 1 - Math.exp(-dt * 18));
    }
  }

  /** Begin blending the camera back to gameplay after the transport jump. */
  beginGameplayBlend(): void {
    this.blendFrom = this.camera.position.clone();
    this.blendFromQuat = this.camera.quaternion.clone();
    this.blendFromFov = this.camera.fov;
    this.blendT = 0;
  }
}
