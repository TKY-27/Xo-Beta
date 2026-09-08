/**
 * Procedural firearm geometry: builds the five weapon classes from real
 * small-arm anatomy — upper/lower receivers, barrel + muzzle device, vented
 * handguard, pistol grip, shoulder stock, iron sights, magazine, charging
 * handle, trigger group — using chamfered primitives and layered gun
 * materials (blued steel, anodized aluminum, polymer, rubber). Weapons point
 * down -Z with +Y up; canonical lengths match the balance tables.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Rarity, WeaponId } from '../core/balance';

export interface GunMaterials {
  /** Blued steel: barrels, bolts, slides. */
  steel: THREE.MeshStandardMaterial;
  /** Anodized aluminum: receivers, handguards, rails. */
  aluminum: THREE.MeshStandardMaterial;
  /** Injection-molded polymer: grips, stocks, furniture. */
  polymer: THREE.MeshStandardMaterial;
  /** Rubber: buttpads, grip panels. */
  rubber: THREE.MeshStandardMaterial;
  /** Bright steel: pins, small hardware. */
  hardware: THREE.MeshStandardMaterial;
}

/**
 * CYCLE 32 — procedural weapon PBR detail. Flat-shaded gun materials read as
 * clay toys at viewmodel range (the reference footage carries visible brush
 * grain, machining marks and grip stipple). One shared 256px canvas per map
 * type; textures tile over the primitive UVs.
 */

let brushedRough: THREE.CanvasTexture | null = null;
let stippleBump: THREE.CanvasTexture | null = null;

/** Horizontal brush grain + random machining scratches as a roughness map. */
function getBrushedRoughness(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (brushedRough) return brushedRough;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#8c8c8c';
  ctx.fillRect(0, 0, size, size);
  // Brush streaks: faint horizontal value lines.
  for (let i = 0; i < 460; i++) {
    const y = Math.random() * size;
    const v = 120 + Math.floor(Math.random() * 70);
    ctx.strokeStyle = `rgba(${v},${v},${v},0.35)`;
    ctx.lineWidth = 0.6 + Math.random() * 1.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 3);
    ctx.stroke();
  }
  // Machining scratches: short diagonal bright/dark nicks.
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 3 + Math.random() * 16;
    const bright = Math.random() > 0.5;
    ctx.strokeStyle = bright ? 'rgba(230,230,230,0.5)' : 'rgba(40,40,40,0.45)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (Math.random() - 0.5) * 6);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.colorSpace = THREE.NoColorSpace;
  brushedRough = tex;
  return tex;
}

