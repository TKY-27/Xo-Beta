/**
 * Weapon model composition: builds the five weapon classes from procedural
 * firearm anatomy (see weaponGeometry.ts) with rarity attachments and accent
 * materials. Shared by first-person viewmodel, world loot and character hand
 * attachments.
 */

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { RARITY_COLORS, RARITIES, type Rarity, type WeaponId } from '../core/balance';
import { peekGltf, type GltfAsset } from '../assets/assets';
import { buildProceduralWeapon, makeGunMaterials, makeSkinTexture, type GunMaterials, type ProceduralWeapon } from './weaponGeometry';
import { toNodeStandard } from './props';

export interface WeaponSight {
  kind: 'iron' | 'optic' | 'bead';
  rear: THREE.Vector3;
  front: THREE.Vector3;
  eyeRelief: number;
}

export interface WeaponModel {
  group: THREE.Group;
  /** Muzzle position in weapon-local space (barrel points -Z). */
  muzzle: THREE.Vector3;
  /** Magazine object for reload animation (may be null). */
  mag: THREE.Object3D | null;
  /** Bolt/slide/pump object for cycling animation (may be null). */
  bolt: THREE.Object3D | null;
  /** Accent meshes whose emissive follows rarity. */
  accents: THREE.MeshStandardMaterial[];
  /** CYCLE 35: first-person hand anchors (weapon-local metres). */
  gripR: THREE.Vector3;
  gripL: THREE.Vector3;
  sight?: WeaponSight;
  reloadSockets?: WeaponReloadSockets;
}

export interface WeaponReloadSockets {
  seated: THREE.Object3D;
  withdrawn: THREE.Object3D;
  stow: THREE.Object3D;
  spare: THREE.Object3D;
  approach: THREE.Object3D;
  magazineContact: THREE.Object3D;
  actionContact: THREE.Object3D;
  port: THREE.Object3D;
  shellContact: THREE.Object3D;
}

export interface AuthoredPistolParts {
  group: THREE.Group;
  muzzleZ: number;
  muzzleY: number;
  muzzlePoint: THREE.Vector3;
  mag: THREE.Object3D | null;
  bolt: THREE.Object3D | null;
  railY: number;
  railZ: number;
  gripR: THREE.Vector3;
  gripL: THREE.Vector3;
  sight: WeaponSight;
}

const AUTHORED_PISTOL_PATH = 'weapons/authored-pistol.glb';
const AUTHORED_WEAPON_PATHS: Partial<Record<WeaponId, string>> = {
  ar: 'weapons/authored-ar-ak47.glb',
  smg: 'weapons/authored-smg-suomi.glb',
  shotgun: 'weapons/authored-shotgun-pump.glb',
  sniper: 'weapons/authored-sniper-m700.glb',
};
export interface AuthoredWeaponParts extends ProceduralWeapon {
  muzzleY: number;
  muzzlePoint: THREE.Vector3;
  sight: WeaponSight;
  roles: AuthoredRoleBinding;
}

type Vec3Tuple = readonly [number, number, number];
type AuthoredWeaponId = Exclude<WeaponId, 'pistol'>;
type WeaponPartRole = 'magazine' | 'bolt' | 'pump' | 'muzzle' | 'muzzleSource' | 'rearSight' | 'frontSight' | 'trigger' | 'port';

export interface AuthoredRoleBinding {
  magazine: THREE.Object3D | null;
  action: THREE.Object3D | null;
  muzzleSource: THREE.Object3D | null;
  trigger: THREE.Object3D | null;
  rearSight: THREE.Object3D | null;
  frontSight: THREE.Object3D | null;
  port: THREE.Object3D | null;
  missing: readonly WeaponPartRole[];
  required: readonly WeaponPartRole[];
}

type RoleSpec = Partial<Record<Exclude<WeaponPartRole, 'muzzle'>, readonly string[]>>;
type SightSpec = {
  kind: WeaponSight['kind'];
  rear: Vec3Tuple;
  front: Vec3Tuple;
  rearSource?: string;
  frontSource?: string;
  eyeRelief: number;
};

const AUTHORED_ROLE_SPECS: Record<AuthoredWeaponId, RoleSpec> = {
  ar: {
    magazine: ['magazine'],
    trigger: ['trigger'],
    muzzleSource: ['ak47'],
    port: ['ejectionport'],
  },
  smg: {
    magazine: ['magazine'],
    bolt: ['bolt'],
    trigger: ['trigger'],
    muzzleSource: ['body'],
    port: ['ejector'],
  },
  shotgun: {
    pump: ['pump'],
    trigger: ['trigger'],
    muzzleSource: ['muzzle'],
    frontSight: ['frontsight'],
    port: ['receiverrail'],
  },
  sniper: {
    muzzleSource: ['framelod0465'],
    port: ['framelod0465'],
  },
};

