/**
 * WorldView: builds the renderable scene from a MapDef + Match state using
 * redistributed CC0 model assets (Quaternius nature, Kenney vehicles —
 * see docs/ASSET_MANIFEST.md): instanced vegetation, detailed vehicles,
* tiered chest presentation, rarity loot presentation, animated storm wall
 * and shader water. Simulation state is read-only.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  ROCK_COLLIDER_RADIUS,
  vehicleRenderSpec,
  type GeoBox,
  type MapDef,
  type MatKey,
  type WaterVolume,
} from '../world/types';
import type { MaterialLibrary } from './materials';
import { PropLibrary, scatterMatrix } from './props';
import { WeaponModelFactory } from './weaponModels';
import { buildVista, type VistaHandle } from './vista';
import type { Match } from '../sim/match';
import { RARITY_COLORS } from '../core/balance';
import { buildTerrainRibbonIndices } from '../world/terrainMesh';

export interface PresentationTransport {
  position: THREE.Vector3;
  /** Optional interpolated yaw; falls back to the route direction. */
  yaw?: number;
}

/** Merge authored chest parts without allowing a silent null geometry. */
function mergeChestParts(parts: THREE.BufferGeometry[], label: string): THREE.BufferGeometry {
  const firstIsIndexed = parts[0]?.index !== null;
  const mixedIndexing = parts.some((part) => (part.index !== null) !== firstIsIndexed);
  const compatible = mixedIndexing
    ? parts.map((part) => (part.index ? part.toNonIndexed() : part))
    : parts;
  const merged = mergeGeometries(compatible);
  if (!merged) throw new Error(`failed to merge ${label} chest geometry`);
  return merged;
}

const STORM_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWPos;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const STORM_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec2 vUv;
  varying vec3 vWPos;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    // vertical fade: solid at eye level, fading toward the top rim
    float vertFade = smoothstep(1.0, 0.3, vUv.y) * smoothstep(0.0, 0.06, vUv.y);
    // large-scale wall presence (slow drifting murk so it reads as a volume)
    float murk = sin(vUv.x * 24.0 + uTime * 0.35 + sin(vUv.y * 9.0 + uTime * 0.2) * 1.4) * 0.5 + 0.5;
    // scrolling energy bands (two directions)
    float band = sin(vUv.x * 90.0 - uTime * 2.2 + sin(vUv.y * 22.0)) * 0.5 + 0.5;
    band *= 0.55 + 0.45 * sin(vUv.y * 34.0 - uTime * 1.4);
    // crackle noise streaks
    vec2 cell = vec2(floor(vUv.x * 140.0), floor(vUv.y * 26.0));
    float n = hash(cell + vec2(floor(uTime * 9.0), 0.0));
    float crackle = step(0.82, n) * (0.6 + 0.4 * sin(uTime * 22.0));
    float energy = band * (0.35 + crackle);
    vec3 col = mix(uColorB, uColorA, clamp(energy * 1.5, 0.0, 1.0));
    col = mix(col, uColorB * 0.85, murk * 0.35);
    // readable translucent wall: solid purple body + energetic highlights
    float alpha = vertFade * (0.27 + murk * 0.08 + energy * 0.24) * uIntensity;
    gl_FragColor = vec4(col, alpha);
  }
`;

const WATER_VERT = /* glsl */ `
  uniform float uTime;
  varying vec3 vWPos;
  varying vec3 vNormalW;
  void main() {
    vec3 p = position;
    // gentle multi-wave displacement (plane is XY before rotateX)
    float w = sin(p.x * 0.55 + uTime * 1.35) * 0.055
            + sin(p.y * 0.72 - uTime * 1.05) * 0.045
            + sin((p.x + p.y) * 0.31 + uTime * 0.75) * 0.038;
    p.z += w;
    // analytic-ish normal from wave gradient
    float dx = cos(p.x * 0.55 + uTime * 1.35) * 0.55 * 0.055
             + cos((p.x + p.y) * 0.31 + uTime * 0.75) * 0.31 * 0.038;
    float dy = cos(p.y * 0.72 - uTime * 1.05) * 0.72 * 0.045
             + cos((p.x + p.y) * 0.31 + uTime * 0.75) * 0.31 * 0.038;
    vec3 n = normalize(vec3(-dx, -dy, 1.0));
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * n);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WATER_FRAG = /* glsl */ `
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uSkyColor;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec2 uWaterCenter;
  uniform vec2 uHalfSize;
  uniform float uTime;
  varying vec3 vWPos;
  varying vec3 vNormalW;

  void main() {
    // Add two fragment-scale wave fields to the displaced surface normal.
    // The old single mesh normal produced a nearly uniform grey sheet from
    // the gameplay camera; crossed directions keep highlights readable at
    // both shore and vista distances without increasing mesh density.
    float phaseA = vWPos.x * 0.83 + vWPos.z * 0.31 + uTime * 1.55;
    float phaseB = vWPos.x * -0.27 + vWPos.z * 1.18 - uTime * 1.12;
    float phaseC = (vWPos.x + vWPos.z) * 0.19 + uTime * 0.46;
    vec2 slope = vec2(
      cos(phaseA) * 0.075 - cos(phaseB) * 0.028 + cos(phaseC) * 0.022,
      cos(phaseA) * 0.028 + cos(phaseB) * 0.095 + cos(phaseC) * 0.022
    );
    vec3 detailNormal = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 n = normalize(mix(normalize(vNormalW), detailNormal, 0.58));
    vec3 v = normalize(cameraPosition - vWPos);
    float facing = max(dot(n, v), 0.0);
    float fres = pow(1.0 - facing, 3.2);

    // Two sun lobes: a readable broad reflection with a restrained hot core.
    // Map sunDirection is the direction light travels. The renderer places
    // the light at its negation, so the surface-to-sun vector is -uSunDir.
    vec3 h = normalize(-uSunDir + v);
    float nh = max(dot(n, h), 0.0);
    float specBroad = pow(nh, 54.0);
    float specCore = pow(nh, 260.0);

    // Sparse capillary glints break up the surface without a tiled texture.
    float ripple = sin(vWPos.x * 6.7 + vWPos.z * 1.9 + uTime * 2.4)
      * sin(vWPos.z * 5.9 - vWPos.x * 1.25 - uTime * 1.8);
    float sparkle = smoothstep(0.985, 1.0, ripple) * (0.035 + specBroad * 0.06);

    vec2 local = abs(vWPos.xz - uWaterCenter);
    float edgeDistance = min(uHalfSize.x - local.x, uHalfSize.y - local.y);
    float shoreline = 1.0 - smoothstep(0.0, 4.5, edgeDistance);
    float depthVariation = sin(vWPos.x * 0.036 + vWPos.z * 0.021)
      * sin(vWPos.z * 0.029 - vWPos.x * 0.017) * 0.5 + 0.5;
    vec3 base = mix(uDeepColor, uShallowColor, shoreline * 0.68 + depthVariation * 0.08);
    vec3 reflected = mix(base, uSkyColor, 0.035 + fres * 0.38);
    vec3 col = reflected;
    col += uSunColor * (specBroad * 0.2 + specCore * 0.42);
    col += uSkyColor * sparkle;
    col += uShallowColor * shoreline * 0.08;
    col *= 0.9 + clamp(slope.x + slope.y, -0.08, 0.1) * 0.8;

    float alpha = mix(0.94, 0.98, fres);
    gl_FragColor = vec4(col, alpha);
  }
`;

export interface WaterlineSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  y: number;
}

/**
 * Trace the actual terrain/water intersection instead of decorating the
 * rectangular water-volume bounds. The lake is exposed by a curved terrain
 * basin, so perimeter-only foam produced a floating rectangle far from the
 * visible bank.
 */
export function traceWaterline(
  heightAt: (x: number, z: number) => number,
  water: WaterVolume,
  spacing = 3,
): WaterlineSegment[] {
  const nx = Math.max(1, Math.ceil((water.maxX - water.minX) / spacing));
  const nz = Math.max(1, Math.ceil((water.maxZ - water.minZ) / spacing));
  const dx = (water.maxX - water.minX) / nx;
  const dz = (water.maxZ - water.minZ) / nz;
  const segments: WaterlineSegment[] = [];
  const crossing = (
    ax: number,
    az: number,
    ah: number,
    bx: number,
    bz: number,
    bh: number,
  ): { x: number; z: number } | null => {
    const a = ah - water.surfaceY;
    const b = bh - water.surfaceY;
    if ((a < 0) === (b < 0) || Math.abs(a - b) < 1e-6) return null;
    const t = a / (a - b);
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t };
  };
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x0 = water.minX + ix * dx;
      const x1 = x0 + dx;
      const z0 = water.minZ + iz * dz;
      const z1 = z0 + dz;
      const h00 = heightAt(x0, z0);
      const h10 = heightAt(x1, z0);
      const h11 = heightAt(x1, z1);
      const h01 = heightAt(x0, z1);
      const points = [
        crossing(x0, z0, h00, x1, z0, h10),
        crossing(x1, z0, h10, x1, z1, h11),
        crossing(x1, z1, h11, x0, z1, h01),
        crossing(x0, z1, h01, x0, z0, h00),
      ].filter((point): point is { x: number; z: number } => point !== null);
      // Ordinary marching cells produce two crossings. For the rare saddle,
      // pair adjacent crossings; short local pieces are visually stable and
      // avoid inventing a long diagonal across the cell.
      for (let i = 0; i + 1 < points.length; i += 2) {
        const a = points[i]!;
        const b = points[i + 1]!;
        if (Math.hypot(b.x - a.x, b.z - a.z) < 0.05) continue;
        segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, y: water.surfaceY });
      }
    }
  }
  return segments;
}

export function buildWaterlineRibbonPositions(
  segments: WaterlineSegment[],
  width: number,
  yOffset: number,
): number[] {
  const positions: number[] = [];
  for (const segment of segments) {
    const dx = segment.bx - segment.ax;
    const dz = segment.bz - segment.az;
    const length = Math.hypot(dx, dz);
    const nx = -dz / length * width / 2;
    const nz = dx / length * width / 2;
    const y = segment.y + yOffset;
    positions.push(
      segment.ax - nx, y, segment.az - nz,
      segment.bx + nx, y, segment.bz + nz,
      segment.bx - nx, y, segment.bz - nz,
      segment.ax - nx, y, segment.az - nz,
      segment.ax + nx, y, segment.az + nz,
      segment.bx + nx, y, segment.bz + nz,
    );
  }
  return positions;
}

function waterlineRibbonGeometry(segments: WaterlineSegment[], width: number, yOffset: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(buildWaterlineRibbonPositions(segments, width, yOffset), 3),
  );
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * WorldItem Y is a lightweight settling centre kept 0.35 m above support.
 * Render meshes use their own bounds, so subtract that simulation clearance
 * instead of stacking an additional bob on top of it.
 */
export function lootRenderY(itemY: number, kind: 'weapon' | 'consumable'): number {
  return itemY + (kind === 'weapon' ? -0.30 : -0.17);
}

/**
 * A restrained rarity treatment for floor weapons.  The old presentation
 * used a tall additive beam and a ground ring, which made the light read as
 * a search light rather than as a property of the item.  This shell follows
 * the actual weapon geometry and only adds a small, view-dependent edge
 * highlight so the silhouette remains legible without washing out nearby
 * surfaces.
 *
 * There is deliberately no time uniform here.  A static spatial scan gives
 * the hologram a little material character while keeping its brightness
 * deterministic from frame to frame (and therefore free of pickup flicker).
 */
