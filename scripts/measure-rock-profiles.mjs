#!/usr/bin/env node
/**
 * Measures the two licensed Quaternius rock variants (Rock_Medium_1 /
 * Rock_Medium_2) straight from their glTF 2.0 sources, with zero
 * dependencies: the .gltf JSON is parsed and the .bin POSITION accessors are
 * decoded by hand (FLOAT/VEC3, bufferView byteOffset + byteStride honoured,
 * node world transforms applied).
 *
 * Usage:
 *   node scripts/measure-rock-profiles.mjs
 *       Prints the full measurement JSON for each variant to stdout: vertex
 *       count, source AABB, horizontal footprint radius from the mesh origin,
 *       and width profiles (max horizontal radius from the vertical axis at
 *       (0,0)) for 8 coarse and 16 fine horizontal slices.
 *
 *   node scripts/measure-rock-profiles.mjs --check <path-or-json>
 *       Additionally evaluates a candidate collider profile against the
 *       measured vertex cloud. Input is either a path to a JSON file or a
 *       literal JSON string shaped like:
 *         { "medium-1": [ { x, y, z, hx, hy, hz, yaw }, ... ],
 *           "medium-2": [ ... ] }
 *       (yaw is the three.js right-handed rotation about +Y).
 *
 * Frame conventions (matches src/world/rockProfiles.ts):
 *   - glTF is Y-up right-handed; the raw transformed geometry is treated as
 *     the render-side source (the renderer only adds uniform-ish scale,
 *     small tilt and a burial offset on top of it).
 *   - the horizontal origin (0,0) is the mesh origin: the render composes
 *     each instance at the rock's authored (x, z), so all radii are measured
 *     from (0,0), not from the AABB centre.
 *   - heights are reported in a bottom-normalised frame: yNormalised =
 *     yRaw - minY, i.e. y=0 is the source mesh bottom (the prop loader
 *     normalises both source bottoms to y=0; see src/render/props.ts
 *     extractGeometries and the baseOffset comment in
 *     src/render/worldView.ts).
 */

/* global console, process, Buffer */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VARIANTS = [
  { variant: 'medium-1', gltfPath: 'public/assets/models/nature/Rock_Medium_1.gltf' },
  { variant: 'medium-2', gltfPath: 'public/assets/models/nature/Rock_Medium_2.gltf' },
];

const SLICE_COUNTS = [8, 16];
const FINE_SLICES = 16;
const SECTOR_COUNT = 8;
/** Sampled-height band half-width used by --check and by the unit test. */
const BAND_HALF_WIDTH = 0.05;
/** Acceptance bounds mirrored by tests/unit/rock-profiles.test.ts. */
const MAX_OVERSHOOT = 0.12;
const MAX_UNDERSHOOT = 0.35;

const COMPONENT_BYTE_LENGTHS = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

// ---------------------------------------------------------------------------
// Column-major 4x4 matrix helpers (glTF matrices are column-major, Y-up).
// ---------------------------------------------------------------------------

function mat4Identity() {
  const m = new Float64Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/** Returns a * b (both column-major). */
function mat4Multiply(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Composes a local TRS matrix (M = T * R * S) from a glTF node. */
function mat4FromNode(node) {
  if (node.matrix) return Float64Array.from(node.matrix);
  const t = node.translation ?? [0, 0, 0];
  const q = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const [qx, qy, qz, qw] = q;
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  const m = new Float64Array(16);
  // Rotation columns, each scaled by the matching axis scale.
  const r = [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy),
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx),
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy),
  ];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) m[col * 4 + row] = r[col * 3 + row] * s[col];
  }
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

// ---------------------------------------------------------------------------
// Minimal glTF 2.0 POSITION reading.
// ---------------------------------------------------------------------------

function loadGltf(gltfPath) {
  return JSON.parse(readFileSync(gltfPath, 'utf8'));
}

