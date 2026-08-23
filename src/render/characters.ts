/**
 * Combatant presentation v2: skinned GLB characters (CC0 Quaternius Universal
 * Base Characters) driven by the Universal Animation Library (43 clips),
 * with procedural costume attachments per identity (helmets, armor,
 * pauldrons, backpacks) and weapon attachment to the right-hand bone.
 * Falls back to legacy capsule rig if assets fail.
 */

import * as THREE from 'three';
import { AnimationAction, AnimationMixer, LoopRepeat, LoopOnce } from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Actor } from '../sim/actor';

export interface CharacterRig {
  group: THREE.Group;
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
  attachWeapon?(model: THREE.Object3D | null): void;
}

interface AnimSet {
  [key: string]: THREE.AnimationClip;
}

const CLIP_MAP: Array<[string, string]> = [
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
  ['death', 'Death01'],
  ['interact', 'Interact'],
];

const TARGET_HEIGHT = 1.86;

export class CharacterFactory {
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
   * Build a rig for an actor. `identitySeed` varies costume pieces;
   * accentColor drives emissive trims; `female` picks the body.
   */
  create(name: string, accentColor: number, female: boolean, weaponModel: THREE.Object3D | null = null): CharacterRig {
    const proto = female ? this.protoFemale : this.protoMale;
    const s = female ? this.scaleF : this.scaleM;

    // Deterministic identity variation
    let seed = 0;
    for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) | 0;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0x7fffffff) / 0x7fffffff;
    };

    const group = new THREE.Group();
    const accents: THREE.MeshStandardMaterial[] = [];
    const baseMats: THREE.MeshStandardMaterial[] = [];

    if (!this.ready || !proto || !Object.keys(this.anims).length) {
      return fallbackRig(group, accentColor, accents, baseMats, name);
    }

    const body = SkeletonUtils.clone(proto) as THREE.Group;
    body.scale.setScalar(s);
    group.add(body);

    // Suit recolor: find materials and tint toward identity palette.
    const suitColor = new THREE.Color(accentColor);
    const darkSuit = suitColor.clone().multiplyScalar(0.35).lerp(new THREE.Color(0x22262c), 0.55);
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
          nm.color = darkSuit.clone().lerp(suitColor, 0.22);
          nm.metalness = Math.min(0.65, nm.metalness + 0.25);
          nm.roughness = Math.max(0.42, nm.roughness * 0.85);
          baseMats.push(nm);
        } else if (/hair|Hair/i.test(nm.name ?? '')) {
          baseMats.push(nm);
        }
        return nm;
      });
      mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    });

    // ---- Costume attachments -------------------------------------------
    const bones = collectBones(body);
    const costumeMat = new THREE.MeshStandardMaterial({
      color: 0x262b33, roughness: 0.52, metalness: 0.45,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x111318, emissive: trimColor, emissiveIntensity: 1.15, roughness: 0.38, metalness: 0.5,
    });
    accents.push(trimMat);
    baseMats.push(costumeMat);

    const helmetKind = Math.floor(rnd() * 4);
    const armorHeavy = rnd() < 0.45;
    const hasPack = rnd() < 0.5;

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
        plate.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.frustumCulled = false; });
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
        pad.frustumCulled = false;
      }
    }

    if (hasPack && bones['spine_01']) {
      const pack = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.3, 0.11), costumeMat);
      pack.position.set(0, 0.02, -0.12);
      const cell = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.02), trimMat);
      cell.position.set(0.06, 0, -0.062);
      pack.add(cell);
      bones['spine_01'].add(pack);
      pack.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.frustumCulled = false; });
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

    // ---- Animation state machine ---------------------------------------
    const mixer = new AnimationMixer(body);
    const actions: Record<string, AnimationAction> = {};
    for (const k of Object.keys(this.anims)) {
      const a = mixer.clipAction(this.anims[k]!);
      a.enabled = true;
      a.setEffectiveWeight(0);
      actions[k] = a;
    }
    const looped = new Set(['idle', 'walk', 'jog', 'sprint', 'crouch_idle', 'crouch_walk', 'swim', 'swim_idle', 'jump_loop', 'armed_idle']);
    for (const k of looped) if (actions[k]) actions[k]!.play();

    let currentBase = '';
    let aimWeight = 0;

    function crossfade(from: string, to: string, dur = 0.16): void {
      const a = actions[to], b = actions[from];
      if (!a || from === to) return;
      a.reset();
      a.setEffectiveWeight(1);
      a.play();
      if (b) b.crossFadeTo(a, dur, false);
    }

    const rig: CharacterRig = {
      group,
      accentMats: accents,
      baseMats: baseMats,
      dissolving: 0,
      update(a: Actor, t: number, dt: number) {
        if (!a.alive) {
          // death clip once, then dissolve handled externally
          if (!actions['death']!.isRunning() && rig.dissolving === 0) {
            crossfade(currentBase, 'death', 0.12);
            actions['death']!.setLoop(LoopOnce, 1);
            actions['death']!.clampWhenFinished = true;
          }
          mixer.update(dt);
          return;
        }
        const speedH = Math.hypot(a.body.velocity.x, a.body.velocity.z);

        let want: string;
        switch (a.state) {
          case 'slide': want = 'roll'; break;
          case 'mantle': want = 'roll'; break;
          case 'wallrun': want = 'sprint'; break;
          case 'freefall': want = speedH > 20 ? 'sprint' : 'jump_loop'; break;
          case 'glide': want = 'jump_loop'; break;
          case 'swim': want = speedH > 1 ? 'swim' : 'swim_idle'; break;
          default:
            if (!a.body.grounded) want = a.wpn.lastShotTime >= 0 && speedH > 2 ? 'jump_loop' : 'jump_loop';
            else if (a.crouched) want = speedH > 0.6 ? 'crouch_walk' : 'crouch_idle';
            else if (speedH < 0.6) want = 'idle';
            else if (speedH < 6.2) want = 'walk';
            else if (speedH < 9.2) want = 'jog';
            else want = 'sprint';
        }
        if (want !== currentBase) {
          crossfade(currentBase, want);
          currentBase = want;
        }
        // Time-warp locomotion to actual speed so footfalls match ground speed
        const baseSpeeds: Record<string, number> = {
          walk: 1.55, jog: 4.4, sprint: 7.0, crouch_walk: 1.5,
        };
        const act = actions[want];
        if (!act) return;
        if (baseSpeeds[want]) {
          act.timeScale = THREE.MathUtils.clamp(speedH / baseSpeeds[want]!, 0.55, 1.9);
        } else {
          act.timeScale = 1;
        }

        // Upper-body aim layer while holding a weapon
        const armed = !!weaponHolder?.children.length &&
          a.state !== 'mantle' && a.state !== 'swim' && !a.crouched;
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
            actions['aim_neutral']!.weight !== undefined; // keep playing
            actions['aim_neutral']!.play();
            actions['aim_up']!.play();
            actions['aim_down']!.play();
          }
          actions['armed_idle']!.play();
          actions['armed_idle']!.setEffectiveWeight(aimWeight);
        } else {
          actions['aim_neutral']?.setEffectiveWeight(0);
          actions['aim_up']?.setEffectiveWeight(0);
          actions['aim_down']?.setEffectiveWeight(0);
          actions['armed_idle']?.setEffectiveWeight(0);
        }

        mixer.update(dt);
      },
      attachWeapon(model: THREE.Object3D | null) {
        if (!weaponHolder) return;
        for (const c of [...weaponHolder.children]) weaponHolder.remove(c);
        if (model) {
          model.position.set(0.02, 0.12, -0.02);
          weaponHolder.add(model);
        }
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
      m.transparent = true;
      m.opacity = 1 - k;
      m.emissiveIntensity *= 1 - dt * 0.8;
    }
  }
  if (k >= 1) rig.group.visible = false;
}