const AUTHORED_REQUIRED_ROLES: Record<AuthoredWeaponId, readonly WeaponPartRole[]> = {
  ar: ['magazine', 'muzzleSource', 'trigger'],
  smg: ['magazine', 'bolt', 'muzzleSource', 'trigger'],
  shotgun: ['pump', 'muzzleSource', 'trigger'],
  sniper: ['muzzleSource'],
};

const AUTHORED_SIGHT_SPECS: Record<AuthoredWeaponId, SightSpec> = {
  ar: { kind: 'iron', rear: [0, 0.12, 0.01], front: [0, 0.12, -0.76], eyeRelief: 0.09 },
  smg: { kind: 'iron', rear: [0, 0.07, 0.06], front: [0, 0.07, -0.52], eyeRelief: 0.07 },
  shotgun: { kind: 'bead', rear: [0, 0.052, -0.072], front: [0, 0.039, -0.2], rearSource: 'receiverrail', frontSource: 'frontsight', eyeRelief: 0.1 },
  sniper: { kind: 'optic', rear: [0, 0.11, -0.08], front: [0, 0.11, -0.8], eyeRelief: 0.12 },
};

function normalizedAuthoredName(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function findExactObject(root: THREE.Object3D, names: readonly string[]): THREE.Object3D | null {
  const wanted = new Set(names.map(normalizedAuthoredName));
  let found: THREE.Object3D | null = null;
  root.traverse((object) => {
    if (!found && wanted.has(normalizedAuthoredName(object.name))) found = object;
  });
  return found;
}

function markRole(object: THREE.Object3D | null, role: WeaponPartRole): THREE.Object3D | null {
  if (!object) return null;
  const roles = Array.isArray(object.userData.weaponPartRoles) ? object.userData.weaponPartRoles as WeaponPartRole[] : [];
  if (!roles.includes(role)) roles.push(role);
  object.userData.weaponPartRoles = roles;
  if (!object.userData.weaponPartRole) object.userData.weaponPartRole = role;
  return object;
}

export function resolveAuthoredWeaponRoles(root: THREE.Object3D, weaponId: AuthoredWeaponId): AuthoredRoleBinding {
  const spec = AUTHORED_ROLE_SPECS[weaponId];
  const required = AUTHORED_REQUIRED_ROLES[weaponId];
  const magazine = markRole(findExactObject(root, spec.magazine ?? []), 'magazine');
  const bolt = markRole(findExactObject(root, spec.bolt ?? []), 'bolt');
  const pump = markRole(findExactObject(root, spec.pump ?? []), 'pump');
  const actionRole: WeaponPartRole = spec.pump ? 'pump' : 'bolt';
  const action = bolt ?? pump;
  const muzzleSource = markRole(findExactObject(root, spec.muzzleSource ?? []), 'muzzleSource');
  const trigger = markRole(findExactObject(root, spec.trigger ?? []), 'trigger');
  const rearSight = markRole(findExactObject(root, spec.rearSight ?? []), 'rearSight');
  const frontSight = markRole(findExactObject(root, spec.frontSight ?? []), 'frontSight');
  const port = markRole(findExactObject(root, spec.port ?? []), 'port');
  const missing: WeaponPartRole[] = [];
  if (!magazine) missing.push('magazine');
  if (!action) missing.push(actionRole);
  if (!muzzleSource) missing.push('muzzleSource');
  if (!trigger) missing.push('trigger');
  if (!rearSight) missing.push('rearSight');
  if (!frontSight) missing.push('frontSight');
  if (!port) missing.push('port');
  return { magazine, action, muzzleSource, trigger, rearSight, frontSight, port, missing, required };
}

function findRole(root: THREE.Object3D, role: WeaponPartRole): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((object) => {
    const roles = Array.isArray(object.userData.weaponPartRoles) ? object.userData.weaponPartRoles as WeaponPartRole[] : [];
    if (!found && (roles.includes(role) || object.userData.weaponPartRole === role)) found = object;
  });
  return found;
}

function objectCenter(root: THREE.Object3D, object: THREE.Object3D | null, fallback: THREE.Vector3): THREE.Vector3 {
  root.updateWorldMatrix(true, true);
  if (!object) return fallback.clone();
  object.updateWorldMatrix(true, false);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) return fallback.clone();
  return root.worldToLocal(bounds.getCenter(new THREE.Vector3()));
}

function muzzleTip(root: THREE.Object3D, source: THREE.Object3D): THREE.Vector3 | null {
  root.updateWorldMatrix(true, true);
  source.updateWorldMatrix(true, false);
  const bounds = new THREE.Box3().setFromObject(source);
  if (bounds.isEmpty()) return null;
  const tip = bounds.getCenter(new THREE.Vector3());
  tip.z = bounds.min.z;
  const local = root.worldToLocal(tip);
  return Number.isFinite(local.x) && Number.isFinite(local.y) && Number.isFinite(local.z) ? local : null;
}

function localTransform(root: THREE.Object3D, object: THREE.Object3D): { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 } {
  root.updateWorldMatrix(true, true);
  object.updateWorldMatrix(true, false);
  const matrix = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(object.matrixWorld);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion, scale };
}

