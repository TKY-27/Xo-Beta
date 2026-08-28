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

/** Commit a texture rewrite to every material that shared the original map. */
export function applySharedTextureReplacements(
  materials: (THREE.Material | null)[],
  replacements: ReadonlyMap<THREE.Texture, THREE.Texture>,
): void {
  for (const material of materials) {
    const mapped = material as (THREE.Material & { map?: THREE.Texture }) | null;
    const replacement = mapped?.map ? replacements.get(mapped.map) : undefined;
    if (mapped && replacement) {
      mapped.map = replacement;
      mapped.needsUpdate = true;
    }
  }
  // Disposal is delayed until every owner has been redirected.
  for (const source of replacements.keys()) source.dispose();
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
          const v = reviveCutoutFoliage(neutralizeGreenBark(neutralizeRedBlossoms(extractGeometries(a.scene))));
          for (const m of v.materials) {
            const std = m as THREE.MeshStandardMaterial;
            if (std?.color) std.color.multiplyScalar(1.3);
          }
          this.variants.set(key, v);
        }),
      );
    const densifyCanopy = (v: { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] }) => {
      const geoms: THREE.BufferGeometry[] = [];
      const materials: (THREE.Material | null)[] = [];
      // Canopy copies are part of the authored map presentation. A runtime
      // random source made the same map differ between loads and invalidated
      // screenshots/replay comparisons, so derive all transforms from the
      // source geometry index instead.
      const rnd = seededRandom(v.geoms.length * 0x45d9f3b);
      for (let i = 0; i < v.geoms.length; i++) {
        const srcGeo = v.geoms[i];
        const srcMat = v.materials[i];
        if (!srcGeo || !srcMat) continue;
        geoms.push(srcGeo);
        materials.push(srcMat);
        const std = srcMat as THREE.MeshStandardMaterial;
        if (!std.map || !/leaf/i.test(std.map.name ?? '')) continue;
        for (let k = 0; k < 3; k++) {
          const g = srcGeo.clone();
          const m4 = new THREE.Matrix4();
          const q = new THREE.Quaternion().setFromEuler(
            new THREE.Euler((rnd() - 0.5) * 0.9, (rnd() - 0.5) * 1.6, (rnd() - 0.5) * 0.9),
          );
          const sc = 0.5 + rnd() * 0.5;
          m4.compose(
            new THREE.Vector3((rnd() - 0.5) * 4.4, (rnd() - 0.5) * 1.6, (rnd() - 0.5) * 4.4),
            q,
            new THREE.Vector3(sc, sc, sc),
          );
          g.applyMatrix4(m4);
          geoms.push(g);
          materials.push(srcMat);
        }
      }
      v.geoms = geoms;
      v.materials = materials;
      return v;
    };
    for (const n of ['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'CommonTree_4', 'CommonTree_5']) {
      jobs.push(loadGltf(`nature/${n}.gltf`).then((a) => {
        this.variants.set(`tree/${n}`, densifyCanopy(reviveCutoutFoliage(neutralizeGreenBark(neutralizeRedBlossoms(extractGeometries(a.scene))))));
      }));
    }
    for (const n of ['Pine_1', 'Pine_2', 'Pine_3', 'Pine_4']) {
      jobs.push(loadGltf(`nature/${n}.gltf`).then((a) => {
        this.variants.set(`pine/${n}`, reviveCutoutFoliage(neutralizeGreenBark(neutralizeRedBlossoms(extractGeometries(a.scene)))));
      }));
    }
    // Dead trees are bare — no foliage to protect — so remap their mossy
    // green bark textures to weathered brown across the whole map.
    for (const n of ['DeadTree_1', 'DeadTree_4']) {
      jobs.push(loadGltf(`nature/${n}.gltf`).then((a) => {
        this.variants.set(`dead/${n}`, degreenAll(neutralizeRedBlossoms(extractGeometries(a.scene))));
      }));
    }
    jobs.push(loadGltf('nature/DeadTree_2.gltf').then((a) => {
      const v = degreenAll(neutralizeRedBlossoms(extractGeometries(a.scene)));
      tintMaterials(v, 0.88, 0.82, 0.74);
      this.variants.set('dead/DeadTree_2', v);
    }));
    jobs.push(loadGltf('nature/Bush_Common.gltf').then((a) => {
      const v = reviveCutoutFoliage(neutralizeRedBlossoms(extractGeometries(a.scene)));
      tintMaterials(v, 1.45, 1.5, 1.3);
      this.variants.set('bush/common', v);
    }));
    // The flower-bearing GLBs bake saturated red blossom textures; desaturate
    // those maps at load so scattered bushes read as natural rose, not red blobs.
    jobs.push(loadGltf('nature/Bush_Common_Flowers.gltf').then((a) => {
      const v = reviveCutoutFoliage(muteFlowers(extractGeometries(a.scene)));
      tintMaterials(v, 1.5, 1.55, 1.4);
      this.variants.set('bush/flowers', v);
    }));
    addVariant('fern/1', 'nature/Fern_1.gltf');
    addVariant('clover/1', 'nature/Clover_1.gltf');
    jobs.push(loadGltf('nature/Flower_3_Group.gltf').then((a) => {
      this.variants.set('flower/group', muteFlowers(extractGeometries(a.scene)));
    }));
    jobs.push(loadGltf('nature/Rock_Medium_1.gltf').then((a) => {
      const v = extractGeometries(a.scene);
      tintMaterials(v, 0.45, 0.44, 0.42);
      this.variants.set('rock/medium1', v);
    }));
    jobs.push(loadGltf('nature/Rock_Medium_2.gltf').then((a) => {
      const v = extractGeometries(a.scene);
      tintMaterials(v, 0.45, 0.44, 0.42);
      this.variants.set('rock/medium2', v);
    }));

    // Vehicle + weapon templates
    for (const v of ['sedan', 'suv', 'van', 'truck', 'taxi', 'police', 'delivery-flat', 'hatchback-sports', 'race-future']) {
      jobs.push(loadGltf(`vehicles/${v}.glb`).then((a) => { this.templates.set(`vehicle/${v}`, a.scene); }));
    }
    for (const w of [
      'blaster-a', 'blaster-d', 'blaster-e', 'blaster-f', 'blaster-p',
      'scope-large-a', 'silencer-small', 'clip-large', 'clip-small',
    ]) {
      jobs.push(loadGltf(`weapons/${w}.glb`).then((a) => { this.templates.set(`weapon/${w}`, a.scene); }));
    }

    await Promise.all(jobs);
    for (const variant of this.variants.values()) {
      for (const geometry of variant.geoms) geometry.userData.externalShared = true;
      for (const material of variant.materials) {
        if (material) material.userData.externalShared = true;
      }
    }
    for (const template of this.templates.values()) {
      template.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.userData.externalShared = true;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material.userData.externalShared = true;
      });
    }
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
      // The caller may replace the instance matrices after construction;
      // addInstancedByGrid recomputes the aggregate bounds before enabling
      // culling. Keep this conservative until those matrices exist.
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

