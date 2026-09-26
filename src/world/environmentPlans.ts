import type { GeoBox } from './types';
import {
  defineEnvironmentKit,
  defineEnvironmentPlan,
  defineEnvironmentPrefab,
  resolveEnvironmentPlan,
  transformEnvironmentPoint,
  type EnvironmentPlan,
  type EnvironmentPrefabInstanceInput,
  type EnvironmentCollisionInput,
  type EnvironmentNavigation,
  type EnvironmentCover,
} from './environmentKit';

const PATHS = {
  wallWindow: 'environment/eden/wall-window.glb',
  wallDoorway: 'environment/eden/wall-doorway.glb',
  wallReinforced: 'environment/eden/wall-reinforced.glb',
  wallCorner: 'environment/eden/wall-corner.glb',
  wallDamaged: 'environment/eden/wall-damaged.glb',
  roofFlat: 'environment/eden/roof-flat.glb',
  roofTrim: 'environment/eden/roof-trim.glb',
  parapet: 'environment/eden/parapet.glb',
  ceiling: 'environment/eden/ceiling.glb',
  floor: 'environment/eden/floor.glb',
  floorHatch: 'environment/eden/floor-hatch.glb',
  stairs: 'environment/eden/stairs.glb',
  railing: 'environment/eden/railing.glb',
  beam: 'environment/eden/beam.glb',
  supportColumn: 'environment/eden/support-column.glb',
  ventWall: 'environment/eden/vent-wall.glb',
  doorframe: 'environment/eden/doorframe.glb',
  doorPanel: 'environment/eden/door-panel.glb',
  pipe: 'environment/eden/pipe.glb',
  crate: 'environment/eden/crate.glb',
  crateStack: 'environment/eden/crate-stack.glb',
  crateBroken: 'environment/eden/crate-broken.glb',
  rubblePile: 'environment/eden/rubble-pile.glb',
  debrisScatter: 'environment/eden/debris-scatter.glb',
  barrelDented: 'environment/eden/barrel-dented.glb',
} as const;

const POLYHAVEN_PATHS = {
  urbanFacade: 'environment/polyhaven/modular-urban-apartments-facade.glb',
  fireEscape: 'environment/polyhaven/modular-fire-escape.glb',
  factoryFacade: 'environment/polyhaven/modular-factory-facade.glb',
  fort: 'environment/polyhaven/modular-fort-01.glb',
  plasticCrate: 'environment/polyhaven/plastic-crate-03.glb',
  woodenCrate: 'environment/polyhaven/wooden-crate-01.glb',
  wickerBasket: 'environment/polyhaven/wicker-basket-01.glb',
  woodenTable: 'environment/polyhaven/wooden-table-02.glb',
  ceramicPot: 'environment/polyhaven/ceramic-pot.glb',
  ceramicVase: 'environment/polyhaven/ceramic-vase.glb',
  brassLantern: 'environment/polyhaven/brass-lantern.glb',
} as const;

const QUATERNIUS_PATHS = {
  marketStand1: 'environment/quaternius/medieval-market-stand-1.glb',
  marketStand2: 'environment/quaternius/medieval-market-stand-2.glb',
  wallArch: 'environment/quaternius/wall-arch.glb',
  wallPlasterStraight: 'environment/quaternius/wall-plaster-straight.glb',
  wallBrickStraight: 'environment/quaternius/wall-uneven-brick-straight.glb',
  wallDoorRound: 'environment/quaternius/wall-uneven-brick-door-round.glb',
} as const;

const KAYKIT_PATHS = {
  market: 'environment/kaykit-market.glb',
  homeA: 'environment/kaykit/kaykit-home-a.glb',
  homeB: 'environment/kaykit/kaykit-home-b.glb',
  towerA: 'environment/kaykit/kaykit-tower-a.glb',
  tavern: 'environment/kaykit/kaykit-tavern.glb',
} as const;

const XO_MARKET_PATHS = {
  marketHall: 'environment/xo-market/market-hall.glb',
  shopRow: 'environment/xo-market/shop-row.glb',
} as const;

type FacilityPrefabId = keyof typeof PATHS;
type PolyhavenPrefabId = keyof typeof POLYHAVEN_PATHS;
type QuaterniusPrefabId = keyof typeof QUATERNIUS_PATHS;
type KaykitPrefabId = keyof typeof KAYKIT_PATHS;
type XoMarketPrefabId = keyof typeof XO_MARKET_PATHS;
type PrefabId = FacilityPrefabId | PolyhavenPrefabId | QuaterniusPrefabId | KaykitPrefabId | XoMarketPrefabId;

function facilityCollision(id: PrefabId): EnvironmentCollisionInput | undefined {
  if (!(id in PATHS)) return undefined;
  const boxes: Partial<Record<FacilityPrefabId, EnvironmentCollisionInput>> = {
    crate: [{ kind: 'box', center: [0, 0.5, 0], halfExtents: [0.45, 0.5, 0.45] }],
    crateStack: [{ kind: 'box', center: [0, 0.8, 0], halfExtents: [0.65, 0.8, 0.55] }],
    crateBroken: [{ kind: 'box', center: [0, 0.35, 0], halfExtents: [0.5, 0.35, 0.45] }],
    barrelDented: [{ kind: 'box', center: [0, 0.55, 0], halfExtents: [0.32, 0.55, 0.32] }],
  };
  return boxes[id as FacilityPrefabId];
}

function facilityNavigation(id: FacilityPrefabId): Partial<EnvironmentNavigation> {
  return facilityCollision(id)
    ? { role: 'obstacle', blocksMovement: true, clearance: 0.25, tags: ['authored', 'solid'] }
    : { role: 'none' };
}

function facilityCover(id: FacilityPrefabId): Partial<EnvironmentCover> {
  if (id === 'crate' || id === 'crateStack' || id === 'crateBroken') {
    return { heightClass: 'waist', protection: 'partial', crouchSafe: true, blocksProjectiles: true, destructible: true, tags: ['cover', 'crate'] };
  }
  if (id === 'barrelDented') {
    return { heightClass: 'waist', protection: 'partial', crouchSafe: true, blocksProjectiles: true, destructible: true, tags: ['cover', 'barrelDented'] };
  }
  return {};
}

function polyhavenCollision(id: PolyhavenPrefabId): EnvironmentCollisionInput | undefined {
  if (id === 'fort') {
    return [
      { kind: 'box', center: [-34.2, 6.8, 0], halfExtents: [1.5, 6.8, 21.3] },
      { kind: 'box', center: [34.2, 6.8, 0], halfExtents: [1.5, 6.8, 21.3] },
      { kind: 'box', center: [0, 6.8, 19.8], halfExtents: [35.7, 6.8, 1.5] },
      { kind: 'box', center: [0, 6.8, -19.8], halfExtents: [35.7, 6.8, 1.5] },
    ];
  }
  if (id === 'plasticCrate') {
    return [{ kind: 'box', center: [0, 0.133, 0], halfExtents: [0.241, 0.133, 0.133] }];
  }
  if (id === 'woodenCrate') {
    return [{ kind: 'box', center: [0, 0.205, 0], halfExtents: [0.413, 0.205, 0.175] }];
  }
  if (id === 'wickerBasket') {
    return [{ kind: 'box', center: [0, 0.148, 0], halfExtents: [0.192, 0.148, 0.059] }];
  }
  if (id === 'woodenTable') {
    return [{ kind: 'box', center: [0, 0.353, 0], halfExtents: [0.567, 0.353, 0.4] }];
  }
  return undefined;
}

