/**
 * Combatant presentation v2: skinned GLB characters (CC0 Quaternius Universal
 * Base Characters) driven by the Universal Animation Library (43 clips),
 * with procedural costume attachments per identity (helmets, armor,
 * pauldrons, backpacks) and weapon attachment to the right-hand bone.
 * Falls back to legacy capsule rig if assets fail.
 */

import * as THREE from 'three';

import { AnimationAction, AnimationMixer, LoopOnce } from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Actor } from '../sim/actor';
import type { ActorView } from '../sim/gameStateView';
import type { SkinId } from '../core/settings';
import { feetYFromBodyCenter } from '../physics/physics';

export type { SkinId } from '../core/settings';

export interface CharacterRig {
  group: THREE.Group;
  /** Currently playing base clip key (QA introspection). */
  animName: string;
  /** Legacy fields kept for API compatibility */
  hips?: THREE.Object3D;
  torso?: THREE.Object3D;
  head?: THREE.Object3D;
  armL?: THREE.Object3D;
  armR?: THREE.Object3D;
  legL?: THREE.Object3D;
  legR?: THREE.Object3D;
  weaponMount?: THREE.Object3D;
  accentMats: THREE.MeshStandardMaterial[];
  baseMats: THREE.MeshStandardMaterial[];
  dissolving: number;
  /** Skinned-character extensions */
  update?(a: Actor, t: number, dt: number): void;
  /** Replica-only presentation update; does not require an Actor or Match. */
  updateView?(a: ActorView, t: number, dt: number): void;
  /**
   * Trigger one melee swing presentation (jab/cross alternating). The host
   * path calls this internally from the authoritative punchTimer edge;
   * guests call it from the networked meleeSwing event.
   */
  playPunch?(): void;
  attachWeapon?(model: THREE.Object3D | null): void;
  /** Resolve the attached weapon's authored muzzle in world space. */
  muzzleWorld?(position: THREE.Vector3, direction: THREE.Vector3): boolean;
  /** Bind the death clip during loading without advancing or displaying it. */
  prewarmDeath?(): void;
  dispose(): void;
}

interface AnimSet {
  [key: string]: THREE.AnimationClip;
}

/** Fade bookkeeping so completed crossfades can retire the outgoing action. */
interface FadingAction extends AnimationAction {
  _fadingFrom?: AnimationAction;
}

/** Rig clip key -> authored Universal Animation Library clip name. */
export const CLIP_MAP: Array<[string, string]> = [
  ['idle', 'Idle_Loop'],
  ['walk', 'Walk_Loop'],
  ['jog', 'Jog_Fwd_Loop'],
  ['sprint', 'Sprint_Loop'],
  ['jump_start', 'Jump_Start'],
 ['jump_loop', 'Jump_Loop'],
  ['jump_land', 'Jump_Land'],
  ['crouch_idle', 'Crouch_Idle_Loop'],
  ['crouch_walk', 'Crouch_Fwd_Loop'],
  ['swim', 'Swim_Fwd_Loop'],
  ['swim_idle', 'Swim_Idle_Loop'],
  ['roll', 'Roll'],
  ['aim_neutral', 'Pistol_Aim_Neutral'],
  ['aim_up', 'Pistol_Aim_Up'],
  ['aim_down', 'Pistol_Aim_Down'],
  ['armed_idle', 'Pistol_Idle_Loop'],
  ['reload', 'Pistol_Reload'],
  ['hit_chest', 'Hit_Chest'],
  ['death', 'Death01'],
  ['interact', 'Interact'],
  ['punch_jab', 'Punch_Jab'],
  ['punch_cross', 'Punch_Cross'],
];

/** Clips that play once and hold their final pose until the state machine moves on. */
const ONESHOT_CLIPS = new Set(['jump_start', 'jump_land', 'hit_chest', 'reload', 'interact', 'death', 'punch_jab', 'punch_cross']);
const LOCOMOTION_CLIPS = new Set(['walk', 'jog', 'sprint', 'crouch_walk']);

const TARGET_HEIGHT = 1.86;

/**
 * Nominal metres-per-second each locomotion clip was calibrated against, and
 * the shared playback-rate clamp. Both the authoritative-actor and replica
 * paths rate clips through this one function so a guest's characters never
 * march at a different cadence than the host's. Climb above the clamp shows
 * as foot skating; sprint+dash caps slightly higher by design.
 */
export function locomotionTimeScale(clip: string, speed: number, dashing = false): number {
  const nominal: Record<string, number> = { walk: 2.35, jog: 5.9, sprint: 9.7, crouch_walk: 2.0 };
  const base = nominal[clip];
  if (!base) return 1;
  return THREE.MathUtils.clamp(speed / base, 0.65, dashing ? 1.55 : 1.42);
}

/** Slow the freefall blend in/out; sharp enough to read, soft enough to never snap. */
const FREEFALL_BLEND_RATE = 3.2;

/**
 * Appearance is deliberately data-driven, but all geometry remains procedural
 * and uses the already licensed male/female base rigs. This keeps skin changes
 * deterministic and avoids loading an unapproved asset per cosmetic.
 */
