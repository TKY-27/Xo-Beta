/**
 * PropLibrary: loads redistributed GLB model assets (CC0 — Quaternius,
 * Kenney; see docs/ASSET_MANIFEST.md) and prepares render-ready resources:
 * per-variant merged geometry for mass-instanced vegetation/rocks and
 * template groups for vehicles/weapons.
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadGltf } from '../assets/assets';

/**
 * Rebuild a GLTF-loader plain standard material as its node-material twin.
 * On the WebGPU backend, plain MeshStandardMaterial on InstancedMesh draws
 * loses ambient/hemisphere/env fill (direct sun works, shade crushes to
 * void-black) — node materials render the same inputs correctly. Used at
 * every GLB ingest point so props/vehicles never hit the broken path.
 */
export function toNodeStandard(mat: THREE.MeshStandardMaterial): MeshStandardNodeMaterial {
  const node = new MeshStandardNodeMaterial({
    color: mat.color.clone(),
    map: mat.map ?? null,
    normalMap: mat.normalMap ?? null,
    roughnessMap: mat.roughnessMap ?? null,
    metalnessMap: mat.metalnessMap ?? null,
    aoMap: mat.aoMap ?? null,
    emissive: mat.emissive.clone(),
    emissiveMap: mat.emissiveMap ?? null,
    emissiveIntensity: mat.emissiveIntensity,
    roughness: mat.roughness,
    metalness: mat.metalness,
    envMapIntensity: mat.envMapIntensity,
    transparent: mat.transparent,
    opacity: mat.opacity,
    alphaTest: mat.alphaTest,
    side: mat.side,
    name: mat.name,
  });
  node.normalScale.copy(mat.normalScale);
  node.aoMapIntensity = mat.aoMapIntensity;
  return node;
}

export interface InstancedProp {
  /** One mesh per material bucket; instance matrices applied at build time. */
  build(count: number): THREE.InstancedMesh[];
  readonly buckets: number;
}

/**
 * Shared lazily-built canvas textures for the organic prop passes below
 * (one GPU upload each, reused by every variant that needs them).
 */
let leafVeinNormalTex: THREE.CanvasTexture | null = null;
let barkStreakRoughTex: THREE.CanvasTexture | null = null;

/**
 * Procedural leaf-vein tangent-space normal map. The pattern is generated
 * per-pixel from phase-locked sinusoids whose frequencies are whole cycles
 * across the canvas, so the texture tiles seamlessly without relying on
 * texture.repeat (node-material UV transforms differ per backend). Two
 * diagonal vein systems at different densities read as leaf ribbing at
 * gameplay distances while staying invisible up close (normalScale 0.55).
 * Verified: MeshLambertMaterial renders normalMap through the r185 node path
 * (MeshLambertNodeMaterial → materialNormal reads material.normalMap), so the
 * foliage stays on the cheap Lambert shader instead of the full PBR stack.
 * Returns null in headless/DOM-less environments (unit tests, workers) —
 * the plain lambert response is the pre-existing fallback there.
 */
function leafVeinNormalTexture(): THREE.CanvasTexture | null {
  if (leafVeinNormalTex) return leafVeinNormalTex;
  if (typeof document === 'undefined') return null;
  const s = 256;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(s, s);
  const d = img.data;
  // Diagonal vein directions (radians) and integer cycle counts — whole
  // cycles keep the wrap seamless.
  const a1 = 0.62, a2 = -0.55, cycles1 = 5, cycles2 = 9;
  const c1 = Math.cos(a1), s1 = Math.sin(a1);
  const c2 = Math.cos(a2), s2 = Math.sin(a2);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const t1 = ((x * c1 + y * s1) / s) * Math.PI * 2 * cycles1;
      const t2 = ((x * c2 + y * s2) / s) * Math.PI * 2 * cycles2;
      // Crest of each vein (sharp) plus a narrower groove offset in phase.
      const crest = Math.pow(Math.max(0, Math.sin(t1)), 6) * 0.75
        + Math.pow(Math.max(0, Math.sin(t2)), 6) * 0.45;
      const groove = Math.pow(Math.max(0, Math.sin(t1 + 1.1)), 14) * 0.55
        + Math.pow(Math.max(0, Math.sin(t2 + 1.2)), 14) * 0.3;
      // Micro cell noise so the ramp is not perfectly smooth.
      const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const jitter = ((n - Math.floor(n)) - 0.5) * 10;
      const r = 128 + crest * 62 - groove * 52 + jitter;
      const g = 128 + crest * 58 - groove * 48 + jitter * 0.6;
      const i = (y * s + x) * 4;
      d[i] = Math.max(0, Math.min(255, r));
      d[i + 1] = Math.max(0, Math.min(255, g));
      d[i + 2] = 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'leafVeinNormal';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  leafVeinNormalTex = tex;
  return tex;
}

