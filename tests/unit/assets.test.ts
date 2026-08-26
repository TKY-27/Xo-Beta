import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { clampHdriPeaks, PRELOAD_HDRIS } from '../../src/assets/assets';

describe('HDRI peak clamping', () => {
  it('preserves half-float encoding while clamping RGB peaks', () => {
    const source = new Uint16Array([
      THREE.DataUtils.toHalfFloat(0.5),
      THREE.DataUtils.toHalfFloat(8),
      THREE.DataUtils.toHalfFloat(2),
      THREE.DataUtils.toHalfFloat(1),
    ]);
    const texture = new THREE.DataTexture(source, 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);

    const clamped = clampHdriPeaks(texture, 4);
    const output = (clamped.image as { data: Uint16Array }).data;

    expect(output).toBeInstanceOf(Uint16Array);
    expect(THREE.DataUtils.fromHalfFloat(output[0]!)).toBeCloseTo(0.5);
    expect(THREE.DataUtils.fromHalfFloat(output[1]!)).toBeCloseTo(4);
    expect(THREE.DataUtils.fromHalfFloat(output[2]!)).toBeCloseTo(2);
    expect(THREE.DataUtils.fromHalfFloat(output[3]!)).toBeCloseTo(1);
  });

  it('only preloads HDRIs that are present in the production asset tree', () => {
    for (const name of PRELOAD_HDRIS) {
      expect(existsSync(join(process.cwd(), 'public/assets/sky', name)), name).toBe(true);
    }
  });
});
