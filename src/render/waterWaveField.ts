/**
 * Deterministic, presentation-only data used by the WebGL water material.
 *
 * This module deliberately has no renderer or simulation dependencies.  The
 * generated field is a small periodic RGBA8 texture so that the same source
 * data can be used by WebGL materials and by deterministic unit tests.
 */

export type WaterKind = 'lake' | 'river' | 'pond' | 'fallback';

export type WaterQuality = 'low' | 'medium' | 'high' | 'ultra' | 'cinematic';

export interface WaterVisualProfile {
  readonly kind: WaterKind;
  /** Maximum vertical visual displacement in world units. */
  readonly amplitude: number;
  /** Horizontal displacement multiplier, expressed as a fraction of amplitude. */
  readonly choppiness: number;
  /** Scrolling speed in world units per second. */
  readonly speed: number;
  /** 0 is opaque/absorptive and 1 is clear. */
  readonly clarity: number;
  /** Shore/crest foam contribution, in the inclusive range 0..1. */
  readonly foamStrength: number;
  /** World-space wind direction, represented as [x, z]. */
  readonly windDirection: readonly [number, number];
}

export interface WaterQualityConfig {
  readonly quality: WaterQuality;
  readonly textureResolution: number;
  readonly bands: number;
  readonly enableFoam: boolean;
  readonly enableChoppiness: boolean;
}

export interface WaveField {
  readonly seed: number;
  readonly resolution: number;
  /** RGBA8: height, gradient X, gradient Z, horizontal displacement. */
  readonly data: Uint8Array;
}

export interface WaveSample {
  readonly height: number;
  readonly gradientX: number;
  readonly gradientZ: number;
  readonly horizontalDisplacement: number;
}

/**
 * Converts a gradient sampled after rotating world coordinates into the
 * original world axes. This mirrors the GLSL wave-band transform.
 */
export function rotateWaveGradientToWorld(
  gradientX: number,
  gradientZ: number,
  angle: number,
): readonly [number, number] {
  if (![gradientX, gradientZ, angle].every(Number.isFinite)) return [0, 0];
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    cosine * gradientX + sine * gradientZ,
    -sine * gradientX + cosine * gradientZ,
  ];
}

interface WaterAmplitudeRange {
  readonly min: number;
  readonly max: number;
}

const AMPLITUDE_RANGES: Readonly<Record<WaterKind, WaterAmplitudeRange>> = {
  lake: { min: 0.12, max: 0.20 },
  pond: { min: 0.06, max: 0.12 },
  river: { min: 0.04, max: 0.10 },
  fallback: { min: 0, max: 0.20 },
};

const DEFAULT_PROFILES: Readonly<Record<WaterKind, WaterVisualProfile>> = {
  lake: {
    kind: 'lake',
    amplitude: 0.16,
    choppiness: 0.32,
    speed: 0.65,
    clarity: 0.72,
    foamStrength: 0.48,
    windDirection: [0.84, 0.54],
  },
  river: {
    kind: 'river',
    amplitude: 0.07,
    choppiness: 0.24,
    speed: 0.90,
    clarity: 0.58,
    foamStrength: 0.40,
    windDirection: [0.98, 0.20],
  },
  pond: {
    kind: 'pond',
    amplitude: 0.09,
    choppiness: 0.18,
    speed: 0.45,
    clarity: 0.66,
    foamStrength: 0.28,
    windDirection: [0.71, 0.71],
  },
  fallback: {
    kind: 'fallback',
    amplitude: 0.04,
    choppiness: 0.10,
    speed: 0.40,
    clarity: 0.50,
    foamStrength: 0,
    windDirection: [1, 0],
  },
};

const QUALITY_CONFIGS: Readonly<Record<WaterQuality, WaterQualityConfig>> = {
  low: {
    quality: 'low',
    textureResolution: 32,
    bands: 2,
    enableFoam: false,
    enableChoppiness: false,
  },
  medium: {
    quality: 'medium',
    textureResolution: 64,
    bands: 3,
    enableFoam: true,
    enableChoppiness: false,
  },
  high: {
    quality: 'high',
    textureResolution: 128,
    bands: 4,
    enableFoam: true,
    enableChoppiness: true,
  },
  ultra: {
    quality: 'ultra',
    textureResolution: 256,
    bands: 5,
    enableFoam: true,
    enableChoppiness: true,
  },
  cinematic: {
    quality: 'cinematic',
    textureResolution: 384,
    bands: 6,
    enableFoam: true,
    enableChoppiness: true,
  },
};