// ---------------------------------------------------------------------------
// Legacy capsule fallback (used if GLB assets fail to load)
// ---------------------------------------------------------------------------

function limb(len: number, thick: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.CapsuleGeometry(thick, len - thick * 2, 4, 8);
  const m = new THREE.Mesh(geo, mat);
  m.geometry.translate(0, -len / 2, 0);
  m.castShadow = true;
  return m;
}

function fallbackRig(
  group: THREE.Group,
  accentColor: number,
  accents: THREE.MeshStandardMaterial[],
  baseMats: THREE.MeshStandardMaterial[],
  name: string,
): CharacterRig {
  const suitColor = name === 'YOU' ? 0x2e3a44 : 0x33383f;
  const darkMat = new THREE.MeshStandardMaterial({ color: suitColor, roughness: 0.62, metalness: 0.25 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x15171a, emissive: accentColor, emissiveIntensity: 0.85, roughness: 0.45, metalness: 0.35,
  });
  accents.push(accentMat);
  baseMats.push(darkMat);
  const hips = new THREE.Group();
  hips.position.y = 1.02;
  const torso = new THREE.Group();
  torso.position.y = 0.12;
  hips.add(torso);
  group.add(hips);
  const rig: CharacterRig = {
    group,
    hips, torso,
    accentMats: accents,
    baseMats: baseMats,
    dissolving: 0,
  };
  return rig;
}
