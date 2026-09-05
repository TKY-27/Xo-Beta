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
import type { WeaponId } from '../core/balance';

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

export function makeGunMaterials(): GunMaterials {
  return {
    steel: new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.3, metalness: 0.88 }),
    aluminum: new THREE.MeshStandardMaterial({ color: 0x484d54, roughness: 0.48, metalness: 0.72 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x313438, roughness: 0.76, metalness: 0.05 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x121315, roughness: 0.96, metalness: 0.02 }),
    hardware: new THREE.MeshStandardMaterial({ color: 0x585f66, roughness: 0.28, metalness: 0.9 }),
  };
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
  box(rear, mats.aluminum, 0.024, 0.016, 0.01, 0, 0.006, 0, 0.002);
  box(rear, mats.polymer, 0.008, 0.012, 0.006, 0, 0.018, 0, 0.001);
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
  receiver(g, mats, 0.042, 0.052, -0.34, -0.08, 0.032);
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
  box(g, mats.polymer, 0.036, 0.062, 0.11, 0, 0.014, 0.09, 0.009);
  box(g, mats.rubber, 0.04, 0.085, 0.018, 0, 0.006, 0.15, 0.006);
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
  ironSights(g, mats, 0.058, -0.615, -0.075);
  // Sling loop
  ring(g, mats.hardware, 0.008, 0.002, 0.024, 0.006, -0.09);
  return { group: g, muzzleZ: -0.71, mag: g.getObjectByName('mag') ?? null, bolt, railY: 0.055, railZ: -0.2 };
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
  return { group: g, muzzleZ: -0.246, mag: g.getObjectByName('mag') ?? null, bolt: slide, railY: 0.048, railZ: -0.11 };
}

/** SMG anatomy (canonical 0.62 m): compact, side-folding rails, big suppressor. */
function buildSmg(mats: GunMaterials): ProceduralWeapon {
  const g = new THREE.Group();
  receiver(g, mats, 0.046, 0.058, -0.3, -0.07, 0.035);
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
    box(g, mats.aluminum, 0.008, 0.014, 0.17, side * 0.028, 0.018, 0.02, 0.002);
  }
  box(g, mats.polymer, 0.07, 0.05, 0.03, 0, 0.014, 0.115, 0.008);
  box(g, mats.rubber, 0.074, 0.062, 0.012, 0, 0.012, 0.135, 0.004);
  // Vertical foregrip
  box(g, mats.polymer, 0.026, 0.084, 0.032, 0, -0.022, -0.38, 0.008);
  for (let i = 0; i < 3; i++) {
    box(g, mats.polymer, 0.03, 0.005, 0.01, 0, -0.045 + i * 0.022, -0.388, 0.0015);
  }
  pistolGrip(g, mats, 0, 0.0, -0.1);
  triggerGroup(g, mats, 0.006, -0.13);
  // Long straight mag
  const mag = boxMagazine(g, mats, 0, -0.026, -0.19, 0.032, 0.16, 0.19);
  mag.group.name = 'mag';
  const bolt = chargingDetail(g, mats, 0.026, 0.04, -0.085);
  bolt.name = 'bolt';
  ironSights(g, mats, 0.06, -0.43, -0.06);
  return { group: g, muzzleZ: -0.525, mag: g.getObjectByName('mag') ?? null, bolt, railY: 0.058, railZ: -0.16 };
}

/** Shotgun anatomy (canonical 1.0 m): tube magazine, pump, bead sight. */
function buildShotgun(mats: GunMaterials): ProceduralWeapon {
  const g = new THREE.Group();
  receiver(g, mats, 0.044, 0.056, -0.36, -0.1, 0.032);
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
  box(stock, mats.rubber, 0.042, 0.09, 0.016, 0, -0.03, 0.245, 0.005);
  g.add(stock);
  pistolGrip(g, mats, 0, 0.002, -0.095);
  triggerGroup(g, mats, 0.006, -0.135);
  // Shell carrier detail on the receiver side
  box(g, mats.aluminum, 0.006, 0.03, 0.1, 0.024, 0.008, -0.18, 0.002);
  ironSights(g, mats, 0.06, -0.35, -0.08);
  return { group: g, muzzleZ: -0.92, mag: null, bolt: pump, railY: 0.06, railZ: -0.2 };
}

/** Sniper anatomy (canonical 1.28 m): heavy barrel, bolt handle, cheek riser. */
function buildSniper(mats: GunMaterials): ProceduralWeapon {
  const g = new THREE.Group();
  receiver(g, mats, 0.044, 0.05, -0.4, -0.06, 0.034);
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
  stock.position.set(0, 0.018, 0.09);
  box(stock, mats.polymer, 0.042, 0.07, 0.17, 0, -0.006, 0.085, 0.01);
  box(stock, mats.rubber, 0.046, 0.095, 0.018, 0, -0.012, 0.175, 0.006);
  box(stock, mats.aluminum, 0.03, 0.03, 0.05, 0, 0.048, 0.06, 0.005);
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
  // Box magazine
  const mag = boxMagazine(g, mats, 0, -0.022, -0.2, 0.036, 0.1, 0.1);
  mag.group.name = 'mag';
  // Bipod folded under the fore-end
  for (const side of [-1, 1]) {
    const leg = box(g, mats.aluminum, 0.008, 0.09, 0.012, side * 0.014, -0.036, -0.6, 0.002);
    leg.rotation.x = 0.9 * side * 0.25;
  }
  return { group: g, muzzleZ: -1.28, mag: g.getObjectByName('mag') ?? null, bolt, railY: 0.062, railZ: -0.16 };
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
