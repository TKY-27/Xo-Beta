/**
 * Bounded water presentation for the WebGL renderer.
 *
 * This module deliberately owns presentation only.  WaterVolume.surfaceY and
 * terrainHeight remain the simulation contract; the wave field below never
 * feeds physics, movement, projectiles, or networking.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  abs, asin, atan, cameraPosition, clamp, cos, Discard, dot, floor, fract,
  float, frontFacing, max, min, mix, modelWorldMatrixInverse, normalize,
  positionWorld, pow, reflect, sin, smoothstep, step, texture, uniform, uv,
  varying, vec2, vec3, vec4,
} from 'three/tsl';
import { WebGPURenderer } from 'three/webgpu';
import { isWebGPUBackend } from './renderer';
import type { MapDef, WaterVolume, WaterVisualKind } from '../world/types';
import {
  createWaterVisualProfile,
  generateWaveField,
  getWaterQualityConfig,
  type WaterQuality,
  type WaterVisualProfile,
} from './waterWaveField';

export interface WaterSurfaceSystemOptions {
  renderer?: WebGPURenderer | null;
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
  materials: WaterSurfaceMaterial[];
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

/**
 * TSL port of the former GLSL water shaders. The wave field, GGX sun
 * response, fresnel sky reflection and depth fade all live in node graphs so
 * the material runs natively on the WebGPU renderer and its WebGL2 fallback.
 * Uniform shim objects keep the historical per-material update call sites
 * (`material.uniforms['uTime'].value = ...`) unchanged.
 */
const BANDS = [
  { scale: 0.42, speed: 0.20, axis: [0.98558477, -0.16918235], offset: [0.11, 0.37], height: 0.48, gradient: 0.35, crest: 0.25 },
  { scale: 0.95, speed: 0.42, axis: [0.95233357, 0.30505864], offset: [0.53, 0.19], height: 0.24, gradient: 0.57, crest: 0.34 },
  { scale: 2.10, speed: 0.84, axis: [0.74517440, -0.66686964], offset: [0.29, 0.71], height: 0.12, gradient: 1.25, crest: 0.28 },
  { scale: 4.40, speed: 1.38, axis: [0.60582016, 0.79560162], offset: [0.83, 0.43], height: 0.05, gradient: 1.85, crest: 0.13 },
  { scale: 7.80, speed: 2.10, axis: [0.90475166, -0.42593947], offset: [0.67, 0.89], height: 0.025, gradient: 2.35, crest: 0.07 },
  { scale: 13.0, speed: 3.10, axis: [0.77757272, 0.62879302], offset: [0.41, 0.07], height: 0.012, gradient: 2.8, crest: 0.04 },
] as const;

const DETAIL_BANDS = [
  { scale: 6.70, speed: 1.85, axis: [0.83205029, 0.55470020], offset: [0.17, 0.61], weight: 0.32, minBands: 2.5 },
  { scale: 11.30, speed: 2.65, axis: [0.51449576, -0.85749293], offset: [0.73, 0.23], weight: 0.18, minBands: 3.5 },
] as const;

/**
 * Every entry is the live node (UniformNode/TextureNode) driving the TSL
 * graph, so the historical `material.uniforms['uTime'].value = ...` update
 * sites keep working unchanged.
 */
interface WaterUniformShim {
  [key: string]: { value: unknown };
}

export class WaterSurfaceMaterial extends MeshBasicNodeMaterial {
  uniforms!: WaterUniformShim;
}

export class WaterFoamMaterial extends MeshBasicNodeMaterial {
  uniforms!: WaterUniformShim;
}