function reparentToGroup(group: THREE.Group, object: THREE.Object3D | null): void {
  if (!object || object.parent === group) return;
  const transform = localTransform(group, object);
  object.removeFromParent();
  group.add(object);
  object.position.copy(transform.position);
  object.quaternion.copy(transform.quaternion);
  object.scale.copy(transform.scale);
}

function sightPoint(root: THREE.Object3D, source: THREE.Object3D | null, fallback: Vec3Tuple): THREE.Vector3 {
  return objectCenter(root, source, new THREE.Vector3(...fallback));
}

export function buildAuthoredWeapon(asset: GltfAsset, weaponId: AuthoredWeaponId): AuthoredWeaponParts | null {
  asset.scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(asset.scene);
  const size = bounds.getSize(new THREE.Vector3());
  const longAxis = size.x >= size.y && size.x >= size.z ? 'x' : size.z >= size.y ? 'z' : 'y';
  const sourceLength = size[longAxis];
  if (!Number.isFinite(sourceLength) || sourceLength <= 0) return null;
  const targetLength = LENGTHS[weaponId];
  const scale = targetLength / sourceLength;
  const center = bounds.getCenter(new THREE.Vector3());
  const rotation = new THREE.Matrix4();
  if (longAxis === 'y') rotation.makeRotationX(-Math.PI / 2);
  else if (longAxis === 'z') rotation.identity();
  else rotation.makeRotationY(Math.PI / 2);
  const transform = new THREE.Matrix4()
    .multiply(rotation)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
  const source = SkeletonUtils.clone(asset.scene) as THREE.Group;
  const materialCache = new Map<THREE.Material, THREE.Material>();
  const meshes: THREE.Mesh[] = [];
  source.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const materials = sourceMaterials.map((material) => authoredMaterial(material, materialCache));
    object.material = Array.isArray(object.material) ? materials : materials[0]!;
    object.userData = { ...object.userData, authoredWeapon: true, authoredWeaponId: weaponId };
    object.castShadow = true;
    object.receiveShadow = false;
     ensureGeometryUv(object.geometry);
     object.geometry.userData.externalShared = true;
    meshes.push(object);
  });
  if (meshes.length === 0) return null;
  source.applyMatrix4(transform);
  const group = new THREE.Group();
  group.add(source);
  group.updateMatrixWorld(true);
  const normalized = new THREE.Box3().setFromObject(group);
  const shiftZ = -targetLength - normalized.min.z;
  group.position.z = shiftZ;
  group.updateMatrixWorld(true);
  const finalBounds = new THREE.Box3().setFromObject(group);
  const finalSize = finalBounds.getSize(new THREE.Vector3());
  const roles = resolveAuthoredWeaponRoles(group, weaponId);
  const roleValue = (role: WeaponPartRole): THREE.Object3D | null => {
    if (role === 'magazine') return roles.magazine;
    if (role === 'bolt' || role === 'pump') return roles.action;
    if (role === 'muzzleSource') return roles.muzzleSource;
    if (role === 'trigger') return roles.trigger;
    if (role === 'rearSight') return roles.rearSight;
    if (role === 'frontSight') return roles.frontSight;
    if (role === 'port') return roles.port;
    return null;
  };
  if (roles.required.some((role) => !roleValue(role))) return null;
  const muzzleSource = roles.muzzleSource;
  if (!muzzleSource) return null;
  const muzzlePoint = muzzleTip(group, muzzleSource);
  if (!muzzlePoint) return null;
  const mag = roles.magazine;
  const bolt = roles.action;
  const magCenter = objectCenter(group, mag, new THREE.Vector3(0, finalSize.y * 0.15, -targetLength * 0.22));
  const triggerCenter = objectCenter(group, roles.trigger, magCenter.clone().add(new THREE.Vector3(0, 0.025, 0.015)));
  const gripR = weaponId === 'shotgun'
    ? new THREE.Vector3(0, finalBounds.min.y + finalSize.y * 0.32, -targetLength * 0.24)
    : new THREE.Vector3(triggerCenter.x, triggerCenter.y - 0.012, triggerCenter.z + 0.01);
  const gripL = new THREE.Vector3(0, magCenter.y - 0.01, -targetLength * (weaponId === 'sniper' ? 0.38 : weaponId === 'shotgun' ? 0.58 : 0.52));
  reparentToGroup(group, mag);
  reparentToGroup(group, bolt);
  const sightSpec = AUTHORED_SIGHT_SPECS[weaponId];
  const rearSource = sightSpec.rearSource ? findExactObject(group, [sightSpec.rearSource]) : roles.rearSight;
  const frontSource = sightSpec.frontSource ? findExactObject(group, [sightSpec.frontSource]) : roles.frontSight;
  const sightCenterX = finalBounds.getCenter(new THREE.Vector3()).x;
  const sightHeight = finalBounds.max.y - Math.min(0.012, finalSize.y * 0.04);
  const rearDepth = finalBounds.max.z - Math.min(0.025, finalSize.z * 0.03);
  const frontDepth = finalBounds.min.z + Math.min(0.14, finalSize.z * 0.18);
  const sight: WeaponSight = {
    kind: sightSpec.kind,
    rear: sightPoint(group, rearSource, [sightCenterX, sightHeight, rearDepth]),
    front: sightPoint(group, frontSource, [sightCenterX, sightHeight, frontDepth]),
    eyeRelief: sightSpec.eyeRelief,
  };
  group.userData.authoredContractMissing = roles.missing;
  group.userData.authoredContractRequired = roles.required;
  return {
    group,
    muzzleZ: muzzlePoint.z,
    muzzleY: muzzlePoint.y,
    muzzlePoint,
    mag,
    bolt,
    railY: finalBounds.max.y - 0.006,
    railZ: (finalBounds.min.z + finalBounds.max.z) * 0.5,
    gripR,
    gripL,
    sight,
    roles,
  };
}

