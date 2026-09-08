/**
 * PBR material library built on redistributed CC0 texture sets (ambientCG,
 * see docs/ASSET_MANIFEST.md). Static world surfaces use world-space
 * projection (exact for axis-aligned/yaw-rotated boxes) so instanced
 * geometry never shows texture stretching regardless of instance scale.
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import type { UniformNode } from 'three/webgpu';
import {
  abs, cross, float, normalize, normalWorld, positionWorld, sign, texture,
  transformNormalToView, uniform, vec2, vec3,
} from 'three/tsl';
import { loadTextureSet, type TextureSet } from '../assets/assets';
import type { MatKey } from '../world/types';

/**
 * CYCLE 48: neutral-grey multi-octave grain for ground roughness — the same
 * treatment vista.ts gives the heightfield terrain (shared generator, moved
 * here so the flat ground materials can carry the identical field). Adjacent
 * ground planes (asphalt base / concreteDark roads & lots / paving sidewalks)
 * previously met at razor-straight tone edges with no shared texture
 * character; a common world-projected grain keeps their micro-roughness
 * continuous across plane boundaries so seams read as material change, not
 * decal edges. Values hug the top of the range: base roughness is untouched,
 * only the variation is new information.
 */
export function buildDetailGrainRoughness(): THREE.CanvasTexture | null {
  // Headless/QA environments have no DOM; the detail map is cosmetic.
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const lattice = (x: number, y: number, seed: number): number => {
    const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const noise = (x: number, y: number, period: number, seed: number): number => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const wrap = (v: number, p: number): number => ((v % p) + p) % p;
    const a = lattice(wrap(xi, period), wrap(yi, period), seed);
    const b = lattice(wrap(xi + 1, period), wrap(yi, period), seed);
    const c = lattice(wrap(xi, period), wrap(yi + 1, period), seed);
    const d = lattice(wrap(xi + 1, period), wrap(yi + 1, period), seed);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // CYCLE 54: mid-octave trimmed in favour of the fine octave — the
      // 14-period band read as a combed mid-frequency stripe on grass.
      const n = noise(u * 6, v * 6, 6, 71) * 0.5
        + noise(u * 14, v * 14, 14, 72) * 0.22
        + noise(u * 32, v * 32, 32, 73) * 0.28;
      const shade = THREE.MathUtils.clamp(0.93 + (n - 0.5) * 0.14, 0.84, 1);
      const g = Math.round(shade * 255);
      const i = (y * size + x) * 4;
      image.data[i] = g;
      image.data[i + 1] = g;
      image.data[i + 2] = g;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const textureOut = new THREE.CanvasTexture(canvas);
  textureOut.wrapS = THREE.RepeatWrapping;
  textureOut.wrapT = THREE.RepeatWrapping;
  textureOut.colorSpace = THREE.NoColorSpace;
  textureOut.anisotropy = 8;
  textureOut.needsUpdate = true;
  return textureOut;
}

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
  // CYCLE 31: lifted one step — the old values read as black silhouette
  // rods under backlight (round-6 critic).
  wood: 0x9a9284,
  woodDark: 0x7d766a,
  rust: 0xcfc0b6,
  plaster: 0xb3a892,
  plasterOld: 0xd8d2c6,
  concreteDark: 0x8d9096,
  // CYCLE 62: eden's concrete service paths clipped to snow under the
  // restored direct sun + bloom — darkened a full step.
  concrete: 0x707479,
  // The dirt shoulder under the path ribbons had no tint (white multiplier)
  // and blew out at distance against the sunlit grass.
  dirt: 0x9a8468,
  // CYCLE 62 (review): eden's road ribbon clipped to snow under the restored
  // sun + bloom — the asphalt set had no tint entry (white multiplier).
  asphalt: 0x84878b,
  rock: 0x948e83,
  metalDark: 0x59636d,
  metal: 0x6b7580,
  facadeA: 0xaebcc8,
  facadeB: 0xd6d9d2,
  facadeC: 0xb4bec6,
  // CYCLE 60 (review): darkened one step — the cathedral floor blew near-white
  // under the overcast rig while exteriors sat mid-grey.
  marble: 0xa9a59d,
  facilityFloor: 0xaab2bc,
  sidewalk: 0x9a9da1,
};

