/**
 * First-person viewmodel: composed weapon models (CC0 Kenney blaster parts),
 * sway, inertia, walking bob, procedural recoil, ADS transition,
 * sprint lowering, tactical/empty reload animation, bolt cycling.
 */

import * as THREE from 'three';
import { WEAPONS, RARITY_MODS, type Rarity, type WeaponId } from '../core/balance';
import type { Actor } from '../sim/actor';
import type { ActorView } from '../sim/gameStateView';
import { WeaponModelFactory, createWeaponReloadSockets, type WeaponModel, type WeaponReloadSockets } from './weaponModels';
import { ArmSolver, createFistRig, createHandRig, type FistRig, type HandRig, type SupportStyle } from './hands';

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

const HIP_POS = new THREE.Vector3(0.15, -0.135, -0.285);
const SPRINT_POS = new THREE.Vector3(0.06, -0.24, -0.28);

/**
 * Per-class ADS pose, computed from each weapon's sight line: the sight
 * height (weapon-local) × presentation scale places the AIM LINE (rear
 * notch → front post / bead / scope body) exactly on the view centre, so
 * ADS presents a true sight picture instead of parking the receiver over
 * the crosshair. Z keeps the buttstock comfortably clear of the eye.
 */
const ADS_POSE: Record<WeaponId, { y: number; z: number }> = {
  pistol: { y: -0.05, z: -0.24 },
  smg: { y: -0.05, z: -0.24 },
  ar: { y: -0.055, z: -0.33 },
  shotgun: { y: -0.03, z: -0.34 },
  sniper: { y: -0.055, z: -0.3 },
};

type PresentationInput = Readonly<{
  crouched: boolean;
  adsAmount: number;
  reloadPhase: number;
  reloadCompleted: boolean;
  empty: boolean;
  boltPhase: number;
  reloadShells: number;
}>;

function boltDuration(weaponId: WeaponId): number {
  const def = WEAPONS[weaponId];
  if (def.fireMode === 'bolt') return Math.max(0.9, 60 / def.rpm - 0.35);
  if (def.fireMode === 'pump') return Math.max(0.55, 60 / def.rpm - 0.3);
  return 0;
}

type ReloadOwner = 'seated' | 'old-hand' | 'stowed' | 'new-hand' | 'inserting' | 'ready';

type ReloadTrack = Readonly<{
  contact: number; extracted: number; stowed: number; fetched: number;
  aligned: number; seated: number; released: number; action: number;
  pitch: number; roll: number; drop: number;
}>;

const RELOAD_TRACKS: Record<WeaponId, ReloadTrack> = {
  pistol: { contact: 0.13, extracted: 0.24, stowed: 0.36, fetched: 0.44, aligned: 0.57, seated: 0.69, released: 0.75, action: 0.8, pitch: -0.12, roll: 0.42, drop: 0.014 },
  smg: { contact: 0.12, extracted: 0.23, stowed: 0.35, fetched: 0.43, aligned: 0.58, seated: 0.72, released: 0.78, action: 0.82, pitch: 0.26, roll: -0.3, drop: 0.02 },
  ar: { contact: 0.16, extracted: 0.29, stowed: 0.41, fetched: 0.49, aligned: 0.63, seated: 0.77, released: 0.82, action: 0.86, pitch: 0.3, roll: -0.35, drop: 0.014 },
  sniper: { contact: 0.18, extracted: 0.31, stowed: 0.43, fetched: 0.51, aligned: 0.64, seated: 0.76, released: 0.8, action: 0.83, pitch: 0.22, roll: -0.3, drop: 0.016 },
  shotgun: { contact: 0.1, extracted: 0.2, stowed: 0.3, fetched: 0.4, aligned: 0.5, seated: 0.84, released: 0.89, action: 0.91, pitch: -0.06, roll: 0.65, drop: 0.008 },
};

function blendPose(out: THREE.Object3D, a: THREE.Object3D, b: THREE.Object3D, t: number): void {
  const weight = smooth(t);
  out.position.lerpVectors(a.position, b.position, weight);
  if (out === b) out.quaternion.slerp(a.quaternion, 1 - weight);
  else out.quaternion.slerpQuaternions(a.quaternion, b.quaternion, weight);
}

class ReloadPresentation {
  readonly sockets: WeaponReloadSockets;
  readonly leftRest = new THREE.Object3D();
  readonly rightRest = new THREE.Object3D();
  readonly boltRest = new THREE.Object3D();
  readonly contact = new THREE.Object3D();
  readonly shellInserted = new THREE.Object3D();
  readonly shellHandInserted = new THREE.Object3D();
  readonly shell: THREE.Object3D | null;
  private oldMagazine: THREE.Object3D | null;
  private newMagazine: THREE.Object3D | null;
  private owner: ReloadOwner = 'seated';
  private active = false;
  private readonly thumb: THREE.Object3D | undefined;
  private readonly actionRotation = new THREE.Quaternion();
  private readonly actionEuler = new THREE.Euler();

