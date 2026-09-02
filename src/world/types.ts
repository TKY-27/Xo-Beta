/** Shared world/map data types. Renderer-independent (usable headless). */

export type MatKey =
  | 'concrete' | 'concreteDark' | 'asphalt' | 'asphaltDesert' | 'sidewalk' | 'metal' | 'metalDark' | 'metalExterior'
  | 'rust' | 'wood' | 'woodDark' | 'stoneBrick' | 'plaster' | 'plasterOld'
  | 'glass' | 'grass' | 'dirt' | 'rock' | 'roofTile' | 'gold'
  | 'neonCyan' | 'neonMagenta' | 'neonOrange' | 'neonGreen' | 'neonBlue'
  | 'windowWarm' | 'windowCool' | 'windowDark'
  | 'facadeA' | 'facadeB' | 'facadeC' | 'marble' | 'sandbag' | 'hay'
  | 'corrugated' | 'bricksOld' | 'facilityFloor'
  | 'interiorCeiling'
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
  /** Optional visual rotations for non-colliding structural detail. */
  pitch?: number;
  roll?: number;
  mat: MatKey;
  /** Don't create a physics collider (pure decoration). */
  noCollide?: boolean;
  /** Collider/placement proxy that is intentionally hidden from rendering. */
  noRender?: boolean;
  /**
   * Invisible stair movement ramp aligned with the flight's nosing line.
   * Solid to movement/cameras/projectiles but excluded from standing-clearance
   * queries so nav and spawn checks reason about the visible treads.
   */
  stairRamp?: boolean;
  /**
   * Stair tread body: solid to cameras, projectiles and ray probes, but the
   * character controller rides the flight's stairRamp instead (CG.STEP).
   */
  stairTread?: boolean;
  /** Skip the static shadow pass for presentation-only detail. */
  castShadow?: boolean;
  /** Authored bridge/stair geometry that intentionally occupies a terrain opening. */
  preserveInTerrainCutout?: boolean;
  /** Finished flat world skin; QA terrain queries ignore ordinary floors/roofs. */
  terrain?: boolean;
  materialHint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage';
}

export interface GeoCylinder {
  kind: 'cyl';
  x: number; y: number; z: number;
  r: number; h: number;
  mat: MatKey;
  segments?: number;
  /** Optional presentation rotation for authored horizontal pipes/logs. */
  yaw?: number;
  pitch?: number;
  roll?: number;
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
  /** Stable map-scoped identity shared by physics, presentation and events. */
  stableId: string;
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
  /** Deterministic model variant shared by physics profiles and rendering. */
  variant: 'medium-1' | 'medium-2';
  /** Deterministic yaw (radians) shared by physics compound colliders and rendering. */
  yaw: number;
}

/**
 * Visual clearance radius for an authored rock at scale 1: the widest lobe of
 * either Quaternius rock variant after the render scale/tilt used by
 * WorldView (measured: 1.876 * 1.12 ≈ 2.10, rounded up with margin). Used to
 * keep placements out of the VISIBLE rock mass. Collider geometry itself is
 * the per-variant measured profile in ./rockProfiles.
 */
export const ROCK_CLEARANCE_RADIUS = 2.15;
/** Legacy physics-envelope height, kept only for visual clearance checks. */
export const ROCK_COLLIDER_HEIGHT = 2.4;

export interface LampSpec {
  x: number; z: number; y: number; h: number;
  color: number;
  intensity: number;
  range: number;
}

/** Presentation-only water profile. These fields never affect simulation. */
export type WaterVisualKind = 'lake' | 'river' | 'pond' | 'fallback';

export interface WaterVisualProfile {
  kind: WaterVisualKind;
  /** Optional world-space wind direction used only by the water shader. */
  windDirection?: readonly [number, number];
  /** Optional deterministic seed for cosmetic wave data. */
  seed?: number;
}

