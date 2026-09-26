import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

export const ENVIRONMENT_TRANSFORM_PRECISION = 6;

export type EnvironmentVec3 = readonly [x: number, y: number, z: number];

export interface EnvironmentEulerYXZ {
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
}

export interface EnvironmentTransform {
  readonly position: EnvironmentVec3;
  readonly rotation: EnvironmentEulerYXZ;
  readonly scale: EnvironmentVec3;
}

export type EnvironmentMatrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export type EnvironmentOrigin = 'preserve' | 'bottom-center' | 'bounds-center';

export type EnvironmentMaterialMode = 'node-standard' | 'preserve';

export interface EnvironmentBoundsInput {
  readonly min: EnvironmentVec3;
  readonly max: EnvironmentVec3;
}

export interface EnvironmentBounds {
  readonly min: EnvironmentVec3;
  readonly max: EnvironmentVec3;
  readonly size: EnvironmentVec3;
  readonly center: EnvironmentVec3;
}

export interface EnvironmentRenderMeshInput {
  readonly assetPath: string;
  readonly bounds?: EnvironmentBoundsInput;
  readonly origin?: EnvironmentOrigin;
  readonly materialMode?: EnvironmentMaterialMode;
  readonly nodeNames?: readonly string[];
  readonly meshCount?: number;
  readonly triangleCount?: number;
}

export interface EnvironmentRenderMesh {
  readonly assetPath: string;
  readonly bounds?: EnvironmentBounds;
  readonly origin: EnvironmentOrigin;
  readonly materialMode: EnvironmentMaterialMode;
  readonly nodeNames: readonly string[];
  readonly meshCount: number;
  readonly triangleCount: number;
}

export type EnvironmentCollisionProxy =
  | {
    readonly kind: 'box';
    readonly center: EnvironmentVec3;
    readonly halfExtents: EnvironmentVec3;
    readonly rotation?: EnvironmentEulerYXZ;
  }
  | {
    readonly kind: 'sphere';
    readonly center: EnvironmentVec3;
    readonly radius: number;
  }
  | {
    readonly kind: 'capsule';
    readonly center: EnvironmentVec3;
    readonly radius: number;
    readonly halfHeight: number;
    readonly rotation?: EnvironmentEulerYXZ;
  };

export interface EnvironmentCollision {
  readonly mode: 'none' | 'static';
  readonly proxies: readonly EnvironmentCollisionProxy[];
}

export type EnvironmentCollisionInput =
  | EnvironmentCollision
  | readonly EnvironmentCollisionProxy[];

export type EnvironmentNavigationRole = 'none' | 'obstacle' | 'walkable' | 'platform';
export type EnvironmentNavigationSurface = 'none' | 'floor' | 'ramp' | 'platform' | 'water';

export interface EnvironmentNavigation {
  readonly role: EnvironmentNavigationRole;
  readonly surface: EnvironmentNavigationSurface;
  readonly walkable: boolean;
  readonly blocksMovement: boolean;
  readonly clearance: number;
  readonly tags: readonly string[];
}

export type EnvironmentCoverHeightClass = 'none' | 'low' | 'waist' | 'high' | 'full';
export type EnvironmentCoverProtection = 'none' | 'partial' | 'full';

export interface EnvironmentCover {
  readonly heightClass: EnvironmentCoverHeightClass;
  readonly height?: number;
  readonly protection: EnvironmentCoverProtection;
  readonly crouchSafe: boolean;
  readonly blocksProjectiles: boolean;
  readonly destructible: boolean;
  readonly tags: readonly string[];
}

export type EnvironmentAssetSource = 'authored-glb' | 'candidate-glb' | 'procedural';
export type EnvironmentAssetLicense = 'CC0-1.0' | 'CC-BY-4.0' | 'other-permissive' | 'unknown';

export interface EnvironmentProvenance {
  readonly author?: string;
  readonly sourceReference?: string;
  readonly reviewed: boolean;
}

