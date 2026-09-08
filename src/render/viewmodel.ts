/**
 * First-person viewmodel: composed weapon models (CC0 Kenney blaster parts),
 * sway, inertia, walking bob, procedural recoil, ADS transition,
 * sprint lowering, tactical/empty reload animation, bolt cycling.
 */

import * as THREE from 'three';
import { WEAPONS, RARITY_MODS, type Rarity, type WeaponId } from '../core/balance';
import type { Actor } from '../sim/actor';
import type { ActorView } from '../sim/gameStateView';
import { WeaponModelFactory, type WeaponModel } from './weaponModels';
import { ArmSolver, createFistRig, createHandRig, type FistRig, type HandRig, type SupportStyle } from './hands';

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

const HIP_POS = new THREE.Vector3(0.15, -0.135, -0.3);
const ADS_POS = new THREE.Vector3(0, -0.058, -0.22);
const SPRINT_POS = new THREE.Vector3(0.1, -0.21, -0.26);

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
  /** CYCLE 35: hands rig attached inside each weapon model clone. */
  private rigs = new Map<string, HandRig>();
  /** CYCLE 36 (user pass): connected shoulder→elbow→wrist arm chains — the
   * hands are the END of the character's arms, never floating mittens. */
  readonly armSolver: ArmSolver;
  private static readonly _wristQuat = new THREE.Quaternion();
  private static readonly _wristOffset = new THREE.Vector3();
  private static readonly _wristWorldR = new THREE.Vector3();
  private static readonly _wristWorldL = new THREE.Vector3();
  private currentId: WeaponId | null = null;
  private currentKey: string | null = null;
  private currentModel: WeaponModel | null = null;
  private t = 0;

  // Fists (permanent melee pseudo-weapon) — CYCLE 52: shared gloved-hand
  // builder + ArmSolver sleeves replace the legacy black capsule fists.
  private fistRig: FistRig;
  private fistsR: THREE.Group;
  private fistsL: THREE.Group;
  private punchT = 0;
  private punchHand = 0;

  // Animation state
  private swayX = 0;
  private swayY = 0;
  private swayRoll = 0;
  private recoilZ = 0;
  private recoilPitch = 0;
  private recoilRoll = 0;
  private slideT = 0;
  private reloadT = 0;
  private swapT = 0;
  private adsSmooth = 0;
  private sprintBlend = 0;
  private lastSpeed = 0;
  // Inspect flourish: <0 inactive, else elapsed seconds into the sweep.
  private inspectT = -1;
  private static readonly INSPECT_DURATION = 2.2;

  // CYCLE 48: presentation-only combat timelines for the ONLINE LOCAL player.
  // Replica ActorViews deliberately carry no combat runtime (no wpn timers —
  // they are host authority and absent from GameStateView), so updateView()
  // used to hardcode reload/bolt phases to -1/0 and the local hands never
  // animated. The guest cannot reconstruct the authoritative timeline, but the
  // fire/reload presentation events it already consumes (kick/muzzle,
  // reloadStarted) are enough to run the SAME choreography curves
  // approximately: notify*() seeds a local stopwatch, updateView() advances it
  // and mirrors update()'s math. Remote players never reach updateView, so
  // the documented read-only replica contract holds.
  private presentReloadElapsed = -1;
  private presentReloadTotal = 0;
  private presentReloadEmpty = false;
  private presentBoltElapsed = -1;
  private presentBoltTotal = 0.9;
  /** Presentation bolt/pump travel duration — update() animates both modes
   * over 0.9 s regardless of the combat runtime's exact boltTimer. */
  private static readonly BOLT_PRESENT_SECONDS = 0.9;

  /** Seed the bolt/pump presentation timeline for the weapon just fired.
   * Called from the online fire handlers next to kick()/muzzlePulse(); no-op
   * for semi/auto weapons (their slide/recoil springs already run). */
  notifyShotFired(weaponId: WeaponId): void {
    const def = WEAPONS[weaponId];
    if (!def || (def.fireMode !== 'bolt' && def.fireMode !== 'pump')) return;
    this.presentBoltElapsed = 0;
    this.presentBoltTotal = ViewModel.BOLT_PRESENT_SECONDS;
  }

  /** Seed the reload presentation timeline from the online reloadStarted
   * event. Duration mirrors the combat runtime's formula (WEAPONS def ×
   * rarity reload modifier) so the sweep lands with the authoritative refill. */
  notifyReloadStarted(weaponId: WeaponId, rarity: Rarity, empty: boolean): void {
    const def = WEAPONS[weaponId];
    if (!def) return;
    this.presentReloadElapsed = 0;
    this.presentReloadTotal = (empty ? def.reloadEmpty : def.reloadTactical)
      * RARITY_MODS[rarity].reloadMult;
    this.presentReloadEmpty = empty;
  }

  /** Advance and retire the presentation timelines. Returns the reload phase
   * (0..1, or -1 when inactive) and the bolt anim amplitude (0..1). */
  private advancePresentationTimelines(dt: number): { reloadPhase: number; boltAnim: number; reloadingEmpty: boolean } {
    let reloadPhase = -1;
    let boltAnim = 0;
    let reloadingEmpty = false;
    if (this.presentReloadElapsed >= 0) {
      this.presentReloadElapsed += dt;
      if (this.presentReloadElapsed >= this.presentReloadTotal) {
        this.presentReloadElapsed = -1;
        this.presentReloadTotal = 0;
      } else {
        reloadPhase = this.presentReloadElapsed / this.presentReloadTotal;
        reloadingEmpty = this.presentReloadEmpty;
      }
    }
    if (this.presentBoltElapsed >= 0) {
      this.presentBoltElapsed += dt;
      if (this.presentBoltElapsed >= this.presentBoltTotal) {
        this.presentBoltElapsed = -1;
      } else {
        boltAnim = Math.sin((1 - this.presentBoltElapsed / this.presentBoltTotal) * Math.PI);
      }
    }
    return { reloadPhase, boltAnim, reloadingEmpty };
  }

  /** Cancel any running presentation timelines (weapon swap, death, hide). */
  private clearPresentationTimelines(): void {
    this.presentReloadElapsed = -1;
    this.presentReloadTotal = 0;
    this.presentBoltElapsed = -1;
  }

  /** Test/QA probe: active reload phase of the presentation timeline. */
  get presentationReloadPhase(): number {
    return this.presentReloadElapsed >= 0
      ? this.presentReloadElapsed / this.presentReloadTotal
      : -1;
  }

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
    this.group.name = 'viewmodel-root';
    this.group.add(this.pivot);
    this.fistRig = createFistRig();
    this.fistsR = this.fistRig.right;
    this.fistsL = this.fistRig.left;
    this.fistRig.group.visible = false;
    this.pivot.add(this.fistRig.group);
    this.armSolver = new ArmSolver();
    this.pivot.add(this.armSolver.group);

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

  /** View-space scale for the hand-held weapon. The factory builds to real
   * canonical length (~1 m AR) for world/loot presentation; at the hip offset
   * (~6 cm from the eye) that fills half the screen, so the viewmodel carries
   * its own presentation scale, like every shipped FPS does. */
  /** Per-class presentation scale (round-6 weapon review): the flat 0.6
   * left the pistol at ~5% of frame while long guns filled 20%. */
  private static readonly WEAPON_VIEW_SCALE: Record<WeaponId, number> = {
    pistol: 0.95, smg: 0.78, ar: 0.82, shotgun: 0.85, sniper: 0.78,
  };

  private modelFor(id: WeaponId, rarity: Rarity): WeaponModel | null {
    const key = `${id}:${rarity}`;
    let m = this.models.get(key);
    if (!m) {
      const built = this.factory.build(id, rarity);
      if (!built) return null;
      m = built;
      const viewScale = ViewModel.WEAPON_VIEW_SCALE[id];
      m.group.scale.setScalar(viewScale);
      // viewmodel render tuning: draw over world, no shadow casting
      m.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) { mesh.castShadow = false; mesh.receiveShadow = false; }
        const mat = mesh.material as THREE.Material | undefined;
        if (mat && 'depthTest' in mat) { /* keep depth test; weapon clips handled by proximity */ }
      });
      // CYCLE 35: gloved hands parented inside the weapon so every weapon
      // motion (sway/ADS/recoil/reload) carries them; counter-scaled to stay
      // human-size against the presentation scale.
      const rig = createHandRig();
      rig.configure({ gripR: m.gripR, gripL: m.gripL, scale: viewScale });
      for (const handGroup of [rig.right, rig.left]) {
        handGroup.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) { mesh.castShadow = false; mesh.receiveShadow = false; }
        });
        m.group.add(handGroup);
      }
      this.rigs.set(key, rig);
      m.group.visible = false;
      this.models.set(key, m);
      this.pivot.add(m.group);
    }
    return m;
  }

  setWeapon(id: WeaponId | null, rarity: Rarity): void {
    const key = id ? `${id}:${rarity}` : null;
    // Unarmed visibility must not depend on the model-change early-return
    // below: a guest who spawns unarmed (currentKey already null) never
    // crossed a weapon→none transition, so the fists stayed hidden forever.
    const unarmed = !id;
    if (this.fistRig.group.visible !== unarmed) {
      this.fistRig.group.visible = unarmed;
    }
    if (this.currentKey === key) return;
    if (this.currentModel) this.currentModel.group.visible = false;
    this.currentId = id;
    this.currentKey = key;
    this.currentModel = id ? this.modelFor(id, rarity) : null;
    if (this.currentModel) this.currentModel.group.visible = true;
    // A swap cancels the in-flight reload/bolt presentation timelines — the
    // old weapon's choreography must not bleed onto the new model.
    this.clearPresentationTimelines();
    this.swapT = 0.32;
  }

  dispose(): void {
    // Weapon instances share resources with the page-lifetime factory; detach
    // them before releasing the viewmodel's own arms/fists geometry.
    for (const model of this.models.values()) model.group.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) geometries.add(mesh.geometry);
    });
    for (const geometry of geometries) geometry.dispose();
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
    if (!actor || (!this.currentId && !this.fistRig.group.visible)) {
      this.group.visible = false;
      this.armSolver.setVisible(false);
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
    this.recoilPitch *= Math.exp(-6.5 * dt);
    this.recoilRoll *= Math.exp(-9 * dt);
    // Pistol slide return spring.
    this.slideT = Math.max(0, this.slideT - dt);
    const slide = this.currentModel?.bolt ?? null;
    if (slide && this.currentKey?.startsWith('pistol')) {
      if (slide.userData.baseZ === undefined) slide.userData.baseZ = slide.position.z;
      const slideCurve = this.slideT > 0 ? Math.sin((1 - this.slideT / 0.09) * Math.PI) : 0;
      // CYCLE 37 (review): slides travel REARWARD (+z) — v2 moved it into
      // the barrel.
      slide.position.z = (slide.userData.baseZ as number) + slideCurve * 0.035;
    }

    // Swap-in dip
    this.swapT = Math.max(0, this.swapT - dt);
    const swapDip = Math.sin((this.swapT / 0.32) * Math.PI) * 0.16;

    if (!this.currentId) {
      this.updateFists(actor.crouched, dt, movingSpeed, swapDip);
      return;
    }

    const weaponId = actor.inv.selectedWeapon?.weaponId ?? 'pistol';
    const def = WEAPONS[weaponId];
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
      // CYCLE 36 (review): port-side cant + slight muzzle-down — the former
      // muzzle-up 0.55 pitch read as 'presenting arms'.
      reloadPitch = curve * 0.14;
      reloadRoll = curve * 0.3;
      reloadDrop = curve * 0.055;
      if (mag) {
        if (mag.userData.baseY === undefined) {
          mag.userData.baseY = mag.position.y;
          mag.userData.baseRot = mag.rotation.z;
        }
        // CYCLE 36 (review): the v1 formula levitated the mag to baseY+0.2 on
        // the second half. Proper reload: slide DOWN out of the well through
        // the first half, then carry a fresh mag back UP to exactly baseY.
        const baseY = mag.userData.baseY as number;
        const drop = 0.14;
        let magY: number;
        let rock: number;
        if (phase < 0.5) {
          const t = smooth(Math.min(1, phase / 0.5));
          magY = baseY - drop * t;
          rock = 0.3 * t;
        } else {
          const t = smooth(Math.min(1, (phase - 0.5) / 0.35));
          magY = baseY - drop * (1 - t);
          rock = 0.3 * (1 - t);
        }
        mag.position.y = magY;
        mag.rotation.z = (mag.userData.baseRot as number) + rock;
        mag.visible = !(phase < 0.25 && actor.wpn.reloadingEmpty);
      }
    } else {
      if (mag && mag.userData.baseY !== undefined) {
        mag.visible = true;
        mag.position.y = mag.userData.baseY;
        mag.rotation.z = mag.userData.baseRot as number;
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
    let pumpOffset = 0;
    if (bolt) {
      if (bolt.userData.baseZ === undefined) bolt.userData.baseZ = bolt.position.z;
      // CYCLE 36 (review): a pump PULLS rearward (+z) to eject, then returns.
      const dir = def2.fireMode === 'pump' ? 0.085 : 0.06;
      pumpOffset = boltAnim * dir;
      bolt.position.z = (bolt.userData.baseZ as number) + pumpOffset;
    }

    // CYCLE 35/36: drive the hand rig with the same choreography the weapon
    // already follows (reload timeline, pump/bolt travel, ADS tuck).
    const rig = this.currentKey ? this.rigs.get(this.currentKey) : undefined;
    if (rig) {
      const reloadPhase = reloading ? 1 - actor.wpn.reloadTimer / actor.wpn.reloadTotal : -1;
      const boltMode = def2.fireMode === 'bolt';
      const supportStyle: SupportStyle = weaponId === 'pistol'
        ? 'over'
        : def2.fireMode === 'pump'
          ? 'pump'
          : weaponId === 'smg' ? 'side' : 'under';
      rig.pose({
        reloadPhase,
        supportStyle,
        magLocal: mag ? mag.position : null,
        pumpOffset,
        pumpHand: def2.fireMode === 'pump',
        ads,
        boltPhase: boltMode && actor.wpn.boltTimer > 0
          ? 1 - actor.wpn.boltTimer / 0.9
          : -1,
        boltLocal: boltMode && bolt ? bolt.position : null,
      });
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
    // Base hip stance angles the receiver inward across the lower-right
    // frame (muzzle toward center) like a real ready position; ADS removes it.
    const hipYaw = 0.28 * (1 - ads);
    const hipRoll = -0.1 * (1 - ads);
    this.pivot.rotation.set(
      -this.swayY * 2.1 + this.recoilPitch + reloadPitch + this.sprintBlend * 0.32 * (1 - ads) + inspect.pitch * iw,
      this.swayX * 2.2 - this.sprintBlend * 0.42 * (1 - ads) + hipYaw + inspect.yaw * iw,
      reloadRoll + this.swayRoll + this.recoilRoll + this.sprintBlend * 0.18 * (1 - ads) - bobX * 1.4 + hipRoll + inspect.roll * iw,
    );

    // CYCLE 36 (user pass): connect the arms shoulder→elbow→wrist to the
    // posed hands so nothing floats.
    this.solveArms();
  }

  /** Solve the arm chains against the live hand positions (world → view). */
  private solveArms(): void {
    const rig = this.currentKey ? this.rigs.get(this.currentKey) : undefined;
    if (!rig) {
      this.armSolver.setVisible(false);
      return;
    }
    this.pivot.updateMatrixWorld(true);
    const wR = ViewModel._wristWorldR;
    rig.right.getWorldPosition(wR);
    const wL = ViewModel._wristWorldL;
    rig.left.getWorldPosition(wL);
    // Wrist targets sit BEHIND each palm (toward the eye) so the sleeve
    // ends at the cuff — the v2 joint sphere covered the hand entirely.
    // CYCLE 46 (review/B2): the behind-palm offset must rotate with the
    // view — world-space +z pointed camera-LEFT at other yaws, detaching
    // the arm from the cuff on every turn.
    const qR = rig.right.getWorldQuaternion(ViewModel._wristQuat);
    wR.add(ViewModel._wristOffset.set(0, 0, 0.068).applyQuaternion(qR));
    const qL = rig.left.getWorldQuaternion(ViewModel._wristQuat);
    wL.add(ViewModel._wristOffset.set(0, 0, 0.068).applyQuaternion(qL));
    this.armSolver.solve(this.pivot, [wR, wL]);
  }

  /**
   * Per-frame presentation update for the local player's read-only replica
   * actor (online matches). Only reaches this path for the owning
   * participant — remote players render through CharacterRig, never here.
   *
   * ActorView deliberately does not expose reload, bolt, recoil, or combat
   * timers (host authority, absent from GameStateView), so the combat
   * choreography cannot be read from the view. Instead the online fire/
   * reload handlers seed presentation-only timelines via notifyShotFired()/
   * notifyReloadStarted(); this method advances them and runs the same
   * curves as update(). ADS is supplied by the local input/presentation
   * layer via opts.adsAmount.
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
      // Death/hide retires any in-flight presentation reload/bolt sweep.
      this.clearPresentationTimelines();
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
    this.recoilPitch *= Math.exp(-6.5 * dt);
    this.recoilRoll *= Math.exp(-9 * dt);
    // Pistol slide return spring — kick() (online fire handlers) sets slideT
    // exactly like the offline path; the replica path just never applied it.
    this.slideT = Math.max(0, this.slideT - dt);
    const slide = this.currentModel?.bolt ?? null;
    if (slide && this.currentKey?.startsWith('pistol')) {
      if (slide.userData.baseZ === undefined) slide.userData.baseZ = slide.position.z;
      const slideCurve = this.slideT > 0 ? Math.sin((1 - this.slideT / 0.09) * Math.PI) : 0;
      slide.position.z = (slide.userData.baseZ as number) + slideCurve * 0.035;
    }

    // Swap-in dip is presentation-only and remains valid for replica views.
    this.swapT = Math.max(0, this.swapT - dt);
    const swapDip = Math.sin((this.swapT / 0.32) * Math.PI) * 0.16;

    if (!weaponId) {
      this.updateFists(actor.crouched, dt, movingSpeed, swapDip);
      return;
    }

    const def = WEAPONS[weaponId];
    const adsTarget = THREE.MathUtils.clamp(opts.adsAmount ?? 0, 0, 1);
    this.adsSmooth += (adsTarget - this.adsSmooth) * Math.min(1, dt * 12);
    const ads = this.adsSmooth;
    const sprinting = movingSpeed > 8.6 && !adsTarget;
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 7);

    const bobAmp = movingSpeed > 0.5 ? Math.min(1, movingSpeed / 9.5) : 0;
    const bobFreq = Math.max(6, movingSpeed * 0.92);
    const bobX = Math.sin(this.t * bobFreq) * 0.0105 * bobAmp * (1 - ads * 0.88);
    const bobY = Math.abs(Math.cos(this.t * bobFreq)) * 0.0125 * bobAmp * (1 - ads * 0.88);

    // CYCLE 48: presentation combat timelines (seeded by the online fire/
    // reload event handlers) drive the SAME choreography curves update()
    // runs offline: reload cant + mag travel, bolt/pump travel, hand rig.
    const { reloadPhase, boltAnim, reloadingEmpty } = this.advancePresentationTimelines(dt);
    const reloading = reloadPhase >= 0;
    let reloadPitch = 0;
    let reloadRoll = 0;
    let reloadDrop = 0;
    const mag = this.currentModel?.mag ?? null;
    if (reloading) {
      const curve = Math.sin(reloadPhase * Math.PI);
      reloadPitch = curve * 0.14;
      reloadRoll = curve * 0.3;
      reloadDrop = curve * 0.055;
      if (mag) {
        if (mag.userData.baseY === undefined) {
          mag.userData.baseY = mag.position.y;
          mag.userData.baseRot = mag.rotation.z;
        }
        const baseY = mag.userData.baseY as number;
        const drop = 0.14;
        let magY: number;
        let rock: number;
        if (reloadPhase < 0.5) {
          const t = smooth(Math.min(1, reloadPhase / 0.5));
          magY = baseY - drop * t;
          rock = 0.3 * t;
        } else {
          const t = smooth(Math.min(1, (reloadPhase - 0.5) / 0.35));
          magY = baseY - drop * (1 - t);
          rock = 0.3 * (1 - t);
        }
        mag.position.y = magY;
        mag.rotation.z = (mag.userData.baseRot as number) + rock;
        mag.visible = !(reloadPhase < 0.25 && reloadingEmpty);
      }
    } else if (mag && mag.userData.baseY !== undefined) {
      mag.visible = true;
      mag.position.y = mag.userData.baseY;
      mag.rotation.z = mag.userData.baseRot as number;
    }

    // Bolt / pump cycling for the weapon just fired (presentation timeline).
    const bolt = this.currentModel?.bolt ?? null;
    let pumpOffset = 0;
    if (bolt && boltAnim > 0 && (def.fireMode === 'bolt' || def.fireMode === 'pump')) {
      if (bolt.userData.baseZ === undefined) bolt.userData.baseZ = bolt.position.z;
      const dir = def.fireMode === 'pump' ? 0.085 : 0.06;
      pumpOffset = boltAnim * dir;
      bolt.position.z = (bolt.userData.baseZ as number) + pumpOffset;
    }

    // CYCLE 36 (review): the online path must pose hands too — v1 left them
    // frozen at configure defaults. The pose now follows the presentation
    // timelines instead of hardcoded inactive phases.
    const rig = this.currentKey ? this.rigs.get(this.currentKey) : undefined;
    if (rig) {
      const supportStyle: SupportStyle = weaponId === 'pistol'
        ? 'over'
        : def.fireMode === 'pump'
          ? 'pump'
          : weaponId === 'smg' ? 'side' : 'under';
      rig.pose({
        reloadPhase,
        supportStyle,
        magLocal: mag ? mag.position : null,
        pumpOffset,
        pumpHand: def.fireMode === 'pump',
        ads,
        boltPhase: def.fireMode === 'bolt' && boltAnim > 0
          ? 1 - this.presentBoltElapsed / this.presentBoltTotal
          : -1,
        boltLocal: def.fireMode === 'bolt' && bolt ? bolt.position : null,
      });
    }

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
    // Base hip stance angles the receiver inward across the lower-right
    // frame (muzzle toward center) like a real ready position; ADS removes it.
    // Parity with update(): the online weapon previously lost this stance.
    const hipYaw = 0.28 * (1 - ads);
    const hipRoll = -0.1 * (1 - ads);
    this.pivot.rotation.set(
      -this.swayY * 2.1 + this.recoilPitch + reloadPitch + this.sprintBlend * 0.32 * (1 - ads) + inspect.pitch * iw,
      this.swayX * 2.2 - this.sprintBlend * 0.42 * (1 - ads) + hipYaw + inspect.yaw * iw,
      reloadRoll + this.swayRoll + this.recoilRoll + this.sprintBlend * 0.18 * (1 - ads) - bobX * 1.4 + hipRoll + inspect.roll * iw,
    );
    this.solveArms();
  }

  kick(strength: number): void {
    // CYCLE 33: reference-feel recoil — a sharp backward+up kick with a
    // randomized roll flick, recovering on the existing springs.
    this.recoilZ += strength * 0.085;
    this.recoilPitch += strength * 0.05;
    this.recoilRoll += (Math.random() - 0.5) * strength * 0.05;
    // CYCLE 36 (review): semi-auto slide cycling — a frozen slide read as a
    // toy. Snap the slide back; the update loop returns it on a spring.
    if (this.currentKey?.startsWith('pistol')) this.slideT = 0.09;
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

    // CYCLE 52: guard bases authored in the (centered) pivot space; the
    // active hand jabs forward-down the sight line. The authored guard
    // orientation is composed on TOP of the dynamic Eulers — rotation.set
    // alone resets the fist pose to identity every frame.
    const drive = (g: THREE.Group, side: 1 | -1, bx: number, by: number, bz: number, base: THREE.Quaternion): void => {
      const active = (side === 1) === (rightActive === true) && ext > 0;
      const e = active ? ext : 0;
      g.position.set(
        bx - side * e * 0.13 + bobX,
        by + e * 0.02 + bobY + breathe - swapDip + this.swayY,
        bz - e * 0.3 + this.recoilZ * 0.4,
      );
      g.rotation.set(
        -this.swayY * 1.6 + e * -0.18,
        this.swayX * 1.7 + side * e * 0.14,
        this.swayRoll + side * e * -0.22 - bobX * 1.2,
      );
      g.quaternion.multiply(base);
    };
    drive(this.fistsR, 1, 0.16, -0.16, -0.34, this.fistRig.baseQuatR);
    drive(this.fistsL, -1, -0.15, -0.19, -0.38, this.fistRig.baseQuatL);

    // Unarmed guard sits centered (the weapon hip x-offset would shove the
    // lead fist off-line); pulled closer than the weapon hip so the fists
    // read at fight distance.
    this.pivot.position.set(
      this.swayX,
      -0.105 + (SPRINT_POS.y - HIP_POS.y) * this.sprintBlend * 0.6 + this.swayY,
      HIP_POS.z * 0.6 + this.recoilZ * 0.4,
    );
    if (crouched) this.pivot.position.y += 0.02;
    this.pivot.rotation.set(
      -this.swayY * 1.4 + this.sprintBlend * 0.26,
      this.swayX * 1.5 - this.sprintBlend * 0.34,
      this.swayRoll + this.sprintBlend * 0.14 - bobX * 1.2,
    );

    // Same connected arm chains as the weapon path (B6): sleeves meet the
    // cuffs through the fist rig's wrist anchors.
    this.pivot.updateMatrixWorld(true);
    const wR = ViewModel._wristWorldR;
    this.fistRig.wristR.getWorldPosition(wR);
    const wL = ViewModel._wristWorldL;
    this.fistRig.wristL.getWorldPosition(wL);
    this.armSolver.solve(this.pivot, [wR, wL]);
  }
}
