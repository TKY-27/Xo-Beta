/** Shared world/map data types. Renderer-independent (usable headless). */

export type MatKey =
  | 'concrete' | 'concreteDark' | 'asphalt' | 'sidewalk' | 'metal' | 'metalDark'
  | 'rust' | 'wood' | 'woodDark' | 'stoneBrick' | 'plaster' | 'plasterOld'
  | 'glass' | 'grass' | 'dirt' | 'rock' | 'roofTile' | 'gold'
  | 'neonCyan' | 'neonMagenta' | 'neonOrange' | 'neonGreen' | 'neonBlue'
  | 'windowWarm'
  | 'facadeA' | 'facadeB' | 'facadeC' | 'marble' | 'sandbag'
  | 'corrugated' | 'bricksOld' | 'facilityFloor'
  | 'paint'
  | 'paving'
  | 'signDimCyan'
  | 'signDimMagenta'
  | 'signDimOrange';

export interface GeoBox {
  kind: 'box';
  x: number; y: number; z: number; // center
  sx: number; sy: number; sz: number; // full sizes
  yaw: number;
  mat: MatKey;
  /** Don't create a physics collider (pure decoration). */
  noCollide?: boolean;
  /** Collider/placement proxy that is intentionally hidden from rendering. */
  noRender?: boolean;
  materialHint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage';
}

export interface GeoCylinder {
  kind: 'cyl';
  x: number; y: number; z: number;
  r: number; h: number;
  mat: MatKey;
  segments?: number;
  noCollide?: boolean;
  noRender?: boolean;
  materialHint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage';
}

export interface GeoSphere {
  kind: 'sphere';
  x: number; y: number; z: number;
  r: number;
  mat: MatKey;
  noCollide?: boolean;
  noRender?: boolean;
  materialHint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage';
}

export type GeoSpec = GeoBox | GeoCylinder | GeoSphere;

/** Destructible prop instance (crates, glass, lamps...). */
export interface DestructibleSpec {
  geo: GeoSpec;
  hp: number;
  type: 'crate' | 'glass' | 'lamp' | 'fence' | 'furniture' | 'sign' | 'vegetation';
}

export interface VehicleSpec {
  x: number; z: number; y: number; yaw: number;
  variant: 'sedan' | 'van' | 'truck' | 'wrecked';
  color: number;
  explodable: boolean;
}

export interface TreeSpec {
  x: number; z: number; y: number;
  scale: number;
  variant: 'pine' | 'oak' | 'palm' | 'dead';
}

export interface RockSpec {
  x: number; z: number; y: number;
  scale: number;
}

export interface LampSpec {
  x: number; z: number; y: number; h: number;
  color: number;
  intensity: number;
  range: number;
}

export interface WaterVolume {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  surfaceY: number;
  depth: number;
}

export interface ChestSpawn {
  x: number; y: number; z: number;
  kind: 'standard' | 'elite' | 'vault';
}

export interface LootSpawn {
  x: number; y: number; z: number;
  /** Optional bias toward weapon/ammo/heal categories. */
  bias?: 'weapon' | 'ammo' | 'heal';
}

export interface Poi {
  name: string;
  x: number; z: number;
  radius: number;
}

export interface LightSpec {
  x: number; y: number; z: number;
  color: number;
  intensity: number;
  range: number;
}

export interface SkyGrade {
  vignette?: number;
  saturation?: number;
  contrast?: number;
  /** Shadow lift color (linear RGB offsets). */
  lift?: [number, number, number];
}

export interface SkyConfig {
  preset: 'night' | 'bluehour' | 'overcast' | 'day';
  /** Equirectangular HDRI file (public/assets/sky) used as background + IBL. */
  hdri?: string;
  fogColor: number;
  fogDensity: number;
  sunDirection: [number, number, number];
  sunColor: number;
  sunIntensity: number;
  ambientColor: number;
  ambientIntensity: number;
  hemisphereSky: number;
  hemisphereGround: number;
  hemisphereIntensity: number;
  exposure?: number;
  envIntensity?: number;
  backgroundBlurriness?: number;
  backgroundIntensity?: number;
  grade?: SkyGrade;
}

export interface MapDef {
  id: string;
  name: string;
  description: string;
  size: number;
  sky: SkyConfig;
  /** Terrain heightfield sampler (worldY at x,z); null = flat ground plane. */
  terrainHeight?: (x: number, z: number) => number;
  geo: GeoSpec[];
  destructibles: DestructibleSpec[];
  vehicles: VehicleSpec[];
  trees: TreeSpec[];
  rocks: RockSpec[];
  lamps: LampSpec[];
  lights: LightSpec[];
  water: WaterVolume[];
  chests: ChestSpawn[];
  loot: LootSpawn[];
  pois: Poi[];
  /** Walkable platform rects recorded during construction (for nav generation). */
  platforms: PlatformRect[];
  /** Suggested drop-route band across the map for the transport. */
  transportRoute: { from: [number, number]; to: [number, number] };
  /** Rain-slicked streets: ground materials get reflective wet treatment. */
  wetGround?: boolean;
}

export interface PlatformRect {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  y: number;
  water?: boolean;
}

/**
 * Human-scale normalization for the Kenney vehicle GLBs, which are authored
 * at toy scale (a sedan is only ~2.5 m long). Player eye height is 2.05 m,
 * so cars are scaled until a sedan reads ~3.8 m long and a truck ~5.6 m.
 * The render side scales the model; physics uses matching collider boxes.
 */
export const VEHICLE_SCALE: Record<string, number> = {
  sedan: 1.5,
  taxi: 1.5,
  police: 1.5,
  'hatchback-sports': 1.55,
  'race-future': 1.5,
  suv: 1.65,
  van: 1.65,
  'delivery-flat': 1.65,
  truck: 1.9,
};

/** Approximate collider half-extents (x/z) + height for a scaled vehicle. */
export function vehicleColliderBox(variant: string): { ex: number; ez: number; h: number; yawAligned: 'x' | 'z' } {
  switch (variant) {
    case 'truck':
      return { ex: 1.42, ez: 2.8, h: 2.6, yawAligned: 'z' };
    case 'van':
      return { ex: 1.25, ez: 2.27, h: 2.4, yawAligned: 'z' };
    case 'wrecked':
      return { ex: 1.2, ez: 2.2, h: 2.0, yawAligned: 'z' };
    default:
      return { ex: 1.12, ez: 1.92, h: 1.75, yawAligned: 'z' };
  }
}
