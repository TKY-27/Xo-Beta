/** Shared world/map data types. Renderer-independent (usable headless). */

export type MatKey =
  | 'concrete' | 'concreteDark' | 'asphalt' | 'sidewalk' | 'metal' | 'metalDark'
  | 'rust' | 'wood' | 'woodDark' | 'stoneBrick' | 'plaster' | 'plasterOld'
  | 'glass' | 'grass' | 'dirt' | 'rock' | 'roofTile' | 'gold'
  | 'neonCyan' | 'neonMagenta' | 'neonOrange' | 'neonGreen' | 'neonBlue'
  | 'facadeA' | 'facadeB' | 'facadeC' | 'marble' | 'sandbag';

export interface GeoBox {
  kind: 'box';
  x: number; y: number; z: number; // center
  sx: number; sy: number; sz: number; // full sizes
  yaw: number;
  mat: MatKey;
  /** Don't create a physics collider (pure decoration). */
  noCollide?: boolean;
  materialHint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage';
}

export interface GeoCylinder {
  kind: 'cyl';
  x: number; y: number; z: number;
  r: number; h: number;
  mat: MatKey;
  segments?: number;
  noCollide?: boolean;
  materialHint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage';
}

export interface GeoSphere {
  kind: 'sphere';
  x: number; y: number; z: number;
  r: number;
  mat: MatKey;
  noCollide?: boolean;
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

export interface SkyConfig {
  preset: 'night' | 'overcast' | 'day';
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
}

export interface PlatformRect {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  y: number;
  water?: boolean;
}
