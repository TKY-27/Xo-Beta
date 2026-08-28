import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { clampHdriPeaks, PRELOAD_HDRIS } from '../../src/assets/assets';
import { applySharedTextureReplacements, extractGeometries } from '../../src/render/props';

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

describe('GLTF prop normalization', () => {
  it('redirects every material sharing a rewritten texture before disposing the source', () => {
    const source = new THREE.Texture();
    const replacement = new THREE.Texture();
    const first = new THREE.MeshStandardMaterial({ map: source });
    const second = new THREE.MeshStandardMaterial({ map: source });
    let disposed = 0;
    source.addEventListener('dispose', () => disposed++);

    applySharedTextureReplacements([first, second], new Map([[source, replacement]]));

    expect(first.map).toBe(replacement);
    expect(second.map).toBe(replacement);
    expect(disposed).toBe(1);
    first.dispose();
    second.dispose();
    replacement.dispose();
  });

  it('applies one asset-wide base correction and preserves trunk/canopy offset', () => {
    const root = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5));
    trunk.position.y = 1;
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2));
    canopy.position.y = 3.5;
    root.add(trunk, canopy);
    const extracted = extractGeometries(root);
    expect(extracted.geoms).toHaveLength(2);
    const bounds = extracted.geoms.map((geo) => {
      geo.computeBoundingBox();
      return geo.boundingBox!;
    });
    expect(bounds[0]!.min.y).toBeCloseTo(0, 8);
    expect(bounds[1]!.min.y - bounds[0]!.min.y).toBeCloseTo(3, 8);
  });
});