/**
 * Desaturate blossom textures on flower-bearing props. The source GLBs bake
 * heavily saturated red flowers; a canvas pass at load time pulls them toward
 * a natural muted rose (works regardless of material color setup).
 */
function muteFlowers(v: { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] }): { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] } {
  const replacements = new Map<THREE.Texture, THREE.Texture>();
  for (const m of v.materials) {
    const std = m as THREE.MeshStandardMaterial & { map?: THREE.Texture };
    if (!std?.map || !std.map.source?.data) continue;
    const source = std.map;
    if (replacements.has(source)) continue;
    const srcImg = source.source.data as ImageBitmap | HTMLImageElement;
    const w = 'width' in srcImg ? srcImg.width : 0;
    const h = 'height' in srcImg ? srcImg.height : 0;
    if (!w || !h) continue;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.filter = 'none';
    ctx.drawImage(srcImg, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!, g = d[i + 1]!, bl = d[i + 2]!;
      if (r > 120 && r > g * 1.45 && r > bl * 1.45) {
        const lum = (r * 0.4 + g * 0.35 + bl * 0.25) / 255;
        d[i] = 150 + lum * 90;
        d[i + 1] = 110 + lum * 70;
        d[i + 2] = 120 + lum * 70;
      } else {
        const lum = (r * 0.3 + g * 0.5 + bl * 0.2) / 255;
        if (lum < 0.3) {
          const k = 0.3 / Math.max(lum, 0.02);
          const kk = Math.min(2.2, k);
          d[i] = Math.min(255, r * kk);
          d[i + 1] = Math.min(255, g * kk);
          d[i + 2] = Math.min(255, bl * kk);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = source.flipY;
    tex.colorSpace = source.colorSpace;
    tex.wrapS = source.wrapS;
    tex.wrapT = source.wrapT;
    replacements.set(source, tex);
  }
  applySharedTextureReplacements(v.materials, replacements);
  return v;
}

/**
 * Bush/undergrowth cutout textures are authored as flat dark-olive blobs on
 * pure black at ~50% coverage. GPU mip generation then averages black into
 * every filtered sample, so mid-distance bushes collapse into near-black
 * mush even when texel-level colors and lighting look acceptable (proven by
 * framebuffer inspection during foliage QA). Repair at load time:
 *  1. re-tone opaque texels — lift luminance, add a vertical light gradient
 *     plus low/high-frequency jitter so the flat authored color gains depth
 *  2. bleed RGB outward into transparent texels (alpha preserved) so mip
 *     averages stay foliage-green instead of collapsing toward black
 *  3. enable anisotropic filtering for grazing-angle leaf cards
 */
function reviveCutoutFoliage(v: { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] }): { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] } {
  const seen = new Set<THREE.Texture>();
  const replacements = new Map<THREE.Texture, THREE.Texture>();
  for (const m of v.materials) {
    const mat = m as THREE.MeshLambertMaterial & { map?: THREE.Texture };
    if (!mat?.map || !mat.alphaTest || seen.has(mat.map)) continue;
    const source = mat.map;
    seen.add(source);
    const srcImg = source.source?.data as ImageBitmap | HTMLImageElement | undefined;
    const w = srcImg && 'width' in srcImg ? srcImg.width : 0;
    const h = srcImg && 'height' in srcImg ? srcImg.height : 0;
    if (!srcImg || !w || !h || w > 2048) continue;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) continue;
    ctx.drawImage(srcImg, 0, 0);
    let img: ImageData;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch {
      continue;
    }
    const d = img.data;
    // Only cutout textures with a meaningful transparent share need repair.
    let holes = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i]! < 128) holes++;
    }
    if (holes < d.length / 4 / 20) continue;

    // Pass 1 — re-tone opaque texels.
    for (let y = 0; y < h; y++) {
      // Vertical gradient: canopy tops catch light, undersides stay deep.
      // Keep it restrained; the earlier blue suppression produced neon lime
      // pines under Eden's strong daylight.
      const grad = 1.08 - 0.25 * (y / h);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3]! < 128) continue;
        const n1 = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const jitter = 0.92 + 0.16 * (n1 - Math.floor(n1));
        const k = grad * jitter;
        const r = d[i]! * k;
        const g = d[i + 1]! * k;
        const b = d[i + 2]! * k;
        const lum = r * 0.25 + g * 0.55 + b * 0.2;
        // Gentle desaturation preserves species texture while pulling the
        // chartreuse source art toward a believable evergreen/leaf value.
        d[i] = Math.min(255, r * 0.82 + lum * 0.18);
        d[i + 1] = Math.min(255, g * 0.76 + lum * 0.24);
        d[i + 2] = Math.min(255, b * 0.88 + lum * 0.12);
      }
    }
    ctx.putImageData(img, 0, 0);

    // Pass 2 — RGB bleed: stamp progressively larger offset copies beneath
    // existing pixels so transparent zones inherit nearby foliage color.
    ctx.globalCompositeOperation = 'destination-over';
    for (const off of [3, 7, 14, 24, 38]) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        ctx.drawImage(canvas, Math.round(Math.cos(ang) * off), Math.round(Math.sin(ang) * off));
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // Restore the original alpha mask, EXCEPT bled holes keep a small
    // residual alpha: canvas storage is premultiplied, so alpha=0 would
    // erase the bled RGB (the texture would upload black holes again and
    // the mip chain would collapse to near-black). 36/255 ≈ 0.14 stays
    // below the 0.2 alphaTest — silhouette at mip 0 is unchanged — while
    // preserving foliage color for mip filtering.
    const bled = ctx.getImageData(0, 0, w, h);
    const bd = bled.data;
    for (let i = 3; i < d.length; i += 4) {
      bd[i] = d[i]! < 128 ? 36 : d[i]!;
    }
    ctx.putImageData(bled, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = source.flipY;
    tex.colorSpace = source.colorSpace;
    tex.wrapS = source.wrapS;
    tex.wrapT = source.wrapT;
    tex.anisotropy = 4;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    replacements.set(source, tex);
  }
  applySharedTextureReplacements(v.materials, replacements);
  return v;
}