function finalize(tex: THREE.Texture): THREE.Texture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
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
 * World-projected Standard node material. Side faces project along their own
 * horizontal tangent (yaw-proof); up/down faces project XZ. Works with
 * InstancedMesh because mapping depends only on world position/normal.
 *
 * TSL port of the former onBeforeCompile triplanar injection: runs natively
 * on the WebGPU renderer and its WebGL2 fallback. The stock `color`,
 * `roughness`, `normalScale`, `map` and `roughnessMap` properties are routed
 * into TSL uniforms/nodes via accessors so existing call sites (per-map
 * retints, weather wetness, polygon-offset clones) keep working unchanged.
 */
class ProjectedStandardMaterial extends MeshStandardNodeMaterial {
  // Uniform nodes are structurally typed here: the Material
  // superconstructor invokes the property setters below, so the nodes must be
  // created lazily, not as class-field initializers.
  private declare tintUniform?: UniformNode<'color', THREE.Color>;
  private declare roughUniform?: UniformNode<'float', number>;
  private declare normalScaleUniform?: UniformNode<'vec2', THREE.Vector2>;
  private declare colorTex?: THREE.Texture;
  private declare roughTex?: THREE.Texture;

  private uniforms(): {
    tint: UniformNode<'color', THREE.Color>;
    rough: UniformNode<'float', number>;
    ns: UniformNode<'vec2', THREE.Vector2>;
  } {
    if (!this.tintUniform) {
      this.tintUniform = uniform(new THREE.Color(0xffffff));
      this.roughUniform = uniform(1);
      this.normalScaleUniform = uniform(new THREE.Vector2(1, 1));
    }
    return {
      tint: this.tintUniform,
      rough: this.roughUniform!,
      ns: this.normalScaleUniform!,
    };
  }

  constructor(
    set?: TextureSet,
    opts: {
      metersPerTile?: number;
      color?: number;
      roughness?: number;
      metalness?: number;
      envMapIntensity?: number;
      normalScale?: number;
      detailRoughMeters?: number;
    } = {},
    detailRough?: THREE.Texture | null,
  ) {
    super({ metalness: opts.metalness ?? 0 });
    // Material.clone() constructs with zero arguments and then copies state
    // through the accessors below — the node graph is rebuilt by copy() when
    // the source had one, so per-map retints, weather wetness and the road/
    // path polygon-offset clones keep their projected texture.
    if (!set) return;
    this.projectionSource = { set, opts, detailRough: detailRough ?? undefined };
    const u = this.uniforms();
    u.tint.value = new THREE.Color(opts.color ?? 0xffffff);
    u.rough.value = opts.roughness ?? 1;
    u.ns.value.set(opts.normalScale ?? 1, opts.normalScale ?? 1);
    this.buildProjectionGraph(set, opts.metersPerTile, detailRough, opts.detailRoughMeters);
    if (opts.envMapIntensity !== undefined) this.envMapIntensity = opts.envMapIntensity;
  }

  /** Set + options the graph was built from; clones re-derive their graph
   * from the source's record via copy(). */
  private declare projectionSource?: {
    set: TextureSet;
    opts: { metersPerTile?: number; color?: number; roughness?: number; metalness?: number; envMapIntensity?: number; normalScale?: number; detailRoughMeters?: number };
    detailRough?: THREE.Texture;
  };
  private declare normalTex?: THREE.Texture;

  override copy(source: THREE.Material): this {
    super.copy(source);
    const src = source as ProjectedStandardMaterial;
    if (src.projectionSource) {
      this.projectionSource = src.projectionSource;
      this.buildProjectionGraph(
        src.projectionSource.set,
        src.projectionSource.opts.metersPerTile,
        src.projectionSource.detailRough,
        src.projectionSource.opts.detailRoughMeters,
      );
    }
    return this;
  }