const RARITY_HOLOGRAM_VERT = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewDirV;
  varying vec3 vPositionO;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDirV = normalize(-viewPosition.xyz);
    // Keep the small scan pattern in object space.  View-space coordinates
    // would shimmer as the camera moves even though the item is stationary.
    vPositionO = position;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const RARITY_HOLOGRAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormalV;
  varying vec3 vViewDirV;
  varying vec3 vPositionO;

  void main() {
    vec3 normalV = normalize(vNormalV);
    vec3 viewDirV = normalize(vViewDirV);
    // abs() keeps the treatment symmetrical for the double-sided shell.
    float rim = pow(1.0 - abs(dot(normalV, viewDirV)), 2.35);
    // A fixed, very low-contrast scan modulation breaks up a flat wash but
    // never changes over time, unlike the old pulsing beacon.
    float scan = 0.94 + 0.06 * sin(vPositionO.y * 26.0);
    float alpha = uOpacity * (0.10 + rim * 0.38) * scan;
    vec3 color = uColor * (0.42 + rim * 1.05);
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * Virtualized static-light system. Night maps define far more light sources
 * than can run as real-time PointLights; a fixed-size pool is reassigned to
 * the brightest nearest sources around the viewer every few frames while
 * emissive fixtures render everywhere. Keeps NUM_POINT_LIGHTS constant.
 */
class StaticLightPool {
  readonly group = new THREE.Group();
  private pool: THREE.PointLight[] = [];
  private assignments: Array<{ source: number; target: number; blend: number }> = [];
  private sources: Array<{ x: number; y: number; z: number; color: number; intensity: number; range: number }> = [];
  private timer = 0;
  private fromPos = new THREE.Vector3();
  private targetPos = new THREE.Vector3();
  private fromColor = new THREE.Color();
  private targetColor = new THREE.Color();

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 1.7);
      this.pool.push(l);
      this.assignments.push({ source: -1, target: -1, blend: 1 });
      this.group.add(l);
    }
  }

  add(x: number, y: number, z: number, color: number, intensity: number, range: number): void {
    this.sources.push({ x, y, z, color, intensity, range });
  }

  update(dt: number, viewPos: THREE.Vector3): void {
    this.timer -= dt;
    if (this.timer <= 0 && this.sources.length > 0) {
      this.timer = 0.25;
      // Retain assignments while they remain in the nearest set. This
      // hysteresis prevents a light from swapping at every selection tick as
      // the viewer crosses a source boundary.
      const scored = this.sources.map((s, idx) => ({
        idx,
        d2: (s.x - viewPos.x) ** 2 + (s.z - viewPos.z) ** 2,
      })).sort((a, b) => a.d2 - b.d2);
      const activeCount = Math.min(this.pool.length, scored.length);
      // Keep a small reserve set so a currently visible source is not dropped
      // immediately at the edge of the active window (selection hysteresis).
      const desired = scored.slice(0, Math.min(activeCount + 2, scored.length)).map((entry) => entry.idx);
      const used = new Set<number>();
      for (const assignment of this.assignments) {
        if (assignment.source >= 0 && desired.includes(assignment.source)) used.add(assignment.source);
      }
      for (const assignment of this.assignments) {
        if (assignment.source >= 0 && desired.includes(assignment.source)) {
          assignment.target = assignment.source;
          continue;
        }
        const replacement = scored.slice(0, activeCount).map((entry) => entry.idx).find((idx) => !used.has(idx));
        if (replacement === undefined) continue;
        used.add(replacement);
        assignment.target = replacement;
        assignment.blend = 0;
      }
    }

    // Move and dim assignments over a short window instead of teleporting the
    // light. This is intentionally done every frame, including between pool
    // selection ticks, so facades do not flash during traversal.
    for (let i = 0; i < this.pool.length; i++) {
      const light = this.pool[i]!;
      const assignment = this.assignments[i]!;
      if (assignment.target < 0 || !this.sources[assignment.target]) {
        light.intensity = 0;
        continue;
      }
      const target = this.sources[assignment.target]!;
      const from = assignment.source >= 0 ? this.sources[assignment.source] ?? target : target;
      assignment.blend = Math.min(1, assignment.blend + dt / 0.18);
      const blend = assignment.blend;
      this.fromPos.set(from.x, from.y, from.z);
      this.targetPos.set(target.x, target.y, target.z);
      light.position.lerpVectors(this.fromPos, this.targetPos, blend);
      this.fromColor.setHex(from.color);
      this.targetColor.setHex(target.color);
      light.color.copy(this.fromColor).lerp(this.targetColor, blend);
      const targetDistance = Math.hypot(target.x - viewPos.x, target.z - viewPos.z);
      const targetFade = Math.min(1, Math.max(0, 1 - targetDistance / (target.range * 1.35)));
      const targetIntensity = target.intensity * (0.35 + 0.65 * targetFade);
      const fromDistance = Math.hypot(from.x - viewPos.x, from.z - viewPos.z);
      const fromFade = Math.min(1, Math.max(0, 1 - fromDistance / (from.range * 1.35)));
      const fromIntensity = assignment.source >= 0
        ? from.intensity * (0.35 + 0.65 * fromFade)
        : 0;
      // Crossfade energy as well as position/color. Multiplying only the new
      // intensity by blend caused every reassignment to dip to black for one
      // frame, which read as a building-light flash.
      light.intensity = THREE.MathUtils.lerp(fromIntensity, targetIntensity, blend);
      light.distance = target.range;
      if (assignment.blend >= 1) assignment.source = assignment.target;
    }
  }
}

export class WorldView {
  readonly group = new THREE.Group();
  private destructibleMeshes = new Map<number, THREE.Object3D>();
  private chestMats = new Map<number, { body: THREE.MeshStandardMaterial; trim: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial }>();
  private lootViews = new Map<number, { root: THREE.Group; inner: THREE.Object3D | null; hologram?: THREE.Object3D }>();
  stormMesh!: THREE.Mesh;
  readonly transportGroup = new THREE.Group();
  private time = 0;
  private waterMats: THREE.ShaderMaterial[] = [];
  private waterVolumes: import('../world/types').WaterVolume[] = [];
  private weaponFactory: WeaponModelFactory;
  private lightPool = new StaticLightPool(22);
  private viewPos = new THREE.Vector3();
  /** Beyond-bounds landscape + boundary barrier (see vista.ts). */
  readonly vista: VistaHandle;

  static async create(
    def: MapDef,
    mats: MaterialLibrary,
    match: Match | null,
    props: PropLibrary,
  ): Promise<WorldView> {
    const w = new WorldView(def, mats, match, props);
    return w;
  }

  private constructor(
    def: MapDef,
    private mats: MaterialLibrary,
    match: Match | null,
    props: PropLibrary,
  ) {
    this.weaponFactory = new WeaponModelFactory(props);
    this.applyWetGround(def);
    this.buildStatic(def);
    this.buildSurfacePaths(def);
    this.buildTerrainRoadStrips(def);
    this.vista = buildVista(def, mats);
    this.group.add(this.vista.group);
    this.buildScatter(def, props);
    this.buildVehicles(def, props);
    this.buildWater(def);
    this.buildShorelineDetail(def);
    if (match) {
      this.trackDestructibles(match, props);
      this.trackChests(match);
      this.buildStorm();
      // No dropship in practice mode (spawn is already on the ground).
      if (!match.practice) this.buildTransport();
    }
  }