export interface SkinSpec {
  id: SkinId;
  label: string;
  primary: number;
  secondary: number;
  accent: number;
  helmetKind: 0 | 1 | 2 | 3;
  armorHeavy: boolean;
  hasPack: boolean;
}

export const SKIN_SPECS: Readonly<Record<SkinId, SkinSpec>> = {
  vanguard: { id: 'vanguard', label: 'Vanguard', primary: 0x263446, secondary: 0x171c25, accent: 0xf2b544, helmetKind: 1, armorHeavy: true, hasPack: true },
  pathfinder: { id: 'pathfinder', label: 'Pathfinder', primary: 0x315d52, secondary: 0x172a29, accent: 0x7de0c0, helmetKind: 3, armorHeavy: false, hasPack: true },
  specter: { id: 'specter', label: 'Specter', primary: 0x191d2b, secondary: 0x0a0d14, accent: 0x9c7cff, helmetKind: 2, armorHeavy: false, hasPack: false },
  striker: { id: 'striker', label: 'Striker', primary: 0x5b2d2d, secondary: 0x241316, accent: 0xff6b55, helmetKind: 0, armorHeavy: true, hasPack: false },
  warden: { id: 'warden', label: 'Warden', primary: 0x4b5142, secondary: 0x20231c, accent: 0xd6e890, helmetKind: 1, armorHeavy: true, hasPack: true },
  nova: { id: 'nova', label: 'Nova', primary: 0x3d2a58, secondary: 0x1b122c, accent: 0x66d8ff, helmetKind: 3, armorHeavy: false, hasPack: true },
};

export const SKIN_IDS: readonly SkinId[] = Object.freeze([
  'vanguard', 'pathfinder', 'specter', 'striker', 'warden', 'nova',
]);

const feetYFromView = feetYFromBodyCenter;

/** Stable bot appearance assignment; never depends on frame order or Math.random. */
export function skinForName(name: string): SkinId {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return SKIN_IDS[(hash >>> 0) % SKIN_IDS.length]!;
}

interface LiveRig {
  group: THREE.Group;
  casters: THREE.Mesh[];
  lodTier: number;
  distSq: number;
}

/** All live full character rigs (fallback capsule rigs excluded). */
const liveRigs: Array<LiveRig> = [];

export class CharacterFactory {
  /**
   * Per-frame LOD/shadow bookkeeping. Computes a distance tier per rig and
   * enforces the character-shadow budget: only the closest `maxFull` rigs
   * render into the shadow map; everyone else keeps a fully rendered body
   * with shadow casting disabled. Deterministic given the camera position.
   */
  static beginFrame(cameraPosition: THREE.Vector3, maxFullShadowCasters = 4): void {
    for (const rig of liveRigs) {
      rig.distSq = rig.group.position.distanceToSquared(cameraPosition);
      rig.lodTier = rig.distSq < 25 * 25 ? 0 : rig.distSq < 60 * 60 ? 1 : 2;
    }
    const casters = liveRigs.filter((r) => r.distSq < 90 * 90)
      .sort((a, b) => a.distSq - b.distSq);
    for (const rig of liveRigs) {
      const full = casters.indexOf(rig) < maxFullShadowCasters;
      for (const mesh of rig.casters) mesh.castShadow = full;
    }
  }
  private protoMale: THREE.Group | null = null;
  private protoFemale: THREE.Group | null = null;
  private anims: AnimSet = {};
  private scaleM = 1;
  private scaleF = 1;
  ready = false;

  async init(male: THREE.Group, female: THREE.Group, clips: THREE.AnimationClip[]): Promise<void> {
    this.protoFemale = preparePrototype(female);
    this.protoMale = preparePrototype(male);
    const box = new THREE.Box3().setFromObject(this.protoMale);
    const h = Math.max(0.001, box.max.y);
    this.scaleM = TARGET_HEIGHT / h;
    const boxF = new THREE.Box3().setFromObject(this.protoFemale);
    this.scaleF = TARGET_HEIGHT / Math.max(0.001, boxF.max.y);

    for (const [key, srcName] of CLIP_MAP) {
      const clip = clips.find((c) => c.name === srcName);
      if (clip) {
        // Strip track node prefixes so tracks bind by bone name on any clone.
        const stripped = clip.clone();
        stripped.tracks = stripped.tracks.map((t) => {
          const parts = t.name.split('.');
          return parts.length > 1 ? t.clone() : t;
        });
        stripped.name = key;
        this.anims[key] = stripped;
      }
    }
    this.ready = true;
  }