  constructor(private readonly model: WeaponModel, readonly id: WeaponId, rig: HandRig) {
    this.sockets = model.reloadSockets ?? createWeaponReloadSockets(model, id);
    model.reloadSockets = this.sockets;
    this.oldMagazine = model.mag;
    this.newMagazine = model.mag?.clone(true) ?? null;
    if (this.newMagazine) {
      this.newMagazine.name = 'reload-spare-magazine';
      this.newMagazine.visible = false;
      model.group.add(this.newMagazine);
    }
    this.shell = model.group.getObjectByName('reload-shell') ?? null;
    this.thumb = rig.left.getObjectByName('thumb-cmc');
    blendPose(this.leftRest, rig.left, rig.left, 0);
    blendPose(this.rightRest, rig.right, rig.right, 0);
    if (model.bolt) blendPose(this.boltRest, model.bolt, model.bolt, 0);
    blendPose(this.shellInserted, this.sockets.port, this.sockets.port, 0);
    this.shellInserted.position.set(0, 0.002, -0.385);
    this.shellInserted.rotation.set(0, 0, 0);
    blendPose(this.shellHandInserted, this.sockets.port, this.sockets.port, 0);
    this.shellHandInserted.position.z -= 0.025;
  }

  reset(completed = false): void {
    if (this.oldMagazine && this.newMagazine) {
      if (completed && this.id !== 'shotgun') {
        const previous = this.oldMagazine;
        this.oldMagazine = this.newMagazine;
        this.newMagazine = previous;
      }
      blendPose(this.oldMagazine, this.sockets.seated, this.sockets.seated, 0);
      this.oldMagazine.visible = true;
      this.oldMagazine.name = 'mag';
      this.newMagazine.visible = false;
      blendPose(this.newMagazine, this.sockets.spare, this.sockets.spare, 0);
      this.newMagazine.name = 'reload-spare-magazine';
      this.model.mag = this.oldMagazine;
    }
    if (this.model.bolt) blendPose(this.model.bolt, this.boltRest, this.boltRest, 0);
    if (this.shell) this.shell.visible = false;
    this.owner = 'seated';
    this.active = false;
    this.model.group.userData.reloadOwner = this.owner;
  }

  private grip(out: THREE.Object3D, item: THREE.Object3D, socket: THREE.Object3D): void {
    out.position.copy(socket.position).applyQuaternion(item.quaternion).add(item.position);
    out.quaternion.copy(item.quaternion).multiply(socket.quaternion);
  }

  fingerPhase(phase: number): number {
    const track = RELOAD_TRACKS[this.id];
    if (phase < 0) return -1;
    if (phase < track.contact) return phase / track.contact * 0.3;
    if (phase < track.released) return 0.5;
    return 0.85 + (phase - track.released) / (1 - track.released) * 0.15;
  }

  pose(rig: HandRig, phase: number, empty: boolean, shells: number): void {
    if (phase < 0) {
      if (this.active) this.reset();
      return;
    }
    this.active = true;
    if (this.id === 'shotgun') this.poseShell(rig, phase, empty, shells);
    else this.poseMagazine(rig, phase, empty);
    this.model.group.userData.reloadOwner = this.owner;
  }

  private poseMagazine(rig: HandRig, phase: number, empty: boolean): void {
    const old = this.oldMagazine;
    const fresh = this.newMagazine;
    if (!old || !fresh) return;
    const s = this.sockets;
    const t = RELOAD_TRACKS[this.id];
    blendPose(rig.right, this.rightRest, this.rightRest, 0);
    this.poseAction(rig, phase, empty);
    if (phase < t.contact) {
      this.owner = 'seated';
      blendPose(old, s.seated, s.seated, 0);
      this.grip(this.contact, old, s.magazineContact);
      blendPose(rig.left, this.leftRest, this.contact, phase / t.contact);
    } else if (phase < t.stowed) {
      this.owner = 'old-hand';
      if (phase < t.extracted) blendPose(old, s.seated, s.withdrawn, (phase - t.contact) / (t.extracted - t.contact));
      else blendPose(old, s.withdrawn, s.stow, (phase - t.extracted) / (t.stowed - t.extracted));
      this.grip(rig.left, old, s.magazineContact);
    } else if (phase < t.fetched) {
      this.owner = 'stowed';
      blendPose(old, s.stow, s.stow, 0);
      this.grip(this.contact, s.spare, s.magazineContact);
      blendPose(rig.left, this.contact, this.contact, 0);
    } else if (phase < t.seated) {
      this.owner = phase < t.aligned ? 'new-hand' : 'inserting';
      if (phase < t.aligned) blendPose(fresh, s.spare, s.approach, (phase - t.fetched) / (t.aligned - t.fetched));
      else blendPose(fresh, s.approach, s.seated, (phase - t.aligned) / (t.seated - t.aligned));
      this.grip(rig.left, fresh, s.magazineContact);
    } else {
      this.owner = 'ready';
      blendPose(fresh, s.seated, s.seated, 0);
      this.grip(this.contact, fresh, s.magazineContact);
      if (this.id !== 'sniper' && empty) {
        const action = this.model.bolt;
        if (action) {
          this.grip(this.contact, action, s.actionContact);
          this.contact.position.x = -Math.abs(this.contact.position.x);
          if (phase < t.action) {
            this.grip(rig.left, fresh, s.magazineContact);
            blendPose(rig.left, rig.left, this.contact, (phase - t.seated) / (t.action - t.seated));
          } else if (phase < 0.94) blendPose(rig.left, this.contact, this.contact, 0);
          else blendPose(rig.left, this.contact, this.leftRest, (phase - 0.94) / 0.06);
        }
      } else blendPose(rig.left, this.contact, this.leftRest, (phase - t.seated) / (t.released - t.seated));
    }
    old.visible = phase < t.stowed;
    fresh.visible = phase >= t.fetched;
    if (phase >= t.stowed) blendPose(old, s.stow, s.stow, 0);
  }