function quaterniusCollision(id: QuaterniusPrefabId): EnvironmentCollisionInput | undefined {
  if (id === 'marketStand1') {
    return [{ kind: 'box', center: [0, 0.595, 0], halfExtents: [0.475, 0.595, 0.525] }];
  }
  if (id === 'marketStand2') {
    return [{ kind: 'box', center: [0, 0.521, 0], halfExtents: [0.259, 0.521, 0.577] }];
  }
  if (id === 'wallArch' || id === 'wallDoorRound') {
    return [
      { kind: 'box', center: [-0.9, 1.5, 0], halfExtents: [0.1, 1.5, 0.08] },
      { kind: 'box', center: [0.9, 1.5, 0], halfExtents: [0.1, 1.5, 0.08] },
      { kind: 'box', center: [0, 2.78, 0], halfExtents: [1, 0.22, 0.08] },
    ];
  }
  if (id === 'wallPlasterStraight' || id === 'wallBrickStraight') {
    return [{ kind: 'box', center: [0, 1.5, 0], halfExtents: [1, 1.5, 0.08] }];
  }
  return undefined;
}

function kaykitCollision(id: KaykitPrefabId): EnvironmentCollisionInput | undefined {
  if (id === 'market') {
    // The source market is an open-front stall: solid side/back shell and two
    // front posts leave a readable entrance while preventing walk-through.
    return [
      { kind: 'box', center: [-0.78, 0.65, 0], halfExtents: [0.12, 0.65, 0.49] },
      { kind: 'box', center: [0.78, 0.65, 0], halfExtents: [0.12, 0.65, 0.49] },
      { kind: 'box', center: [0, 0.65, 0.4], halfExtents: [0.9, 0.65, 0.09] },
      { kind: 'box', center: [-0.72, 0.65, -0.4], halfExtents: [0.12, 0.65, 0.12] },
      { kind: 'box', center: [0.72, 0.65, -0.4], halfExtents: [0.12, 0.65, 0.12] },
    ];
  }
  if (id === 'homeA') return [{ kind: 'box', center: [0, 0.43, 0], halfExtents: [0.4, 0.43, 0.47] }];
  if (id === 'homeB') return [{ kind: 'box', center: [0, 0.55, 0], halfExtents: [0.44, 0.55, 0.64] }];
  if (id === 'towerA') return [{ kind: 'box', center: [0, 0.58, 0], halfExtents: [0.5, 0.58, 1.1] }];
  if (id === 'tavern') return [{ kind: 'box', center: [0, 0.67, 0], halfExtents: [0.59, 0.67, 0.7] }];
  return undefined;
}

function xoMarketCollision(id: XoMarketPrefabId): EnvironmentCollisionInput | undefined {
  if (id === 'marketHall') {
    return [
      { kind: 'box', center: [-3.92, 1.85, 0], halfExtents: [0.08, 1.85, 2.42] },
      { kind: 'box', center: [3.92, 1.85, 0], halfExtents: [0.08, 1.85, 2.42] },
      { kind: 'box', center: [0, 1.85, 2.42], halfExtents: [3.92, 1.85, 0.08] },
      { kind: 'box', center: [-2.9, 1.85, -2.42], halfExtents: [1.1, 1.85, 0.08] },
      { kind: 'box', center: [2.9, 1.85, -2.42], halfExtents: [1.1, 1.85, 0.08] },
      { kind: 'box', center: [0, 3.2, -2.42], halfExtents: [1.8, 0.5, 0.08] },
      { kind: 'box', center: [2.6, 1.16, 3.68], halfExtents: [1.74, 1.16, 1.18] },
      { kind: 'box', center: [-2.45, 4.545, 0.95], halfExtents: [0.85, 0.845, 0.75] },
    ];
  }
  if (id === 'shopRow') {
    // The authored row faces local -Y. Front wall segments leave a 1.2 m
    // central doorway; the remaining boxes cover the shell, divider, counter
    // and awning posts without turning the whole row into a solid block.
    return [
      { kind: 'box', center: [-3.85, 1.5, 0], halfExtents: [0.3, 1.5, 2.4] },
      { kind: 'box', center: [3.85, 1.5, 0], halfExtents: [0.3, 1.5, 2.4] },
      { kind: 'box', center: [0, 1.5, 2.4], halfExtents: [4.15, 1.5, 0.3] },
      { kind: 'box', center: [-2.4, 1.5, -2.4], halfExtents: [1.8, 1.5, 0.3] },
      { kind: 'box', center: [2.4, 1.5, -2.4], halfExtents: [1.8, 1.5, 0.3] },
      { kind: 'box', center: [0, 1.4, 0], halfExtents: [0.12, 1.4, 2.4] },
      { kind: 'box', center: [1.35, 0.9, -1.85], halfExtents: [1.35, 0.5, 0.5] },
      { kind: 'box', center: [0, 2.85, -2.4], halfExtents: [1.2, 0.35, 0.3] },
    ];
  }
  return undefined;
}

function xoMarketNavigation(id: XoMarketPrefabId): Partial<EnvironmentNavigation> {
  if (id === 'marketHall' || id === 'shopRow') {
    return { role: 'obstacle', blocksMovement: true, clearance: 0.5, tags: ['authored', 'solid', 'market', 'building'] };
  }
  return { role: 'none' };
}

function xoMarketCover(id: XoMarketPrefabId): Partial<EnvironmentCover> {
  if (id === 'marketHall' || id === 'shopRow') {
    return { heightClass: 'full', protection: 'full', crouchSafe: true, blocksProjectiles: true, destructible: false, tags: ['cover', 'market', 'building'] };
  }
  return {};
}

function prefabCollision(id: PrefabId): EnvironmentCollisionInput | undefined {
  if (id in PATHS) return facilityCollision(id as FacilityPrefabId);
  if (id in POLYHAVEN_PATHS) return polyhavenCollision(id as PolyhavenPrefabId);
  if (id in QUATERNIUS_PATHS) return quaterniusCollision(id as QuaterniusPrefabId);
  if (id in KAYKIT_PATHS) return kaykitCollision(id as KaykitPrefabId);
  if (id in XO_MARKET_PATHS) return xoMarketCollision(id as XoMarketPrefabId);
  return undefined;
}

function prefabNavigation(id: PrefabId): Partial<EnvironmentNavigation> {
  if (id in PATHS) return facilityNavigation(id as FacilityPrefabId);
  if (id === 'fort') return { role: 'obstacle', blocksMovement: true, clearance: 0.5, tags: ['authored', 'solid'] };
  if (id === 'plasticCrate' || id === 'woodenCrate' || id === 'wickerBasket' || id === 'woodenTable') {
    return { role: 'obstacle', blocksMovement: true, clearance: 0.25, tags: ['authored', 'solid', 'cargo'] };
  }
  if (id === 'marketStand1' || id === 'marketStand2') {
    return { role: 'obstacle', blocksMovement: true, clearance: 0.5, tags: ['authored', 'solid', 'market', 'stall'] };
  }
  if (id === 'wallArch' || id === 'wallDoorRound' || id === 'wallPlasterStraight' || id === 'wallBrickStraight') {
    return { role: 'obstacle', blocksMovement: true, clearance: 0.15, tags: ['authored', 'solid', 'market', 'enclosure'] };
  }
  if (id === 'market' || id === 'marketHall') {
    return { role: 'obstacle', blocksMovement: true, clearance: 0.5, tags: ['authored', 'solid', 'market', 'building'] };
  }
  return { role: 'none' };
}