const TWO_PI = Math.PI * 2;
const MAX_RESOLUTION = 512;
const MAX_SEED = 0x7fffffff;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function isWaterKind(value: unknown): value is WaterKind {
  return value === 'lake' || value === 'river' || value === 'pond' || value === 'fallback';
}

function isWaterQuality(value: unknown): value is WaterQuality {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'ultra' || value === 'cinematic';
}

function normalizedSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 0;
  const integer = Math.trunc(seed);
  return ((integer % MAX_SEED) + MAX_SEED) % MAX_SEED;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function decode(byte: number | undefined): number {
  return ((byte ?? 128) / 255) * 2 - 1;
}

function encode(value: number): number {
  return Math.round(clamp(value * 0.5 + 0.5, 0, 1) * 255);
}

/** Returns a fresh immutable profile for a known water kind. */
export function getWaterVisualProfile(kind: WaterKind): WaterVisualProfile {
  if (!isWaterKind(kind)) throw new RangeError(`Unknown water kind: ${String(kind)}`);
  const profile = DEFAULT_PROFILES[kind];
  return Object.freeze({
    ...profile,
    windDirection: Object.freeze([profile.windDirection[0], profile.windDirection[1]]) as readonly [number, number],
  });
}

/**
 * Builds and validates a profile without letting map data introduce NaN or
 * unbounded visual displacement.
 */
export function createWaterVisualProfile(
  kind: WaterKind,
  overrides: Partial<Omit<WaterVisualProfile, 'kind'>> = {},
): WaterVisualProfile {
  const base = getWaterVisualProfile(kind);
  return validateWaterVisualProfile({
    ...base,
    ...overrides,
    kind,
    windDirection: overrides.windDirection ?? base.windDirection,
  });
}

/** Returns true only for finite, bounded, render-safe profiles. */
export function isValidWaterVisualProfile(value: unknown): value is WaterVisualProfile {
  if (typeof value !== 'object' || value === null) return false;
  const profile = value as Partial<WaterVisualProfile>;
  if (!isWaterKind(profile.kind)) return false;
  const amplitudeRange = AMPLITUDE_RANGES[profile.kind];
  if (typeof profile.amplitude !== 'number' || !finite(profile.amplitude)
    || profile.amplitude < amplitudeRange.min || profile.amplitude > amplitudeRange.max) return false;
  if (typeof profile.choppiness !== 'number' || !finite(profile.choppiness)
    || profile.choppiness < 0 || profile.choppiness > 0.8) return false;
  if (typeof profile.speed !== 'number' || !finite(profile.speed)
    || profile.speed < 0 || profile.speed > 3) return false;
  if (typeof profile.clarity !== 'number' || !finite(profile.clarity)
    || profile.clarity < 0 || profile.clarity > 1) return false;
  if (typeof profile.foamStrength !== 'number' || !finite(profile.foamStrength)
    || profile.foamStrength < 0 || profile.foamStrength > 1) return false;
  if (!Array.isArray(profile.windDirection) || profile.windDirection.length !== 2) return false;
  const [windX, windZ] = profile.windDirection;
  if (typeof windX !== 'number' || typeof windZ !== 'number' || !finite(windX) || !finite(windZ)) return false;
  return Math.hypot(windX, windZ) > 1e-6;
}

/**
 * Validates a profile and returns an immutable copy.  Keeping validation here
 * makes the rendering layer fail closed instead of accepting unsafe map data.
 */