function ensureGeometryUv(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute('uv')) return;
  const position = geometry.getAttribute('position');
  if (!position) return;
  const normal = geometry.getAttribute('normal');
  const values = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const nx = Math.abs(normal?.getX(index) ?? 0);
    const ny = Math.abs(normal?.getY(index) ?? 0);
    const nz = Math.abs(normal?.getZ(index) ?? 0);
    if (ny >= nx && ny >= nz) {
      values[index * 2] = x * 0.5;
      values[index * 2 + 1] = z * 0.5;
    } else if (nx >= nz) {
      values[index * 2] = z * 0.5;
      values[index * 2 + 1] = y * 0.5;
    } else {
      values[index * 2] = x * 0.5;
      values[index * 2 + 1] = y * 0.5;
    }
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(values, 2));
}

function authoredMaterial(source: THREE.Material, cache: Map<THREE.Material, THREE.Material>): THREE.Material {
  const cached = cache.get(source);
  if (cached) return cached;
  const material = toNodeStandard(source as unknown as THREE.MeshStandardMaterial);
  const pbr = material as unknown as THREE.MeshStandardMaterial;
  const name = source.name.toLowerCase();
  if (name === 'plastic') {
    pbr.color.set(0x2a3037);
    pbr.roughness = 0.56;
    pbr.metalness = 0.04;
  } else if (name === 'plastic trim') {
    pbr.color.set(0x3b444d);
    pbr.roughness = 0.48;
    pbr.metalness = 0.08;
  } else if (name === 'trou') {
    pbr.color.set(0x1b2026);
    pbr.roughness = 0.72;
    pbr.metalness = 0.02;
  } else if (name === 'slider metal') {
    pbr.color.set(0x68747e);
    pbr.roughness = 0.28;
    pbr.metalness = 0.72;
  } else if (name === 'barrel') {
    pbr.color.set(0x3a434b);
    pbr.roughness = 0.24;
    pbr.metalness = 0.78;
  } else if (name === 'material.002') {
    pbr.color.set(0x59656b);
    pbr.roughness = 0.4;
    pbr.metalness = 0.32;
  } else if (name.includes('wood')) {
    pbr.color.set(0x4a3020);
    pbr.roughness = 0.58;
    pbr.metalness = 0.04;
  } else if (name.includes('metal')) {
    pbr.color.set(0x3d454b);
    pbr.roughness = 0.3;
    pbr.metalness = 0.78;
  } else if (name === 'mat' || name.startsWith('wpn_')) {
    pbr.color.set(0x5e6d75);
    pbr.roughness = 0.48;
    pbr.metalness = 0.36;
  } else {
    pbr.color.set(0x53616a);
    pbr.roughness = 0.52;
    pbr.metalness = 0.24;
  }
  if (pbr.map) pbr.color.set(0xffffff);
  material.name = source.name;
  material.userData.weaponFactoryOwned = true;
  cache.set(source, material);
  return material;
}