function makeWaterUniforms(params: {
  waveTexture: THREE.DataTexture;
  depthTexture: THREE.DataTexture;
  skyTexture: THREE.Texture;
  amplitude: number;
  chop: number;
  period: number;
  bands: number;
  wind: THREE.Vector2;
  min: THREE.Vector2;
  extent: THREE.Vector2;
  deep: THREE.Color;
  shallow: THREE.Color;
  skyColor: THREE.Color;
  skyRotation: number;
  skyIntensity: number;
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  clarity: number;
  roughness: number;
  hasSkyTexture: boolean;
}): WaterUniformShim {
  return {
    uWaveTexture: texture(params.waveTexture),
    uDepthTexture: texture(params.depthTexture),
    uSkyTexture: texture(params.skyTexture),
    uHasSkyTexture: uniform(params.hasSkyTexture ? 1 : 0),
    uTime: uniform(0),
    uAmplitude: uniform(params.amplitude),
    uChop: uniform(params.chop),
    uPeriod: uniform(params.period),
    uBands: uniform(params.bands),
    uWind: uniform(params.wind),
    uMin: uniform(params.min),
    uExtent: uniform(params.extent),
    uDeepColor: uniform(params.deep),
    uShallowColor: uniform(params.shallow),
    uSkyColor: uniform(params.skyColor),
    uSkyRotation: uniform(params.skyRotation),
    uSkyIntensity: uniform(params.skyIntensity),
    uSunDirection: uniform(params.sunDirection),
    uSunColor: uniform(params.sunColor),
    uClarity: uniform(params.clarity),
    uRoughness: uniform(params.roughness),
  };
}

/**
 * Builds the TSL water material: displaced vertex position (world-space wave
 * sum), wave normal and crest factor as varyings, then GGX sun response,
 * fresnel sky reflection and depth fade in the fragment stage.
 */
