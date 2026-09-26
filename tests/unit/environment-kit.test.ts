import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  canonicalEnvironmentTransform,
  defineEnvironmentKit,
  defineEnvironmentPlan,
  defineEnvironmentPrefab,
  defineEnvironmentPrefabInstance,
  environmentTransformToMatrix,
  resolveEnvironmentInstance,
  resolveEnvironmentPlan,
  transformEnvironmentPoint,
  type EnvironmentTransform,
} from '../../src/world/environmentKit';
import { createEnvironmentPlan, environmentPlanAssetPaths } from '../../src/world/environmentPlans';
import {
  createEnvironmentPrefabFromGlb,
  normalizeEnvironmentGlb,
} from '../../src/render/environmentKitGlb';

describe('authored environment kit contracts', () => {
  it('canonicalizes prefab transforms without negative zero or input precision noise', () => {
    const transform: EnvironmentTransform = {
      position: [1.123456789, -0, -2.0000004],
      rotation: { pitch: -0.0000004, yaw: 0.123456789, roll: 0 },
      scale: [1.0000004, 1, 1],
    };
    const first = canonicalEnvironmentTransform(transform);
    const second = canonicalEnvironmentTransform({
      position: [1.1234569, 0, -2.0000001],
      rotation: { pitch: 0, yaw: 0.1234569, roll: -0 },
      scale: [1.0000001, 1, 1],
    });
    expect(first).toEqual(second);
    expect(first.position).toEqual([1.123457, 0, -2]);
    expect(Object.is(first.position[1], -0)).toBe(false);
    expect(first.rotation.pitch).toBe(0);
  });

  it('uses the renderer YXZ convention for point transforms', () => {
    const transform: EnvironmentTransform = {
      position: [3, -2, 5],
      rotation: { pitch: 0.21, yaw: -0.73, roll: 0.17 },
      scale: [1.5, 0.8, 2.1],
    };
    const point: [number, number, number] = [1.25, -0.5, 2];
    const matrix = new THREE.Matrix4().fromArray(environmentTransformToMatrix(transform));
    const expected = new THREE.Vector3(...point).applyMatrix4(matrix);
    const actual = transformEnvironmentPoint(point, transform);
    expect(actual[0]).toBeCloseTo(expected.x, 5);
    expect(actual[1]).toBeCloseTo(expected.y, 5);
    expect(actual[2]).toBeCloseTo(expected.z, 5);
  });

  it('matches Three.js YXZ transforms for cardinal rotations and scale', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const transform: EnvironmentTransform = {
        position: [1, 2, 3],
        rotation: { pitch: 0, yaw, roll: 0 },
        scale: [2, 3, 4],
      };
      const actual = new THREE.Matrix4().fromArray(environmentTransformToMatrix(transform));
      const expected = new THREE.Matrix4().compose(
        new THREE.Vector3(...transform.position),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ')),
        new THREE.Vector3(...transform.scale),
      );
      for (let index = 0; index < 16; index += 1) {
        expect(actual.elements[index]).toBeCloseTo(expected.elements[index]!, 5);
      }
    }
  });

  it('keeps render, collision, navigation, and cover metadata in separate layers', () => {
    const prefab = defineEnvironmentPrefab({
      id: ' modular-crate ',
      render: {
        assetPath: 'models/kit/crate.glb',
        bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
        nodeNames: ['body', 'lid'],
        meshCount: 2,
        triangleCount: 24,
      },
      collision: [{
        kind: 'box',
        center: [0, 1, 0],
        halfExtents: [0.9, 1, 0.9],
        rotation: { pitch: 0, yaw: 0.5, roll: 0 },
      }],
      navigation: {
        role: 'obstacle',
        tags: ['solid', 'exterior'],
      },
      cover: {
        heightClass: 'waist',
        height: 1.1,
        protection: 'partial',
        crouchSafe: true,
        blocksProjectiles: true,
      },
      metadata: {
        source: 'candidate-glb',
        license: 'CC0-1.0',
        candidate: true,
        sourceLabel: 'CC0 modular kit candidate',
        tags: ['kit', 'candidate'],
        provenance: { reviewed: false },
      },
    });

    expect(prefab.id).toBe('modular-crate');
    expect(prefab.render.assetPath).toBe('models/kit/crate.glb');
    expect(prefab.render.nodeNames).toEqual(['body', 'lid']);
    expect(prefab.collision.mode).toBe('static');
    expect(prefab.collision.proxies[0]).toMatchObject({ kind: 'box' });
    expect(prefab.navigation).toMatchObject({ role: 'obstacle', walkable: false, blocksMovement: true });
    expect(prefab.cover).toMatchObject({ heightClass: 'waist', crouchSafe: true, blocksProjectiles: true });
    expect(prefab.metadata).toMatchObject({
      source: 'candidate-glb',
      license: 'CC0-1.0',
      candidate: true,
      provenance: { reviewed: false },
    });
    expect(prefab.metadata.tags).toEqual(['candidate', 'kit']);
    expect(prefab.render.bounds).toEqual({
      min: [-1, 0, -1],
      max: [1, 2, 1],
      size: [2, 2, 2],
      center: [0, 1, 0],
    });
  });

  it('sorts kit prefabs deterministically and rejects duplicate ids', () => {
    const first = defineEnvironmentPrefab({ id: 'b', render: { assetPath: 'b.glb' } });
    const second = defineEnvironmentPrefab({ id: 'a', render: { assetPath: 'a.glb' } });
    const kit = defineEnvironmentKit({ id: 'modular-kit', version: '0.1.0', prefabs: [first, second] });
    expect(kit.prefabs.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(() => defineEnvironmentKit({
      id: 'modular-kit',
      version: '0.1.0',
      prefabs: [first, first],
    })).toThrow(/duplicate environment prefab id/);
  });

  it('resolves a deterministic instance transform against the referenced prefab', () => {
    const prefab = defineEnvironmentPrefab({ id: 'wall', render: { assetPath: 'wall.glb' } });
    const instance = defineEnvironmentPrefabInstance({
      id: 'wall-01',
      prefabId: 'wall',
      transform: {
        position: [10.0000004, 0, -0],
        rotation: { pitch: 0, yaw: 1.5707963, roll: 0 },
        scale: [1, 1, 1],
      },
      tags: ['exterior', 'module'],
    });
    const resolved = resolveEnvironmentInstance(prefab, instance);
    expect(resolved.instanceId).toBe('wall-01');
    expect(resolved.transform.position).toEqual([10, 0, 0]);
    expect(resolved.transform.rotation.yaw).toBe(1.570796);
    expect(resolved.render).toBe(prefab.render);
    expect(resolved.collision).toEqual({ mode: 'none', proxies: [] });
  });
});

