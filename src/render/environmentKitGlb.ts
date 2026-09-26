import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import type { GltfAsset } from '../assets/assets';
import {
  defineEnvironmentPrefab,
  canonicalEnvironmentBounds,
  canonicalEnvironmentNumber,
  type EnvironmentAssetMetadataInput,
  type EnvironmentBounds,
  type EnvironmentCollisionInput,
  type EnvironmentMaterialMode,
  type EnvironmentCover,
  type EnvironmentNavigation,
  type EnvironmentOrigin,
  type EnvironmentPrefab,
  type EnvironmentRenderMesh,
  type EnvironmentVec3,
} from '../world/environmentKit';

export interface EnvironmentGlbNormalizationOptions {
  readonly origin?: EnvironmentOrigin;
  readonly uniformScale?: number;
  readonly materialMode?: EnvironmentMaterialMode;
  readonly precision?: number;
}

export interface EnvironmentGlbIngestOptions extends EnvironmentGlbNormalizationOptions {
  readonly assetPath?: string;
}

export type EnvironmentGlbSource = THREE.Object3D | GltfAsset;

export type EnvironmentGlbNodeKind = 'group' | 'mesh' | 'bone' | 'other';

export interface EnvironmentGlbNode {
  readonly path: string;
  readonly name: string;
  readonly kind: EnvironmentGlbNodeKind;
}

export interface NormalizedEnvironmentGlb {
  readonly assetPath: string;
  readonly scene: THREE.Group;
  readonly render: EnvironmentRenderMesh;
  readonly bounds: EnvironmentBounds;
  readonly nodes: readonly EnvironmentGlbNode[];
  readonly meshCount: number;
  readonly triangleCount: number;
}

export interface EnvironmentPrefabFromGlbInput {
  readonly id: string;
  readonly collision?: EnvironmentCollisionInput;
  readonly navigation?: Partial<EnvironmentNavigation>;
  readonly cover?: Partial<EnvironmentCover>;
  readonly metadata?: EnvironmentAssetMetadataInput;
}

function isGltfAsset(value: EnvironmentGlbSource): value is GltfAsset {
  return 'scene' in value;
}

function sourceScene(value: EnvironmentGlbSource): THREE.Object3D {
  return isGltfAsset(value) ? value.scene : value;
}

function finiteScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`environment GLB scale must be positive and finite: ${value}`);
  }
  return value;
}

function nodeKind(node: THREE.Object3D): EnvironmentGlbNodeKind {
  if (node instanceof THREE.Mesh) return 'mesh';
  if (node instanceof THREE.Bone) return 'bone';
  if (node instanceof THREE.Group) return 'group';
  return 'other';
}

function collectNodes(root: THREE.Object3D): {
  nodes: EnvironmentGlbNode[];
  meshNames: string[];
  meshCount: number;
  triangleCount: number;
} {
  const nodes: EnvironmentGlbNode[] = [];
  const meshNames: string[] = [];
  let meshCount = 0;
  let triangleCount = 0;
  const visit = (node: THREE.Object3D, parentPath: string, siblingIndex: number): void => {
    const label = node.name || `${node.type.toLowerCase()}-${siblingIndex}`;
    const path = `${parentPath}/${label}[${siblingIndex}]`;
    nodes.push({ path, name: node.name, kind: nodeKind(node) });
    if (node instanceof THREE.Mesh) {
      meshCount += 1;
      if (node.name) meshNames.push(node.name);
      const vertexCount = node.geometry.getAttribute('position')?.count ?? 0;
      const indexCount = node.geometry.index?.count ?? vertexCount;
      const instances = node instanceof THREE.InstancedMesh ? Math.max(1, node.count) : 1;
      triangleCount += Math.floor(indexCount / 3) * instances;
    }
    node.children.forEach((child, index) => visit(child, path, index));
  };
  visit(root, '', 0);
  return { nodes, meshNames, meshCount, triangleCount };
}