  /**
   * Rain-slicked street treatment for wet maps (NEO CITY): shared ground
   * materials get lowered roughness + stronger env response. Materials are
   * shared per-session, so this is re-applied per map load — only one map is
   * ever resident.
   */
  private applyWetGround(def: MapDef): void {
    const groundMats: MatKey[] = ['asphalt', 'sidewalk', 'concreteDark'];
    for (const key of groundMats) {
      const m = this.mats.get(key) as THREE.MeshStandardMaterial;
      if (!m || !m.isMeshStandardMaterial) continue;
      if (def.wetGround) {
        if (m.userData.baseRoughness === undefined) m.userData.baseRoughness = m.roughness;
        // Subtle rain sheen only — full mirror-smooth ground turns the whole
        // map into a bright env mirror ("frozen lake") and drowns the albedo.
        m.roughness = Math.min(0.58, (m.userData.baseRoughness as number) * 0.62);
        m.envMapIntensity = 0.85;
        m.needsUpdate = true;
      } else if (m.userData.baseRoughness !== undefined) {
        m.roughness = m.userData.baseRoughness as number;
        m.envMapIntensity = 1;
        m.needsUpdate = true;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Static geometry (instanced boxes/cylinders/spheres per material)
  // -------------------------------------------------------------------------

  private buildStatic(def: MapDef): void {
    const byKind = new Map<string, Map<MatKey, THREE.Matrix4[]>>();
    const desertDaylightMat: Partial<Record<MatKey, MatKey>> = {
      concreteDark: 'concrete',
      metalDark: 'metal',
      woodDark: 'wood',
    };
    for (const g of def.geo) {
      if (g.noRender) continue;
      const q = g.kind === 'box'
        ? new THREE.Quaternion().setFromEuler(new THREE.Euler(g.pitch ?? 0, g.yaw, g.roll ?? 0, 'YXZ'))
        : g.kind === 'cyl'
          ? new THREE.Quaternion().setFromEuler(new THREE.Euler(g.pitch ?? 0, g.yaw ?? 0, g.roll ?? 0, 'YXZ'))
          : new THREE.Quaternion();
      let scale: THREE.Vector3;
      if (g.kind === 'box') scale = new THREE.Vector3(g.sx, g.sy, g.sz);
      else if (g.kind === 'cyl') scale = new THREE.Vector3(g.r, g.h, g.r);
      else scale = new THREE.Vector3(g.r, g.r, g.r);
      const key = g.kind;
      const renderMat = def.id === 'ashara' ? desertDaylightMat[g.mat] ?? g.mat : g.mat;
      if (!byKind.has(key)) byKind.set(key, new Map());
      const byMat = byKind.get(key)!;
      if (!byMat.has(renderMat)) byMat.set(renderMat, []);
      byMat.get(renderMat)!.push(new THREE.Matrix4().compose(new THREE.Vector3(g.x, g.y, g.z), q, scale));
    }

    const geos: Record<string, THREE.BufferGeometry> = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
      sphere: new THREE.SphereGeometry(1, 12, 10),
    };
    // Bales retain conservative box colliders, but their presentation uses a
    // softened unit profile so farm stacks no longer read as unfinished wall
    // blocks. Keeping the special case material-driven preserves one shared
    // instanced draw instead of allocating a mesh per bale.
    const hayBox = new RoundedBoxGeometry(1, 1, 1, 3, 0.12);

    for (const [kind, byMat] of byKind) {
      for (const [mat, matrices] of byMat) {
        const geometry = kind === 'box' && mat === 'hay' ? hayBox : geos[kind]!;
        const inst = new THREE.InstancedMesh(geometry, this.mats.get(mat), matrices.length);
        matrices.forEach((m, i) => inst.setMatrixAt(i, m));
        inst.instanceMatrix.needsUpdate = true;
        inst.frustumCulled = false;
        inst.castShadow = true;
        inst.receiveShadow = true;
        this.group.add(inst);
      }
    }
  }

  /** Build smooth terrain-following ribbons for roads that do not need colliders. */
  private buildSurfacePaths(def: MapDef): void {
    if (!def.terrainHeight) return;
    def.surfacePaths.forEach((path, pathIndex) => {
      if (path.points.length < 2) return;
      const positions: number[] = [];
      const uvs: number[] = [];
      let distance = 0;
      for (let i = 0; i < path.points.length; i++) {
        const point = path.points[i]!;
        const previous = path.points[Math.max(0, i - 1)]!;
        const next = path.points[Math.min(path.points.length - 1, i + 1)]!;
        const dx = next.x - previous.x;
        const dz = next.z - previous.z;
        const invLength = 1 / Math.max(1e-5, Math.hypot(dx, dz));
        const nx = -dz * invLength;
        const nz = dx * invLength;
        if (i > 0) distance += Math.hypot(point.x - previous.x, point.z - previous.z);
        for (const side of [-1, 1]) {
          const x = point.x + nx * point.width * 0.5 * side;
          const z = point.z + nz * point.width * 0.5 * side;
          positions.push(x, def.terrainHeight!(x, z) + path.yOffset + pathIndex * 0.0004, z);
          uvs.push(distance / 8, side < 0 ? 0 : 1);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(buildTerrainRibbonIndices(path.points.length - 1), 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.mats.get(path.mat));
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.group.add(mesh);
    });
  }

  /** Render terrain-following roads as continuous strips over segmented colliders. */
  private buildTerrainRoadStrips(def: MapDef): void {
    if (def.id !== 'ashara' || !def.terrainHeight) return;
    const boxes = def.geo.filter((g): g is GeoBox => g.kind === 'box' && g.mat === 'asphaltDesert');
    const groups = new Map<string, typeof boxes>();
    for (const box of boxes) {
      const alongX = Math.abs(Math.cos(box.yaw)) >= Math.abs(Math.sin(box.yaw));
      const fixed = alongX ? box.z : box.x;
      const key = `${alongX ? 'x' : 'z'}:${fixed.toFixed(2)}`;
      const group = groups.get(key) ?? [];
      group.push(box);
      groups.set(key, group);
    }

    for (const [key, group] of groups) {
      if (group.length === 0) continue;
      const alongX = key.startsWith('x:');
      const fixed = alongX ? group[0]!.z : group[0]!.x;
      const start = Math.min(...group.map((box) => (
        alongX ? box.x - box.sx / 2 : box.z - box.sx / 2
      )));
      const end = Math.max(...group.map((box) => (
        alongX ? box.x + box.sx / 2 : box.z + box.sx / 2
      )));
      // roadSegment stores local X as length and local Z as width. Yaw rotates
      // those axes in world space but does not swap the stored dimensions.
      const width = Math.max(...group.map((box) => box.sz));
      const steps = Math.max(2, Math.ceil((end - start) / 2));
      const addStrip = (stripWidth: number, yOffset: number, mat: MatKey) => {
        const positions: number[] = [];
        const uvs: number[] = [];
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const along = THREE.MathUtils.lerp(start, end, t);
          for (const side of [-1, 1]) {
            const x = alongX ? along : fixed + side * stripWidth / 2;
            const z = alongX ? fixed + side * stripWidth / 2 : along;
            positions.push(x, def.terrainHeight!(x, z) + yOffset, z);
            uvs.push(t * (end - start) / 8, side < 0 ? 0 : 1);
          }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(new THREE.BufferAttribute(buildTerrainRibbonIndices(steps), 1));
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, this.mats.get(mat));
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        this.group.add(mesh);
      };
      // Segment-level shoulder boxes were flat at each centre height. Their
      // uphill edges pierced the welded asphalt as pale transverse bands.
      // Render both layers from the same sampled ribbon instead: a wider,
      // lower dirt shoulder followed by the continuous asphalt surface.
      addStrip(width + 1.8, 0.064, 'dirt');
      addStrip(width, 0.116, 'asphaltDesert');
    }
  }

  // -------------------------------------------------------------------------
  // Vegetation / rocks — GLB variants, instanced per material bucket
  // -------------------------------------------------------------------------

  private buildScatter(def: MapDef, props: PropLibrary): void {
    // Group trees by variant bucket
    const treeVariantKeys: Record<string, string[]> = {
      oak: ['tree/CommonTree_1', 'tree/CommonTree_2', 'tree/CommonTree_3', 'tree/CommonTree_4', 'tree/CommonTree_5'],
      pine: ['pine/Pine_1', 'pine/Pine_2', 'pine/Pine_3', 'pine/Pine_4'],
      dead: ['dead/DeadTree_1', 'dead/DeadTree_2', 'dead/DeadTree_4'],
    };
    const palms = def.trees.filter((tree) => tree.variant === 'palm');
    const buckets = new Map<string, THREE.Matrix4[]>();
    for (const t of def.trees) {
      if (t.variant === 'palm') continue;
      const keys = treeVariantKeys[t.variant] ?? treeVariantKeys.oak!;
      const key = keys[Math.abs(Math.round(t.x * 13.7 + t.z * 7.3)) % keys.length]!;
      if (!buckets.has(key)) buckets.set(key, []);
      const tiltZ = (Math.sin(t.x * 12.9 + t.z * 3.1) * 0.04) * (t.variant === 'dead' ? 2.2 : 1);
      const tiltX = (Math.cos(t.x * 7.7 + t.z * 11.3) * 0.04) * (t.variant === 'dead' ? 1.8 : 1);
      const yScale = t.scale * (t.variant === 'oak' || t.variant === 'pine' ? 1.15 : 1);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(t.x, t.y, t.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, Math.abs(t.x * 31.7 + t.z * 17.3) * 0.7 % (Math.PI * 2), tiltZ)),
        new THREE.Vector3(t.scale * 1.05, yScale * 1.15, t.scale * 1.05),
      );
      buckets.get(key)!.push(m);
    }
    for (const [key, matrices] of buckets) {
      if (!props.hasVariant(key)) continue;
      // Trees skip shadow-casting on overcast maps: the low sun + heavy fog
      // make their shadows invisible while the extra depth pass costs a full
      // scene traversal of the dominant triangle budget.
      const isTree = key.startsWith('tree/') || key === 'palm';
      const tint = def.id === 'oldfront' && isTree ? moorTint : undefined;
      this.addInstancedByGrid(key, matrices, props, 4096, def.sky.preset !== 'overcast', tint);
    }

    // The bundled nature pack has no palm silhouette. Reusing a temperate
    // broadleaf tree made the desert read as a green forest, so palms use a
    // light procedural trunk/crown assembled into two instanced draw calls.
    if (palms.length > 0) {
      const trunkGeometry = new THREE.CylinderGeometry(1, 1.35, 1, 9, 6);
      const trunkMaterial = new THREE.MeshStandardMaterial({
        color: 0x75563b,
        roughness: 0.96,
        metalness: 0,
      });
      const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, palms.length);
      const crownGeometry = new THREE.SphereGeometry(1, 9, 6);
      const crowns = new THREE.InstancedMesh(crownGeometry, trunkMaterial, palms.length);

      // A palm frond is a curved central rachis with paired leaflets, not one
      // triangular billboard. Build a compact feathered mesh once and fan it
      // around every crown. Geometry carries the droop so instances only need
      // a yaw and mild scale variation.
      const frondGeometry = new THREE.BufferGeometry();
      const frondVertices: number[] = [];
      const frondIndices: number[] = [];
      const addFrondQuad = (
        a: [number, number, number],
        b: [number, number, number],
        c: [number, number, number],
        d: [number, number, number],
      ) => {
        const base = frondVertices.length / 3;
        frondVertices.push(...a, ...b, ...c, ...d);
        frondIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      };
      const frondCenter = (t: number): [number, number] => [
        -0.14 * t - 1.05 * t * t,
        4.9 * t,
      ];
      const rachisSegments = 10;
      for (let i = 0; i < rachisSegments; i++) {
        const t0 = i / rachisSegments;
        const t1 = (i + 1) / rachisSegments;
        const [y0, z0] = frondCenter(t0);
        const [y1, z1] = frondCenter(t1);
        const w0 = 0.055 * (1 - t0 * 0.55);
        const w1 = 0.055 * (1 - t1 * 0.55);
        addFrondQuad([-w0, y0, z0], [w0, y0, z0], [w1, y1, z1], [-w1, y1, z1]);
      }
      for (let i = 1; i <= 8; i++) {
        const t = 0.08 + i * 0.092;
        const [y, z] = frondCenter(t);
        const leafLength = 0.72 * Math.pow(Math.sin(t * Math.PI), 0.62) * (1 - t * 0.16);
        const back = 0.13 + t * 0.08;
        const forward = 0.28 + t * 0.15;
        addFrondQuad(
          [-0.025, y, z - back],
          [-0.025, y, z + back],
          [-leafLength, y - 0.08, z + forward],
          [-leafLength * 0.88, y - 0.045, z + 0.03],
        );
        addFrondQuad(
          [0.025, y, z + back],
          [0.025, y, z - back],
          [leafLength * 0.88, y - 0.045, z + 0.03],
          [leafLength, y - 0.08, z + forward],
        );
      }
      const [tipY, tipZ] = frondCenter(1);
      addFrondQuad([-0.035, tipY, tipZ - 0.38], [0.035, tipY, tipZ - 0.38], [0.015, tipY - 0.08, tipZ + 0.2], [-0.015, tipY - 0.08, tipZ + 0.2]);
      frondGeometry.setAttribute('position', new THREE.Float32BufferAttribute(frondVertices, 3));
      frondGeometry.setIndex(frondIndices);
      frondGeometry.computeVertexNormals();
      const frondMaterial = new THREE.MeshStandardMaterial({
        color: 0x647d40,
        emissive: 0x18220f,
        emissiveIntensity: 0.12,
        roughness: 0.92,
        metalness: 0,
        side: THREE.DoubleSide,
      });
      const frondsPerPalm = 10;
      const fronds = new THREE.InstancedMesh(frondGeometry, frondMaterial, palms.length * frondsPerPalm);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      palms.forEach((tree, palmIndex) => {
        const height = tree.scale * 7.2;
        const width = tree.scale * 0.22;
        position.set(tree.x, tree.y + height / 2, tree.z);
        quaternion.setFromEuler(new THREE.Euler(0.015 * Math.sin(tree.x), tree.x + tree.z, 0.02 * Math.cos(tree.z)));
        scale.set(width, height, width);
        matrix.compose(position, quaternion, scale);
        trunks.setMatrixAt(palmIndex, matrix);

        position.set(tree.x, tree.y + height - tree.scale * 0.02, tree.z);
        quaternion.identity();
        scale.setScalar(tree.scale * 0.38);
        matrix.compose(position, quaternion, scale);
        crowns.setMatrixAt(palmIndex, matrix);

        for (let i = 0; i < frondsPerPalm; i++) {
          const yaw = i / frondsPerPalm * Math.PI * 2 + tree.x * 0.13 + tree.z * 0.07;
          position.set(tree.x, tree.y + height - tree.scale * 0.08, tree.z);
          quaternion.setFromEuler(new THREE.Euler(0, yaw, (i % 2 ? 1 : -1) * 0.035, 'YXZ'));
          const leafScale = tree.scale * (0.88 + (i % 2) * 0.12);
          scale.set(leafScale, leafScale * (0.9 + (i % 3) * 0.08), leafScale);
          matrix.compose(position, quaternion, scale);
          fronds.setMatrixAt(palmIndex * frondsPerPalm + i, matrix);
        }
      });
      trunks.instanceMatrix.needsUpdate = true;
      trunks.castShadow = true;
      trunks.receiveShadow = true;
      crowns.instanceMatrix.needsUpdate = true;
      crowns.castShadow = true;
      crowns.receiveShadow = true;
      fronds.instanceMatrix.needsUpdate = true;
      fronds.castShadow = false;
      this.group.add(trunks, crowns, fronds);
    }

    // Undergrowth: bushes / ferns / clover / flowers near tree clusters
    const undergrowthKeys = ['bush/common', 'bush/flowers', 'fern/1', 'clover/1', 'flower/group'];
    const underMatrices = new Map<string, THREE.Matrix4[]>();
    const rngSeed = def.id === 'neocity' ? 11 : 23;
    let s1 = rngSeed * 1000 + 17;
    const rnd = () => {
      s1 = (s1 * 16807) % 2147483647;
      return (s1 & 0x7fffffff) / 0x7fffffff;
    };
    for (const t of def.trees) {
      const count = def.id === 'ashara' ? 0 : def.id === 'eden' ? 6 : 3;
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2;
        const r = 1.6 + rnd() * 3.4;
        const x = t.x + Math.cos(a) * r;
        const z = t.z + Math.sin(a) * r;
        const key = undergrowthKeys[Math.floor(rnd() * undergrowthKeys.length)]!;
        if (!underMatrices.has(key)) underMatrices.set(key, []);
        const s = 0.55 + rnd() * 0.65;
        const yaw = rnd() * Math.PI * 2;
        underMatrices.get(key)!.push(scatterMatrix(x, t.y + 0.02, z, s, yaw));
      }
    }
    for (const key of undergrowthKeys) {
      // Shoreline vegetation (reeds/sedges) + rock-adjacent bushes, driven by
      // the heightfield so plants hug real water edges. Skipped on flat maps
      // and tiny water features like fountains.
      if (!underMatrices.has(key)) underMatrices.set(key, []);
    }
    if (def.terrainHeight && def.id !== 'neocity' && def.id !== 'ashara') {
      const shoreKeys = ['fern/1', 'clover/1', 'fern/1', 'bush/common'];
      const smp = def.terrainHeight;
      for (const w of def.water) {
        const spanX = w.maxX - w.minX;
        const spanZ = w.maxZ - w.minZ;
        if (spanX < 20 && spanZ < 20) continue;
        const perim = 2 * (spanX + spanZ);
        const n = Math.max(24, Math.min(140, Math.round(perim * 0.55)));
        for (let i = 0; i < n; i++) {
          // Walk the rect perimeter with outward jitter 0.5–7 m.
          const t = rnd() * perim;
          let x: number, z: number;
          if (t < spanX) { x = w.minX + t; z = w.minZ; }
          else if (t < spanX + spanZ) { x = w.maxX; z = w.minZ + (t - spanX); }
          else if (t < 2 * spanX + spanZ) { x = w.minX + (t - spanX - spanZ); z = w.maxZ; }
          else { x = w.minX; z = w.minZ + (t - 2 * spanX - spanZ); }
          const side = rnd() < 0.5 ? 1 : -1;
          const horiz = rnd() < 0.5;
          x += (horiz ? 0 : side) * (0.5 + rnd() * 6.5);
          z += (horiz ? side : 0) * (0.5 + rnd() * 6.5);
          const y = smp(x, z);
          // Keep plants in the beach band around the waterline.
          if (y > w.surfaceY + 0.3 || y < w.surfaceY - 0.9) continue;
          const key2 = shoreKeys[Math.floor(rnd() * shoreKeys.length)]!;
          const s = 0.6 + rnd() * 0.7;
          underMatrices.get(key2)!.push(scatterMatrix(x, y + 0.02, z, s, rnd() * Math.PI * 2));
        }
      }
      // Bushes tucked against boulders.
      for (const r of def.rocks) {
        if (rnd() > 0.55) continue;
        const a = rnd() * Math.PI * 2;
        const d = ROCK_COLLIDER_RADIUS * r.scale + 0.6 + rnd() * 1.4;
        const x = r.x + Math.cos(a) * d;
        const z = r.z + Math.sin(a) * d;
        const y = def.terrainHeight ? def.terrainHeight(x, z) : r.y;
        const key3 = rnd() < 0.6 ? 'bush/common' : 'fern/1';
        underMatrices.get(key3)!.push(scatterMatrix(x, y + 0.02, z, 0.55 + rnd() * 0.6, rnd() * Math.PI * 2));
      }
      // Meadow tufts: break up the open lawn so fields don't read as empty carpet.
      const tuftCount = def.id === 'eden' ? 420 : def.id === 'oldfront' ? 520 : 0;
      const facilityCores = def.id === 'eden'
        ? [{ x: -90, z: -20, r: 46 }, { x: 120, z: 40, r: 34 }]
        : [];
      for (let i = 0; i < tuftCount; i++) {
        const x = (rnd() * 2 - 1) * 244;
        const z = (rnd() * 2 - 1) * 244;
        if (facilityCores.some((c) => Math.hypot(x - c.x, z - c.z) < c.r)) continue;
        let inWater = false;
        for (const w of def.water) {
          if (x > w.minX - 2 && x < w.maxX + 2 && z > w.minZ - 2 && z < w.maxZ + 2) { inWater = true; break; }
        }
        if (inWater) continue;
        const y = smp(x, z);
        if (y < -1.5) continue;
        const r3 = rnd();
        const keyT = r3 < 0.45 ? 'clover/1' : r3 < 0.8 ? 'fern/1' : 'bush/common';
        underMatrices.get(keyT)!.push(scatterMatrix(x, y + 0.02, z, 0.5 + rnd() * 0.75, rnd() * Math.PI * 2));
      }
    }
    for (const key of undergrowthKeys) {
      const ms = underMatrices.get(key)!;
      if (!ms.length || !props.hasVariant(key)) continue;
      const softTint = def.id === 'oldfront'
        ? moorTintSoft
        : def.id === 'eden' ? wetlandTintSoft : undefined;
      this.addInstancedByGrid(key, ms, props, 4096, false, softTint);
    }