/**
 * The nature kit shares blossom textures across many bush/flower props, so
 * muting only the flower-bearing GLBs leaves red speckles on the rest. This
 * pass remaps saturated-red pixels toward foliage green on every nature
 * variant map, leaving bark/leaf/rock pixels untouched.
 */
function neutralizeRedBlossoms(v: { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] }): { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] } {
  const seen = new Set<THREE.Texture>();
  const replacements = new Map<THREE.Texture, THREE.Texture>();
  for (const m of v.materials) {
    const std = m as THREE.MeshStandardMaterial & { map?: THREE.Texture };
    if (!std?.map || seen.has(std.map)) continue;
    const source = std.map;
    seen.add(source);
    const srcImg = source.source?.data as ImageBitmap | HTMLImageElement | undefined;
    const w = srcImg && 'width' in srcImg ? srcImg.width : 0;
    const h = srcImg && 'height' in srcImg ? srcImg.height : 0;
    if (!srcImg || !w || !h || w > 2048) continue;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) continue;
    ctx.drawImage(srcImg, 0, 0);
    let img: ImageData;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch {
      continue;
    }
    const d = img.data;
    let touched = false;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
      if (r > 130 && r > g * 1.55 && r > b * 1.5 && g < 140) {
        // The common-bush atlas is almost pure dark red, so a relative-only
        // transform produced near-black olive cards. Map that authored mask
        // into a mid-value forest green while retaining its value variation.
        d[i] = r * 0.36;
        d[i + 1] = Math.min(255, 70 + r * 0.22 + g * 0.4);
        d[i + 2] = Math.min(255, 38 + b * 0.2);
        touched = true;
      }
    }
    if (!touched) continue;
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = source.flipY;
    tex.colorSpace = source.colorSpace;
    tex.wrapS = source.wrapS;
    tex.wrapT = source.wrapT;
    replacements.set(source, tex);
  }
  applySharedTextureReplacements(v.materials, replacements);
  return v;
}

