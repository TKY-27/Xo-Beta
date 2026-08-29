/**
 * Map registry + loader. Prepares map definitions (including heightfield
 * data and terrain sampling). Collider construction happens inside Match
 * via buildColliders so simulation always has exactly one physics world.
 */

import type { MapDef } from './types';
import {
  buildTerrainGridMesh,
  sampleTerrainGridMeshHeight,
  sampleTerrainHeightfield,
} from './terrainMesh';
import { RAPIER_READY } from './rapierReady';
import { initPhysics } from '../physics/physics';
import { buildNeoCity } from './maps/neocity';
import { buildOldFront } from './maps/oldfront';
import { buildEdenFacility } from './maps/eden';
import { buildAsharaReach } from './maps/desert';

export type MapId = 'neocity' | 'oldfront' | 'eden' | 'ashara';

export interface LoadedMap {
  def: MapDef;
  terrainHeight: (x: number, z: number) => number;
}

const BUILDERS: Record<MapId, () => MapDef> = {
  neocity: buildNeoCity,
  oldfront: buildOldFront,
  eden: buildEdenFacility,
  ashara: buildAsharaReach,
};

export const MAP_LIST: Array<{
  id: MapId;
  name: string;
  description: string;
  nameKey: string;
  descKey: string;
}> = [
  {
    id: 'neocity',
    name: 'NEO CITY',
    description: 'Rain-slicked neon streets, rooftops and an underground transit hub.',
    nameKey: 'map.neocity.name',
    descKey: 'map.neocity.desc',
  },
  {
    id: 'oldfront',
    name: 'OLD FRONT',
    description: 'A worn frontier town: cathedral square, keep ruins and war remnants.',
    nameKey: 'map.oldfront.name',
    descKey: 'map.oldfront.desc',
  },
  {
    id: 'eden',
    name: 'EDEN FACILITY',
    description: 'Lakeside research station swallowed by green. Water routes and cliffs.',
    nameKey: 'map.eden.name',
    descKey: 'map.eden.desc',
  },
  {
    id: 'ashara',
    name: 'ASHARA REACH',
    description: 'Dense desert compounds, dry wadis, industrial yards and long-range ridges.',
    nameKey: 'map.ashara.name',
    descKey: 'map.ashara.desc',
  },
];

/** Must be awaited before constructing a Match (loads the Rapier WASM). */
export async function ensureWorldReady(): Promise<void> {
  await RAPIER_READY;
  await initPhysics();
}

export function loadMap(id: MapId): LoadedMap {
  const def = BUILDERS[id]();

  const hf = def.heightfield;
  if (hf) {
    const half = def.size / 2;
    const terrainMesh = buildTerrainGridMesh({
      minX: -half,
      maxX: half,
      minZ: -half,
      maxZ: half,
      segmentsX: hf.n - 1,
      segmentsZ: hf.n - 1,
      heightAt: (x, z) => sampleTerrainHeightfield(hf, def.size, x, z),
      removals: def.terrainCutouts ?? [],
    });
    def.terrainMesh = terrainMesh;
    def.terrainHeight = (x: number, z: number) => sampleTerrainGridMeshHeight(terrainMesh, x, z);
  }

  const terrainHeight = def.terrainHeight ?? (() => 0);
  const supportedY = (x: number, z: number, authoredY: number): number => {
    let support = terrainHeight(x, z);
    for (const platform of def.platforms) {
      if (platform.water) continue;
      if (x < platform.minX || x > platform.maxX || z < platform.minZ || z > platform.maxZ) continue;
      // Prefer the highest nearby walkable surface. Far-away upper floors do
      // not capture ground props, while sidewalks/decks correctly win over
      // terrain beneath them.
      if (platform.y >= authoredY - 0.65 && platform.y <= authoredY + 0.5) {
        support = Math.max(support, platform.y);
      }
    }
    return support;
  };
  // Builders place scatter from their analytic terrain formula, while render
  // and Rapier consume the finite heightfield sampled from that formula. On a
  // steep bank those two surfaces can differ by half a metre. Re-anchor only
  // objects already close enough to be ground-authored; intentional rooftop,
  // bridge and underwater placements remain untouched.
  for (const tree of def.trees) {
    // Rooftop palms may sit in raised planters above the registered roof
    // platform. Only terrain-authored vegetation is resampled here.
    const y = terrainHeight(tree.x, tree.z);
    if (Math.abs(tree.y - y) < 0.8) tree.y = y;
  }
  for (const rock of def.rocks) {
    const inWater = def.water.some((w) => (
      rock.x >= w.minX && rock.x <= w.maxX && rock.z >= w.minZ && rock.z <= w.maxZ
    ));
    if (inWater) continue;
    const y = supportedY(rock.x, rock.z, rock.y);
    if (Math.abs(rock.y - y) < 0.8) rock.y = y;
  }
  for (const vehicle of def.vehicles) {
    const y = supportedY(vehicle.x, vehicle.z, vehicle.y);
    if (Math.abs(vehicle.y - y) < 0.5) vehicle.y = y;
  }
  for (const lamp of def.lamps) {
    const y = supportedY(lamp.x, lamp.z, lamp.y);
    const delta = y - lamp.y;
    if (Math.abs(delta) >= 0.6) continue;
    lamp.y = y;
    for (const geo of def.geo) {
      if (!geo.noRender || geo.kind !== 'box') continue;
      if (Math.abs(geo.x - lamp.x) < 0.01 && Math.abs(geo.z - lamp.z) < 0.01
        && Math.abs(geo.sy - lamp.h) < 0.01) geo.y += delta;
    }
  }

  return {
    def,
    terrainHeight,
  };
}