  /**
   * Build a rig for an actor. The explicit skin selects a deterministic
   * procedural costume; `female` picks the existing base body. The fourth
   * argument accepts either the legacy weapon model or a skin id.
   */
  create(
    name: string,
    accentColor: number,
    female: boolean,
    weaponModelOrSkin: THREE.Object3D | null | SkinId = null,
    explicitSkin?: SkinId,
  ): CharacterRig {
    const proto = female ? this.protoFemale : this.protoMale;
    const s = female ? this.scaleF : this.scaleM;
    // Keep the legacy weapon fourth argument source-compatible while allowing
    // callers that do not need a weapon to pass the skin in that position.
    const weaponModel = typeof weaponModelOrSkin === 'string' ? null : weaponModelOrSkin;
    const skinId = typeof weaponModelOrSkin === 'string'
      ? weaponModelOrSkin
      : explicitSkin ?? skinForName(name);
    const skin = SKIN_SPECS[skinId] ?? SKIN_SPECS.vanguard;

    const group = new THREE.Group();
    group.userData.xoSkinId = skin.id;
    const accents: THREE.MeshStandardMaterial[] = [];
    const baseMats: THREE.MeshStandardMaterial[] = [];

    if (!this.ready || !proto || !Object.keys(this.anims).length) {
      return fallbackRig(group, accentColor, accents, baseMats, name, skin);
    }

    const body = SkeletonUtils.clone(proto) as THREE.Group;
    body.scale.setScalar(s);
    group.add(body);
    // SkeletonUtils intentionally shares immutable BufferGeometry with the
    // loaded prototype. Keep those references out of per-rig cleanup; only
    // procedural costume geometry belongs to this actor.
    const sharedBodyGeometry = new Set<THREE.BufferGeometry>();
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) sharedBodyGeometry.add(mesh.geometry);
    });

    // Suit recolor: find materials and tint toward identity palette.
    const suitColor = new THREE.Color(skin.primary).lerp(new THREE.Color(accentColor), 0.18);
    // Preserve readable cloth/plate values under the night maps. The previous
    // double darkening drove the body albedo close to black, so a correctly
    // exposed TPS character still rendered as a silhouette with no costume
    // detail. This remains a physically lit material rather than self-lighting.
    const darkSuit = suitColor.clone().multiplyScalar(0.58).lerp(new THREE.Color(0x30363e), 0.35);
    const trimColor = suitColor.clone();
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const next = mats.map((m) => {
        const std = m as THREE.MeshStandardMaterial;
        const nm = std.clone();
        nm.envMapIntensity = 0.9;
        if (/suit|body|armor|MI_Superhero/i.test(nm.name ?? '')) {
          nm.color = darkSuit.clone().lerp(suitColor, 0.35);
          nm.metalness = Math.min(0.65, nm.metalness + 0.25);
          nm.roughness = Math.max(0.42, nm.roughness * 0.85);
          // The bundled suit texture is intentionally very dark. A restrained
          // albedo-derived bounce term keeps seams and armour planes readable
          // in NeoCity without turning the actor into an unlit/glowing model.
          // This mirrors the soft character fill used by competitive TPS games
          // while all highlights and shadows still come from the PBR material.
          nm.emissive.copy(suitColor).multiplyScalar(0.34);
          nm.emissiveMap = null;
          nm.emissiveIntensity = 0.52;
        }
        // Every clone is actor-owned and must dissolve/dispose with the rig,
        // including skin, hair and eye materials.
        baseMats.push(nm);
        return nm;
      });
      mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Real frustum culling with bounds expanded for the animation range:
      // permanently unculled skinned meshes cost skeleton/skin work for every
      // off-screen actor in ten-combatant matches.
      mesh.frustumCulled = true;
      const skinned = mesh as THREE.SkinnedMesh;
      if (typeof skinned.computeBoundingSphere === 'function') {
        skinned.computeBoundingSphere();
        if (skinned.boundingSphere) {
          skinned.boundingSphere.radius += 0.6;
          skinned.boundingSphere.center.y += 0.15;
        }
      }
    });

    // ---- Costume attachments -------------------------------------------
    const bones = collectBones(body);
    const costumeMat = new THREE.MeshStandardMaterial({
      color: skin.secondary,
      emissive: new THREE.Color(skin.secondary).multiplyScalar(0.3),
      emissiveIntensity: 0.4,
      roughness: 0.52,
      metalness: 0.45,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x111318, emissive: new THREE.Color(skin.accent).lerp(trimColor, 0.18), emissiveIntensity: 1.15, roughness: 0.38, metalness: 0.5,
    });
    accents.push(trimMat);
    baseMats.push(costumeMat);

    const helmetKind = skin.helmetKind;
    const armorHeavy = skin.armorHeavy;
    const hasPack = skin.hasPack;

    if (bones['Head']) {
      const head = bones['Head'];
      const helm = new THREE.Group();
      if (helmetKind === 0) {
        // Visor band
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.132, 0.142, 0.075, 12), trimMat);
        band.rotation.x = Math.PI / 2 - 0.12;
        band.position.set(0, 0.02, 0.055);
        helm.add(band);
      } else if (helmetKind === 1) {
        // Full dome helmet
        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.148, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), costumeMat);
        dome.position.y = 0.015;
        const visor = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.045, 0.03), trimMat);
        visor.position.set(0, 0.03, 0.115);
        const crest = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.17), trimMat);
        crest.position.set(0, 0.13, 0);
        helm.add(dome, visor, crest);
      } else if (helmetKind === 2) {
        // Hood
        const hood = new THREE.Mesh(new THREE.ConeGeometry(0.155, 0.24, 10), costumeMat);
        hood.position.y = 0.08;
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.016, 6, 16), trimMat);
        rim.rotation.x = Math.PI / 2 - 0.15;
        rim.position.set(0, 0.04, 0.03);
        helm.add(hood, rim);
      } else {
        // Cap + antenna
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.152, 0.075, 12), costumeMat);
        cap.position.y = 0.075;
        const brim = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.022, 0.11), costumeMat);
        brim.position.set(0, 0.045, 0.115);
        const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.21, 5), trimMat);
        ant.position.set(0.105, 0.16, -0.04);
        ant.rotation.z = -0.28;
        helm.add(cap, brim, ant);
      }
      head.add(helm);
    }

    if (armorHeavy) {
      // Chest plate
      if (bones['spine_02'] || bones['spine_03']) {
        const anchor = bones['spine_03'] ?? bones['spine_02']!;
        const plate = new THREE.Group();
        const main = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.26, 0.14), costumeMat);
        const glow = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 0.03), trimMat);
        glow.position.set(0, 0.03, 0.075);
        plate.add(main, glow);
        anchor.add(plate);
        plate.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.frustumCulled = true; });
      }
      // Pauldrons
      for (const side of ['l', 'r']) {
        const b = bones[`clavicle_${side}`] ?? bones[`upperarm_${side}`];
        if (!b) continue;
        const pad = new THREE.Mesh(
          side === 'l'
            ? new THREE.SphereGeometry(0.085, 10, 8)
            : new THREE.SphereGeometry(0.085, 10, 8),
          costumeMat,
        );
        pad.scale.set(1, 0.72, 1);
        pad.position.set(side === 'l' ? -0.045 : 0.045, 0.055, 0);
        b.add(pad);
        pad.frustumCulled = true;
      }
    }

    if (hasPack && bones['spine_01']) {
      const pack = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.3, 0.11), costumeMat);
      pack.position.set(0, 0.02, -0.12);
      const cell = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.02), trimMat);
      cell.position.set(0.06, 0, -0.062);
      pack.add(cell);
      bones['spine_01'].add(pack);
      pack.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.frustumCulled = true; });
    }

    // ---- Weapon attachment ---------------------------------------------
    const handR = bones['hand_r'];
    let weaponHolder: THREE.Group | null = null;
    if (handR) {
      weaponHolder = new THREE.Group();
      weaponHolder.rotation.set(Math.PI / 2, 0, 0); // align -Z barrel forward along fingers
      handR.add(weaponHolder);
      if (weaponModel) {
        weaponModel.position.set(0.02, 0.12, -0.02);
        weaponHolder.add(weaponModel);
      }
    }

    // Register for per-frame LOD tiers and the shadow budget.
    const casters: THREE.Mesh[] = [];
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.castShadow) casters.push(mesh);
    });
    const registryEntry: LiveRig = { group, casters, lodTier: 0, distSq: 0 };
    liveRigs.push(registryEntry);

    // ---- Animation state machine ---------------------------------------
    const mixer = new AnimationMixer(body);
    const actions: Record<string, FadingAction> = {};
    for (const k of Object.keys(this.anims)) {
      const a = mixer.clipAction(this.anims[k]!);
      a.enabled = true;
      a.setEffectiveWeight(0);
      actions[k] = a;
    }
    // Only the initial base clip and the armed-idle layer stay scheduled;
    // every other action is started by crossfade() on demand and stopped when
    // its fade completes. Ten combatants x ~10 pre-played loops used to cost
    // substantial mixer evaluation every frame for zero visual output.
    actions['idle']?.play();
    actions['armed_idle']?.play();

    let currentBase = '';
    let animAccum = 0;
    let fadingFrom: FadingAction | null = null;
    let fadingTimer = 0;
    let aimWeight = 0;
    let wasGrounded = true;
    let jumpStartT = 0;
    let landT = 0;
    let hitT = 0;
    let prevDmg: number | null = null;
    let visualSpeed = 0;
    let forwardLean = 0;
    let sideLean = 0;
    let disposed = false;
    const bodyBaseRotation = body.rotation.clone();
    // Melee: real licensed one-shot clips (Punch_Jab / Punch_Cross), hands
    // alternating per swing. punchClipHolds tracks the active presentation.
    let punchClip = 'punch_jab';
    let punchHoldT = 0;
    let swingIndex = 0;
    // Trained freefall pose blend (0 = normal clips, 1 = full skydive pose).
    let freefallBlend = 0;
    const _fwq = new THREE.Quaternion();
    const _bwq = new THREE.Quaternion();
    const _wq = new THREE.Quaternion();
    const _tq = new THREE.Quaternion();
    const _axis = new THREE.Vector3();
    function triggerPunch(): void {
      punchClip = swingIndex % 2 === 0 ? 'punch_jab' : 'punch_cross';
      swingIndex++;
      punchHoldT = 0.34;
      crossfade(currentBase, punchClip, 0.05);
      currentBase = punchClip;
    }

    /**
     * Rotate `bone` by `angle` (radians) about a body-space axis, converted
     * into the bone's local space, as an additive overlay on whatever the
     * mixer wrote this frame. The mixer rewrites local quaternions on the
     * next update, so the overlay never accumulates drift.
     */
    function twistFromBodyAxis(bone: THREE.Object3D, axis: 'x' | 'y' | 'z', angle: number): void {
      if (!bone.parent || angle === 0) return;
      bone.parent.getWorldQuaternion(_fwq);
      body.getWorldQuaternion(_bwq);
      _axis.set(0, 0, 0);
      _axis[axis] = 1;
      _axis.applyQuaternion(_bwq);
      _wq.setFromAxisAngle(_axis, angle);
      _tq.copy(_fwq).invert().multiply(_wq).multiply(_fwq);
      bone.quaternion.premultiply(_tq);
    }

    /**
     * Trained freefall pose: body horizontal, back toward the ground, chest
     * and face up, arms spread, knees bent and legs separated. `blend`
     * eases the whole pose in and out so transitions never snap, and the
     * gameplay collider is untouched (presentation-only).
     */
    function applyFreefallPose(blend: number): void {
      if (blend < 0.001) return;
      // Belly-up: rotating the body -90deg about its local X tips the head
      // back and the chest skyward while travel stays along body +Z.
      body.rotation.x = bodyBaseRotation.x - (Math.PI / 2 - 0.14) * blend;
      // Arms spread wide for stability (left -Z / right +Z derived from the
      // UBL bind layout: -Z about the body roll axis abducts the left limbs).
      const armL = bones['upperarm_l'];
      const armR = bones['upperarm_r'];
      const foreL = bones['lowerarm_l'];
      const foreR = bones['lowerarm_r'];
      if (armL) twistFromBodyAxis(armL, 'z', -0.62 * blend);
      if (armR) twistFromBodyAxis(armR, 'z', 0.62 * blend);
      // Slight elbow bend so the arms read as controlled, not rigid.
      if (foreL) twistFromBodyAxis(foreL, 'y', 0.35 * blend);
      if (foreR) twistFromBodyAxis(foreR, 'y', -0.35 * blend);
      // Legs separated with bent knees, heels trailing toward the back plane.
      const thighL = bones['thigh_l'];
      const thighR = bones['thigh_r'];
      const calfL = bones['calf_l'];
      const calfR = bones['calf_r'];
      if (thighL) twistFromBodyAxis(thighL, 'z', -0.2 * blend);
      if (thighR) twistFromBodyAxis(thighR, 'z', 0.2 * blend);
      if (calfL) twistFromBodyAxis(calfL, 'x', -0.5 * blend);
      if (calfR) twistFromBodyAxis(calfR, 'x', -0.5 * blend);
    }

    function crossfade(from: string, to: string, dur = 0.16): void {
      const a = actions[to], b = actions[from];
      if (!a || from === to) return;
      if (ONESHOT_CLIPS.has(to)) {
        a.setLoop(LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      const phase = b && LOCOMOTION_CLIPS.has(from) && LOCOMOTION_CLIPS.has(to)
        ? (b.time % Math.max(0.001, b.getClip().duration)) / Math.max(0.001, b.getClip().duration)
        : 0;
      a.reset();
      if (phase > 0) a.time = phase * a.getClip().duration;
      a.setEffectiveWeight(1);
      a.play();
      if (b) {
        b.crossFadeTo(a, dur, false);
        // Retire the outgoing action once the blend completes so the mixer
        // stops evaluating it; a new crossfade retires the previous one.
        fadingFrom = b;
        fadingTimer = dur + 0.03;
      }
    }

    const rig: CharacterRig = {
      group,
      animName: 'idle',
      accentMats: accents,
      baseMats: baseMats,
      dissolving: 0,
      playPunch() {
        triggerPunch();
      },
      prewarmDeath() {
        const death = actions['death'];
        if (!death) return;
        death.reset();
        death.setEffectiveWeight(0);
        death.play();
        mixer.update(0);
        death.stop();
      },
      update(a: Actor, t: number, dt: number) {
        // Face aim heading. GLB base characters are authored facing +Z;
        // sim yaw 0 faces -Z, hence the PI offset.
        rig.group.rotation.y = a.yaw + Math.PI;
        if (!a.alive) {
          // death clip once, then dissolve handled externally
          const death = actions['death'];
          if (death && !death.isRunning() && rig.dissolving === 0) {
            crossfade(currentBase, 'death', 0.12);
            death.setLoop(LoopOnce, 1);
            death.clampWhenFinished = true;
          }
          mixer.update(dt);
          return;
        }
        const speedH = Math.hypot(a.body.velocity.x, a.body.velocity.z);
        visualSpeed += (speedH - visualSpeed) * Math.min(1, dt * (speedH > visualSpeed ? 10 : 7));
        const dashing = a.dashTimer > 0;

        // One-shot clip edges: jump start/land, damage flinch, interaction.
        // lastDamageTime is a count-up "time since damage" timer that saturates
        // at 90 — a DECREASE means fresh damage was just applied.
        if (prevDmg !== null && a.lastDamageTime < prevDmg) {
          if (a.body.grounded && a.state !== 'swim') hitT = 0.34;
        }
        prevDmg = a.lastDamageTime;
        if (!a.body.grounded && wasGrounded && a.body.velocity.y > 2) jumpStartT = 0.26;
        if (a.body.grounded && !wasGrounded) {
          landT = 0.3;
          jumpStartT = 0;
        }
        wasGrounded = a.body.grounded;
        jumpStartT = Math.max(0, jumpStartT - dt);
        landT = Math.max(0, landT - dt);
        hitT = Math.max(0, hitT - dt);
        a.interactTimer = Math.max(0, a.interactTimer - dt);

        // Melee presentation: real jab/cross one-shots on the swing edge.
        if (a.punchTimer > 0 && punchHoldT <= 0) triggerPunch();
        punchHoldT = Math.max(0, punchHoldT - dt);

        // Retire faded-out actions: keeps the mixer's evaluated-action set
        // bounded at (base + one fading) instead of every visited clip.
        if (fadingFrom && (fadingTimer -= dt) <= 0) {
          fadingFrom.stop();
          fadingFrom.setEffectiveWeight(0);
          fadingFrom = null;
        }

        // Distance LOD: far actors animate at a reduced cadence (timer-based
        // one-shots and authoritative gameplay state stay current; the mixer
        // and pose work run at 20 Hz instead of every presented frame).
        let animDt = dt;
        if (registryEntry.lodTier > 0) {
          animAccum += dt;
          const minStep = registryEntry.lodTier === 1 ? 1 / 30 : 1 / 20;
          if (animAccum < minStep) return;
          animDt = animAccum;
          animAccum = 0;
        }

        let want: string;
        if (dashing) {
          want = 'sprint';
        } else switch (a.state) {
          case 'slide': want = 'roll'; break;
          case 'mantle': want = 'roll'; break;
          case 'wallrun': want = 'sprint'; break;
          // Freefall keeps a gentle base clip for micro-motion; the trained
          // skydive pose is applied procedurally after the mixer step.
          case 'freefall': want = 'jump_loop'; break;
          case 'glide': want = 'jump_loop'; break;
          case 'swim': want = speedH > 1 ? 'swim' : 'swim_idle'; break;
          default:
            if (!a.body.grounded) want = jumpStartT > 0 ? 'jump_start' : 'jump_loop';
            else if (landT > 0 && speedH < 2.5) want = 'jump_land';
            else if (hitT > 0 && speedH < 3) want = 'hit_chest';
            else if (punchHoldT > 0) want = punchClip;
            else if (a.interactTimer > 0 && speedH < 2) want = 'interact';
            else if (a.crouched) want = speedH > 0.6 ? 'crouch_walk' : 'crouch_idle';
            else if (speedH < 0.6) {
              want = weaponHolder && weaponHolder.children.length > 0 && a.wpn.reloadTimer > 0
                ? 'reload'
                : 'idle';
            }
            else if (visualSpeed < 3.2) want = 'walk';
            else if (visualSpeed < 8.6) want = 'jog';
            else want = 'sprint';
        }
        if (want !== currentBase) {
          crossfade(currentBase, want);
          currentBase = want;
        }
        // Freefall QA label: the skydive pose is procedural, so surface it.
        rig.animName = a.state === 'freefall' ? 'freefall' : want;
        // Time-warp locomotion to actual speed so footfalls match ground speed
        const act = actions[want];
        if (!act) return;
        act.timeScale = locomotionTimeScale(want, visualSpeed, dashing);

        // Upper-body aim layer while holding a weapon (suppressed while a
        // full-body one-shot owns the pose)
        const aimBlocked = want === 'reload' || want === 'hit_chest' || want === 'interact';
        const armed = !!weaponHolder?.children.length &&
          a.state !== 'mantle' && a.state !== 'swim' && !a.crouched &&
          !aimBlocked;
        const wantAim = armed ? 1 : 0;
        aimWeight += (wantAim - aimWeight) * Math.min(1, dt * 8);
        if (aimWeight > 0.01) {
          const p = THREE.MathUtils.clamp(a.pitch, -1.1, 1.1);
          const wUp = Math.max(0, p) / 1.1;
          const wDown = Math.max(0, -p) / 1.1;
          actions['aim_neutral']!.setEffectiveWeight((1 - wUp - wDown) * aimWeight);
          actions['aim_up']!.setEffectiveWeight(wUp * aimWeight);
          actions['aim_down']!.setEffectiveWeight(wDown * aimWeight);
          if (speedH < 0.6) {
            if (!actions['aim_neutral']!.isRunning()) actions['aim_neutral']!.play();
            if (!actions['aim_up']!.isRunning()) actions['aim_up']!.play();
            if (!actions['aim_down']!.isRunning()) actions['aim_down']!.play();
          }
          if (!actions['armed_idle']!.isRunning()) actions['armed_idle']!.play();
          actions['armed_idle']!.setEffectiveWeight(aimWeight);
        } else {
          actions['aim_neutral']?.setEffectiveWeight(0);
          actions['aim_up']?.setEffectiveWeight(0);
          actions['aim_down']?.setEffectiveWeight(0);
          actions['armed_idle']?.setEffectiveWeight(0);
        }

        mixer.update(animDt);

        // Smooth whole-body anticipation: sprint/dash leans into travel while
        // lateral acceleration produces only a restrained counter-lean. This
        // sits below the authored clips, so feet and weapon posing stay intact.
        const fwdX = -Math.sin(a.yaw), fwdZ = -Math.cos(a.yaw);
        const rightX = Math.cos(a.yaw), rightZ = -Math.sin(a.yaw);
        const localForward = a.body.velocity.x * fwdX + a.body.velocity.z * fwdZ;
        const localSide = a.body.velocity.x * rightX + a.body.velocity.z * rightZ;
        const targetForwardLean = dashing
          ? 0.22
          : THREE.MathUtils.clamp((Math.abs(localForward) - 5.5) * 0.018, 0, 0.095);
        const targetSideLean = THREE.MathUtils.clamp(-localSide / 90, -0.085, 0.085);
        forwardLean += (targetForwardLean - forwardLean) * Math.min(1, dt * 9);
        sideLean += (targetSideLean - sideLean) * Math.min(1, dt * 10);
        body.rotation.set(
          bodyBaseRotation.x - forwardLean,
          bodyBaseRotation.y,
          bodyBaseRotation.z + sideLean,
        );

        // Trained freefall pose (presentation-only; collider unchanged).
        freefallBlend += ((a.state === 'freefall' ? 1 : 0) - freefallBlend)
          * Math.min(1, dt * FREEFALL_BLEND_RATE);
        if (freefallBlend > 0.001) {
          body.updateMatrixWorld(true);
          applyFreefallPose(freefallBlend);
        }
      },
      updateView(a: ActorView, _t: number, dt: number) {
        rig.group.position.set(a.position.x, feetYFromView(a.position.y), a.position.z);
        rig.group.rotation.y = a.yaw + Math.PI;
        if (!a.alive) {
          const death = actions['death'];
          if (death && !death.isRunning() && rig.dissolving === 0) {
            crossfade(currentBase, 'death', 0.12);
            death.setLoop(LoopOnce, 1);
            death.clampWhenFinished = true;
          }
          mixer.update(dt);
          return;
        }
        const speedH = Math.hypot(a.velocity.x, a.velocity.z);
        const want = a.moveState === 'swim'
          ? (speedH > 1 ? 'swim' : 'swim_idle')
          : a.moveState === 'slide' || a.moveState === 'mantle'
            ? 'roll'
            : a.moveState === 'freefall' || a.moveState === 'glide'
              ? 'jump_loop'
              : !a.grounded
                ? 'jump_loop'
                : a.crouched
                  ? (speedH > 0.6 ? 'crouch_walk' : 'crouch_idle')
                  : speedH < 0.6 ? 'idle' : speedH < 3.2 ? 'walk' : speedH < 8.6 ? 'jog' : 'sprint';
        if (want !== currentBase) {
          crossfade(currentBase, want);
          currentBase = want;
        }
        rig.animName = a.moveState === 'freefall' ? 'freefall' : want;
        const action = actions[want];
        if (action) action.timeScale = locomotionTimeScale(want, speedH);
        if (fadingFrom && (fadingTimer -= dt) <= 0) {
          fadingFrom.stop();
          fadingFrom.setEffectiveWeight(0);
          fadingFrom = null;
        }
        mixer.update(dt);

        // Same broad skydive presentation as the host path: the networked
        // moveState carries freefall, so replicas blend the pose identically.
        freefallBlend += ((a.moveState === 'freefall' ? 1 : 0) - freefallBlend)
          * Math.min(1, dt * FREEFALL_BLEND_RATE);
        if (freefallBlend > 0.001) {
          body.updateMatrixWorld(true);
          applyFreefallPose(freefallBlend);
        }
      },
      attachWeapon(model: THREE.Object3D | null) {
        if (!weaponHolder) return;
        for (const c of [...weaponHolder.children]) weaponHolder.remove(c);
        if (model) {
          model.position.set(0.02, 0.12, -0.02);
          weaponHolder.add(model);
        }
      },
      muzzleWorld(position: THREE.Vector3, direction: THREE.Vector3) {
        if (!weaponHolder) return false;
        const muzzle = weaponHolder.getObjectByName('muzzle');
        if (!muzzle) return false;
        // Animation bones and the weapon mount both move every presentation
        // frame, so derive the flash from the rendered rig rather than the
        // actor eye/capsule approximation used by simulation.
        group.updateWorldMatrix(true, true);
        muzzle.getWorldPosition(position);
        direction.set(0, 0, -1).transformDirection(muzzle.matrixWorld).normalize();
        return true;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        const registryIndex = liveRigs.indexOf(registryEntry);
        if (registryIndex >= 0) liveRigs.splice(registryIndex, 1);
        rig.attachWeapon?.(null);
        mixer.stopAllAction();
        mixer.uncacheRoot(body);
        for (const material of new Set<THREE.Material>([...baseMats, ...accents])) material.dispose();
        const ownedGeometry = new Set<THREE.BufferGeometry>();
        group.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.geometry && !sharedBodyGeometry.has(mesh.geometry)) {
            ownedGeometry.add(mesh.geometry);
          }
        });
        for (const geometry of ownedGeometry) geometry.dispose();
        group.removeFromParent();
      },
    };
    return rig;
  }
}

