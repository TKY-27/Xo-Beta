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
import { VEHICLE_SCALE, type MapDef, type MatKey } from '../world/types';
import type { MaterialLibrary } from './materials';
import { PropLibrary, scatterMatrix } from './props';
import { WeaponModelFactory } from './weaponModels';
import { buildVista, type VistaHandle } from './vista';
import type { Match } from '../sim/match';
import { RARITY_COLORS } from '../core/balance';

export interface PresentationTransport {
  position: THREE.Vector3;
  /** Optional interpolated yaw; falls back to the route direction. */
  yaw?: number;
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
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vWPos);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);

    // sun glint (blinn) — tight lobe, modest gain so grazing water never
    // blows out to a white sheet
    vec3 h = normalize(uSunDir + v);
    float spec = pow(max(dot(n, h), 0.0), 900.0);

    // ripple sparkle bands
    float ripple = sin(vWPos.x * 2.4 + uTime * 1.8) * sin(vWPos.z * 2.1 - uTime * 1.3);
    float sparkle = smoothstep(0.88, 1.0, ripple) * 0.22;

    vec2 local = abs(vWPos.xz - uWaterCenter);
    float edgeDistance = min(uHalfSize.x - local.x, uHalfSize.y - local.y);
    float shoreline = 1.0 - smoothstep(0.0, 4.5, edgeDistance);
    vec3 base = mix(uDeepColor, uShallowColor, shoreline * 0.82 + 0.08);
    vec3 sky = mix(base, uSkyColor, 0.12 + fres * 0.48);
    vec3 col = sky + uSunColor * spec * 0.26 + uSkyColor * sparkle * 0.42;
    col += uShallowColor * shoreline * 0.12;

    float alpha = mix(0.82, 0.94, fres);
    gl_FragColor = vec4(col, alpha);
  }
