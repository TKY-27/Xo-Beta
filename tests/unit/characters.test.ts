import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CharacterFactory, SKIN_IDS, SKIN_SPECS, skinForName } from '../../src/render/characters';

describe('character skins', () => {
  it('exposes six distinct deterministic procedural skin specs', () => {
    expect(SKIN_IDS).toHaveLength(6);
    expect(new Set(SKIN_IDS.map((id) => SKIN_SPECS[id].primary)).size).toBe(6);
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