/**
 * Procedural bark-streak roughness map for dead-tree trunks: vertical
 * fibrous streaks (rough crevices, slightly polished ridges) with wrap-safe
 * whole-cycle frequencies. Encoded in the green channel as three.js reads
 * roughnessMap.g; consumed at roughness=1 so the map carries the full range.
 * Returns null in headless/DOM-less environments (unit tests, workers).
 */
function barkStreakRoughTexture(): THREE.CanvasTexture | null {
  if (barkStreakRoughTex) return barkStreakRoughTex;
  if (typeof document === 'undefined') return null;
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(s, s);
  const d = img.data;
  const cyclesX = 12, freqY = Math.PI * 2 * 3 / s;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // Vertical streak field: per-column hash depth + slow vertical wobble.
      const col = Math.sin((x / s) * Math.PI * 2 * cyclesX) * 0.5 + 0.5;
      const wob = Math.sin(y * freqY + x * 0.21) * 0.5 + 0.5;
      const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      const grain = n - Math.floor(n);
      let v = 118 + col * 52 + wob * 34 + grain * 34;
      // A few bright (smoother) weathered ridges crossing the streaks.
      v -= Math.pow(Math.max(0, Math.sin(y * freqY * 1.0 + x * 0.05)), 8) * 26;
      const i = (y * s + x) * 4;
      const b = Math.max(60, Math.min(235, v));
      d[i] = b;
      d[i + 1] = b;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'barkStreakRough';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  barkStreakRoughTex = tex;
  return tex;
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
    for (const n of ['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'CommonTree_4', 'CommonTree_5']) {
      jobs.push(loadGltf(`nature/${n}.gltf`).then((a) => {
        // Keep the authored canopy intact. Duplicating the complete leaf mesh
        // three times produced detached, intersecting canopy shells and 4x
        // masked overdraw, visible as large black cards in OLD FRONT.
        this.variants.set(`tree/${n}`, reviveCutoutFoliage(neutralizeGreenBark(neutralizeRedBlossoms(extractGeometries(a.scene)))));
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
      const v = softenRockNormals(extractGeometries(a.scene));
      // Preserve the 2K rock atlas' midtones. The former 0.45 multiplier
      // crushed the shaded face to near-black before biome retoning could
      // recover it, especially under OLD FRONT's overcast sky.
      tintMaterials(v, 0.7, 0.68, 0.65);
      this.variants.set('rock/medium1', v);
    }));
    jobs.push(loadGltf('nature/Rock_Medium_2.gltf').then((a) => {
      const v = softenRockNormals(extractGeometries(a.scene));
      tintMaterials(v, 0.7, 0.68, 0.65);
      this.variants.set('rock/medium2', v);
    }));

    // Vehicle + weapon templates
    for (const v of ['sedan', 'suv', 'van', 'truck', 'taxi', 'police', 'delivery-flat', 'hatchback-sports', 'race-future']) {
      jobs.push(loadGltf(`vehicles/${v}.glb`).then((a) => {
        a.scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh || !mesh.material) return;
          const swap = (m: THREE.Material): THREE.Material =>
            m instanceof THREE.MeshStandardMaterial ? toNodeStandard(m) : m;
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map(swap)
            : swap(mesh.material);
        });
        this.templates.set(`vehicle/${v}`, a.scene);
      }));
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
      const mat = src.materials[i] ?? new MeshStandardNodeMaterial({ color: 0x5d7a43 });
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
 * The source boulders ship with a hard normal per low-poly face. Preserve
 * genuine silhouette breaks while blending broad adjacent planes, letting the
 * atlas/bump response describe stone instead of a uniformly faceted toy.
 */
function softenRockNormals(v: { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] }): { geoms: THREE.BufferGeometry[]; materials: (THREE.Material | null)[] } {
  v.geoms = v.geoms.map((geometry) => {
    const position = geometry.getAttribute('position');
    // Add centimetre-scale deterministic breakup along a radial direction.
    // Duplicate face vertices receive the same offset because it depends only
    // on position, so the pass cannot tear seams in the imported mesh.
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const rx = x;
      const ry = y - 0.78;
      const rz = z;
      const invRadius = 1 / Math.max(0.001, Math.hypot(rx, ry, rz));
      const breakup = Math.sin(x * 4.37 + y * 3.13 + z * 5.61) * 0.034
        + Math.sin(x * 9.17 - y * 6.03 + z * 7.43) * 0.014;
      position.setXYZ(
        i,
        x + rx * invRadius * breakup,
        y + ry * invRadius * breakup,
        z + rz * invRadius * breakup,
      );
    }
    position.needsUpdate = true;
    const softened = toCreasedNormals(geometry, Math.PI * 0.38);
    geometry.dispose();
    return softened;
  });
  return v;
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

    // Restore the exact source alpha mask while retaining the bled RGB in a
    // DataTexture. CanvasTexture premultiplies fully transparent pixels back
    // to black; the former residual-alpha workaround then crossed alphaTest
    // in lower mips and rendered a grey/black halo around whole canopies.
    const bled = ctx.getImageData(0, 0, w, h);
    const bd = bled.data;
    const pixels = new Uint8Array(bd.length);
    pixels.set(bd);
    for (let i = 3; i < d.length; i += 4) {
      pixels[i] = d[i]!;
    }

    const tex = new THREE.DataTexture(pixels, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.name = source.name;
    tex.flipY = source.flipY;
    tex.colorSpace = source.colorSpace;
    tex.wrapS = source.wrapS;
    tex.wrapT = source.wrapT;
    tex.anisotropy = 16;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
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
    const materialIdentity = `${(mat as THREE.MeshStandardMaterial | null)?.name ?? ''}|${(mat as THREE.MeshStandardMaterial & { map?: THREE.Texture } | null)?.map?.name ?? ''}`;
    // Foliage (alpha-cutout organic materials) renders through MeshLambert:
    // visually equivalent for matte organic surfaces, ~20% cheaper per
    // shaded pixel than the full PBR stack — foliage dominates the fragment
    // load on forest maps (measured on the reference GPU).
    if (mat instanceof THREE.MeshStandardMaterial && mat.alphaTest > 0) {
      const organicCutout = !/bark/i.test(materialIdentity);
      const lambert = new THREE.MeshLambertMaterial({
        map: mat.map,
        color: mat.color.clone(),
        // The kit's 0.2 cutoff exposes too much filtered transparent border
        // around leaves/flowers at distance. Bark is also tagged MASK despite
        // using an opaque atlas, so preserve its authored value.
        alphaTest: organicCutout ? Math.max(0.42, mat.alphaTest) : mat.alphaTest,
        side: mat.side, fog: true,
      });
      lambert.name = mat.name;
      if (organicCutout) {
        // CYCLE 42 (paper-cutout finding): the flat lambert response made
        // every leaf card read as flat cardstock. A shared procedural vein
        // normal map gives the canopy micro-relief, and the classic
        // translucency trick (darker base + faint green emissive lift) keeps
        // shaded undersides inside foliage-green instead of crushing black.
        // The 0.9 color multiplier lands BEFORE the per-variant lift tints
        // (addVariant 1.3 / bush tints), so it is a uniform relative -10%
        // across species.
        const veinNormal = leafVeinNormalTexture();
        if (veinNormal) {
          lambert.normalMap = veinNormal;
          lambert.normalScale.set(0.55, 0.55);
        }
        lambert.color.multiplyScalar(0.9);
        lambert.emissive.setHex(0x0a140a);
      }
      mat.dispose();
      mat = lambert;
    }
    // Remaining plain PBR materials (bark, rock, vehicle paint) go through
    // the node twin — see toNodeStandard for the WebGPU instancing bug.
    if (mat instanceof THREE.MeshStandardMaterial) {
      if (/bark/i.test(materialIdentity)) {
        // CYCLE 42 (dead-tree finding): the flat authored roughness made bark
        // read as smooth plastic. Procedural vertical streak roughness at
        // roughness=1 (the map carries the whole range) plus a slightly
        // stronger authored normal response raise trunk contrast.
        const barkRough = barkStreakRoughTexture();
        if (barkRough) {
          mat.roughnessMap = barkRough;
          mat.roughness = 1;
          mat.normalScale.set(1.15, 1.15);
        }
      }
      const node = toNodeStandard(mat);
      mat.dispose();
      mat = node;
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