function loadBuffer(gltfPath, gltf) {
  const buffer = gltf.buffers?.[0];
  if (!buffer) throw new Error(`${gltfPath}: no buffers entry`);
  if (buffer.uri === undefined) throw new Error(`${gltfPath}: embedded GLB buffers are not supported`);
  if (buffer.uri.startsWith('data:')) {
    const comma = buffer.uri.indexOf(',');
    return Buffer.from(buffer.uri.slice(comma + 1), 'base64');
  }
  return readFileSync(path.join(path.dirname(gltfPath), decodeURIComponent(buffer.uri)));
}

/** Decodes one FLOAT VEC3 accessor into a flat [x,y,z,...] Float64Array. */
function readVec3Accessor(gltf, dataView, accessorIndex, gltfPath) {
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`${gltfPath}: accessor ${accessorIndex} not found`);
  if (accessor.componentType !== 5126) {
    throw new Error(`${gltfPath}: accessor ${accessorIndex} is not FLOAT (got ${accessor.componentType})`);
  }
  if (accessor.type !== 'VEC3') {
    throw new Error(`${gltfPath}: accessor ${accessorIndex} is not VEC3 (got ${accessor.type})`);
  }
  const view = gltf.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`${gltfPath}: bufferView ${accessor.bufferView} not found`);
  const componentBytes = COMPONENT_BYTE_LENGTHS[5126];
  const stride = view.byteStride && view.byteStride >= componentBytes * 3
    ? view.byteStride
    : componentBytes * 3;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Float64Array(accessor.count * 3);
  for (let i = 0; i < accessor.count; i++) {
    const base = start + i * stride;
    out[i * 3 + 0] = dataView.getFloat32(base, true);
    out[i * 3 + 1] = dataView.getFloat32(base + 4, true);
    out[i * 3 + 2] = dataView.getFloat32(base + 8, true);
  }
  return out;
}