export function validateWaterVisualProfile(value: unknown): WaterVisualProfile {
  if (!isValidWaterVisualProfile(value)) throw new RangeError('Invalid water visual profile');
  const profile = value as WaterVisualProfile;
  const length = Math.hypot(profile.windDirection[0], profile.windDirection[1]);
  return Object.freeze({
    kind: profile.kind,
    amplitude: profile.amplitude,
    choppiness: profile.choppiness,
    speed: profile.speed,
    clarity: profile.clarity,
    foamStrength: profile.foamStrength,
    windDirection: Object.freeze([
      profile.windDirection[0] / length,
      profile.windDirection[1] / length,
    ]) as readonly [number, number],
  });
}

/** Returns a fresh quality configuration so callers cannot mutate defaults. */
export function getWaterQualityConfig(quality: WaterQuality): WaterQualityConfig {
  if (!isWaterQuality(quality)) throw new RangeError(`Unknown water quality: ${String(quality)}`);
  return { ...QUALITY_CONFIGS[quality] };
}

/**
 * A small integer hash used only while constructing the periodic field.  The
 * integer lattice and trigonometric basis below make every edge periodic.
 */
function hash(seed: number, x: number, z: number, band: number): number {
  let value = (seed ^ Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(z + 0xc2b2ae35, 0x27d4eb2d)
    ^ Math.imul(band + 1, 0x165667b1)) | 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

interface WaveBasis {
  readonly kx: number;
  readonly kz: number;
  readonly phase: number;
  readonly weight: number;
  readonly direction: number;
}

function buildBases(seed: number, bands: number): WaveBasis[] {
  // Integer lattice directions keep every basis exactly periodic on both
  // texture axes. Continuous random angles leave a phase discontinuity at
  // the RepeatWrapping seam even when the texture sampler itself wraps.
  const directions = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
    [2, 1], [1, 2], [-1, 2], [-2, 1],
    [-2, -1], [-1, -2], [1, -2], [2, -1],
  ] as const;
  const basis: WaveBasis[] = [];
  for (let band = 0; band < bands; band += 1) {
    const frequency = 1 << band;
    // Several independently phased lattice directions per spatial band turn
    // the generated texture into a wave field instead of exposing one obvious
    // sinusoid per octave. Broad/medium scales receive one extra low-weight
    // component because repetition is most visible at grazing distance.
    const componentCount = band < 2 ? 3 : 2;
    let previousDirectionIndex = -1;
    for (let component = 0; component < componentCount; component += 1) {
      let directionIndex = Math.floor(
        hash(seed, band * 17 + component, 3 + component * 11, band + component) * directions.length,
      ) % directions.length;
      if (directionIndex === previousDirectionIndex) {
        directionIndex = (directionIndex + 5 + band) % directions.length;
      }
      previousDirectionIndex = directionIndex;
      const [directionX, directionZ] = directions[directionIndex]!;
      const phase = hash(seed, band * 29 + component, 11 + component * 7, component + 1) * TWO_PI;
      const direction = Math.atan2(directionZ, directionX);
      const componentWeight = component === 0 ? 1 : component === 1 ? 0.58 : 0.34;
      basis.push({
        kx: directionX * frequency,
        kz: directionZ * frequency,
        phase,
        weight: componentWeight / (1 + band * 0.72),
        direction,
      });
    }
  }
  return basis;
}

function basisSample(u: number, v: number, bases: readonly WaveBasis[]): WaveSample {
  let height = 0;
  let gradientX = 0;
  let gradientZ = 0;
  let horizontalDisplacement = 0;
  let totalWeight = 0;
  for (const basis of bases) {
    const argument = basis.kx * u + basis.kz * v + basis.phase;
    const wave = Math.sin(argument);
    const weight = basis.weight;
    height += wave * weight;
    gradientX += Math.cos(argument) * basis.kx * weight;
    gradientZ += Math.cos(argument) * basis.kz * weight;
    horizontalDisplacement += wave * Math.cos(basis.direction) * weight;
    totalWeight += weight;
  }
  const heightScale = totalWeight > 0 ? 1 / totalWeight : 0;
  const gradientScale = heightScale * 0.24;
  return {
    height: clamp(height * heightScale, -1, 1),
    gradientX: clamp(gradientX * gradientScale, -1, 1),
    gradientZ: clamp(gradientZ * gradientScale, -1, 1),
    horizontalDisplacement: clamp(horizontalDisplacement * heightScale, -1, 1),
  };
}