function toEnvironmentNodeMaterial(material: THREE.MeshStandardMaterial): THREE.Material {
  const node = new MeshStandardNodeMaterial({
    color: material.color.clone(),
    map: material.map ?? null,
    normalMap: material.normalMap,
    normalMapType: material.normalMapType,
    bumpMap: material.bumpMap,
    bumpScale: material.bumpScale,
    roughnessMap: material.roughnessMap ?? null,
    metalnessMap: material.metalnessMap ?? null,
    aoMap: material.aoMap ?? null,
    emissive: material.emissive.clone(),
    emissiveMap: material.emissiveMap ?? null,
    emissiveIntensity: material.emissiveIntensity,
    roughness: material.roughness,
    metalness: material.metalness,
    envMapIntensity: material.envMapIntensity,
    transparent: material.transparent,
    opacity: material.opacity,
    alphaTest: material.alphaTest,
    side: material.side,
    name: material.name,
  });
  node.normalScale.copy(material.normalScale);
  node.aoMapIntensity = material.aoMapIntensity;
  return node;
}

function normalizeMaterials(root: THREE.Object3D, mode: 'node-standard' | 'preserve'): void {
  const converted = new Map<THREE.Material, THREE.Material>();
  const markShared = (material: THREE.Material): THREE.Material => {
    material.userData.externalShared = true;
    return material;
  };
  const convert = (material: THREE.Material): THREE.Material => {
    const existing = converted.get(material);
    if (existing) return existing;
    const next = material instanceof THREE.MeshStandardMaterial && mode === 'node-standard'
      ? toEnvironmentNodeMaterial(material)
      : markShared(material);
    converted.set(material, next);
    return markShared(next);
  };
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (Array.isArray(object.material)) {
      object.material = object.material.map(convert);
    } else {
      object.material = convert(object.material);
    }
  });
}

function vectorTuple(value: THREE.Vector3, precision: number): EnvironmentVec3 {
  return [
    canonicalEnvironmentNumber(value.x, precision),
    canonicalEnvironmentNumber(value.y, precision),
    canonicalEnvironmentNumber(value.z, precision),
  ];
}

function boundsTuple(bounds: THREE.Box3, precision: number): {
  min: EnvironmentVec3;
  max: EnvironmentVec3;
} {
  return {
    min: vectorTuple(bounds.min, precision),
    max: vectorTuple(bounds.max, precision),
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
      values[index * 2] = x * 0.25;
      values[index * 2 + 1] = z * 0.25;
    } else if (nx >= nz) {
      values[index * 2] = z * 0.25;
      values[index * 2 + 1] = y * 0.25;
    } else {
      values[index * 2] = x * 0.25;
      values[index * 2 + 1] = y * 0.25;
    }
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(values, 2));
}

function bakeEnvironmentObject(source: THREE.Object3D): THREE.Object3D {
  if (source instanceof THREE.Mesh) {
    if (source instanceof THREE.SkinnedMesh || source instanceof THREE.InstancedMesh) {
      throw new Error(`environment GLB contains unsupported animated or instanced mesh: ${source.name || 'unnamed'}`);
    }
    source.updateMatrixWorld(true);
    const geometry = source.geometry.clone();
    geometry.applyMatrix4(source.matrixWorld);
    ensureGeometryUv(geometry);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, source.material);
    mesh.name = source.name;
    mesh.userData = { ...source.userData };
    mesh.visible = source.visible;
    mesh.renderOrder = source.renderOrder;
    mesh.castShadow = source.castShadow;
    mesh.receiveShadow = source.receiveShadow;
    mesh.frustumCulled = source.frustumCulled;
    mesh.layers.mask = source.layers.mask;
    return mesh;
  }
  const group = new THREE.Group();
  group.name = source.name;
  group.userData = { ...source.userData };
  group.visible = source.visible;
  group.renderOrder = source.renderOrder;
  group.layers.mask = source.layers.mask;
  for (const child of source.children) group.add(bakeEnvironmentObject(child));
  return group;
}

function bakeEnvironmentHierarchy(source: THREE.Object3D): THREE.Group {
  source.updateMatrixWorld(true);
  const content = new THREE.Group();
  content.name = source.name || 'environment-source';
  const baked = bakeEnvironmentObject(source);
  if (baked instanceof THREE.Group) {
    content.add(baked);
  } else {
    content.add(baked);
  }
  return content;
}

