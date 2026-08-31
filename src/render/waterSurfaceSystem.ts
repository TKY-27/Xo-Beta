/**
 * Bounded water presentation for the WebGL renderer.
 *
 * This module deliberately owns presentation only.  WaterVolume.surfaceY and
 * terrainHeight remain the simulation contract; the wave field below never
 * feeds physics, movement, projectiles, or networking.
 */

import * as THREE from 'three';
import type { MapDef, WaterVolume, WaterVisualKind } from '../world/types';
import {
  createWaterVisualProfile,
  generateWaveField,
  getWaterQualityConfig,
  type WaterQuality,
  type WaterVisualProfile,
} from './waterWaveField';

export interface WaterSurfaceSystemOptions {
  renderer?: THREE.WebGLRenderer | null;
  quality?: WaterQuality;
  skyColor?: THREE.ColorRepresentation;
  sunColor?: THREE.ColorRepresentation;
  sunDirection?: readonly [number, number, number];
  /** An existing equirectangular environment/background texture, if any. */
  skyTexture?: THREE.Texture | null;
  /** Matches the renderer's equirectangular background rotation. */
  skyRotationY?: number;
  skyIntensity?: number;
}

export interface WaterQaStats {
  quality: WaterQuality;
  volumes: number;
  visibleVolumes: number;
  drawCalls: number;
  triangles: number;
  waveTextureBytes: number;
  depthTextureBytes: number;
  halfFloatWaveData: boolean;
  waveResolution: number;
}

export interface WaterSurfaceHandle {
  readonly group: THREE.Group;
  update(authoritativeTime: number, viewPosition?: THREE.Vector3 | null): void;
  setPresentationTime(time: number): void;
  setQuality(quality: WaterQuality): void;
  getQaStats(): WaterQaStats;
  dispose(): void;
}

export interface WaterlineSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  y: number;
}

/** Trace the actual terrain intersection, never the rectangular volume edge. */
export function traceWaterline(
  heightAt: (x: number, z: number) => number,
  water: WaterVolume,
  spacing = 3,
): WaterlineSegment[] {
  const nx = Math.max(1, Math.ceil((water.maxX - water.minX) / spacing));
  const nz = Math.max(1, Math.ceil((water.maxZ - water.minZ) / spacing));
  const dx = (water.maxX - water.minX) / nx;
  const dz = (water.maxZ - water.minZ) / nz;
  const result: WaterlineSegment[] = [];
  const crossing = (
    ax: number,
    az: number,
    ah: number,
    bx: number,
    bz: number,
    bh: number,
  ): { x: number; z: number } | null => {
    const a = ah - water.surfaceY;
    const b = bh - water.surfaceY;
    if (!Number.isFinite(a) || !Number.isFinite(b) || (a < 0) === (b < 0) || Math.abs(a - b) < 1e-6) return null;
    const t = a / (a - b);
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t };
  };
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x0 = water.minX + ix * dx;
      const x1 = x0 + dx;
      const z0 = water.minZ + iz * dz;
      const z1 = z0 + dz;
      const h00 = heightAt(x0, z0);
      const h10 = heightAt(x1, z0);
      const h11 = heightAt(x1, z1);
      const h01 = heightAt(x0, z1);
      const points = [
        crossing(x0, z0, h00, x1, z0, h10),
        crossing(x1, z0, h10, x1, z1, h11),
        crossing(x1, z1, h11, x0, z1, h01),
        crossing(x0, z1, h01, x0, z0, h00),
      ].filter((point): point is { x: number; z: number } => point !== null);
      for (let i = 0; i + 1 < points.length; i += 2) {
        const a = points[i]!;
        const b = points[i + 1]!;
        if (Math.hypot(b.x - a.x, b.z - a.z) >= 0.05) {
          result.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, y: water.surfaceY });
        }
      }
    }
  }
  return result;
}

export function buildWaterlineRibbonPositions(
  segments: readonly WaterlineSegment[],
  width: number,
  yOffset: number,
): number[] {
  const positions: number[] = [];
  for (const segment of segments) {
    const dx = segment.bx - segment.ax;
    const dz = segment.bz - segment.az;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const nx = -dz / length * width / 2;
    const nz = dx / length * width / 2;
    const y = segment.y + yOffset;
    positions.push(
      segment.ax - nx, y, segment.az - nz,
      segment.bx + nx, y, segment.bz + nz,
      segment.bx - nx, y, segment.bz - nz,
      segment.ax - nx, y, segment.az - nz,
      segment.ax + nx, y, segment.az + nz,
      segment.bx + nx, y, segment.bz + nz,
    );
  }
  return positions;
}