function polyhavenCover(id: PolyhavenPrefabId): Partial<EnvironmentCover> {
  if (id === 'plasticCrate' || id === 'woodenCrate') {
    return { heightClass: 'waist', protection: 'partial', crouchSafe: true, blocksProjectiles: true, destructible: true, tags: ['cover', 'cargo'] };
  }
  if (id === 'wickerBasket') {
    return { heightClass: 'low', protection: 'partial', crouchSafe: true, blocksProjectiles: false, destructible: true, tags: ['cover', 'cargo'] };
  }
  if (id === 'woodenTable') {
    return { heightClass: 'waist', protection: 'partial', crouchSafe: true, blocksProjectiles: true, destructible: true, tags: ['cover', 'cargo', 'market'] };
  }
  return {};
}

function quaterniusCover(id: QuaterniusPrefabId): Partial<EnvironmentCover> {
  if (id === 'marketStand1' || id === 'marketStand2') {
    return { heightClass: 'waist', protection: 'partial', crouchSafe: true, blocksProjectiles: true, destructible: true, tags: ['cover', 'market', 'stall'] };
  }
  return {};
}

function kaykitCover(id: KaykitPrefabId): Partial<EnvironmentCover> {
  if (id === 'market') {
    return { heightClass: 'full', protection: 'full', crouchSafe: true, blocksProjectiles: true, destructible: false, tags: ['cover', 'market', 'building'] };
  }
  return {};
}

const XO_MARKET_PREFABS = (Object.entries(XO_MARKET_PATHS) as Array<[XoMarketPrefabId, string]>).map(([id, assetPath]) => defineEnvironmentPrefab({
  id,
  render: { assetPath, origin: 'bottom-center', materialMode: 'preserve' },
  collision: xoMarketCollision(id),
  navigation: xoMarketNavigation(id),
  cover: xoMarketCover(id),
  metadata: {
    source: 'authored-glb',
    license: 'CC0-1.0',
    sourceLabel: 'XO authored market structures',
    tags: ['authored', 'xo-authored', 'market', 'visual-only'],
    provenance: {
      author: 'XO Beta original authoring pipeline',
      sourceReference: 'docs/REBUILD_ROOT_CAUSE_MATRIX.md#ashara-market',
      reviewed: true,
    },
  },
}));

const FACILITY_PREFABS = (Object.entries(PATHS) as Array<[FacilityPrefabId, string]>).map(([id, assetPath]) => defineEnvironmentPrefab({
  id,
  render: { assetPath, origin: 'preserve' },
  collision: facilityCollision(id),
  navigation: facilityNavigation(id),
  cover: facilityCover(id),
  metadata: {
    source: 'authored-glb',
    license: 'CC0-1.0',
    sourceLabel: 'Jaron Bragg ModKit v1.2',
    tags: ['modular', 'facility', 'visual-only'],
    provenance: {
      author: 'Jaron Bragg',
      sourceReference: 'Jaron Bragg ModKit v1.2; see docs/ASSET_MANIFEST.md',
      reviewed: true,
    },
  },
}));

const POLYHAVEN_PREFABS = (Object.entries(POLYHAVEN_PATHS) as Array<[PolyhavenPrefabId, string]>).map(([id, assetPath]) => defineEnvironmentPrefab({
  id,
  render: {
    assetPath,
    origin: id === 'fort' || id === 'urbanFacade' || id === 'fireEscape' || id === 'factoryFacade' ? 'preserve' : 'bottom-center',
    materialMode: 'preserve',
  },
  collision: polyhavenCollision(id),
  navigation: prefabNavigation(id),
  cover: polyhavenCover(id),
  metadata: {
    source: 'authored-glb',
    license: 'CC0-1.0',
    sourceLabel: 'Poly Haven',
    tags: ['authored', 'polyhaven', 'visual-only'],
    provenance: {
      author: id === 'fireEscape'
        ? 'Juniix'
        : id === 'fort'
          ? 'Rico Cilliers'
          : id === 'plasticCrate'
            ? 'Pacific Penguin'
              : id === 'wickerBasket'
                ? 'Kuutti Siitonen'
                : id === 'woodenTable'
                  ? 'Serhii Khromov'
                  : id === 'ceramicPot'
                    ? 'Aron Łyczek'
                    : id === 'ceramicVase'
                      ? 'James Ray Cock'
                      : id === 'brassLantern'
                        ? 'Bhargav Kubal'
                        : 'James Ray Cock',
      sourceReference: id === 'fireEscape'
        ? 'https://polyhaven.com/a/modular_fire_escape'
        : id === 'urbanFacade'
          ? 'https://polyhaven.com/a/modular_urban_apartments_facade'
          : id === 'fort'
            ? 'https://polyhaven.com/a/modular_fort_01'
            : id === 'plasticCrate'
              ? 'https://polyhaven.com/a/plastic_crate_03'
              : id === 'wickerBasket'
                ? 'https://polyhaven.com/a/wicker_basket_01'
                : id === 'woodenTable'
                  ? 'https://polyhaven.com/a/wooden_table_02'
                  : id === 'ceramicPot'
                    ? 'https://polyhaven.com/a/ceramic_pot'
                    : id === 'ceramicVase'
                      ? 'https://polyhaven.com/a/ceramic_vase_04'
                      : id === 'brassLantern'
                        ? 'https://polyhaven.com/a/brass_diya_lantern'
                        : 'https://polyhaven.com/a/modular_factory_facade',
      reviewed: true,
    },
  },
}));

const QUATERNIUS_PREFABS = (Object.entries(QUATERNIUS_PATHS) as Array<[QuaterniusPrefabId, string]>).map(([id, assetPath]) => defineEnvironmentPrefab({
  id,
  render: { assetPath, origin: 'bottom-center', materialMode: 'node-standard' },
  collision: quaterniusCollision(id),
  navigation: prefabNavigation(id),
  cover: quaterniusCover(id),
  metadata: {
    source: 'authored-glb',
    license: 'CC0-1.0',
    sourceLabel: 'Quaternius Medieval Village Pack',
    tags: ['authored', 'quaternius', 'visual-only', 'market'],
    provenance: {
      author: 'Quaternius',
      sourceReference: 'https://quaternius.com/packs/medievalvillage.html; https://opengameart.org/content/lowpoly-medieval-village-pack',
      reviewed: true,
    },
  },
}));

const KAYKIT_PREFABS = (Object.entries(KAYKIT_PATHS) as Array<[KaykitPrefabId, string]>).map(([id, assetPath]) => defineEnvironmentPrefab({
  id,
  render: { assetPath, origin: 'bottom-center', materialMode: 'preserve' },
  collision: kaykitCollision(id),
  navigation: prefabNavigation(id),
  cover: kaykitCover(id),
  metadata: {
    source: 'authored-glb',
    license: 'CC0-1.0',
    sourceLabel: 'KayKit Medieval Hexagon Pack 1.0',
    tags: ['authored', 'kaykit', 'market', 'visual-only'],
    provenance: {
      author: 'Kay Lousberg',
      sourceReference: 'KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0@84fa4e91af6a88989be7c99e0891cede11f2ca38; addons/kaykit_medieval_hexagon_pack/Assets/fbx(unity)/buildings/red/building_market_red.fbx',
      reviewed: true,
    },
  },
}));

const KIT = defineEnvironmentKit({
  id: 'xo-beta-modular-facility',
  version: '2026.09.26',
  prefabs: [...FACILITY_PREFABS, ...POLYHAVEN_PREFABS],
});

const EDEN_KIT = defineEnvironmentKit({
  id: 'xo-beta-eden-wetland-slice',
  version: '2026.09.26',
  prefabs: FACILITY_PREFABS,
});

