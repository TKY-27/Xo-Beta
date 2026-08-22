/**
 * Procedural combatant characters. Each actor gets a rigged group built from
 * primitives with a distinct silhouette per identity (helmets, pads,
 * proportions, accents) plus a procedural animation state machine
 * (locomotion, crouch, slide, wall-run tilt, air control, swim, heal,
 * elimination dissolve).
 */

import * as THREE from 'three';
import type { Actor } from '../sim/actor';

export interface CharacterRig {
  group: THREE.Group;
  hips: THREE.Object3D;
  torso: THREE.Object3D;
  head: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  weaponMount: THREE.Object3D;
  accentMats: THREE.MeshStandardMaterial[];
  baseMats: THREE.MeshStandardMaterial[];
  /** Elimination effect state */
  dissolving: number;
}

function limb(len: number, thick: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.CapsuleGeometry(thick, len - thick * 2, 4, 8);
  const m = new THREE.Mesh(geo, mat);
  m.geometry.translate(0, -len / 2, 0);
  m.castShadow = true;
  return m;
}

export function createCharacter(name: string, accentColor: number, isPlayer: boolean): CharacterRig {
  const group = new THREE.Group();

  const suitColor = name === 'YOU' ? 0x2e3a44 : 0x33383f;
  const darkMat = new THREE.MeshStandardMaterial({ color: suitColor, roughness: 0.62, metalness: 0.25 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x15171a, emissive: accentColor, emissiveIntensity: isPlayer ? 0.85 : 0.65, roughness: 0.45, metalness: 0.35,
  });
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x0a0d10, emissive: accentColor, emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.5,
  });

  const hips = new THREE.Group();
  hips.position.y = 1.02;

  // Pelvis
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.22, 0.28), darkMat);
  hips.add(pelvis);

  // Torso
  const torso = new THREE.Group();
  torso.position.y = 0.12;
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.52, 0.32), darkMat);
  chest.position.y = 0.26;
  chest.castShadow = true;
  torso.add(chest);
  // Chest core light
  const core = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.05), accentMat);
  core.position.set(0, 0.3, 0.17);
  torso.add(core);
  // Shoulders vary by identity hash
  let seed = 0;
  for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) | 0;
  const padScale = 1 + (((seed >>> 3) % 5) * 0.09);
  const shoulderGeo = new THREE.SphereGeometry(0.15 * padScale, 8, 6);
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(shoulderGeo, darkMat);
    pad.position.set(side * 0.31, 0.42, 0);
    torso.add(pad);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.06), accentMat);
    stripe.position.set(side * 0.33, 0.42, 0);
    torso.add(stripe);
  }

  // Head + helmet variants
  const head = new THREE.Group();
  head.position.y = 0.66;
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.27), darkMat);
  head.add(skull);
  const helmetKind = ((seed >>> 5) % 4);
  if (helmetKind === 0) {
    // Full visor
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.09, 0.04), visorMat);
    visor.position.set(0, 0.02, 0.145);
    head.add(visor);
    const crest = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.24), accentMat);
    crest.position.set(0, 0.17, 0);
    head.add(crest);
  } else if (helmetKind === 1) {
    // Round dome + single eye strip
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), darkMat);
    dome.position.y = 0.06;
    head.add(dome);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.03), visorMat);
    eye.position.set(0, 0.06, 0.155);
    head.add(eye);
  } else if (helmetKind === 2) {
    // Angular hood w/ antenna
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.24, 4), darkMat);
    hood.position.y = 0.16;
    hood.rotation.y = Math.PI / 4;
    head.add(hood);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 4), accentMat);
    ant.position.set(0.11, 0.24, -0.05);
    ant.rotation.z = -0.25;
    head.add(ant);
  } else {
    // Split visor mask
    const mask = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.13, 0.06), visorMat);
    mask.position.set(0, 0.03, 0.13);
    head.add(mask);
    const topPlate = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.08, 0.29), accentMat);
    topPlate.position.y = 0.16;
    head.add(topPlate);
  }

  // Arms (upper pivot at shoulder)
  const armL = new THREE.Group();
  armL.position.set(-0.34, 0.42, 0);
  const armLUpper = limb(0.34, 0.07, darkMat);
  armL.add(armLUpper);
  const armLLowerPivot = new THREE.Group();
  armLLowerPivot.position.y = -0.34;
  const armLLower = limb(0.32, 0.06, darkMat);
  armLLower.add((() => { const h = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), accentMat); h.position.y = -0.32; return h; })());
  armLLowerPivot.add(armLLower);
  armL.add(armLLowerPivot);
  armL.userData.lower = armLLowerPivot;

  const armR = new THREE.Group();
  armR.position.set(0.34, 0.42, 0);
  const armRUpper = limb(0.34, 0.07, darkMat);
  armR.add(armRUpper);
  const armRLowerPivot = new THREE.Group();
  armRLowerPivot.position.y = -0.34;
  const armRLower = limb(0.32, 0.06, darkMat);
  armRLower.add((() => { const h = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), accentMat); h.position.y = -0.32; return h; })());
  armRLowerPivot.add(armRLower);
  armR.add(armRLowerPivot);
  armR.userData.lower = armRLowerPivot;

  // Legs
  const mkLeg = (side: number): THREE.Group => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.15, -0.08, 0);
    const upper = limb(0.46, 0.085, darkMat);
    leg.add(upper);
    const lowerPivot = new THREE.Group();
    lowerPivot.position.y = -0.46;
    const lower = limb(0.44, 0.07, darkMat);
    lower.add((() => { const f = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.24), accentMat); f.position.set(0, -0.44, 0.05); return f; })());
    lowerPivot.add(lower);
    leg.add(lowerPivot);
    leg.userData.lower = lowerPivot;
    return leg;
  };
  const legL = mkLeg(-1);
  const legR = mkLeg(1);

  // Weapon mount on right hand
  const weaponMount = new THREE.Group();
  weaponMount.position.set(0, -0.64, 0.02);
  armR.userData.lower.add(weaponMount);

  torso.add(head, armL, armR);
  hips.add(torso, legL, legR);
  group.add(hips);

  return {
    group, hips, torso, head, armL, armR, legL, legR, weaponMount,
    accentMats: [accentMat, visorMat],
    baseMats: [darkMat],
    dissolving: 0,
  };
}