  /** Build the triplanar node graph sampling the given set, tinted by the
   * CURRENT uniform values (not constructor options) so clones and runtime
   * retints keep their state. `detailRough` (optional) multiplies a shared
   * world-projected grain into the roughness so every material carrying it
   * shares one continuous micro-roughness field — adjacent ground planes
   * keep texture character across their seams. */
  private buildProjectionGraph(
    set: TextureSet,
    metersPerTile?: number,
    detailRough?: THREE.Texture | null,
    detailRoughMeters?: number,
  ): void {
    const u = this.uniforms();
    this.colorTex = set.color ? finalize(set.color.clone()) : undefined;
    this.roughTex = set.rough ? finalize(set.rough.clone()) : undefined;
    this.normalTex = set.normal ? finalize(set.normal.clone()) : undefined;
    const k = uniform(1 / Math.max(0.001, metersPerTile ?? 4));

    // projUv: single-axis pick from the interpolated world normal — exact for
    // axis-aligned/yaw-rotated boxes and stable under instancing.
    const wPos = positionWorld;
    const wNrm = normalize(normalWorld);
    const an = abs(wNrm);
    const uvTop = vec2(wPos.x, wPos.z).mul(k);
    const signX = sign(wNrm.x).abs().lessThan(0.5).select(float(1), sign(wNrm.x));
    const signZ = sign(wNrm.z).abs().lessThan(0.5).select(float(1), sign(wNrm.z));
    const uvSideX = vec2(wPos.z.negate(), wPos.y).mul(k).mul(vec2(signX, float(1)));
    const uvSideZ = vec2(wPos.x, wPos.y).mul(k).mul(vec2(signZ, float(1)));
    const puv = an.y.greaterThanEqual(an.x)
      .and(an.y.greaterThanEqual(an.z))
      .select(uvTop, an.x.greaterThanEqual(an.z).select(uvSideX, uvSideZ));

    if (this.colorTex) this.colorNode = texture(this.colorTex).sample(puv).mul(u.tint);
    if (this.roughTex) {
      const rough = u.rough.mul(texture(this.roughTex).sample(puv).g);
      if (detailRough && detailRoughMeters && detailRoughMeters > 0) {
        // Same projection as the base rough scan, but at the grain's own tile
        // scale — the field stays continuous across every box that shares the
        // material (world-space UVs), which is what softens plane seams.
        const grain = texture(detailRough).sample(
          puv.mul(float(Math.max(0.001, metersPerTile ?? 4) / detailRoughMeters)),
        ).g;
        this.roughnessNode = rough.mul(grain);
      } else {
        this.roughnessNode = rough;
      }
    }
    if (this.normalTex) {
      const mapN = texture(this.normalTex).sample(puv).xyz.mul(2).sub(1);
      const mapNxy = mapN.xy.mul(u.ns);
      // Face-tangent frame derived from the world normal.
      const T0 = normalize(cross(vec3(0.0, 1.0, 0.0), wNrm));
      const flat = abs(wNrm.y).greaterThan(0.99);
      const T = flat.select(vec3(1.0, 0.0, 0.0), T0);
      const B = flat.select(vec3(0.0, 0.0, 1.0), cross(wNrm, T0));
      const wPerturbed = normalize(T.mul(mapNxy.x).add(B.mul(mapNxy.y)).add(wNrm.mul(mapN.z)));
      this.normalNode = transformNormalToView(wPerturbed);
    }
  }

  override get color(): THREE.Color {
    return this.uniforms().tint.value as THREE.Color;
  }

  override set color(v: THREE.Color) {
    this.uniforms().tint.value = v;
  }

  override get roughness(): number {
    return this.uniforms().rough.value as number;
  }

  override set roughness(v: number) {
    this.uniforms().rough.value = v;
  }

  override get normalScale(): THREE.Vector2 {
    return this.uniforms().ns.value as THREE.Vector2;
  }

  override set normalScale(v: THREE.Vector2) {
    this.uniforms().ns.value = v;
  }

  override get map(): THREE.Texture | null {
    return this.colorTex ?? null;
  }

  override set map(v: THREE.Texture | null) {
    // The color node already references this material family's texture set;
    // clone-time reassignments keep the same projection.
    if (v) this.colorTex = v;
  }

  override get roughnessMap(): THREE.Texture | null {
    return this.roughTex ?? null;
  }

  override set roughnessMap(v: THREE.Texture | null) {
    // facilityFloor-style overrides clear the map and fall back to the scalar
    // roughness (kept live through roughUniform).
    if (v === null) {
      this.roughTex = undefined;
      this.roughnessNode = this.uniforms().rough;
    } else {
      this.roughTex = v;
    }
  }
}