function preparePrototype(src: THREE.Group): THREE.Group {
  // Keep the loader-owned scene pristine; per-actor copies are made with
  // SkeletonUtils.clone which correctly rebuilds skin<->bone relationships.
  return src;
}

function collectBones(root: THREE.Object3D): Record<string, THREE.Object3D> {
  const out: Record<string, THREE.Object3D> = {};
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone || o.type === 'Bone') {
      out[o.name] = o;
    }
  });
  return out;
}

/** Elimination presentation: death clip settles then the body dematerializes. */
export function updateEliminationFx(rig: CharacterRig, dt: number): void {
  rig.dissolving += dt * 0.9;
  const k = Math.min(1, Math.max(0, rig.dissolving - 0.9) / 1.6);
  if (k > 0) {
    rig.group.position.y -= dt * 0.5 * k;
    rig.group.rotation.y += dt * 1.1 * k;
    rig.group.scale.setScalar(Math.max(0.001, 1 - k));
    for (const m of [...rig.accentMats, ...rig.baseMats]) {
      if (!m.transparent) {
        m.transparent = true;
        m.needsUpdate = true;
      }
      m.opacity = 1 - k;
      m.emissiveIntensity *= 1 - dt * 0.8;
    }
  }
  if (k >= 1) rig.group.visible = false;
}