function buildAuthoredPistol(asset: GltfAsset): AuthoredPistolParts | null {
  asset.scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(asset.scene);
  const size = bounds.getSize(new THREE.Vector3());
  if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z) || size.z <= 0) return null;
  const scale = 0.42 / size.z;
  const center = bounds.getCenter(new THREE.Vector3());
  const transform = new THREE.Matrix4()
    .makeTranslation(0, 0, -size.z * scale * 0.5)
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI))
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
  const source = SkeletonUtils.clone(asset.scene) as THREE.Group;
  const materialCache = new Map<THREE.Material, THREE.Material>();
  source.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const materials = sourceMaterials.map((material) => authoredMaterial(material, materialCache));
    object.material = Array.isArray(object.material) ? materials : materials[0]!;
    object.userData = { ...object.userData, authoredWeapon: true };
    object.castShadow = true;
    object.receiveShadow = false;
     ensureGeometryUv(object.geometry);
     object.geometry.userData.externalShared = true;
  });
  source.applyMatrix4(transform);
  const group = new THREE.Group();
  group.add(source);
  group.updateMatrixWorld(true);
  const normalized = new THREE.Box3().setFromObject(group);
  const shiftZ = -0.42 - normalized.min.z;
  group.position.z = shiftZ;
  group.updateMatrixWorld(true);
  const finalBounds = new THREE.Box3().setFromObject(group);
  const magazine = markRole(findExactObject(group, ['mag']), 'magazine');
  const bolt = markRole(findExactObject(group, ['slide002', 'slider']), 'bolt');
  const barrel = findExactObject(group, ['barrel']);
  if (!barrel || !bolt || !magazine) return null;
  const muzzlePoint = muzzleTip(group, barrel);
  if (!muzzlePoint) return null;
  const magazineCenter = objectCenter(group, magazine, new THREE.Vector3(0, -0.02, -0.08));
  const gripR = new THREE.Vector3(magazineCenter.x, magazineCenter.y + 0.012, magazineCenter.z + 0.026);
  const gripL = new THREE.Vector3(magazineCenter.x + 0.055, magazineCenter.y - 0.018, magazineCenter.z + 0.018);
  reparentToGroup(group, magazine);
  reparentToGroup(group, bolt);
  const sight: WeaponSight = {
    kind: 'iron',
    rear: sightPoint(group, findExactObject(group, ['rearsight']), [0, 0.13, -0.1]),
    front: sightPoint(group, findExactObject(group, ['frontsight']), [0, 0.13, -0.3]),
    eyeRelief: 0.05,
  };
  group.userData.authoredContractMissing = [
    ...(!magazine ? ['magazine' as const] : []),
    ...(!bolt ? ['bolt' as const] : []),
  ];
  return {
    group,
    muzzleZ: muzzlePoint.z,
    muzzleY: muzzlePoint.y,
    muzzlePoint,
    mag: magazine,
    bolt,
    railY: finalBounds.max.y - 0.014,
    railZ: (finalBounds.min.z + finalBounds.max.z) * 0.5 - 0.02,
    gripR,
    gripL,
    sight,
  };
}

export function createWeaponReloadSockets(model: WeaponModel, id: WeaponId): WeaponReloadSockets {
  reparentToGroup(model.group, model.mag);
  reparentToGroup(model.group, model.bolt);
  type SocketTransform = { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
  const identity: SocketTransform = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(1, 1, 1),
  };
  const partTransform = (part: THREE.Object3D | null): SocketTransform => part ? localTransform(model.group, part) : {
    position: identity.position.clone(),
    quaternion: identity.quaternion.clone(),
    scale: identity.scale.clone(),
  };
  const anchor = (name: string, transform: SocketTransform): THREE.Object3D => {
    const socket = new THREE.Object3D();
    socket.name = `reload-${name}`;
    socket.position.copy(transform.position);
    socket.quaternion.copy(transform.quaternion);
    socket.scale.copy(transform.scale);
    model.group.add(socket);
    return socket;
  };
  const relative = (base: SocketTransform, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): SocketTransform => ({
    position: new THREE.Vector3(x, y, z).multiply(base.scale).applyQuaternion(base.quaternion).add(base.position),
    quaternion: base.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz))),
    scale: base.scale.clone(),
  });
  const magazine = partTransform(model.mag);
  const action = partTransform(model.bolt);
  const seated = anchor('seated', magazine);
  const withdrawn = anchor('withdrawn', relative(magazine, 0, id === 'pistol' ? -0.14 : -0.2, id === 'ar' ? 0.065 : 0, id === 'ar' ? -0.38 : 0));
  const stowPosition = new THREE.Vector3(-0.13, id === 'sniper' ? -0.9 : -0.34, 0.07);
  const stow = anchor('stow', { position: stowPosition, quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.25, 0, -0.12)), scale: new THREE.Vector3(1, 1, 1) });
  const spare = anchor('spare', { position: stow.position.clone(), quaternion: stow.quaternion.clone(), scale: stow.scale.clone() });
  const approach = anchor('approach', relative(magazine, -0.015, id === 'pistol' ? -0.13 : -0.18, id === 'ar' ? 0.065 : 0.01, id === 'ar' ? -0.38 : 0));
  if (id === 'pistol') {
    withdrawn.position.copy(relative(magazine, 0, -0.14, 0).position);
    withdrawn.quaternion.copy(magazine.quaternion);
    approach.position.copy(withdrawn.position);
    approach.quaternion.copy(magazine.quaternion);
  }
  const magazineContact = anchor('magazine-contact', relative(magazine, -0.04, id === 'sniper' || id === 'pistol' ? -0.06 : -0.1, 0.016, 0.25, 0.2, Math.PI / 2));
  const actionContact = anchor('action-contact', relative(action, id === 'sniper' ? 0.044 : -0.025, 0.015, 0.024, 0.2, -0.15, -Math.PI / 2));
  const portSource = findRole(model.group, 'port');
  const portTransform = portSource
    ? localTransform(model.group, portSource)
    : {
      position: identity.position.clone(),
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.15, 0, 0)),
      scale: identity.scale.clone(),
    };
  portTransform.position = objectCenter(model.group, portSource, new THREE.Vector3(0, -0.022, -0.226));
  const port = anchor('port', portTransform);
  const shellContact = anchor('shell-contact', { position: new THREE.Vector3(-0.025, -0.046, 0.028), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0.2)), scale: new THREE.Vector3(1, 1, 1) });
  return { seated, withdrawn, stow, spare, approach, magazineContact, actionContact, port, shellContact };
}

