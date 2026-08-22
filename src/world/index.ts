/**
 * Map registry + loader. Prepares map definitions (including heightfield
 * data and terrain sampling). Collider construction happens inside Match
 * via buildColliders so simulation always has exactly one physics world.
 */

import type { MapDef } from './types';
import { RAPIER_READY } from './rapierReady';
import { initPhysics } from '../physics/physics';
import { buildNeoCity } from './maps/neocity';
import { buildOldFront } from './maps/oldfront';
import { buildEdenFacility } from './maps/eden';

export type MapId = 'neocity' | 'oldfront' | 'eden';

export interface LoadedMap {
  def: MapDef;
  terrainHeight: (x: number, z: number) => number;
}

const BUILDERS: Record<MapId, () => MapDef> = {
  neocity: buildNeoCity,
  oldfront: buildOldFront,
  eden: buildEdenFacility,
};

interface HeightfieldExt {
  heightfield?: { n: number; heights: Float32Array };
}

export const MAP_LIST: Array<{ id: MapId; name: string; description: string }> = [
  { id: 'neocity', name: 'NEO CITY', description: 'Rain-slicked neon streets, rooftops and an underground transit hub.' },
  { id: 'oldfront', name: 'OLD FRONT', description: 'A worn frontier town: cathedral square, keep ruins and war remnants.' },
  { id: 'eden', name: 'EDEN FACILITY', description: 'Lakeside research station swallowed by green. Water routes and cliffs.' },
];

/** Must be awaited before constructing a Match (loads the Rapier WASM). */
export async function ensureWorldReady(): Promise<void> {
  await RAPIER_READY;
  await initPhysics();
}

export function loadMap(id: MapId): LoadedMap {
  const def = BUILDERS[id]();

  const hf = (def as MapDef & HeightfieldExt).heightfield;
  if (hf) {
    const n = hf.n;
    def.terrainHeight = (x: number, z: number) => {
      const gx = ((x + def.size / 2) / def.size) * (n - 1);
      const gz = ((z + def.size / 2) / def.size) * (n - 1);
      const x0 = Math.max(0, Math.min(n - 2, Math.floor(gx)));
      const z0 = Math.max(0, Math.min(n - 2, Math.floor(gz)));
      const fx = gx - x0;
      const fz = gz - z0;
      const h00 = hf.heights[z0 * n + x0]!;
      const h10 = hf.heights[z0 * n + x0 + 1]!;
      const h01 = hf.heights[(z0 + 1) * n + x0]!;
      const h11 = hf.heights[(z0 + 1) * n + x0 + 1]!;
      return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
    };
  }

  return {
    def,
    terrainHeight: def.terrainHeight ?? (() => 0),
  };
}
