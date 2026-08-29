import type { TerrainCutout, TerrainGridMesh, TerrainHeightfield } from './types';
export type { TerrainGridMesh } from './types';

/** Match Rapier heightfield's anti-diagonal triangle interpolation exactly. */
export function sampleTerrainHeightfield(
  heightfield: TerrainHeightfield,
  size: number,
  x: number,
  z: number,
): number {
  const { n, heights } = heightfield;
  const gx = Math.max(0, Math.min(n - 1, ((x + size / 2) / size) * (n - 1)));
  const gz = Math.max(0, Math.min(n - 1, ((z + size / 2) / size) * (n - 1)));
  const col = Math.min(n - 2, Math.floor(gx));
  const row = Math.min(n - 2, Math.floor(gz));
  const u = gx - col;
  const v = gz - row;
  const a = heights[row * n + col]!;
  const b = heights[row * n + col + 1]!;
  const c = heights[(row + 1) * n + col]!;
  const d = heights[(row + 1) * n + col + 1]!;
  return u + v <= 1
    ? a + (b - a) * u + (c - a) * v
    : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

/** Two triangles per ribbon segment, wound counter-clockwise from above. */
export function buildTerrainRibbonIndices(segmentCount: number): Uint32Array {
  const indices = new Uint32Array(Math.max(0, Math.floor(segmentCount)) * 6);
  for (let segment = 0; segment < segmentCount; segment++) {
    const vertex = segment * 2;
    const out = segment * 6;
    indices[out] = vertex;
    indices[out + 1] = vertex + 1;
    indices[out + 2] = vertex + 2;
    indices[out + 3] = vertex + 2;
    indices[out + 4] = vertex + 1;
    indices[out + 5] = vertex + 3;
  }
  return indices;
}

interface TerrainGridOptions {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  segmentsX: number;
  segmentsZ: number;
  heightAt: (x: number, z: number) => number;
  removals: TerrainCutout[];
}

function axisCoordinates(
  min: number,
  max: number,
  segments: number,
  removals: TerrainCutout[],
  axis: 'x' | 'z',
): number[] {
  const values = Array.from({ length: segments + 1 }, (_, i) => min + ((max - min) * i) / segments);
  for (const hole of removals) {
    const lo = axis === 'x' ? hole.minX : hole.minZ;
    const hi = axis === 'x' ? hole.maxX : hole.maxZ;
    if (lo > min && lo < max) values.push(lo);
    if (hi > min && hi < max) values.push(hi);
  }
  values.sort((a, b) => a - b);
  return values.filter((value, i) => i === 0 || value - values[i - 1]! > 1e-5);
}

/**
 * Build a terrain grid whose cell boundaries include every authored opening.
 * No triangle can straddle a cutout edge, so render and physics share an exact
 * rectangular hole instead of the jagged half-cell left by centroid culling.
 */
export function buildTerrainGridMesh(options: TerrainGridOptions): TerrainGridMesh {
  const { minX, maxX, minZ, maxZ, segmentsX, segmentsZ, heightAt, removals } = options;
  const xs = axisCoordinates(minX, maxX, segmentsX, removals, 'x');
  const zs = axisCoordinates(minZ, maxZ, segmentsZ, removals, 'z');
  const positions = new Float32Array(xs.length * zs.length * 3);
  const uvs = new Float32Array(xs.length * zs.length * 2);
  for (let row = 0; row < zs.length; row++) {
    for (let col = 0; col < xs.length; col++) {
      const vertex = row * xs.length + col;
      const x = xs[col]!;
      const z = zs[row]!;
      positions[vertex * 3] = x;
      positions[vertex * 3 + 1] = heightAt(x, z);
      positions[vertex * 3 + 2] = z;
      uvs[vertex * 2] = (x - minX) / (maxX - minX);
      uvs[vertex * 2 + 1] = (z - minZ) / (maxZ - minZ);
    }
  }

  const triangles: number[] = [];
  for (let row = 0; row < zs.length - 1; row++) {
    for (let col = 0; col < xs.length - 1; col++) {
      const midX = (xs[col]! + xs[col + 1]!) / 2;
      const midZ = (zs[row]! + zs[row + 1]!) / 2;
      if (removals.some((hole) =>
        midX >= hole.minX && midX <= hole.maxX && midZ >= hole.minZ && midZ <= hole.maxZ)) continue;
      const a = row * xs.length + col;
      const b = a + 1;
      const c = a + xs.length;
      const d = c + 1;
      triangles.push(a, c, b, b, c, d);
    }
  }
  return {
    positions,
    uvs,
    indices: new Uint32Array(triangles),
    xs: new Float32Array(xs),
    zs: new Float32Array(zs),
  };
}

function intervalAt(axis: Float32Array, value: number): number {
  let lo = 0;
  let hi = axis.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (axis[mid]! <= value) lo = mid;
    else hi = mid;
  }
  return Math.min(axis.length - 2, Math.max(0, lo));
}

/** Sample the actual triangles emitted by buildTerrainGridMesh. */
export function sampleTerrainGridMeshHeight(mesh: TerrainGridMesh, x: number, z: number): number {
  const col = intervalAt(mesh.xs, x);
  const row = intervalAt(mesh.zs, z);
  const x0 = mesh.xs[col]!;
  const x1 = mesh.xs[col + 1]!;
  const z0 = mesh.zs[row]!;
  const z1 = mesh.zs[row + 1]!;
  const u = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  const v = Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
  const stride = mesh.xs.length;
  const height = (r: number, c: number): number => mesh.positions[(r * stride + c) * 3 + 1]!;
  const a = height(row, col);
  const b = height(row, col + 1);
  const c = height(row + 1, col);
  const d = height(row + 1, col + 1);
  return u + v <= 1
    ? a + (b - a) * u + (c - a) * v
    : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}
