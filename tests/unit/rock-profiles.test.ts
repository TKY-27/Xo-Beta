import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROCK_COLLIDER_PROFILES,
  rockColliderProfile,
  type RockColliderBox,
  type RockVariant,
} from '../../src/world/rockProfiles';

/**
 * Acceptance contract for the rock collider profiles (see the provenance
 * header in src/world/rockProfiles.ts): the compound boxes must track the
 * actual licensed Quaternius rock meshes — never exceeding the measured mesh
 * radius by more than MAX_OVERSHOOT at any sampled height (invisible
 * corners) and never undershooting it by more than MAX_UNDERSHOOT
 * (walk-through visible mass).
 *
 * The GLTF files are re-parsed here (independent of
 * scripts/measure-rock-profiles.mjs) so the measured numbers cannot silently
 * drift from the shipped profile data.
 */
const MAX_OVERSHOOT = 0.12;
const MAX_UNDERSHOOT = 0.35;
const SAMPLE_COUNT = 16;
const BAND_HALF_WIDTH = 0.05;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const GLTF_FILES: Record<RockVariant, string> = {
  'medium-1': 'public/assets/models/nature/Rock_Medium_1.gltf',
  'medium-2': 'public/assets/models/nature/Rock_Medium_2.gltf',
};

const VARIANTS: readonly RockVariant[] = ['medium-1', 'medium-2'];

// ---------------------------------------------------------------------------
// Minimal glTF 2.0 POSITION reader (FLOAT/VEC3 accessors, node transforms).
// ---------------------------------------------------------------------------

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives?: { attributes?: { POSITION?: number } }[] }[];
  accessors?: { bufferView?: number; componentType?: number; type?: string; count?: number; byteOffset?: number }[];
  bufferViews?: { byteOffset?: number; byteStride?: number }[];
  buffers?: { uri?: string }[];
}

function req<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

/** Column-major 4x4 helpers, glTF convention. */
function identityMatrix(): Float64Array {
  const m = new Float64Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

function multiplyMatrix(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function localNodeMatrix(node: GltfNode): Float64Array {
  if (node.matrix) return Float64Array.from(node.matrix);
  const t = node.translation ?? [0, 0, 0];
  const q = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const [qx, qy, qz, qw] = [q[0]!, q[1]!, q[2]!, q[3]!];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  const r = [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy),
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx),
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy),
  ];
  const m = new Float64Array(16);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) m[col * 4 + row] = r[col * 3 + row]! * s[col]!;
  }
  m[12] = t[0]!; m[13] = t[1]!; m[14] = t[2]!; m[15] = 1;
  return m;
}

function readVec3Accessor(gltf: GltfJson, dataView: DataView, accessorIndex: number): Float64Array {
  const accessor = req(gltf.accessors?.[accessorIndex], `accessor ${accessorIndex} missing`);
  if (accessor.componentType !== 5126 || accessor.type !== 'VEC3') {
    throw new Error(`accessor ${accessorIndex} is not a FLOAT VEC3`);
  }
  const viewIndex = req(accessor.bufferView, `accessor ${accessorIndex} has no bufferView`);
  const view = req(gltf.bufferViews?.[viewIndex], `bufferView ${viewIndex} missing`);
  const stride = view.byteStride !== undefined && view.byteStride >= 12 ? view.byteStride : 12;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const count = req(accessor.count, 'accessor count missing');
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const base = start + i * stride;
    out[i * 3] = dataView.getFloat32(base, true);
    out[i * 3 + 1] = dataView.getFloat32(base + 4, true);
    out[i * 3 + 2] = dataView.getFloat32(base + 8, true);
  }
  return out;
}