const OLD_FRONT_KIT = defineEnvironmentKit({
  id: 'xo-beta-old-front-fortified-kit',
  version: '2026.09.26',
  prefabs: [...FACILITY_PREFABS, ...POLYHAVEN_PREFABS],
});

const ASHARA_KIT = defineEnvironmentKit({
  id: 'xo-beta-ashara-settlement-kit',
  version: '2026.09.26',
  prefabs: [...FACILITY_PREFABS, ...POLYHAVEN_PREFABS, ...QUATERNIUS_PREFABS, ...KAYKIT_PREFABS, ...XO_MARKET_PREFABS],
});

function transform(
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
) {
  return {
    position,
    rotation: { pitch: rotation[0], yaw: rotation[1], roll: rotation[2] },
    scale,
  };
}

function instance(
  id: string,
  prefabId: PrefabId,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
  tags: readonly string[] = ['visual-only'],
  renderVisible = true,
): EnvironmentPrefabInstanceInput {
  return {
    id,
    prefabId,
    transform: transform(position, rotation, scale),
    renderVisible,
    tags: prefabCollision(prefabId) ? [...tags, 'collision-bridge'] : tags,
  };
}

function groundAt(terrainHeight: ((x: number, z: number) => number) | undefined, x: number, z: number): number {
  return terrainHeight?.(x, z) ?? 0;
}

export function environmentPlanAssetPaths(plan: EnvironmentPlan | undefined): string[] {
  if (!plan) return [];
  return [...new Set(resolveEnvironmentPlan(plan)
    .filter(({ renderVisible }) => renderVisible)
    .map(({ render }) => render.assetPath))].sort();
}

export function environmentCollisionGeo(plan: EnvironmentPlan): GeoBox[] {
  const boxes: GeoBox[] = [];
  const instanceTags = new Map(plan.instances.map((item) => [item.id, item.tags]));
  for (const resolved of resolveEnvironmentPlan(plan)) {
    if (!instanceTags.get(resolved.instanceId)?.includes('collision-bridge') || resolved.collision.mode !== 'static') continue;
    const [scaleX, scaleY, scaleZ] = resolved.transform.scale;
    for (const proxy of resolved.collision.proxies) {
      if (proxy.kind !== 'box') continue;
      const center = transformEnvironmentPoint(proxy.center, resolved.transform);
      boxes.push({
        kind: 'box',
        x: center[0],
        y: center[1],
        z: center[2],
        sx: proxy.halfExtents[0] * 2 * Math.abs(scaleX),
        sy: proxy.halfExtents[1] * 2 * Math.abs(scaleY),
        sz: proxy.halfExtents[2] * 2 * Math.abs(scaleZ),
        yaw: resolved.transform.rotation.yaw,
        pitch: resolved.transform.rotation.pitch,
        roll: resolved.transform.rotation.roll,
        mat: resolved.prefabId === 'barrelDented' ? 'metal' : resolved.prefabId === 'rubblePile' ? 'rock' : resolved.prefabId === 'market' || resolved.prefabId === 'kaykitMarket' || resolved.prefabId === 'marketHall' ? 'mudbrick' : 'wood',
        noRender: true,
      });
    }
  }
  return boxes;
}

function authoredLevelBase(
  terrainHeight: ((x: number, z: number) => number) | undefined,
  x: number,
  z: number,
  width: number,
  depth: number,
): number {
  if (!terrainHeight) return 0.12;
  const halfWidth = width / 2 + 0.4;
  const halfDepth = depth / 2 + 0.4;
  let highest = -Infinity;
  for (let iz = 0; iz <= 8; iz++) {
    for (let ix = 0; ix <= 8; ix++) {
      highest = Math.max(
        highest,
        terrainHeight(x - halfWidth + (2 * halfWidth * ix) / 8, z - halfDepth + (2 * halfDepth * iz) / 8),
      );
    }
  }
  return highest + 0.12;
}

export const EDEN_LAB_LAYOUT = {
  centerX: -95,
  centerZ: -30,
  width: 34,
  depth: 24,
  floorHeight: 4.2,
} as const;

export const EDEN_LAB_DOORS: ReadonlyArray<{
  side: 0 | 1 | 2 | 3;
  offset: number;
  width: number;
  x: number;
  z: number;
}> = [
  { side: 0, offset: 10, width: 2.8, x: -100.6, z: -18 },
  { side: 0, offset: 24, width: 2.8, x: -86.6, z: -18 },
  { side: 2, offset: 17, width: 2.8, x: -93.6, z: -42 },
  { side: 1, offset: 9, width: 2.8, x: -78, z: -31.6 },
  { side: 3, offset: 9, width: 2.8, x: -112, z: -31.6 },
];

