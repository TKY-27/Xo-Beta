/**
 * First-person viewmodel: weapon presentation (5 classes), arms, sway,
 * walking bob, recoil kick, ADS transition, reload sequences.
 */

import * as THREE from 'three';
import { RARITY_COLORS, WEAPONS, type Rarity, type WeaponId } from '../core/balance';
import type { Actor } from '../sim/actor';

export class ViewModel {
  readonly group = new THREE.Group();
  private weaponGroups = new Map<string, THREE.Group>();
  private armMat: THREE.MeshStandardMaterial;
  private suitMat: THREE.MeshStandardMaterial;
  private currentId: string | null = null;
  private t = 0;

  // Animation state
  private swayX = 0;
  private swayY = 0;
  private recoilZ = 0;
  private reloadT = 0;
  private boltT = 0;
  private magMesh: THREE.Object3D | null = null;
  private slideMesh: THREE.Object3D | null = null;

  constructor() {
    this.armMat = new THREE.MeshStandardMaterial({ color: 0x2e3a44, roughness: 0.6, metalness: 0.25 });
    this.suitMat = new THREE.MeshStandardMaterial({
      color: 0x15171a, emissive: 0x5fd0ff, emissiveIntensity: 0.7, roughness: 0.45, metalness: 0.35,
    });
    for (const id of ['pistol', 'smg', 'ar', 'shotgun', 'sniper'] as WeaponId[]) {
      const g = this.buildWeapon(id);
      this.weaponGroups.set(id, g);
      g.visible = false;
      this.group.add(g);
    }
    // Arms
    const armR = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.34, 4, 8), this.armMat);
    armR.position.set(0.16, -0.22, -0.18);
    armR.rotation.x = 1.1;
    const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.3, 4, 8), this.armMat);
    armL.position.set(-0.12, -0.24, -0.42);
    armL.rotation.set(1.2, 0.35, 0);
    const gloveR = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.11), this.suitMat);
    gloveR.position.set(0.055, -0.13, -0.32);
    const gloveL = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.11), this.suitMat);
    gloveL.position.set(-0.06, -0.16, -0.52);
    this.group.add(armR, armL, gloveR, gloveL);
  }

  private buildWeapon(id: WeaponId): THREE.Group {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b3036, roughness: 0.38, metalness: 0.78 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x191c20, roughness: 0.5, metalness: 0.6 });

    const addBox = (w: number, h: number, d: number, x: number, y: number, z: number, mat = bodyMat) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };

    if (id === 'pistol') {
      this.slideMesh = addBox(0.07, 0.075, 0.3, 0, 0.02, -0.1);
      addBox(0.065, 0.14, 0.09, 0, -0.08, 0.02, darkMat).name = 'mag';
      addBox(0.05, 0.03, 0.05, 0, 0.065, -0.24, darkMat);
    } else if (id === 'smg') {
      addBox(0.08, 0.1, 0.44, 0, 0, -0.12);
      this.slideMesh = addBox(0.06, 0.05, 0.24, 0, 0.065, -0.2, darkMat);
      this.magMesh = addBox(0.055, 0.22, 0.08, 0, -0.16, -0.06, darkMat);
      addBox(0.05, 0.05, 0.16, 0, 0.01, 0.16, darkMat); // stock
    } else if (id === 'ar') {
      addBox(0.075, 0.1, 0.56, 0, 0, -0.16);
      addBox(0.05, 0.05, 0.3, 0, 0.005, -0.55, darkMat); // barrel
      this.magMesh = addBox(0.06, 0.2, 0.1, 0, -0.15, -0.1, darkMat);
      addBox(0.06, 0.09, 0.14, 0, -0.07, 0.14, darkMat); // grip
      addBox(0.06, 0.06, 0.22, 0, 0.02, 0.26, darkMat); // stock
      addBox(0.09, 0.03, 0.12, 0, 0.075, -0.14, darkMat); // rail
    } else if (id === 'shotgun') {
      addBox(0.08, 0.1, 0.6, 0, 0, -0.18);
      addBox(0.055, 0.055, 0.4, 0, -0.065, -0.36, darkMat); // tube
      addBox(0.07, 0.09, 0.16, 0, -0.03, 0.16, darkMat); // pump grip
      addBox(0.07, 0.1, 0.2, 0, -0.02, 0.3, darkMat); // stock
    } else {
      // sniper
      addBox(0.07, 0.095, 0.7, 0, 0, -0.22);
      addBox(0.045, 0.045, 0.42, 0, 0.005, -0.72, darkMat); // long barrel
      addBox(0.055, 0.055, 0.16, 0, 0.09, -0.28, darkMat); // scope tube
      const lens = new THREE.Mesh(
        new THREE.CircleGeometry(0.028, 10),
        new THREE.MeshBasicMaterial({ color: 0x53b8ff }),
      );
      lens.position.set(0, 0.09, -0.365);
      g.add(lens);
      this.magMesh = addBox(0.055, 0.16, 0.09, 0, -0.13, -0.05, darkMat);
      addBox(0.07, 0.1, 0.26, 0, -0.01, 0.3, darkMat); // stock
      this.slideMesh = addBox(0.05, 0.04, 0.2, 0, 0.062, -0.1, darkMat); // bolt carrier
    }

    // Rarity accent strip (recolored per instance at runtime)
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(0.085, 0.02, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x101114, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4 }),
    );
    strip.name = 'rarityStrip';
    strip.position.set(0, 0.055, -0.02);
    g.add(strip);

    return g;
  }

  setWeapon(id: WeaponId | null, rarity: Rarity): void {
    if (this.currentId) {
      const prev = this.weaponGroups.get(this.currentId);
      if (prev) prev.visible = false;
    }
    this.currentId = id;
    if (!id) return;
    const g = this.weaponGroups.get(id)!;
    g.visible = true;
    const strip = g.getObjectByName('rarityStrip') as THREE.Mesh | null;
    if (strip) {
      (strip.material as THREE.MeshStandardMaterial).emissive.setHex(RARITY_COLORS[rarity]);
    }
    this.magMesh = g.children.find((c) => c.name === 'mag') ?? null;
  }

  /** Per-frame presentation update driven by actor state. */
  update(actor: Actor | null, dt: number, lookDx: number, lookDy: number, movingSpeed: number): void {
    this.t += dt;
    if (!actor || !this.currentId) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const def = WEAPONS[actor.inv.selectedWeapon?.weaponId ?? 'pistol'];
    const ads = actor.wpn.adsAmount;

    // Sway from look input
    this.swayX += (-lookDx * 0.0016 - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (-lookDy * 0.0014 - this.swayY) * Math.min(1, dt * 9);

    // Bob
    const bobAmp = movingSpeed > 0.5 ? Math.min(1, movingSpeed / 9.5) : 0;
    const bobX = Math.sin(this.t * movingSpeed * 0.9) * 0.011 * bobAmp * (1 - ads * 0.85);
    const bobY = Math.abs(Math.cos(this.t * movingSpeed * 0.9)) * 0.013 * bobAmp * (1 - ads * 0.85);

    // Recoil recovery
    this.recoilZ *= Math.exp(-9 * dt);

    // Reload animation progress
    const reloading = actor.wpn.reloadTimer > 0;
    let reloadAnim = 0;
    if (reloading) {
      this.reloadT += dt;
      const phase = 1 - actor.wpn.reloadTimer / actor.wpn.reloadTotal;
      reloadAnim = Math.sin(phase * Math.PI);
      if (this.magMesh) {
        // drop then insert magazine
        const dropPhase = Math.min(1, phase * 2.2);
        this.magMesh.position.y = (this.magMesh.userData.baseY ??= this.magMesh.position.y);
        this.magMesh.position.y = this.magMesh.userData.baseY - dropPhase * 0.22 * (phase < 0.55 ? 1 : -1);
        this.magMesh.visible = !(phase < 0.45 && actor.wpn.reloadingEmpty);
      }
    } else {
      this.reloadT = 0;
      if (this.magMesh) {
        this.magMesh.visible = true;
        if (this.magMesh.userData.baseY !== undefined) this.magMesh.position.y = this.magMesh.userData.baseY;
      }
    }

    // Bolt/pump cycling
    let boltAnim = 0;
    if (actor.wpn.boltTimer > 0 && (def.fireMode === 'bolt' || def.fireMode === 'pump')) {
      boltAnim = Math.sin((1 - actor.wpn.boltTimer / 0.9) * Math.PI);
    }

    // ADS position lerp
    const hipPos = { x: 0.17, y: -0.155, z: -0.05 };
    const adsPos = { x: 0, y: def.id === 'sniper' ? -0.062 : -0.07, z: -0.12 };
    const px = hipPos.x + (adsPos.x - hipPos.x) * ads;
    const py = hipPos.y + (adsPos.y - hipPos.y) * ads;
    const pz = hipPos.z + (adsPos.z - hipPos.z) * ads;

    this.group.position.set(px + bobX + this.swayX, py + bobY + this.swayY, pz + this.recoilZ);
    this.group.rotation.set(
      -this.swayY * 2 + reloadAnim * 0.5 + (reloading ? 0.15 : 0),
      this.swayX * 2,
      reloadAnim * 0.25,
    );

    // Slide/bolt visual offset
    if (this.slideMesh) {
      this.slideMesh.position.z = (this.slideMesh.userData.baseZ ??= this.slideMesh.position.z);
      this.slideMesh.position.z = this.slideMesh.userData.baseZ + boltAnim * (def.fireMode === 'pump' ? 0.06 : 0.045);
    }
  }

  kick(strength: number): void {
    this.recoilZ += strength * 0.06;
  }

  /** Muzzle world position for effects. */
  muzzleWorld(camera: THREE.Camera): THREE.Vector3 {
    const v = new THREE.Vector3(0, 0.02, -0.62);
    v.applyMatrix4(this.group.matrixWorld);
    void camera;
    return v;
  }
}