describe('environment GLB normalization', () => {
  it('clones and rebases an authored scene while retaining mesh metadata', () => {
    const source = new THREE.Group();
    source.name = 'candidate-module';
    const geometry = new THREE.BoxGeometry(2, 4, 2);
    geometry.translate(3, 2, -1);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.name = 'body';
    source.add(mesh);

    const normalized = normalizeEnvironmentGlb(source, {
      assetPath: 'models/environment/candidate.glb',
      origin: 'bottom-center',
      uniformScale: 2,
      materialMode: 'preserve',
    });

    expect(source.children[0]).toBe(mesh);
    expect(normalized.assetPath).toBe('models/environment/candidate.glb');
    expect(normalized.scene).not.toBe(source);
    expect(normalized.meshCount).toBe(1);
    expect(normalized.triangleCount).toBe(12);
    expect(normalized.render.nodeNames).toEqual(['body']);
    expect(normalized.bounds.min).toEqual([-2, 0, -2]);
    expect(normalized.bounds.max).toEqual([2, 8, 2]);
     expect(normalized.nodes.some(({ name }) => name === 'body')).toBe(true);
     const normalizedMesh = normalized.scene.getObjectByName('body') as THREE.Mesh;
     const normalizedMaterial = Array.isArray(normalizedMesh.material) ? normalizedMesh.material[0] : normalizedMesh.material;
     expect(normalizedMaterial?.userData.externalShared).toBe(true);
  });

  it('bakes source mesh transforms before canonical normalization', () => {
    const source = new THREE.Group();
    source.name = 'transformed-module';
    source.position.set(8, -3, 5);
    source.rotation.set(0.2, -0.35, 0.15);
    source.scale.set(1.5, 0.8, 2.2);
    const group = new THREE.Group();
    group.name = 'nested';
    group.position.set(-2, 1, 3);
    group.rotation.set(-0.1, 0.25, -0.2);
    group.scale.set(0.7, 1.3, 1.1);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshBasicMaterial());
    mesh.name = 'body';
    mesh.position.set(0.5, 0.25, -0.75);
    mesh.rotation.set(0.3, 0.4, -0.2);
    mesh.scale.set(1.2, 0.6, 0.8);
    group.add(mesh);
    source.add(group);
    source.updateMatrixWorld(true);
    const sourceBounds = new THREE.Box3().setFromObject(source);

    const normalized = normalizeEnvironmentGlb(source, {
      assetPath: 'models/environment/transformed.glb',
      materialMode: 'preserve',
    });
    const bakedMesh = normalized.scene.getObjectByName('body') as THREE.Mesh;
    const size = sourceBounds.getSize(new THREE.Vector3());

    expect(bakedMesh).toBeInstanceOf(THREE.Mesh);
    expect(bakedMesh.position.toArray()).toEqual([0, 0, 0]);
    expect(bakedMesh.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(bakedMesh.scale.toArray()).toEqual([1, 1, 1]);
    expect(normalized.bounds.min[0]).toBeCloseTo(-size.x / 2, 5);
    expect(normalized.bounds.min[1]).toBe(0);
    expect(normalized.bounds.min[2]).toBeCloseTo(-size.z / 2, 5);
    expect(normalized.bounds.max[0]).toBeCloseTo(size.x / 2, 5);
    expect(normalized.bounds.max[1]).toBeCloseTo(size.y, 5);
    expect(normalized.bounds.max[2]).toBeCloseTo(size.z / 2, 5);
  });

  it('converts standard materials to the node path without mutating the source', () => {
    const source = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.name = 'body';
    source.add(mesh);
    const normalized = normalizeEnvironmentGlb(source, { assetPath: 'candidate.glb' });
    const normalizedMesh = normalized.scene.getObjectByName('body') as THREE.Mesh;
    const sourceMesh = source.getObjectByName('body') as THREE.Mesh;
    const normalizedMaterial = normalizedMesh.material;
    const sourceMaterial = sourceMesh.material;
    expect(Array.isArray(normalizedMaterial) ? normalizedMaterial[0]?.type : normalizedMaterial.type)
      .toBe('MeshStandardNodeMaterial');
    expect(Array.isArray(sourceMaterial) ? sourceMaterial[0]?.type : sourceMaterial.type)
      .toBe('MeshStandardMaterial');
  });

  it('creates a candidate prefab without inferring collision, navigation, or cover', () => {
    const source = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
    );
    source.add(mesh);
    const normalized = normalizeEnvironmentGlb(source, {
      assetPath: 'models/environment/candidate.glb',
      materialMode: 'preserve',
    });
    const prefab = createEnvironmentPrefabFromGlb(normalized, {
      id: 'candidate-module',
      metadata: { license: 'CC0-1.0', sourceLabel: 'CC0 candidate' },
    });

    expect(prefab.render).toEqual(normalized.render);
    expect(prefab.collision).toEqual({ mode: 'none', proxies: [] });
    expect(prefab.navigation).toMatchObject({ role: 'none', walkable: false, blocksMovement: false });
    expect(prefab.cover).toMatchObject({ heightClass: 'none', protection: 'none' });
    expect(prefab.metadata).toMatchObject({
      source: 'candidate-glb',
      license: 'CC0-1.0',
      candidate: true,
    });
  });
});

