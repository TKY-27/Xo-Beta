/**
 * Weapon model composition: builds the five weapon classes from CC0 Kenney
 * blaster parts (see docs/ASSET_MANIFEST.md) with rarity attachments and
 * accent materials. Shared by first-person viewmodel, world loot and
 * character hand attachments.
 */

import * as THREE from 'three';
import { RARITY_COLORS, RARITIES, type Rarity, type WeaponId } from '../core/balance';
import { PropLibrary } from './props';

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
  };
}

interface ClassRecipe {
  base: string;
  length: number; // canonical barrel length (meters)
  attach?: { scope?: string; silencer?: string; clip?: string };
  scopeOffset?: [number, number, number];
  silencerOffset?: [number, number, number];
  clipOffset?: [number, number, number];
}

const RECIPES: Record<WeaponId, ClassRecipe> = {
  pistol: { base: 'blaster-a', length: 0.42 },
  smg: { base: 'blaster-d', length: 0.62, attach: { clip: 'clip-small' }, clipOffset: [0, -0.09, 0.05] },
  ar: { base: 'blaster-f', length: 0.95, attach: { clip: 'clip-large', silencer: 'silencer-small' }, clipOffset: [0, -0.1, 0.08], silencerOffset: [0, 0, 0] },
  shotgun: { base: 'blaster-p', length: 1.0, attach: { silencer: 'silencer-small' }, silencerOffset: [0, -0.01, 0.02] },
  sniper: { base: 'blaster-e', length: 1.28, attach: { scope: 'scope-large-a' }, scopeOffset: [0, 0.06, 0.02] },
};

const RARITY_RANK: Record<Rarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
};

export class WeaponModelFactory {
  /** Prebuilt archetype per `weaponId:rarity`. Clones share geometry+materials. */
  private templates = new Map<string, WeaponModel>();

