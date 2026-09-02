/**
 * PBR material library built on redistributed CC0 texture sets (ambientCG,
 * see docs/ASSET_MANIFEST.md). Static world surfaces use world-space
 * projection (exact for axis-aligned/yaw-rotated boxes) so instanced
 * geometry never shows texture stretching regardless of instance scale.
 */

import * as THREE from 'three';
import { loadTextureSet, type TextureSet } from '../assets/assets';
import type { MatKey } from '../world/types';

export interface MaterialLibrary {
  get(key: MatKey): THREE.Material;
  /** Raw set access for bespoke prop materials. */
  set(dir: string): Promise<TextureSet>;
  dispose(): void;
}

const TILE_DENSITY: Record<string, number> = {
  // meters per texture tile
  concrete: 3.6, concreteDark: 3.2, asphalt: 2.4, sidewalk: 3.2, grass: 4,
  metal: 2.6, metalDark: 2.6, rust: 2.8, corrugated: 2.2,
  wood: 2.4, woodDark: 2.4, stoneBrick: 3, bricksOld: 3,
  plaster: 4, plasterOld: 4, dirt: 3.2, rock: 3,
  roofTile: 2.6, marble: 4, facadeA: 6,
};

/** Tints applied on top of base color maps (white = untouched). */
const TINTS: Partial<Record<MatKey, number>> = {
  grass: 0xb9c4a9,
  wood: 0x857d6e,
  woodDark: 0x6e675c,
  rust: 0xcfc0b6,
  plaster: 0xb3a892,
  plasterOld: 0xd8d2c6,
  concreteDark: 0x8d9096,
  concrete: 0x9aa0a6,
  rock: 0x948e83,
  metalDark: 0x59636d,
  metal: 0x6b7580,
  facadeA: 0xaebcc8,
  facadeB: 0xd6d9d2,
  facadeC: 0xb4bec6,
  marble: 0xc9c5bd,
  facilityFloor: 0xaab2bc,
  sidewalk: 0x9a9da1,
};

function finalize(tex: THREE.Texture): THREE.Texture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The redistributed asphalt set carries baked red crack-vein markings that
 * read as lava/marble at street scale. Desaturate strongly-red pixels toward
 * their own luminance so cracks stay as value variation without the hue.
 */
function neutralizeRedVeins(tex: THREE.Texture): void {
  const src = tex.source?.data as HTMLImageElement | undefined;
  if (!src || typeof document === 'undefined') return;
  const c = document.createElement('canvas');
  c.width = src.naturalWidth || src.width;
  c.height = src.naturalHeight || src.height;
  if (!c.width || !c.height) return;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
    // Red-dominant texel (veins): pull toward gray, keep a trace of warmth.
    if (r > g + 6 && r > b + 6 && r > 30) {
      const l = 0.35 * r + 0.5 * g + 0.15 * b;
      const k = 0.12;
      d[i] = l + (r - l) * k;
      d[i + 1] = l + (g - l) * k;
      d[i + 2] = l + (b - l) * k;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.source.data = c;
  tex.needsUpdate = true;
}

/**
 * World-projected Standard material. Side faces project along their own
 * horizontal tangent (yaw-proof); up/down faces project XZ. Works with
 * InstancedMesh because mapping depends only on world position/normal.
 */
function makeProjectedMaterial(set: TextureSet, opts: {
  metersPerTile: number;
  color?: number;
  roughness?: number;
  metalness?: number;
  envMapIntensity?: number;
  normalScale?: number;
}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xffffff,
    map: set.color ? finalize(set.color.clone()) : null,
    normalMap: set.normal ? finalize(set.normal.clone()) : null,
    roughnessMap: set.rough ? finalize(set.rough.clone()) : null,
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 0,
    envMapIntensity: opts.envMapIntensity ?? 1,
  });
  if (opts.normalScale !== undefined) mat.normalScale.set(opts.normalScale, opts.normalScale);
  const k = 1 / Math.max(0.001, opts.metersPerTile);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNrm;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vWNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
        #else
          vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWNrm = normalize(mat3(modelMatrix) * objectNormal);
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNrm;
        uniform float uProjScale;
        vec2 projUv(vec3 p, vec3 n) {
          vec3 an = abs(n);
          if (an.y >= an.x && an.y >= an.z) return p.xz * uProjScale;
          if (an.x >= an.z) return vec2(dot(p, vec3(0.0, 0.0, -1.0)), p.y) * uProjScale * vec2(sign(n.x) == 0.0 ? 1.0 : sign(n.x), 1.0);
          return vec2(dot(p, vec3(1.0, 0.0, 0.0)), p.y) * uProjScale * vec2(n.z == 0.0 ? 1.0 : sign(n.z), 1.0);
        }`)
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec2 puv = projUv(vWPos, vWNrm);
          vec4 sampledDiffuseColor = texture2D( map, puv );
          diffuseColor *= sampledDiffuseColor;
        #endif`)
      .replace('#include <normal_fragment_maps>', `
        #if defined( USE_NORMALMAP_TANGENTSPACE )
          vec2 nuv = projUv(vWPos, vWNrm);
          vec3 mapN = texture2D( normalMap, nuv ).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          // perturb along face-tangent frame derived from world normal
          vec3 T = normalize(cross(vec3(0.0,1.0,0.0), normal));
          vec3 B = cross(normal, T);
          if (abs(normal.y) > 0.99) { T = vec3(1.0,0.0,0.0); B = vec3(0.0,0.0,1.0); }
          normal = normalize(T * mapN.x + B * mapN.y + normal * mapN.z);
        #endif`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          vec2 ruv = projUv(vWPos, vWNrm);
          vec4 texelRoughness = texture2D( roughnessMap, ruv );
          roughnessFactor *= texelRoughness.g;
        #endif`);
    shader.uniforms.uProjScale = { value: k };
  };
  mat.customProgramCacheKey = () => 'xoproj';
  return mat;
}

