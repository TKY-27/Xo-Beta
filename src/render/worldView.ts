/**
 * WorldView: builds the renderable scene from a MapDef + Match state using
 * redistributed CC0 model assets (Quaternius nature, Kenney vehicles —
 * see docs/ASSET_MANIFEST.md): instanced vegetation, detailed vehicles,
* tiered chest presentation, rarity loot presentation, animated storm wall
 * and shader water. Simulation state is read-only.
 */

import * as THREE from 'three';
import type { MapDef, MatKey } from '../world/types';
import type { MaterialLibrary } from './materials';
import { PropLibrary, scatterMatrix } from './props';
import { WeaponModelFactory } from './weaponModels';
import type { Match } from '../sim/match';
import { RARITY_COLORS, WEAPONS } from '../core/balance';

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

interface ChestView {
  group: THREE.Group;
  lid: THREE.Object3D | null;
  light: THREE.PointLight | null;
  glowMat: THREE.MeshStandardMaterial[];
}

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
  private chestViews = new Map<number, ChestView>();
  private lootViews = new Map<number, { root: THREE.Group; beam?: THREE.Mesh; ring?: THREE.Mesh; phase: number }>();
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
      for (const mesh of props.makeInstanced(key, matrices.length)) {
        matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
        this.group.add(mesh);
      }
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
      const count = def.id === 'eden' ? 5 : 3;
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
      for (const mesh of props.makeInstanced(key, ms.length)) {
        ms.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = false;
        this.group.add(mesh);
      }
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
      for (const mesh of props.makeInstanced(key, matrices.length)) {
        matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
        this.group.add(mesh);
      }
    }

    // Lamps: authored street fixtures
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
    for (let i = 0; i < maxLamps; i++) {
      const l = def.lamps[i]!;
      const post = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.scale.set(1, l.h, 1);
      pole.castShadow = true;
      const arm = new THREE.Mesh(armGeo, poleMat);
      arm.position.set(0.42, l.h - 0.06, 0);
      const head = new THREE.Mesh(headGeo, poleMat);
      head.position.set(0.78, l.h - 0.12, 0);
      head.rotation.z = 0.18;
      const lens = new THREE.Mesh(lensGeo, new THREE.MeshBasicMaterial({ color: l.color }));
      lens.position.set(0.78, l.h - 0.21, 0);
      lens.rotation.z = 0.18;
      post.add(pole, arm, head, lens);
      post.position.set(l.x, l.y, l.z);
      this.group.add(post);
      // Real light comes from the shared pool; the fixture itself is emissive.
      this.lightPool.add(l.x + 0.78, l.y + l.h - 0.35, l.z, l.color, l.intensity * 1.35, l.range);
      if (i < 60) {
        const pool = new THREE.Mesh(poolGeo, new THREE.MeshBasicMaterial({
          map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85,
        }));
        pool.renderOrder = 1;
        pool.position.set(l.x + 0.78, 0.07, l.z);
        pool.scale.setScalar(0.9 + Math.min(0.5, l.range / 60));
        this.group.add(pool);
      }
    }

    for (const l of def.lights) {
      this.lightPool.add(l.x, l.y, l.z, l.color, l.intensity, l.range);
    }
    this.group.add(this.lightPool.group);
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
          uDeepColor: { value: new THREE.Color(def.sky.preset === 'night' ? 0x0a1a2e : 0x14486b) },
          uShallowColor: { value: new THREE.Color(def.sky.preset === 'night' ? 0x123248 : 0x2f7d9e) },
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
      const material = this.mats.get(matKey).clone();
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

  private chestBody(kind: string): ChestView {
    const tier = kind === 'vault' ? 2 : kind === 'elite' ? 1 : 0;
    const glowHex = kind === 'vault' ? 0xffb43a : kind === 'elite' ? 0xb06ce8 : 0x4f9fe8;
    const bodyMat = new THREE.MeshStandardMaterial({ color: tier === 2 ? 0x2b2320 : tier === 1 ? 0x242430 : 0x27343c, roughness: 0.42, metalness: 0.72 });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x111214, emissive: glowHex, emissiveIntensity: 1.5 + tier * 0.5, roughness: 0.35, metalness: 0.5,
    });
    const accentMat = trimMat.clone();

    const g = new THREE.Group();
    // Base with inset panel look
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.68, 0.96), bodyMat);
    base.position.y = 0.38;
    base.castShadow = true;
    base.receiveShadow = true;
    const baseTrim = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.09, 1.02), trimMat);
    baseTrim.position.y = 0.09;
    const lid = new THREE.Group();
    const lidBox = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 0.99), bodyMat);
    lidBox.position.y = 0.17;
    lidBox.castShadow = true;
    const lidTrimFront = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.12, 0.1), trimMat);
    lidTrimFront.position.set(0, 0.17, -0.47);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.13 + tier * 0.03, 10, 8), accentMat);
    core.position.set(0, 0.17, 0.42);
    lid.add(lidBox, lidTrimFront, core);
    lid.name = 'lid';
    lid.position.y = 0.72;
    // corner brackets
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.72, 0.12), trimMat);
        bracket.position.set(sx * 0.67, 0.38, sz * 0.42);
        g.add(bracket);
      }
    }
    const lock = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 10), accentMat);
    lock.rotation.x = Math.PI / 2;
    lock.position.set(0, 0.62, -0.5);
    g.add(base, baseTrim, lid, lock);

    // Tier halo ring above elite/vault chests
    if (tier > 0) {
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.62 + tier * 0.1, 0.022 + tier * 0.008, 8, 40),
        new THREE.MeshBasicMaterial({ color: glowHex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 1.55 + tier * 0.12;
      halo.name = 'halo';
      g.add(halo);
    }
    // No per-chest real-time light — emissive trim + halo carry the tier read
    return { group: g, lid, light: null, glowMat: [trimMat, accentMat] };
  }

  private trackChests(match: Match): void {
    for (const c of match.chests) {
      const view = this.chestBody(c.kind);
      view.group.position.set(c.x, c.y, c.z);
      view.group.rotation.y = Math.abs(Math.round((c.x * 13.7 + c.z * 7.3))) * 0.61 % (Math.PI * 2);
      this.chestViews.set(c.id, view);
      this.group.add(view.group);
    }
  }

  syncChests(match: Match): void {
    for (const c of match.chests) {
      const view = this.chestViews.get(c.id);
      if (!view) continue;
      const targetLid = -Math.min(1, c.openT * 1.6) * 1.85;
      if (view.lid) view.lid.rotation.x += (targetLid - view.lid.rotation.x) * 0.14;
      const pulse = 1 + Math.sin(this.time * 2.6 + c.x) * 0.12;
      if (!c.opened) {
        for (const m of view.glowMat) m.emissiveIntensity = (1.5 + pulse * 0.6);
      } else {
        for (const m of view.glowMat) m.emissiveIntensity *= Math.exp(-this.timeDelta() * 1.4);
        const halo = view.group.getObjectByName('halo');
        if (halo) {
          const hm = (halo as THREE.Mesh).material as THREE.MeshBasicMaterial;
          hm.opacity = Math.max(0, hm.opacity - 0.02);
        }
      }
    }
  }

  private lastFrameTime = 0;
  private timeDelta(): number {
    return Math.max(0.001, this.time - this.lastFrameTime);
  }

  // -------------------------------------------------------------------------
  // Loot presentation: floating items, rarity beams, ground rings
  // -------------------------------------------------------------------------

  private lootViewFor(item: import('../sim/loot').WorldItem): { root: THREE.Group; beam?: THREE.Mesh; ring?: THREE.Mesh } {
    const root = new THREE.Group();
    const rarityRank = ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(item.rarity);
    const glowHex = RARITY_COLORS[item.rarity];

    let inner: THREE.Object3D | null = null;
    if (item.kind === 'weapon' && item.weapon) {
      const wm = this.weaponFactory.buildWorldScale(item.weapon.weaponId, item.rarity);
      if (wm) inner = wm.group;
    }
    if (!inner) {
      const g = new THREE.Group();
      if (item.kind === 'ammo') {
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(0.42, 0.3, 0.3),
          new THREE.MeshStandardMaterial({ color: 0x4a5038, roughness: 0.7, metalness: 0.2 }),
        );
        const stripe = new THREE.Mesh(
          new THREE.BoxGeometry(0.44, 0.06, 0.32),
          new THREE.MeshStandardMaterial({ color: 0x101114, emissive: 0xd8c86a, emissiveIntensity: 0.8 }),
        );
        stripe.position.y = 0.12;
        g.add(box, stripe);
      } else {
        const isMed = item.heal?.itemId === 'medkit';
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(0.48, 0.34, 0.34),
          new THREE.MeshStandardMaterial({
            color: isMed ? 0xe8ecef : 0x244a66, roughness: 0.5, metalness: 0.3,
            emissive: isMed ? 0x882030 : 0x10406a, emissiveIntensity: 0.5,
          }),
        );
        const crossMat = new THREE.MeshBasicMaterial({ color: isMed ? 0xff5f6d : 0x53d8ff });
        const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.02), crossMat);
        c1.position.set(0, 0.05, 0.18);
        const c2 = c1.clone(); c2.rotation.z = Math.PI / 2;
        const glow = new THREE.Mesh(
          new THREE.SphereGeometry(0.05, 8, 6),
          new THREE.MeshBasicMaterial({ color: isMed ? 0xff8088 : 0x53d8ff }),
        );
        glow.position.y = 0.24;
        g.add(box, c1, c2, glow);
      }
      inner = g;
    }
    root.add(inner);

    // Rarity presentation: beam + ground ring + light scale with rarity
    let beam: THREE.Mesh | undefined;
    let ring: THREE.Mesh | undefined;
    let light: THREE.PointLight | undefined;
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
    return { root, beam, ring };
  }

  syncLoot(match: Match): void {
    const seen = new Set<number>();
    for (const item of match.loot.items) {
      seen.add(item.id);
      let view = this.lootViews.get(item.id);
      if (!view) {
        view = { ...this.lootViewFor(item), phase: Math.random() * Math.PI * 2 };
        view.root.position.set(item.x, item.y, item.z);
        this.lootViews.set(item.id, view);
        this.group.add(view.root);
      }
      const bob = Math.sin(this.time * 2.1 + view.phase) * 0.09 + 0.62;
      const spin = this.time * (item.kind === 'heal' ? 0.8 : 0.55) + view.phase;
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
      this.transportGroup.rotation.y = Math.atan2(
        match.transportTo[0] - match.transportFrom[0],
        match.transportTo[1] - match.transportFrom[1],
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
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  });
}
