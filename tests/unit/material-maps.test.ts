import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { toNodeStandard } from '../../src/render/props';
import { makeGunMaterials } from '../../src/render/weaponGeometry';

describe('node material relief preservation', () => {
  it.each([THREE.TangentSpaceNormalMap, THREE.ObjectSpaceNormalMap])('preserves normal type %s and independent scale with color and roughness maps', (normalMapType) => {
    const map = new THREE.Texture();
    map.colorSpace = THREE.SRGBColorSpace;
    const normalMap = new THREE.Texture();
    const roughnessMap = new THREE.Texture();
    const source = new THREE.MeshStandardMaterial({
      map, normalMap, roughnessMap, normalMapType,
      normalScale: new THREE.Vector2(0.35, -0.6),
    });
    const node = toNodeStandard(source);
    expect(node.map).toBe(map);
    expect(node.normalMap).toBe(normalMap);
    expect(node.roughnessMap).toBe(roughnessMap);
    expect(node.normalMapType).toBe(normalMapType);
    expect(node.normalScale.toArray()).toEqual([0.35, -0.6]);
    expect(node.normalScale).not.toBe(source.normalScale);
    expect(node.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect(node.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    node.dispose();
    source.dispose();
    for (const texture of [map, normalMap, roughnessMap]) texture.dispose();
  });

  it('preserves a small grayscale bump and its signed scale', () => {
    const bumpMap = new THREE.Texture();
    const source = new THREE.MeshStandardMaterial({ bumpMap, bumpScale: -0.00025 });
    const node = toNodeStandard(source);
    expect(node.bumpMap).toBe(bumpMap);
    expect(node.bumpScale).toBe(-0.00025);
    expect(node.normalMap).toBeNull();
    expect(node.bumpMap!.colorSpace).toBe(THREE.NoColorSpace);
    node.dispose();
    source.dispose();
    bumpMap.dispose();
  });
});

describe('weapon stipple relief', () => {
  it('uses sub-millimeter bump scales rather than grayscale normal maps', () => {
    const materials = makeGunMaterials();
    expect(materials.polymer.normalMap).toBeNull();
    expect(materials.rubber.normalMap).toBeNull();
    expect(materials.polymer.bumpScale).toBe(0.00018);
    expect(materials.rubber.bumpScale).toBe(0.00025);
    for (const material of Object.values(materials)) material.dispose();
  });
});
