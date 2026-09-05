/**
 * First-person viewmodel: composed weapon models (CC0 Kenney blaster parts),
 * arms, sway, inertia, walking bob, procedural recoil, ADS transition,
 * sprint lowering, tactical/empty reload animation, bolt cycling.
 */

import * as THREE from 'three';
import { WEAPONS, type Rarity, type WeaponId } from '../core/balance';
import type { Actor } from '../sim/actor';
import type { ActorView } from '../sim/gameStateView';
import { WeaponModelFactory, type WeaponModel } from './weaponModels';

const HIP_POS = new THREE.Vector3(0.185, -0.17, -0.06);
const ADS_POS = new THREE.Vector3(0, -0.075, -0.14);
const SPRINT_POS = new THREE.Vector3(0.12, -0.26, -0.1);

export class ViewModel {
  /**
   * Scene-child root. It carries NO pose of its own: `syncCamera` glues it to
   * the camera every frame. (Historical bug: this group once sat at the scene
   * origin while `update()` wrote view-space hip offsets into it, so the
   * first-person weapon rendered ~at the map spawn and the player simply
   * never saw a weapon.)
   */
  readonly group = new THREE.Group();
  /** Pose space: every authored offset (hip/ADS/sprint/bob/recoil/inspect)
   * and all attached models/arms live here, relative to the camera. */
  private readonly pivot = new THREE.Group();
  private factory: WeaponModelFactory;
  private models = new Map<string, WeaponModel>();
  private armMat: THREE.MeshStandardMaterial;
  private gloveMat: THREE.MeshStandardMaterial;
  private currentId: WeaponId | null = null;
  private currentKey: string | null = null;
  private currentModel: WeaponModel | null = null;
  private t = 0;

  // Fists (permanent melee pseudo-weapon)
  private fistsR = new THREE.Group();
  private fistsL = new THREE.Group();
  private punchT = 0;
  private punchHand = 0;

  // Animation state
  private swayX = 0;
  private swayY = 0;
  private swayRoll = 0;
  private recoilZ = 0;
  private recoilPitch = 0;
  private reloadT = 0;
  private swapT = 0;
  private adsSmooth = 0;
  private sprintBlend = 0;
  private lastSpeed = 0;
  // Inspect flourish: <0 inactive, else elapsed seconds into the sweep.
  private inspectT = -1;
  private static readonly INSPECT_DURATION = 2.2;

  /**
   * Begin (or restart) the weapon-inspect flourish. Fails while unarmed or
   * mid-swap — the arms have nothing to show and the swap dip owns the pose.
   */
  startInspect(): boolean {
    if (!this.currentId) return false;
    if (this.swapT > 0) return false;
    this.inspectT = 0;
    return true;
  }

  /** Hard-cancel (firing, reloading). */
  cancelInspect(): void {
    this.inspectT = -1;
  }

  /**
   * Advance the inspect timeline and return its additive pose contribution.
   * Auto-cancels when the player aims, sprints or fires — the flourish never
   * fights gameplay poses.
   */
  private inspectPose(dt: number, ads: number, sprinting: number, reloading: boolean): {
    weight: number; pitch: number; yaw: number; roll: number; lift: number;
  } {
    if (this.inspectT >= 0) {
      if (ads > 0.25 || sprinting || reloading) this.inspectT = -1;
      else this.inspectT += dt;
      if (this.inspectT >= ViewModel.INSPECT_DURATION) this.inspectT = -1;
    }
    const weight = (1 - ads) * (1 - sprinting);
    if (this.inspectT < 0 || weight < 0.05) {
      return { weight: 0, pitch: 0, yaw: 0, roll: 0, lift: 0 };
    }
    const p = Math.min(1, this.inspectT / ViewModel.INSPECT_DURATION);
    const env = Math.sin(p * Math.PI);
    // Rotate the receiver toward the camera and roll it to read the far
    // side, then a slight top tilt before returning to the hip pose. Yaw is
    // deliberately moderate: the pivot sits at the eye, so large swings
    // carry the weapon off-frame.
    const yaw = env * 0.5;
    const roll = env * 0.34 * Math.sin(p * Math.PI * 2 + 0.7);
    const pitch = env * 0.12;
    const lift = env;
    return { weight, pitch, yaw, roll, lift };
  }
  /**
   * Muzzle flash light. Deliberately NOT a child of `group`: the group is
   * hidden during sniper scope, spectator and transport phases, and an
   * invisible light changes the renderer's NUM_POINT_LIGHTS — forcing every
   * material in the scene through a full shader recompile (the "first scope
   * entry freeze"). The light is parked in the scene root with intensity 0
   * instead, so the light count never varies.
   */
  readonly muzzleFlashLight: THREE.PointLight;