`;

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
    this.vista = buildVista(def, mats);
    this.group.add(this.vista.group);
    this.buildScatter(def, props);
    this.buildVehicles(def, props);
    this.buildWater(def);
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
    for (const g of def.geo) {
      if (g.noRender) continue;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), g.kind === 'box' ? g.yaw : 0);
      let scale: THREE.Vector3;
      if (g.kind === 'box') scale = new THREE.Vector3(g.sx, g.sy, g.sz);
      else if (g.kind === 'cyl') scale = new THREE.Vector3(g.r, g.h, g.r);
      else scale = new THREE.Vector3(g.r, g.r, g.r);
      const key = g.kind;
      if (!byKind.has(key)) byKind.set(key, new Map());
      const byMat = byKind.get(key)!;
      if (!byMat.has(g.mat)) byMat.set(g.mat, []);
      byMat.get(g.mat)!.push(new THREE.Matrix4().compose(new THREE.Vector3(g.x, g.y, g.z), q, scale));
    }

    const geos: Record<string, THREE.BufferGeometry> = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
      sphere: new THREE.SphereGeometry(1, 12, 10),
    };

    for (const [kind, byMat] of byKind) {
      for (const [mat, matrices] of byMat) {
        const inst = new THREE.InstancedMesh(geos[kind]!, this.mats.get(mat), matrices.length);
        matrices.forEach((m, i) => inst.setMatrixAt(i, m));
        inst.instanceMatrix.needsUpdate = true;
        inst.frustumCulled = false;
        inst.castShadow = true;
        inst.receiveShadow = true;
        this.group.add(inst);
      }
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
      palm: ['tree/CommonTree_3'], // nearest available silhouette
      dead: ['dead/DeadTree_1', 'dead/DeadTree_2', 'dead/DeadTree_4'],
    };
    const buckets = new Map<string, THREE.Matrix4[]>();
    for (const t of def.trees) {
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
      const isSoft = key.startsWith('fern') || key.startsWith('clover') || key.startsWith('bush');
      const tint = def.id === 'oldfront' ? (isTree ? moorTint : isSoft ? moorTintSoft : undefined) : undefined;
      this.addInstancedByGrid(key, matrices, props, 4096, def.sky.preset !== 'overcast', tint);
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
      const count = def.id === 'eden' ? 6 : 3;
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
    if (def.terrainHeight && def.id !== 'neocity') {
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
        const d = r.scale * 0.9 + 0.6 + rnd() * 1.4;
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
      this.addInstancedByGrid(key, ms, props, 4096, false);
    }

    // Rocks → Quaternius rock models
    const rockKeys = ['rock/medium1', 'rock/medium2'];
    const rockBuckets = new Map<string, THREE.Matrix4[]>();
    def.rocks.forEach((r, i) => {
      const key = rockKeys[i % rockKeys.length]!;
      if (!rockBuckets.has(key)) rockBuckets.set(key, []);
      const tiltZ = Math.sin(r.x * 9.1 + r.z * 5.3) * 0.28;
      const tiltX = Math.cos(r.x * 3.7 + r.z * 13.1) * 0.24;
      rockBuckets.get(key)!.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(r.x, r.y + r.scale * 0.12, r.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, r.x * 7.7 + r.z * 3.3, tiltZ)),
          new THREE.Vector3(r.scale * 1.15, r.scale * 0.85, r.scale * 1.05),
        ),
      );
    });
    for (const [key, matrices] of rockBuckets) {
      if (!props.hasVariant(key)) continue;
      this.addInstancedByGrid(key, matrices, props, 4096);
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
    const pick: Record<string, string[]> = {
      sedan: ['sedan', 'sedan-sports', 'hatchback-sports'],
      van: ['van', 'delivery-flat'],
      truck: ['truck'],
      wrecked: ['police', 'suv'],
    };
    for (let i = 0; i < def.vehicles.length; i++) {
      const v = def.vehicles[i]!;
      const options = pick[v.variant] ?? pick.sedan!;
      const key = options[Math.abs(Math.round(v.x * 7.9 + v.z * 3.7)) % options.length]!;
      const tmpl = props.cloneTemplate(`vehicle/${key}`);
      if (!tmpl) continue;
      const tint = new THREE.Color(v.color ?? 0x88929c);
      tmpl.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        const src = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
        const m = src.clone() as THREE.MeshStandardMaterial;
        delete m.userData.externalShared;
        if (m.map && !v.explodable) m.color.copy(new THREE.Color(1, 1, 1));
        if (v.variant === 'wrecked') {
          m.color.multiply(tint).multiplyScalar(0.32);
          m.metalness = 0.4;
          m.roughness = 0.95;
        } else if (m.map) {
          // Kenney colormap cars are white-bodied: tint toward the spec color.
          m.color.multiplyScalar(0.25).lerp(tint, 0.85);
        }
        mesh.material = m;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      const g = new THREE.Group();
      const vs = VEHICLE_SCALE[key] ?? 1.5;
      tmpl.scale.setScalar(vs);
      g.add(tmpl);
      // Keep the same slight wheel-sink as authored (GLB base sits at -0.3).
      g.position.set(v.x, v.y + 0.3 * (vs - 1), v.z);
      g.rotation.y = v.yaw;
      this.group.add(g);
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
          uDeepColor: { value: new THREE.Color(def.sky.preset === 'night' || def.sky.preset === 'bluehour' ? 0x0a1a2e : 0x14486b) },
          uShallowColor: { value: new THREE.Color(def.sky.preset === 'night' || def.sky.preset === 'bluehour' ? 0x123248 : 0x2f7d9e) },
          uSkyColor: { value: new THREE.Color(def.sky.preset === 'day' ? 0x8fb6cc : def.sky.fogColor) },
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
      const glowHex = tier === 2 ? 0xffa632 : tier === 1 ? 0xb878f0 : 0xffc45c;
      let cached = this.chestMats.get(tier);
      if (!cached) {
        const trimMat = new THREE.MeshStandardMaterial({
          color: 0x24211c, emissive: glowHex, emissiveIntensity: 0.55 + tier * 0.2, roughness: 0.35, metalness: 0.5,
        });
        const accentMat = trimMat.clone();
        // Weathered metal bodies remain readable in unlit interiors. Standard
        // crates use the familiar warm-gold language of a valuable chest;
        // higher tiers retain distinct gunmetal/bronze bodies.
        const bodyColor = tier === 2 ? 0x51402c : tier === 1 ? 0x34313d : 0x5b492b;
        const bodyMat = new THREE.MeshStandardMaterial({
          color: bodyColor,
          emissive: new THREE.Color(bodyColor),
          emissiveIntensity: 0.38,
          roughness: 0.62,
          metalness: 0.38,
        });
        for (const m of [trimMat, accentMat, bodyMat]) (m.userData as { shared?: boolean }).shared = true;
        cached = { body: bodyMat, trim: trimMat, accent: accentMat };
        this.chestMats.set(tier, cached);
      }
      const n = counts[tier]!;
      // static base (body) — lid pivot at (0,0.72,0), children baked relative
      const baseGeo = new RoundedBoxGeometry(1.46, 0.68, 0.96, 3, 0.055);
      baseGeo.translate(0, 0.38, 0);
      // static trim: base skirt + 4 corner brackets, merged
      const skirt = new THREE.BoxGeometry(1.52, 0.09, 1.02);
      skirt.translate(0, 0.09, 0);
      const brackets: THREE.BufferGeometry[] = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const b = new THREE.BoxGeometry(0.12, 0.72, 0.12);
        b.translate(sx * 0.67, 0.38, sz * 0.42);
        brackets.push(b);
      }
      // Recessed face bands catch highlights and break up the old featureless
      // box silhouette while remaining one instanced draw.
      for (const y of [0.3, 0.52]) {
        const band = new THREE.BoxGeometry(1.18, 0.055, 0.055);
        band.translate(0, y, -0.495);
        brackets.push(band);
      }
      const trimGeo = mergeGeometries([skirt, ...brackets])!;
      // lock cylinder (static, accent)
      const lockGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.08, 10);
      lockGeo.rotateX(Math.PI / 2);
      lockGeo.translate(0, 0.62, -0.5);
      // Classic arched coffer lid. A half-cylinder creates a continuous
      // silhouette and readable specular roll instead of stacked cuboids.
      // Geometry remains relative to the hinge pivot at (0, 0.72, 0).
      const lidArch = new THREE.CylinderGeometry(0.47, 0.47, 1.5, 18, 1, false, 0, Math.PI);
      lidArch.rotateZ(Math.PI / 2);
      const lidBase = new THREE.BoxGeometry(1.5, 0.08, 0.94);
      lidBase.translate(0, 0.035, 0);
      const lidBodyGeo = mergeGeometries([lidArch, lidBase])!;
      const lidFrontBand = new THREE.BoxGeometry(1.54, 0.1, 0.08);
      lidFrontBand.translate(0, 0.1, -0.46);
      const lidRibs: THREE.BufferGeometry[] = [];
      for (const x of [-0.48, 0, 0.48]) {
        const rib = new THREE.TorusGeometry(0.48, 0.035, 6, 18, Math.PI);
        rib.rotateY(Math.PI / 2);
        rib.translate(x, 0, 0);
        lidRibs.push(rib);
      }
      const lidTrimGeo = mergeGeometries([lidFrontBand, ...lidRibs])!;
      const coreGeo = new RoundedBoxGeometry(0.3 + tier * 0.03, 0.1, 0.045, 2, 0.018);
      coreGeo.translate(0, 0.12, -0.485);
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
      if (inst.halo) inst.halo.setMatrixAt(s.idx, m4);
      const lidM = m4.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.72, 0));
      inst.lidBody.setMatrixAt(s.idx, lidM);
      inst.lidTrim.setMatrixAt(s.idx, lidM);
      inst.core.setMatrixAt(s.idx, lidM);
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
    const pivot = new THREE.Vector3(0, 0.72, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (const c of match.chests) {
      const s = this.chestSlots.get(c.id);
      if (!s) continue;
      const inst = this.chestInst[s.tier]!;
      const targetLid = -Math.min(1, c.openT * 1.6) * 1.85;
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
      inst.core.setMatrixAt(s.idx, lidM);
    }
    for (let tier = 0; tier < 3; tier++) {
      const inst = this.chestInst[tier];
      if (!inst) continue;
      inst.lidBody.instanceMatrix.needsUpdate = true;
      inst.lidTrim.instanceMatrix.needsUpdate = true;
      inst.core.instanceMatrix.needsUpdate = true;
      if (inst.halo) inst.halo.instanceMatrix.needsUpdate = true;
      // Tier materials are shared and intentionally stable. Open-state
      // animation is expressed only through the per-instance lid transform.
      inst.mats.trim.emissiveIntensity = 0.55 + tier * 0.2;
      inst.mats.accent.emissiveIntensity = 0.55 + tier * 0.2;
    }
  }

  // -------------------------------------------------------------------------
  // Loot presentation: floating items and model-attached rarity highlights.
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
      const bob = Math.sin(this.time * 2.1 + item.id * 1.7) * 0.05 + 0.42;
      if (item.kind !== 'weapon') {
        const key = item.kind === 'ammo' ? 'ammo' : item.heal?.itemId === 'medkit' ? 'med' : 'shield';
        instBuckets[key]!.push({ x: item.x, y: item.y + bob, z: item.z, spin: item.yaw });
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
      view.root.position.y = item.y + bob;
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
  // Only tint foliage-ish (green) materials; leave trunks/bark alone.
  const c = std.color;
  if (c.g > c.r && c.g > c.b) {
    c.lerp(new THREE.Color(0x6e7452), 0.62).multiplyScalar(0.9);
  } else if (std.map && c.r > 0.85 && c.g > 0.85 && c.b > 0.85) {
    // Green lives in the albedo texture (ferns/clover) — multiply toward moor.
    c.setRGB(0.78, 0.82, 0.66);
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