    // Rocks → Quaternius rock models. Each authored collider owns one primary
    // boulder plus a smaller companion kept inside the same physical radius;
    // this breaks the repeated single-mesh silhouette without inventing
    // non-colliding visual mass around the obstacle.
    const rockKeys = ['rock/medium1', 'rock/medium2'];
    const rockBuckets = new Map<string, THREE.Matrix4[]>();
    def.rocks.forEach((r, i) => {
      const phase = r.x * 7.7 + r.z * 3.3;
      const keyIndex = Math.abs(Math.round(phase * 1.73 + i * 2.31)) % rockKeys.length;
      const key = rockKeys[keyIndex]!;
      const addRock = (bucketKey: string, matrix: THREE.Matrix4) => {
        if (!rockBuckets.has(bucketKey)) rockBuckets.set(bucketKey, []);
        rockBuckets.get(bucketKey)!.push(matrix);
      };
      const tiltZ = Math.sin(r.x * 9.1 + r.z * 5.3) * 0.06;
      const tiltX = Math.cos(r.x * 3.7 + r.z * 13.1) * 0.05;
      const heightVariation = 0.96 + Math.sin(phase * 0.63) * 0.08;
      // Prop extraction normalises both source bottoms to y=0. Bury the broad
      // irregular footprint far enough to cover terrain slope and the small
      // authored tilt; a positive lift left a dark daylight gap under large
      // ASHARA boulders.
      const baseOffset = -0.22;
      addRock(
        key,
        new THREE.Matrix4().compose(
          new THREE.Vector3(r.x, r.y + r.scale * baseOffset, r.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, phase, tiltZ)),
          new THREE.Vector3(r.scale * 1.12, r.scale * heightVariation, r.scale * 1.04),
        ),
      );

      const clusterAngle = phase * 1.91 + 0.7;
      const companionScale = r.scale * (0.24 + (Math.sin(phase * 2.3) * 0.5 + 0.5) * 0.12);
      const clusterDistance = r.scale * (0.8 + (Math.cos(phase * 1.4) * 0.5 + 0.5) * 0.22);
      const companionX = r.x + Math.cos(clusterAngle) * clusterDistance;
      const companionZ = r.z + Math.sin(clusterAngle) * clusterDistance;
      const companionKeyIndex = (keyIndex + 1) % rockKeys.length;
      addRock(
        rockKeys[companionKeyIndex]!,
        new THREE.Matrix4().compose(
          new THREE.Vector3(
            companionX,
            r.y - companionScale * 0.18,
            companionZ,
          ),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(
            -tiltZ * 0.7,
            phase + 1.9,
            tiltX * 0.65,
          )),
          new THREE.Vector3(companionScale * 1.18, companionScale * 0.68, companionScale * 1.05),
        ),
      );
    });
    for (const [key, matrices] of rockBuckets) {
      if (!props.hasVariant(key)) continue;
      const tintRock = def.id === 'ashara'
        ? desertRockTint
        : def.id === 'eden'
          ? wetlandRockTint
          : def.id === 'oldfront'
            ? moorRockTint
            : undefined;
      this.addInstancedByGrid(
        key,
        matrices,
        props,
        4096,
        true,
        tintRock,
      );
    }

    // Small angular scree visually seats boulders into the terrain. All
    // fragments stay within the already-solid authored rock cylinder, so the
    // detail cannot become a walk-through visual obstruction.
    if (def.rocks.length > 0) {
      const fragmentsPerRock = 5;
      const screeGeo = new THREE.IcosahedronGeometry(1, 0);
      const screeColor = def.id === 'ashara' ? 0x846a51
        : def.id === 'eden' ? 0x626b62
          : def.id === 'oldfront' ? 0x716a60 : 0x696967;
      const screeMat = new THREE.MeshStandardMaterial({
        color: screeColor,
        roughness: 0.98,
        metalness: 0,
      });
      const scree = new THREE.InstancedMesh(screeGeo, screeMat, def.rocks.length * fragmentsPerRock);
      const fragmentMatrix = new THREE.Matrix4();
      const fragmentPosition = new THREE.Vector3();
      const fragmentRotation = new THREE.Quaternion();
      const fragmentScale = new THREE.Vector3();
      let fragmentIndex = 0;
      def.rocks.forEach((rock, rockIndex) => {
        for (let j = 0; j < fragmentsPerRock; j++) {
          const phase = rock.x * 3.17 + rock.z * 5.83 + rockIndex * 1.37 + j * 2.41;
          const angle = phase * 1.73;
          const distance = rock.scale * (1.05 + (Math.sin(phase) * 0.5 + 0.5) * 0.48);
          const scale = rock.scale * (0.075 + (Math.cos(phase * 1.9) * 0.5 + 0.5) * 0.085);
          fragmentPosition.set(
            rock.x + Math.cos(angle) * distance,
            rock.y + scale * 0.42,
            rock.z + Math.sin(angle) * distance,
          );
          fragmentRotation.setFromEuler(new THREE.Euler(phase * 0.7, phase, phase * 0.37));
          fragmentScale.set(scale * 1.35, scale * 0.65, scale);
          fragmentMatrix.compose(fragmentPosition, fragmentRotation, fragmentScale);
          scree.setMatrixAt(fragmentIndex++, fragmentMatrix);
        }
      });
      scree.instanceMatrix.needsUpdate = true;
      scree.computeBoundingBox();
      scree.computeBoundingSphere();
      scree.castShadow = false;
      scree.receiveShadow = true;
      this.group.add(scree);
    }

    // Lamps: authored street fixtures, instanced per part (draw-call budget)
    const poolGeo = new THREE.CircleGeometry(7, 20);
    poolGeo.rotateX(-Math.PI / 2);
    const poolTex = makeGlowTexture('rgba(255,235,190,', 128);
    const maxLamps = Math.min(def.lamps.length, 84);
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 1, 8);
    poleGeo.translate(0, 0.5, 0);
    const armGeo = new THREE.BoxGeometry(0.9, 0.08, 0.08);
    const headGeo = new THREE.BoxGeometry(0.52, 0.14, 0.3);
    const lensGeo = new THREE.PlaneGeometry(0.42, 0.2);
    lensGeo.rotateX(-Math.PI / 2.6);
    const poleMat = this.mats.get('metalDark');
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, maxLamps);
    const arms = new THREE.InstancedMesh(armGeo, poleMat, maxLamps);
    const heads = new THREE.InstancedMesh(headGeo, poleMat, maxLamps);
    const lensInst = new THREE.InstancedMesh(lensGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), maxLamps);
    const pools = new THREE.InstancedMesh(
      poolGeo,
      new THREE.MeshBasicMaterial({
        map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85,
      }),
      Math.min(maxLamps, 60),
    );
    pools.renderOrder = 1;
    const headTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.18));
    const idQ = new THREE.Quaternion();
    const oneS = new THREE.Vector3(1, 1, 1);
    let poolIdx = 0;
    for (let i = 0; i < maxLamps; i++) {
      const l = def.lamps[i]!;
      const m4 = new THREE.Matrix4();
      m4.compose(new THREE.Vector3(l.x, l.y, l.z), idQ, new THREE.Vector3(1, l.h, 1));
      poles.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(l.x + 0.42, l.y + l.h - 0.06, l.z), idQ, oneS);
      arms.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(l.x + 0.78, l.y + l.h - 0.12, l.z), headTilt, oneS);
      heads.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(l.x + 0.78, l.y + l.h - 0.21, l.z), headTilt, oneS);
      lensInst.setMatrixAt(i, m4);
      lensInst.setColorAt(i, new THREE.Color(l.color));
      // Real light comes from the shared pool; the fixture itself is emissive.
      this.lightPool.add(l.x + 0.78, l.y + l.h - 0.35, l.z, l.color, l.intensity * 1.35, l.range);
      if (poolIdx < pools.count) {
        m4.compose(
          new THREE.Vector3(l.x + 0.78, l.y + 0.07, l.z),
          idQ,
          new THREE.Vector3().setScalar(0.9 + Math.min(0.5, l.range / 60)),
        );
        pools.setMatrixAt(poolIdx, m4);
        pools.setColorAt(poolIdx, new THREE.Color(l.color));
        poolIdx++;
      }
    }
    poles.instanceMatrix.needsUpdate = true;
    arms.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    lensInst.instanceMatrix.needsUpdate = true;
    if (lensInst.instanceColor) lensInst.instanceColor.needsUpdate = true;
    if (pools.instanceColor) pools.instanceColor.needsUpdate = true;
    pools.instanceMatrix.needsUpdate = true;
    poles.castShadow = true;
    poles.receiveShadow = true;
    this.group.add(poles, arms, heads, lensInst, pools);

    for (const l of def.lights) {
      this.lightPool.add(l.x, l.y, l.z, l.color, l.intensity, l.range);
    }
    this.group.add(this.lightPool.group);
  }

  /**
   * Instance a scatter bucket split into a coarse world grid so three.js
   * frustum culling can skip whole cells. One InstancedMesh per
   * (variant, non-empty cell) — a few extra draws in exchange for rendering
   * only the cells in view (vegetation dominates the triangle budget).
   */
  private addInstancedByGrid(
    key: string,
    matrices: THREE.Matrix4[],
    props: PropLibrary,
    cell = 80,
    castShadow = true,
    tint?: (m: THREE.Material) => void,
  ): void {
    const byCell = new Map<string, THREE.Matrix4[]>();
    for (const m of matrices) {
      const cx = Math.floor(m.elements[12]! / cell);
      const cz = Math.floor(m.elements[14]! / cell);
      const k = `${cx}:${cz}`;
      let list = byCell.get(k);
      if (!list) byCell.set(k, list = []);
      list.push(m);
    }
    const tintCache = new Map<THREE.Material, THREE.Material>();
    for (const [, list] of byCell) {
      for (const mesh of props.makeInstanced(key, list.length)) {
        if (tint) {
          // Clone + tint once per source material per call; the PropLibrary's
          // shared materials must never be mutated (they outlive the match).
          const srcMat = mesh.material;
          if (!tintCache.has(srcMat as THREE.Material)) {
            const arr = Array.isArray(srcMat) ? srcMat : [srcMat];
            const cloned = arr.map((mm) => {
              const c = mm.clone();
              delete c.userData.externalShared;
              tint(c);
              return c;
            });
            tintCache.set(srcMat as THREE.Material,
              (Array.isArray(srcMat) ? cloned : cloned[0]!) as THREE.Material);
          }
          mesh.material = tintCache.get(srcMat as THREE.Material)!;
        }
        list.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
        // InstancedMesh starts with a source-geometry bound. Once per-cell
        // transforms are installed, compute the aggregate bound before
        // enabling frustum culling; otherwise a large cell can disappear when
        // its source origin leaves the camera frustum.
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        mesh.frustumCulled = true;
        mesh.castShadow = castShadow;
        this.group.add(mesh);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Vehicles — Kenney car kit GLBs with tint
  // -------------------------------------------------------------------------

  private buildVehicles(def: MapDef, props: PropLibrary): void {
    const buckets = new Map<string, Array<{ vehicle: (typeof def.vehicles)[number]; key: string }>>();
    for (let i = 0; i < def.vehicles.length; i++) {
      const v = def.vehicles[i]!;
      const key = vehicleRenderSpec(v.variant, v.x, v.z).asset;
      const bucketKey = `${key}:${v.variant === 'wrecked' ? 'wrecked' : 'live'}`;
      const bucket = buckets.get(bucketKey) ?? [];
      bucket.push({ vehicle: v, key });
      buckets.set(bucketKey, bucket);
    }

    const rootInverse = new THREE.Matrix4();
    const localMatrix = new THREE.Matrix4();
    const vehicleMatrix = new THREE.Matrix4();
    const instanceMatrix = new THREE.Matrix4();
    const vehicleQuaternion = new THREE.Quaternion();
    const vehiclePosition = new THREE.Vector3();
    const sourceScale = new THREE.Vector3();

    for (const [bucketName, entries] of buckets) {
      const key = entries[0]!.key;
      const tmpl = props.cloneTemplate(`vehicle/${key}`);
      if (!tmpl) continue;
      tmpl.updateMatrixWorld(true);
      rootInverse.copy(tmpl.matrixWorld).invert();
      tmpl.traverse((o) => {
        const sourceMesh = o as THREE.Mesh;
        if (!sourceMesh.isMesh || !sourceMesh.material || !sourceMesh.geometry) return;
        const src = Array.isArray(sourceMesh.material) ? sourceMesh.material[0]! : sourceMesh.material;
        const m = src.clone() as THREE.MeshStandardMaterial;
        delete m.userData.externalShared;
        const wrecked = entries[0]!.vehicle.variant === 'wrecked';
        const tintable = wrecked || Boolean(m.map);
        if (wrecked) {
          m.metalness = 0.4;
          m.roughness = 0.95;
        }
        const instanced = new THREE.InstancedMesh(sourceMesh.geometry, m, entries.length);
        localMatrix.multiplyMatrices(rootInverse, sourceMesh.matrixWorld);
        for (let i = 0; i < entries.length; i++) {
          const v = entries[i]!.vehicle;
          const spec = vehicleRenderSpec(v.variant, v.x, v.z);
          const vs = spec.scale;
          vehiclePosition.set(v.x, v.y + spec.yOffset, v.z);
          vehicleQuaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, v.yaw);
          sourceScale.setScalar(vs);
          vehicleMatrix.compose(vehiclePosition, vehicleQuaternion, sourceScale);
          instanceMatrix.multiplyMatrices(vehicleMatrix, localMatrix);
          instanced.setMatrixAt(i, instanceMatrix);
          if (tintable) {
            const tint = new THREE.Color(v.color ?? 0x88929c);
            if (wrecked) tint.multiplyScalar(0.32);
            else tint.multiplyScalar(0.85).addScalar(0.0375);
            instanced.setColorAt(i, tint);
          }
        }
        instanced.instanceMatrix.needsUpdate = true;
        if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
        instanced.computeBoundingBox();
        instanced.computeBoundingSphere();
        instanced.frustumCulled = true;
        instanced.castShadow = true;
        instanced.receiveShadow = true;
        instanced.name = `vehicle:${bucketName}`;
        this.group.add(instanced);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Water — custom shader surface
  // -------------------------------------------------------------------------

  private buildWater(def: MapDef): void {
    this.waterVolumes = def.water.slice();
    for (const w of def.water) {
      const geo = new THREE.PlaneGeometry(w.maxX - w.minX, w.maxZ - w.minZ, 48, 48);
      const mat = new THREE.ShaderMaterial({
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
        premultipliedAlpha: false,
        uniforms: {
          uTime: { value: 0 },
          uDeepColor: { value: new THREE.Color(def.sky.preset === 'night' || def.sky.preset === 'bluehour' ? 0x06121e : 0x06283b) },
          uShallowColor: { value: new THREE.Color(def.sky.preset === 'night' || def.sky.preset === 'bluehour' ? 0x102b3c : 0x19596b) },
          uSkyColor: { value: new THREE.Color(def.sky.preset === 'day' ? 0x5f879e : def.sky.fogColor) },
          uSunDir: { value: new THREE.Vector3(...def.sky.sunDirection).normalize() },
          uSunColor: { value: new THREE.Color(def.sky.sunColor) },
          uWaterCenter: { value: new THREE.Vector2((w.minX + w.maxX) / 2, (w.minZ + w.maxZ) / 2) },
          uHalfSize: { value: new THREE.Vector2((w.maxX - w.minX) / 2, (w.maxZ - w.minZ) / 2) },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((w.minX + w.maxX) / 2, w.surfaceY, (w.minZ + w.maxZ) / 2);
      mesh.geometry.rotateX(-Math.PI / 2);
      mesh.renderOrder = 3;
      this.waterMats.push(mat);
      this.group.add(mesh);
    }
  }

  private buildShorelineDetail(def: MapDef): void {
    if (def.id !== 'eden' || !def.terrainHeight) return;
    const segments = def.water.flatMap((water) => traceWaterline(def.terrainHeight!, water));
    if (segments.length === 0) return;

    // A broad, low-contrast sediment band grounds the bank; a broken narrow
    // foam trace gives the waterline motion-scale without drawing a perfect
    // procedural outline around the whole lake.
    const sediment = new THREE.Mesh(
      waterlineRibbonGeometry(segments, 0.42, 0.012),
      new THREE.MeshStandardMaterial({
        color: 0x34463b,
        roughness: 0.96,
        metalness: 0,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      }),
    );
    sediment.name = 'shoreline:sediment';
    sediment.receiveShadow = true;
    sediment.renderOrder = 3.5;
    this.group.add(sediment);

    const brokenFoam = segments.filter((segment, index) => (
      index % 4 === 1
      && Math.sin(segment.ax * 0.37 + segment.az * 0.19) > 0.38
    ));
    const foam = new THREE.Mesh(
      waterlineRibbonGeometry(brokenFoam, 0.07, 0.026),
      new THREE.MeshBasicMaterial({
        color: 0x8fa69c,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        toneMapped: true,
      }),
    );
    foam.name = 'shoreline:foam';
    foam.renderOrder = 4;
    this.group.add(foam);
  }

  animateWater(t: number): void {
    for (const m of this.waterMats) m.uniforms['uTime']!.value = t;
  }

  // -------------------------------------------------------------------------
  // Destructibles — real material + slight damage tint
  // -------------------------------------------------------------------------

  private trackDestructibles(match: Match, _props: PropLibrary): void {
    for (const d of match.combat.destructibleList()) {
      const g = d.geo;
      let mesh: THREE.Object3D;
      const matKey = ((g as unknown as { mat: MatKey }).mat ?? 'wood') as MatKey;
      const material = this.mats.get(matKey);
      if (g.kind === 'box') {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(g.sx, g.sy, g.sz), material);
        mesh.position.set(g.x, g.y, g.z);
        const yaw = (g as unknown as { yaw?: number }).yaw ?? 0;
        mesh.rotation.y = yaw;
      } else {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(g.r ?? 0.5, g.r ?? 0.5, g.h ?? 1, 10), material);
        mesh.position.set(g.x, g.y, g.z);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.destructibleMeshes.set(d.id, mesh);
      this.group.add(mesh);
    }
  }

  syncDestructibles(match: Match): void {
    for (const d of match.combat.destructibleList()) {
      if (!d.alive) {
        const mesh = this.destructibleMeshes.get(d.id);
        if (mesh) {
          this.group.remove(mesh);
          const rendered = mesh as THREE.Mesh;
          rendered.geometry?.dispose();
          this.destructibleMeshes.delete(d.id);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Chests — tier-specific presentation with mechanical open animation
  // -------------------------------------------------------------------------


  /**
   * Chest presentation — fully instanced per tier (~7 draws total vs ~11 per
   * chest). Only the lid is animated; lighting remains stable per tier.
   */
  private chestInst: Array<{
    body: THREE.InstancedMesh; trim: THREE.InstancedMesh; lock: THREE.InstancedMesh;
    lidBody: THREE.InstancedMesh; lidTrim: THREE.InstancedMesh; core: THREE.InstancedMesh;
    halo: THREE.InstancedMesh | null;
    mats: { body: THREE.MeshStandardMaterial; trim: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial };
  } | null> = [null, null, null];
  private chestSlots = new Map<number, {
    tier: number; idx: number; pos: THREE.Vector3; yaw: number; lidAngle: number; opened: boolean;
  }>();

  private trackChests(match: Match): void {
    const counts = [0, 0, 0];
    for (const c of match.chests) counts[c.kind === 'vault' ? 2 : c.kind === 'elite' ? 1 : 0]!++;
    for (let tier = 0; tier < 3; tier++) {
      if (this.chestInst[tier] || counts[tier] === 0) continue;
      const glowHex = tier === 2 ? 0xffb441 : tier === 1 ? 0xb88cff : 0xffc766;
      let cached = this.chestMats.get(tier);
      if (!cached) {
        const trimMat = new THREE.MeshStandardMaterial({
          color: tier === 2 ? 0xb0833f : tier === 1 ? 0x77798a : 0x98713d,
          emissive: glowHex,
          emissiveIntensity: 0.055,
          roughness: tier === 2 ? 0.34 : 0.42,
          metalness: 0.78,
        });
        const accentMat = new THREE.MeshStandardMaterial({
          color: glowHex,
          emissive: glowHex,
          emissiveIntensity: 0.82 + tier * 0.14,
          roughness: 0.24,
          metalness: 0.22,
        });
        // Keep the large surfaces material-led rather than emissive. The old
        // bright bands flattened the silhouette into a glowing cage and made
        // the chest read as black-and-yellow plastic in direct sunlight.
        const bodyColor = tier === 2 ? 0x4b301a : tier === 1 ? 0x343744 : 0x5d3b20;
        const bodyMat = new THREE.MeshStandardMaterial({
          color: bodyColor,
          emissive: new THREE.Color(bodyColor),
          emissiveIntensity: 0.09,
          roughness: tier === 1 ? 0.57 : 0.72,
          metalness: tier === 1 ? 0.24 : 0.06,
        });
        for (const m of [trimMat, accentMat, bodyMat]) (m.userData as { shared?: boolean }).shared = true;
        cached = { body: bodyMat, trim: trimMat, accent: accentMat };
        this.chestMats.set(tier, cached);
      }
      const n = counts[tier]!;
      // The render volume stays inside the authored 1.10 x .80 x .76 static
      // collider. This prevents the previous oversized lid and corner bands
      // from appearing penetrable even when physics correctly stopped actors.
      const baseGeo = new RoundedBoxGeometry(1.06, 0.5, 0.72, 4, 0.045);
      baseGeo.translate(0, 0.29, 0);
      // Static aged-metal frame: grounded skirt, top rail, corner guards and
      // small feet. The pieces are merged so detail costs one draw per tier.
      const skirt = new THREE.BoxGeometry(1.1, 0.07, 0.76);
      skirt.translate(0, 0.065, 0);
      const upperRailFront = new THREE.BoxGeometry(1.1, 0.065, 0.055);
      upperRailFront.translate(0, 0.515, -0.365);
      const upperRailBack = upperRailFront.clone();
      upperRailBack.translate(0, 0, 0.73);
      const brackets: THREE.BufferGeometry[] = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const b = new THREE.BoxGeometry(0.075, 0.5, 0.075);
        b.translate(sx * 0.49, 0.29, sz * 0.33);
        brackets.push(b);
        const foot = new THREE.CylinderGeometry(0.065, 0.075, 0.05, 8);
        foot.translate(sx * 0.45, 0.025, sz * 0.29);
        brackets.push(foot);
      }
      // Narrow rails frame three believable front planks without covering the
      // wood grain/readable body mass in emissive metal.
      for (const y of [0.225, 0.39]) {
        const band = new THREE.BoxGeometry(0.88, 0.035, 0.035);
        band.translate(0, y, -0.372);
        brackets.push(band);
      }
      const trimGeo = mergeChestParts([skirt, upperRailFront, upperRailBack, ...brackets], 'frame');
      // Lock plate, raised escutcheon, shackle and rivets. All are authored on
      // the near face so the interaction target reads from gameplay distance.
      const lockParts: THREE.BufferGeometry[] = [];
      const lockPlate = new RoundedBoxGeometry(0.19, 0.22, 0.035, 3, 0.018);
      lockPlate.translate(0, 0.47, -0.385);
      lockParts.push(lockPlate);
      const shackle = new THREE.TorusGeometry(0.068, 0.016, 6, 12, Math.PI);
      shackle.translate(0, 0.59, -0.405);
      lockParts.push(shackle);
      for (const x of [-0.075, 0.075]) for (const y of [0.395, 0.545]) {
        const rivet = new THREE.SphereGeometry(0.012, 6, 4);
        rivet.translate(x, y, -0.407);
        lockParts.push(rivet);
      }
      const lockGeo = mergeChestParts(lockParts, 'lock');
      // Lid geometry is local to a real rear hinge at z=+0.38. Its centre is
      // offset toward the front, so opening raises the front instead of
      // rotating the whole chest top through its centre like a seesaw.
      const lidBodyGeo = new RoundedBoxGeometry(1.08, 0.27, 0.74, 4, 0.065);
      lidBodyGeo.translate(0, 0.135, -0.37);
      const lidTrimParts: THREE.BufferGeometry[] = [];
      const lidFrontRail = new THREE.BoxGeometry(1.1, 0.075, 0.045);
      lidFrontRail.translate(0, 0.08, -0.742);
      lidTrimParts.push(lidFrontRail);
      for (const x of [-0.38, 0, 0.38]) {
        const topStrap = new THREE.BoxGeometry(0.05, 0.035, 0.68);
        topStrap.translate(x, 0.282, -0.37);
        lidTrimParts.push(topStrap);
        const frontStrap = new THREE.BoxGeometry(0.05, 0.21, 0.035);
        frontStrap.translate(x, 0.13, -0.748);
        lidTrimParts.push(frontStrap);
      }
      for (const x of [-0.38, 0.38]) {
        const hinge = new THREE.CylinderGeometry(0.035, 0.035, 0.16, 8);
        hinge.rotateZ(Math.PI / 2);
        hinge.translate(x, 0.035, -0.015);
        lidTrimParts.push(hinge);
      }
      const lidTrimGeo = mergeChestParts(lidTrimParts, 'lid trim');
      // A restrained rarity beacon and a lining glow become visible when the
      // lid opens. This concentrates emission in believable light sources.
      const badge = new THREE.OctahedronGeometry(0.055 + tier * 0.006, 0);
      badge.scale(1, 1.25, 0.45);
      badge.translate(0, 0.465, -0.415);
      const innerGlow = new RoundedBoxGeometry(0.42, 0.018, 0.18, 2, 0.008);
      innerGlow.translate(0, 0.555, 0);
      // Mixed indexed/non-indexed parts must be normalised before merging.
      // Passing a null merge result into InstancedMesh crashes Three's render
      // traversal every frame, so the shared helper also fails descriptively.
      const coreGeo = mergeChestParts([badge, innerGlow], 'rarity core');
      const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
        const im = new THREE.InstancedMesh(geo, mat, n);
        im.castShadow = shadow;
        im.receiveShadow = shadow;
        im.frustumCulled = false;
        this.group.add(im);
        return im;
      };
      // No animated halo mesh: the old scale pulse read as lighting flicker
      // and the floating/ground ring made the object look broken. Stable PBR
      // body highlights plus restrained emissive hardware provide the cue.
      const halo: THREE.InstancedMesh | null = null;
      this.chestInst[tier] = {
        body: mk(baseGeo, cached.body, true),
        trim: mk(trimGeo, cached.trim, false),
        lock: mk(lockGeo, cached.accent, false),
        lidBody: mk(lidBodyGeo, cached.body, true),
        lidTrim: mk(lidTrimGeo, cached.trim, false),
        core: mk(coreGeo, cached.accent, false),
        halo,
        mats: cached,
      };
    }
    const nextIdx: number[] = [0, 0, 0];
    for (const c of match.chests) {
      if (this.chestSlots.has(c.id)) continue;
      const tier = c.kind === 'vault' ? 2 : c.kind === 'elite' ? 1 : 0;
      const idx = nextIdx[tier]!;
      nextIdx[tier] = idx + 1;
      this.chestSlots.set(c.id, {
        tier, idx,
        pos: new THREE.Vector3(c.x, c.y, c.z),
        yaw: Math.abs(Math.round((c.x * 13.7 + c.z * 7.3))) * 0.61 % (Math.PI * 2),
        lidAngle: 0, opened: false,
      });
    }
    // Write static transforms once (base, hardware and closed-lid pose).
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (const [, s] of this.chestSlots) {
      const inst = this.chestInst[s.tier]!;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw);
      m4.compose(s.pos, q, one);
      inst.body.setMatrixAt(s.idx, m4);
      inst.trim.setMatrixAt(s.idx, m4);
      inst.lock.setMatrixAt(s.idx, m4);
      inst.core.setMatrixAt(s.idx, m4);
      if (inst.halo) inst.halo.setMatrixAt(s.idx, m4);
      const lidM = m4.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.54, 0.38));
      inst.lidBody.setMatrixAt(s.idx, lidM);
      inst.lidTrim.setMatrixAt(s.idx, lidM);
    }
    for (let tier = 0; tier < 3; tier++) {
      const inst = this.chestInst[tier];
      if (!inst) continue;
      for (const im of [inst.body, inst.trim, inst.lock, inst.lidBody, inst.lidTrim, inst.core, ...(inst.halo ? [inst.halo] : [])]) {
        im.instanceMatrix.needsUpdate = true;
        im.count = nextIdx[tier]!;
      }
    }
  }

  syncChests(match: Match): void {
    const m4 = new THREE.Matrix4();
    const qy = new THREE.Quaternion();
    const qx = new THREE.Quaternion();
    const pivot = new THREE.Vector3(0, 0.54, 0.38);
    const one = new THREE.Vector3(1, 1, 1);
    for (const c of match.chests) {
      const s = this.chestSlots.get(c.id);
      if (!s) continue;
      const inst = this.chestInst[s.tier]!;
      const targetLid = Math.min(1, c.openT * 1.6) * 1.82;
      s.lidAngle += (targetLid - s.lidAngle) * 0.14;
      s.opened = c.opened;
      qy.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw);
      // lid: chest transform · translate(pivot) · rotateX(angle)
      m4.compose(s.pos, qy, one);
      const lidM = m4.clone().multiply(new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z));
      qx.setFromAxisAngle(new THREE.Vector3(1, 0, 0), s.lidAngle);
      lidM.multiply(new THREE.Matrix4().makeRotationFromQuaternion(qx));
      inst.lidBody.setMatrixAt(s.idx, lidM);
      inst.lidTrim.setMatrixAt(s.idx, lidM);
    }
    for (let tier = 0; tier < 3; tier++) {
      const inst = this.chestInst[tier];
      if (!inst) continue;
      inst.lidBody.instanceMatrix.needsUpdate = true;
      inst.lidTrim.instanceMatrix.needsUpdate = true;
      if (inst.halo) inst.halo.instanceMatrix.needsUpdate = true;
      // Tier materials are shared and intentionally stable. Open-state
      // animation is expressed only through the per-instance lid transform.
      inst.mats.trim.emissiveIntensity = 0.055;
      inst.mats.accent.emissiveIntensity = 0.82 + tier * 0.14;
    }
  }

  // -------------------------------------------------------------------------
  // Loot presentation: grounded items and model-attached rarity highlights.
  // Ammo/heals render through shared instanced pools (draw-call budget);
  // weapons keep individual models with a subtle geometry-following shell.
  // -------------------------------------------------------------------------

  private lootInst: Partial<Record<'ammo' | 'med' | 'shield', THREE.InstancedMesh>> = {};

  private lootInstMesh(kind: 'ammo' | 'med' | 'shield'): THREE.InstancedMesh {
    const existing = this.lootInst[kind];
    if (existing) return existing;
    const cap = 128;
    let mesh: THREE.InstancedMesh;
    if (kind === 'ammo') {
      const box = new THREE.BoxGeometry(0.42, 0.3, 0.3);
      const stripe = new THREE.BoxGeometry(0.44, 0.06, 0.32);
      stripe.translate(0, 0.12, 0);
      const geo = mergeGeometries([box, stripe], true)!;
      mesh = new THREE.InstancedMesh(geo, [lootMats.ammoBox, lootMats.ammoStripe], cap);
    } else {
      const box = new THREE.BoxGeometry(0.48, 0.34, 0.34);
      const c1 = new THREE.BoxGeometry(0.3, 0.08, 0.02);
      c1.translate(0, 0.05, 0.18);
      const c2 = new THREE.BoxGeometry(0.08, 0.02, 0.3);
      c2.translate(0, 0.05, 0.18);
      const glow = new THREE.SphereGeometry(0.05, 8, 6);
      glow.translate(0, 0.24, 0);
      const geo = mergeGeometries([box, c1, c2, glow], true)!;
      const mats = kind === 'med'
        ? [lootMats.medBox, lootMats.crossMed, lootMats.crossMed, lootMats.glowMed]
        : [lootMats.shieldBox, lootMats.crossShield, lootMats.crossShield, lootMats.glowShield];
      mesh = new THREE.InstancedMesh(geo, mats, cap);
    }
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.lootInst[kind] = mesh;
    this.group.add(mesh);
    return mesh;
  }

  private lootViewFor(item: import('../sim/loot').WorldItem): { root: THREE.Group; inner: THREE.Object3D | null; hologram?: THREE.Object3D } {
    const root = new THREE.Group();
    const rarityRank = ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(item.rarity);
    const glowHex = RARITY_COLORS[item.rarity];

    // Weapons only — consumables render through the shared instanced pools.
    let inner: THREE.Object3D | null = null;
    let hologram: THREE.Object3D | undefined;
    if (item.kind === 'weapon' && item.weapon) {
      const wm = this.weaponFactory.buildWorldScale(item.weapon.weaponId, item.rarity);
      if (wm) {
        inner = wm.group;
        root.add(inner);
        // Keep the shell just outside the real model.  The slight scale
        // expansion avoids depth ties while preserving the authored shape.
        hologram = buildWeaponHologram(wm.group, glowHex, rarityRank);
        if (hologram) root.add(hologram);
      }
    }
    return { root, inner, hologram };
  }

  syncLoot(match: Match): void {
    const seen = new Set<number>();
    const farSqr = 48 * 48;
    const instBuckets: Record<'ammo' | 'med' | 'shield', Array<{ x: number; y: number; z: number; spin: number }>> = {
      ammo: [], med: [], shield: [],
    };
    for (const item of match.loot.items) {
      seen.add(item.id);
      if (item.kind !== 'weapon') {
        const key = item.kind === 'ammo' ? 'ammo' : item.heal?.itemId === 'medkit' ? 'med' : 'shield';
        instBuckets[key]!.push({ x: item.x, y: lootRenderY(item.y, 'consumable'), z: item.z, spin: item.yaw });
        continue;
      }
      let view = this.lootViews.get(item.id);
      if (!view) {
        view = {
          ...this.lootViewFor(item),
        };
        view.root.position.set(item.x, item.y, item.z);
        this.lootViews.set(item.id, view);
        this.group.add(view.root);
      }
      // Distance-cull the item model and its attached hologram together.  A
      // floating beacon would be cheap to spot but was the source of the
      // distracting vertical light column this presentation replaces.
      const dx = item.x - this.viewPos.x;
      const dz = item.z - this.viewPos.z;
      const nearby = dx * dx + dz * dz < farSqr;
      if (view.inner) view.inner.visible = nearby;
      if (view.hologram) view.hologram.visible = nearby;
      // Fixed believable orientation — floor loot never spins.
      view.root.rotation.y = item.yaw;
      // Pop-out simulation updates all three axes. Keeping only Y in sync
      // left the rendered gun at its spawn point while pickup/LOS logic used
      // its moving world position.
      view.root.position.set(item.x, lootRenderY(item.y, 'weapon'), item.z);
    }
    // Flush consumable loot into the shared instanced pools.
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const key of ['ammo', 'med', 'shield'] as const) {
      const mesh = this.lootInst[key] ?? this.lootInstMesh(key);
      const items = instBuckets[key]!;
      const n = Math.min(items.length, mesh.instanceMatrix.count);
      for (let i = 0; i < n; i++) {
        const it = items[i]!;
        q.setFromAxisAngle(up, it.spin);
        m4.compose(pos.set(it.x, it.y, it.z), q, one);
        mesh.setMatrixAt(i, m4);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = n > 0;
    }
    for (const [id, view] of this.lootViews) {
      if (!seen.has(id)) {
        disposeWeaponHologram(view.hologram);
        this.group.remove(view.root);
        this.lootViews.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Storm wall + transport
  // -------------------------------------------------------------------------

  private buildStorm(): void {
    const geo = new THREE.CylinderGeometry(1, 1, 260, 72, 1, true);
    const mat = new THREE.ShaderMaterial({
      vertexShader: STORM_VERT,
      fragmentShader: STORM_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 1 },
        uColorA: { value: new THREE.Color(0xd2b4ff) },
        uColorB: { value: new THREE.Color(0x5426bd) },
      },
    });
    this.stormMesh = new THREE.Mesh(geo, mat);
    this.stormMesh.position.y = 70;
    this.stormMesh.visible = false;
    this.stormMesh.renderOrder = 5;
    this.group.add(this.stormMesh);
  }

  syncStorm(match: Match): void {
    if (match.storm.state === 'idle') {
      this.stormMesh.visible = false;
      return;
    }
    const me = match.player;
    const mat = this.stormMesh.material as THREE.ShaderMaterial;
    if (!me) {
      this.stormMesh.visible = false;
      return;
    }
    // The wall stays visible from anywhere with line of sight — players must
    // always be able to read the enclosing boundary, not discover it at 30 m.
    const distOutside = match.storm.distanceOutside(me.body.position.x, me.body.position.z);
    const closeness = distOutside >= 0 ? 1 : Math.max(0, Math.min(1, 1 + distOutside / 60));
    this.stormMesh.visible = true;
    this.stormMesh.position.x = match.storm.centerX;
    this.stormMesh.position.z = match.storm.centerZ;
    this.stormMesh.scale.set(match.storm.radius, 1, match.storm.radius);
    mat.uniforms['uIntensity']!.value = Math.min(1.15, (0.5 + closeness * 0.5) * (0.92 + Math.sin(this.time * 1.4) * 0.08));
  }

  private buildTransport(): void {
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x42566f, roughness: 0.42, metalness: 0.7 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c2633, roughness: 0.48, metalness: 0.72 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xa87332, roughness: 0.34, metalness: 0.84 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x0c1218, emissive: 0x53e0ff, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.5,
    });
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(3.4, 14, 6, 14), hullMat);
    hull.geometry.rotateZ(Math.PI / 2);
    hull.castShadow = true;
    const wingL = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.3, 7), darkMat);
    wingL.position.set(-2, 0.6, 5.4);
    wingL.rotation.z = 0.16;
    wingL.castShadow = true;
    const wingR = wingL.clone();
    wingR.position.z = -5.4;
    wingR.rotation.z = -0.16;
    const engineGlow = new THREE.Mesh(new THREE.SphereGeometry(1.15, 12, 10), glassMat);
    engineGlow.position.set(-9.6, 0, 0);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(3.4, 4.4, 0.3), darkMat);
    fin.position.set(6.4, 2.4, 0);
    fin.castShadow = true;
    // Structural hoops and a raised cockpit break up the old featureless
    // capsule silhouette. These pieces share the hull axes, so the ship still
    // reads clearly from the high transport camera at normal gameplay scale.
    const hoops: THREE.Mesh[] = [];
    for (const hx of [-4.6, 0, 4.6]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(3.55, 0.14, 6, 18), trimMat);
      hoop.geometry.rotateY(Math.PI / 2);
      hoop.position.x = hx;
      hoop.castShadow = true;
      hoops.push(hoop);
    }
    const cockpit = new THREE.Mesh(new THREE.CapsuleGeometry(1.4, 2.4, 4, 10), glassMat);
    cockpit.geometry.rotateZ(Math.PI / 2);
    cockpit.position.set(4.4, 2.8, 0);
    cockpit.scale.set(1, 0.58, 1.25);
    const cargoCabin = new THREE.Mesh(new THREE.BoxGeometry(6.4, 2.2, 3.8), darkMat);
    cargoCabin.position.set(-0.5, -3.2, 0);
    cargoCabin.castShadow = true;
    const cabinWindowL = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.75, 0.12), glassMat);
    cabinWindowL.position.set(-0.5, -3.05, 1.96);
    const cabinWindowR = cabinWindowL.clone();
    cabinWindowR.position.z = -1.96;
    const nacelles: THREE.Object3D[] = [];
    for (const nz of [-5.3, 5.3]) {
      const nacelle = new THREE.Mesh(new THREE.CapsuleGeometry(0.85, 3.2, 4, 10), darkMat);
      nacelle.geometry.rotateZ(Math.PI / 2);
      nacelle.position.set(-3.4, -0.1, nz);
      nacelle.castShadow = true;
      const exhaust = new THREE.Mesh(new THREE.SphereGeometry(0.72, 12, 8), glassMat);
      exhaust.scale.set(0.65, 1, 1);
      exhaust.position.set(-5.45, -0.1, nz);
      nacelles.push(nacelle, exhaust);
    }
    const dorsalRail = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.16, 0.22), trimMat);
    dorsalRail.position.set(-0.4, 3.45, 0);
    // running lights
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff5f5f });
    for (const bz of [4.4, -4.4]) {
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), beaconMat);
      beacon.position.set(3.2, 2.2, bz);
      this.transportGroup.add(beacon);
    }
    this.transportGroup.add(
      hull, wingL, wingR, engineGlow, fin,
      ...hoops, cockpit, cargoCabin, cabinWindowL, cabinWindowR, ...nacelles, dorsalRail,
    );
    this.transportGroup.visible = false;
    this.group.add(this.transportGroup);
  }

  /** Feed the viewer position so the static-light pool can follow. */
  setViewPos(pos: THREE.Vector3): void {
    this.viewPos.copy(pos);
  }

  /** True when a world-space point is below any water surface. */
  isEyeUnderwater(p: THREE.Vector3): boolean {
    for (const w of this.waterVolumes) {
      if (p.x >= w.minX && p.x <= w.maxX && p.z >= w.minZ && p.z <= w.maxZ && p.y < w.surfaceY) return true;
    }
    return false;
  }

  /** Per-frame updates driven by the game loop. */
  update(dt: number, match: Match, presentationTransport?: PresentationTransport): void {
    this.time += dt;
    this.vista.update(this.viewPos, this.time);
    this.lightPool.update(dt, this.viewPos);
    this.animateWater(this.time);
    this.syncLoot(match);
    this.syncChests(match);
    this.syncDestructibles(match);
    this.syncStorm(match);
    const stormMat = this.stormMesh.material as THREE.ShaderMaterial;
    stormMat.uniforms['uTime']!.value = this.time;

    if (match.phase === 'transport') {
      this.transportGroup.visible = true;
      const transportPosition = presentationTransport?.position ?? match.transportPos;
      this.transportGroup.position.copy(transportPosition);
      // Model's long axis is +X; align it with the flight direction.
      this.transportGroup.rotation.y = presentationTransport?.yaw ?? Math.atan2(
        -(match.transportTo[1] - match.transportFrom[1]),
        match.transportTo[0] - match.transportFrom[0],
      );
      const blink = Math.sin(this.time * 5.2) > 0.2 ? 1 : 0.15;
      this.transportGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && (mesh.material as THREE.MeshBasicMaterial).color?.getHexString() === 'ff5f5f') {
          (mesh.material as THREE.MeshBasicMaterial).transparent = true;
          (mesh.material as THREE.MeshBasicMaterial).opacity = blink;
        }
      });
    } else {
      this.transportGroup.visible = false;
    }
  }

  /** Release only resources owned by this match view. Shared libraries and
   * weapon archetypes use explicit ownership markers/lifetimes. */
  dispose(): void {
    this.vista.dispose();
    this.group.remove(this.vista.group);
    this.weaponFactory.dispose();

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.group.traverse((object) => {
      const asMesh = object as THREE.Mesh;
      const asLine = object as THREE.Line;
      if (!asMesh.isMesh && !asLine.isLine) return;
      const renderable = object as THREE.Mesh;
      const geometry = renderable.geometry;
      if (geometry && !geometry.userData.externalShared && !geometry.userData.weaponFactoryOwned) {
        geometries.add(geometry);
      }
      const material = renderable.material;
      const list = Array.isArray(material) ? material : material ? [material] : [];
      for (const mat of list) {
        if (!mat.userData.externalShared && !mat.userData.weaponFactoryOwned) materials.add(mat);
        const map = (mat as THREE.Material & { map?: THREE.Texture | null }).map;
        if (map?.userData.worldViewOwned) textures.add(map);
      }
    });
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    this.destructibleMeshes.clear();
    this.chestMats.clear();
    this.chestSlots.clear();
    this.lootViews.clear();
    this.group.clear();
  }
}