interface WaveFieldData {
  data: Uint8Array | Uint16Array;
  resolution: number;
  bytes: number;
  halfFloat: boolean;
}

interface VisualProfile extends WaterVisualProfile {
  period: number;
  shallow: THREE.Color;
  deep: THREE.Color;
  foam: THREE.Color;
}

interface QualityConfig {
  bands: number;
  resolution: number;
  meshSegments: number;
  nearDistance: number;
  farDistance: number;
  displacement: number;
  chopScale: number;
  foam: number;
}

interface SurfaceEntry {
  root: THREE.Group;
  meshes: THREE.Mesh[];
  foam: THREE.Mesh | null;
  sediment: THREE.Mesh | null;
  materials: THREE.ShaderMaterial[];
  waveTexture: THREE.DataTexture;
  depthTexture: THREE.DataTexture;
  ownedTextures: THREE.Texture[];
  volume: WaterVolume;
  profile: VisualProfile;
  triangleCounts: number[];
  currentLod: number;
}

const EMPTY_SKY = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
EMPTY_SKY.needsUpdate = true;
EMPTY_SKY.colorSpace = THREE.SRGBColorSpace;

const WATER_VERTEX = /* glsl */ `
  uniform sampler2D uWaveTexture;
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uChop;
  uniform float uPeriod;
  uniform float uBands;
  uniform vec2 uWind;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vCrest;

  vec4 waveSample(
    vec2 world,
    float scale,
    float speed,
    vec2 localXAxis,
    vec2 offset,
    out vec2 worldGradient
  ) {
    vec2 localYAxis = vec2(-localXAxis.y, localXAxis.x);
    vec2 p = vec2(dot(world, localXAxis), dot(world, localYAxis));
    vec2 uv = p * scale / uPeriod + uWind * speed * uTime + offset;
    vec4 sampleValue = texture2D(uWaveTexture, uv);
    vec2 localGradient = sampleValue.gb * 2.0 - 1.0;
    // p = R * world, so a texture-space gradient returns to world axes as
    // transpose(R) * gradient. Height, choppiness and highlights now share
    // one correctly oriented displacement field for every rotated band.
    worldGradient = localXAxis * localGradient.x + localYAxis * localGradient.y;
    return sampleValue;
  }

  void main() {
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    float height = 0.0;
    vec2 gradient = vec2(0.0);
    float crest = 0.0;
    vec4 s;
    vec2 bandGradient;
    if (uBands > 0.5) {
      s = waveSample(world.xz, 0.42, 0.20, vec2(0.98558477, -0.16918235), vec2(0.11, 0.37), bandGradient);
      height += (s.r * 2.0 - 1.0) * 0.48;
      gradient += bandGradient * 0.35;
      crest += s.a * 0.25;
    }
    if (uBands > 1.5) {
      s = waveSample(world.xz, 0.95, 0.42, vec2(0.95233357, 0.30505864), vec2(0.53, 0.19), bandGradient);
      height += (s.r * 2.0 - 1.0) * 0.24;
      gradient += bandGradient * 0.57;
      crest += s.a * 0.34;
    }
    if (uBands > 2.5) {
      s = waveSample(world.xz, 2.10, 0.84, vec2(0.74517440, -0.66686964), vec2(0.29, 0.71), bandGradient);
      height += (s.r * 2.0 - 1.0) * 0.12;
      gradient += bandGradient * 1.25;
      crest += s.a * 0.28;
    }
    if (uBands > 3.5) {
      s = waveSample(world.xz, 4.40, 1.38, vec2(0.60582016, 0.79560162), vec2(0.83, 0.43), bandGradient);
      height += (s.r * 2.0 - 1.0) * 0.05;
      gradient += bandGradient * 1.85;
      crest += s.a * 0.13;
    }
    if (uBands > 4.5) {
      s = waveSample(world.xz, 7.80, 2.10, vec2(0.90475166, -0.42593947), vec2(0.67, 0.89), bandGradient);
      height += (s.r * 2.0 - 1.0) * 0.025;
      gradient += bandGradient * 2.35;
      crest += s.a * 0.07;
    }
    if (uBands > 5.5) {
      s = waveSample(world.xz, 13.0, 3.10, vec2(0.77757272, 0.62879302), vec2(0.41, 0.07), bandGradient);
      height += (s.r * 2.0 - 1.0) * 0.012;
      gradient += bandGradient * 2.8;
      crest += s.a * 0.04;
    }
    height *= uAmplitude;
    // A bounded choppy term derived from the very same field keeps crests
    // attached to highlights without folding the finite gameplay surface.
    world.xz += gradient * uAmplitude * uChop;
    world.y += height;
    vWorldPosition = world;
    vCrest = clamp(crest, 0.0, 1.0);
    vWorldNormal = normalize(vec3(-gradient.x * uAmplitude, 1.0, -gradient.y * uAmplitude));
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  uniform sampler2D uWaveTexture;
  uniform sampler2D uDepthTexture;
  uniform sampler2D uSkyTexture;
  uniform float uTime;
  uniform float uPeriod;
  uniform float uBands;
  uniform vec2 uWind;
  uniform float uHasSkyTexture;
  uniform vec2 uMin;
  uniform vec2 uExtent;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uSkyColor;
  uniform float uSkyRotation;
  uniform float uSkyIntensity;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform float uClarity;
  uniform float uRoughness;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vCrest;

  vec2 waterDetailGradient(
    vec2 world,
    float scale,
    float speed,
    vec2 localXAxis,
    vec2 offset
  ) {
    vec2 localYAxis = vec2(-localXAxis.y, localXAxis.x);
    vec2 p = vec2(dot(world, localXAxis), dot(world, localYAxis));
    vec2 uv = p * scale / uPeriod + uWind * speed * uTime + offset;
    vec2 localGradient = texture2D(uWaveTexture, uv).gb * 2.0 - 1.0;
    return localXAxis * localGradient.x + localYAxis * localGradient.y;
  }

  vec3 skyReflection(vec3 direction) {
    if (uHasSkyTexture < 0.5) return uSkyColor;
    float cs = cos(uSkyRotation);
    float sn = sin(uSkyRotation);
    vec3 rotated = vec3(
      cs * direction.x - sn * direction.z,
      direction.y,
      sn * direction.x + cs * direction.z
    );
    vec2 uv = vec2(atan(rotated.z, rotated.x) / 6.2831853 + 0.5,
      0.5 + asin(clamp(rotated.y, -1.0, 1.0)) / 3.1415926);
    return texture2D(uSkyTexture, uv).rgb * uSkyIntensity;
  }

  void main() {
    vec2 localPosition = vWorldPosition.xz - uMin;
    float boundaryDistance = min(
      min(localPosition.x, uExtent.x - localPosition.x),
      min(localPosition.y, uExtent.y - localPosition.y)
    );
    if (boundaryDistance <= 0.0) discard;
    float boundaryFade = smoothstep(0.0, 0.65, boundaryDistance);
    vec2 uv = clamp(localPosition / max(uExtent, vec2(0.001)), 0.0, 1.0);
    float depth = texture2D(uDepthTexture, uv).r;
    if (depth < 0.003) discard;
    // Sub-triangle capillary normals come from the same deterministic field
    // as vertex displacement. Two decorrelated samples break up broad grazing
    // reflections without adding meshes, textures, or camera-relative noise.
    vec2 detailGradient = vec2(0.0);
    if (uBands > 2.5) {
      detailGradient += waterDetailGradient(
        vWorldPosition.xz,
        6.70,
        1.85,
        vec2(0.83205029, 0.55470020),
        vec2(0.17, 0.61)
      ) * 0.32;
    }
    if (uBands > 3.5) {
      detailGradient += waterDetailGradient(
        vWorldPosition.xz,
        11.30,
        2.65,
        vec2(0.51449576, -0.85749293),
        vec2(0.73, 0.23)
      ) * 0.18;
    }
    vec3 n = normalize(vWorldNormal + vec3(-detailGradient.x, 0.0, -detailGradient.y));
    if (!gl_FrontFacing) n = -n;
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float nov = max(dot(n, viewDirection), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - nov, 5.0);
    vec3 sunDirection = normalize(-uSunDirection);
    vec3 halfDirection = normalize(sunDirection + viewDirection);
    float nh = max(dot(n, halfDirection), 0.0);
    float nol = max(dot(n, sunDirection), 0.0);
    float roughness = clamp(uRoughness, 0.08, 0.45);
    float alphaRoughness = roughness * roughness;
    float alphaSquared = alphaRoughness * alphaRoughness;
    float distributionDenominator = nh * nh * (alphaSquared - 1.0) + 1.0;
    float distribution = alphaSquared
      / max(3.1415926 * distributionDenominator * distributionDenominator, 0.001);
    float geometryK = (roughness + 1.0) * (roughness + 1.0) * 0.125;
    float geometryView = nov / max(nov * (1.0 - geometryK) + geometryK, 0.001);
    float geometryLight = nol / max(nol * (1.0 - geometryK) + geometryK, 0.001);
    float ggxSpec = distribution * geometryView * geometryLight
      / max(4.0 * nov * nol, 0.001);
    float glint = pow(nh, 180.0) * (0.006 + 0.035 * vCrest);
    // Water is more transparent at a shallow edge, while deep water absorbs
    // red light first. The depth texture comes from the canonical terrain.
    float shallow = 1.0 - smoothstep(0.08, 0.56, depth);
    vec3 base = mix(uDeepColor, uShallowColor, shallow * 0.86);
    vec3 reflected = skyReflection(reflect(-viewDirection, n));
    vec3 color = mix(base, reflected, fresnel * (0.20 + 0.28 * uClarity));
    color += uSunColor * (min(ggxSpec, 1.25) * nol * 0.07 + glint);
    color += uShallowColor * shallow * 0.045;
    float alpha = mix(0.91, 0.985, fresnel) * mix(0.78, 1.0, depth) * boundaryFade;
    gl_FragColor = vec4(max(color, vec3(0.0)), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const FOAM_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldXZ = world.xz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FOAM_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.7, 113.9))) * 43758.5453); }
  void main() {
    float along = dot(vWorldXZ, vec2(0.73, 0.41));
    float crossWave = sin(dot(vWorldXZ, vec2(-0.19, 0.83)) * 0.47 - uTime * 0.21);
    float breakup = smoothstep(0.20, 0.78,
      sin(along * 0.62 + uTime * 0.34 + crossWave * 1.8) * 0.5 + 0.5);
    breakup *= 0.82 + 0.18 * hash(floor(vWorldXZ * 0.38));
    float edge = 1.0 - smoothstep(0.0, 0.5, abs(vUv.y - 0.5) * 2.0);
    float alpha = breakup * edge * uStrength;
    if (alpha < 0.008) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function profileFor(water: WaterVolume, index: number): VisualProfile {
  const kind: WaterVisualKind = water.visual?.kind ?? 'fallback';
  const profile = createWaterVisualProfile(kind, {
    windDirection: water.visual?.windDirection,
  });
  const colors = kind === 'river'
    ? [0x2a7280, 0x073446, 0xb1d1c7, 50]
    : kind === 'pond'
      ? [0x397d7e, 0x0a3946, 0x9ebeb4, 42]
      : kind === 'lake'
        ? [0x347d83, 0x062d42, 0xa9c9bf, 66]
        : [0x34737e, 0x082d3c, 0x9db9b0, 48 + (index % 3) * 4];
  return {
    ...profile,
    shallow: new THREE.Color(colors[0]),
    deep: new THREE.Color(colors[1]),
    foam: new THREE.Color(colors[2]),
    period: colors[3]!,
  };
}

function qualityConfig(quality: WaterQuality, profile: VisualProfile): QualityConfig {
  const preset = getWaterQualityConfig(quality);
  const cinematic = quality === 'cinematic';
  const ultra = quality === 'ultra' || cinematic;
  return {
    bands: preset.bands,
    resolution: preset.textureResolution,
    meshSegments: ultra ? (profile.kind === 'river' ? 56 : 72) : quality === 'high' ? (profile.kind === 'river' ? 42 : 56) : quality === 'medium' ? 34 : 18,
    nearDistance: profile.kind === 'river' ? 55 : 92,
    farDistance: profile.kind === 'river' ? 160 : 260,
    displacement: quality === 'low' ? 0.62 : 1,
    chopScale: preset.enableChoppiness ? 1 : 0,
    foam: preset.enableFoam ? (cinematic ? 0.40 : quality === 'ultra' ? 0.36 : 0.31) : 0,
  };
}

/** Generate the same finite periodic field for equal seed/resolution. */
export function generateWaterWaveField(
  resolution: number,
  seed: number,
  halfFloat = false,
  bands = 5,
): WaveFieldData {
  const field = generateWaveField(seed, resolution, Math.max(1, Math.min(8, Math.floor(bands))));
  if (!halfFloat) return { data: field.data, resolution: field.resolution, bytes: field.data.byteLength, halfFloat: false };
  const data = new Uint16Array(field.data.length);
  for (let index = 0; index < field.data.length; index += 1) {
    data[index] = THREE.DataUtils.toHalfFloat(field.data[index]! / 255);
  }
  return { data, resolution: field.resolution, bytes: data.byteLength, halfFloat: true };
}

function makeDepthTexture(map: MapDef, water: WaterVolume, resolution = 64): THREE.DataTexture {
  const n = Math.max(16, Math.min(128, Math.floor(resolution)));
  const data = new Uint8Array(n * n * 4);
  const terrain = map.terrainHeight;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const wx = water.minX + (x + 0.5) / n * (water.maxX - water.minX);
      const wz = water.minZ + (z + 0.5) / n * (water.maxZ - water.minZ);
      const ground = terrain ? terrain(wx, wz) : water.surfaceY - water.depth;
      const depth = Number.isFinite(ground)
        ? Math.max(0, Math.min(1, (water.surfaceY - ground) / Math.max(water.depth, 0.001)))
        : 0;
      const value = Math.round(depth * 255);
      const base = (z * n + x) * 4;
      data[base] = value;
      data[base + 1] = value;
      data[base + 2] = value;
      data[base + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  texture.userData.xoWaterOwned = true;
  return texture;
}

function makeRibbonGeometry(segments: readonly WaterlineSegment[], width: number, yOffset: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const segment of segments) {
    const dx = segment.bx - segment.ax;
    const dz = segment.bz - segment.az;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const nx = -dz / length * width / 2;
    const nz = dx / length * width / 2;
    const y = segment.y + yOffset;
    const a = [segment.ax - nx, y, segment.az - nz];
    const b = [segment.bx - nx, y, segment.bz - nz];
    const c = [segment.bx + nx, y, segment.bz + nz];
    const d = [segment.ax + nx, y, segment.az + nz];
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

function markOwned(object: THREE.Object3D): void {
  object.userData.xoWaterOwned = true;
  object.userData.xoWaterSystem = true;
}

function canUseHalfFloat(renderer: THREE.WebGLRenderer | null | undefined): boolean {
  if (!renderer?.capabilities.isWebGL2) return false;
  try {
    return renderer.extensions.has('OES_texture_float_linear')
      || renderer.extensions.has('OES_texture_half_float_linear');
  } catch {
    return false;
  }
}

function makeWaveTexture(
  seed: number,
  resolution: number,
  bands: number,
  halfFloat: boolean,
): THREE.DataTexture {
  const waveData = generateWaterWaveField(resolution, seed, halfFloat, bands);
  const texture = new THREE.DataTexture(
    waveData.data,
    waveData.resolution,
    waveData.resolution,
    THREE.RGBAFormat,
    halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
  );
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  texture.userData.xoWaterOwned = true;
  return texture;
}

export class WaterSurfaceSystem implements WaterSurfaceHandle {
  readonly group = new THREE.Group();
  private readonly entries: SurfaceEntry[] = [];
  private readonly map: MapDef;
  private readonly renderer: THREE.WebGLRenderer | null;
  private readonly skyTexture: THREE.Texture;
  private readonly skyColor: THREE.Color;
  private readonly skyRotationY: number;
  private readonly skyIntensity: number;
  private readonly sunColor: THREE.Color;
  private readonly sunDirection: THREE.Vector3;
  private quality: WaterQuality;
  private time = 0;
  private viewPosition = new THREE.Vector3();
  private disposed = false;
  private readonly halfFloat: boolean;

  constructor(map: MapDef, options: WaterSurfaceSystemOptions = {}) {
    this.map = map;
    this.renderer = options.renderer ?? null;
    this.quality = options.quality ?? 'high';
    this.skyTexture = options.skyTexture ?? EMPTY_SKY;
    this.skyColor = new THREE.Color(options.skyColor ?? map.sky.fogColor);
    this.skyRotationY = Number.isFinite(options.skyRotationY) ? -(options.skyRotationY ?? 0) : 0;
    this.skyIntensity = Number.isFinite(options.skyIntensity)
      ? Math.max(0, options.skyIntensity ?? 1)
      : Math.max(0, map.sky.envIntensity ?? 1);
    this.sunColor = new THREE.Color(options.sunColor ?? map.sky.sunColor);
    this.sunDirection = new THREE.Vector3(...(options.sunDirection ?? map.sky.sunDirection)).normalize();
    this.halfFloat = canUseHalfFloat(this.renderer);
    markOwned(this.group);
    this.group.name = 'water-surface-system';
    // Validate every profile before allocating any owned renderer resource.
    // If an unexpected construction failure follows, release completed
    // entries before propagating it to the caller.
    map.water.forEach((water, index) => profileFor(water, index));
    try {
      map.water.forEach((water, index) => this.addSurface(water, index));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private addSurface(water: WaterVolume, index: number): void {
    const profile = profileFor(water, index);
    const config = qualityConfig(this.quality, profile);
    const root = new THREE.Group();
    root.name = `water:${profile.kind}:${index}`;
    markOwned(root);
    const seed = water.visual?.seed ?? (this.map.id.length * 997 + index * 131 + 17);
    const waveTexture = makeWaveTexture(seed, config.resolution, config.bands, this.halfFloat);
    let depthTexture: THREE.DataTexture;
    try {
      depthTexture = makeDepthTexture(this.map, water, profile.kind === 'river' ? 72 : 64);
    } catch (error) {
      waveTexture.dispose();
      throw error;
    }
    const materials: THREE.ShaderMaterial[] = [];
    const meshes: THREE.Mesh[] = [];
    const triangleCounts: number[] = [];
    const ownedGeometries = new Set<THREE.BufferGeometry>();
    const ownedMaterials = new Set<THREE.Material>();
    let sediment: THREE.Mesh | null = null;
    let foam: THREE.Mesh | null = null;
    try {
      const center = new THREE.Vector3((water.minX + water.maxX) / 2, water.surfaceY, (water.minZ + water.maxZ) / 2);
      const width = water.maxX - water.minX;
      const height = water.maxZ - water.minZ;
      // Prebuild three bounded meshes. Runtime changes only visibility, so LOD
      // changes do not allocate or rebuild geometry in the render loop.
      const meshConfig = qualityConfig('cinematic', profile);
      const segmentCounts = [
        Math.max(12, Math.floor(meshConfig.meshSegments * 0.42)),
        Math.max(18, Math.floor(meshConfig.meshSegments * 0.70)),
        meshConfig.meshSegments,
      ];
      for (const segments of segmentCounts) {
        const geometry = new THREE.PlaneGeometry(
          width,
          height,
          segments,
          profile.kind === 'river' ? Math.max(12, Math.floor(segments * 0.58)) : segments,
        );
        ownedGeometries.add(geometry);
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(center.x, center.y, center.z);
        const material = this.makeMaterial(profile, water, waveTexture, depthTexture, config);
        ownedMaterials.add(material);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `water-surface:${index}:lod${meshes.length}`;
        mesh.renderOrder = 3;
        mesh.frustumCulled = true;
        markOwned(mesh);
        root.add(mesh);
        materials.push(material);
        meshes.push(mesh);
        triangleCounts.push(geometry.index ? geometry.index.count / 3 : geometry.attributes.position!.count / 3);
      }
      const shoreline = this.map.terrainHeight
        ? traceWaterline(this.map.terrainHeight, water, profile.kind === 'river' ? 2 : 3)
        : [];
      if (shoreline.length > 0) {
        const sedimentGeometry = makeRibbonGeometry(
          shoreline,
          profile.kind === 'river' ? 0.30 : 0.54,
          0.012,
        );
        ownedGeometries.add(sedimentGeometry);
        const sedimentMaterial = new THREE.MeshBasicMaterial({
          color: 0x34463b,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          toneMapped: true,
        });
        ownedMaterials.add(sedimentMaterial);
        sediment = new THREE.Mesh(sedimentGeometry, sedimentMaterial);
        sediment.name = `water-sediment:${index}`;
        sediment.renderOrder = 3.5;
        markOwned(sediment);
        root.add(sediment);
        const foamMaterial = new THREE.ShaderMaterial({
          vertexShader: FOAM_VERTEX,
          fragmentShader: FOAM_FRAGMENT,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          uniforms: { uTime: { value: this.time }, uColor: { value: profile.foam }, uStrength: { value: config.foam } },
        });
        ownedMaterials.add(foamMaterial);
        const foamGeometry = makeRibbonGeometry(
          shoreline,
          profile.kind === 'river' ? 0.12 : 0.18,
          0.030,
        );
        ownedGeometries.add(foamGeometry);
        foam = new THREE.Mesh(foamGeometry, foamMaterial);
        foam.name = `water-foam:${index}`;
        foam.renderOrder = 4;
        foam.visible = config.foam > 0;
        markOwned(foam);
        root.add(foam);
      }
      const entry: SurfaceEntry = {
        root,
        meshes,
        foam,
        sediment,
        materials,
        waveTexture,
        depthTexture,
        ownedTextures: [waveTexture, depthTexture],
        volume: water,
        profile,
        triangleCounts,
        currentLod: 0,
      };
      this.selectLod(entry);
      this.group.add(root);
      this.entries.push(entry);
    } catch (error) {
      this.group.remove(root);
      for (const geometry of ownedGeometries) geometry.dispose();
      for (const material of ownedMaterials) material.dispose();
      waveTexture.dispose();
      depthTexture.dispose();
      root.clear();
      throw error;
    }
  }

  private makeMaterial(
    profile: VisualProfile,
    water: WaterVolume,
    waveTexture: THREE.DataTexture,
    depthTexture: THREE.DataTexture,
    config: QualityConfig,
  ): THREE.ShaderMaterial {
    const wind = water.visual?.windDirection ?? profile.windDirection;
    const direction = new THREE.Vector2(wind[0], wind[1]);
    if (direction.lengthSq() < 1e-4) direction.set(0.82, 0.32);
    direction.normalize();
    const material = new THREE.ShaderMaterial({
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      premultipliedAlpha: false,
      uniforms: {
        uWaveTexture: { value: waveTexture },
        uDepthTexture: { value: depthTexture },
        uSkyTexture: { value: this.skyTexture },
        uHasSkyTexture: { value: this.skyTexture !== EMPTY_SKY ? 1 : 0 },
        uTime: { value: this.time },
        uAmplitude: { value: profile.amplitude * config.displacement },
        uChop: { value: profile.choppiness * config.chopScale },
        uPeriod: { value: profile.period },
        uBands: { value: config.bands },
        uWind: { value: direction },
        uMin: { value: new THREE.Vector2(water.minX, water.minZ) },
        uExtent: { value: new THREE.Vector2(water.maxX - water.minX, water.maxZ - water.minZ) },
        uDeepColor: { value: profile.deep },
        uShallowColor: { value: profile.shallow },
        uSkyColor: { value: this.skyColor },
        uSkyRotation: { value: this.skyRotationY },
        uSkyIntensity: { value: this.skyIntensity },
        uSunDirection: { value: this.sunDirection },
        uSunColor: { value: this.sunColor },
        uClarity: { value: profile.clarity },
        uRoughness: { value: profile.kind === 'lake' ? 0.16 : profile.kind === 'river' ? 0.22 : 0.24 },
      },
    });
    material.userData.xoWaterOwned = true;
    material.userData.xoWaterSystem = true;
    return material;
  }

  private selectLod(entry: SurfaceEntry): void {
    const config = qualityConfig(this.quality, entry.profile);
    const maximumLod = this.quality === 'ultra' || this.quality === 'cinematic'
      ? 2
      : this.quality === 'high'
        ? 1
        : 0;
    let lod = 0;
    if (maximumLod > 0) {
      const dx = this.viewPosition.x - (entry.volume.minX + entry.volume.maxX) / 2;
      const dz = this.viewPosition.z - (entry.volume.minZ + entry.volume.maxZ) / 2;
      const distance = Math.hypot(dx, dz);
      lod = distance < config.nearDistance
        ? maximumLod
        : distance < config.farDistance
          ? maximumLod - 1
          : 0;
    }
    if (lod === entry.currentLod && entry.meshes[lod]?.visible) return;
    entry.currentLod = lod;
    entry.meshes.forEach((mesh, index) => { mesh.visible = index === lod; });
  }

  update(authoritativeTime: number, viewPosition?: THREE.Vector3 | null): void {
    if (this.disposed) return;
    this.time = Number.isFinite(authoritativeTime) ? Math.max(0, authoritativeTime) : this.time;
    if (viewPosition) this.viewPosition.copy(viewPosition);
    for (const entry of this.entries) {
      for (const material of entry.materials) material.uniforms['uTime']!.value = this.time * entry.profile.speed;
      if (entry.foam?.material instanceof THREE.ShaderMaterial) entry.foam.material.uniforms['uTime']!.value = this.time;
      this.selectLod(entry);
    }
  }

  setPresentationTime(time: number): void {
    this.update(time, this.viewPosition);
  }

  setQuality(quality: WaterQuality): void {
    if (this.disposed || this.quality === quality) return;
    this.quality = quality;
    for (const entry of this.entries) {
      const config = qualityConfig(quality, entry.profile);
      const seed = entry.volume.visual?.seed ?? (this.map.id.length * 997 + this.entries.indexOf(entry) * 131 + 17);
      const currentResolution = entry.waveTexture.image.width;
      if (currentResolution !== config.resolution) {
        const previousTexture = entry.waveTexture;
        const replacement = makeWaveTexture(seed, config.resolution, config.bands, this.halfFloat);
        entry.waveTexture = replacement;
        entry.ownedTextures[0] = replacement;
        for (const material of entry.materials) material.uniforms['uWaveTexture']!.value = replacement;
        previousTexture.dispose();
      }
      for (const material of entry.materials) {
        material.uniforms['uBands']!.value = config.bands;
        material.uniforms['uAmplitude']!.value = entry.profile.amplitude * config.displacement;
        material.uniforms['uChop']!.value = entry.profile.choppiness * config.chopScale;
      }
      if (entry.foam?.material instanceof THREE.ShaderMaterial) {
        entry.foam.material.uniforms['uStrength']!.value = config.foam;
        entry.foam.visible = config.foam > 0;
      }
      this.selectLod(entry);
    }
  }

  getQaStats(): WaterQaStats {
    let visibleVolumes = 0;
    let drawCalls = 0;
    let triangles = 0;
    let waveTextureBytes = 0;
    let depthTextureBytes = 0;
    for (const entry of this.entries) {
      if (entry.root.visible && entry.meshes[entry.currentLod]?.visible) {
        visibleVolumes++;
        drawCalls++;
        triangles += entry.triangleCounts[entry.currentLod] ?? 0;
        if (entry.foam?.visible) drawCalls++;
        if (entry.sediment?.visible) drawCalls++;
      }
      waveTextureBytes += entry.waveTexture.image.data?.byteLength ?? 0;
      depthTextureBytes += entry.depthTexture.image.data?.byteLength ?? 0;
    }
    return {
      quality: this.quality,
      volumes: this.entries.length,
      visibleVolumes,
      drawCalls,
      triangles,
      waveTextureBytes,
      depthTextureBytes,
      halfFloatWaveData: this.halfFloat,
      waveResolution: this.entries[0]?.waveTexture.image.width ?? 0,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries) {
      for (const mesh of entry.meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      if (entry.foam) {
        entry.foam.geometry.dispose();
        (entry.foam.material as THREE.Material).dispose();
      }
      if (entry.sediment) {
        entry.sediment.geometry.dispose();
        (entry.sediment.material as THREE.Material).dispose();
      }
      for (const texture of entry.ownedTextures) texture.dispose();
      entry.root.clear();
    }
    this.entries.length = 0;
    this.group.clear();
  }
}

export default WaterSurfaceSystem;
