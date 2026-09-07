/**
 * Weapon model composition: builds the five weapon classes from procedural
 * firearm anatomy (see weaponGeometry.ts) with rarity attachments and accent
 * materials. Shared by first-person viewmodel, world loot and character hand
 * attachments.
 */

import * as THREE from 'three';
import { RARITY_COLORS, RARITIES, type Rarity, type WeaponId } from '../core/balance';
import { buildProceduralWeapon, makeGunMaterials, makeSkinTexture, type GunMaterials } from './weaponGeometry';

export interface WeaponModel {
  group: THREE.Group;
  /** Muzzle position in weapon-local space (barrel points -Z). */
  muzzle: THREE.Vector3;
  /** Magazine object for reload animation (may be null). */
  mag: THREE.Object3D | null;
  /** Bolt/slide/pump object for cycling animation (may be null). */
  bolt: THREE.Object3D | null;
  /** Accent meshes whose emissive follows rarity. */
  accents: THREE.MeshStandardMaterial[];
  /** CYCLE 35: first-person hand anchors (weapon-local metres). */
  gripR: THREE.Vector3;
  gripL: THREE.Vector3;
}

const ALL_RARITIES = RARITIES;

/** Keep floor pickups near their authored one-metre weapon length. */
export const WORLD_LOOT_WEAPON_SCALE = 1.25;

/** Lightweight instance clone: shares geometries + materials with the archetype. */
function cloneWeaponModel(tmpl: WeaponModel): WeaponModel {
  const group = tmpl.group.clone(true);
  const mag = group.getObjectByName('mag') ?? null;
  const bolt = group.getObjectByName('bolt') ?? null;
  const muzzleObj = group.getObjectByName('muzzle');
  return {
    group,
    muzzle: muzzleObj ? muzzleObj.position.clone() : tmpl.muzzle.clone(),
    mag: tmpl.mag ? mag : null,
    bolt: tmpl.bolt ? bolt : null,
    accents: tmpl.accents,
    gripR: tmpl.gripR,
    gripL: tmpl.gripL,
  };
}

/** Canonical weapon lengths (meters), matching the balance tables. */
const LENGTHS: Record<WeaponId, number> = {
  pistol: 0.42,
  smg: 0.62,
  ar: 0.95,
  shotgun: 1.0,
  sniper: 1.28,
};

const RARITY_RANK: Record<Rarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
};

export class WeaponModelFactory {
  /** Prebuilt archetype per `weaponId:rarity`. Clones share geometry+materials. */
  private templates = new Map<string, WeaponModel>();
  private readonly mats: GunMaterials;
  /** CYCLE 32: per-rarity skin material overrides for the large receiver /
   * handguard / stock panels. Shared across every weapon archetype. */
  private skinPanels = new Map<Rarity, Map<string, THREE.MeshStandardMaterial>>();
  /** Hex tint per rarity for the skin graphic. */
  private static readonly SKIN_TINTS: Record<Rarity, string> = {
    common: '#8d949c',
    uncommon: '#5fd08a',
    rare: '#57a8ff',
    epic: '#c46bff',
    legendary: '#ffb545',
  };

  constructor(
    /** Unused since the procedural-geometry rework; retained for call-site stability. */
    _props: unknown,
  ) {
    this.mats = makeGunMaterials();
  }

  /** Skin-panel material for one base material + rarity (cached). Common
   * keeps the bare-metal look; uncommon+ carry the pattern graphic. */
  private skinPanel(baseName: string, rarity: Rarity): THREE.MeshStandardMaterial | null {
    if (rarity === 'common') return null;
    let byBase = this.skinPanels.get(rarity);
    if (!byBase) {
      byBase = new Map();
      this.skinPanels.set(rarity, byBase);
    }
    const cached = byBase.get(baseName);
    if (cached) return cached;
    const base = (this.mats as unknown as Record<string, THREE.MeshStandardMaterial | undefined>)[baseName];
    if (!base) return null;
    const panel = base.clone();
    panel.map = makeSkinTexture(rarity, WeaponModelFactory.SKIN_TINTS[rarity]);
    panel.color.set(0xbfc3c8);
    panel.roughness = Math.min(0.62, base.roughness + 0.08);
    panel.name = `skin:${baseName}:${rarity}`;
    panel.userData.weaponFactoryOwned = true;
    byBase.set(baseName, panel);
    return panel;
  }

  /**
   * Compose a weapon. `rarity` drives attachment extras + accent glow.
   * Returns a lightweight clone of a cached archetype: geometries and
   * materials are shared, so repeated builds (loot spawns, bot swaps) never
   * re-create GPU resources or trigger shader compilation mid-match.
   */
  build(weaponId: WeaponId, rarity: Rarity): WeaponModel | null {
    const key = `${weaponId}:${rarity}`;
    let tmpl = this.templates.get(key);
    if (tmpl === undefined) {
      const built = this.buildUnique(weaponId, rarity);
      if (!built) return null;
      this.templates.set(key, built);
      tmpl = built;
    }
    return cloneWeaponModel(tmpl);
  }

