import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { buildAuthoredWeapon, createWeaponReloadSockets, resolveAuthoredWeaponRoles, type WeaponModel } from '../../src/render/weaponModels';
import { sightAdjustedPose } from '../../src/render/viewmodel';

function mesh(name: string, size: THREE.Vector3, position: THREE.Vector3): THREE.Mesh {
  const result = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshStandardMaterial());
  result.name = name;
  result.position.copy(position);
  return result;
}

function closeVector(actual: THREE.Vector3, expected: THREE.Vector3, epsilon = 1e-8): void {
  expect(actual.distanceTo(expected)).toBeLessThanOrEqual(epsilon);
}

function closeQuaternion(actual: THREE.Quaternion, expected: THREE.Quaternion, epsilon = 1e-8): void {
  expect(actual.angleTo(expected)).toBeLessThanOrEqual(epsilon);
}

describe('authored weapon role contracts', () => {
  it('binds shotgun pump exactly and never selects magazine-tube', () => {
    const root = new THREE.Group();
    const tube = mesh('magazine-tube', new THREE.Vector3(0.03, 0.03, 0.8), new THREE.Vector3(0, 0, -0.4));
    const pump = mesh('pump', new THREE.Vector3(0.08, 0.08, 0.2), new THREE.Vector3(0, 0, -0.1));
    const muzzle = mesh('muzzle', new THREE.Vector3(0.04, 0.04, 0.08), new THREE.Vector3(0, 0, -0.7));
    const trigger = mesh('trigger', new THREE.Vector3(0.03, 0.06, 0.05), new THREE.Vector3(0, 0, 0.1));
    root.add(tube, pump, muzzle, trigger);

    const roles = resolveAuthoredWeaponRoles(root, 'shotgun');

    expect(roles.action).toBe(pump);
    expect(roles.action).not.toBe(tube);
    expect(roles.muzzleSource).toBe(muzzle);
    expect(roles.trigger).toBe(trigger);
    expect(roles.required).toContain('pump');
  });

  it('reports a missing shotgun pump as a pump omission', () => {
    const root = new THREE.Group();
    root.add(mesh('muzzle', new THREE.Vector3(0.04, 0.04, 0.1), new THREE.Vector3()), mesh('trigger', new THREE.Vector3(0.03, 0.06, 0.05), new THREE.Vector3()));

    const roles = resolveAuthoredWeaponRoles(root, 'shotgun');

    expect(roles.action).toBeNull();
    expect(roles.missing).toContain('pump');
  });

  it('keeps missing baked sniper action and magazine explicit', () => {
    const root = new THREE.Group();
    const frame = mesh('FRAME_LOD0465', new THREE.Vector3(0.2, 0.2, 1), new THREE.Vector3());
    root.add(frame);

    const roles = resolveAuthoredWeaponRoles(root, 'sniper');

    expect(roles.muzzleSource).toBe(frame);
    expect(roles.action).toBeNull();
    expect(roles.magazine).toBeNull();
    expect(roles.missing).toEqual(expect.arrayContaining(['magazine', 'bolt', 'trigger']));
  });
  it('preserves authored base maps when converting generic weapon materials', () => {
    const texture = new THREE.DataTexture(new Uint8Array([180, 40, 20, 255]), 1, 1, THREE.RGBAFormat);
    texture.needsUpdate = true;
    const material = new THREE.MeshStandardMaterial({ name: 'Mat', map: texture });
    const root = new THREE.Group();
    const receiver = mesh('Body', new THREE.Vector3(0.3, 0.25, 1.2), new THREE.Vector3());
    receiver.material = material;
    const magazine = mesh('Magazine', new THREE.Vector3(0.08, 0.18, 0.1), new THREE.Vector3(0, -0.18, 0.05));
    const bolt = mesh('Bolt', new THREE.Vector3(0.08, 0.06, 0.16), new THREE.Vector3(0, 0.08, -0.2));
    const trigger = mesh('Trigger', new THREE.Vector3(0.04, 0.07, 0.06), new THREE.Vector3(0, -0.08, 0.05));
    const ejector = mesh('Ejector', new THREE.Vector3(0.04, 0.04, 0.08), new THREE.Vector3(0.1, 0.04, -0.1));
    root.add(receiver, magazine, bolt, trigger, ejector);

    const parts = buildAuthoredWeapon({ scene: root, animations: [] }, 'smg');

    expect(parts).not.toBeNull();
    const materials: THREE.Material[] = [];
    parts!.group.traverse((object) => {
      if (object instanceof THREE.Mesh) materials.push(...(Array.isArray(object.material) ? object.material : [object.material]));
    });
    expect(materials.some((candidate) => candidate instanceof MeshStandardNodeMaterial && candidate.map === texture)).toBe(true);
  });
});

