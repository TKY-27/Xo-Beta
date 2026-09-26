import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CharacterFactory, SKIN_IDS, SKIN_SPECS, authoredMaterialRole, skinForName, styleAuthoredMaterial } from '../../src/render/characters';

describe('character skins', () => {
  it('exposes twelve distinct deterministic procedural skin specs', () => {
    expect(SKIN_IDS).toHaveLength(12);
    // Every skin keeps a distinct primary palette entry.
    expect(new Set(SKIN_IDS.map((id) => SKIN_SPECS[id].primary)).size).toBe(SKIN_IDS.length);
    expect(skinForName('bot-alpha')).toBe(skinForName('bot-alpha'));
    expect(SKIN_IDS).toContain(skinForName('bot-alpha'));
  });

  it('keeps the fallback rig visible when character assets are unavailable', () => {
    const rig = new CharacterFactory().create('FALLBACK', 0x5fd0ff, false, null, 'nova');
    const meshes: THREE.Mesh[] = [];
    rig.group.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
    });
    expect(meshes.length).toBeGreaterThan(0);
    expect(rig.group.visible).toBe(true);
    const bounds = new THREE.Box3().setFromObject(rig.group);
    expect(bounds.min.y).toBeCloseTo(0, 5);
    expect(bounds.max.y).toBeGreaterThan(1.8);
    expect(bounds.max.y).toBeLessThan(1.9);
    rig.dispose();
  });
});

describe('authored SWAT materials', () => {
  it('maps source names to stable semantic roles', () => {
    expect(authoredMaterialRole('DarkBrown')).toBe('darkBrown');
    expect(authoredMaterialRole('Swat_Black')).toBe('swatBlack');
    expect(authoredMaterialRole('Visor')).toBe('visor');
    expect(authoredMaterialRole('unknown')).toBeNull();
  });

  it('keeps skin and visor source color while separating their response', () => {
    const suit = new THREE.Color(0x2d6cdf);
    const skin = new THREE.MeshStandardMaterial({ name: 'Skin', color: 0xc58b6a, emissive: 0x111111, roughness: 0.5, metalness: 0.1 });
    const visor = new THREE.MeshStandardMaterial({ name: 'Visor', color: 0x101820, emissive: 0x111111, roughness: 0.5, metalness: 0 });
    styleAuthoredMaterial(skin, authoredMaterialRole(skin.name), suit);
    styleAuthoredMaterial(visor, authoredMaterialRole(visor.name), suit);
    expect(skin.color.getHex()).toBe(0xc58b6a);
    expect(skin.emissive.getHex()).toBe(0);
    expect(skin.roughness).toBe(0.76);
    expect(skin.metalness).toBe(0);
    expect(visor.color.getHex()).toBe(0x101820);
    expect(visor.emissive.getHex()).toBe(0);
    expect(visor.roughness).toBe(0.2);
    expect(visor.metalness).toBe(0.55);
  });

  it('gives tactical roles distinct PBR values and leaves unknown roles source-faithful', () => {
    const suit = new THREE.Color(0x2d6cdf);
    const swat = new THREE.MeshStandardMaterial({ name: 'Swat', color: 0x334455, roughness: 0.5, metalness: 0 });
    const black = new THREE.MeshStandardMaterial({ name: 'Black', color: 0x111111, roughness: 0.5, metalness: 0 });
    const unknown = new THREE.MeshStandardMaterial({ name: 'SourceOnly', color: 0xabcdef, emissive: 0x123456, roughness: 0.37, metalness: 0.12, envMapIntensity: 0.42 });
    styleAuthoredMaterial(swat, authoredMaterialRole(swat.name), suit);
    styleAuthoredMaterial(black, authoredMaterialRole(black.name), suit);
    styleAuthoredMaterial(unknown, authoredMaterialRole(unknown.name), suit);
    expect(swat.roughness).toBe(0.8);
    expect(swat.metalness).toBe(0.05);
    expect(black.roughness).toBe(0.48);
    expect(black.metalness).toBe(0.35);
    expect(unknown.color.getHex()).toBe(0xabcdef);
    expect(unknown.emissive.getHex()).toBe(0x123456);
    expect(unknown.roughness).toBe(0.37);
    expect(unknown.metalness).toBe(0.12);
    expect(unknown.envMapIntensity).toBe(0.42);
  });
});

describe('character resource ownership', () => {
  it('disposes actor-owned resources without destroying shared body geometry', async () => {
    const bodyGeometry = new THREE.BoxGeometry(0.5, 1, 0.3);
    const prototypeMaterial = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const prototype = new THREE.Group();
    prototype.add(new THREE.Mesh(bodyGeometry, prototypeMaterial));
    const head = new THREE.Bone();
    head.name = 'Head';
    prototype.add(head);

    const factory = new CharacterFactory();
    await factory.init(
      prototype,
      prototype.clone(),
      [new THREE.AnimationClip('Idle_Loop', 1, [])],
    );
    const rig = factory.create('RESOURCE_OWNER', 0x5fd0ff, false);
    const parent = new THREE.Group();
    parent.add(rig.group);

    const clonedBody = rig.group.getObjectByProperty('geometry', bodyGeometry) as THREE.Mesh;
    const clonedMaterial = clonedBody.material as THREE.Material;
    expect(clonedMaterial).not.toBe(prototypeMaterial);
    const generatedGeometry = new Set<THREE.BufferGeometry>();
    rig.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry !== bodyGeometry) generatedGeometry.add(mesh.geometry);
    });
    expect(generatedGeometry.size).toBeGreaterThan(0);

    const sharedGeometryDispose = vi.spyOn(bodyGeometry, 'dispose');
    const prototypeMaterialDispose = vi.spyOn(prototypeMaterial, 'dispose');
    const clonedMaterialDispose = vi.spyOn(clonedMaterial, 'dispose');
    const generatedDisposes = [...generatedGeometry].map((geometry) => vi.spyOn(geometry, 'dispose'));

    rig.dispose();
    rig.dispose();

    expect(rig.group.parent).toBeNull();
    expect(sharedGeometryDispose).not.toHaveBeenCalled();
    expect(prototypeMaterialDispose).not.toHaveBeenCalled();
    expect(clonedMaterialDispose).toHaveBeenCalledTimes(1);
    for (const dispose of generatedDisposes) expect(dispose).toHaveBeenCalledTimes(1);
  });
});