/**
 * Some Kenney nature-kit bark UV regions sample mossy green atlas areas, so
 * certain trunks render alien-green. Bark buckets are the alphaTest===0
 * materials (foliage uses alpha cutout); remap green-dominant bark pixels
 * toward weathered brown. Leaves are never touched (different buckets).
 */
function neutralizeGreenBark(v: { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] }): { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] } {
  const seen = new Set<THREE.Texture>();
  const replacements = new Map<THREE.Texture, THREE.Texture>();
  for (const m of v.materials) {
    const mat = m as THREE.MeshLambertMaterial & { map?: THREE.Texture };
    if (!mat?.map || seen.has(mat.map)) continue;
    const source = mat.map;
    seen.add(source);
    const srcImg = source.source?.data as ImageBitmap | HTMLImageElement | undefined;
    const w = srcImg && 'width' in srcImg ? srcImg.width : 0;
    const h = srcImg && 'height' in srcImg ? srcImg.height : 0;
    if (!srcImg || !w || !h || w > 2048) continue;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) continue;
    ctx.drawImage(srcImg, 0, 0);
    let img: ImageData;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch {
      continue;
    }
    const d = img.data;
    // Leafy cutout textures carry transparent pixels — never touch those.
    // Fully opaque green textures are bark (mossy trunks) and get remapped.
    let transparent = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i]! < 200) transparent++;
    }
    if (transparent > d.length / 4 / 100) continue;
    let touched = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
      if (g > 55 && g > r * 1.22 && g > b * 1.15) {
        d[i] = g * 0.78;
        d[i + 1] = g * 0.66;
        d[i + 2] = g * 0.35;
        touched++;
      }
    }
    // Only swap the texture when a meaningful share of bark was green.
    if (touched < w * h * 0.005) continue;
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = source.flipY;
    tex.colorSpace = source.colorSpace;
    tex.wrapS = source.wrapS;
    tex.wrapT = source.wrapT;
    replacements.set(source, tex);
  }
  applySharedTextureReplacements(v.materials, replacements);
  return v;
}