/** Polymer stipple: staggered dot grid as a bump map (grip texture). */
function getStippleBump(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (stippleBump) return stippleBump;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  const step = 9;
  for (let row = 0; row * step < size; row++) {
    for (let col = 0; col * step < size; col++) {
      const x = col * step + (row % 2 ? step / 2 : 0);
      const y = row * step;
      const grad = ctx.createRadialGradient(x, y, 0.5, x, y, 3.4);
      grad.addColorStop(0, 'rgba(230,230,230,0.9)');
      grad.addColorStop(1, 'rgba(128,128,128,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.NoColorSpace;
  stippleBump = tex;
  return tex;
}

/**
 * Rarity skin panel graphic. A per-tier pattern drawn over a gunmetal base,
 * tinted toward the rarity colour — the reference footage carries full-body
 * weapon skins; flat single-colour receivers read as toys. One canvas per
 * rarity, shared by every weapon class.
 */
export function makeSkinTexture(rarity: Rarity, tint: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // Gunmetal base with a faint vertical brushed gradient.
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#4c5157');
  grad.addColorStop(0.5, '#41464c');
  grad.addColorStop(1, '#363b41');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 90; i++) {
    const y = Math.random() * size;
    ctx.strokeStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = tint;
  ctx.fillStyle = tint;
  switch (rarity) {
    case 'uncommon': // diagonal service stripes
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 9;
      for (let i = -1; i < 6; i++) {
        ctx.beginPath();
        ctx.moveTo(-20, i * 48);
        ctx.lineTo(size + 20, i * 48 + 34);
        ctx.stroke();
      }
      break;
    case 'rare': // circuit traces
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 3;
      for (let i = 0; i < 5; i++) {
        const y = 28 + i * 48;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(70 + (i % 2) * 40, y);
        ctx.lineTo(110 + (i % 2) * 40, y - 22);
        ctx.lineTo(size, y - 22);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(70 + (i % 2) * 40, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'epic': // geometric shards
      ctx.globalAlpha = 0.34;
      for (let i = 0; i < 9; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const w = 30 + Math.random() * 60;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y - w * 0.32);
        ctx.lineTo(x + w * 1.2, y + w * 0.3);
        ctx.closePath();
        ctx.fill();
      }
      break;
    case 'legendary': // ornate filigree + crown band
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 4;
      for (let i = 0; i < 4; i++) {
        const y = 32 + i * 64;
        ctx.beginPath();
        for (let x = 0; x <= size; x += 8) {
          ctx.lineTo(x, y + Math.sin(x * 0.09 + i) * 12);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 0.3;
      ctx.fillRect(0, size * 0.42, size, 14);
      break;
    default: // common: plain gunmetal, no graphic
      ctx.globalAlpha = 0;
      break;
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function makeGunMaterials(): GunMaterials {
  // CYCLE 32: brightened one step so silhouette shapes read at gameplay
  // range, plus shared PBR detail maps (brush grain, grip stipple).
  const rough = getBrushedRoughness();
  const stipple = getStippleBump();
  const steel = new THREE.MeshStandardMaterial({ color: 0x495057, roughness: 0.34, metalness: 0.9 });
  steel.roughnessMap = rough;
  steel.name = 'steel';
  const aluminum = new THREE.MeshStandardMaterial({ color: 0x575e66, roughness: 0.52, metalness: 0.78 });
  aluminum.roughnessMap = rough;
  aluminum.name = 'aluminum';
  const polymer = new THREE.MeshStandardMaterial({ color: 0x3d4147, roughness: 0.8, metalness: 0.06 });
  polymer.normalMap = stipple;
  polymer.normalScale.set(0.35, 0.35);
  polymer.name = 'polymer';
  const rubber = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.94, metalness: 0.02 });
  rubber.normalMap = stipple;
  rubber.normalScale.set(0.5, 0.5);
  rubber.name = 'rubber';
  const hardware = new THREE.MeshStandardMaterial({ color: 0x666d75, roughness: 0.3, metalness: 0.92 });
  hardware.name = 'hardware';
  return { steel, aluminum, polymer, rubber, hardware };
}

/** Shared helper: chamfered box at a pose. */
function box(
  parent: THREE.Object3D,
  mat: THREE.Material,
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
  radius = 0.006,
): THREE.Mesh {
  const r = Math.min(radius, w / 2.2, h / 2.2, d / 2.2);
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.max(0.0008, r)), mat);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function cyl(
  parent: THREE.Object3D,
  mat: THREE.Material,
  radiusTop: number,
  radiusBottom: number,
  length: number,
  x: number,
  y: number,
  z: number,
  segments = 20,
): THREE.Mesh {
  // CylinderGeometry's axis is +Y; rotate so length runs down -Z.
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments), mat);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

/** Ring (torus) around -Z axis at a pose. */
function ring(parent: THREE.Object3D, mat: THREE.Material, radius: number, tube: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 20), mat);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

/** Vent slots cut visually into a handguard (dark inset boxes, both sides). */
function handguardVents(parent: THREE.Object3D, mat: THREE.Material, zFrom: number, zTo: number, y: number, halfWidth: number): void {
  const count = Math.max(3, Math.round((zFrom - zTo) / 0.028));
  for (let i = 0; i < count; i++) {
    const z = zFrom - ((zFrom - zTo) * i) / (count - 1);
    for (const side of [-1, 1]) {
      box(parent, mat, 0.002, 0.012, 0.014, side * halfWidth, y, z, 0.0008);
    }
  }
}

/** Picatinny rail ridge running along the top of a part. */
function topRail(parent: THREE.Object3D, mat: THREE.Material, zFrom: number, zTo: number, y: number): void {
  const length = zFrom - zTo;
  box(parent, mat, 0.018, 0.007, length, 0, y, (zFrom + zTo) / 2, 0.0015);
  const crossCount = Math.max(2, Math.round(length / 0.02));
  for (let i = 0; i < crossCount; i++) {
    const z = zFrom - (length * i) / (crossCount - 1);
    box(parent, mat, 0.021, 0.004, 0.005, 0, y + 0.004, z, 0.0008);
  }
}

/** Pistol grip with raked angle, finger grooves and a rubber panel. */
function pistolGrip(parent: THREE.Object3D, mats: GunMaterials, x: number, yTop: number, zTop: number): void {
  const grip = new THREE.Group();
  grip.position.set(x, yTop, zTop);
  grip.rotation.x = -0.32;
  box(grip, mats.polymer, 0.032, 0.13, 0.044, 0, -0.052, 0, 0.009);
  // Rubber side panels
  for (const side of [-1, 1]) {
    box(grip, mats.rubber, 0.004, 0.09, 0.03, side * 0.017, -0.05, 0.002, 0.0015);
  }
  // Finger groove ridges
  for (let i = 0; i < 3; i++) {
    box(grip, mats.polymer, 0.036, 0.006, 0.012, 0, -0.03 - i * 0.026, 0.004, 0.002);
  }
  parent.add(grip);
}

/** Trigger + guard assembly inside the receiver's lower front. */
function triggerGroup(parent: THREE.Object3D, mats: GunMaterials, y: number, z: number): void {
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.017, 0.0035, 6, 18, Math.PI), mats.aluminum);
  guard.rotation.set(Math.PI / 2, 0, 0);
  guard.position.set(0, y - 0.012, z + 0.005);
  parent.add(guard);
  box(parent, mats.aluminum, 0.006, 0.014, 0.004, 0, y - 0.028, z + 0.021, 0.001);
  const blade = box(parent, mats.hardware, 0.006, 0.022, 0.005, 0, y - 0.018, z + 0.006, 0.001);
  blade.rotation.x = 0.18;
}

/** Front (post) and rear (notch/ring) iron sights. */
function ironSights(parent: THREE.Object3D, mats: GunMaterials, yTop: number, zFront: number, zRear: number): void {
  const front = new THREE.Group();
  front.position.set(0, yTop, zFront);
  box(front, mats.aluminum, 0.012, 0.02, 0.008, 0, 0.008, 0, 0.002);
  box(front, mats.hardware, 0.003, 0.014, 0.003, 0, 0.022, 0, 0.0008);
  parent.add(front);
  const rear = new THREE.Group();
  rear.position.set(0, yTop, zRear);
  // CYCLE 34 (review): pedestal reaching down to the receiver deck — the
  // bare base used to hover ~20 mm above it, reading as a black tower.
  box(rear, mats.aluminum, 0.024, 0.024, 0.012, 0, 0.0, 0, 0.002);
  box(rear, mats.polymer, 0.008, 0.012, 0.006, 0, 0.021, 0, 0.001);
  parent.add(rear);
}

/** Charging handle / ejection port detail on the receiver's right side. */
function chargingDetail(parent: THREE.Object3D, mats: GunMaterials, x: number, y: number, z: number): THREE.Object3D {
  const handle = new THREE.Group();
  handle.position.set(x, y, z);
  box(handle, mats.hardware, 0.01, 0.008, 0.036, 0.004, 0, 0, 0.002);
  box(handle, mats.steel, 0.004, 0.014, 0.02, -0.002, -0.004, 0.004, 0.001);
  parent.add(handle);
  return handle;
}

/** Curved-look magazine: stacked slight-angle segments descending from a well. */
function boxMagazine(parent: THREE.Object3D, mats: GunMaterials, x: number, yTop: number, z: number, w: number, frontAngle: number, length = 0.16): { group: THREE.Group; tip: number } {
  const mag = new THREE.Group();
  mag.position.set(x, yTop, z);
  const segments = 3;
  const segLen = length / segments;
  let angle = 0;
  for (let i = 0; i < segments; i++) {
    angle += frontAngle / segments;
    const seg = box(
      mag,
      i === 0 ? mats.aluminum : mats.polymer,
      w, segLen + 0.004, 0.052,
      0, -(segLen * (i + 0.5)), Math.sin(angle) * segLen * (i + 0.5) * -0.5,
      0.006,
    );
    seg.rotation.x = angle * (i + 1) * 0.35;
  }
  // Baseplate
  box(mag, mats.rubber, w + 0.004, 0.012, 0.058, 0, -length - 0.004, Math.sin(frontAngle) * length * -0.35, 0.004);
  parent.add(mag);
  return { group: mag, tip: yTop - length - 0.012 };
}

export interface ProceduralWeapon {
  group: THREE.Group;
  muzzleZ: number;
  mag: THREE.Object3D | null;
  bolt: THREE.Object3D | null;
  /** Top of receiver (rail height) for optic placement. */
  railY: number;
  /** Where a scope/sight mounts (z). */
  railZ: number;
  /** CYCLE 35: first-person hand anchors (weapon-local, metres).
   * gripR = trigger hand on the pistol grip; gripL = support hand on the
   * handguard / foregrip / pump. */
  gripR: THREE.Vector3;
  gripL: THREE.Vector3;
}

/** Common receiver block: upper + lower with magwell, serial-plate detail. */
function receiver(parent: THREE.Object3D, mats: GunMaterials, w: number, h: number, zFrom: number, zTo: number, railY: number): void {
  const zc = (zFrom + zTo) / 2;
  const len = Math.abs(zFrom - zTo);
  box(parent, mats.aluminum, w, h, len, 0, (railY + railY - h) / 2 + 0.004, zc, 0.008);
}

/**
 * Assault rifle anatomy (canonical 0.95 m): the reference build every other
 * class scales details from.
 */
function buildAr(mats: GunMaterials): ProceduralWeapon {
  const g = new THREE.Group();
  // Upper + lower receiver
  receiver(g, mats, 0.042, 0.052, -0.34, -0.08, 0.048);
  // Barrel: profiled steps + muzzle device
  cyl(g, mats.steel, 0.009, 0.011, 0.34, 0, 0.024, -0.51);
  cyl(g, mats.steel, 0.013, 0.013, 0.05, 0, 0.024, -0.345, 14);
  cyl(g, mats.steel, 0.016, 0.016, 0.058, 0, 0.024, -0.68, 14);
  for (const side of [-1, 1]) {
    box(g, mats.steel, 0.004, 0.03, 0.03, side * 0.012, 0.024, -0.68, 0.001);
  }
  ring(g, mats.steel, 0.0165, 0.004, 0, 0.024, -0.655);
  // Handguard with vents + top rail
  box(g, mats.aluminum, 0.048, 0.052, 0.3, 0, 0.026, -0.49, 0.008);
  handguardVents(g, mats.polymer, -0.37, -0.62, 0.026, 0.025);
  topRail(g, mats.aluminum, -0.34, -0.64, 0.055);
  topRail(g, mats.aluminum, -0.06, -0.35, 0.055);
  // Front sight block on the handguard
  box(g, mats.steel, 0.016, 0.036, 0.018, 0, 0.04, -0.63, 0.003);
  // Stock: buffer tube + adjustable shoulder stock
  cyl(g, mats.aluminum, 0.016, 0.016, 0.14, 0, 0.02, -0.008, 12);
  box(g, mats.polymer, 0.036, 0.05, 0.11, 0, 0.016, 0.09, 0.009);
  box(g, mats.rubber, 0.036, 0.06, 0.018, 0, 0.008, 0.15, 0.006);
  box(g, mats.polymer, 0.02, 0.03, 0.06, 0, -0.024, 0.055, 0.005);
  // Pistol grip + trigger
  pistolGrip(g, mats, 0, 0.004, -0.115);
  triggerGroup(g, mats, 0.008, -0.15);
  // Magazine (curved 30-round profile)
  const magWell = box(g, mats.aluminum, 0.044, 0.03, 0.062, 0, -0.012, -0.2, 0.006);
  magWell.name = 'magwell';
  const mag = boxMagazine(g, mats, 0, -0.024, -0.2, 0.038, 0.42);
  mag.group.name = 'mag';
  // Charging handle + ejection detail
  const bolt = chargingDetail(g, mats, 0.023, 0.038, -0.1);
  bolt.name = 'bolt';
  // Iron sights (folded profile)
  ironSights(g, mats, 0.058, -0.615, -0.1);
  // Sling loop
  ring(g, mats.hardware, 0.008, 0.002, 0.024, 0.006, -0.09);
  return {
    group: g, muzzleZ: -0.71, mag: g.getObjectByName('mag') ?? null, bolt, railY: 0.055, railZ: -0.2,
    // Hands-review fix: anchors sit ON the grip surfaces, not at the grip's
    // centre — gripR on the right-rear face (the palm's contact face, weapon
    // +x) so the hand wraps the profile instead of centring inside it;
    // gripL just under the handguard bottom for the palm-up under carry.
    // AR grip: top (0, 0.004, -0.115) raked -0.32, centre ≈ (0, -0.045, -0.099).
    gripR: new THREE.Vector3(0.02, -0.052, -0.096),
    gripL: new THREE.Vector3(0, -0.006, -0.44),
  };
}

/** Pistol anatomy (canonical 0.42 m incl. arms-length proportioning). */
function buildPistol(mats: GunMaterials): ProceduralWeapon {
  const g = new THREE.Group();
  // Frame + grip
  box(g, mats.polymer, 0.03, 0.036, 0.13, 0, 0, -0.09, 0.007);
  pistolGrip(g, mats, 0, -0.01, -0.045);
  triggerGroup(g, mats, 0.0, -0.075);
  // Slide: steel with serrations + ejection port
  const slide = box(g, mats.steel, 0.032, 0.03, 0.21, 0, 0.033, -0.13, 0.005);
  slide.name = 'bolt';
  for (let i = 0; i < 6; i++) {
    box(g, mats.steel, 0.034, 0.026, 0.003, 0, 0.033, -0.045 - i * 0.009, 0.0008);
  }
  box(g, mats.polymer, 0.034, 0.012, 0.045, 0, 0.033, -0.175, 0.002);
  // Barrel visible at the muzzle + guide rod
  cyl(g, mats.steel, 0.009, 0.009, 0.014, 0, 0.031, -0.238, 14);
  cyl(g, mats.hardware, 0.005, 0.005, 0.012, 0, 0.006, -0.166, 10);
  // Magazine inside the grip (baseplate visible)
  const mag = boxMagazine(g, mats, 0, -0.075, -0.045, 0.028, 0.12, 0.09);
  mag.group.name = 'mag';
  // Sights
  ironSights(g, mats, 0.048, -0.225, -0.035);
  return {
    group: g, muzzleZ: -0.246, mag: g.getObjectByName('mag') ?? null, bolt: slide, railY: 0.048, railZ: -0.11,
    // Same on-surface rule (grip top (0, -0.01, -0.045) raked -0.32).
    gripR: new THREE.Vector3(0.019, -0.056, -0.024),
    gripL: new THREE.Vector3(-0.02, -0.05, -0.03),
  };
}

/** SMG anatomy (canonical 0.62 m): compact, side-folding rails, big suppressor. */
function buildSmg(mats: GunMaterials): ProceduralWeapon {
  const g = new THREE.Group();
  receiver(g, mats, 0.046, 0.058, -0.3, -0.07, 0.05);
  // Short barrel + suppressor-ready muzzle
  cyl(g, mats.steel, 0.012, 0.012, 0.12, 0, 0.026, -0.36, 14);
  cyl(g, mats.aluminum, 0.019, 0.019, 0.12, 0, 0.026, -0.46, 16);
  for (let i = 0; i < 4; i++) {
    ring(g, mats.steel, 0.0195, 0.0025, 0, 0.026, -0.41 - i * 0.032);
  }
  // Shroud with oval vents
  box(g, mats.aluminum, 0.044, 0.05, 0.16, 0, 0.028, -0.35, 0.008);
  handguardVents(g, mats.polymer, -0.29, -0.42, 0.028, 0.023);
  topRail(g, mats.aluminum, -0.05, -0.44, 0.058);
  // Side-folding stock rails + compact buttplate
  for (const side of [-1, 1]) {
    box(g, mats.aluminum, 0.012, 0.014, 0.17, side * 0.026, 0.018, 0.02, 0.002);
  }
  box(g, mats.polymer, 0.062, 0.05, 0.03, 0, 0.014, 0.115, 0.008);
  box(g, mats.rubber, 0.05, 0.052, 0.012, 0, 0.012, 0.135, 0.004);
  // Vertical foregrip
  box(g, mats.rubber, 0.026, 0.084, 0.032, 0, -0.022, -0.38, 0.008);
  for (let i = 0; i < 3; i++) {
    box(g, mats.polymer, 0.03, 0.005, 0.01, 0, -0.045 + i * 0.022, -0.388, 0.0015);
  }
  pistolGrip(g, mats, 0, 0.0, -0.1);
  triggerGroup(g, mats, 0.006, -0.13);
  // Long straight mag
  const mag = boxMagazine(g, mats, 0, -0.026, -0.19, 0.032, 0.16, 0.15);
  mag.group.name = 'mag';
  const bolt = chargingDetail(g, mats, 0.026, 0.04, -0.085);
  bolt.name = 'bolt';
  ironSights(g, mats, 0.06, -0.43, -0.06);
  return {
    group: g, muzzleZ: -0.525, mag: g.getObjectByName('mag') ?? null, bolt, railY: 0.058, railZ: -0.16,
    // Grip top (0, 0, -0.1) raked -0.32; gripL on the LEFT face of the
    // vertical foregrip (spans x ±0.013, y -0.064..0.02, z -0.396..-0.364).
    gripR: new THREE.Vector3(0.02, -0.05, -0.072),
    gripL: new THREE.Vector3(-0.014, -0.03, -0.38),
  };
}

/** Shotgun anatomy (canonical 1.0 m): tube magazine, pump, bead sight. */
function buildShotgun(mats: GunMaterials): ProceduralWeapon {
  const g = new THREE.Group();
  receiver(g, mats, 0.044, 0.056, -0.36, -0.1, 0.046);
  // Barrel + underbarrel tube magazine
  cyl(g, mats.steel, 0.011, 0.012, 0.56, 0, 0.03, -0.64, 14);
  cyl(g, mats.aluminum, 0.013, 0.013, 0.46, 0, 0.002, -0.58, 12);
  cyl(g, mats.steel, 0.015, 0.015, 0.03, 0, 0.03, -0.9, 12);
  // Pump grip rides the tube (this is the cycling bolt)
  const pump = new THREE.Group();
  pump.position.set(0, 0.002, -0.52);
  box(pump, mats.polymer, 0.042, 0.036, 0.11, 0, 0, 0, 0.01);
  for (let i = 0; i < 5; i++) {
    box(pump, mats.rubber, 0.046, 0.03, 0.006, 0, 0, -0.04 + i * 0.02, 0.001);
  }
  pump.name = 'bolt';
  g.add(pump);
  // Barrel-to-tube brace
  box(g, mats.steel, 0.014, 0.03, 0.02, 0, 0.016, -0.42, 0.003);
  box(g, mats.steel, 0.014, 0.03, 0.02, 0, 0.016, -0.72, 0.003);
  // Bead sight
  box(g, mats.hardware, 0.004, 0.006, 0.004, 0, 0.043, -0.88, 0.001);
  // Stock with wrist + butt pad
  box(g, mats.polymer, 0.034, 0.05, 0.08, 0, 0.014, -0.06, 0.007);
  const stock = new THREE.Group();
  stock.position.set(0, 0.012, -0.02);
  stock.rotation.x = 0.14;
  box(stock, mats.polymer, 0.038, 0.056, 0.22, 0, -0.01, 0.13, 0.01);
  box(stock, mats.rubber, 0.04, 0.06, 0.016, 0, -0.024, 0.245, 0.005);
  g.add(stock);
  pistolGrip(g, mats, 0, 0.002, -0.095);
  triggerGroup(g, mats, 0.006, -0.135);
  // Shell carrier detail on the receiver side
  box(g, mats.aluminum, 0.006, 0.03, 0.1, 0.024, 0.008, -0.18, 0.002);
  ironSights(g, mats, 0.06, -0.35, -0.08);
  return {
    group: g, muzzleZ: -0.92, mag: null, bolt: pump, railY: 0.06, railZ: -0.2,
    // Grip top (0, 0.002, -0.095) raked -0.32; gripL rides the pump body
    // (y -0.016..0.02 at z -0.52) — the rig offsets the palm UNDER it.
    gripR: new THREE.Vector3(0.02, -0.048, -0.068),
    gripL: new THREE.Vector3(0, 0.014, -0.51),
  };
}

/** Sniper anatomy (canonical 1.28 m): heavy barrel, bolt handle, cheek riser. */
function buildSniper(mats: GunMaterials): ProceduralWeapon {
  const g = new THREE.Group();
  receiver(g, mats, 0.044, 0.05, -0.4, -0.06, 0.048);
  // Free-floated heavy barrel with fluting suggestion
  cyl(g, mats.steel, 0.013, 0.016, 0.72, 0, 0.026, -0.82, 16);
  for (const side of [-1, 1]) {
    box(g, mats.steel, 0.003, 0.02, 0.4, side * 0.011, 0.026, -0.78, 0.0008);
  }
  cyl(g, mats.steel, 0.018, 0.018, 0.08, 0, 0.026, -1.2, 16);
  cyl(g, mats.steel, 0.02, 0.024, 0.05, 0, 0.026, -1.25, 16);
  ring(g, mats.steel, 0.0205, 0.004, 0, 0.026, -1.22);
  // Full-length rail
  topRail(g, mats.aluminum, -0.05, -0.78, 0.062);
  // Chassis fore-end with angled cuts
  box(g, mats.aluminum, 0.05, 0.05, 0.34, 0, 0.02, -0.58, 0.009);
  handguardVents(g, mats.polymer, -0.44, -0.74, 0.02, 0.026);
  // Adjustable stock: cheek riser + hook
  box(g, mats.aluminum, 0.04, 0.04, 0.14, 0, 0.02, 0.02, 0.007);
  const stock = new THREE.Group();
  stock.position.set(0, 0.018, 0.07);
  box(stock, mats.polymer, 0.042, 0.07, 0.17, 0, -0.006, 0.085, 0.01);
  box(stock, mats.rubber, 0.046, 0.072, 0.018, 0, -0.012, 0.175, 0.006);
  box(stock, mats.aluminum, 0.05, 0.03, 0.05, 0, 0.036, 0.06, 0.005);
  g.add(stock);
  // Grip + trigger
  pistolGrip(g, mats, 0, 0.002, -0.085);
  triggerGroup(g, mats, 0.006, -0.12);
  // Bolt handle (cycling)
  const bolt = new THREE.Group();
  bolt.position.set(0.026, 0.04, -0.12);
  cyl(bolt, mats.steel, 0.005, 0.005, 0.05, 0.012, 0, 0, 10);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 10), mats.steel);
  knob.position.set(0.038, 0, 0);
  bolt.add(knob);
  bolt.name = 'bolt';
  g.add(bolt);
  // CYCLE 34 (review): class-identity optic — tube + objective bell +
  // eyepiece + mounts + emissive lens on the full-length rail.
  const scope = new THREE.Group();
  scope.position.set(0, 0.096, -0.16);
  cyl(scope, mats.aluminum, 0.02, 0.02, 0.28, 0, 0, 0, 14);
  cyl(scope, mats.aluminum, 0.028, 0.023, 0.07, 0, 0, -0.17, 14);
  cyl(scope, mats.aluminum, 0.023, 0.02, 0.05, 0, 0, 0.16, 14);
  box(scope, mats.aluminum, 0.014, 0.03, 0.022, 0, -0.02, -0.06, 0.002);
  box(scope, mats.aluminum, 0.014, 0.03, 0.022, 0, -0.02, 0.05, 0.002);
  box(scope, mats.hardware, 0.01, 0.014, 0.014, 0, 0.026, 0, 0.002);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.022, 16),
    new THREE.MeshStandardMaterial({ color: 0x0a1420, emissive: 0x2a5a8c, emissiveIntensity: 0.5, roughness: 0.15, metalness: 0.4 }),
  );
  lens.rotation.y = Math.PI;
  lens.position.set(0, 0, -0.206);
  scope.add(lens);
  g.add(scope);
  // Box magazine
  const mag = boxMagazine(g, mats, 0, -0.022, -0.2, 0.036, 0.1, 0.1);
  mag.group.name = 'mag';
  // Bipod folded under the fore-end
  for (const side of [-1, 1]) {
    const leg = box(g, mats.aluminum, 0.008, 0.09, 0.012, side * 0.014, -0.036, -0.6, 0.002);
    leg.rotation.x = 0.9 * side * 0.25;
  }
  return {
    group: g, muzzleZ: -1.28, mag: g.getObjectByName('mag') ?? null, bolt, railY: 0.062, railZ: -0.16,
    // Grip top (0, 0.002, -0.085) raked -0.32; gripL under the chassis
    // fore-end (spans y -0.005..0.045, z -0.41..-0.75).
    gripR: new THREE.Vector3(0.02, -0.048, -0.058),
    gripL: new THREE.Vector3(0, -0.008, -0.52),
  };
}

export function buildProceduralWeapon(weaponId: WeaponId, mats: GunMaterials): ProceduralWeapon {
  switch (weaponId) {
    case 'pistol': return buildPistol(mats);
    case 'smg': return buildSmg(mats);
    case 'shotgun': return buildShotgun(mats);
    case 'sniper': return buildSniper(mats);
    case 'ar':
    default: return buildAr(mats);
  }
}