export async function createMaterials(): Promise<MaterialLibrary> {
  const mats = new Map<MatKey, THREE.Material>();

  const dirsByMat: Record<string, string> = {
    concrete: 'concrete', concreteDark: 'concreteDark', asphalt: 'asphalt',
    sidewalk: 'sidewalk', metal: 'metal', metalDark: 'metalDark', rust: 'rust',
    corrugated: 'corrugated', wood: 'wood', woodDark: 'woodDark',
    stoneBrick: 'stoneBrick', bricksOld: 'bricksOld', plaster: 'plaster',
    plasterOld: 'plasterOld', grass: 'grass', dirt: 'dirt', rock: 'rock',
    roofTile: 'roofTile', marble: 'marble', facadeA: 'facadeA',
  };

  const sets = new Map<string, Awaited<ReturnType<typeof loadTextureSet>>>();
  await Promise.all(
    Object.entries(dirsByMat).map(async ([matKey, dir]) => {
      try {
        sets.set(matKey, await loadTextureSet(dir));
      } catch {
        /* missing set falls back to flat material */
      }
    }),
  );

  const std = (
    key: MatKey,
    dir: string | undefined,
    opts: { roughness?: number; metalness?: number; color?: number; envMapIntensity?: number; metersPerTile?: number; normalScale?: number } = {},
  ): THREE.Material => {
    const set = dir ? sets.get(dir) : undefined;
    if (set?.color) {
      const tint = TINTS[key];
      const m = makeProjectedMaterial(set, {
        metersPerTile: opts.metersPerTile ?? TILE_DENSITY[dir ?? key] ?? 4,
        color: opts.color ?? tint ?? 0xffffff,
        roughness: opts.roughness ?? 1,
        metalness: opts.metalness ?? 0,
        envMapIntensity: opts.envMapIntensity,
        normalScale: opts.normalScale,
      });
      m.name = String(key);
      return m;
    }
    const fallback: Record<string, number> = {
      concrete: 0x8f9296, concreteDark: 0x74777c, asphalt: 0x60646b, sidewalk: 0x777a7d,
      metal: 0x9aa4ad, metalDark: 0x59636d, rust: 0x7a4a30, corrugated: 0x88929c,
      wood: 0xa07848, woodDark: 0x5f4630, stoneBrick: 0x8d897f, bricksOld: 0x8d6f5f,
      plaster: 0xbfb7a8, plasterOld: 0xb0a48c, grass: 0x5d7a43, dirt: 0x6e5a41,
      rock: 0x76736c, roofTile: 0x8a4a3a, marble: 0xd9d6cf, facadeA: 0x9fb2c0,
      facilityFloor: 0x9aa2ac,
    };
    return new THREE.MeshStandardMaterial({
      color: fallback[key] ?? 0x888888,
      roughness: opts.roughness ?? 0.9,
      metalness: opts.metalness ?? 0.05,
    });
  };

  mats.set('concrete', std('concrete', 'concrete'));
  mats.set('concreteDark', std('concreteDark', 'concreteDark'));
  {
    const cd = mats.get('concreteDark') as THREE.MeshStandardMaterial;
    cd.color = new THREE.Color(0x3e4248);
    cd.normalScale.set(0.6, 0.6);
  }
  mats.set('asphalt', std('asphalt', 'asphalt'));
  { // Neutralize the baked red crack veins before first use.
    const a = mats.get('asphalt') as THREE.MeshStandardMaterial;
    if (a.map) neutralizeRedVeins(a.map);
    // Night-city asphalt must stay dark or the whole map reads as snow.
    a.color = new THREE.Color(0x4c5057);
    a.normalScale.set(0.35, 0.35);
    a.roughness = 0.98;
  }
  // ASHARA is a high-noon desert. Reusing the blue-hour city asphalt made
  // its highway collapse to a featureless black ribbon. Keep this surface
  // untextured and matte so it retains a warm aggregate value under direct
  // sun; road wear and lane breakup are authored as separate geometry.
  mats.set('asphaltDesert', new THREE.MeshStandardMaterial({
    color: 0x4f4a43,
    roughness: 0.97,
    metalness: 0,
    envMapIntensity: 0.24,
  }));
  mats.set('sidewalk', std('sidewalk', 'sidewalk', { roughness: 1 }));
  mats.set('metal', std('metal', 'metal', { metalness: 0.85, roughness: 0.65 }));
  mats.set('metalDark', std('metalDark', 'metalDark', { metalness: 0.8, roughness: 0.7 }));
  mats.set('metalExterior', new THREE.MeshStandardMaterial({
    color: 0x78838c,
    emissive: 0x151b20,
    emissiveIntensity: 0.12,
    roughness: 0.74,
    metalness: 0.62,
    envMapIntensity: 0.72,
  }));
  mats.set('rust', std('rust', 'rust', { metalness: 0.45 }));
  mats.set('corrugated', std('corrugated', 'corrugated', { metalness: 0.55 }));
  mats.set('wood', std('wood', 'wood'));
  mats.set('woodDark', std('woodDark', 'woodDark'));
  mats.set('stoneBrick', std('stoneBrick', 'stoneBrick'));
  mats.set('bricksOld', std('bricksOld', 'bricksOld'));
  mats.set('plaster', std('plaster', 'plaster'));
  mats.set('plasterOld', std('plasterOld', 'plasterOld'));
  mats.set('grass', std('grass', 'grass'));
  mats.set('dirt', std('dirt', 'dirt'));
  mats.set('rock', std('rock', 'rock'));
  mats.set('roofTile', std('roofTile', 'roofTile'));
  mats.set('marble', std('marble', 'marble', { roughness: 0.45 }));
  mats.set('facadeA', std('facadeA', 'facadeA'));
  mats.set('facadeB', std('facadeB', 'bricksOld'));
  mats.set('facadeC', std('facadeC', 'corrugated', { metalness: 0.15 }));
  {
    // The legacy facilityFloor image is a small green pool-mosaic sheet; at
    // building scale it produced noisy checkerboards on both slab faces. Use
    // the restrained concrete set under the dedicated key, with a cooler tint
    // and matte non-metal response suitable for a research/utility interior.
    const floor = std('facilityFloor', 'concrete', {
      roughness: 0.94,
      metalness: 0,
      envMapIntensity: 0.24,
      color: 0x78838c,
      metersPerTile: 3.6,
      normalScale: 0.45,
    }) as THREE.MeshStandardMaterial;
    floor.roughnessMap = null;
    floor.roughness = 0.94;
    floor.metalness = 0;
    floor.envMapIntensity = 0.24;
  mats.set('facilityFloor', floor);
  }
  // A ceiling needs to remain legible under the deliberately sparse world
  // lighting used inside enterable buildings. Reusing exterior concrete or
  // roof tiles made their high-contrast projected textures collapse into a
  // black checker/grid at grazing angles. Keep this finish matte and mostly
  // untextured, with only a restrained ambient lift; authored beams still
  // carry the building's structural material and provide the visible rhythm.
  mats.set('interiorCeiling', new THREE.MeshStandardMaterial({
    color: 0xb8b1a5,
    emissive: 0x2f2c27,
    emissiveIntensity: 0.34,
    roughness: 0.96,
    metalness: 0,
    envMapIntensity: 0.18,
  }));
  // Modern-city paving: same concrete set, lighter + denser so sidewalks and
  // plazas read as poured slabs rather than the grassy cobblestone 'sidewalk'.
  // Modern-city paving: concrete set retinted dark — the raw concrete albedo
  // is ~10x brighter than asphalt and turns sidewalks into snow under the
  // bluehour rig. 1.8 m/tile keeps the normal readable instead of smeared.
  const paving = std('paving', 'concrete', { roughness: 0.96, color: 0x4a4e52, metersPerTile: 1.8, normalScale: 0.55 });
  mats.set('paving', paving);
  // Crisp traffic paint for lane markings / crosswalks (no texture so dashes
  // stay readable at grazing angles).
  mats.set('paint', new THREE.MeshStandardMaterial({ color: 0xd9dbd2, roughness: 0.82, metalness: 0 }));
  mats.set('sandbag', new THREE.MeshStandardMaterial({ color: 0x9c8b62, roughness: 0.98 }));
  mats.set('hay', new THREE.MeshStandardMaterial({ color: 0xb89a55, roughness: 1, metalness: 0 }));
  mats.set('gold', new THREE.MeshStandardMaterial({ color: 0xd8b45a, roughness: 0.32, metalness: 0.95 }));
  // NOTE: plain alpha-blend glass. MeshPhysicalMaterial.transmission forces
  // three.js to re-render the whole scene into a refraction buffer every
  // frame (~14ms on the reference GPU) — never worth it at game scale.
  mats.set('glass', new THREE.MeshStandardMaterial({
    color: 0x6fa3bd, roughness: 0.3, metalness: 0.1, transparent: true, opacity: 0.42,
    envMapIntensity: 0.55, depthWrite: false,
  }));

  // Neon emissive accents
  const neon = (color: number, intensity: number) =>
    new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.1,
    });
  mats.set('neonCyan', neon(0x53e0ff, 2.6));
  mats.set('neonMagenta', neon(0xff53c8, 2.6));
  mats.set('neonOrange', neon(0xff9040, 2.4));
  mats.set('neonGreen', neon(0x54ff9f, 2.6));
  mats.set('neonBlue', neon(0x5f8cff, 2.6));
  // Lit rooms should read as luminous panes, not white bloom cards. Large
  // window surfaces stay below the bloom threshold so frame detail survives
  // indoors and at street distance; dedicated neon remains the bloom source.
  mats.set('windowWarm', new THREE.MeshStandardMaterial({
    color: 0x33291b,
    emissive: 0xffc47d,
    emissiveIntensity: 0.38,
    roughness: 0.68,
    metalness: 0.02,
  }));
  mats.set('windowCool', new THREE.MeshStandardMaterial({
    color: 0x18242d,
    emissive: 0x86b9d2,
    emissiveIntensity: 0.24,
    roughness: 0.7,
    metalness: 0.02,
  }));
  // Occupied-dark facade window: unlit glass behind a dim interior, still
  // distinct from a wall hole. Presentation-only, below the bloom threshold.
  mats.set('windowDark', new THREE.MeshStandardMaterial({
    color: 0x111a22,
    emissive: 0x2a3b46,
    emissiveIntensity: 0.06,
    roughness: 0.82,
    metalness: 0.05,
  }));
  // Large sign panels: emissive just above the 1.62 bloom threshold so big
  // surfaces glow without blowing out into white slabs.
  mats.set('signDimCyan', neon(0x53e0ff, 1.05));
  mats.set('signDimMagenta', neon(0xff53c8, 1.05));
  mats.set('signDimOrange', neon(0xff9040, 1.0));

  // MaterialLibrary outlives individual matches. WorldView disposal uses
  // this marker to release match-owned geometry/materials without invalidating
  // the shared PBR palette used by the next map.
  for (const material of mats.values()) material.userData.externalShared = true;

  return {
    get(key: MatKey): THREE.Material {
      return mats.get(key) ?? mats.get('concrete')!;
    },
    async set(dir: string) {
      let s = sets.get(dir);
      if (!s) {
        s = await loadTextureSet(dir);
        sets.set(dir, s);
      }
      return s;
    },
    dispose() {
      for (const m of mats.values()) m.dispose();
      mats.clear();
      sets.clear();
    },
  };
}