function addEdenResearchLab(
  instances: EnvironmentPrefabInstanceInput[],
  terrainHeight?: (x: number, z: number) => number,
): void {
  const { centerX, centerZ, width, depth, floorHeight } = EDEN_LAB_LAYOUT;
  const baseY = authoredLevelBase(terrainHeight, centerX, centerZ, width, depth);
  const add = (
    suffix: string,
    id: PrefabId,
    x: number,
    y: number,
    z: number,
    yaw = 0,
    scale: readonly [number, number, number] = [1, 1, 1],
  ) => {
    instances.push(instance(
      `eden-research-lab-${suffix}`,
      id,
      [x, y, z],
      [0, yaw, 0],
      scale,
      ['visual-only', 'authored-lab', 'biome:wetland'],
    ));
  };
  const addRun = (
    prefix: string,
    axis: 'x' | 'z',
    fixed: number,
    start: number,
    length: number,
    y: number,
    reverse: boolean,
    kind: 'wall' | 'parapet',
    openings: readonly number[] = [],
  ) => {
    const segmentLength = 4;
    const placeRange = (rangePrefix: string, from: number, to: number): void => {
      const rangeLength = to - from;
      if (rangeLength <= 0.001) return;
      const count = Math.ceil(rangeLength / segmentLength);
      for (let index = 0; index < count; index++) {
        const currentLength = Math.min(segmentLength, rangeLength - index * segmentLength);
        const segmentCenter = from + index * currentLength + currentLength / 2;
        const yaw = axis === 'x' ? (reverse ? Math.PI : 0) : (reverse ? Math.PI / 2 : -Math.PI / 2);
        const variant = Math.abs(Math.round(segmentCenter)) % 7;
        const id: FacilityPrefabId = kind === 'parapet'
          ? 'parapet'
          : variant === 0
            ? 'wallReinforced'
            : 'wallWindow';
        const lengthScale = currentLength / segmentLength;
        const scale: readonly [number, number, number] = axis === 'x'
          ? [kind === 'parapet' ? lengthScale * 0.9 : lengthScale, 1, 1]
          : [kind === 'parapet' ? lengthScale * 0.9 : lengthScale, 1, 1];
        add(
          `${rangePrefix}-${index}`,
          id,
          axis === 'x' ? segmentCenter : fixed,
          y,
          axis === 'x' ? fixed : segmentCenter,
          yaw,
          scale,
        );
      }
    };
    if (kind === 'wall' && openings.length > 0) {
      const sortedOpenings = [...openings].sort((a, b) => a - b);
      let cursor = start;
      sortedOpenings.forEach((opening, index) => {
        const doorwayStart = opening - segmentLength / 2;
        placeRange(`${prefix}-before-${index}`, cursor, doorwayStart);
        add(
          `${prefix}-door-${index}`,
          'wallDoorway',
          axis === 'x' ? opening : fixed,
          y,
          axis === 'x' ? fixed : opening,
          axis === 'x' ? (reverse ? Math.PI : 0) : (reverse ? Math.PI / 2 : -Math.PI / 2),
          [1, 1, 1],
        );
        cursor = opening + segmentLength / 2;
      });
      placeRange(`${prefix}-after`, cursor, start + length);
      return;
    }
    placeRange(prefix, start, start + length);
  };
  const addDoor = (suffix: string, x: number, z: number, yaw: number) => {
    add(`${suffix}-frame`, 'doorframe', x, baseY + 0.04, z, yaw);
    const sideOpening = Math.abs(Math.abs(yaw) - Math.PI / 2) < 0.01;
    const panelX = sideOpening ? x : x + 1.08;
    const panelZ = sideOpening ? z + 1.08 : z;
    add(`${suffix}-panel`, 'doorPanel', panelX, baseY + 0.08, panelZ, yaw + Math.PI / 2, [0.92, 1, 1]);
  };
  const doorFor = (side: 0 | 1 | 2 | 3, index = 0) => EDEN_LAB_DOORS.filter((entry) => entry.side === side)[index]!;
  const left = centerX - width / 2;
  const right = centerX + width / 2;
  const back = centerZ - depth / 2;
  const front = centerZ + depth / 2;
  for (let floor = 0; floor < 2; floor++) {
    const levelY = baseY + floor * floorHeight;
    addRun(`front-wall-${floor}`, 'x', front, left, width, levelY, false, 'wall', [doorFor(0, 0).x, doorFor(0, 1).x]);
    addRun(`back-wall-${floor}`, 'x', back, left, width, levelY, true, 'wall', [doorFor(2).x]);
    addRun(`left-wall-${floor}`, 'z', left, back, depth, levelY, false, 'wall', [doorFor(3).z]);
    addRun(`right-wall-${floor}`, 'z', right, back, depth, levelY, true, 'wall', [doorFor(1).z]);
    for (const x of [left + 0.45, centerX, right - 0.45]) {
      add(`front-column-${floor}-${x}`, 'supportColumn', x, levelY, front - 0.1, 0, [1, 1.4, 1]);
      add(`back-column-${floor}-${x}`, 'supportColumn', x, levelY, back + 0.1, Math.PI, [1, 1.4, 1]);
    }
    for (const z of [back + 0.45, centerZ, front - 0.45]) {
      add(`left-column-${floor}-${z}`, 'supportColumn', left + 0.1, levelY, z, Math.PI / 2, [1, 1.4, 1]);
      add(`right-column-${floor}-${z}`, 'supportColumn', right - 0.1, levelY, z, -Math.PI / 2, [1, 1.4, 1]);
    }
  }
  for (let floor = 0; floor < 2; floor++) {
    const levelY = baseY + floor * floorHeight + 0.04;
    for (let ix = 0; ix < 8; ix++) {
      for (let iz = 0; iz < 6; iz++) {
        add(`floor-${floor}-${ix}-${iz}`, floor === 0 ? 'floor' : 'ceiling', left + ix * 4 + 2, levelY, back + iz * 4 + 2);
      }
    }
    add(`hatch-${floor}`, 'floorHatch', centerX - 4.2, levelY + 0.08, centerZ + 1.4, 0, [0.9, 0.9, 0.9]);
  }
  const apronY = baseY + 0.01;
  for (let ix = -1; ix <= 8; ix++) {
    add(`apron-front-${ix}`, 'floor', left + ix * 4 + 2, apronY, front + 2, 0, [0.92, 0.5, 0.92]);
    add(`apron-back-${ix}`, 'floor', left + ix * 4 + 2, apronY, back - 2, 0, [0.92, 0.5, 0.92]);
  }
  for (let iz = -1; iz <= 6; iz++) {
    add(`apron-left-${iz}`, 'floor', left - 2, apronY, back + iz * 4 + 2, 0, [0.92, 0.5, 0.92]);
    add(`apron-right-${iz}`, 'floor', right + 2, apronY, back + iz * 4 + 2, 0, [0.92, 0.5, 0.92]);
  }
  const interiorY = baseY + 0.08;
  add('interior-crate-stack-west', 'crateStack', left + 3.2, interiorY, back + 3.1, 0.12);
  add('interior-crate-west', 'crate', left + 4.4, interiorY, back + 4.1, -0.18);
  add('interior-barrel-west-a', 'barrelDented', left + 5.2, interiorY, back + 3.5, 0.1);
  add('interior-barrel-west-b', 'barrelDented', left + 5.2, interiorY, back + 4.4, -0.12);
  add('interior-crate-stack-east', 'crateStack', right - 3.2, interiorY, back + 3.2, -0.16);
  add('interior-barrel-east', 'barrelDented', right - 4.3, interiorY, back + 4.2, 0.18);
  add('interior-vent-back', 'ventWall', centerX, baseY + 2.15, back + 0.18, 0, [1.05, 1.05, 1.05]);
  add('interior-pipe-back', 'pipe', centerX + 5.4, baseY + 2.35, back + 0.22, Math.PI / 2, [1.15, 1.15, 1.15]);
  add('interior-railing-west', 'railing', left + 7.2, baseY + 0.16, centerZ + 2.2, Math.PI / 2, [1, 1, 1]);
  add('interior-rubble-east', 'rubblePile', right - 5.2, interiorY, front - 4.2, 0.26);
  add('interior-debris-west', 'debrisScatter', left + 6.3, interiorY, front - 3.6, -0.22);
  addDoor('front-west', doorFor(0, 0).x, doorFor(0, 0).z, 0);
  addDoor('front-east', doorFor(0, 1).x, doorFor(0, 1).z, 0);
  addDoor('back', doorFor(2).x, doorFor(2).z, Math.PI);
  addDoor('right', doorFor(1).x, doorFor(1).z, Math.PI / 2);
  addDoor('left', doorFor(3).x, doorFor(3).z, -Math.PI / 2);
  const roofY = baseY + floorHeight * 2 + 0.12;
  for (let ix = 0; ix < 8; ix++) {
    for (let iz = 0; iz < 6; iz++) {
      add(`roof-${ix}-${iz}`, 'roofFlat', left + ix * 4 + 2, roofY, back + iz * 4 + 2, 0, [1, 1, 1]);
    }
  }
  addRun('roof-front-parapet', 'x', front, left, width, roofY + 0.15, false, 'parapet');
  addRun('roof-back-parapet', 'x', back, left, width, roofY + 0.15, true, 'parapet');
  addRun('roof-left-parapet', 'z', left, back, depth, roofY + 0.15, true, 'parapet');
  addRun('roof-right-parapet', 'z', right, back, depth, roofY + 0.15, false, 'parapet');
  add('front-vent-west', 'ventWall', -107, baseY + 2.1, front - 0.12, 0, [1.15, 1.15, 1.15]);
  add('front-vent-east', 'ventWall', -82, baseY + 2.1, front - 0.12, 0, [1.15, 1.15, 1.15]);
  add('right-vent', 'ventWall', right - 0.12, baseY + 2.1, -26, -Math.PI / 2, [1.15, 1.15, 1.15]);
  add('roof-vent', 'ventWall', -101, roofY + 0.45, -27, 0, [1.4, 1.4, 1.4]);
  add('front-pipe', 'pipe', -105, baseY + 2.25, front - 0.2, 0, [1.1, 1.1, 1.1]);
  add('right-pipe', 'pipe', right - 0.2, baseY + 2.25, -27, Math.PI / 2, [1.1, 1.1, 1.1]);
  add('roof-pipe', 'pipe', -94, roofY + 0.65, -35, 0, [1.3, 1.3, 1.3]);
  add('roof-rubble', 'rubblePile', -88, roofY + 0.05, -25, 0.2);
  add('roof-debris', 'debrisScatter', -105, roofY + 0.06, -35, -0.18);
}