function buildWaterMaterial(uniforms: WaterUniformShim): WaterSurfaceMaterial {
  const U = (key: string) => uniforms[key] as UniformNode<'float', number>;
  const uTime = U('uTime');
  const uPeriod = U('uPeriod');
  const uBands = U('uBands');
  const uWind = uniforms.uWind as UniformNode<'vec2', THREE.Vector2>;
  const uAmplitude = U('uAmplitude');
  const uChop = U('uChop');
  const uMin = uniforms.uMin as UniformNode<'vec2', THREE.Vector2>;
  const uExtent = uniforms.uExtent as UniformNode<'vec2', THREE.Vector2>;
  const uHasSkyTexture = U('uHasSkyTexture');
  const uSkyColor = uniforms.uSkyColor as UniformNode<'color', THREE.Color>;
  const uSkyRotation = U('uSkyRotation');
  const uSkyIntensity = U('uSkyIntensity');
  const uSunDirection = uniforms.uSunDirection as UniformNode<'vec3', THREE.Vector3>;
  const uSunColor = uniforms.uSunColor as UniformNode<'color', THREE.Color>;
  const uClarity = U('uClarity');
  const uRoughness = U('uRoughness');
  const uDeepColor = uniforms.uDeepColor as UniformNode<'color', THREE.Color>;
  const uShallowColor = uniforms.uShallowColor as UniformNode<'color', THREE.Color>;
  const waveTex = uniforms.uWaveTexture as ReturnType<typeof texture>;
  const depthTex = uniforms.uDepthTexture as ReturnType<typeof texture>;
  const skyTex = uniforms.uSkyTexture as ReturnType<typeof texture>;

  // One rotated band of the periodic wave field: the packed sample plus the
  // world-space gradient (transpose(R) * local gradient).
  const waveSample = (band: (typeof BANDS)[number], world: Node<'vec2'>): { s: Node<'vec4'>; grad: Node<'vec2'> } => {
    const axis = vec2(band.axis[0], band.axis[1]);
    const yAxis = vec2(axis.y.negate(), axis.x);
    const p = vec2(dot(world, axis), dot(world, yAxis));
    const uvw = p.mul(band.scale).div(uPeriod).add(uWind.mul(band.speed).mul(uTime)).add(vec2(band.offset[0], band.offset[1]));
    const s = waveTex.sample(uvw);
    const localGradient = s.gb.mul(2.0).sub(1.0);
    const grad = axis.mul(localGradient.x).add(yAxis.mul(localGradient.y));
    return { s, grad };
  };

  // Vertex stage: accumulate height/gradient/crest across active bands.
  // Additive terms with mask gating, built as pure expression trees (TSL
  // assigns require a stack context, which material construction lacks).
  const worldPos = positionWorld;
  let height: Node<'float'> = float(0);
  let gradient: Node<'vec2'> = vec2(0, 0);
  let crest: Node<'float'> = float(0);
  for (let i = 0; i < BANDS.length; i++) {
    const band = BANDS[i]!;
    const mask = step(i + 0.5, uBands);
    const { s, grad } = waveSample(band, worldPos.xz);
    height = height.add(s.r.mul(2.0).sub(1.0).mul(band.height).mul(mask));
    gradient = gradient.add(grad.mul(band.gradient).mul(mask));
    crest = crest.add(s.a.mul(band.crest).mul(mask));
  }
  const chopAmount = uAmplitude.mul(uChop);
  const displacedWorld = worldPos.add(vec3(
    gradient.x.mul(chopAmount),
    height.mul(uAmplitude),
    gradient.y.mul(chopAmount),
  ));
  const waveNormal = normalize(vec3(gradient.x.negate().mul(uAmplitude), float(1), gradient.y.negate().mul(uAmplitude)));
  const vNormal = varying(waveNormal) as unknown as Node<'vec3'>;
  const vCrest = varying(clamp(crest, 0.0, 1.0)) as unknown as Node<'float'>;

  // Fragment stage.
  const localPosition = positionWorld.xz.sub(uMin);
  const boundaryDistance = min(
    min(localPosition.x, uExtent.x.sub(localPosition.x)),
    min(localPosition.y, uExtent.y.sub(localPosition.y)),
  );
  Discard(boundaryDistance.lessThanEqual(0.0));
  const boundaryFade = smoothstep(0.0, 0.65, boundaryDistance);
  const depthUv = clamp(localPosition.div(max(uExtent, vec2(0.001, 0.001))), 0.0, 1.0);
  const depth = depthTex.sample(depthUv).r;
  Discard(depth.lessThan(0.003));

  // Sub-triangle capillary normals come from the same deterministic field as
  // the vertex displacement, decorrelated from the broad bands.
  let detailGradient: Node<'vec2'> = vec2(0, 0);
  for (const band of DETAIL_BANDS) {
    const mask = step(band.minBands, uBands);
    const axis = vec2(band.axis[0], band.axis[1]);
    const yAxis = vec2(axis.y.negate(), axis.x);
    const p = vec2(dot(positionWorld.xz, axis), dot(positionWorld.xz, yAxis));
    const uvw = p.mul(band.scale).div(uPeriod).add(uWind.mul(band.speed).mul(uTime)).add(vec2(band.offset[0], band.offset[1]));
    const localGradient = waveTex.sample(uvw).gb.mul(2.0).sub(1.0);
    detailGradient = detailGradient.add(axis.mul(localGradient.x).add(yAxis.mul(localGradient.y)).mul(band.weight).mul(mask));
  }

  const n = normalize(vNormal.add(vec3(detailGradient.x.negate(), float(0), detailGradient.y.negate())));
  const faceN = frontFacing.select(n, n.negate());
  const viewDirection = normalize(cameraPosition.sub(positionWorld));
  const nov = max(dot(faceN, viewDirection), 0.0);
  const fresnel = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(nov), 5.0)));
  const sunDirection = normalize(uSunDirection.negate());
  const halfDirection = normalize(sunDirection.add(viewDirection));
  const nh = max(dot(faceN, halfDirection), 0.0);
  const nol = max(dot(faceN, sunDirection), 0.0);
  const roughness = clamp(uRoughness, 0.08, 0.45);
  const alphaRoughness = roughness.mul(roughness);
  const alphaSquared = alphaRoughness.mul(alphaRoughness);
  const distributionDenominator = nh.mul(nh).mul(alphaSquared.sub(1.0)).add(1.0);
  const distribution = alphaSquared.div(
    max(float(3.1415926).mul(distributionDenominator).mul(distributionDenominator), 0.001),
  );
  const geometryK = roughness.add(1.0).mul(roughness.add(1.0)).mul(0.125);
  const geometryView = nov.div(max(nov.mul(float(1.0).sub(geometryK)).add(geometryK), 0.001));
  const geometryLight = nol.div(max(nol.mul(float(1.0).sub(geometryK)).add(geometryK), 0.001));
  const ggxSpec = distribution.mul(geometryView).mul(geometryLight).div(max(float(4.0).mul(nov).mul(nol), 0.001));
  const glint = pow(nh, 180.0).mul(float(0.006).add(vCrest.mul(0.035)));

  // Water is more transparent at a shallow edge, while deep water absorbs
  // red light first. The depth texture comes from the canonical terrain.
  const shallow = float(1.0).sub(smoothstep(0.08, 0.56, depth));
  const asVec3 = (c: UniformNode<'color', THREE.Color>): Node<'vec3'> => c as unknown as Node<'vec3'>;
  const base = mix(asVec3(uDeepColor), asVec3(uShallowColor), shallow.mul(0.86));
  // Equirectangular sky reflection with the background rotation applied.
  const cs = cos(uSkyRotation);
  const sn = sin(uSkyRotation);
  const reflectedDir = reflect(viewDirection.negate(), faceN);
  const rotated = vec3(
    cs.mul(reflectedDir.x).sub(sn.mul(reflectedDir.z)),
    reflectedDir.y,
    sn.mul(reflectedDir.x).add(cs.mul(reflectedDir.z)),
  );
  const skyUv = vec2(
    atan(rotated.z, rotated.x).div(6.2831853).add(0.5),
    float(0.5).add(asin(clamp(rotated.y, -1.0, 1.0)).div(3.1415926)),
  );
  const skySampled = skyTex.sample(skyUv).rgb.mul(uSkyIntensity);
  const reflected = uHasSkyTexture.lessThan(0.5).select(asVec3(uSkyColor), skySampled);
  // CYCLE 28: a small always-on sky term — real water never shows pure
  // scatter colour from overhead; ambient sky fills even near-normal views.
  const color = mix(base, reflected, fresnel.mul(float(0.42).add(uClarity.mul(0.3)))).add(reflected.mul(0.12));
  const shaded = color
    .add(asVec3(uSunColor).mul(min(ggxSpec, 1.25).mul(nol).mul(0.07).add(glint)))
    .add(asVec3(uShallowColor).mul(shallow).mul(0.045));
  const alpha = mix(0.91, 0.985, fresnel).mul(mix(0.78, 1.0, depth)).mul(boundaryFade);

  const material = new WaterSurfaceMaterial();
  material.uniforms = uniforms;
  material.transparent = true;
  material.side = THREE.DoubleSide;
  material.depthTest = true;
  material.depthWrite = false;
  material.premultipliedAlpha = false;
  material.positionNode = modelWorldMatrixInverse.mul(vec4(displacedWorld, 1.0)).xyz;
  material.colorNode = shaded.max(0.0);
  material.opacityNode = alpha;
  return material;
}

