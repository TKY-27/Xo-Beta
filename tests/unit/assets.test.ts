import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { clampHdriPeaks, PRELOAD_HDRIS } from '../../src/assets/assets';
import { applySharedTextureReplacements, extractGeometries } from '../../src/render/props';
import { WORLD_LOOT_WEAPON_SCALE } from '../../src/render/weaponModels';
import { lootRenderY } from '../../src/render/worldView';

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

  it('ships a reviewed menu hero for every production map', () => {
    for (const map of ['neocity', 'oldfront', 'eden', 'ashara']) {
      expect(existsSync(join(process.cwd(), 'public/assets/maps', `${map}.jpg`)), map).toBe(true);
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

  it('tightens organic cutout edges without changing masked bark', () => {
    const root = new THREE.Group();
    const leafMap = new THREE.Texture();
    leafMap.name = 'Leaves_NormalTree_C';
    const leafMaterial = new THREE.MeshStandardMaterial({ map: leafMap, alphaTest: 0.2 });
    leafMaterial.name = 'Leaves_NormalTree';
    const barkMap = new THREE.Texture();
    barkMap.name = 'Bark_NormalTree';
    const barkMaterial = new THREE.MeshStandardMaterial({ map: barkMap, alphaTest: 0.2 });
    barkMaterial.name = 'Bark_NormalTree';
    root.add(
      new THREE.Mesh(new THREE.PlaneGeometry(1, 1), leafMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), barkMaterial),
    );

    const extracted = extractGeometries(root);
    expect(extracted.materials).toHaveLength(2);
    expect((extracted.materials[0] as THREE.Material & { alphaTest: number }).alphaTest).toBe(0.42);
    expect((extracted.materials[1] as THREE.Material & { alphaTest: number }).alphaTest).toBe(0.2);
    extracted.geoms.forEach((geo) => geo.dispose());
    extracted.materials.forEach((material) => material?.dispose());
  });
});

describe('floor-loot presentation', () => {
  it('keeps weapon models near authored scale and seats settled items on support', () => {
    expect(WORLD_LOOT_WEAPON_SCALE).toBeLessThanOrEqual(1.3);
    expect(WORLD_LOOT_WEAPON_SCALE).toBeGreaterThanOrEqual(1);
    expect(lootRenderY(0.35, 'weapon')).toBeCloseTo(0.05, 8);
    expect(lootRenderY(0.35, 'consumable')).toBeCloseTo(0.18, 8);
  });
});
