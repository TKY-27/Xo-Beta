import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CharacterFactory } from '../../src/render/characters';

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