export interface EnvironmentAssetMetadata {
  readonly source: EnvironmentAssetSource;
  readonly license: EnvironmentAssetLicense;
  readonly candidate: boolean;
  readonly assetPath: string;
  readonly sourceLabel: string;
  readonly tags: readonly string[];
  readonly provenance: EnvironmentProvenance;
}

export interface EnvironmentAssetMetadataInput {
  readonly source?: EnvironmentAssetSource;
  readonly license?: EnvironmentAssetLicense;
  readonly candidate?: boolean;
  readonly sourceLabel?: string;
  readonly tags?: readonly string[];
  readonly provenance?: Partial<EnvironmentProvenance>;
}

export interface EnvironmentPrefabInput {
  readonly id: string;
  readonly render: EnvironmentRenderMeshInput;
  readonly collision?: EnvironmentCollisionInput;
  readonly navigation?: Partial<EnvironmentNavigation>;
  readonly cover?: Partial<EnvironmentCover>;
  readonly metadata?: EnvironmentAssetMetadataInput;
}

export interface EnvironmentPrefab {
  readonly id: string;
  readonly render: EnvironmentRenderMesh;
  readonly collision: EnvironmentCollision;
  readonly navigation: EnvironmentNavigation;
  readonly cover: EnvironmentCover;
  readonly metadata: EnvironmentAssetMetadata;
}

export interface EnvironmentKit {
  readonly id: string;
  readonly version: string;
  readonly prefabs: readonly EnvironmentPrefab[];
}

export interface EnvironmentPlan {
  readonly kit: EnvironmentKit;
  readonly instances: readonly EnvironmentPrefabInstance[];
}

export interface EnvironmentKitInput {
  readonly id: string;
  readonly version: string;
  readonly prefabs: readonly EnvironmentPrefab[];
}

export interface EnvironmentPrefabInstanceInput {
  readonly id: string;
  readonly prefabId: string;
  readonly transform: EnvironmentTransform;
  readonly renderVisible?: boolean;
  readonly tags?: readonly string[];
}

export interface EnvironmentPrefabInstance {
  readonly id: string;
  readonly prefabId: string;
  readonly transform: EnvironmentTransform;
  readonly renderVisible: boolean;
  readonly tags: readonly string[];
}

export interface ResolvedEnvironmentInstance {
  readonly instanceId: string;
  readonly prefabId: string;
  readonly transform: EnvironmentTransform;
  readonly renderVisible: boolean;
  readonly render: EnvironmentRenderMesh;
  readonly collision: EnvironmentCollision;
  readonly navigation: EnvironmentNavigation;
  readonly cover: EnvironmentCover;
  readonly metadata: EnvironmentAssetMetadata;
}

export const IDENTITY_ENVIRONMENT_TRANSFORM: EnvironmentTransform = {
  position: [0, 0, 0],
  rotation: { pitch: 0, yaw: 0, roll: 0 },
  scale: [1, 1, 1],
};

export function canonicalEnvironmentNumber(
  value: number,
  precision = ENVIRONMENT_TRANSFORM_PRECISION,
): number {
  if (!Number.isFinite(value)) throw new Error(`environment value must be finite: ${value}`);
  if (!Number.isInteger(precision) || precision < 0 || precision > 12) {
    throw new Error(`environment precision must be an integer from 0 to 12: ${precision}`);
  }
  const rounded = Number(value.toFixed(precision));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function canonicalEnvironmentVec3(
  value: EnvironmentVec3,
  precision = ENVIRONMENT_TRANSFORM_PRECISION,
): EnvironmentVec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('environment vector must contain three numbers');
  }
  return [
    canonicalEnvironmentNumber(value[0], precision),
    canonicalEnvironmentNumber(value[1], precision),
    canonicalEnvironmentNumber(value[2], precision),
  ];
}

