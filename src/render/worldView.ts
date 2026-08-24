/**
 * WorldView: builds the renderable scene from a MapDef + Match state using
 * redistributed CC0 model assets (Quaternius nature, Kenney vehicles —
 * see docs/ASSET_MANIFEST.md): instanced vegetation, detailed vehicles,
* tiered chest presentation, rarity loot presentation, animated storm wall
 * and shader water. Simulation state is read-only.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MapDef, MatKey } from '../world/types';
import type { MaterialLibrary } from './materials';
import { PropLibrary, scatterMatrix } from './props';
import { WeaponModelFactory } from './weaponModels';
import type { Match } from '../sim/match';
import { RARITY_COLORS } from '../core/balance';

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
    // vertical fade: strong at eye level, fading at top
    float vertFade = smoothstep(0.95, 0.25, vUv.y) * smoothstep(0.02, 0.12, vUv.y);
    // scrolling energy bands (two directions)
    float band = sin(vUv.x * 90.0 - uTime * 2.2 + sin(vUv.y * 22.0)) * 0.5 + 0.5;
    band *= 0.55 + 0.45 * sin(vUv.y * 34.0 - uTime * 1.4);
    // crackle noise streaks
    vec2 cell = vec2(floor(vUv.x * 140.0), floor(vUv.y * 26.0));
    float n = hash(cell + vec2(floor(uTime * 9.0), 0.0));
    float crackle = step(0.82, n) * (0.6 + 0.4 * sin(uTime * 22.0));
    float energy = band * (0.35 + crackle);
    vec3 col = mix(uColorB, uColorA, clamp(energy * 1.5, 0.0, 1.0));
    float alpha = vertFade * (0.16 + energy * 0.30) * uIntensity;
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
  uniform float uTime;
  varying vec3 vWPos;
  varying vec3 vNormalW;

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vWPos);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);

    // sun glint (blinn)
    vec3 h = normalize(uSunDir + v);
    float spec = pow(max(dot(n, h), 0.0), 240.0);

    // ripple sparkle bands
    float ripple = sin(vWPos.x * 2.4 + uTime * 1.8) * sin(vWPos.z * 2.1 - uTime * 1.3);
    float sparkle = smoothstep(0.86, 1.0, ripple) * 0.5;

    vec3 base = mix(uShallowColor, uDeepColor, clamp(fres, 0.0, 1.0) * 0.85);
    vec3 sky = mix(base, uSkyColor, fres * 0.85);
    vec3 col = sky + uSunColor * spec * 2.2 + uSkyColor * sparkle;

    float alpha = mix(0.86, 0.97, fres);
    // shoreline foam: brighten near plane edges (uv-based via world bounds passed as uniforms)
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
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
  private sources: Array<{ x: number; y: number; z: number; color: number; intensity: number; range: number }> = [];
  private timer = 0;

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 1.7);
      this.pool.push(l);
      this.group.add(l);
    }
  }

  add(x: number, y: number, z: number, color: number, intensity: number, range: number): void {
    this.sources.push({ x, y, z, color, intensity, range });
  }

  update(dt: number, viewPos: THREE.Vector3): void {
    this.timer -= dt;
    if (this.timer > 0 || this.sources.length === 0) return;
    this.timer = 0.25;
    // Score by distance; take the closest ones.
    const scored = this.sources.map((s, idx) => {
      const d2 = (s.x - viewPos.x) ** 2 + (s.z - viewPos.z) ** 2;
      return { idx, d2, s };
    });
    scored.sort((a, b) => a.d2 - b.d2);
    const n = Math.min(this.pool.length, scored.length);
    for (let i = 0; i < this.pool.length; i++) {
      const light = this.pool[i]!;
      if (i < n) {
        const s = scored[i]!.s;
        const fade = Math.min(1, Math.max(0, 1 - Math.sqrt(scored[i]!.d2) / (s.range * 1.35)));
        light.position.set(s.x, s.y, s.z);
        light.color.setHex(s.color);
        light.intensity = s.intensity * (0.35 + 0.65 * fade);
        light.distance = s.range;
      } else {
        light.intensity = 0;
      }
    }
  }
}

export class WorldView {
  readonly group = new THREE.Group();
  private destructibleMeshes = new Map<number, THREE.Object3D>();
  private chestMats = new Map<number, { body: THREE.MeshStandardMaterial; trim: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial }>();
  private lootViews = new Map<number, { root: THREE.Group; inner: THREE.Object3D | null; beam?: THREE.Mesh; ring?: THREE.Mesh; phase: number }>();
  stormMesh!: THREE.Mesh;
  readonly transportGroup = new THREE.Group();
  private time = 0;
  private waterMats: THREE.ShaderMaterial[] = [];
  private waterVolumes: import('../world/types').WaterVolume[] = [];
  private weaponFactory: WeaponModelFactory;
  private lightPool = new StaticLightPool(22);
  private viewPos = new THREE.Vector3();

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
    this.buildScatter(def, props);
    this.buildVehicles(def, props);
    this.buildWater(def);
    if (match) {
      this.trackDestructibles(match, props);
      this.trackChests(match);
      this.buildStorm();
      this.buildTransport();
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
        m.roughness = Math.min(0.42, (m.userData.baseRoughness as number) * 0.45);
        m.envMapIntensity = 1.5;
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
      this.addInstancedByGrid(key, matrices, props, 4096, def.sky.preset !== 'overcast');
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
      const count = def.id === 'eden' ? 4 : 3;
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
          new THREE.Vector3(l.x + 0.78, 0.07, l.z),
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
    for (const [, list] of byCell) {
      for (const mesh of props.makeInstanced(key, list.length)) {
        list.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
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
      g.add(tmpl);
      g.position.set(v.x, v.y, v.z);
      g.rotation.y = v.yaw;
      // Wrecked cars get a smoke wisp marker (light handled by sim events)
      if (v.variant !== 'wrecked') {
        const glassTint = new THREE.MeshPhysicalMaterial({ visible: false });
        void glassTint;
      }
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
        uniforms: {
          uTime: { value: 0 },
          uDeepColor: { value: new THREE.Color(def.sky.preset === 'night' || def.sky.preset === 'bluehour' ? 0x0a1a2e : 0x14486b) },
          uShallowColor: { value: new THREE.Color(def.sky.preset === 'night' || def.sky.preset === 'bluehour' ? 0x123248 : 0x2f7d9e) },
          uSkyColor: { value: new THREE.Color(def.sky.fogColor) },
          uSunDir: { value: new THREE.Vector3(...def.sky.sunDirection).normalize() },
          uSunColor: { value: new THREE.Color(def.sky.sunColor) },
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
        const yaw = (g as unknown as { yaw?: number }).yaw ?? 0;
        mesh.rotation.y = yaw;
      } else {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(g.r ?? 0.5, g.r ?? 0.5, g.h ?? 1, 10), material);
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
   * chest). Lid animation + halo fade run through per-instance matrices.
   */
  private chestInst: Array<{
    body: THREE.InstancedMesh; trim: THREE.InstancedMesh; lock: THREE.InstancedMesh;
    lidBody: THREE.InstancedMesh; lidTrim: THREE.InstancedMesh; core: THREE.InstancedMesh;
    halo: THREE.InstancedMesh | null;
    mats: { body: THREE.MeshStandardMaterial; trim: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial };
  } | null> = [null, null, null];
  private chestSlots = new Map<number, {
    tier: number; idx: number; pos: THREE.Vector3; yaw: number; lidAngle: number; opened: boolean; haloScale: number;
  }>();

  private trackChests(match: Match): void {
    const counts = [0, 0, 0];
    for (const c of match.chests) counts[c.kind === 'vault' ? 2 : c.kind === 'elite' ? 1 : 0]!++;
    for (let tier = 0; tier < 3; tier++) {
      if (this.chestInst[tier] || counts[tier] === 0) continue;
      const glowHex = tier === 2 ? 0xffb43a : tier === 1 ? 0xb06ce8 : 0x4f9fe8;
      let cached = this.chestMats.get(tier);
      if (!cached) {
        const trimMat = new THREE.MeshStandardMaterial({
          color: 0x111214, emissive: glowHex, emissiveIntensity: 1.5 + tier * 0.5, roughness: 0.35, metalness: 0.5,
        });
        const accentMat = trimMat.clone();
        const bodyMat = new THREE.MeshStandardMaterial({
          color: tier === 2 ? 0x2b2320 : tier === 1 ? 0x242430 : 0x27343c, roughness: 0.42, metalness: 0.72,
        });
        for (const m of [trimMat, accentMat, bodyMat]) (m.userData as { shared?: boolean }).shared = true;
        cached = { body: bodyMat, trim: trimMat, accent: accentMat };
        this.chestMats.set(tier, cached);
      }
      const n = counts[tier]!;
      // static base (body) — lid pivot at (0,0.72,0), children baked relative
      const baseGeo = new THREE.BoxGeometry(1.46, 0.68, 0.96);
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
      const trimGeo = mergeGeometries([skirt, ...brackets])!;
      // lock cylinder (static, accent)
      const lockGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.08, 10);
      lockGeo.rotateX(Math.PI / 2);
      lockGeo.translate(0, 0.62, -0.5);
      // lid parts — translated relative to the lid pivot (0, 0.72, 0)
      const lidBodyGeo = new THREE.BoxGeometry(1.5, 0.34, 0.99);
      lidBodyGeo.translate(0, 0.17, 0);
      const lidTrimGeo = new THREE.BoxGeometry(1.54, 0.12, 0.1);
      lidTrimGeo.translate(0, 0.17, -0.47);
      const coreGeo = new THREE.SphereGeometry(0.13 + tier * 0.03, 10, 8);
      coreGeo.translate(0, 0.17, 0.42);
      const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
        const im = new THREE.InstancedMesh(geo, mat, n);
        im.castShadow = shadow;
        im.receiveShadow = shadow;
        im.frustumCulled = false;
        this.group.add(im);
        return im;
      };
      let halo: THREE.InstancedMesh | null = null;
      if (tier > 0) {
        const haloGeo = new THREE.TorusGeometry(0.62 + tier * 0.1, 0.022 + tier * 0.008, 8, 40);
        haloGeo.rotateX(Math.PI / 2);
        haloGeo.translate(0, 1.55 + tier * 0.12, 0);
        halo = mk(haloGeo, new THREE.MeshBasicMaterial({
          color: glowHex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
        }), false);
        halo.renderOrder = 2;
      }
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
    let nextIdx: number[] = [0, 0, 0];
    for (const c of match.chests) {
      if (this.chestSlots.has(c.id)) continue;
      const tier = c.kind === 'vault' ? 2 : c.kind === 'elite' ? 1 : 0;
      const idx = nextIdx[tier]!;
      nextIdx[tier] = idx + 1;
      this.chestSlots.set(c.id, {
        tier, idx,
        pos: new THREE.Vector3(c.x, c.y, c.z),
        yaw: Math.abs(Math.round((c.x * 13.7 + c.z * 7.3))) * 0.61 % (Math.PI * 2),
        lidAngle: 0, opened: false, haloScale: 1,
      });
    }
    // write static transforms once (base/trim/lock/halo base matrices)
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
    const zero = new THREE.Vector3(0.0001, 0.0001, 0.0001);
    const pulseByTier = [false, false, false];
    for (const c of match.chests) {
      const s = this.chestSlots.get(c.id);
      if (!s) continue;
      const inst = this.chestInst[s.tier]!;
      const targetLid = -Math.min(1, c.openT * 1.6) * 1.85;
      s.lidAngle += (targetLid - s.lidAngle) * 0.14;
      s.opened = c.opened;
      if (!c.opened) pulseByTier[s.tier] = true;
      qy.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw);
      // lid: chest transform · translate(pivot) · rotateX(angle)
      m4.compose(s.pos, qy, one);
      const lidM = m4.clone().multiply(new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z));
      qx.setFromAxisAngle(new THREE.Vector3(1, 0, 0), s.lidAngle);
      lidM.multiply(new THREE.Matrix4().makeRotationFromQuaternion(qx));
      inst.lidBody.setMatrixAt(s.idx, lidM);
      inst.lidTrim.setMatrixAt(s.idx, lidM);
      inst.core.setMatrixAt(s.idx, lidM);
      // halo shrinks away once opened
      if (inst.halo) {
        s.haloScale = Math.max(0, s.haloScale - this.timeDelta() * (s.opened ? 1.4 : 0));
        m4.compose(s.pos, qy, s.haloScale < 1 ? new THREE.Vector3().setScalar(Math.max(0.0001, s.haloScale)) : one);
        inst.halo.setMatrixAt(s.idx, m4);
      }
    }
    for (let tier = 0; tier < 3; tier++) {
      const inst = this.chestInst[tier];
      if (!inst) continue;
      inst.lidBody.instanceMatrix.needsUpdate = true;
      inst.lidTrim.instanceMatrix.needsUpdate = true;
      inst.core.instanceMatrix.needsUpdate = true;
      if (inst.halo) inst.halo.instanceMatrix.needsUpdate = true;
      const pulse = 1 + Math.sin(this.time * 2.6) * 0.12;
      const e = pulseByTier[tier] ? 1.5 + pulse * 0.6 : inst.mats.trim.emissiveIntensity * Math.exp(-this.timeDelta() * 1.4);
      inst.mats.trim.emissiveIntensity = e;
      inst.mats.accent.emissiveIntensity = e;
    }
  }

  private lastFrameTime = 0;
  private timeDelta(): number {
    return Math.max(0.001, this.time - this.lastFrameTime);
  }

  // -------------------------------------------------------------------------
  // Loot presentation: floating items, rarity beams, ground rings.
  // Ammo/heals render through shared instanced pools (draw-call budget);
  // weapons keep individual models with rarity beams (distance-culled).
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

  private lootViewFor(item: import('../sim/loot').WorldItem): { root: THREE.Group; inner: THREE.Object3D | null; beam?: THREE.Mesh; ring?: THREE.Mesh } {
    const root = new THREE.Group();
    const rarityRank = ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(item.rarity);
    const glowHex = RARITY_COLORS[item.rarity];

    // Weapons only — consumables render through the shared instanced pools.
    let inner: THREE.Object3D | null = null;
    if (item.kind === 'weapon' && item.weapon) {
      const wm = this.weaponFactory.buildWorldScale(item.weapon.weaponId, item.rarity);
      if (wm) inner = wm.group;
    }
    if (inner) root.add(inner);

    // Rarity presentation: beam + ground ring scale with rarity
    let beam: THREE.Mesh | undefined;
    let ring: THREE.Mesh | undefined;
    if (item.kind === 'weapon' && rarityRank >= 1) {
      const beamH = 3.4 + rarityRank * 0.7;
      const beamGeo = new THREE.CylinderGeometry(0.16, 0.3, beamH, 12, 1, true);
      beamGeo.translate(0, beamH / 2, 0);
      beam = new THREE.Mesh(beamGeo, makeBeamMaterial(glowHex, 0.16 + rarityRank * 0.05));
      beam.position.y = 0.1;
      beam.renderOrder = 2;
      const ringGeo = new THREE.RingGeometry(0.42, 0.58, 28);
      ringGeo.rotateX(-Math.PI / 2);
      ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: glowHex, transparent: true, opacity: 0.5 + rarityRank * 0.08,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      ring.renderOrder = 2;
      root.add(beam, ring);
    }
    return { root, inner, beam, ring };
  }

  syncLoot(match: Match): void {
    const seen = new Set<number>();
    const farSqr = 48 * 48;
    const instBuckets: Record<'ammo' | 'med' | 'shield', Array<{ x: number; y: number; z: number; spin: number }>> = {
      ammo: [], med: [], shield: [],
    };
    for (const item of match.loot.items) {
      seen.add(item.id);
      const bob = Math.sin(this.time * 2.1 + item.id * 1.7) * 0.09 + 0.62;
      if (item.kind !== 'weapon') {
        const key = item.kind === 'ammo' ? 'ammo' : item.heal?.itemId === 'medkit' ? 'med' : 'shield';
        instBuckets[key]!.push({ x: item.x, y: item.y + bob, z: item.z, spin: this.time * (item.kind === 'heal' ? 0.8 : 0.55) + item.id });
        continue;
      }
      let view = this.lootViews.get(item.id);
      if (!view) {
        view = { ...this.lootViewFor(item), phase: Math.random() * Math.PI * 2 };
        view.root.position.set(item.x, item.y, item.z);
        this.lootViews.set(item.id, view);
        this.group.add(view.root);
      }
      // Distance-cull the item model; rarity beams stay visible as far cues.
      const dx = item.x - this.viewPos.x;
      const dz = item.z - this.viewPos.z;
      if (view.inner) view.inner.visible = dx * dx + dz * dz < farSqr;
      const spin = this.time * 0.55 + view.phase;
      view.root.rotation.y = spin;
      const pulse = 1 + Math.sin(this.time * 3.4 + view.phase) * 0.14;
      const beam = view.beam;
      if (beam) {
        (beam.material as THREE.MeshBasicMaterial).opacity =
          (parseFloat(((beam.material as THREE.MeshBasicMaterial).userData.baseOpacity ?? '0.2')) ) * (0.8 + pulse * 0.35);
        beam.rotation.y = -spin * 0.5;
      }
      const ring = view.ring;
      if (ring) {
        ring.scale.setScalar(pulse);
        ring.position.y = 0.06 + bob * 0.1;
      }
      view.root.position.y = item.y + bob;
    }
    // Flush consumable loot into the shared instanced pools.
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (const key of ['ammo', 'med', 'shield'] as const) {
      const mesh = this.lootInst[key] ?? this.lootInstMesh(key);
      const items = instBuckets[key]!;
      const n = Math.min(items.length, mesh.instanceMatrix.count);
      for (let i = 0; i < n; i++) {
        const it = items[i]!;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.spin);
        m4.compose(new THREE.Vector3(it.x, it.y, it.z), q, one);
        mesh.setMatrixAt(i, m4);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = n > 0;
    }
    for (const [id, view] of this.lootViews) {
      if (!seen.has(id)) {
        disposeObject(view.root);
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
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 1 },
        uColorA: { value: new THREE.Color(0x9fd4ff) },
        uColorB: { value: new THREE.Color(0x3a6fd4) },
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
    const distOutside = match.storm.distanceOutside(me.body.position.x, me.body.position.z);
    let proximity: number;
    if (distOutside >= 0) proximity = 1;
    else {
      const d = -distOutside;
      proximity = Math.max(0, Math.min(1, 1 - (d - 4) / 34));
    }
    if (proximity <= 0.01) {
      this.stormMesh.visible = false;
      return;
    }
    this.stormMesh.visible = true;
    this.stormMesh.position.x = match.storm.centerX;
    this.stormMesh.position.z = match.storm.centerZ;
    this.stormMesh.scale.set(match.storm.radius, 1, match.storm.radius);
    mat.uniforms['uIntensity']!.value = Math.min(1.25, proximity * (0.9 + Math.sin(this.time * 1.4) * 0.12));
  }

  private buildTransport(): void {
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.5, metalness: 0.72 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.55, metalness: 0.66 });
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
    // running lights
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff5f5f });
    for (const bz of [4.4, -4.4]) {
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), beaconMat);
      beacon.position.set(3.2, 2.2, bz);
      this.transportGroup.add(beacon);
    }
    this.transportGroup.add(hull, wingL, wingR, engineGlow, fin);
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
  update(dt: number, match: Match): void {
    this.lastFrameTime = this.time;
    this.time += dt;
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
      this.transportGroup.position.set(match.transportPos.x, match.transportPos.y, match.transportPos.z);
      // Model's long axis is +X; align it with the flight direction.
      this.transportGroup.rotation.y = Math.atan2(
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
}

function makeBeamMaterial(color: number, baseOpacity: number): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: baseOpacity, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  (mat.userData as { baseOpacity?: string }).baseOpacity = String(baseOpacity);
  return mat;
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
for (const m of Object.values(lootMats)) (m.userData as { shared?: boolean }).shared = true;

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
  return tex;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => { if (!(m.userData as { shared?: boolean }).shared) m.dispose(); });
      else if (mat && !(mat.userData as { shared?: boolean }).shared) mat.dispose();
    }
  });
}