function collectWorldPositions(gltf: GltfJson, bin: Buffer): Float64Array {
  const dataView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const positions: number[] = [];
  const walk = (nodeIndex: number, parentMatrix: Float64Array): void => {
    const node = req(gltf.nodes?.[nodeIndex], `node ${nodeIndex} missing`);
    const world = multiplyMatrix(parentMatrix, localNodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = req(gltf.meshes?.[node.mesh], `mesh ${node.mesh} missing`);
      for (const primitive of mesh.primitives ?? []) {
        const accessorIndex = primitive.attributes?.POSITION;
        if (accessorIndex === undefined) continue;
        const raw = readVec3Accessor(gltf, dataView, accessorIndex);
        for (let i = 0; i < raw.length; i += 3) {
          const x = raw[i]!, y = raw[i + 1]!, z = raw[i + 2]!;
          positions.push(
            world[0]! * x + world[4]! * y + world[8]! * z + world[12]!,
            world[1]! * x + world[5]! * y + world[9]! * z + world[13]!,
            world[2]! * x + world[6]! * y + world[10]! * z + world[14]!,
          );
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  const scene = req(gltf.scenes?.[gltf.scene ?? 0], 'scene missing');
  for (const nodeIndex of scene.nodes ?? []) walk(nodeIndex, identityMatrix());
  return Float64Array.from(positions);
}

interface MeasuredMesh {
  positions: Float64Array;
  minY: number;
  maxY: number;
  footprintRadius: number;
}

function loadRockMesh(variant: RockVariant): MeasuredMesh {
  const gltfPath = path.join(repoRoot, GLTF_FILES[variant]);
  const gltf = JSON.parse(readFileSync(gltfPath, 'utf8')) as GltfJson;
  const bufferUri = req(gltf.buffers?.[0]?.uri, `${gltfPath}: buffer uri missing`);
  const bin = readFileSync(path.join(path.dirname(gltfPath), bufferUri));
  const positions = collectWorldPositions(gltf, bin);
  let minY = Infinity;
  let maxY = -Infinity;
  let footprintRadius = 0;
  for (let v = 0; v < positions.length; v += 3) {
    const y = positions[v + 1]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const r = Math.hypot(positions[v]!, positions[v + 2]!);
    if (r > footprintRadius) footprintRadius = r;
  }
  return { positions, minY, maxY, footprintRadius };
}

// ---------------------------------------------------------------------------
// Profile radius math (same convention as scripts/measure-rock-profiles.mjs:
// three.js right-handed yaw about +Y, corner-driven max radius).
// ---------------------------------------------------------------------------

function boxRadiusAtHeight(box: RockColliderBox, y: number): number {
  if (y < box.y - box.hy || y > box.y + box.hy) return 0;
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  let max = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = sx * box.hx;
      const lz = sz * box.hz;
      const d = Math.hypot(box.x + c * lx + s * lz, box.z + -s * lx + c * lz);
      if (d > max) max = d;
    }
  }
  return max;
}

function profileRadiusAtHeight(boxes: RockColliderBox[], y: number): number {
  let max = 0;
  for (const box of boxes) {
    const r = boxRadiusAtHeight(box, y);
    if (r > max) max = r;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('rock collider profiles', () => {
  it('exposes both licensed variants with finite, sane data', () => {
    for (const variant of VARIANTS) {
      const profile = rockColliderProfile(variant);
      expect(profile.variant).toBe(variant);
      expect(ROCK_COLLIDER_PROFILES[variant]).toBe(profile);
      expect(profile.boxes.length).toBeGreaterThanOrEqual(2);
      expect(profile.boxes.length).toBeLessThanOrEqual(3);
      for (const box of profile.boxes) {
        for (const value of [box.x, box.y, box.z, box.hx, box.hy, box.hz, box.yaw]) {
          expect(Number.isFinite(value), `non-finite box value in ${variant}`).toBe(true);
        }
        expect(box.hx).toBeGreaterThan(0);
        expect(box.hy).toBeGreaterThan(0);
        expect(box.hz).toBeGreaterThan(0);
      }
      expect(Number.isFinite(profile.footprintRadius)).toBe(true);
      expect(Number.isFinite(profile.height)).toBe(true);
      expect(profile.footprintRadius).toBeGreaterThan(0);
      expect(profile.height).toBeGreaterThan(0);
    }
  });

  it.each(VARIANTS)(
    '%s: boxes track the measured mesh within the overshoot/undershoot bounds',
    (variant) => {
      const mesh = loadRockMesh(variant);
      const profile = rockColliderProfile(variant);
      const meshHeight = mesh.maxY - mesh.minY;
      // Sampled heights = the 16 fine slice mid heights from
      // scripts/measure-rock-profiles.mjs, in the bottom-normalised frame.
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const h = (meshHeight * (i + 0.5)) / SAMPLE_COUNT;
        let meshRadius = 0;
        let vertices = 0;
        for (let v = 0; v < mesh.positions.length; v += 3) {
          if (Math.abs(mesh.positions[v + 1]! - mesh.minY - h) <= BAND_HALF_WIDTH) {
            vertices++;
            const r = Math.hypot(mesh.positions[v]!, mesh.positions[v + 2]!);
            if (r > meshRadius) meshRadius = r;
          }
        }
        const label = `${variant} slice ${i} (h=${h.toFixed(4)})`;
        expect(vertices, `${label}: measured band unexpectedly empty`).toBeGreaterThan(0);
        const boxRadius = profileRadiusAtHeight(profile.boxes, h);
        expect(boxRadius, `${label}: no collider box covers the mesh mass`).toBeGreaterThan(0);
        expect(
          boxRadius - meshRadius,
          `${label}: collider radius ${boxRadius.toFixed(4)} vs mesh ${meshRadius.toFixed(4)} (invisible-corner overshoot)`,
        ).toBeLessThanOrEqual(MAX_OVERSHOOT + 1e-9);
        expect(
          meshRadius - boxRadius,
          `${label}: collider radius ${boxRadius.toFixed(4)} vs mesh ${meshRadius.toFixed(4)} (walk-through undershoot)`,
        ).toBeLessThanOrEqual(MAX_UNDERSHOOT + 1e-9);
      }
    },
  );

  it.each(VARIANTS)(
    '%s: footprintRadius and height are consistent with the boxes and the mesh',
    (variant) => {
      const mesh = loadRockMesh(variant);
      const profile = rockColliderProfile(variant);
      let maxCorner = 0;
      let top = 0;
      for (const box of profile.boxes) {
        maxCorner = Math.max(maxCorner, boxRadiusAtHeight(box, box.y));
        top = Math.max(top, box.y + box.hy);
      }
      expect(profile.footprintRadius).toBeCloseTo(maxCorner, 6);
      expect(profile.height).toBeCloseTo(top, 9);
      // Profile data is documented at 4-6 decimal precision; allow that much
      // slack when comparing against the exact mesh extent.
      expect(profile.height).toBeLessThanOrEqual(mesh.maxY - mesh.minY + 1e-4);
      expect(profile.footprintRadius).toBeLessThanOrEqual(mesh.footprintRadius + MAX_OVERSHOOT + 1e-9);
    },
  );
});