/** Walks the scene graph and returns all POSITION vertices, world-transformed. */
function collectWorldPositions(gltf, bin, gltfPath) {
  const dataView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const positions = [];
  let triangleCount = 0;
  /** POSITION accessors used, with their declared min/max (provenance). */
  const positionAccessors = [];
  const declaredAccessorBounds = [];

  const walk = (nodeIndex, parentMatrix) => {
    const node = gltf.nodes?.[nodeIndex];
    if (!node) throw new Error(`${gltfPath}: node ${nodeIndex} not found`);
    const world = mat4Multiply(parentMatrix, mat4FromNode(node));
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes?.[node.mesh];
      if (!mesh) throw new Error(`${gltfPath}: mesh ${node.mesh} not found`);
      for (const primitive of mesh.primitives) {
        const posIndex = primitive.attributes?.POSITION;
        if (posIndex === undefined) continue;
        const raw = readVec3Accessor(gltf, dataView, posIndex, gltfPath);
        positionAccessors.push(posIndex);
        if (Array.isArray(gltf.accessors?.[posIndex]?.min)) {
          declaredAccessorBounds.push({ accessor: posIndex, min: gltf.accessors[posIndex].min, max: gltf.accessors[posIndex].max });
        }
        for (let i = 0; i < raw.length; i += 3) {
          const x = raw[i], y = raw[i + 1], z = raw[i + 2];
          positions.push(
            world[0] * x + world[4] * y + world[8] * z + world[12],
            world[1] * x + world[5] * y + world[9] * z + world[13],
            world[2] * x + world[6] * y + world[10] * z + world[14],
          );
        }
        if (primitive.indices !== undefined) {
          triangleCount += (gltf.accessors?.[primitive.indices]?.count ?? 0) / 3;
        } else {
          triangleCount += raw.length / 9;
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };

  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const nodeIndex of scene?.nodes ?? []) walk(nodeIndex, mat4Identity());
  return { positions: Float64Array.from(positions), triangleCount, declaredAccessorBounds };
}

// ---------------------------------------------------------------------------
// Measurement.
// ---------------------------------------------------------------------------

const round4 = (v) => Math.round(v * 1e4) / 1e4;

function sliceTable(positions, minY, height, sliceCount) {
  const slices = [];
  for (let i = 0; i < sliceCount; i++) {
    const yLow = (height * i) / sliceCount;
    const yHigh = (height * (i + 1)) / sliceCount;
    let radius = 0;
    let vertexCount = 0;
    for (let v = 0; v < positions.length; v += 3) {
      const yn = positions[v + 1] - minY;
      const inSlice = yn >= yLow && (yn < yHigh || (i === sliceCount - 1 && yn <= yHigh));
      if (!inSlice) continue;
      vertexCount++;
      const r = Math.hypot(positions[v], positions[v + 2]);
      if (r > radius) radius = r;
    }
    slices.push({
      index: i,
      yLow: round4(yLow),
      yHigh: round4(yHigh),
      yMid: round4((yLow + yHigh) / 2),
      vertexCount,
      radius: round4(radius),
    });
  }
  return slices;
}

/** Per fine slice: max radius in SECTOR_COUNT equal angular sectors. */
function sectorTable(positions, minY, height) {
  const table = [];
  const sectorWidth = (Math.PI * 2) / SECTOR_COUNT;
  for (let i = 0; i < FINE_SLICES; i++) {
    const yLow = (height * i) / FINE_SLICES;
    const yHigh = (height * (i + 1)) / FINE_SLICES;
    const sectorRadii = new Array(SECTOR_COUNT).fill(0);
    for (let v = 0; v < positions.length; v += 3) {
      const yn = positions[v + 1] - minY;
      const inSlice = yn >= yLow && (yn < yHigh || (i === FINE_SLICES - 1 && yn <= yHigh));
      if (!inSlice) continue;
      const angle = Math.atan2(positions[v + 2], positions[v]); // [-PI, PI]
      const sector = Math.min(SECTOR_COUNT - 1, Math.floor((angle + Math.PI) / sectorWidth));
      const r = Math.hypot(positions[v], positions[v + 2]);
      if (r > sectorRadii[sector]) sectorRadii[sector] = r;
    }
    table.push({ slice: i, yMid: round4((yLow + yHigh) / 2), sectorRadii: sectorRadii.map(round4) });
  }
  return table;
}

function measureVariant(variant, gltfPath) {
  const absoluteGltfPath = path.join(repoRoot, gltfPath);
  const gltf = loadGltf(absoluteGltfPath);
  const bin = loadBuffer(absoluteGltfPath, gltf);
  const { positions, triangleCount, declaredAccessorBounds } = collectWorldPositions(gltf, bin, absoluteGltfPath);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let footprintRadius = 0;
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v], y = positions[v + 1], z = positions[v + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    const r = Math.hypot(x, z);
    if (r > footprintRadius) footprintRadius = r;
  }
  const height = maxY - minY;

  const slices = {};
  for (const count of SLICE_COUNTS) slices[`slices${count}`] = sliceTable(positions, minY, height, count);

  return {
    variant,
    gltf: gltfPath,
    vertexCount: positions.length / 3,
    triangleCount: round4(triangleCount),
    sourceAabb: {
      min: [round4(minX), round4(minY), round4(minZ)],
      max: [round4(maxX), round4(maxY), round4(maxZ)],
    },
    declaredAccessorBounds,
    normalized: {
      /** Bottom-normalised frame: y = rawY - minY, so y=0 is the mesh bottom. */
      height: round4(height),
      aabb: {
        min: [round4(minX), 0, round4(minZ)],
        max: [round4(maxX), round4(height), round4(maxZ)],
      },
      footprintRadius: round4(footprintRadius),
      ...slices,
      sectorRadii16x8: sectorTable(positions, minY, height),
    },
    _positions: positions,
    _minY: minY,
  };
}

// ---------------------------------------------------------------------------
// Candidate profile evaluation (--check mode).
// ---------------------------------------------------------------------------

/**
 * Max horizontal distance from the vertical axis at (0,0) over the yaw-rotated
 * box cross-section at height y (three.js right-handed yaw about +Y), or 0
 * when the box does not cover that height.
 */
