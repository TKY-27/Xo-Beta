/**
 * Asset pipeline: manifest-driven loading of redistributed CC0/permissively
 * licensed assets (PBR texture sets, HDRI skies, GLB models, WAV samples).
 * Everything under public/assets is locally managed — no runtime CDNs.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const BASE = `${import.meta.env.BASE_URL ?? '/'}assets/`;

export interface TextureSet {
  color?: THREE.Texture;
  normal?: THREE.Texture;
  rough?: THREE.Texture;
}

export interface GltfAsset {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export type ProgressFn = (pct: number, label: string) => void;

interface LoadState {
  textures: Map<string, THREE.Texture>;
  textureSets: Map<string, TextureSet>;
  hdrs: Map<string, THREE.Texture>;
  gltfs: Map<string, GltfAsset>;
  audio: Map<string, ArrayBuffer>;
}

const state: LoadState = {
  textures: new Map(),
  textureSets: new Map(),
  hdrs: new Map(),
  gltfs: new Map(),
  audio: new Map(),
};

let gltfLoader: GLTFLoader | null = null;
function loader(): GLTFLoader {
  if (!gltfLoader) gltfLoader = new GLTFLoader();
  return gltfLoader;
}

export function texUrl(rel: string): string {
  return `${BASE}textures/${rel}`;
}
export function skyUrl(name: string): string {
  return `${BASE}sky/${name}`;
}
export function modelUrl(rel: string): string {
  return `${BASE}models/${rel}`;
}
export function audioUrl(rel: string): string {
  return `${BASE}audio/${rel}`;
}

/** Load a single image texture (sRGB for color maps). */
export async function loadTexture(key: string, rel: string, srgb = true): Promise<THREE.Texture> {
  const cached = state.textures.get(key);
  if (cached) return cached;
  const tex = await new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load(texUrl(rel), resolve, undefined, reject);
  });
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  else tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  state.textures.set(key, tex);
  return tex;
}

/** Load a basecolor/normal/roughness triple from textures/<dir>/{color,normal,rough}.jpg */
export async function loadTextureSet(dir: string): Promise<TextureSet> {
  const cached = state.textureSets.get(dir);
  if (cached) return cached;
  const set: TextureSet = {};
  const jobs: Array<Promise<void>> = [];
  const grab = (slot: 'color' | 'normal' | 'rough', file: string, srgb: boolean) => {
    jobs.push(
      loadTexture(`${dir}/${slot}`, `${dir}/${file}`, srgb)
        .then((t) => { set[slot] = t; })
        .catch(() => { /* optional slot */ }),
    );
  };
  grab('color', 'color.jpg', true);
  grab('normal', 'normal.jpg', false);
  grab('rough', 'rough.jpg', false);
  await Promise.all(jobs);
  state.textureSets.set(dir, set);
  return set;
}

/** Load an HDRI (.hdr) as equirectangular float texture. */
export async function loadHdri(name: string): Promise<THREE.Texture> {
  const cached = state.hdrs.get(name);
  if (cached) return cached;
  const tex = await new Promise<THREE.Texture>((resolve, reject) => {
    new HDRLoader().load(skyUrl(name), resolve, undefined, reject);
  });
  tex.mapping = THREE.EquirectangularReflectionMapping;
  state.hdrs.set(name, tex);
  return tex;
}

/** Load a GLB/GLTF; returns scene + embedded animation clips. */
export async function loadGltf(rel: string): Promise<GltfAsset> {
  const cached = state.gltfs.get(rel);
  if (cached) return cached;
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const l = loader();
  l.setPath(modelUrl(dir));
  const file = rel.slice(dir.length);
  const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>(
    (resolve, reject) => l.load(file, resolve as never, undefined, reject),
  );
  const asset: GltfAsset = { scene: gltf.scene, animations: gltf.animations };
  state.gltfs.set(rel, asset);
  return asset;
}

/** Fetch raw audio bytes (decode happens in the AudioEngine). */
export async function loadAudioBytes(_rel: string): Promise<AudioBuffer> {
  throw Object.assign(new Error('use AudioEngine.loadSample'), { code: 'use-audio-engine' });
}

export function fetchAudio(rel: string): Promise<ArrayBuffer> {
  const key = rel;
  const cached = state.audio.get(key);
  if (cached) return Promise.resolve(cached);
  return fetch(audioUrl(rel))
    .then((r) => {
      if (!r.ok) throw new Error(`audio ${rel}: ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      state.audio.set(key, buf);
      return buf;
    });
}

/**
 * Preload everything needed before entering a match. Reports progress so
 * the boot screen can show real progress instead of fake steps.
 */
export async function preloadAll(onProgress: ProgressFn): Promise<void> {
  const tasks: Array<{ label: string; run: () => Promise<void> }> = [];

  // PBR texture sets used by the material library
  const TEX_DIRS = [
    'concrete', 'concreteDark', 'asphalt', 'sidewalk', 'metal', 'metalDark',
    'rust', 'corrugated', 'wood', 'woodDark', 'stoneBrick', 'bricksOld',
    'plaster', 'plasterOld', 'grass', 'dirt', 'rock', 'roofTile', 'marble',
    'facadeA', 'facilityFloor',
  ];
  for (const d of TEX_DIRS) {
    tasks.push({ label: `Materials · ${d}`, run: () => loadTextureSet(d).then(() => undefined) });
  }

  // HDRIs (one per map preset)
  for (const h of ['dikhololo_night_2k.hdr', 'kloofendal_overcast_puresky_2k.hdr', 'qwantani_puresky_2k.hdr']) {
    tasks.push({ label: `Lighting · ${h.replace('.hdr', '')}`, run: () => loadHdri(h).then(() => undefined) });
  }

  // Models
  tasks.push({ label: 'Combat rigs', run: () => loadGltf('characters/ual_standard.glb').then(() => undefined) });
  tasks.push({
    label: 'Combatants',
    run: async () => {
      await Promise.all([
        loadGltf('characters/hero_male.gltf'),
        loadGltf('characters/hero_female.gltf'),
      ]);
    },
  });

  let done = 0;
  const total = tasks.length;
  let lastLabel = '';
  const tick = () => {
    done++;
    onProgress(done / total, lastLabel);
  };
  // Run in small concurrent batches to keep the UI responsive.
  const BATCH = 6;
  for (let i = 0; i < total; i += BATCH) {
    const batch = tasks.slice(i, i + BATCH);
    lastLabel = batch[0]!.label;
    onProgress(done / total, lastLabel);
    await Promise.all(batch.map((t) => t.run().then(tick).catch(tick)));
  }
}