function addEdenBay(
  instances: EnvironmentPrefabInstanceInput[],
  prefix: string,
  cx: number,
  cz: number,
  y: number,
  wallOffset = -2,
): void {
  const add = (id: PrefabId, x: number, z: number, dy = 0, yaw = 0, pitch = 0, roll = 0, scale = 1) => {
    instances.push(instance(`${prefix}-${instances.length}`, id, [x, y + dy, z], [pitch, yaw, roll], [scale, scale, scale]));
  };
  add('wallWindow', cx + wallOffset, cz - 2);
  add('wallDoorway', cx + 2, cz - 2);
  add('wallReinforced', cx - 2, cz + 2);
  add('wallCorner', cx - 4, cz + 2, 0, Math.PI);
  add('wallReinforced', cx + 4, cz, 0, Math.PI / 2);
  add('wallDamaged', cx - 4.05, cz - 1.4, 0, Math.PI / 2, 0, 0, 0.75);
  add('floor', cx, cz, 0.04);
  add('floorHatch', cx + 0.6, cz - 0.4, 0.12, 0, 0, 0.08, 0.82);
  add('ceiling', cx, cz, 2.76);
  add('roofFlat', cx, cz, 2.78);
  add('roofTrim', cx, cz, 2.96);
  add('beam', cx, cz, 2.62);
  for (const x of [cx - 3.6, cx + 3.6]) {
    for (const z of [cz - 3.6, cz + 3.6]) add('supportColumn', x, z);
  }
  add('doorframe', cx + 2, cz - 2.3);
  add('doorPanel', cx + 2, cz - 2.36, 1.1, 0, 0, 0.08, 0.92);
  add('ventWall', cx - 3.9, cz - 1.8, 1.65, 0, 0, 0, 1.05);
  add('pipe', cx - 1.2, cz - 2.35, 1.45, 0, 0, Math.PI / 2, 1.05);
  add('railing', cx, cz - 4.2, 0.12);
}

function addEdenWetlandGreenhouseCourt(
  instances: EnvironmentPrefabInstanceInput[],
  terrainHeight?: (x: number, z: number) => number,
): void {
  const add = (
    suffix: string,
    id: PrefabId,
    x: number,
    z: number,
    dy = 0,
    yaw = 0,
    pitch = 0,
    roll = 0,
    scale = 1,
  ) => {
    const y = groundAt(terrainHeight, x, z) + dy;
    instances.push(instance(
      `eden-wetland-greenhouse-${suffix}`,
      id,
      [x, y, z],
      [pitch, yaw, roll],
      [scale, scale, scale],
      ['visual-only', 'biome:wetland', 'slice:greenhouse'],
    ));
  };
  add('01-wall-window', 'wallWindow', 7, 27, 0, Math.PI / 2);
  add('02-entry-door', 'wallDoorway', 13, 27);
  add('03-wall-reinforced', 'wallReinforced', 7, 33);
  add('04-wall-corner', 'wallCorner', 4, 33, 0, Math.PI);
  add('05-wall-damaged', 'wallDamaged', 4.05, 29, 0, Math.PI / 2, 0, 0, 0.75);
  add('06-floor', 'floor', 10, 30, 0.04);
  add('07-floor-hatch', 'floorHatch', 10.6, 29.6, 0.12, 0, 0, 0.08, 0.82);
  add('08-ceiling', 'ceiling', 10, 30, 3.02);
  add('09-roof', 'roofFlat', 10, 30, 3.08);
  add('10-roof-trim', 'roofTrim', 10, 30, 3.26);
  add('11-beam', 'beam', 10, 30, 2.78);
  for (const [suffix, x, z] of [
    ['12-column-a', 6.4, 26.4],
    ['13-column-b', 13.6, 26.4],
    ['14-column-c', 6.4, 33.6],
    ['15-column-d', 13.6, 33.6],
  ] as const) add(suffix, 'supportColumn', x, z);
  add('16-doorframe', 'doorframe', 13, 26.7);
  add('17-door-panel', 'doorPanel', 13, 26.66, 1.1, 0, 0, 0.08, 0.92);
  add('18-vent-wall', 'ventWall', 6.1, 28.4, 1.65, 0, 0, 0, 1.05);
  add('19-pipe-run', 'pipe', 10, 27.65, 1.45, 0, 0, Math.PI / 2, 1.15);
  add('20-railing', 'railing', 10, 25.8, 0.12);
  add('21-crate-stack', 'crateStack', 15.8, 28.4, 0, 0.18, 0, 0, 0.92);
  add('22-crate', 'crate', 16.5, 31.2, 0, -0.22, 0, 0, 0.86);
  add('23-crate-broken', 'crateBroken', 7.3, 34, 0.1, -0.42, 0, 0.08, 0.8);
  add('24-rubble', 'rubblePile', 15, 34, 0, 0.2);
  add('25-debris', 'debrisScatter', 6, 35, 0.05, 0.1);
  add('26-barrel', 'barrelDented', 4.8, 28, 0, 0.4);
  add('27-stairs', 'stairs', 16.2, 30, 0, Math.PI / 2);
  add('28-landing-railing', 'railing', 16.2, 27.6, 0.12, Math.PI / 2);
}

function createEdenPlan(terrainHeight?: (x: number, z: number) => number): EnvironmentPlan {
  const instances: EnvironmentPrefabInstanceInput[] = [];
  const serviceY = groundAt(terrainHeight, -18, 24);
  const add = (id: PrefabId, x: number, z: number, y = serviceY, yaw = 0, pitch = 0, roll = 0, scale = 1) => {
    instances.push(instance(`eden-service-${instances.length}`, id, [x, y, z], [pitch, yaw, roll], [scale, scale, scale]));
  };
  add('wallWindow', -20, 24);
  add('wallDoorway', -16, 24);
  add('wallReinforced', -24, 24, serviceY, Math.PI / 2);
  add('wallCorner', -12, 24, serviceY, Math.PI);
  add('wallDamaged', -24.1, 28, serviceY, Math.PI / 2);
  add('floor', -18, 24, serviceY + 0.04);
  add('floorHatch', -18.4, 24.1, serviceY + 0.12, 0, 0, 0.08, 0.9);
  add('ceiling', -18, 24, serviceY + 3.02);
  add('roofFlat', -18, 24, serviceY + 3.06);
  add('roofTrim', -18, 24, serviceY + 3.22);
  add('parapet', -18, 28, serviceY + 3.2, 0, 0, 0, 1.1);
  add('beam', -18, 24, serviceY + 2.75);
  add('supportColumn', -21.7, 21.2, serviceY);
  add('supportColumn', -14.3, 21.2, serviceY);
  add('doorframe', -16, 23.7, serviceY);
  add('doorPanel', -16, 23.66, serviceY + 1.1, 0, 0, 0.08, 0.92);
  add('ventWall', -21.9, 23.55, serviceY + 1.65, 0, 0, 0, 1.1);
  add('stairs', -11.2, 23.5, serviceY, Math.PI / 2);
  add('railing', -11.2, 20.7, serviceY + 0.12, Math.PI / 2);
  add('pipe', -18, 23.65, serviceY + 1.45, 0, 0, Math.PI / 2, 1.15);
  add('crateStack', -22.1, 22.8, serviceY, 0.18);
  add('crateBroken', -21.2, 26.4, serviceY + 0.1, -0.42, 0, 0.08, 0.8);
  add('rubblePile', -14.2, 27.2, serviceY, 0.2);
  add('debrisScatter', -20.8, 27.4, serviceY + 0.05, -0.16);
  add('barrelDented', -24, 24.2, serviceY, 0.12);
  addEdenResearchLab(instances, terrainHeight);
  addEdenBay(instances, 'eden-dock', 112, 38, groundAt(terrainHeight, 112, 38), -4);
  instances.push(instance('eden-dock-crates', 'crateStack', [116, groundAt(terrainHeight, 116, 34.5), 34.5], [0, -0.2, 0]));
  instances.push(instance('eden-dock-barrel', 'barrelDented', [117, groundAt(terrainHeight, 117, 38.5), 38.5], [0, 0.4, 0]));
  instances.push(instance('eden-dock-rubble', 'rubblePile', [106, groundAt(terrainHeight, 106, 41), 41], [0, 0.2, 0]));
  addEdenWetlandGreenhouseCourt(instances, terrainHeight);
  addEdenBay(instances, 'eden-generator', -210, 40, groundAt(terrainHeight, -210, 40));
  instances.push(instance('eden-generator-crates', 'crateStack', [-207, groundAt(terrainHeight, -207, 35.2), 35.2], [0, 0.2, 0]));
  instances.push(instance('eden-generator-barrel', 'barrelDented', [-205.2, groundAt(terrainHeight, -205.2, 41.2), 41.2], [0, -0.3, 0]));
  instances.push(instance('eden-generator-pipe', 'pipe', [-208.5, groundAt(terrainHeight, -208.5, 35.5) + 1.5, 35.5], [0, 0, Math.PI / 2], [1.25, 1.25, 1.25]));
  return defineEnvironmentPlan(EDEN_KIT, instances);
}