function buildFoamMaterial(uniforms: WaterUniformShim): WaterFoamMaterial {
  const uTime = uniforms.uTime as UniformNode<'float', number>;
  const uColor = uniforms.uColor as UniformNode<'color', THREE.Color>;
  const uStrength = uniforms.uStrength as UniformNode<'float', number>;
  const worldXZ = positionWorld.xz;
  const along = dot(worldXZ, vec2(0.73, 0.41));
  const crossWave = sin(dot(worldXZ, vec2(-0.19, 0.83)).mul(0.47).sub(uTime.mul(0.21)));
  const breakup = smoothstep(0.20, 0.78, sin(along.mul(0.62).add(uTime.mul(0.34)).add(crossWave.mul(1.8))).mul(0.5).add(0.5));
  const hash = fract(sin(dot(floor(worldXZ.mul(0.38)), vec2(41.7, 113.9))).mul(43758.5453));
  const breakupModulated = breakup.mul(float(0.82).add(hash.mul(0.18)));
  const edge = float(1.0).sub(smoothstep(0.0, 0.5, abs(uv().y.sub(0.5)).mul(2.0)));
  const alpha = breakupModulated.mul(edge).mul(uStrength);
  Discard(alpha.lessThan(0.008));
  const material = new WaterFoamMaterial();
  material.uniforms = uniforms;
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.colorNode = uColor as unknown as Node<'vec3'>;
  material.opacityNode = alpha;
  return material;
}