// ---------------------------------------------------------------------------
// Legacy capsule fallback (used if GLB assets fail to load)
// ---------------------------------------------------------------------------

function fallbackRig(
  group: THREE.Group,
  accentColor: number,
  accents: THREE.MeshStandardMaterial[],
  baseMats: THREE.MeshStandardMaterial[],
  name: string,
  skin: SkinSpec,
): CharacterRig {
  // Keep the failure state useful in gameplay. An empty Group is especially
  // damaging in TPS because it makes the player appear to vanish entirely.
  const suitColor = new THREE.Color(name === 'YOU' ? 0x2e3a44 : skin.primary).getHex();
  const darkMat = new THREE.MeshStandardMaterial({ color: suitColor, roughness: 0.62, metalness: 0.25 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x15171a,
    emissive: new THREE.Color(skin.accent).lerp(new THREE.Color(accentColor), 0.2),
    emissiveIntensity: 0.85, roughness: 0.45, metalness: 0.35,
  });
  accents.push(accentMat);
  baseMats.push(darkMat);
  const hips = new THREE.Group();
  // Author the emergency rig in the same feet-origin space as the GLB rigs.
  // The old capsule centres left the soles 0.2u above ground and separated
  // the legs from the torso.
  hips.position.y = 0.67;
  const torso = new THREE.Group();
  torso.position.y = 0.38;
  hips.add(torso);
  const add = (geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial, parent: THREE.Object3D, position: [number, number, number]): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(0.42, 0.62, 0.26), darkMat, torso, [0, 0, 0]);
  add(new THREE.BoxGeometry(0.34, 0.18, 0.24), darkMat, hips, [0, 0, 0]);
  add(new THREE.CylinderGeometry(0.07, 0.075, 0.16, 10), darkMat, torso, [0, 0.37, 0]);
  add(new THREE.SphereGeometry(0.19, 12, 8), darkMat, torso, [0, 0.61, 0]);
  add(new THREE.BoxGeometry(0.48, 0.075, 0.29), accentMat, torso, [0, 0.09, 0.145]);
  add(new THREE.CapsuleGeometry(0.075, 0.45, 6, 10), darkMat, hips, [-0.14, -0.37, 0]);
  add(new THREE.CapsuleGeometry(0.075, 0.45, 6, 10), darkMat, hips, [0.14, -0.37, 0]);
  add(new THREE.CapsuleGeometry(0.06, 0.48, 6, 10), darkMat, torso, [-0.29, 0, 0]);
  add(new THREE.CapsuleGeometry(0.06, 0.48, 6, 10), darkMat, torso, [0.29, 0, 0]);
  add(new THREE.BoxGeometry(0.24, 0.3, 0.11), darkMat, torso, [0, 0.02, -0.18]);
  group.add(hips);
  const rig: CharacterRig = {
    group,
    animName: 'idle',
    hips, torso,
    accentMats: accents,
    baseMats: baseMats,
    dissolving: 0,
    update(a: Actor) {
      group.rotation.y = a.yaw + Math.PI;
    },
    updateView(a: ActorView) {
      group.position.set(a.position.x, feetYFromView(a.position.y), a.position.z);
      group.rotation.y = a.yaw + Math.PI;
    },
    dispose() {
      for (const material of new Set<THREE.Material>([...baseMats, ...accents])) material.dispose();
      const geometry = new Set<THREE.BufferGeometry>();
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) geometry.add(mesh.geometry);
      });
      for (const item of geometry) item.dispose();
      group.removeFromParent();
    },
  };
  return rig;
}