export function boxRadiusAtHeight(box, y) {
  if (y < box.y - box.hy || y > box.y + box.hy) return 0;
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  let max = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = sx * box.hx;
      const lz = sz * box.hz;
      const wx = box.x + c * lx + s * lz;
      const wz = box.z + -s * lx + c * lz;
      const d = Math.hypot(wx, wz);
      if (d > max) max = d;
    }
  }
  return max;
}

function profileRadiusAtHeight(boxes, y) {
  let max = 0;
  for (const box of boxes) {
    const r = boxRadiusAtHeight(box, y);
    if (r > max) max = r;
  }
  return max;
}

/** Max horizontal corner distance over a whole box (ignoring height). */
function boxFootprintRadius(box) {
  return boxRadiusAtHeight(box, box.y);
}

function evaluateProfile(measured, boxes, height) {
  const positions = measured._positions;
  const minY = measured._minY;
  const rows = [];
  for (let i = 0; i < FINE_SLICES; i++) {
    // Sampled at the 16 fine slice mid heights (same definition as
    // tests/unit/rock-profiles.test.ts).
    const h = (height * (i + 0.5)) / FINE_SLICES;
    let meshRadius = 0;
    let vertexCount = 0;
    for (let v = 0; v < positions.length; v += 3) {
      if (Math.abs(positions[v + 1] - minY - h) <= BAND_HALF_WIDTH) {
        vertexCount++;
        const r = Math.hypot(positions[v], positions[v + 2]);
        if (r > meshRadius) meshRadius = r;
      }
    }
    const boxRadius = profileRadiusAtHeight(boxes, h);
    rows.push({
      height: round4(h),
      vertexCount,
      meshRadius: round4(meshRadius),
      boxRadius: round4(boxRadius),
      overshoot: round4(boxRadius - meshRadius),
      undershoot: round4(meshRadius - boxRadius),
      ok: boxRadius <= meshRadius + MAX_OVERSHOOT + 1e-9 && meshRadius - boxRadius <= MAX_UNDERSHOOT + 1e-9,
    });
  }
  const failures = rows.filter((row) => !row.ok);
  return {
    rows,
    maxOvershoot: round4(Math.max(...rows.map((row) => row.overshoot))),
    maxUndershoot: round4(Math.max(...rows.map((row) => row.undershoot))),
    pass: failures.length === 0,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function main() {
  const measurements = VARIANTS.map(({ variant, gltfPath }) => measureVariant(variant, gltfPath));

  const checkArgIndex = process.argv.indexOf('--check');
  if (checkArgIndex !== -1) {
    const arg = process.argv[checkArgIndex + 1];
    if (!arg) {
      console.error('--check requires a JSON file path or a literal JSON string');
      process.exit(1);
    }
    const candidate = JSON.parse(arg.startsWith('{') ? arg : readFileSync(path.resolve(arg), 'utf8'));
    const report = {};
    for (const measured of measurements) {
      const boxes = candidate[measured.variant];
      if (!Array.isArray(boxes)) {
        report[measured.variant] = { error: 'missing box list for variant' };
        continue;
      }
      report[measured.variant] = {
        normalizedHeight: measured.normalized.height,
        ...evaluateProfile(measured, boxes, measured.normalized.height),
        profileFootprintRadius: round4(Math.max(...boxes.map(boxFootprintRadius))),
        profileHeight: round4(Math.max(...boxes.map((b) => b.y + b.hy))),
      };
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const output = { units: 'metres, source mesh scale 1', variants: [] };
  for (const measured of measurements) {
    output.variants.push({
      variant: measured.variant,
      gltf: measured.gltf,
      vertexCount: measured.vertexCount,
      triangleCount: measured.triangleCount,
      sourceAabb: measured.sourceAabb,
      declaredAccessorBounds: measured.declaredAccessorBounds,
      normalized: measured.normalized,
    });
  }
  console.log(JSON.stringify(output, null, 2));
}

main();