  private poseAction(rig: HandRig, phase: number, empty: boolean): void {
    const bolt = this.model.bolt;
    if (!bolt) return;
    const t = RELOAD_TRACKS[this.id];
    blendPose(bolt, this.boltRest, this.boltRest, 0);
    if (!empty) return;
    if (this.id === 'pistol') {
      bolt.position.z += 0.035 * (1 - smooth((phase - 0.9) / 0.035));
      return;
    }
    const p = THREE.MathUtils.clamp((phase - t.action) / (0.96 - t.action), 0, 1);
    const pull = p < 0.5 ? smooth(p * 2) : 1 - smooth((p - 0.5) * 2);
    bolt.position.z += pull * (this.id === 'sniper' ? 0.065 : 0.04);
    if (this.id === 'sniper') {
      const lift = smooth(p / 0.2) * (1 - smooth((p - 0.8) / 0.2));
      this.actionRotation.setFromEuler(this.actionEuler.set(0, 0, -lift * 0.8));
      bolt.quaternion.multiply(this.actionRotation);
      this.grip(this.contact, bolt, this.sockets.actionContact);
      if (phase < t.action) blendPose(rig.right, this.rightRest, this.contact, (phase - t.released) / (t.action - t.released));
      else if (phase < 0.96) blendPose(rig.right, this.contact, this.contact, 0);
      else blendPose(rig.right, this.contact, this.rightRest, (phase - 0.96) / 0.04);
    } else if (phase >= t.action && phase < 0.94) {
      this.grip(rig.left, bolt, this.sockets.actionContact);
      rig.left.position.x = -Math.abs(rig.left.position.x);
    }
  }

