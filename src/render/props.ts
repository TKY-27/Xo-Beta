/**
 * PropLibrary: loads redistributed GLB model assets (CC0 — Quaternius,
 * Kenney; see docs/ASSET_MANIFEST.md) and prepares render-ready resources:
 * per-variant merged geometry for mass-instanced vegetation/rocks and
 * template groups for vehicles/weapons.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadGltf } from '../assets/assets';

export interface InstancedProp {
  /** One mesh per material bucket; instance matrices applied at build time. */
  build(count: number): THREE.InstancedMesh[];
  readonly buckets: number;
}

interface VariantSource {
  geoms: THREE.BufferGeometry[];
  materials: (THREE.Material | null)[];
}

export class PropLibrary {
  private variants = new Map<string, VariantSource>();
  private templates = new Map<string, THREE.Object3D>();
  private texLoader: THREE.TextureLoader | null = null;

  async load(): Promise<void> {
    const jobs: Array<Promise<void>> = [];

    const addVariant = (key: string, rel: string) =>
      jobs.push(
        loadGltf(rel).then((a) => {
          this.variants.set(key, extractGeometries(a.scene));
        }),
      );
    for (const n of ['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'CommonTree_4', 'CommonTree_5']) {
      addVariant(`tree/${n}`, `nature/${n}.gltf`);
    }
    for (const n of ['Pine_1', 'Pine_2', 'Pine_3', 'Pine_4']) {
      addVariant(`pine/${n}`, `nature/${n}.gltf`);
    }
    for (const n of ['DeadTree_1', 'DeadTree_2', 'DeadTree_4']) {
      addVariant(`dead/${n}`, `nature/${n}.gltf`);
    }
    addVariant('bush/common', 'nature/Bush_Common.gltf');
    addVariant('bush/flowers', 'nature/Bush_Common_Flowers.gltf');
    addVariant('fern/1', 'nature/Fern_1.gltf');
    addVariant('clover/1', 'nature/Clover_1.gltf');
    addVariant('flower/group', 'nature/Flower_3_Group.gltf');
    addVariant('rock/medium1', 'nature/Rock_Medium_1.gltf');
    addVariant('rock/medium2', 'nature/Rock_Medium_2.gltf');

    // Vehicle + weapon templates
    for (const v of ['sedan', 'suv', 'van', 'truck', 'taxi', 'police', 'delivery-flat', 'hatchback-sports', 'race-future']) {
      jobs.push(loadGltf(`vehicles/${v}.glb`).then((a) => { this.templates.set(`vehicle/${v}`, a.scene); }));
    }
    for (const w of [
      'blaster-a', 'blaster-b', 'blaster-c', 'blaster-d', 'blaster-e',
      'blaster-f', 'blaster-g', 'blaster-h', 'blaster-i', 'blaster-j',
      'scope-small', 'scope-large-a', 'silencer-small', 'clip-large', 'clip-small',
    ]) {
      jobs.push(loadGltf(`weapons/${w}.glb`).then((a) => { this.templates.set(`weapon/${w}`, a.scene); }));
    }

    await Promise.all(jobs);
  }

  hasVariant(key: string): boolean {
    return this.variants.has(key);
  }

  getVariant(key: string): VariantSource | undefined {
    return this.variants.get(key);
  }

  /**
   * Build an instanced prop from a variant key. Returns one InstancedMesh per
   * material bucket sharing the same index order.
   */
  makeInstanced(key: string, count: number): THREE.InstancedMesh[] {
    const src = this.variants.get(key);
    if (!src || count === 0) return [];
    return src.geoms.map((geo, i) => {
      const mat = src.materials[i] ?? new THREE.MeshStandardMaterial({ color: 0x5d7a43 });
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      return mesh;
    });
  }

  /** Fresh clone of a template group (vehicles, weapons). */
  cloneTemplate(key: string): THREE.Object3D | null {
    const t = this.templates.get(key);
    if (!t) return null;
    const c = t.clone(true);
    return c;
  }

  vehicleKeys(): string[] {
    return [...this.templates.keys()].filter((k) => k.startsWith('vehicle/')).map((k) => k.slice(8));
  }

  dispose(): void {
    for (const v of this.variants.values()) {
      for (const g of v.geoms) g.dispose();
    }
    this.variants.clear();
    this.templates.clear();
  }
}

/** Split a GLTF scene into flat geometries + matching materials. */
function extractGeometries(root: THREE.Object3D): { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] } {
  const geoms: THREE.BufferGeometry[] = [];
  const materials: (THREE.Material | null)[] = [];
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);
    // Drop skinning attributes — static props don't need them.
    for (const attr of ['skinIndex', 'skinWeight'] as const) {
      if (geo.getAttribute(attr)) geo.deleteAttribute(attr);
    }
    // Normalize to y=0 base, keep authored scale.
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const min = bb.min.y;
    geo.translate(0, -min, 0);
    geo.computeBoundingSphere();
    geoms.push(geo);
    materials.push(Array.isArray(mesh.material) ? mesh.material[0] ?? null : mesh.material);
  });
  return { geoms, materials };
}

/**
 * Merge many transformed copies of a variant into single geometries
 * (fewer draw calls than InstancedMesh when counts are small).
 */
export function mergeInstances(
  lib: PropLibrary,
  key: string,
  matrices: THREE.Matrix4[],
  opts: { shadow?: boolean } = {},
): THREE.Mesh[] {
  const src = lib.getVariant(key);
  if (!src || matrices.length === 0) return [];
  return src.geoms.map((geo, i) => {
    const parts = matrices.map((m) => {
      const g = geo.clone();
      g.applyMatrix4(m);
      return g;
    });
    const merged = mergeGeometries(parts, false)!;
    for (const p of parts) p.dispose();
    const mesh = new THREE.Mesh(merged, src.materials[i] ?? new THREE.MeshStandardMaterial({ color: 0x777777 }));
    mesh.castShadow = opts.shadow !== false;
    mesh.receiveShadow = true;
    return mesh;
  });
}

/** Random rotation matrix helper for scatter placement. */
export function scatterMatrix(
  x: number, y: number, z: number,
  scale: number,
  yaw: number,
  tiltZ = 0,
  tiltX = 0,
): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, yaw, tiltZ));
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    q,
    new THREE.Vector3(scale, scale, scale),
  );
}