function profileFor(water: WaterVolume, index: number): VisualProfile {
  const kind: WaterVisualKind = water.visual?.kind ?? 'fallback';
  const profile = createWaterVisualProfile(kind, {
    windDirection: water.visual?.windDirection,
  });
  // CYCLE 31: one more desaturation step — the shallow-end bed still read as
  // saturated turquoise through the 70-78% surface alpha at some angles.
  const colors = kind === 'river'
    ? [0x3c6a6b, 0x0c2c36, 0xb1d1c7, 50]
    : kind === 'pond'
      ? [0x476c6a, 0x0f2e33, 0x9ebeb4, 42]
      : kind === 'lake'
        ? [0x466e6b, 0x0e2a31, 0xa9c9bf, 66]
        : [0x466b6a, 0x0e2c34, 0x9db9b0, 48 + (index % 3) * 4];
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

function canUseHalfFloat(renderer: WebGPURenderer | null | undefined): boolean {
  if (renderer === null || renderer === undefined) return false;
  // Native WebGPU filters 16F textures as a core capability; the WebGL2
  // fallback needs the classic extension probe.
  if (isWebGPUBackend(renderer)) return true;
  const caps = (renderer as unknown as { capabilities?: { isWebGL2?: boolean } }).capabilities;
  if (!caps?.isWebGL2) return false;
  try {
    const glRenderer = renderer as unknown as { extensions: { has(name: string): boolean } };
    return glRenderer.extensions.has('OES_texture_float_linear')
      || glRenderer.extensions.has('OES_texture_half_float_linear');
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
  private readonly renderer: WebGPURenderer | null;
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
    const materials: WaterSurfaceMaterial[] = [];
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
        // A wide wet-sand band: the old 0.3-0.5 m strip left the waterline
        // reading as a hard vector edge against dry terrain.
        const sedimentGeometry = makeRibbonGeometry(
          shoreline,
          profile.kind === 'river' ? 1.1 : 2.1,
          0.012,
        );
        ownedGeometries.add(sedimentGeometry);
        const sedimentMaterial = new THREE.MeshBasicMaterial({
          color: 0x34463b,
          transparent: true,
          opacity: 0.26,
          depthWrite: false,
          toneMapped: true,
        });
        ownedMaterials.add(sedimentMaterial);
        sediment = new THREE.Mesh(sedimentGeometry, sedimentMaterial);
        sediment.name = `water-sediment:${index}`;
        sediment.renderOrder = 3.5;
        markOwned(sediment);
        root.add(sediment);
        const foamMaterial = buildFoamMaterial({
          uTime: uniform(this.time),
          uColor: uniform(profile.foam),
          uStrength: uniform(config.foam),
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
  ): WaterSurfaceMaterial {
    const wind = water.visual?.windDirection ?? profile.windDirection;
    const direction = new THREE.Vector2(wind[0], wind[1]);
    if (direction.lengthSq() < 1e-4) direction.set(0.82, 0.32);
    direction.normalize();
    const uniforms = makeWaterUniforms({
      waveTexture,
      depthTexture,
      skyTexture: this.skyTexture,
      amplitude: profile.amplitude * config.displacement,
      chop: profile.choppiness * config.chopScale,
      period: profile.period,
      bands: config.bands,
      wind: direction,
      min: new THREE.Vector2(water.minX, water.minZ),
      extent: new THREE.Vector2(water.maxX - water.minX, water.maxZ - water.minZ),
      deep: profile.deep,
      shallow: profile.shallow,
      skyColor: this.skyColor,
      skyRotation: this.skyRotationY,
      skyIntensity: this.skyIntensity,
      sunDirection: this.sunDirection,
      sunColor: this.sunColor,
      clarity: profile.clarity,
      roughness: profile.kind === 'lake' ? 0.16 : profile.kind === 'river' ? 0.22 : 0.24,
      hasSkyTexture: this.skyTexture !== EMPTY_SKY,
    });
    const material = buildWaterMaterial(uniforms);
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
      if (entry.foam?.material instanceof WaterFoamMaterial) entry.foam.material.uniforms['uTime']!.value = this.time;
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
      if (entry.foam?.material instanceof WaterFoamMaterial) {
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

  /** Every water shader material across all volumes and LOD tiers. Water
   * meshes only become visible near a shoreline, so without an explicit
   * warmup their (large) GLSL programs would compile on the player's first
   * approach to water mid-match. */
  warmupMaterials(): THREE.Material[] {
    const materials: THREE.Material[] = [];
    for (const entry of this.entries) {
      for (const material of entry.materials) materials.push(material);
      if (entry.foam) materials.push(entry.foam.material as THREE.Material);
      if (entry.sediment) materials.push(entry.sediment.material as THREE.Material);
    }
    return materials;
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