export interface WaterVolume {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  surfaceY: number;
  depth: number;
  /** Cosmetic rendering metadata; physics uses only the fields above. */
  visual?: WaterVisualProfile;
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

/**
 * Presentation-only visible-sky profile consumed by SkyAtmosphereSystem.
 * Never affects simulation, lighting physics or the gameplay map hash — the
 * existing HDRI/environment map remains the IBL source.
 */
export interface SkyAtmosphereProfile {
  /** Zenith / horizon gradient colours (linear-ish sRGB hex). */
  zenith: number;
  horizon: number;
  /** Sun/moon disc: size in radians of the visual half-angle, tint, glow. */
  discSize: number;
  discColor: number;
  discGlow: number;
  /** 0..1 cloud coverage; layers scroll with windSpeed (u/s, deterministic). */
  cloudCover: number;
  cloudTint: number;
  cloudShade: number;
  windSpeed: number;
  /** Visible stars (masked by cloud opacity). */
  starOpacity: number;
  /** Horizon haze band colour and strength. */
  hazeColor: number;
  hazeStrength: number;
}

export interface SkyConfig {
  preset: 'night' | 'bluehour' | 'overcast' | 'day';
  /** Visible-sky presentation profile (see SkyAtmosphereProfile). */
  atmosphere?: SkyAtmosphereProfile;
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

/** Rectangular opening removed from the rendered and physical terrain. */
export interface TerrainCutout {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Expected top surface, used to avoid cutting unrelated underground floors. */
  surfaceY: number;
}

/** Render-only terrain-following ribbon used for authored roads and paths. */
export interface SurfacePathPoint {
  x: number;
  z: number;
  /** Full path width in metres at this sample. */
  width: number;
}

export interface SurfacePath {
  points: SurfacePathPoint[];
  mat: MatKey;
  /** Small lift above the sampled terrain to prevent z-fighting. */
  yOffset: number;
}

export interface TerrainHeightfield {
  n: number;
  heights: Float32Array;
}

export interface TerrainGridMesh {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  xs: Float32Array;
  zs: Float32Array;
}

export interface MapDef {
  id: string;
  name: string;
  description: string;
  size: number;
  sky: SkyConfig;
  /** Finite terrain samples consumed by Rapier and the playable render mesh. */
  heightfield?: TerrainHeightfield;
  /** Compiled playable triangles shared by physics, rendering and QA. */
  terrainMesh?: TerrainGridMesh;
  /** Exact triangle-interpolated terrain surface (worldY at x,z). */
  terrainHeight?: (x: number, z: number) => number;
  /** Authored shafts/courtyards where terrain must not cap an underground space. */
  terrainCutouts?: TerrainCutout[];
  /** Continuous render-only surfaces; collision remains the terrain below. */
  surfacePaths: SurfacePath[];
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
  /** Deterministic manifest of every authored stair flight (QA + guard proxies). */
  stairs: StairFlight[];
  /** Suggested drop-route band across the map for the transport. */
  transportRoute: { from: [number, number]; to: [number, number] };
  /** Rain-slicked streets: ground materials get reflective wet treatment. */
  wetGround?: boolean;
}

/**
 * Deterministic record of one authored stair flight, emitted by
 * WorldBuilder.stairs(). Derived entirely from the flight's hashed geometry;
 * QA traversal harnesses and guard-proxy generation consume it instead of
 * re-deriving flight layouts from raw geo boxes.
 */
export interface StairFlight {
  x: number; y: number; z: number;
  dir: 0 | 1 | 2 | 3;
  steps: number;
  stepH: number;
  stepD: number;
  width: number;
  totalRise: number;
  run: number;
}

export interface PlatformRect {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  y: number;
  water?: boolean;
  /** Nav surface supplied by an authored bridge/stair inside a terrain opening. */
  preserveInTerrainCutout?: boolean;
}

/**
 * Human-scale normalization for the Kenney vehicle GLBs, which are authored
 * at toy scale (a sedan is only ~2.5 m long). Player eye height is 1.72 m,
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

export const VEHICLE_ASSET_BOUNDS: Record<string, {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}> = {
  sedan: { minX: -0.75, maxX: 0.75, minY: 0, maxY: 1.3, minZ: -1.3, maxZ: 1.25 },
  'race-future': { minX: -0.6, maxX: 0.6, minY: 0, maxY: 0.8325, minZ: -1.3299, maxZ: 1.3299 },
  'hatchback-sports': { minX: -0.65, maxX: 0.65, minY: 0, maxY: 1.1, minZ: -1.45, maxZ: 1.4 },
  van: { minX: -0.75, maxX: 0.75, minY: 0, maxY: 1.35, minZ: -1.4, maxZ: 1.35 },
  'delivery-flat': { minX: -0.75, maxX: 0.75, minY: 0, maxY: 1.35, minZ: -1.65, maxZ: 1.6 },
  truck: { minX: -0.75, maxX: 0.75, minY: 0, maxY: 1.3, minZ: -1.5, maxZ: 1.45 },
  police: { minX: -0.75, maxX: 0.75, minY: 0, maxY: 1.3, minZ: -1.55, maxZ: 1.55 },
  suv: { minX: -0.75, maxX: 0.75, minY: 0, maxY: 1.3, minZ: -1.35, maxZ: 1.35 },
  taxi: { minX: -0.75, maxX: 0.75, minY: 0, maxY: 1.5, minZ: -1.4, maxZ: 1.35 },
};

const VEHICLE_ASSET_OPTIONS: Record<string, readonly string[]> = {
  sedan: ['sedan', 'race-future', 'hatchback-sports'],
  van: ['van', 'delivery-flat'],
  truck: ['truck'],
  wrecked: ['police', 'suv'],
};

/** Resolve the exact GLB selected by the renderer for an authored vehicle. */
export function vehicleAssetVariant(variant: string, x: number, z: number): string {
  const options = VEHICLE_ASSET_OPTIONS[variant] ?? VEHICLE_ASSET_OPTIONS.sedan!;
  return options[Math.abs(Math.round(x * 7.9 + z * 3.7)) % options.length]!;
}

/** Shared render placement derived from measured source-GLB bounds. */
export function vehicleRenderSpec(variant: string, x: number, z: number): {
  asset: string;
  scale: number;
  yOffset: number;
} {
  const asset = vehicleAssetVariant(variant, x, z);
  const scale = VEHICLE_SCALE[asset] ?? 1.5;
  const bounds = VEHICLE_ASSET_BOUNDS[asset] ?? VEHICLE_ASSET_BOUNDS.sedan!;
  return { asset, scale, yOffset: -bounds.minY * scale };
}

/** Collider envelope for the exact scaled GLB chosen by vehicleRenderSpec. */
export function vehicleColliderBox(variant: string, x = 0, z = 0): {
  ex: number; ez: number; h: number;
  centerX: number; centerZ: number;
  yawAligned: 'x' | 'z';
} {
  const { asset, scale } = vehicleRenderSpec(variant, x, z);
  const bounds = VEHICLE_ASSET_BOUNDS[asset] ?? VEHICLE_ASSET_BOUNDS.sedan!;
  const pad = 0.025;
  return {
    ex: (bounds.maxX - bounds.minX) * scale / 2 + pad,
    ez: (bounds.maxZ - bounds.minZ) * scale / 2 + pad,
    h: (bounds.maxY - bounds.minY) * scale,
    centerX: (bounds.minX + bounds.maxX) * scale / 2,
    centerZ: (bounds.minZ + bounds.maxZ) * scale / 2,
    yawAligned: 'z',
  };
}

/** Rotate the GLB-local collider centre around its authored vehicle origin. */
export function vehicleColliderCenter(
  vehicle: { x: number; z: number; yaw: number; variant: string },
): { x: number; z: number } {
  const box = vehicleColliderBox(vehicle.variant, vehicle.x, vehicle.z);
  const c = Math.cos(vehicle.yaw);
  const s = Math.sin(vehicle.yaw);
  return {
    x: vehicle.x + box.centerX * c + box.centerZ * s,
    z: vehicle.z - box.centerX * s + box.centerZ * c,
  };
}