/** Pull bright GLTF canopy greens down to the overcast moor palette. */
function moorTint(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.color) return;
  // Only tint foliage cutouts/green materials; white-mapped bark buckets must
  // retain their brown atlas colour.
  const c = std.color;
  // The source kit marks bark as MASK too, despite an opaque bark atlas.
  // Identify leaves by their texture/material name so bark does not receive
  // foliage emissive fill or a pale green tint.
  const materialIdentity = `${std.name ?? ''}|${std.map?.name ?? ''}`;
  const foliageCutout = /leaf/i.test(materialIdentity);
  const explicitGreen = c.g > c.r * 1.04 && c.g > c.b * 1.04;
  if (!foliageCutout && !explicitGreen) return;
  if (explicitGreen) c.lerp(new THREE.Color(0x7f8763), 0.46);
  else c.setRGB(1.02, 1.05, 0.94);
  // Overcast leaf cards receive little direct light and formerly collapsed
  // into black rectangles. A restrained indirect-value floor restores the
  // canopy volume without turning it into a self-lit prop.
  if (std.emissive) {
    std.emissive.set(0x182014);
    std.emissiveIntensity = Math.max(std.emissiveIntensity ?? 0, 0.08);
  }
  if (std.roughness !== undefined) std.roughness = Math.min(1, std.roughness + 0.05);
}