function addMapCluster(
  instances: EnvironmentPrefabInstanceInput[],
  mapId: string,
  prefix: string,
  cx: number,
  cz: number,
  terrainHeight?: (x: number, z: number) => number,
): void {
  const y = groundAt(terrainHeight, cx, cz);
  const add = (id: PrefabId, x: number, z: number, dy = 0, yaw = 0, scale = 1) => {
    instances.push(instance(`${mapId}-${prefix}-${instances.length}`, id, [x, y + dy, z], [0, yaw, 0], [scale, scale, scale]));
  };
  add('wallWindow', cx - 2, cz - 2);
  add('wallDoorway', cx + 2, cz - 2);
  add('crateStack', cx + 3, cz + 1, 0, 0.2);
  add('barrelDented', cx - 3, cz + 1, 0, 0.4);
  add('pipe', cx + 1, cz + 2, 1.4, 0, 0.9);
  add('railing', cx, cz - 3, 0.1);
  if (mapId === 'neocity') {
    add('wallReinforced', cx + 4, cz, 0, Math.PI / 2);
    add('ventWall', cx - 3.8, cz - 1.6, 1.6);
  } else if (mapId === 'oldfront') {
    add('crateBroken', cx + 2, cz + 2, 0, -0.4);
    add('debrisScatter', cx - 1, cz + 2, 0, 0.2);
  } else {
    add('roofTrim', cx, cz, 3.1);
    add('rubblePile', cx - 2, cz + 2, 0, 0.2);
  }
}

function addAsharaMarketBuildings(
  instances: EnvironmentPrefabInstanceInput[],
  terrainHeight?: (x: number, z: number) => number,
): void {
  const tags = ['authored', 'desert', 'market', 'building', 'authored-material', 'biome:desert', 'site:sunwall-market'];
  instances.push(instance(
    'ashara-market-hall',
    'marketHall',
    [-40, groundAt(terrainHeight, -40, -31), -31],
    [0, -Math.PI / 2 + 0.06, 0],
    [0.95, 0.95, 0.95],
    tags,
  ));
}

function addAsharaMarketShopRow(
  instances: EnvironmentPrefabInstanceInput[],
  terrainHeight?: (x: number, z: number) => number,
): void {
  const tags = ['authored', 'desert', 'market', 'building', 'authored-material', 'collision-bridge', 'biome:desert', 'site:sunwall-market'];
  instances.push(instance(
    'ashara-market-shop-row',
    'shopRow',
    [-25, groundAt(terrainHeight, -25, -31), -31],
    [0, Math.PI / 2, 0],
    [1, 1, 1],
    tags,
  ));
}

function addAsharaMarketBackground(
  instances: EnvironmentPrefabInstanceInput[],
  terrainHeight?: (x: number, z: number) => number,
): void {
  const tags = ['visual-only', 'authored', 'desert', 'market', 'building', 'authored-material', 'biome:desert', 'site:sunwall-market'];
  const add = (suffix: string, prefabId: KaykitPrefabId, x: number, z: number, yaw: number, scale: number): void => {
    instances.push(instance(
      `ashara-market-${suffix}`,
      prefabId,
      [x, groundAt(terrainHeight, x, z), z],
      [0, yaw, 0],
      [scale, scale, scale],
      tags,
    ));
  };
  // A varied, human-scale edge frames the authored hall without letting
  // background modules become the dominant mass. Positions are deliberately
  // kept off the x=-34 market lane and its fixed QA sightlines.
  add('background-home-west', 'homeA', -49, -31, 0.1, 1.8);
  add('background-home-east', 'homeB', -19, -45, -0.24, 1.6);
  add('background-tavern-west', 'tavern', -44, -38, 0.08, 1.7);
  add('background-tower-east', 'towerA', -12, -45, -0.1, 1.6);
}

function addAsharaMarketCargo(
  instances: EnvironmentPrefabInstanceInput[],
  terrainHeight?: (x: number, z: number) => number,
): void {
  const tags = ['authored', 'desert', 'market', 'cargo', 'authored-material', 'biome:desert', 'site:sunwall-market'];
  const add = (
    suffix: string,
    prefabId: PolyhavenPrefabId,
    x: number,
    z: number,
    yaw: number,
    scale = 1,
  ): void => {
    const y = groundAt(terrainHeight, x, z);
    instances.push(instance(
      `ashara-market-${suffix}`,
      prefabId,
      [x, y, z],
      [0, yaw, 0],
      [scale, scale, scale],
      tags,
    ));
  };

  add('table-west', 'woodenTable', -46.5, -32.5, 0.04);
  add('table-east', 'woodenTable', -32.0, -32.5, -0.07);
  add('table-north', 'woodenTable', -40, -22.0, Math.PI / 2 + 0.03);
  add('crate-west', 'woodenCrate', -47, -28.5, 0.12);
  add('crate-east', 'woodenCrate', -30.5, -28.5, -0.16);
  add('crate-north', 'woodenCrate', -40, -20.5, Math.PI / 2 + 0.08);
  add('produce-west', 'wickerBasket', -45.5, -24.5, 0.2);
  add('produce-east', 'wickerBasket', -32.0, -24.5, -0.18);
  add('produce-north', 'wickerBasket', -37.5, -27.0, Math.PI / 2);
  // Wooden, not the saturated blue plastic crate: the desert market palette
  // is mudbrick/plaster/terracotta/sand, and a bright blue crate read as a
  // placeholder prop against it.
  add('stack-west', 'woodenCrate', -48.2, -24.0, 0.08, 0.9);
  add('stack-east', 'woodenCrate', -29.5, -24.0, -0.1, 0.9);
}