/**
 * Generates a deterministic periodic RGBA8 field.  Resolution is bounded so
 * malformed quality or QA input cannot allocate an unexpectedly large buffer.
 */
export function generateWaveField(seed: number, resolution = 128, bands = 5): WaveField {
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > MAX_RESOLUTION) {
    throw new RangeError(`Wave resolution must be an integer from 2 to ${MAX_RESOLUTION}`);
  }
  if (!Number.isInteger(bands) || bands < 1 || bands > 8) {
    throw new RangeError('Wave bands must be an integer from 1 to 8');
  }
  const safeSeed = normalizedSeed(seed);
  const data = new Uint8Array(resolution * resolution * 4);
  const bases = buildBases(safeSeed, bands);
  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      // u and v are exact periodic coordinates: the right/top edge samples
      // the same phase as the left/bottom edge without duplicating texels.
      const sample = basisSample(x / resolution * TWO_PI, z / resolution * TWO_PI, bases);
      const offset = (z * resolution + x) * 4;
      data[offset] = encode(sample.height);
      data[offset + 1] = encode(sample.gradientX);
      data[offset + 2] = encode(sample.gradientZ);
      data[offset + 3] = encode(sample.horizontalDisplacement);
    }
  }
  return { seed: safeSeed, resolution, data };
}

/** Explicit alias for callers that want to emphasize that the texture wraps. */
export const generatePeriodicWaveField = generateWaveField;

function wrapUnit(value: number): number {
  const wrapped = value - Math.floor(value);
  return wrapped >= 1 ? 0 : wrapped;
}

function texel(field: WaveField, x: number, z: number): WaveSample {
  const index = (z * field.resolution + x) * 4;
  return {
    height: decode(field.data[index]),
    gradientX: decode(field.data[index + 1]),
    gradientZ: decode(field.data[index + 2]),
    horizontalDisplacement: decode(field.data[index + 3]),
  };
}

function blend(a: WaveSample, b: WaveSample, amount: number): WaveSample {
  return {
    height: a.height + (b.height - a.height) * amount,
    gradientX: a.gradientX + (b.gradientX - a.gradientX) * amount,
    gradientZ: a.gradientZ + (b.gradientZ - a.gradientZ) * amount,
    horizontalDisplacement: a.horizontalDisplacement
      + (b.horizontalDisplacement - a.horizontalDisplacement) * amount,
  };
}

/** Bilinearly samples the repeating field at normalized periodic coordinates. */
export function sampleWaveField(field: WaveField, u: number, v: number): WaveSample {
  if (!Number.isFinite(u) || !Number.isFinite(v) || field.resolution < 2 || field.data.length < field.resolution * field.resolution * 4) {
    return { height: 0, gradientX: 0, gradientZ: 0, horizontalDisplacement: 0 };
  }
  const wrappedU = wrapUnit(u);
  const wrappedV = wrapUnit(v);
  const scaledU = wrappedU * field.resolution;
  const scaledV = wrappedV * field.resolution;
  const x0 = Math.floor(scaledU) % field.resolution;
  const z0 = Math.floor(scaledV) % field.resolution;
  const x1 = (x0 + 1) % field.resolution;
  const z1 = (z0 + 1) % field.resolution;
  const tx = scaledU - Math.floor(scaledU);
  const tz = scaledV - Math.floor(scaledV);
  const top = blend(texel(field, x0, z0), texel(field, x1, z0), tx);
  const bottom = blend(texel(field, x0, z1), texel(field, x1, z1), tx);
  return blend(top, bottom, tz);
}

/**
 * Samples in world space.  No camera transform is accepted or used, so the
 * same world point always receives the same wave phase on every client.
 */
export function sampleWaveFieldWorld(
  field: WaveField,
  worldX: number,
  worldZ: number,
  tileSize = 32,
): WaveSample {
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    return { height: 0, gradientX: 0, gradientZ: 0, horizontalDisplacement: 0 };
  }
  const safeTileSize = Number.isFinite(tileSize) && tileSize > 0 ? tileSize : 1;
  return sampleWaveField(field, worldX / safeTileSize, worldZ / safeTileSize);
}