  /** Build every archetype up front (call during the loading screen). */
  prewarmAll(): void {
    for (const id of Object.keys(LENGTHS) as WeaponId[]) {
      for (const rarity of ALL_RARITIES) {
        const key = `${id}:${rarity}`;
        if (this.templates.has(key)) continue;
        const built = this.buildUnique(id, rarity);
        if (built) this.templates.set(key, built);
      }
    }
  }

  /**
   * The cached archetype roots for the renderer warmup stage. Building an
   * archetype is CPU-only; its materials and geometry still compile/upload on
   * first render, and floor loot stays 48 m-culled (invisible) until the
   * player walks up to it. Rendering each template once during the loading
   * screen uploads every part material + geometry, so mid-match loot
   * encounters never stall. Callers must detach the returned objects after
   * the warmup render — they stay owned by the factory cache.
   */
  warmupTemplates(): WeaponModel[] {
    return [...this.templates.values()];
  }

  private buildUnique(weaponId: WeaponId, rarity: Rarity): WeaponModel | null {
    if (!(weaponId in LENGTHS)) return null;
    const gun = buildProceduralWeapon(weaponId, this.mats);
    const group = gun.group;
    const length = LENGTHS[weaponId];
    const rank = RARITY_RANK[rarity];
    const accents: THREE.MeshStandardMaterial[] = [];

    // Rarity accent strip along the receiver rail.
    if (rank >= 0) {
      const stripColor = new THREE.Color(RARITY_COLORS[rarity]).multiplyScalar(0.55);
      const stripMat = new THREE.MeshStandardMaterial({
        color: 0x101114,
        emissive: stripColor,
        emissiveIntensity: 0.28 + rank * 0.16,
        roughness: 0.42,
        metalness: 0.3,
      });
      // CYCLE 34 (review): the strip hung in mid-air beside every receiver
      // (x 0.024 > half-widths, length overshooting the butt). It now lies
      // flush inside the top-rail slot like a rail insert, capped length.
      const stripLen = Math.min(0.22, length * (rank >= 3 ? 0.4 : 0.26));
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.0022, stripLen), stripMat);
      strip.position.set(0, gun.railY + 0.007, gun.railZ + 0.02);
      strip.visible = rank > 0 || weaponId === 'pistol';
      group.add(strip);
      accents.push(stripMat);

      // Legendary/epic edge glow lines hugging the handguard sides.
      if (rank >= 3) {
        const lineMat = stripMat.clone();
        lineMat.emissiveIntensity += 0.12;
        accents.push(lineMat);
        for (const side of [-1, 1]) {
          const line = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.002, stripLen * 1.1), lineMat);
          line.position.set(side * 0.0255, gun.railY - 0.026, gun.railZ - 0.1);
          group.add(line);
        }
      }
    }

    // Muzzle marker.
    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0.026, gun.muzzleZ - 0.015);
    group.add(muzzle);

    // CYCLE 32: rarity skin panels on the large surfaces (receiver/handguard/
    // stock are aluminum/polymer-named materials). Small hardware stays bare.
    if (rarity !== 'common') {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (Array.isArray(mat) || !mat?.name) return;
        if (mat.name !== 'aluminum' && mat.name !== 'polymer') return;
        const panel = this.skinPanel(mat.name, rarity);
        if (panel) mesh.material = panel;
      });
    }

    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      if (!mesh.geometry.userData.externalShared) mesh.geometry.userData.weaponFactoryOwned = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material.userData.externalShared) material.userData.weaponFactoryOwned = true;
      }
    });
    return { group, muzzle: muzzle.position.clone(), mag: gun.mag, bolt: gun.bolt, accents, gripR: gun.gripR, gripL: gun.gripL };
  }

  /** World-loot presentation scale of a weapon. */
  buildWorldScale(weaponId: WeaponId, rarity: Rarity): WeaponModel | null {
    const m = this.build(weaponId, rarity);
    if (m) m.group.scale.multiplyScalar(WORLD_LOOT_WEAPON_SCALE);
    return m;
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const template of this.templates.values()) {
      template.group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mesh.geometry.userData.weaponFactoryOwned) geometries.add(mesh.geometry);
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) {
          if (material.userData.weaponFactoryOwned) materials.add(material);
        }
      });
    }
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of Object.values(this.mats)) material.dispose();
    for (const byBase of this.skinPanels.values()) {
      for (const material of byBase.values()) material.dispose();
    }
    this.skinPanels.clear();
    this.templates.clear();
  }
}