function addAsharaMarketWalls(
  instances: EnvironmentPrefabInstanceInput[],
  terrainHeight?: (x: number, z: number) => number,
): void {
  const tags = ['authored', 'desert', 'market', 'enclosure', 'authored-material', 'biome:desert', 'site:sunwall-market'];
  const add = (suffix: string, prefabId: QuaterniusPrefabId, x: number, z: number, yaw: number): void => {
    instances.push(instance(
      `ashara-enclosure-${suffix}`,
      prefabId,
      [x, groundAt(terrainHeight, x, z), z],
      [0, yaw, 0],
      [1.04, 1, 1.04],
      tags,
    ));
  };
  // Keep only the distant gate/threshold as a market landmark. The former
  // shoulder panels were flat node-standard cards that blocked the authored
  // hall and read as cardboard at normal FOV; the hall now provides the
  // enclosure and its own collision shell.
  add('gate', 'wallArch', -34, -44, 0);
  add('threshold-west', 'wallPlasterStraight', -40, -43, 0);
  add('threshold-east', 'wallBrickStraight', -28, -43, 0);
}

function addAsharaMarketProps(
  instances: EnvironmentPrefabInstanceInput[],
  terrainHeight?: (x: number, z: number) => number,
): void {
  const tags = ['visual-only', 'authored', 'desert', 'market', 'prop', 'authored-material', 'biome:desert', 'site:sunwall-market'];
  const add = (
    suffix: string,
    prefabId: PolyhavenPrefabId,
    x: number,
    z: number,
    dy: number,
    yaw: number,
    scale = 1,
  ): void => {
    instances.push(instance(
      `ashara-market-${suffix}`,
      prefabId,
      [x, groundAt(terrainHeight, x, z) + dy, z],
      [0, yaw, 0],
      [scale, scale, scale],
      tags,
    ));
  };

  // Small authored goods break the empty foreground and give the market a
  // readable human scale without introducing another primitive-built stall.
  add('pot-west', 'ceramicPot', -46.0, -31.8, 0, 0.18);
  add('pot-east', 'ceramicPot', -31.5, -31.8, 0, -0.22);
  add('pot-north', 'ceramicPot', -38.0, -23.0, 0, Math.PI + 0.12);
  add('vase-west', 'ceramicVase', -48.0, -32.2, 0, 0.08, 0.9);
  add('vase-east', 'ceramicVase', -30.0, -32.2, 0, -0.1, 0.9);
  add('vase-north', 'ceramicVase', -40.0, -21.8, 0, Math.PI / 2 + 0.03, 0.9);
  add('lantern-west', 'brassLantern', -45.0, -32.4, 0, 0.08, 1.15);
  add('lantern-east', 'brassLantern', -32.0, -32.4, 0, -0.1, 1.15);
  add('lantern-north', 'brassLantern', -40.0, -22.8, 0, Math.PI / 2 + 0.03, 1.15);
}

function addAsharaMarketApproach(
  instances: EnvironmentPrefabInstanceInput[],
  terrainHeight?: (x: number, z: number) => number,
): void {
  const tags = ['authored', 'desert', 'market', 'approach', 'authored-material', 'biome:desert', 'site:sunwall-market'];
  const add = (
    suffix: string,
    prefabId: QuaterniusPrefabId | PolyhavenPrefabId,
    x: number,
    z: number,
    yaw: number,
    scale = 1,
  ): void => {
    instances.push(instance(
      `ashara-approach-${suffix}`,
      prefabId,
      [x, groundAt(terrainHeight, x, z), z],
      [0, yaw, 0],
      [scale, scale, scale],
      tags,
    ));
  };

  // The market gate used to sit in an empty 30 m desert approach. These
  // authored stalls and cargo clusters create a readable street edge without
  // filling the central lane or replacing the market with primitive boxes.
  for (const [index, z] of [-10, -15, -20].entries()) {
    add(`stand-west-${index}`, index === 1 ? 'marketStand2' : 'marketStand1', -38.6, z, index % 2 === 0 ? 0 : Math.PI, 1.15);
    add(`stand-east-${index}`, index === 1 ? 'marketStand1' : 'marketStand2', -29.4, z, index % 2 === 0 ? Math.PI : 0, 1.15);
  }
  add('crate-west-near', 'woodenCrate', -37.4, -12.4, 0.12, 1.05);
  add('crate-east-near', 'woodenCrate', -30.6, -17.4, -0.16, 1.05);
  add('basket-west-far', 'wickerBasket', -37.2, -18.2, 0.2, 1.1);
  add('basket-east-far', 'wickerBasket', -30.8, -12.2, -0.2, 1.1);
}

function createGenericPlan(
  mapId: string,
  terrainHeight?: (x: number, z: number) => number,
): EnvironmentPlan {
  const sites: Record<string, Array<readonly [string, number, number]>> = {
    neocity: [['industrial', -160, 0], ['freight', 70, 205], ['server', 200, -60]],
    oldfront: [['town', 110, 30], ['checkpoint', -170, 60], ['farm', 150, 170]],
    ashara: [['works', 142, 32], ['compound', -158, 86]],
  };
  const instances: EnvironmentPrefabInstanceInput[] = [];
  if (mapId === 'neocity') {
    const approachFacadeY = groundAt(terrainHeight, -22, 45);
    instances.push(instance(
      'neocity-authored-urban-facade',
      'urbanFacade',
      [-22, approachFacadeY + 0.45, 45],
      [0, 0, 0],
      [0.6, 0.6, 0.6],
      ['visual-only', 'authored-material', 'biome:urban', 'site:spire-approach'],
    ));
    instances.push(instance(
      'neocity-authored-fire-escape-west',
      'fireEscape',
      [-31, groundAt(terrainHeight, -31, 39.2) + 0.64, 39.2],
      [0, 0, 0],
      [0.8, 0.8, 0.8],
      ['visual-only', 'authored-material', 'biome:urban', 'site:spire-approach'],
    ));
    instances.push(instance(
      'neocity-authored-fire-escape-east',
      'fireEscape',
      [-13, groundAt(terrainHeight, -13, 39.2) + 0.64, 39.2],
      [0, 0, 0],
      [0.8, 0.8, 0.8],
      ['visual-only', 'authored-material', 'biome:urban', 'site:spire-approach'],
    ));
    const industrialY = groundAt(terrainHeight, -160, -12);
    instances.push(instance(
      'neocity-authored-factory-facade',
      'factoryFacade',
      [-160, industrialY + 0.45, -12],
      [0, 0, 0],
      [0.62, 0.62, 0.62],
      ['visual-only', 'authored-material', 'biome:urban', 'site:industrial'],
    ));
  }
  if (mapId === 'oldfront') {
    const fortY = groundAt(terrainHeight, 170, 18);
    instances.push(instance(
      'oldfront-authored-fort-landmark',
      'fort',
      [170, fortY, 18],
      [0, -0.18, 0],
      [0.48, 0.48, 0.48],
      ['visual-only', 'authored-material', 'biome:temperate', 'site:settlement'],
    ));
  }
  if (mapId === 'ashara') {
  addAsharaMarketBuildings(instances, terrainHeight);
  addAsharaMarketShopRow(instances, terrainHeight);
  addAsharaMarketBackground(instances, terrainHeight);
      addAsharaMarketCargo(instances, terrainHeight);
      addAsharaMarketWalls(instances, terrainHeight);
      addAsharaMarketApproach(instances, terrainHeight);
      addAsharaMarketProps(instances, terrainHeight);
  }
  for (const [prefix, x, z] of sites[mapId] ?? []) addMapCluster(instances, mapId, prefix, x, z, terrainHeight);
  return defineEnvironmentPlan(mapId === 'oldfront' ? OLD_FRONT_KIT : mapId === 'ashara' ? ASHARA_KIT : KIT, instances);
}

export function createEnvironmentPlan(
  mapId: string,
  terrainHeight?: (x: number, z: number) => number,
): EnvironmentPlan {
  if (mapId === 'eden') return createEdenPlan(terrainHeight);
  return createGenericPlan(mapId, terrainHeight);
}