const ALL_RARITIES = RARITIES;

/** Keep floor pickups near their authored one-metre weapon length. */
export const WORLD_LOOT_WEAPON_SCALE = 1.25;

/** Lightweight instance clone: shares geometries + materials with the archetype. */
function cloneWeaponModel(tmpl: WeaponModel): WeaponModel {
  const group = tmpl.group.clone(true);
  const part = (role: WeaponPartRole, legacyName: string): THREE.Object3D | null => (
    findRole(group, role) ?? group.getObjectByName(legacyName) ?? null
  );
  const mag = part('magazine', 'mag');
  const bolt = part('bolt', 'bolt') ?? part('pump', 'pump');
  const muzzleObj = part('muzzle', 'muzzle') ?? group.getObjectByName('muzzle');
  if (!muzzleObj) throw new Error('weapon clone lost muzzle marker');
  if (tmpl.mag && !mag) throw new Error('weapon clone lost magazine part');
  if (tmpl.bolt && !bolt) throw new Error('weapon clone lost action part');
  const socket = (name: string): THREE.Object3D => {
    const cloned = group.getObjectByName(name);
    if (!cloned) throw new Error(`weapon clone lost reload socket ${name}`);
    return cloned;
  };
  const reloadSockets = tmpl.reloadSockets
    ? {
      seated: socket(tmpl.reloadSockets.seated.name),
      withdrawn: socket(tmpl.reloadSockets.withdrawn.name),
      stow: socket(tmpl.reloadSockets.stow.name),
      spare: socket(tmpl.reloadSockets.spare.name),
      approach: socket(tmpl.reloadSockets.approach.name),
      magazineContact: socket(tmpl.reloadSockets.magazineContact.name),
      actionContact: socket(tmpl.reloadSockets.actionContact.name),
      port: socket(tmpl.reloadSockets.port.name),
      shellContact: socket(tmpl.reloadSockets.shellContact.name),
    }
    : undefined;
  return {
    group,
    muzzle: muzzleObj ? muzzleObj.position.clone() : tmpl.muzzle.clone(),
    mag: tmpl.mag ? mag : null,
    bolt: tmpl.bolt ? bolt : null,
    accents: tmpl.accents,
    gripR: tmpl.gripR.clone(),
    gripL: tmpl.gripL.clone(),
    sight: tmpl.sight
      ? { ...tmpl.sight, rear: tmpl.sight.rear.clone(), front: tmpl.sight.front.clone() }
      : undefined,
    reloadSockets,
  };
}

/** Canonical weapon lengths (meters), matching the balance tables. */
const LENGTHS: Record<WeaponId, number> = {
  pistol: 0.42,
  smg: 0.62,
  ar: 0.95,
  shotgun: 1.0,
  sniper: 1.28,
};

const RARITY_RANK: Record<Rarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
};

export class WeaponModelFactory {
  /** Prebuilt archetype per `weaponId:rarity`. Clones share geometry+materials. */
  private templates = new Map<string, WeaponModel>();
  private readonly mats: GunMaterials;
  /** Per-class finish sets: each weapon class gets its own material INSTANCE
   * set (shared across its rarities) so the five classes read as different
   * finishes — blued pistol, grey-phosphate AR, walnut shotgun, OD sniper —
   * instead of five copies of one black plastic. */
  private classMats = new Map<WeaponId, GunMaterials>();
  /** CYCLE 32: per-rarity skin material overrides for the large receiver /
   * handguard / stock panels. Shared across every weapon archetype. */
  private skinPanels = new Map<Rarity, Map<string, THREE.MeshStandardMaterial>>();
  /** Hex tint per rarity for the skin graphic. */
  private static readonly SKIN_TINTS: Record<Rarity, string> = {
    common: '#8d949c',
    uncommon: '#5fd08a',
    rare: '#57a8ff',
    epic: '#c46bff',
    legendary: '#ffb545',
  };

  /** Absolute finish colors per class: steel / aluminum / polymer / rubber.
   * Values stay mid-dark (nothing pure black) so form shadows still model
   * the shapes under the stage light rig. */
  private static readonly FINISHES: Record<WeaponId, { steel: number; aluminum: number; polymer: number; rubber?: number }> = {
    pistol: { steel: 0x2c3036, aluminum: 0x363b42, polymer: 0x232629 },
    smg: { steel: 0x3a4046, aluminum: 0x454c53, polymer: 0x2b2f34 },
    ar: { steel: 0x474d55, aluminum: 0x59616a, polymer: 0x353a41 },
    shotgun: { steel: 0x35393f, aluminum: 0x40454c, polymer: 0x54422e, rubber: 0x2e271f },
    sniper: { steel: 0x3c4147, aluminum: 0x57624e, polymer: 0x47523f },
  };