/** Gentle moor pass for ground foliage — keeps tufts readable, not black blobs. */
function moorTintSoft(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.color) return;
  const c = std.color;
  if (c.g > c.r && c.g > c.b) {
    c.lerp(new THREE.Color(0x8a905e), 0.3);
  } else if (std.map && c.r > 0.85 && c.g > 0.85 && c.b > 0.85) {
    c.setRGB(1.22, 1.28, 1.1);
  }
  if (std.emissive) {
    std.emissive.set(0x182014);
    std.emissiveIntensity = Math.max(std.emissiveIntensity ?? 0, 0.1);
  }
}

/** Preserve wetland undergrowth colour while preventing black card undersides. */
function wetlandTintSoft(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.color) return;
  const c = std.color;
  if (c.g > c.r && c.g > c.b) c.lerp(new THREE.Color(0x768960), 0.18);
  if (std.emissive) {
    std.emissive.set(0x122014);
    std.emissiveIntensity = Math.max(std.emissiveIntensity ?? 0, 0.07);
  }
}

/** Warm shared rock assets into ASHARA's dry sandstone/basalt range. */
function desertRockTint(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.color) return;
  retoneRockMap(std, 0xa48466, 0.88);
  std.emissive.set(0x392819);
  std.emissiveIntensity = 0.24;
  if (std.roughness !== undefined) std.roughness = Math.max(0.92, std.roughness);
  if (std.metalness !== undefined) std.metalness = Math.min(0.02, std.metalness);
}