describe('canonical environment plans', () => {
  it('builds deterministic visual-only plans for every map profile', () => {
    for (const mapId of ['eden', 'neocity', 'oldfront', 'ashara']) {
      const plan = createEnvironmentPlan(mapId, () => 1.25);
      const resolved = resolveEnvironmentPlan(plan);
      expect(plan.kit.id).toBe(
        mapId === 'eden'
          ? 'xo-beta-eden-wetland-slice'
          : mapId === 'oldfront'
            ? 'xo-beta-old-front-fortified-kit'
            : mapId === 'ashara'
              ? 'xo-beta-ashara-settlement-kit'
              : 'xo-beta-modular-facility',
      );
      expect(plan.instances.length).toBeGreaterThan(0);
      expect(resolved.length).toBe(plan.instances.length);
      expect(new Set(resolved.map(({ instanceId }) => instanceId)).size).toBe(resolved.length);
       expect(plan.instances.every(({ tags }) => tags.includes('visual-only') || tags.includes('collision-bridge'))).toBe(true);
      expect(resolved.every(({ navigation }) => (
        navigation.role === 'none'
        || (navigation.blocksMovement && navigation.tags.includes('authored') && navigation.tags.includes('solid'))
      ))).toBe(true);
      expect(resolved.some(({ collision }) => collision.mode === 'static')).toBe(true);
       expect(resolved.every(({ metadata }) => metadata.license === 'CC0-1.0' || metadata.license === 'CC-BY-4.0')).toBe(true);
    }
  });

  it('builds a bounded authored Ashara market district with an authored approach', () => {
    const plan = createEnvironmentPlan('ashara', () => 0);
    const resolved = resolveEnvironmentPlan(plan);
    const buildings = resolved.filter(({ prefabId }) => prefabId === 'marketHall' || prefabId === 'shopRow');
    const background = resolved.filter(({ instanceId }) => instanceId.startsWith('ashara-market-background-'));
    const cargo = resolved.filter(({ instanceId }) => instanceId.startsWith('ashara-market-cargo-') || instanceId.startsWith('ashara-market-table-') || instanceId.startsWith('ashara-market-produce-') || instanceId.startsWith('ashara-market-stack-') || instanceId.startsWith('ashara-market-crate-'));
    const approach = resolved.filter(({ instanceId }) => instanceId.startsWith('ashara-approach-'));
    const enclosure = resolved.filter(({ instanceId }) => instanceId.startsWith('ashara-enclosure-'));
    const props = resolved.filter(({ instanceId }) => instanceId.startsWith('ashara-market-pot-') || instanceId.startsWith('ashara-market-vase-') || instanceId.startsWith('ashara-market-lantern-'));
    expect(resolved.some(({ instanceId }) => instanceId === 'ashara-settlement-fort')).toBe(false);
    expect(resolved.some(({ instanceId }) => instanceId.startsWith('ashara-market-stall-'))).toBe(false);
    expect(buildings).toHaveLength(2);
    expect(background).toHaveLength(4);
    expect(cargo).toHaveLength(11);
    expect(approach).toHaveLength(10);
    expect(enclosure).toHaveLength(3);
    expect(props).toHaveLength(9);
    expect(buildings.every(({ collision }) => collision.mode === 'static' && collision.proxies.length === 8)).toBe(true);
    expect(background.every(({ collision }) => collision.mode === 'static' && collision.proxies.length === 1)).toBe(true);
    expect(buildings.every(({ metadata }) => metadata.license === 'CC0-1.0' && metadata.provenance.author === 'XO Beta original authoring pipeline')).toBe(true);
    const assets = environmentPlanAssetPaths(plan);
    expect(assets).toContain('environment/xo-market/market-hall.glb');
    expect(assets).toContain('environment/xo-market/shop-row.glb');
    expect(assets).toContain('environment/kaykit/kaykit-home-a.glb');
    expect(assets).toContain('environment/kaykit/kaykit-home-b.glb');
    expect(assets).toContain('environment/kaykit/kaykit-tower-a.glb');
    expect(assets).toContain('environment/kaykit/kaykit-tavern.glb');
    expect(assets).not.toContain('environment/kaykit-market.glb');
    expect(assets).not.toContain('environment/polyhaven/modular-fort-01.glb');
    expect(assets).toContain('environment/quaternius/medieval-market-stand-1.glb');
    expect(assets).toContain('environment/quaternius/medieval-market-stand-2.glb');
    expect(assets).not.toContain('environment/megakit/roof-round-tile-2x4.glb');
    expect(assets).toContain('environment/quaternius/wall-uneven-brick-straight.glb');
    expect(assets).toContain('environment/quaternius/wall-plaster-straight.glb');
    expect(assets).toContain('environment/polyhaven/wooden-table-02.glb');
    expect(assets).toContain('environment/polyhaven/ceramic-pot.glb');
    expect(assets).toContain('environment/polyhaven/ceramic-vase.glb');
    expect(assets).toContain('environment/polyhaven/brass-lantern.glb');
  });

  it('rejects duplicate and unknown plan instances', () => {
    const prefab = defineEnvironmentPrefab({ id: 'wall', render: { assetPath: 'wall.glb' } });
    const kit = defineEnvironmentKit({ id: 'plan-kit', version: '1', prefabs: [prefab] });
    const transform = { position: [0, 0, 0] as [number, number, number], rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: [1, 1, 1] as [number, number, number] };
    expect(() => defineEnvironmentPlan(kit, [
      { id: 'same', prefabId: 'wall', transform },
      { id: 'same', prefabId: 'wall', transform },
    ])).toThrow(/duplicate environment instance id/);
    expect(() => defineEnvironmentPlan(kit, [
      { id: 'unknown', prefabId: 'missing', transform },
    ])).toThrow(/unknown prefab/);
  });
});