describe('authored weapon transforms', () => {
  it('uses the resolved muzzle geometry tip instead of whole-weapon bounds', () => {
    const root = new THREE.Group();
    const receiver = mesh('receiver', new THREE.Vector3(0.35, 0.25, 2), new THREE.Vector3());
    const muzzle = mesh('muzzle', new THREE.Vector3(0.04, 0.04, 0.1), new THREE.Vector3(0.08, 0.04, 0.65));
    const pump = mesh('pump', new THREE.Vector3(0.08, 0.08, 0.2), new THREE.Vector3(0, 0, -0.1));
    const trigger = mesh('trigger', new THREE.Vector3(0.03, 0.06, 0.05), new THREE.Vector3(0, 0, 0.1));
    root.add(receiver, muzzle, pump, trigger);

    const parts = buildAuthoredWeapon({ scene: root, animations: [] }, 'shotgun');
    expect(parts).not.toBeNull();
    const source = parts!.roles.muzzleSource!;
    parts!.group.updateMatrixWorld(true);
    const sourceBounds = new THREE.Box3().setFromObject(source);
    const sourceTip = sourceBounds.getCenter(new THREE.Vector3());
    sourceTip.z = sourceBounds.min.z;
    parts!.group.worldToLocal(sourceTip);

    closeVector(parts!.muzzlePoint, sourceTip);
    expect(parts!.muzzleZ).toBeCloseTo(sourceTip.z, 8);
    expect(parts!.muzzlePoint.z).not.toBeCloseTo(new THREE.Box3().setFromObject(parts!.group).min.z, 8);
  });

  it('derives seated reload transforms from the full authored parent chain', () => {
    const group = new THREE.Group();
    group.position.set(0.12, -0.07, 0.05);
    group.rotation.set(0.08, -0.14, 0.06);
    group.scale.set(1.2, 0.8, 0.9);
    const parent = new THREE.Group();
    parent.position.set(0.03, 0.02, -0.04);
    parent.rotation.set(-0.12, 0.18, 0.1);
    parent.scale.setScalar(1.1);
    const magazine = mesh('magazine', new THREE.Vector3(0.06, 0.18, 0.08), new THREE.Vector3(0.04, -0.03, 0.02));
    magazine.scale.set(0.8, 1.2, 0.6);
    parent.add(magazine);
    group.add(parent);
    group.updateMatrixWorld(true);

    const expectedMatrix = group.matrixWorld.clone().invert().multiply(magazine.matrixWorld);
    const expectedPosition = new THREE.Vector3();
    const expectedQuaternion = new THREE.Quaternion();
    const expectedScale = new THREE.Vector3();
    expectedMatrix.decompose(expectedPosition, expectedQuaternion, expectedScale);
    const model: WeaponModel = {
      group,
      muzzle: new THREE.Vector3(),
      mag: magazine,
      bolt: null,
      accents: [],
      gripR: new THREE.Vector3(),
      gripL: new THREE.Vector3(),
    };

    const sockets = createWeaponReloadSockets(model, 'ar');

    expect(magazine.parent).toBe(group);
    closeVector(sockets.seated.position, expectedPosition);
    closeQuaternion(sockets.seated.quaternion, expectedQuaternion);
    closeVector(sockets.seated.scale, expectedScale);
  });
});

describe('ADS sight projection', () => {
  it('aligns projected rear and front points through an authored group transform', () => {
    const group = new THREE.Group();
    group.position.set(0, 0, 0);
    group.rotation.set(0.12, -0.18, 0.09);
    group.scale.set(0.72, 0.81, 0.66);
    const model: WeaponModel = {
      group,
      muzzle: new THREE.Vector3(0, 0, -1),
      mag: null,
      bolt: null,
      accents: [],
      gripR: new THREE.Vector3(),
      gripL: new THREE.Vector3(),
      sight: {
        kind: 'iron',
        rear: new THREE.Vector3(0.02, 0.12, 0.06),
        front: new THREE.Vector3(0.02, 0.12, -0.7),
        eyeRelief: 0.08,
      },
    };
    const pose = sightAdjustedPose(model, 'ar', 0.66);
    const pivot = new THREE.Group();
    pivot.position.set(pose.x, pose.y, pose.z);
    pivot.rotation.set(pose.pitch, pose.yaw, pose.roll);
    pivot.add(group);
    pivot.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.08, 100);
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const rear = model.sight!.rear.clone().applyMatrix4(group.matrixWorld).project(camera);
    const front = model.sight!.front.clone().applyMatrix4(group.matrixWorld).project(camera);

    expect(Math.abs(rear.x)).toBeLessThan(1e-7);
    expect(Math.abs(rear.y)).toBeLessThan(1e-7);
    expect(front.x - rear.x).toBeLessThan(1e-7);
    expect(front.y - rear.y).toBeLessThan(1e-7);
    expect(front.z).toBeGreaterThan(rear.z);
  });
});