/**
 * Aggressive green→brown remap for BARE models (dead trees): every
 * green-dominant pixel becomes bark brown. Not safe for leafy variants.
 */
function degreenAll(v: { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] }): { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] } {
  const seen = new Set<THREE.Texture>();
  const replacements = new Map<THREE.Texture, THREE.Texture>();
  for (const m of v.materials) {
    const mat = m as THREE.MeshLambertMaterial & { map?: THREE.Texture };
    if (!mat?.map || seen.has(mat.map)) continue;
    const source = mat.map;
    seen.add(source);
    const srcImg = source.source?.data as ImageBitmap | HTMLImageElement | undefined;
    const w = srcImg && 'width' in srcImg ? srcImg.width : 0;
    const h = srcImg && 'height' in srcImg ? srcImg.height : 0;
    if (!srcImg || !w || !h || w > 2048) continue;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) continue;
    ctx.drawImage(srcImg, 0, 0);
    let img: ImageData;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch {
      continue;
    }
    const d = img.data;
    let touched = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
      if (g > 45 && g > r * 1.12 && g > b * 1.08) {
        d[i] = g * 0.72;
        d[i + 1] = g * 0.6;
        d[i + 2] = g * 0.34;
        touched++;
      }
    }
    if (touched < 64) continue;
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = source.flipY;
    tex.colorSpace = source.colorSpace;
    tex.wrapS = source.wrapS;
    tex.wrapT = source.wrapT;
    replacements.set(source, tex);
  }
  applySharedTextureReplacements(v.materials, replacements);
  return v;
}

/** Multiply every variant material color (values may exceed 1 to lift dark albedos). */
function tintMaterials(v: { materials: (THREE.Material | null)[] }, r: number, g: number, b: number): void {
  const k = new THREE.Color(r, g, b);
  for (const m of v.materials) {
    if (m && (m as THREE.MeshLambertMaterial).color) {
      (m as THREE.MeshLambertMaterial).color.multiply(k);
    }
  }
}

/** Split a GLTF scene into flat geometries + matching materials. */
export function extractGeometries(root: THREE.Object3D): { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] } {
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
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    geoms.push(geo);
    let mat = Array.isArray(mesh.material) ? mesh.material[0] ?? null : mesh.material;
    // Foliage (alpha-cutout organic materials) renders through MeshLambert:
    // visually equivalent for matte organic surfaces, ~20% cheaper per
    // shaded pixel than the full PBR stack — foliage dominates the fragment
    // load on forest maps (measured on the reference GPU).
    if (mat instanceof THREE.MeshStandardMaterial && mat.alphaTest > 0) {
      const lambert = new THREE.MeshLambertMaterial({
        map: mat.map, color: mat.color.clone(), alphaTest: mat.alphaTest,
        side: mat.side, fog: true,
      });
      mat.dispose();
      mat = lambert;
    }
    materials.push(mat);
  });
  // GLTF trees are a hierarchy: the trunk and canopy occupy different mesh
  // nodes. Normalizing each node independently moves leaves to the ground.
  // Compute one minimum over the complete asset and apply one translation to
  // every part, preserving the authored relative Y positions.
  let minY = Infinity;
  for (const geo of geoms) {
    geo.computeBoundingBox();
    minY = Math.min(minY, geo.boundingBox?.min.y ?? Infinity);
  }
  if (Number.isFinite(minY) && Math.abs(minY) > 1e-6) {
    for (const geo of geoms) {
      geo.translate(0, -minY, 0);
      geo.computeBoundingSphere();
    }
  }
  return { geoms, materials };
}

function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
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