export function canonicalEnvironmentRotation(
  value: EnvironmentEulerYXZ,
  precision = ENVIRONMENT_TRANSFORM_PRECISION,
): EnvironmentEulerYXZ {
  return {
    pitch: canonicalEnvironmentNumber(value.pitch, precision),
    yaw: canonicalEnvironmentNumber(value.yaw, precision),
    roll: canonicalEnvironmentNumber(value.roll, precision),
  };
}

export function canonicalEnvironmentTransform(
  value: EnvironmentTransform,
  precision = ENVIRONMENT_TRANSFORM_PRECISION,
): EnvironmentTransform {
  return {
    position: canonicalEnvironmentVec3(value.position, precision),
    rotation: canonicalEnvironmentRotation(value.rotation, precision),
    scale: canonicalEnvironmentVec3(value.scale, precision),
  };
}

export function canonicalEnvironmentBounds(
  value: EnvironmentBoundsInput,
  precision = ENVIRONMENT_TRANSFORM_PRECISION,
): EnvironmentBounds {
  const min = canonicalEnvironmentVec3(value.min, precision);
  const max = canonicalEnvironmentVec3(value.max, precision);
  if (max[0] < min[0] || max[1] < min[1] || max[2] < min[2]) {
    throw new Error('environment bounds max must not be below min');
  }
  return {
    min,
    max,
    size: [
      canonicalEnvironmentNumber(max[0] - min[0], precision),
      canonicalEnvironmentNumber(max[1] - min[1], precision),
      canonicalEnvironmentNumber(max[2] - min[2], precision),
    ],
    center: [
      canonicalEnvironmentNumber((min[0] + max[0]) / 2, precision),
      canonicalEnvironmentNumber((min[1] + max[1]) / 2, precision),
      canonicalEnvironmentNumber((min[2] + max[2]) / 2, precision),
    ],
  };
}

function canonicalString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function canonicalTags(value: readonly string[] | undefined): readonly string[] {
  return [...new Set((value ?? []).map((tag) => canonicalString(tag, 'environment tag')))].sort();
}