  private finishMats(id: WeaponId): GunMaterials {
    let set = this.classMats.get(id);
    if (set) return set;
    const finish = WeaponModelFactory.FINISHES[id];
    const clone = (base: THREE.MeshStandardMaterial, color: number, rough?: number): THREE.MeshStandardMaterial => {
      const m = base.clone();
      m.color = new THREE.Color(color);
      if (rough !== undefined) m.roughness = rough;
      m.name = base.name;
      return m;
    };
    set = {
      steel: clone(this.mats.steel, finish.steel),
      aluminum: clone(this.mats.aluminum, finish.aluminum, id === 'sniper' ? 0.62 : undefined),
      polymer: clone(this.mats.polymer, finish.polymer),
      rubber: clone(this.mats.rubber, finish.rubber ?? this.mats.rubber.color.getHex()),
      hardware: this.mats.hardware,
      postIvory: this.mats.postIvory,
    };
    this.classMats.set(id, set);
    return set;
  }

  constructor(
    /** Unused since the procedural-geometry rework; retained for call-site stability. */
    _props: unknown,
  ) {
    this.mats = makeGunMaterials();
  }

  /** Skin-panel material for one base material + rarity (cached). Common
   * keeps the bare-metal look; uncommon+ carry the pattern graphic. */
  private skinPanel(baseName: string, rarity: Rarity, classSet: GunMaterials | null = null): THREE.MeshStandardMaterial | null {
    if (rarity === 'common') return null;
    let byBase = this.skinPanels.get(rarity);
    if (!byBase) {
      byBase = new Map();
      this.skinPanels.set(rarity, byBase);
    }
    const cached = byBase.get(baseName);
    if (cached) return cached;
    const source = classSet ?? this.mats;
    const base = (source as unknown as Record<string, THREE.MeshStandardMaterial | undefined>)[baseName];
    if (!base) return null;
    const panel = base.clone();
    panel.map = makeSkinTexture(rarity, WeaponModelFactory.SKIN_TINTS[rarity]);
    panel.color.set(0xbfc3c8);
    panel.roughness = Math.min(0.62, base.roughness + 0.08);
    panel.name = `skin:${baseName}:${rarity}`;
    panel.userData.weaponFactoryOwned = true;
    byBase.set(baseName, panel);
    return panel;
  }

  /**
   * Compose a weapon. `rarity` drives attachment extras + accent glow.
   * Returns a lightweight clone of a cached archetype: geometries and
   * materials are shared, so repeated builds (loot spawns, bot swaps) never
   * re-create GPU resources or trigger shader compilation mid-match.
   */
  build(weaponId: WeaponId, rarity: Rarity): WeaponModel | null {
    const key = `${weaponId}:${rarity}`;
    let tmpl = this.templates.get(key);
    if (tmpl === undefined) {
      const built = this.buildUnique(weaponId, rarity);
      if (!built) return null;
      this.templates.set(key, built);
      tmpl = built;
    }
    return cloneWeaponModel(tmpl);
  }

  /** Build every archetype up front (call during the loading screen). */
  prewarmAll(): void {
    for (const id of Object.keys(LENGTHS) as WeaponId[]) {
      for (const rarity of ALL_RARITIES) {
        const key = `${id}:${rarity}`;
        if (this.templates.has(key)) continue;
        const built = this.buildUnique(id, rarity);
        if (built) this.templates.set(key, built);
      }
    }
  }

  /**
   * The cached archetype roots for the renderer warmup stage. Building an
   * archetype is CPU-only; its materials and geometry still compile/upload on
   * first render, and floor loot stays 48 m-culled (invisible) until the
   * player walks up to it. Rendering each template once during the loading
   * screen uploads every part material + geometry, so mid-match loot
   * encounters never stall. Callers must detach the returned objects after
   * the warmup render — they stay owned by the factory cache.
   */
  warmupTemplates(): WeaponModel[] {
    return [...this.templates.values()];
  }

  private readonly warnedAuthoredWeapons = new Set<WeaponId>();
  private readonly reportedAuthoredContractIssues = new Set<WeaponId>();

  private buildAuthoredPistol(): AuthoredPistolParts | null {
    const asset = peekGltf(AUTHORED_PISTOL_PATH);
    return asset ? buildAuthoredPistol(asset) : null;
  }

  private buildAuthoredWeapon(weaponId: Exclude<WeaponId, 'pistol'>): AuthoredWeaponParts | null {
    const path = AUTHORED_WEAPON_PATHS[weaponId];
    if (!path) return null;
    const asset = peekGltf(path);
    return asset ? buildAuthoredWeapon(asset, weaponId) : null;
  }