  constructor(factory: WeaponModelFactory) {
    this.factory = factory;
    this.armMat = new THREE.MeshStandardMaterial({ color: 0x2e3a44, roughness: 0.62, metalness: 0.22 });
    this.gloveMat = new THREE.MeshStandardMaterial({ color: 0x191d22, roughness: 0.55, metalness: 0.3 });
    this.group.add(this.pivot);
    this.buildArms();
    this.buildFists();

    this.muzzleFlashLight = new THREE.PointLight(0xffc878, 0, 7, 2);
  }

  /**
   * Glue the pose root to the camera. Call once per frame before
   * update()/updateView(); the pivot then positions the weapon relative to
   * the view, exactly as the HIP/ADS/SPRINT constants are authored.
   */
  syncCamera(camera: THREE.Camera): void {
    this.group.position.copy(camera.position);
    this.group.quaternion.copy(camera.quaternion);
  }

  private buildArms(): void {
    // Right arm (trigger hand)
    const armR = new THREE.Mesh(new THREE.CapsuleGeometry(0.047, 0.3, 4, 10), this.armMat);
    armR.position.set(0.175, -0.235, -0.16);
    armR.rotation.set(1.25, -0.12, 0.1);
    const gloveR = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.115), this.gloveMat);
    gloveR.position.set(0.055, -0.145, -0.31);
    gloveR.rotation.x = 0.35;
    // Left support arm
    const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.044, 0.27, 4, 10), this.armMat);
    armL.position.set(-0.135, -0.255, -0.4);
    armL.rotation.set(1.32, 0.42, 0);
    const gloveL = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.082, 0.11), this.gloveMat);
    gloveL.position.set(-0.062, -0.185, -0.545);
    gloveL.rotation.set(0.3, 0, -0.15);
    // Forearm guard accent
    const guardR = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.02, 0.14), this.gloveMat);
    guardR.position.set(0.09, -0.19, -0.24);
    guardR.rotation.x = 1.25;
    for (const m of [armR, armL, gloveR, gloveL, guardR]) m.castShadow = false;
    this.pivot.add(armR, armL, gloveR, gloveL, guardR);
  }

  private buildFists(): void {
    const mkHand = (side: 1 | -1, group: THREE.Group): void => {
      const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.3, 4, 10), this.armMat);
      forearm.position.set(0.02 * side, -0.06, 0.14);
      forearm.rotation.set(1.15, -0.18 * side, -0.22 * side);
      const fist = new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.075, 4, 12), this.gloveMat);
      fist.rotation.z = Math.PI / 2;
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.028, 0.03), this.armMat);
      ridge.position.set(0, 0.048, 0);
      // Knuckle plate accent
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.02, 0.05), this.gloveMat);
      plate.position.set(0, 0.01, -0.045);
      plate.rotation.x = -0.25;
      const wrap = new THREE.Group();
      wrap.add(fist, ridge, plate);
      wrap.position.set(0.11 * side, -0.16, -0.34);
      wrap.rotation.set(0.32, 0.24 * side, -0.12 * side);
      group.add(forearm, wrap);
      for (const m of [forearm, fist, ridge, plate]) m.castShadow = false;
      group.visible = false;
      this.pivot.add(group);
    };
    mkHand(1, this.fistsR);
    mkHand(-1, this.fistsL);
  }

  /** View-space scale for the hand-held weapon. The factory builds to real
   * canonical length (~1 m AR) for world/loot presentation; at the hip offset
   * (~6 cm from the eye) that fills half the screen, so the viewmodel carries
   * its own presentation scale, like every shipped FPS does. */
  private static readonly WEAPON_VIEW_SCALE = 0.55;

  private modelFor(id: WeaponId, rarity: Rarity): WeaponModel | null {
    const key = `${id}:${rarity}`;
    let m = this.models.get(key);
    if (!m) {
      const built = this.factory.build(id, rarity);
      if (!built) return null;
      m = built;
      m.group.scale.setScalar(ViewModel.WEAPON_VIEW_SCALE);
      // viewmodel render tuning: draw over world, no shadow casting
      m.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) { mesh.castShadow = false; mesh.receiveShadow = false; }
        const mat = mesh.material as THREE.Material | undefined;
        if (mat && 'depthTest' in mat) { /* keep depth test; weapon clips handled by proximity */ }
      });
      m.group.visible = false;
      this.models.set(key, m);
      this.pivot.add(m.group);
    }
    return m;
  }

  setWeapon(id: WeaponId | null, rarity: Rarity): void {
    const key = id ? `${id}:${rarity}` : null;
    if (this.currentKey === key) return;
    if (this.currentModel) this.currentModel.group.visible = false;
    this.currentId = id;
    this.currentKey = key;
    this.currentModel = id ? this.modelFor(id, rarity) : null;
    if (this.currentModel) this.currentModel.group.visible = true;
    const unarmed = !id;
    if (this.fistsR.visible !== unarmed) {
      this.fistsR.visible = unarmed;
      this.fistsL.visible = unarmed;
    }
    this.swapT = 0.32;
  }

  dispose(): void {
    // Weapon instances share resources with the page-lifetime factory; detach
    // them before releasing the viewmodel's own arms/fists geometry.
    for (const model of this.models.values()) this.group.remove(model.group);
    const geometries = new Set<THREE.BufferGeometry>();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) geometries.add(mesh.geometry);
    });
    for (const geometry of geometries) geometry.dispose();
    this.armMat.dispose();
    this.gloveMat.dispose();
    this.currentKey = null;
    this.currentModel = null;
    this.models.clear();
    this.group.clear();
  }

  /** Trigger a punch animation (alternating hands). */
  punch(): void {
    this.punchT = 0.3;
    this.punchHand ^= 1;
  }

  /** Muzzle flash light pulse at the barrel tip. Resolved through the
   * model's world matrix (camera→pivot→weapon chain) — during a pulse the
   * intensity decays in ~100 ms, so one frame of staleness is invisible. */
  muzzlePulse(strength: number): void {
    this.muzzleFlashLight.intensity = 5 * strength;
    const m = this.currentModel;
    if (m) {
      m.group.localToWorld(this.muzzleFlashLight.position.copy(m.muzzle));
    }
  }

  /** Per-frame presentation update driven by actor state. */
  update(actor: Actor | null, dt: number, lookDx: number, lookDy: number, movingSpeed: number): void {
    this.t += dt;
    this.muzzleFlashLight.intensity *= Math.exp(-dt * 30);
    if (!actor || (!this.currentId && !this.fistsR.visible)) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    // Sway from look input (inertia: weapon lags behind aim)
    this.swayX += (-lookDx * 0.00095 - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (-lookDy * 0.00085 - this.swayY) * Math.min(1, dt * 9);
    this.swayRoll += (-lookDx * 0.00045 - this.swayRoll) * Math.min(1, dt * 7);

    // Walk bob (figure-8), suppressed while aiming
    const speedDelta = Math.abs(movingSpeed - this.lastSpeed);
    this.lastSpeed = movingSpeed;
    void speedDelta;

    // Recoil recovery (spring)
    this.recoilZ *= Math.exp(-8.5 * dt);
    this.recoilPitch *= Math.exp(-7 * dt);

    // Swap-in dip
    this.swapT = Math.max(0, this.swapT - dt);
    const swapDip = Math.sin((this.swapT / 0.32) * Math.PI) * 0.16;

    if (!this.currentId) {
      this.updateFists(actor.crouched, dt, movingSpeed, swapDip);
      return;
    }

    const def = WEAPONS[actor.inv.selectedWeapon?.weaponId ?? 'pistol'];
    const adsTarget = actor.wpn.adsAmount;
    this.adsSmooth += (adsTarget - this.adsSmooth) * Math.min(1, dt * 12);
    const ads = this.adsSmooth;

    // Sprint lowering when moving fast & not aiming
    const sprinting = movingSpeed > 8.6 && !adsTarget;
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 7);

    const bobAmp = movingSpeed > 0.5 ? Math.min(1, movingSpeed / 9.5) : 0;
    const bobFreq = Math.max(6, movingSpeed * 0.92);
    const bobX = Math.sin(this.t * bobFreq) * 0.0105 * bobAmp * (1 - ads * 0.88);
    const bobY = Math.abs(Math.cos(this.t * bobFreq)) * 0.0125 * bobAmp * (1 - ads * 0.88);

    // Reload choreography
    const reloading = actor.wpn.reloadTimer > 0;
    let reloadPitch = 0;
    let reloadRoll = 0;
    let reloadDrop = 0;
    const mag = this.currentModel?.mag ?? null;
    if (reloading) {
      const phase = 1 - actor.wpn.reloadTimer / actor.wpn.reloadTotal;
      const curve = Math.sin(phase * Math.PI);
      reloadPitch = curve * 0.55;
      reloadRoll = curve * 0.38;
      reloadDrop = curve * 0.055;
      if (mag) {
        if (mag.userData.baseY === undefined) mag.userData.baseY = mag.position.y;
        const baseY = mag.userData.baseY as number;
        const dropPhase = Math.min(1, phase * 2.4);
        mag.position.y = baseY - dropPhase * 0.2 * (phase < 0.52 ? 1 : -1);
        mag.visible = !(phase < 0.44 && actor.wpn.reloadingEmpty);
      }
    } else {
      if (mag && mag.userData.baseY !== undefined) {
        mag.visible = true;
        mag.position.y = mag.userData.baseY;
      }
    }

    // Bolt / pump cycling
    const def2 = def;
    let boltAnim = 0;
    if (actor.wpn.boltTimer > 0 && (def2.fireMode === 'bolt' || def2.fireMode === 'pump')) {
      const total = def2.fireMode === 'pump' ? 0.9 : 0.9;
      boltAnim = Math.sin((1 - actor.wpn.boltTimer / total) * Math.PI);
    }
    const bolt = this.currentModel?.bolt ?? null;
    if (bolt) {
      if (bolt.userData.baseZ === undefined) bolt.userData.baseZ = bolt.position.z;
      const dir = def2.fireMode === 'pump' ? -0.085 : 0.06;
      bolt.position.z = (bolt.userData.baseZ as number) + boltAnim * dir;
    }

    // Compose position: hip → ADS → sprint offsets
    const inspect = this.inspectPose(dt, ads, this.sprintBlend, reloading);
    const iw = inspect.weight;
    const px =
      HIP_POS.x + (ADS_POS.x - HIP_POS.x) * ads +
      (SPRINT_POS.x - HIP_POS.x) * this.sprintBlend * (1 - ads) +
      bobX + this.swayX - 0.1 * inspect.lift * iw;
    const py =
      HIP_POS.y + (ADS_POS.y - HIP_POS.y) * ads +
      (SPRINT_POS.y - HIP_POS.y) * this.sprintBlend * (1 - ads) +
      bobY + this.swayY - reloadDrop - swapDip + 0.04 * inspect.lift * iw;
    const pz =
      HIP_POS.z + (ADS_POS.z - HIP_POS.z) * ads +
      (SPRINT_POS.z - HIP_POS.z) * this.sprintBlend * (1 - ads) +
      this.recoilZ + 0.14 * inspect.lift * iw;

    this.pivot.position.set(px, py, pz);
    this.pivot.rotation.set(
      -this.swayY * 2.1 + this.recoilPitch + reloadPitch + this.sprintBlend * 0.32 * (1 - ads) + inspect.pitch * iw,
      this.swayX * 2.2 - this.sprintBlend * 0.42 * (1 - ads) + inspect.yaw * iw,
      reloadRoll + this.swayRoll + this.sprintBlend * 0.18 * (1 - ads) - bobX * 1.4 + inspect.roll * iw,
    );
  }

  /**
   * Per-frame presentation update for a read-only replica actor.
   *
   * ActorView deliberately does not expose reload, bolt, recoil, or combat
   * timers. Those details must remain local presentation state, so this path
   * only consumes the equipped weapon, owner-scoped inventory metadata, and
   * movement pose. ADS is supplied by the local input/presentation layer.
   */
  updateView(
    actor: ActorView | null,
    dt: number,
    lookDx: number,
    lookDy: number,
    movingSpeed: number,
    opts: { adsAmount?: number } = {},
  ): void {
    this.t += dt;
    this.muzzleFlashLight.intensity *= Math.exp(-dt * 30);
    if (!actor || !actor.alive) {
      this.group.visible = false;
      return;
    }

    // The replica never receives a mutable Inventory. Resolve the render
    // model from its immutable equipped-weapon identity and, when present,
    // the owning participant's inventory rarity only.
    const weaponId = actor.equippedWeapon;
    const selected = actor.inventory && actor.inventory.selected >= 0
      ? actor.inventory.slots[actor.inventory.selected]
      : null;
    const rarity: Rarity = weaponId && selected?.kind === 'weapon' && selected.weaponId === weaponId
      ? selected.rarity : 'common';
    this.setWeapon(weaponId, rarity);
    this.group.visible = true;

    // Sway from local look input (inertia: the viewmodel lags behind aim).
    this.swayX += (-lookDx * 0.00095 - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (-lookDy * 0.00085 - this.swayY) * Math.min(1, dt * 9);
    this.swayRoll += (-lookDx * 0.00045 - this.swayRoll) * Math.min(1, dt * 7);

    // Recoil is a local presentation spring. Replica state does not invent
    // or reconstruct authoritative fire/combat timing.
    this.recoilZ *= Math.exp(-8.5 * dt);
    this.recoilPitch *= Math.exp(-7 * dt);

    // Swap-in dip is presentation-only and remains valid for replica views.
    this.swapT = Math.max(0, this.swapT - dt);
    const swapDip = Math.sin((this.swapT / 0.32) * Math.PI) * 0.16;

    if (!weaponId) {
      this.updateFists(actor.crouched, dt, movingSpeed, swapDip);
      return;
    }

    const adsTarget = THREE.MathUtils.clamp(opts.adsAmount ?? 0, 0, 1);
    this.adsSmooth += (adsTarget - this.adsSmooth) * Math.min(1, dt * 12);
    const ads = this.adsSmooth;
    const sprinting = movingSpeed > 8.6 && !adsTarget;
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 7);

    const bobAmp = movingSpeed > 0.5 ? Math.min(1, movingSpeed / 9.5) : 0;
    const bobFreq = Math.max(6, movingSpeed * 0.92);
    const bobX = Math.sin(this.t * bobFreq) * 0.0105 * bobAmp * (1 - ads * 0.88);
    const bobY = Math.abs(Math.cos(this.t * bobFreq)) * 0.0125 * bobAmp * (1 - ads * 0.88);

    // Replica views intentionally do not animate reload/bolt state: those
    // timers are private combat authority and are absent from ActorView.
    const inspect = this.inspectPose(dt, ads, this.sprintBlend, false);
    const iw = inspect.weight;
    const px =
      HIP_POS.x + (ADS_POS.x - HIP_POS.x) * ads +
      (SPRINT_POS.x - HIP_POS.x) * this.sprintBlend * (1 - ads) +
      bobX + this.swayX - 0.1 * inspect.lift * iw;
    const py =
      HIP_POS.y + (ADS_POS.y - HIP_POS.y) * ads +
      (SPRINT_POS.y - HIP_POS.y) * this.sprintBlend * (1 - ads) +
      bobY + this.swayY - swapDip + 0.04 * inspect.lift * iw;
    const pz =
      HIP_POS.z + (ADS_POS.z - HIP_POS.z) * ads +
      (SPRINT_POS.z - HIP_POS.z) * this.sprintBlend * (1 - ads) +
      this.recoilZ + 0.14 * inspect.lift * iw;

    this.pivot.position.set(px, py, pz);
    this.pivot.rotation.set(
      -this.swayY * 2.1 + this.recoilPitch + this.sprintBlend * 0.32 * (1 - ads) + inspect.pitch * iw,
      this.swayX * 2.2 - this.sprintBlend * 0.42 * (1 - ads) + inspect.yaw * iw,
      this.swayRoll + this.sprintBlend * 0.18 * (1 - ads) - bobX * 1.4 + inspect.roll * iw,
    );
  }

  kick(strength: number): void {
    this.recoilZ += strength * 0.055;
    this.recoilPitch += strength * 0.03;
  }

  private updateFists(crouched: boolean, dt: number, movingSpeed: number, swapDip: number): void {
    this.adsSmooth = 0;
    const sprinting = movingSpeed > 8.6;
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 7);
    const bobAmp = movingSpeed > 0.5 ? Math.min(1, movingSpeed / 9.5) : 0;
    const bobFreq = Math.max(6, movingSpeed * 0.92);
    const bobX = Math.sin(this.t * bobFreq) * 0.0105 * bobAmp;
    const bobY = Math.abs(Math.cos(this.t * bobFreq)) * 0.0125 * bobAmp;

    // Guard idle breathing
    const breathe = Math.sin(this.t * 2.1) * 0.006;

    // Punch animation
    this.punchT = Math.max(0, this.punchT - dt);
    const p = 1 - this.punchT / 0.3;
    const ext = this.punchT > 0 ? Math.sin(Math.min(1, p) * Math.PI) : 0;
    const rightActive = this.punchHand === 0;

    const drive = (g: THREE.Group, side: 1 | -1): void => {
      const active = (side === 1) === (rightActive === true) && ext > 0;
      const e = active ? ext : 0;
      g.position.set(
        -side * e * 0.13 + bobX,
        e * 0.02 + bobY + breathe - swapDip + this.swayY,
        -e * 0.3 + this.recoilZ * 0.4,
      );
      g.rotation.set(
        -this.swayY * 1.6 + e * -0.18,
        this.swayX * 1.7 + side * e * 0.14,
        this.swayRoll + side * e * -0.22 - bobX * 1.2,
      );
    };
    drive(this.fistsR, 1);
    drive(this.fistsL, -1);

    this.pivot.position.set(
      HIP_POS.x * 0.55 + (SPRINT_POS.x - HIP_POS.x) * this.sprintBlend * 0.6 + this.swayX,
      HIP_POS.y + (SPRINT_POS.y - HIP_POS.y) * this.sprintBlend * 0.6 + this.swayY,
      HIP_POS.z + this.recoilZ * 0.4,
    );
    if (crouched) this.pivot.position.y += 0.02;
    this.pivot.rotation.set(
      -this.swayY * 1.4 + this.sprintBlend * 0.26,
      this.swayX * 1.5 - this.sprintBlend * 0.34,
      this.swayRoll + this.sprintBlend * 0.14 - bobX * 1.2,
    );
  }

  /** Muzzle world position for effects. */
  muzzleWorld(_camera: THREE.Camera): THREE.Vector3 {
    const m = this.currentModel;
    if (m) return m.group.localToWorld(m.muzzle.clone());
    const v = new THREE.Vector3(0, 0.02, -0.62);
    return this.group.localToWorld(v);
  }
}