/** Lift shared rocks out of EDEN's black-green foliage while keeping a damp tone. */
function wetlandRockTint(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.color) return;
  retoneRockMap(std, 0x879088, 0.82);
  std.emissive.set(0x283029);
  std.emissiveIntensity = 0.22;
  if (std.roughness !== undefined) std.roughness = Math.max(0.94, std.roughness);
  if (std.metalness !== undefined) std.metalness = Math.min(0.01, std.metalness);
}

/** Warm shared rocks toward OLD FRONT's weathered stone and moor palette. */
function moorRockTint(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.color) return;
  retoneRockMap(std, 0x9c9489, 0.86);
  std.emissive.set(0x514c45);
  std.emissiveIntensity = 0.3;
  if (std.roughness !== undefined) std.roughness = Math.max(0.96, std.roughness);
  if (std.metalness !== undefined) std.metalness = Math.min(0.01, std.metalness);
}

/**
 * The bundled rock atlas contains dark moss-green albedo baked into many UV
 * islands. Material colour can only multiply that texture, so a warm tint
 * still rendered as a near-black green silhouette. Rebuild the owned map by
 * retaining the source luminance/detail and mapping its hue into the biome.
 */
function retoneRockMap(std: THREE.MeshStandardMaterial, color: number, amount: number): void {
  const source = std.map;
  const srcImg = source?.source?.data as ImageBitmap | HTMLImageElement | undefined;
  const width = srcImg && 'width' in srcImg ? srcImg.width : 0;
  const height = srcImg && 'height' in srcImg ? srcImg.height : 0;
  if (!source || !srcImg || !width || !height) {
    std.color.lerp(new THREE.Color(color), amount);
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(srcImg, 0, 0);
  let image: ImageData;
  try {
    image = ctx.getImageData(0, 0, width, height);
  } catch {
    std.color.lerp(new THREE.Color(color), amount);
    return;
  }

  const target = new THREE.Color(color);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    const luminance = (r * 0.22 + g * 0.64 + b * 0.14) / 255;
    // Preserve cracks and broad planes, but keep the darkest authored moss
    // above silhouette-black so the indirect-light side remains readable.
    const pixel = i / 4;
    const px = pixel % width;
    const py = Math.floor(pixel / width);
    // Two cheap deterministic scales retain atlas detail even on UV islands
    // whose authored moss colour was nearly uniform.
    const coarse = ((((Math.floor(px / 48) * 73) ^ (Math.floor(py / 48) * 151)) & 255) / 255 - 0.5) * 0.12;
    const fine = ((((Math.floor(px / 9) * 29) ^ (Math.floor(py / 9) * 61)) & 255) / 255 - 0.5) * 0.035;
    const value = 0.76 + Math.min(1, Math.max(0, luminance)) * 0.4 + coarse + fine;
    const tr = target.r * 255 * value;
    const tg = target.g * 255 * value;
    const tb = target.b * 255 * value;
    d[i] = r + (tr - r) * amount;
    d[i + 1] = g + (tg - g) * amount;
    d[i + 2] = b + (tb - b) * amount;
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = source.flipY;
  texture.colorSpace = source.colorSpace;
  texture.wrapS = source.wrapS;
  texture.wrapT = source.wrapT;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  texture.userData.worldViewOwned = true;
  std.map = texture;
  // The source atlas contains useful cracks and strata but previously only
  // affected albedo. Reusing it at restrained strength gives grazing light a
  // material response without fabricating a normal map or changing geometry.
  std.bumpMap = texture;
  std.bumpScale = 0.085;
  std.color.set(0xffffff);
  std.needsUpdate = true;
}

/**
 * Clone only the scene graph for the visual shell; the weapon factory owns
 * the source geometries and materials.  The shell gets per-loot materials so
 * each world item can be released when it is picked up without touching the
 * shared weapon archetypes.
 */
function buildWeaponHologram(source: THREE.Object3D, colorHex: number, rarityRank: number): THREE.Object3D | undefined {
  const shell = source.clone(true);
  shell.name = 'weapon-rarity-hologram';
  // Common weapons stay readable but do not look like a beacon.  Higher
  // tiers gain a little more edge energy, never a separate light source.
  const opacity = 0.14 + Math.max(0, rarityRank) * 0.022;
  shell.scale.multiplyScalar(1.018);
  shell.renderOrder = 1;
  shell.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const hasNormals = mesh.geometry.getAttribute('normal') !== undefined;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.material = materials.map(() => makeWeaponHologramMaterial(colorHex, opacity, hasNormals));
    mesh.renderOrder = 1;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });
  return shell;
}