export async function createMaterials(): Promise<MaterialLibrary> {
  const mats = new Map<MatKey, THREE.Material>();

  // CYCLE 48: one shared grain field for the flat ground material family
  // (asphalt / sidewalk / concrete / concreteDark / paving). The same 1.2 m
  // grain scale the terrain heightfield uses, so streets, lots and sidewalks
  // share micro-roughness character with the terrain and with each other.
  const groundGrain = buildDetailGrainRoughness();
  // Meters per grain tile. 1.2 matches vista's terrain detail roughness so
  // the in-bounds ground and the surrounding heightfield read as one world.
  const GROUND_GRAIN_METERS = 1.2;
  /** Keys of the ground family carrying the shared grain. */
  const GRAIN_KEYS: ReadonlySet<string> = new Set(['asphalt', 'sidewalk', 'concrete', 'concreteDark', 'paving']);

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
      const m = new ProjectedStandardMaterial(set, {
        metersPerTile: opts.metersPerTile ?? TILE_DENSITY[dir ?? key] ?? 4,
        color: opts.color ?? tint ?? 0xffffff,
        roughness: opts.roughness ?? 1,
        metalness: opts.metalness ?? 0,
        envMapIntensity: opts.envMapIntensity,
        normalScale: opts.normalScale,
        detailRoughMeters: GRAIN_KEYS.has(key) ? GROUND_GRAIN_METERS : undefined,
      }, groundGrain);
      m.name = String(key);
      return m;
    }
    const fallback: Record<string, number> = {
      // CYCLE 62 (review): the pale concrete ribbon read as snow against sunlit
      // grass — warmed/darkened one step.
      concrete: 0x7d8084, concreteDark: 0x74777c, asphalt: 0x60646b, sidewalk: 0x777a7d,
      metal: 0x9aa4ad, metalDark: 0x59636d, rust: 0x7a4a30, corrugated: 0x88929c,
      wood: 0xa07848, woodDark: 0x5f4630, stoneBrick: 0x8d897f, bricksOld: 0x8d6f5f,
      plaster: 0xbfb7a8, plasterOld: 0xb0a48c, grass: 0x5d7a43, dirt: 0x6e5a41,
      rock: 0x76736c, roofTile: 0x8a4a3a, marble: 0xd9d6cf, facadeA: 0x9fb2c0,
      facilityFloor: 0x9aa2ac,
    };
    return new MeshStandardNodeMaterial({
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
  mats.set('asphaltDesert', new MeshStandardNodeMaterial({
    color: 0x4f4a43,
    roughness: 0.97,
    metalness: 0,
    envMapIntensity: 0.24,
  }));
  mats.set('sidewalk', std('sidewalk', 'sidewalk', { roughness: 1 }));
  // Outdoor steel family: weathered, painted or corroded — not clean metal.
  // Metalness ≥0.8 here made every shadowed face crush to near-black (no
  // diffuse term, weak env fill), which the round-3/4 critics flagged as
  // "pure-black unlit faces" on poles, boulder bases and sign panels. Lower
  // metalness keeps the specular character while letting ambient/fill light
  // actually model the shaded side.
  mats.set('metal', std('metal', 'metal', { metalness: 0.55, roughness: 0.68 }));
  mats.set('metalDark', std('metalDark', 'metalDark', { metalness: 0.5, roughness: 0.72 }));
  mats.set('metalExterior', new MeshStandardNodeMaterial({
    color: 0x78838c,
    emissive: 0x151b20,
    emissiveIntensity: 0.12,
    roughness: 0.74,
    metalness: 0.38,
    envMapIntensity: 0.72,
  }));
  // CYCLE 23: rust skips the projected scan. Its instanced pool rendered
  // pure black on WebGPU regardless of albedo/roughness/metalness edits or
  // pipeline rebuilds (healthy scan data verified: color ~(93,45,19), rough
  // ~0.83, textbook normal) — a draw-level r185 instancing fault in the same
  // family as the zero-size uniform-buffer errors recorded in QA_STATE. The
  // flat fallback under the same key renders correctly and reads as painted
  // rusted steel at the distances rust props appear. Retry the scan when
  // three fixes the instancing binding family.
  mats.set('rust', std('rust', undefined, { metalness: 0.2, roughness: 0.88 }));
  mats.set('corrugated', std('corrugated', 'corrugated', { metalness: 0.28 }));
  mats.set('wood', std('wood', 'wood'));
  mats.set('woodDark', std('woodDark', 'woodDark'));
  mats.set('stoneBrick', std('stoneBrick', 'stoneBrick'));
  mats.set('bricksOld', std('bricksOld', 'bricksOld'));
  mats.set('plaster', std('plaster', 'plaster'));
  mats.set('plasterOld', std('plasterOld', 'plasterOld'));
  // ASHARA mud-brick: the concrete set under a warm sand tint so desert
  // compounds stop reading as cool blue-grey slabs against the dunes.
  mats.set('mudbrick', std('mudbrick', 'concrete', {
    color: 0xc4a87e,
    roughness: 0.96,
    metalness: 0,
    metersPerTile: 3.2,
    normalScale: 0.55,
  }));
  mats.set('grass', std('grass', 'grass'));
  mats.set('dirt', std('dirt', 'dirt'));
  mats.set('rock', std('rock', 'rock'));
  mats.set('roofTile', std('roofTile', 'roofTile'));
  // CYCLE 24: roughness 0.45 made oldfront's trims/pier decks read as
  // polished marble under the overcast rig (round-4 critic). Weathered
  // outdoor stone: mostly diffuse, just a hint of sheen.
  mats.set('marble', std('marble', 'marble', { roughness: 0.88 }));
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
  mats.set('interiorCeiling', new MeshStandardNodeMaterial({
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
  mats.set('paint', new MeshStandardNodeMaterial({ color: 0xd9dbd2, roughness: 0.82, metalness: 0 }));
  mats.set('sandbag', new MeshStandardNodeMaterial({ color: 0x9c8b62, roughness: 0.98 }));
  mats.set('hay', new MeshStandardNodeMaterial({ color: 0xb89a55, roughness: 1, metalness: 0 }));
  mats.set('gold', new MeshStandardNodeMaterial({ color: 0xd8b45a, roughness: 0.32, metalness: 0.95 }));
  // NOTE: plain alpha-blend glass. MeshPhysicalMaterial.transmission forces
  // three.js to re-render the whole scene into a refraction buffer every
  // frame (~14ms on the reference GPU) — never worth it at game scale.
  mats.set('glass', new MeshStandardNodeMaterial({
    color: 0x6fa3bd, roughness: 0.3, metalness: 0.1, transparent: true, opacity: 0.42,
    envMapIntensity: 0.55, depthWrite: false,
  }));

  // Neon emissive accents
  const neon = (color: number, intensity: number) =>
    new MeshStandardNodeMaterial({
      color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.1,
    });
  // CYCLE 60 (review): large sign panels bloomed into white slabs at close
  // range — intensities capped so the neon hue survives under 5 m.
  mats.set('neonCyan', neon(0x53e0ff, 1.7));
  mats.set('neonMagenta', neon(0xff53c8, 1.7));
  mats.set('neonOrange', neon(0xff9040, 1.6));
  mats.set('neonGreen', neon(0x54ff9f, 1.7));
  mats.set('neonBlue', neon(0x5f8cff, 2.6));
  // CYCLE 42 (candy-LED finding): night window palettes desaturated toward
  // warm/cool whites — the former saturated orange/cyan panes read as neon
  // billboards. Intensity buckets (bright/normal/dim) let neocity scatter
  // per-window variety through deterministic hash selection; every bucket
  // stays below the 1.62 bloom threshold so panes never blow out.
  mats.set('windowWarm', new MeshStandardNodeMaterial({
    color: 0x33291b,
    emissive: 0xdfc8a2,
    emissiveIntensity: 0.34,
    roughness: 0.68,
    metalness: 0.02,
  }));
  mats.set('windowWarmBright', new MeshStandardNodeMaterial({
    color: 0x33291b,
    emissive: 0xe2cda6,
    emissiveIntensity: 1.1,
    roughness: 0.62,
    metalness: 0.02,
  }));
  mats.set('windowWarmDim', new MeshStandardNodeMaterial({
    color: 0x2a2218,
    emissive: 0xd4c2a0,
    emissiveIntensity: 0.12,
    roughness: 0.74,
    metalness: 0.02,
  }));
  mats.set('windowCool', new MeshStandardNodeMaterial({
    color: 0x18242d,
    emissive: 0xa3b2ba,
    emissiveIntensity: 0.22,
    roughness: 0.7,
    metalness: 0.02,
  }));
  mats.set('windowCoolBright', new MeshStandardNodeMaterial({
    color: 0x18242d,
    emissive: 0xaab9c0,
    emissiveIntensity: 0.8,
    roughness: 0.64,
    metalness: 0.02,
  }));
  mats.set('windowCoolDim', new MeshStandardNodeMaterial({
    color: 0x141e26,
    emissive: 0x9aa9b2,
    emissiveIntensity: 0.09,
    roughness: 0.76,
    metalness: 0.02,
  }));
  // Occupied-dark facade window: unlit glass behind a dim interior, still
  // distinct from a wall hole. Presentation-only, below the bloom threshold.
  mats.set('windowDark', new MeshStandardNodeMaterial({
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
      groundGrain?.dispose();
    },
  };
}
