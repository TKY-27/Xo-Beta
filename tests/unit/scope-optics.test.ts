import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SCOPE_DEFAULT_MAGNIFICATION,
  SCOPE_MAGNIFICATIONS,
  scopeFovForMagnification,
} from '../../src/render/renderer';
import { DEFAULT_BINDINGS, DEFAULT_SETTINGS } from '../../src/core/settings';

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
});

describe('sniper scope magnification', () => {
  it('supports exactly 1x, 2x and 4x with 2x default', () => {
    expect([...SCOPE_MAGNIFICATIONS]).toEqual([1, 2, 4]);
    expect(SCOPE_DEFAULT_MAGNIFICATION).toBe(2);
  });

  it('computes angular FOV: 1x is the hip view, 2x half the angle, 4x a quarter', () => {
    const base = 80;
    expect(scopeFovForMagnification(base, 1)).toBeCloseTo(base, 6);
    const fov2 = scopeFovForMagnification(base, 2);
    const expectedHalfDeg = (Math.atan(Math.tan((base * Math.PI) / 180 / 2) / 2) * 180) / Math.PI;
    expect(fov2 / 2).toBeCloseTo(expectedHalfDeg, 6);
    expect(fov2).toBeLessThan(base);
    const fov4 = scopeFovForMagnification(base, 4);
    // Each doubling halves the view tangent.
    expect(Math.tan((fov4 * Math.PI) / 180 / 2)).toBeCloseTo(Math.tan((fov2 * Math.PI) / 180 / 2) / 2, 6);
    expect(fov4).toBeLessThan(fov2);
    // Monotonic and strictly positive across the common base FOV range.
    for (const baseFov of [60, 80, 110]) {
      expect(scopeFovForMagnification(baseFov, 1)).toBeGreaterThan(scopeFovForMagnification(baseFov, 2));
      expect(scopeFovForMagnification(baseFov, 2)).toBeGreaterThan(scopeFovForMagnification(baseFov, 4));
      expect(scopeFovForMagnification(baseFov, 4)).toBeGreaterThan(0);
    }
  });

  it('never lets the scoped FOV collapse to zero', () => {
    expect(scopeFovForMagnification(110, 4)).toBeGreaterThan(1);
    expect(scopeFovForMagnification(60, 4)).toBeGreaterThan(1);
  });

  it('binds scope cycling to a key that conflicts with no other binding', () => {
    const codes = Object.values(DEFAULT_BINDINGS);
    expect(codes.filter((code) => code === DEFAULT_BINDINGS.scopeZoom)).toHaveLength(1);
  });

  it('persists the magnification preference with the documented default', () => {
    expect(DEFAULT_SETTINGS.scopeMagnification).toBe(2);
  });
});