function makeWeaponHologramMaterial(colorHex: number, opacity: number, hasNormals: boolean): THREE.Material {
  if (!hasNormals) {
    // A malformed/very small imported mesh may not carry normals.  Keep it
    // visible as a quiet silhouette instead of failing the whole shell.
    const fallback = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: opacity * 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    fallback.userData.weaponHologram = true;
    return fallback;
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: RARITY_HOLOGRAM_VERT,
    fragmentShader: RARITY_HOLOGRAM_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uOpacity: { value: opacity },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  material.userData.weaponHologram = true;
  return material;
}

function disposeWeaponHologram(root: THREE.Object3D | undefined): void {
  if (!root) return;
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (material.userData.weaponHologram) materials.add(material);
    }
  });
  for (const material of materials) material.dispose();
}

/** Shared ground-loot materials (one instance per look — draw-call/GC budget). */
const lootMats = {
  ammoBox: new THREE.MeshStandardMaterial({ color: 0x4a5038, roughness: 0.7, metalness: 0.2 }),
  ammoStripe: new THREE.MeshStandardMaterial({ color: 0x101114, emissive: 0xd8c86a, emissiveIntensity: 0.8 }),
  medBox: new THREE.MeshStandardMaterial({
    color: 0xe8ecef, roughness: 0.5, metalness: 0.3, emissive: 0x882030, emissiveIntensity: 0.5,
  }),
  shieldBox: new THREE.MeshStandardMaterial({
    color: 0x244a66, roughness: 0.5, metalness: 0.3, emissive: 0x10406a, emissiveIntensity: 0.5,
  }),
  crossMed: new THREE.MeshBasicMaterial({ color: 0xff5f6d }),
  crossShield: new THREE.MeshBasicMaterial({ color: 0x53d8ff }),
  glowMed: new THREE.MeshBasicMaterial({ color: 0xff8088 }),
  glowShield: new THREE.MeshBasicMaterial({ color: 0x53d8ff }),
};
for (const m of Object.values(lootMats)) {
  (m.userData as { shared?: boolean }).shared = true;
  m.userData.externalShared = true;
}

/** Shared radial-gradient canvas texture (lamp pools etc.). */
export function makeGlowTexture(rgbPrefix: string, size: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2 - 2);
  grad.addColorStop(0, `${rgbPrefix}0.55)`);
  grad.addColorStop(1, `${rgbPrefix}0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.worldViewOwned = true;
  return tex;
}