  constructor(private props: PropLibrary) {}

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
    for (const id of Object.keys(RECIPES) as WeaponId[]) {
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
    const recipe = RECIPES[weaponId];
    if (!recipe) return null;
    const base = this.props.cloneTemplate(`weapon/${recipe.base}`);
    if (!base) return null;

    const group = new THREE.Group();
    group.add(base);

    // Normalize: center on grip axis, scale to canonical length.
    const box = new THREE.Box3().setFromObject(base);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = recipe.length / Math.max(0.001, size.z);
    base.position.set(-center.x * s, -box.min.y * s - 0.02, -center.z * s);
    base.scale.setScalar(s);

    // Body material: dark gunmetal + subtle env response
    base.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const src = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
      const m = src.clone() as THREE.MeshStandardMaterial;
      delete m.userData.externalShared;
      m.color.multiplyScalar(0.55);
      m.metalness = Math.min(1, m.metalness + 0.25);
      m.roughness = Math.max(0.32, m.roughness * 0.8);
      mesh.material = m;
      mesh.castShadow = true;
    });

    const accents: THREE.MeshStandardMaterial[] = [];
    const rank = RARITY_RANK[rarity];

    // Rarity accent strip along the receiver
    if (rank >= 0) {
      const stripMat = new THREE.MeshStandardMaterial({
        color: 0x101114,
        emissive: new THREE.Color(RARITY_COLORS[rarity]),
        emissiveIntensity: 0.6 + rank * 0.45,
        roughness: 0.35,
        metalness: 0.4,
      });
      const stripLen = recipe.length * (rank >= 3 ? 0.62 : 0.4);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(size.x * s * 0.9, 0.014, stripLen), stripMat);
      strip.position.set(0, size.y * s * 0.42, -recipe.length * 0.52);
      strip.visible = rank > 0 || weaponId === 'pistol';
      group.add(strip);
      accents.push(stripMat);

      // Legendary/epic edge glow lines
      if (rank >= 3) {
        const lineMat = stripMat.clone();
        lineMat.emissiveIntensity += 0.5;
        for (const side of [-1, 1]) {
          const line = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.008, stripLen * 1.05), lineMat);
          line.position.set(side * size.x * s * 0.5, size.y * s * 0.18, -recipe.length * 0.52);
          group.add(line);
        }
        accents.push(lineMat);
      }
    }

    // Attachments unlock with rarity
    const at = recipe.attach ?? {};
    let muzzleZ = -recipe.length;
    const silencerPart = at.silencer && rank >= 1
      ? this.props.cloneTemplate(`weapon/${at.silencer}`)
      : null;
    if (silencerPart) {
      const part = silencerPart;
      normalizePart(part);
      const pb = new THREE.Box3().setFromObject(part);
      const psz = pb.getSize(new THREE.Vector3());
      const ps = Math.min(0.06 / psz.y, 0.16 / psz.x);
      part.scale.setScalar(ps);
      const off = recipe.silencerOffset ?? [0, 0, 0];
      part.position.set(off[0], off[1], muzzleZ + psz.z * ps * 0.5 - 0.01);
      group.add(part);
      muzzleZ -= psz.z * ps * 0.8;
    }
    const scopePart = at.scope && rank >= 2
      ? this.props.cloneTemplate(`weapon/${at.scope}`)
      : null;
    if (scopePart) {
      const part = scopePart;
      normalizePart(part);
      const pb = new THREE.Box3().setFromObject(part);
      const psz = pb.getSize(new THREE.Vector3());
      const ps = Math.min(0.07 / psz.y, 0.22 / psz.z);
      part.scale.setScalar(ps);
      const off = recipe.scopeOffset ?? [0, size.y * s * 0.5, -recipe.length * 0.45];
      part.position.set(off[0], off[1] + psz.y * ps * 0.5, off[2]);
      group.add(part);
    }
    const clipPart = at.clip && rank >= 2
      ? this.props.cloneTemplate(`weapon/${at.clip}`)
      : null;
    if (clipPart) {
      const part = clipPart;
      normalizePart(part);
      part.name = 'mag';
      const pb = new THREE.Box3().setFromObject(part);
      const psz = pb.getSize(new THREE.Vector3());
      const ps = Math.min(0.05 / psz.y, 0.14 / psz.z);
      part.scale.setScalar(ps);
      const off = recipe.clipOffset ?? [0, -psz.y * ps * 0.5, -recipe.length * 0.4];
      part.position.set(off[0], off[1] - psz.y * ps * 0.5 + 0.02, off[2]);
      group.add(part);
    }

    // Muzzle marker
    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, size.y * s * 0.32, muzzleZ - 0.02);
    group.add(muzzle);

    // Mag/bolt references for animation
    let mag: THREE.Object3D | null = null;
    if (at.clip && rank >= 2) mag = (group.getObjectByName('mag') ?? null);
    else {
      mag = new THREE.Group();
      mag.position.set(0, -size.y * s * 0.35, -recipe.length * 0.38);
      mag.userData.virtual = true;
      group.add(mag);
    }
    let bolt: THREE.Object3D | null = null;
    const boltMesh = new THREE.Mesh(
      new THREE.BoxGeometry(size.x * s * 0.5, 0.02, recipe.length * 0.16),
      new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.4, metalness: 0.85 }),
    );
    boltMesh.name = 'bolt';
    boltMesh.position.set(0, size.y * s * 0.46, -recipe.length * 0.34);
    boltMesh.visible = false;
    group.add(boltMesh);
    bolt = boltMesh;

    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry.userData.externalShared) mesh.geometry.userData.weaponFactoryOwned = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material.userData.externalShared) material.userData.weaponFactoryOwned = true;
      }
    });
    return { group, muzzle: muzzle.position.clone(), mag, bolt, accents };
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
    this.templates.clear();
  }
}

function normalizePart(part: THREE.Object3D): void {
  part.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const src = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
    const m = src.clone() as THREE.MeshStandardMaterial;
    delete m.userData.externalShared;
    m.color.multiplyScalar(0.7);
    m.metalness = Math.min(1, m.metalness + 0.3);
    m.roughness = Math.max(0.3, m.roughness * 0.85);
    mesh.material = m;
  });
}