  private poseShell(rig: HandRig, phase: number, empty: boolean, shells: number): void {
    const shell = this.shell;
    if (!shell) return;
    const s = this.sockets;
    const count = Math.max(1, Math.min(WEAPONS.shotgun.magSize, shells));
    const progress = Math.round(THREE.MathUtils.clamp((phase - 0.1) / 0.72, 0, 0.999999) * count * 1e12) / 1e12;
    const cycle = progress - Math.floor(progress);
    blendPose(rig.right, this.rightRest, this.rightRest, 0);
    if (phase < 0.1) {
      this.grip(this.contact, s.spare, s.shellContact);
      blendPose(rig.left, this.leftRest, this.contact, phase / 0.1);
      shell.visible = false;
    } else if (phase < 0.82) {
      this.owner = cycle < 0.55 ? 'new-hand' : 'inserting';
      if (cycle < 0.55) blendPose(shell, s.spare, s.port, cycle / 0.55);
      else blendPose(shell, s.port, this.shellInserted, (cycle - 0.55) / 0.25);
      if (cycle < 0.55) this.grip(rig.left, shell, s.shellContact);
      else if (cycle < 0.8) {
        blendPose(this.contact, s.port, this.shellHandInserted, (cycle - 0.55) / 0.25);
        this.grip(rig.left, this.contact, s.shellContact);
      } else {
        this.grip(this.contact, this.shellHandInserted, s.shellContact);
        this.grip(rig.left, s.spare, s.shellContact);
        blendPose(rig.left, this.contact, rig.left, (cycle - 0.8) / 0.2);
      }
      shell.visible = cycle < 0.8;
      if (this.thumb) {
        const push = smooth((cycle - 0.55) / 0.1) * (1 - smooth((cycle - 0.75) / 0.1));
        this.thumb.rotation.y -= push * 0.45;
        this.thumb.rotation.z += push * 0.3;
      }
    } else {
      this.owner = 'ready';
      shell.visible = false;
      this.grip(this.contact, s.spare, s.shellContact);
      blendPose(rig.left, this.contact, this.leftRest, (phase - 0.82) / 0.07);
      if (empty && this.model.bolt) {
        const p = (phase - 0.89) / 0.11;
        const pump = p <= 0 ? 0 : Math.sin(Math.min(1, p) * Math.PI) * 0.085;
        this.model.bolt.position.z = this.boltRest.position.z + pump;
        rig.left.position.z += pump;
      }
    }
  }
}

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
  private reloads = new Map<string, ReloadPresentation>();
  private lastAmmoInMag = 0;
  private presentReloadShells = 1;
  /** CYCLE 36 (user pass): connected shoulder→elbow→wrist arm chains — the
   * hands are the END of the character's arms, never floating mittens. */
  readonly armSolver: ArmSolver;
  private static readonly _wristQuat = new THREE.Quaternion();
  private static readonly _wristOffset = new THREE.Vector3();
  private static readonly _wristWorldR = new THREE.Vector3();
  private static readonly _wristWorldL = new THREE.Vector3();
  /** Reusable wrist-target pair (B5: solveArms/updateFists run per frame). */
  private static readonly _wristPair: [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(), new THREE.Vector3(),
  ];
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

  private offlineReloadRemaining = 0;
  private presentReloadElapsed = -1;
  private presentReloadTotal = 0;
  private presentReloadEmpty = false;
  private presentBoltElapsed = -1;
  private presentBoltTotal = 0;

  /** Seed the bolt/pump presentation timeline for the weapon just fired.
   * Called from the online fire handlers next to kick()/muzzlePulse(); no-op
   * for semi/auto weapons (their slide/recoil springs already run). */
  notifyShotFired(weaponId: WeaponId): void {
    if (weaponId !== this.currentId || !this.group.visible) return;
    const duration = boltDuration(weaponId);
    if (duration <= 0) return;
    this.presentBoltElapsed = 0;
    this.presentBoltTotal = duration;
  }

  /** Seed the reload presentation timeline from the online reloadStarted
   * event. Duration mirrors the combat runtime's formula (WEAPONS def ×
   * rarity reload modifier) so the sweep lands with the authoritative refill. */
  notifyReloadStarted(weaponId: WeaponId, rarity: Rarity, empty: boolean): void {
    if (weaponId !== this.currentId || !this.group.visible) return;
    const def = WEAPONS[weaponId];
    if (!def) return;
    this.presentReloadElapsed = 0;
    this.presentReloadTotal = (empty ? def.reloadEmpty : def.reloadTactical)
      * RARITY_MODS[rarity].reloadMult;
    this.presentReloadEmpty = empty;
    this.presentReloadShells = Math.min(def.magSize, Math.max(1, empty ? def.magSize : def.magSize - this.lastAmmoInMag));
  }

  private advancePresentationTimelines(dt: number): Pick<PresentationInput, 'reloadPhase' | 'reloadCompleted' | 'boltPhase' | 'empty' | 'reloadShells'> {
    let reloadPhase = -1;
    let reloadCompleted = false;
    let boltPhase = -1;
    let empty = false;
    const reloadShells = this.presentReloadShells;
    if (this.presentReloadElapsed >= 0) {
      this.presentReloadElapsed += dt;
      if (this.presentReloadElapsed >= this.presentReloadTotal) {
        reloadCompleted = true;
        this.presentReloadElapsed = -1;
        this.presentReloadTotal = 0;
      } else {
        reloadPhase = this.presentReloadElapsed / this.presentReloadTotal;
        empty = this.presentReloadEmpty;
      }
    }
    if (this.presentBoltElapsed >= 0) {
      this.presentBoltElapsed += dt;
      if (this.presentBoltElapsed >= this.presentBoltTotal) {
        this.presentBoltElapsed = -1;
      } else {
        boltPhase = this.presentBoltElapsed / this.presentBoltTotal;
      }
    }
    return { reloadPhase, reloadCompleted, boltPhase, empty, reloadShells };
  }

  private clearPresentationTimelines(): void {
    this.offlineReloadRemaining = 0;
    this.presentReloadElapsed = -1;
    this.presentReloadTotal = 0;
    this.presentReloadEmpty = false;
    this.presentBoltElapsed = -1;
    this.presentBoltTotal = 0;
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
  /**
   * The viewmodel lives in the dedicated first-person stage whose camera sits
   * at the origin looking down -Z, so the pose root is pinned to identity —
   * pose space is view space by construction. The camera argument stays for
   * call-site stability; the world camera's transform is irrelevant here
   * (the stage's light rig picks up the camera rotation separately through
   * ViewModelStage.syncLighting).
   */
  syncCamera(_camera: THREE.Camera): void {
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
  }

  /** View-space scale for the hand-held weapon. The factory builds to real
   * canonical length (~1 m AR) for world/loot presentation; at the hip offset
   * (~6 cm from the eye) that fills half the screen, so the viewmodel carries
   * its own presentation scale, like every shipped FPS does. */
  /** Per-class presentation scale. The stage camera runs a constant 55° FOV
   * (vs the world's 80°), so scales are ~0.62x of the old shared-camera
   * values to keep the same on-screen fraction. */
  private static readonly WEAPON_VIEW_SCALE: Record<WeaponId, number> = {
    pistol: 0.66, smg: 0.56, ar: 0.58, shotgun: 0.6, sniper: 0.56,
  };

  /** Per-class ADS pose offsets (metres, applied through the ads blend).
   * Y drops the sniper so the box magazine falls out of the aim point. */
  private static readonly ADS_EXTRA_Y: Record<WeaponId, number> = {
    pistol: 0, smg: 0, ar: 0, shotgun: 0, sniper: 0,
  };

  /** The stage camera's 1 cm near plane makes forward nudges
   * unnecessary — stocks stay outside the clip volume at true ADS. */
  private static readonly ADS_EXTRA_FORWARD: Record<WeaponId, number> = {
    pistol: 0, smg: 0, ar: 0, shotgun: 0, sniper: 0,
  };

  /**
   * Live body motion the viewmodel reacts to (set from the render loop):
   * view-space lateral/forward speed, vertical velocity and grounded state.
   * The weapon carries mass — it trails acceleration, dips on landings,
   * rises on jumps and floats while airborne.
   */
  setMotionState(s: { sideVel: number; fwdVel: number; vertVel: number; grounded: boolean }): void {
    this.motion.sideVel = s.sideVel;
    this.motion.fwdVel = s.fwdVel;
    this.motion.vertVel = s.vertVel;
    if (s.grounded !== this.motion.grounded) {
      if (!s.grounded && s.vertVel > 2) this.jumpT = 0.22;
      if (s.grounded && this.motion.fallSpeed < -5) {
        this.landT = Math.min(0.34, 0.14 + Math.abs(this.motion.fallSpeed) * 0.007);
      }
      this.motion.grounded = s.grounded;
    }
    this.motion.fallSpeed = s.grounded ? 0 : Math.min(0, s.vertVel);
  }
  private readonly motion = { sideVel: 0, fwdVel: 0, vertVel: 0, grounded: true, fallSpeed: 0 };
  private sideLag = 0;
  private fwdLag = 0;
  private landT = 0;
  private jumpT = 0;
  private crouchBlend = 0;

  private modelFor(id: WeaponId, rarity: Rarity): WeaponModel | null {
    const key = `${id}:${rarity}`;
    let m = this.models.get(key);
    if (!m) {
      const built = this.factory.build(id, rarity);
      if (!built) return null;
      m = built;
      const viewScale = ViewModel.WEAPON_VIEW_SCALE[id];
      m.group.scale.setScalar(viewScale);
      // The stage's sun casts real self-shadow onto the weapon: fingers on
      // the grip, sights on the receiver. The stage shadow frustum (±0.85 m
      // around the view origin) covers every held pose.
      m.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
      });
      // CYCLE 35: gloved hands parented inside the weapon so every weapon
      // motion (sway/ADS/recoil/reload) carries them; counter-scaled to stay
      // human-size against the presentation scale.
      const rig = createHandRig();
      rig.configure({ gripR: m.gripR, gripL: m.gripL, scale: viewScale });
      for (const handGroup of [rig.right, rig.left]) {
        handGroup.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
        });
        m.group.add(handGroup);
      }
      this.rigs.set(key, rig);
      rig.pose({
        reloadPhase: -1, supportStyle: id === 'pistol' ? 'over' : id === 'smg' ? 'side' : id === 'shotgun' ? 'pump' : 'under',
        magLocal: m.mag?.position ?? null, pumpOffset: 0, pumpHand: id === 'shotgun',
        ads: 0, boltPhase: -1, boltLocal: null,
      });
      this.reloads.set(key, new ReloadPresentation(m, id, rig));
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
    this.resetPresentation();
    if (this.currentModel) this.currentModel.group.visible = false;
    this.currentId = id;
    this.currentKey = key;
    this.currentModel = id ? this.modelFor(id, rarity) : null;
    if (this.currentModel) this.currentModel.group.visible = true;
    this.restoreMovableParts();
    this.swapT = 0.32;
  }

  private restoreMovableParts(): void {
    if (this.currentKey) this.reloads.get(this.currentKey)?.reset();
  }

  private resetPresentation(): void {
    this.clearPresentationTimelines();
    this.slideT = 0;
    this.reloadT = 0;
    this.swapT = 0;
    this.punchT = 0;
    this.inspectT = -1;
    this.recoilZ = 0;
    this.recoilPitch = 0;
    this.recoilRoll = 0;
    this.adsSmooth = 0;
    this.sprintBlend = 0;
    this.restoreMovableParts();
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
    this.reloads.clear();
    this.rigs.clear();
    this.group.clear();
  }

  /** QA debug snapshot of the live presentation pose (read-only). */
  debugPose(): {
    currentId: WeaponId | null; ads: number;
    pivotPos: number[]; pivotRot: number[]; leftPos: number[] | null; rightPos: number[] | null;
  } {
    const rig = this.currentKey ? this.rigs.get(this.currentKey) : undefined;
    this.pivot.updateMatrixWorld(true);
    return {
      currentId: this.currentId,
      ads: this.adsSmooth,
      pivotPos: this.pivot.position.toArray().map((n) => +n.toFixed(3)),
      pivotRot: [this.pivot.rotation.x, this.pivot.rotation.y, this.pivot.rotation.z].map((n) => +n.toFixed(3)),
      leftPos: rig ? rig.left.position.toArray().map((n) => +n.toFixed(3)) : null,
      rightPos: rig ? rig.right.position.toArray().map((n) => +n.toFixed(3)) : null,
    };
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
      // Stage-drawn flash quad at the muzzle: carries the weapon transform,
      // random roll per shot so bursts don't repeat a silhouette.
      this.ensureFlash();
      if (this.flashQuad) {
        // Weapon-local → stage-space → pivot-local (the quad is pivot-child).
        m.group.localToWorld(this.flashQuad.position.copy(m.muzzle));
        this.pivot.worldToLocal(this.flashQuad.position);
        this.flashQuad.quaternion.identity();
        this.flashQuad.rotation.z = Math.random() * Math.PI * 2;
        this.flashQuad.scale.setScalar(0.85 + strength * 0.35);
        this.flashQuad.visible = true;
        this.flashT = 0.07;
        (this.flashQuad.material as THREE.MeshBasicMaterial).opacity = 1;
      }
    }
  }

  /** Current muzzle position in VIEW space (the stage scene's coordinate
   * space). Callers transform by the world camera matrix to place world-space
   * first-person effects (flash sprite, smoke, shell ejecta). */
  muzzleView(out: THREE.Vector3): THREE.Vector3 {
    const m = this.currentModel;
    if (!m) return out.copy(this.muzzleFlashLight.position);
    this.pivot.updateMatrixWorld(true);
    return m.group.localToWorld(out.copy(m.muzzle));
  }

  /**
   * First-person muzzle flash, drawn INSIDE the stage at the weapon muzzle:
   * a bright additive star quad that carries the weapon transform, so the
   * flash sits exactly at the on-screen barrel (a world-space sprite misses
   * it — the stage camera's FOV differs from the world's). HDR color pushes
   * the quad over the bloom threshold for a genuine flash read.
   */
  private flashQuad: THREE.Mesh | null = null;
  private flashT = 0;
  private static buildFlashTexture(): THREE.CanvasTexture {
    const size = 96;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,240,210,1)');
    grad.addColorStop(0.25, 'rgba(255,190,110,0.85)');
    grad.addColorStop(0.6, 'rgba(255,140,60,0.25)');
    grad.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    // Four-petal star for a muzzle-burst silhouette.
    ctx.translate(size / 2, size / 2);
    ctx.fillStyle = 'rgba(255,225,170,0.9)';
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -3);
      ctx.lineTo(size * 0.46, 0);
      ctx.lineTo(0, 3);
      ctx.closePath();
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private ensureFlash(): void {
    if (this.flashQuad || typeof document === 'undefined') return;
    const material = new THREE.MeshBasicMaterial({
      map: ViewModel.buildFlashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      color: new THREE.Color(5.5, 4.4, 2.6),
    });
    this.flashQuad = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.15), material);
    this.flashQuad.visible = false;
    this.flashQuad.frustumCulled = false;
    this.pivot.add(this.flashQuad);
  }

  private updateFlash(dt: number): void {
    if (!this.flashQuad || this.flashT <= 0) return;
    this.flashT = Math.max(0, this.flashT - dt);
    const k = this.flashT / 0.07;
    this.flashQuad.scale.setScalar(0.7 + (1 - k) * 0.9);
    (this.flashQuad.material as THREE.MeshBasicMaterial).opacity = k;
    if (this.flashT <= 0) this.flashQuad.visible = false;
  }

  /** Per-frame presentation update driven by actor state. */
  update(actor: Actor | null, dt: number, lookDx: number, lookDy: number, movingSpeed: number): void {
    if (!actor || !actor.alive) {
      this.evaluate(null, dt, lookDx, lookDy, movingSpeed);
      return;
    }
    const selected = actor.inv.selectedWeapon;
    this.setWeapon(selected?.weaponId ?? null, selected?.rarity ?? 'common');
    const total = selected ? boltDuration(selected.weaponId) : 0;
    const reloadCompleted = actor.wpn.reloadTimer <= 0 && this.offlineReloadRemaining > 0
      && this.offlineReloadRemaining <= Math.max(0, dt) + 1e-9;
    this.offlineReloadRemaining = actor.wpn.reloadTimer;
    this.evaluate({
      crouched: actor.crouched,
      adsAmount: actor.wpn.adsAmount,
      reloadPhase: actor.wpn.reloadTimer > 0 && actor.wpn.reloadTotal > 0
        ? THREE.MathUtils.clamp(1 - actor.wpn.reloadTimer / actor.wpn.reloadTotal, 0, 1) : -1,
      reloadCompleted,
      empty: actor.wpn.reloadingEmpty,
      reloadShells: selected ? Math.max(1, WEAPONS[selected.weaponId].magSize - actor.wpn.reloadInitialAmmo) : 1,
      boltPhase: actor.wpn.boltTimer > 0 && total > 0
        ? THREE.MathUtils.clamp(1 - actor.wpn.boltTimer / total, 0, 1) : -1,
    }, dt, lookDx, lookDy, movingSpeed);
  }

  private evaluate(input: PresentationInput | null, dt: number, lookDx: number, lookDy: number, movingSpeed: number): void {
    this.t += dt;
    this.muzzleFlashLight.intensity *= Math.exp(-dt * 30);
    this.updateFlash(dt);
    if (!input || (!this.currentId && !this.fistRig.group.visible)) {
      this.group.visible = false;
      this.armSolver.setVisible(false);
      this.resetPresentation();
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
      this.updateFists(input.crouched, dt, movingSpeed, swapDip);
      return;
    }

    const weaponId = this.currentId;
    const def = WEAPONS[weaponId];
    const adsTarget = THREE.MathUtils.clamp(input.adsAmount, 0, 1);
    this.adsSmooth += (adsTarget - this.adsSmooth) * Math.min(1, dt * 12);
    const ads = this.adsSmooth;

    // Sprint lowering when moving fast & not aiming
    const sprinting = movingSpeed > 8.6 && !adsTarget;
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 7);

    const bobAmp = movingSpeed > 0.5 ? Math.min(1, movingSpeed / 9.5) : 0;
    const bobFreq = Math.max(6, movingSpeed * 0.92);
    const bobX = Math.sin(this.t * bobFreq) * 0.0105 * bobAmp * (1 - ads * 0.88);
    const bobY = Math.abs(Math.cos(this.t * bobFreq)) * 0.0125 * bobAmp * (1 - ads * 0.88);

    const { reloadPhase, boltPhase, empty, reloadShells } = input;
    const reloading = reloadPhase >= 0;
    const reload = this.currentKey ? this.reloads.get(this.currentKey) : undefined;
    if (input.reloadCompleted) reload?.reset(true);
    const track = RELOAD_TRACKS[weaponId];
    const reloadWeight = reloading ? smooth(reloadPhase / 0.14) * (1 - smooth((reloadPhase - 0.88) / 0.12)) : 0;
    const reloadPitch = track.pitch * reloadWeight;
    const reloadRoll = track.roll * reloadWeight;
    const reloadDrop = track.drop * reloadWeight;
    const mag = this.currentModel?.mag ?? null;

    // Bolt / pump cycling
    const boltAnim = boltPhase > 0 && boltPhase < 1 ? Math.sin(boltPhase * Math.PI) : 0;
    const bolt = this.currentModel?.bolt ?? null;
    let pumpOffset = 0;
    if (bolt && (def.fireMode === 'bolt' || def.fireMode === 'pump')) {
      if (bolt.userData.baseZ === undefined) bolt.userData.baseZ = bolt.position.z;
      // CYCLE 36 (review): a pump PULLS rearward (+z) to eject, then returns.
      const dir = def.fireMode === 'pump' ? 0.085 : 0.06;
      pumpOffset = boltAnim * dir;
      bolt.position.z = (bolt.userData.baseZ as number) + pumpOffset;
    }

    // CYCLE 35/36: drive the hand rig with the same choreography the weapon
    // already follows (reload timeline, pump/bolt travel, ADS tuck).
    const rig = this.currentKey ? this.rigs.get(this.currentKey) : undefined;
    if (rig) {
      const boltMode = def.fireMode === 'bolt';
      const supportStyle: SupportStyle = weaponId === 'pistol'
        ? 'over'
        : def.fireMode === 'pump'
          ? 'pump'
          : weaponId === 'smg' ? 'side' : 'under';
      rig.pose({
        reloadPhase: reload?.fingerPhase(reloadPhase) ?? reloadPhase,
        supportStyle,
        magLocal: mag ? mag.position : null,
        pumpOffset,
        pumpHand: def.fireMode === 'pump',
        ads,
        boltPhase: boltMode ? boltPhase : -1,
        boltLocal: boltMode && bolt ? bolt.position : null,
      });
      reload?.pose(rig, reloadPhase, empty, reloadShells);
    }

    // Compose position: hip → ADS → sprint offsets
    const inspect = this.inspectPose(dt, ads, this.sprintBlend, reloading);
    const iw = inspect.weight;
    const adsFwd = ViewModel.ADS_EXTRA_FORWARD[weaponId] * ads;
    const adsDrop = ViewModel.ADS_EXTRA_Y[weaponId] * ads;
    const adsPose = ADS_POSE[weaponId];

    // Movement inertia: the weapon trails lateral/forward acceleration
    // (mass), settles back on a spring. Suppressed while aiming.
    const inertiaScale = (1 - ads * 0.85) * (1 - this.sprintBlend * 0.4);
    this.sideLag += (-this.motion.sideVel * 0.0052 - this.sideLag) * Math.min(1, dt * 5.5);
    this.fwdLag += (this.motion.fwdVel * 0.0038 - this.fwdLag) * Math.min(1, dt * 5.5);
    this.sideLag = THREE.MathUtils.clamp(this.sideLag, -0.05, 0.05) * inertiaScale;
    this.fwdLag = THREE.MathUtils.clamp(this.fwdLag, -0.04, 0.04) * inertiaScale;

    // Landing dip / jump rise / airborne float.
    this.landT = Math.max(0, this.landT - dt);
    const landDip = this.landT > 0 ? Math.sin((1 - this.landT / 0.34) * Math.PI) * this.landT * 0.16 : 0;
    this.jumpT = Math.max(0, this.jumpT - dt);
    const jumpRise = this.jumpT > 0 ? Math.sin((1 - this.jumpT / 0.22) * Math.PI) * 0.02 : 0;
    const airFloat = !this.motion.grounded
      ? THREE.MathUtils.clamp(-this.motion.vertVel * 0.0016, -0.012, 0.014)
      : 0;

    // Crouch pull (weapon held slightly tighter and closer).
    this.crouchBlend += ((input.crouched ? 1 : 0) - this.crouchBlend) * Math.min(1, dt * 8);

    // Idle breathing: a slow, shallow sway so the weapon never freezes.
    const breathe = Math.sin(this.t * 1.7) * 0.0021 + Math.sin(this.t * 0.9) * 0.0012;

    const px =
      HIP_POS.x + (0 - HIP_POS.x) * ads +
      (SPRINT_POS.x - HIP_POS.x) * this.sprintBlend * (1 - ads) +
      bobX + this.swayX + this.sideLag - 0.1 * inspect.lift * iw;
    const py =
      HIP_POS.y + (adsPose.y - HIP_POS.y) * ads - adsDrop +
      (SPRINT_POS.y - HIP_POS.y) * this.sprintBlend * (1 - ads) +
      bobY + this.swayY - reloadDrop - swapDip + 0.04 * inspect.lift * iw +
      breathe - landDip + jumpRise + airFloat - this.crouchBlend * 0.012;
    const pz =
      HIP_POS.z + (adsPose.z - HIP_POS.z) * ads - adsFwd +
      (SPRINT_POS.z - HIP_POS.z) * this.sprintBlend * (1 - ads) +
      this.recoilZ + 0.14 * inspect.lift * iw + this.fwdLag + this.crouchBlend * 0.012;

    this.pivot.position.set(px, py, pz);
    // Base hip stance angles the receiver inward across the lower-right
    // frame (muzzle toward center) like a real ready position; ADS removes it.
    const hipYaw = 0.28 * (1 - ads);
    const hipRoll = -0.1 * (1 - ads);
    const strafeRoll = this.sideLag * 1.6;
    const landPitch = this.landT > 0 ? Math.sin((1 - this.landT / 0.34) * Math.PI) * 0.12 : 0;
    this.pivot.rotation.set(
      -this.swayY * 2.1 + this.recoilPitch + reloadPitch + this.sprintBlend * 0.44 * (1 - ads) + inspect.pitch * iw + landPitch + airFloat * 6,
      this.swayX * 2.2 - this.sprintBlend * 0.58 * (1 - ads) + hipYaw + inspect.yaw * iw,
      reloadRoll + this.swayRoll + this.recoilRoll + this.sprintBlend * 0.3 * (1 - ads) - bobX * 1.4 + hipRoll + inspect.roll * iw + strafeRoll,
    );

    // CYCLE 36 (user pass): connect the arms shoulder→elbow→wrist to the
    // posed hands so nothing floats.
    this.solveArms(ads);
  }

  /** Solve the arm chains against the live hand positions (world → view). */
  private solveArms(ads = 0): void {
    const rig = this.currentKey ? this.rigs.get(this.currentKey) : undefined;
    if (!rig) {
      this.armSolver.setVisible(false);
      return;
    }
    this.pivot.updateMatrixWorld(true);
    const wR = ViewModel._wristWorldR;
    // Attach the sleeves at each hand's CUFF RIDGE (an anchor riding the
    // hand's own cuff barrel), not behind the palm and not a hand-orientation
    // guess: the grip pose rotates the hand's local +z up-and-across (the old
    // +z offset dragged the sniper ADS sleeve through the scope line), while
    // a fixed view-space offset gapped the sleeve off the under-hand. The
    // elbow droop (ArmSolver bend hints) does the below-the-bore routing.
    rig.wristR.getWorldPosition(wR);
    const wL = ViewModel._wristWorldL;
    rig.wristL.getWorldPosition(wL);
    const pair = ViewModel._wristPair;
    pair[0].copy(wR);
    pair[1].copy(wL);
    this.armSolver.solve(this.pivot, pair, ads);
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
    if (!actor || !actor.alive) {
      this.evaluate(null, dt, lookDx, lookDy, movingSpeed);
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
    if (selected?.kind === 'weapon') this.lastAmmoInMag = selected.ammoInMag;
    this.evaluate({
      crouched: actor.crouched,
      adsAmount: opts.adsAmount ?? 0,
      ...this.advancePresentationTimelines(dt),
    }, dt, lookDx, lookDy, movingSpeed);
  }

  kick(strength: number): void {
    if (this.presentReloadElapsed >= 0 || this.offlineReloadRemaining > 0) {
      this.clearPresentationTimelines();
      this.restoreMovableParts();
    }
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
    drive(this.fistsR, 1, 0.17, -0.125, -0.32, this.fistRig.baseQuatR);
    drive(this.fistsL, -1, -0.16, -0.15, -0.36, this.fistRig.baseQuatL);

    // Unarmed guard sits centered (the weapon hip x-offset would shove the
    // lead fist off-line); pulled closer than the weapon hip so the fists
    // read at fight distance.
    this.pivot.position.set(
      this.swayX,
      -0.075 + (SPRINT_POS.y - HIP_POS.y) * this.sprintBlend * 0.6 + this.swayY,
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
    const pair = ViewModel._wristPair;
    pair[0].copy(wR);
    pair[1].copy(wL);
    this.armSolver.solve(this.pivot, pair);
  }
}