export function normalizeEnvironmentGlb(
  source: EnvironmentGlbSource,
  options: EnvironmentGlbIngestOptions = {},
): NormalizedEnvironmentGlb {
  const precision = options.precision ?? 6;
  canonicalEnvironmentNumber(0, precision);
  const scale = finiteScale(options.uniformScale ?? 1);
  const origin = options.origin ?? 'bottom-center';
  const content = bakeEnvironmentHierarchy(sourceScene(source));
  const rawBounds = new THREE.Box3().setFromObject(content);
  if (rawBounds.isEmpty()) throw new Error(`environment GLB has no finite mesh bounds: ${options.assetPath ?? ''}`);
  const sourceName = content.name;
  const root = new THREE.Group();
  root.name = `${sourceName}__environment-kit`;
  root.add(content);
  root.scale.setScalar(scale);
  if (origin === 'bottom-center') {
    const center = rawBounds.getCenter(new THREE.Vector3());
    root.position.set(-center.x * scale, -rawBounds.min.y * scale, -center.z * scale);
  } else if (origin === 'bounds-center') {
    const center = rawBounds.getCenter(new THREE.Vector3());
    root.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  }
  root.updateMatrixWorld(true);
  normalizeMaterials(root, options.materialMode ?? 'node-standard');
  const normalizedBounds = new THREE.Box3().setFromObject(root);
  if (normalizedBounds.isEmpty()) throw new Error(`environment GLB normalization produced empty bounds: ${options.assetPath ?? ''}`);
  const renderBounds = canonicalEnvironmentBounds(boundsTuple(normalizedBounds, precision), precision);
  const assetPath = options.assetPath ?? '';
  const collected = collectNodes(root);
  const render: EnvironmentRenderMesh = {
    assetPath,
    bounds: renderBounds,
    origin,
    materialMode: options.materialMode ?? 'node-standard',
    nodeNames: collected.meshNames,
    meshCount: collected.meshCount,
    triangleCount: collected.triangleCount,
  };
  root.userData.environmentKit = { assetPath, origin, sourceName };
  return {
    assetPath,
    scene: root,
    render,
    bounds: renderBounds,
    nodes: collected.nodes,
    meshCount: collected.meshCount,
    triangleCount: collected.triangleCount,
  };
}

export function createEnvironmentPrefabFromGlb(
  glb: Pick<NormalizedEnvironmentGlb, 'assetPath' | 'render'>,
  input: EnvironmentPrefabFromGlbInput,
): EnvironmentPrefab {
  const assetPath = glb.assetPath || 'environment.glb';
  return defineEnvironmentPrefab({
    id: input.id,
    render: {
      assetPath,
      bounds: glb.render.bounds,
      origin: glb.render.origin,
      materialMode: glb.render.materialMode,
      nodeNames: glb.render.nodeNames,
      meshCount: glb.render.meshCount,
      triangleCount: glb.render.triangleCount,
    },
    collision: input.collision,
    navigation: input.navigation,
    cover: input.cover,
    metadata: {
      source: input.metadata?.source ?? 'candidate-glb',
      license: input.metadata?.license ?? 'unknown',
      candidate: input.metadata?.candidate ?? true,
      sourceLabel: input.metadata?.sourceLabel ?? assetPath,
      tags: input.metadata?.tags,
      provenance: input.metadata?.provenance,
    },
  });
}

const ingestCache = new Map<string, Promise<NormalizedEnvironmentGlb>>();

function ingestKey(path: string, options: EnvironmentGlbIngestOptions): string {
  return [
    path,
    options.origin ?? 'bottom-center',
    options.uniformScale ?? 1,
    options.materialMode ?? 'node-standard',
    options.precision ?? 6,
  ].join('|');
}

export async function ingestEnvironmentGlb(
  path: string,
  options: EnvironmentGlbIngestOptions = {},
): Promise<NormalizedEnvironmentGlb> {
  const normalizedPath = path.trim();
  if (!normalizedPath) throw new Error('environment GLB path must not be empty');
  const key = ingestKey(normalizedPath, options);
  const cached = ingestCache.get(key);
  if (cached) return cached;
  const pending = import('../assets/assets')
    .then(({ loadGltf }) => loadGltf(normalizedPath))
    .then((asset) => normalizeEnvironmentGlb(asset, {
      ...options,
      assetPath: normalizedPath,
    }));
  ingestCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    ingestCache.delete(key);
    throw error;
  }
}

export function clearEnvironmentGlbIngestCache(): void {
  ingestCache.clear();
}
