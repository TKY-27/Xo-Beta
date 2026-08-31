import { describe, expect, it } from 'vitest';
import {
  createWaterVisualProfile,
  generateWaveField,
  getWaterQualityConfig,
  getWaterVisualProfile,
  isValidWaterVisualProfile,
  rotateWaveGradientToWorld,
  sampleWaveField,
  sampleWaveFieldWorld,
  validateWaterVisualProfile,
} from '../../src/render/waterWaveField';

describe('water visual profiles', () => {
  it('keeps authored amplitudes inside the bounded water-kind targets', () => {
    expect(getWaterVisualProfile('lake').amplitude).toBeGreaterThanOrEqual(0.12);
    expect(getWaterVisualProfile('lake').amplitude).toBeLessThanOrEqual(0.20);
    expect(getWaterVisualProfile('pond').amplitude).toBeGreaterThanOrEqual(0.06);
    expect(getWaterVisualProfile('pond').amplitude).toBeLessThanOrEqual(0.12);
    expect(getWaterVisualProfile('river').amplitude).toBeGreaterThanOrEqual(0.04);
    expect(getWaterVisualProfile('river').amplitude).toBeLessThanOrEqual(0.10);
  });

  it('normalizes wind direction and rejects non-finite or unbounded values', () => {
    const profile = createWaterVisualProfile('lake', { windDirection: [3, 4] });
    expect(profile.windDirection[0]).toBeCloseTo(0.6);
    expect(profile.windDirection[1]).toBeCloseTo(0.8);
    expect(isValidWaterVisualProfile({ ...profile, amplitude: Number.NaN })).toBe(false);
    expect(isValidWaterVisualProfile({ ...profile, choppiness: 0.81 })).toBe(false);
    expect(isValidWaterVisualProfile({ ...profile, clarity: -0.01 })).toBe(false);
    expect(() => validateWaterVisualProfile({ ...profile, speed: Infinity })).toThrow(RangeError);
  });

  it('provides bounded quality configurations with explicit feature flags', () => {
    expect(getWaterQualityConfig('low')).toMatchObject({
      textureResolution: 32,
      bands: 2,
      enableFoam: false,
      enableChoppiness: false,
    });
    expect(getWaterQualityConfig('high')).toMatchObject({
      textureResolution: 128,
      bands: 4,
      enableFoam: true,
      enableChoppiness: true,
    });
    expect(getWaterQualityConfig('cinematic').textureResolution).toBeLessThanOrEqual(512);
  });

  it('rotates sampled gradients back to world axes without changing magnitude', () => {
    const quarterTurn = rotateWaveGradientToWorld(1, 0, Math.PI / 2);
    expect(quarterTurn[0]).toBeCloseTo(0, 12);
    expect(quarterTurn[1]).toBeCloseTo(-1, 12);

    const angled = rotateWaveGradientToWorld(0.3, -0.7, 0.73);
    expect(Math.hypot(...angled)).toBeCloseTo(Math.hypot(0.3, -0.7), 12);
    expect(rotateWaveGradientToWorld(Number.NaN, 1, 0)).toEqual([0, 0]);
  });
});

describe('deterministic periodic water wave field', () => {
  it('produces byte-identical output for the same seed', () => {
    const first = generateWaveField(72517, 32, 4);
    const second = generateWaveField(72517, 32, 4);
    expect(first.seed).toBe(second.seed);
    expect(first.data).toEqual(second.data);
  });

  it('changes the field for a different seed without using frame randomness', () => {
    const first = generateWaveField(72517, 32, 4);
    const second = generateWaveField(72518, 32, 4);
    expect(first.data).not.toEqual(second.data);
  });

  it('wraps seamlessly at the periodic boundary', () => {
    const field = generateWaveField(42, 32, 5);
    const origin = sampleWaveField(field, 0, 0);
    const wrapped = sampleWaveField(field, 1, 1);
    expect(wrapped).toEqual(origin);
    expect(sampleWaveField(field, -1, -1)).toEqual(origin);
  });

  it('samples finite bounded values in world space independent of camera state', () => {
    const field = generateWaveField(1001, 64, 5);
    const first = sampleWaveFieldWorld(field, 12.5, -88.25, 32);
    const second = sampleWaveFieldWorld(field, 12.5, -88.25, 32);
    expect(second).toEqual(first);
    for (const value of Object.values(first)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(sampleWaveFieldWorld(field, Number.NaN, 0)).toEqual({
      height: 0,
      gradientX: 0,
      gradientZ: 0,
      horizontalDisplacement: 0,
    });
  });
});