const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

function setRot(obj: THREE.Object3D, x: number, y: number, z: number): void {
  tmpE.set(x, y, z);
  tmpQ.setFromEuler(tmpE);
  obj.quaternion.slerp(tmpQ, 0.35);
}
function setRotHard(obj: THREE.Object3D, x: number, y: number, z: number): void {
  tmpE.set(x, y, z);
  tmpQ.setFromEuler(tmpE);
  obj.quaternion.copy(tmpQ);
}

/**
 * Drive the rig from simulation state. Called every rendered frame.
 * phase: global time; moveSpeed: horizontal speed.
 */
export function animateCharacter(rig: CharacterRig, actor: Actor, t: number, dt: number): void {
  if (!actor.alive) {
    updateDissolve(rig, dt);
    return;
  }
  rig.group.visible = true;
  const speedH = Math.hypot(actor.body.velocity.x, actor.body.velocity.z);
  const moving = speedH > 0.6;
  const runPhase = t * Math.min(speedH * 1.35, 12);

  // Default locomotion pose
  let hipY = 1.02;
  let hipPitch = 0;
  let torsoPitch = 0;
  let torsoRoll = 0;
  const legSwing = moving ? Math.sin(runPhase) * Math.min(0.85, speedH * 0.09) : 0;
  const armSwing = moving ? -Math.sin(runPhase) * Math.min(0.55, speedH * 0.055) : 0;

  setRot(rig.legL, legSwing, 0, 0);
  setRot(rig.legR, -legSwing, 0, 0);
  (rig.legL.userData.lower as THREE.Object3D).rotation.x = Math.max(0, -legSwing * 1.2);
  (rig.legR.userData.lower as THREE.Object3D).rotation.x = Math.max(0, legSwing * 1.2);

  // Aim influence on torso/arms
  const pitchAim = actor.pitch;
  const yawDiff = shortestAngle(actor.yaw, rig.group.rotation.y);
  rig.group.rotation.y += yawDiff * Math.min(1, dt * 14);

  switch (actor.state) {
    case 'slide': {
      hipY = 0.62;
      hipPitch = -0.9;
      torsoPitch = 0.45;
      setRot(rig.legL, 1.15, 0, 0);
      setRot(rig.legR, 0.35, 0, 0);
      break;
    }
    case 'wallrun': {
      hipY = 1.0;
      torsoRoll = actor.wallSide * 0.5;
      setRot(rig.legL, 0.9, 0, 0);
      setRot(rig.legR, -0.5, 0, 0);
      break;
    }
    case 'mantle': {
      hipY = 1.06;
      setRot(rig.legL, -0.7, 0, 0);
      setRot(rig.legR, -0.5, 0, 0);
      setRot(rig.armL, -2.4, 0, 0);
      setRot(rig.armR, -2.4, 0, 0);
      break;
    }
    case 'swim': {
      hipY = 0.95;
      torsoPitch = 1.2;
      const paddle = Math.sin(t * 6);
      setRot(rig.armL, -1.6 + paddle * 0.7, 0, 0.3);
      setRot(rig.armR, -1.6 - paddle * 0.7, 0, -0.3);
      setRot(rig.legL, paddle * 0.5, 0, 0);
      setRot(rig.legR, -paddle * 0.5, 0, 0);
      break;
    }
    case 'freefall': {
      hipY = 1.0;
      torsoPitch = -0.6 - Math.min(0.5, speedH * 0.01);
      setRot(rig.armL, -2.6, 0, 0.9);
      setRot(rig.armR, -2.6, 0, -0.9);
      setRot(rig.legL, 0.4, 0, 0.15);
      setRot(rig.legR, -0.3, 0, -0.15);
      break;
    }
    case 'glide': {
      hipY = 1.0;
      torsoPitch = 0.25;
      setRot(rig.armL, -0.6, 0, 1.25);
      setRot(rig.armR, -0.6, 0, -1.25);
      setRot(rig.legL, 0.25, 0, 0.08);
      setRot(rig.legR, -0.2, 0, -0.08);
      break;
    }
    case 'poundFall':
    case 'poundWindup': {
      hipY = 1.0;
      torsoPitch = 0.5;
      setRot(rig.armL, -2.9, 0, 0.4);
      setRot(rig.armR, -2.9, 0, -0.4);
      setRot(rig.legL, 0.5, 0, 0);
      setRot(rig.legR, 0.5, 0, 0);
      break;
    }
    default: {
      if (!actor.body.grounded && actor.state === 'air') {
        setRot(rig.legL, 0.55, 0, 0.1);
        setRot(rig.legR, -0.35, 0, -0.1);
        setRot(rig.armL, -0.7 + armSwing, 0, 0.25);
        setRot(rig.armR, -0.7 - armSwing, 0, -0.25);
      } else if (actor.crouched) {
        hipY = 0.68;
        setRot(rig.legL, 1.15, 0, 0.12);
        setRot(rig.legR, -0.5, 0, -0.12);
        (rig.legL.userData.lower as THREE.Object3D).rotation.x = -1.4;
        (rig.legR.userData.lower as THREE.Object3D).rotation.x = 0.9;
      } else {
        setRot(rig.armL, armSwing - 0.35, 0, 0.18);
        setRot(rig.armR, -armSwing - 0.9, 0, -0.12);
        if (moving) hipY += Math.abs(Math.sin(runPhase)) * 0.045;
      }
    }
  }

  // Weapon hold overrides right arm when armed
  const hasWeapon = actor.inv.selectedWeapon !== null;
  if (hasWeapon && actor.state !== 'mantle' && actor.state !== 'swim' &&
      actor.state !== 'freefall' && actor.state !== 'glide' && !actor.healing) {
    const ads = actor.wpn.adsAmount;
    setRot(rig.armR, -1.45 - ads * 0.25 + pitchAim * 0.8, 0, -0.28);
    (rig.armR.userData.lower as THREE.Object3D).rotation.x = -0.5 - ads * 0.35;
    setRot(rig.armL, -1.25 + pitchAim * 0.8, 0.5, 0.45);
    (rig.armL.userData.lower as THREE.Object3D).rotation.x = -0.9;
  }

  // Healing pose: left hand to chest device
  if (actor.healing) {
    setRot(rig.armL, -2.1, 0.2, 0.3);
    torsoPitch += Math.sin(t * 3) * 0.02;
  }

  setRot(rig.hips, hipPitch, 0, 0);
  rig.hips.position.y += (hipY - rig.hips.position.y) * Math.min(1, dt * 12);
  setRot(rig.torso, torsoPitch, 0, torsoRoll);
  setRot(rig.head, -pitchAim * 0.55, 0, 0);
}

function updateDissolve(rig: CharacterRig, dt: number): void {
  rig.dissolving += dt * 1.4;
  const k = Math.min(1, rig.dissolving);
  rig.group.position.y -= dt * 0.4 * k;
  rig.group.rotation.y += dt * 1.2 * k;
  rig.group.scale.setScalar(Math.max(0.001, 1 - k));
  for (const m of [...rig.accentMats, ...rig.baseMats]) {
    m.transparent = true;
    m.opacity = 1 - k;
    m.emissiveIntensity *= 1 - dt * 0.8;
  }
  if (k >= 1) rig.group.visible = false;
}

/** Reset the dissolve so rigs can be reused across matches. */
export function resetCharacter(rig: CharacterRig): void {
  rig.dissolving = 0;
  rig.group.scale.setScalar(1);
  rig.group.visible = true;
  for (const m of [...rig.accentMats, ...rig.baseMats]) {
    m.transparent = false;
    m.opacity = 1;
  }
}

function shortestAngle(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