  private buildUnique(weaponId: WeaponId, rarity: Rarity): WeaponModel | null {
    if (!(weaponId in LENGTHS)) return null;
    const finish = this.finishMats(weaponId);
    const authored = weaponId === 'pistol'
      ? this.buildAuthoredPistol()
      : this.buildAuthoredWeapon(weaponId);
    if (!authored) {
      const message = `authored ${weaponId} contract unavailable; refusing production fallback`;
      if (!import.meta.env.DEV) throw new Error(message);
      if (!this.warnedAuthoredWeapons.has(weaponId)) {
        this.warnedAuthoredWeapons.add(weaponId);
        console.warn(message);
      }
    }
    const gun = authored ?? buildProceduralWeapon(weaponId, finish);
    const group = gun.group;
    if (authored && !this.reportedAuthoredContractIssues.has(weaponId)) {
      const missing = Array.isArray(group.userData.authoredContractMissing)
        ? group.userData.authoredContractMissing.filter((role: unknown): role is string => typeof role === 'string')
        : [];
      const required = Array.isArray(group.userData.authoredContractRequired)
        ? group.userData.authoredContractRequired.filter((role: unknown): role is string => typeof role === 'string')
        : [];
      const requiredSet = new Set(required);
      const critical = missing.filter((role) => requiredSet.has(role));
      if (critical.length > 0) {
        this.reportedAuthoredContractIssues.add(weaponId);
        console.warn(`authored ${weaponId} contract missing required roles: ${critical.join(', ')}`);
      }
    }
    const length = LENGTHS[weaponId];
    const rank = RARITY_RANK[rarity];
    const accents: THREE.MeshStandardMaterial[] = [];

    // Rarity accent strip along the receiver rail.
    if (rank >= 0) {
      const stripColor = new THREE.Color(RARITY_COLORS[rarity]).multiplyScalar(0.55);
      const stripMat = new THREE.MeshStandardMaterial({
        color: 0x101114,
        emissive: stripColor,
        emissiveIntensity: 0.28 + rank * 0.16,
        roughness: 0.42,
        metalness: 0.3,
      });
      // CYCLE 34 (review): the strip hung in mid-air beside every receiver
      // (x 0.024 > half-widths, length overshooting the butt). It now lies
      // flush inside the top-rail slot like a rail insert, capped length.
      const stripLen = Math.min(0.22, length * (rank >= 3 ? 0.4 : 0.26));
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.0022, stripLen), stripMat);
      strip.position.set(0, gun.railY + 0.007, gun.railZ + 0.02);
      strip.visible = rank > 0 || weaponId === 'pistol';
      group.add(strip);
      accents.push(stripMat);

      // Legendary/epic edge glow lines hugging the handguard sides.
      if (rank >= 3) {
        const lineMat = stripMat.clone();
        lineMat.emissiveIntensity += 0.12;
        accents.push(lineMat);
        for (const side of [-1, 1]) {
          const line = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.002, stripLen * 1.1), lineMat);
          line.position.set(side * 0.0255, gun.railY - 0.026, gun.railZ - 0.1);
          group.add(line);
        }
      }
    }

    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.userData.weaponPartRole = 'muzzle';
    muzzle.position.copy(authored?.muzzlePoint ?? new THREE.Vector3(0, 0.026, gun.muzzleZ - 0.015));
    group.add(muzzle);

    // CYCLE 32: rarity skin panels on the large surfaces (receiver/handguard/
    // stock are aluminum/polymer-named materials). Small hardware stays bare.
    if (rarity !== 'common') {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (Array.isArray(mat) || !mat?.name) return;
        if (mat.name !== 'aluminum' && mat.name !== 'polymer') return;
        const panel = this.skinPanel(mat.name, rarity, finish);
        if (panel) mesh.material = panel;
      });
    }

    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      if (!mesh.geometry.userData.externalShared) mesh.geometry.userData.weaponFactoryOwned = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material.userData.externalShared) material.userData.weaponFactoryOwned = true;
      }
    });
    return { group, muzzle: muzzle.position.clone(), mag: gun.mag, bolt: gun.bolt, accents, gripR: gun.gripR, gripL: gun.gripL, sight: authored?.sight };
  }

  /** World-loot presentation scale of a weapon. */
  buildWorldScale(weaponId: WeaponId, rarity: Rarity): WeaponModel | null {
    const m = this.build(weaponId, rarity);
    if (m) m.group.scale.multiplyScalar(WORLD_LOOT_WEAPON_SCALE);
    return m;
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const template of this.templates.values()) {
      template.group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mesh.geometry.userData.weaponFactoryOwned) geometries.add(mesh.geometry);
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) {
          if (material.userData.weaponFactoryOwned) materials.add(material);
        }
      });
    }
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of Object.values(this.mats)) material.dispose();
    for (const byBase of this.skinPanels.values()) {
      for (const material of byBase.values()) {
        material.map?.dispose();
        material.dispose();
      }
    }
    this.skinPanels.clear();
    this.templates.clear();
  }
}