function canonicalCount(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer: ${value}`);
  }
  return value;
}

function canonicalRender(value: EnvironmentRenderMeshInput): EnvironmentRenderMesh {
  const assetPath = canonicalString(value.assetPath, 'environment render asset path');
  const nodeNames = (value.nodeNames ?? []).map((name, index) => (
    canonicalString(name, `environment render node ${index}`)
  ));
  return {
    assetPath,
    ...(value.bounds ? { bounds: canonicalEnvironmentBounds(value.bounds) } : {}),
    origin: value.origin ?? 'preserve',
    materialMode: value.materialMode ?? 'node-standard',
    nodeNames,
    meshCount: canonicalCount(value.meshCount, 'environment render mesh count'),
    triangleCount: canonicalCount(value.triangleCount, 'environment render triangle count'),
  };
}

function canonicalProxy(value: EnvironmentCollisionProxy): EnvironmentCollisionProxy {
  if (value.kind === 'sphere') {
    if (!Number.isFinite(value.radius) || value.radius <= 0) {
      throw new Error(`sphere collision radius must be positive: ${value.radius}`);
    }
    return {
      kind: 'sphere',
      center: canonicalEnvironmentVec3(value.center),
      radius: canonicalEnvironmentNumber(value.radius),
    };
  }
  if (value.kind === 'capsule') {
    if (!Number.isFinite(value.radius) || value.radius <= 0) {
      throw new Error(`capsule collision radius must be positive: ${value.radius}`);
    }
    if (!Number.isFinite(value.halfHeight) || value.halfHeight <= 0) {
      throw new Error(`capsule collision half-height must be positive: ${value.halfHeight}`);
    }
    return {
      kind: 'capsule',
      center: canonicalEnvironmentVec3(value.center),
      radius: canonicalEnvironmentNumber(value.radius),
      halfHeight: canonicalEnvironmentNumber(value.halfHeight),
      ...(value.rotation ? { rotation: canonicalEnvironmentRotation(value.rotation) } : {}),
    };
  }
  if (!Number.isFinite(value.halfExtents[0]) || value.halfExtents.some((extent) => extent <= 0)) {
    throw new Error('box collision half-extents must be positive');
  }
  return {
    kind: 'box',
    center: canonicalEnvironmentVec3(value.center),
    halfExtents: canonicalEnvironmentVec3(value.halfExtents),
    ...(value.rotation ? { rotation: canonicalEnvironmentRotation(value.rotation) } : {}),
  };
}

function canonicalCollision(value: EnvironmentCollisionInput | undefined): EnvironmentCollision {
  if (value === undefined) return { mode: 'none', proxies: [] };
  if (Array.isArray(value)) {
    const proxies: readonly EnvironmentCollisionProxy[] = value;
    const canonical = proxies.map(canonicalProxy);
    return { mode: canonical.length === 0 ? 'none' : 'static', proxies: canonical };
  }
  const collision = value as EnvironmentCollision;
  const canonical = collision.proxies.map(canonicalProxy);
  if (collision.mode === 'none' && canonical.length > 0) {
    throw new Error('collision mode none cannot contain proxies');
  }
  if (collision.mode === 'static' && canonical.length === 0) {
    throw new Error('collision mode static requires at least one proxy');
  }
  return { mode: collision.mode, proxies: canonical };
}

function canonicalNavigation(value: Partial<EnvironmentNavigation> | undefined): EnvironmentNavigation {
  const role = value?.role ?? 'none';
  const surface = value?.surface ?? (role === 'walkable' ? 'floor' : role === 'platform' ? 'platform' : 'none');
  const walkable = value?.walkable ?? (role === 'walkable' || role === 'platform');
  const blocksMovement = value?.blocksMovement ?? role === 'obstacle';
  const clearance = canonicalEnvironmentNumber(value?.clearance ?? 0);
  if (clearance < 0) throw new Error(`navigation clearance must be non-negative: ${clearance}`);
  if (role === 'none' && (walkable || blocksMovement)) {
    throw new Error('navigation role none cannot be walkable or movement-blocking');
  }
  if (role === 'obstacle' && (walkable || !blocksMovement)) {
    throw new Error('navigation role obstacle must block movement and cannot be walkable');
  }
  if ((role === 'walkable' || role === 'platform') && (!walkable || blocksMovement)) {
    throw new Error('navigation walkable roles must be walkable and not movement-blocking');
  }
  return { role, surface, walkable, blocksMovement, clearance, tags: canonicalTags(value?.tags) };
}

function canonicalCover(value: Partial<EnvironmentCover> | undefined): EnvironmentCover {
  const heightClass = value?.heightClass ?? 'none';
  const protection = value?.protection ?? (heightClass === 'none' ? 'none' : 'partial');
  const crouchSafe = value?.crouchSafe ?? false;
  const blocksProjectiles = value?.blocksProjectiles ?? heightClass !== 'none';
  const destructible = value?.destructible ?? false;
  const height = value?.height === undefined ? undefined : canonicalEnvironmentNumber(value.height);
  if (height !== undefined && height < 0) {
    throw new Error(`cover height must be non-negative: ${height}`);
  }
  if (heightClass === 'none' && (protection !== 'none' || crouchSafe || blocksProjectiles)) {
    throw new Error('cover height class none cannot provide protection');
  }
  if (heightClass !== 'none' && protection === 'none') {
    throw new Error('cover height classes other than none require protection metadata');
  }
  return {
    heightClass,
    ...(height === undefined ? {} : { height }),
    protection,
    crouchSafe,
    blocksProjectiles,
    destructible,
    tags: canonicalTags(value?.tags),
  };
}

function canonicalMetadata(
  value: EnvironmentAssetMetadataInput | undefined,
  assetPath: string,
): EnvironmentAssetMetadata {
  const source = value?.source ?? 'procedural';
  const provenance = {
    ...(value?.provenance?.author
      ? { author: canonicalString(value.provenance.author, 'environment asset author') }
      : {}),
    ...(value?.provenance?.sourceReference
      ? { sourceReference: canonicalString(value.provenance.sourceReference, 'environment asset source reference') }
      : {}),
    reviewed: value?.provenance?.reviewed ?? false,
  };
  return {
    source,
    license: value?.license ?? 'unknown',
    candidate: value?.candidate ?? source === 'candidate-glb',
    assetPath,
    sourceLabel: canonicalString(value?.sourceLabel ?? assetPath, 'environment source label'),
    tags: canonicalTags(value?.tags),
    provenance,
  };
}

export function defineEnvironmentPrefab(input: EnvironmentPrefabInput): EnvironmentPrefab {
  const render = canonicalRender(input.render);
  return {
    id: canonicalString(input.id, 'environment prefab id'),
    render,
    collision: canonicalCollision(input.collision),
    navigation: canonicalNavigation(input.navigation),
    cover: canonicalCover(input.cover),
    metadata: canonicalMetadata(input.metadata, render.assetPath),
  };
}

export function defineEnvironmentKit(input: EnvironmentKitInput): EnvironmentKit {
  const prefabs = input.prefabs
    .map((prefab) => defineEnvironmentPrefab(prefab))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ids = new Set<string>();
  for (const prefab of prefabs) {
    if (ids.has(prefab.id)) throw new Error(`duplicate environment prefab id: ${prefab.id}`);
    ids.add(prefab.id);
  }
  return {
    id: canonicalString(input.id, 'environment kit id'),
    version: canonicalString(input.version, 'environment kit version'),
    prefabs,
  };
}

export function defineEnvironmentPrefabInstance(
  input: EnvironmentPrefabInstanceInput,
): EnvironmentPrefabInstance {
  return {
    id: canonicalString(input.id, 'environment instance id'),
    prefabId: canonicalString(input.prefabId, 'environment prefab reference'),
    transform: canonicalEnvironmentTransform(input.transform),
    renderVisible: input.renderVisible ?? true,
    tags: canonicalTags(input.tags),
  };
}

export function resolveEnvironmentInstance(
  prefab: EnvironmentPrefab,
  instance: EnvironmentPrefabInstance,
): ResolvedEnvironmentInstance {
  if (instance.prefabId !== prefab.id) {
    throw new Error(`environment instance ${instance.id} references ${instance.prefabId}, not ${prefab.id}`);
  }
  return {
    instanceId: instance.id,
    prefabId: instance.prefabId,
    transform: canonicalEnvironmentTransform(instance.transform),
    renderVisible: instance.renderVisible,
    render: prefab.render,
    collision: prefab.collision,
    navigation: prefab.navigation,
    cover: prefab.cover,
    metadata: prefab.metadata,
  };
}

export function defineEnvironmentPlan(
  kit: EnvironmentKit,
  instances: readonly EnvironmentPrefabInstanceInput[],
): EnvironmentPlan {
  const prefabIds = new Set(kit.prefabs.map((prefab) => prefab.id));
  const resolved = instances
    .map((instance) => defineEnvironmentPrefabInstance(instance))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const instanceIds = new Set<string>();
  for (const instance of resolved) {
    if (instanceIds.has(instance.id)) throw new Error(`duplicate environment instance id: ${instance.id}`);
    instanceIds.add(instance.id);
    if (!prefabIds.has(instance.prefabId)) {
      throw new Error(`environment instance ${instance.id} references unknown prefab ${instance.prefabId}`);
    }
  }
  return { kit, instances: resolved };
}

export function resolveEnvironmentPlan(plan: EnvironmentPlan): ResolvedEnvironmentInstance[] {
  const prefabs = new Map(plan.kit.prefabs.map((prefab) => [prefab.id, prefab]));
  return plan.instances.map((instance) => {
    const prefab = prefabs.get(instance.prefabId);
    if (!prefab) throw new Error(`environment instance ${instance.id} references unknown prefab ${instance.prefabId}`);
    return resolveEnvironmentInstance(prefab, instance);
  });
}

function rotationQuaternion(rotation: EnvironmentEulerYXZ): {
  x: number; y: number; z: number; w: number;
} {
  const quaternion = new Quaternion().setFromEuler(new Euler(
    rotation.pitch,
    rotation.yaw,
    rotation.roll,
    'YXZ',
  ));
  return {
    x: quaternion.x,
    y: quaternion.y,
    z: quaternion.z,
    w: quaternion.w,
  };
}

export function environmentTransformToMatrix(
  value: EnvironmentTransform,
  precision = ENVIRONMENT_TRANSFORM_PRECISION,
): EnvironmentMatrix4 {
  const transform = canonicalEnvironmentTransform(value, precision);
  const q = rotationQuaternion(transform.rotation);
  const matrix = new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion(q.x, q.y, q.z, q.w),
    new Vector3(...transform.scale),
  );
  return [
    canonicalEnvironmentNumber(matrix.elements[0], precision),
    canonicalEnvironmentNumber(matrix.elements[1], precision),
    canonicalEnvironmentNumber(matrix.elements[2], precision),
    0,
    canonicalEnvironmentNumber(matrix.elements[4], precision),
    canonicalEnvironmentNumber(matrix.elements[5], precision),
    canonicalEnvironmentNumber(matrix.elements[6], precision),
    0,
    canonicalEnvironmentNumber(matrix.elements[8], precision),
    canonicalEnvironmentNumber(matrix.elements[9], precision),
    canonicalEnvironmentNumber(matrix.elements[10], precision),
    0,
    canonicalEnvironmentNumber(matrix.elements[12], precision),
    canonicalEnvironmentNumber(matrix.elements[13], precision),
    canonicalEnvironmentNumber(matrix.elements[14], precision),
    1,
  ];
}

export function transformEnvironmentPoint(
  point: EnvironmentVec3,
  value: EnvironmentTransform,
  precision = ENVIRONMENT_TRANSFORM_PRECISION,
): EnvironmentVec3 {
  const transform = canonicalEnvironmentTransform(value, precision);
  const source = canonicalEnvironmentVec3(point, precision);
  const scaled: EnvironmentVec3 = [
    source[0] * transform.scale[0],
    source[1] * transform.scale[1],
    source[2] * transform.scale[2],
  ];
  const q = rotationQuaternion(transform.rotation);
  const x2 = q.x + q.x;
  const y2 = q.y + q.y;
  const z2 = q.z + q.z;
  const xx = q.x * x2;
  const xy = q.x * y2;
  const xz = q.x * z2;
  const yy = q.y * y2;
  const yz = q.y * z2;
  const zz = q.z * z2;
  const wx = q.w * x2;
  const wy = q.w * y2;
  const wz = q.w * z2;
  return canonicalEnvironmentVec3([
    (1 - (yy + zz)) * scaled[0] + (xy - wz) * scaled[1] + (xz + wy) * scaled[2] + transform.position[0],
    (xy + wz) * scaled[0] + (1 - (xx + zz)) * scaled[1] + (yz - wx) * scaled[2] + transform.position[1],
    (xz - wy) * scaled[0] + (yz + wx) * scaled[1] + (1 - (xx + yy)) * scaled[2] + transform.position[2],
  ], precision);
}

export function applyEnvironmentTransform(
  value: EnvironmentTransform,
  point: EnvironmentVec3,
  precision = ENVIRONMENT_TRANSFORM_PRECISION,
): EnvironmentVec3 {
  return transformEnvironmentPoint(point, value, precision);
}
