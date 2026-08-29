/**
 * VFX: pooled tracers, muzzle flashes (sprite + light), impact sparks/debris,
 * shell casings, glass shards, ground-pound shockwaves, grapple ropes,
 * explosion bursts, elimination energy wisps. Everything is pooled — no
 * per-effect allocations in steady state.
 */

import * as THREE from 'three';

interface Tracer {
  slot: number;
  life: number;
  maxLife: number;
  color: number;
}

interface Flash {
  sprite: THREE.Sprite;
  light: THREE.PointLight | null;
  life: number;
  maxLife: number;
  /** Star-petal texture variant (shotgun/sniper-class). */
  star: boolean;
}

interface Particle {
  mesh: THREE.InstancedMesh | null;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  color: THREE.Color;
  gravity: number;
}

const MAX_TRACERS = 128;
const MAX_FLASHES = 24;
const MAX_FLASH_LIGHTS = 6;
const MAX_PARTICLES = 512;
const MAX_SHOCKWAVES = 8;

function finite(...values: number[]): boolean {
  return values.every(Number.isFinite);
}

// Shared scratch objects — never allocate inside spawn/update paths.
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _axis = new THREE.Vector3(0.3, 0.8, 0.2).normalize();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
const _lookM = new THREE.Matrix4();

interface Shockwave {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

export class VfxSystem {
  readonly group = new THREE.Group();
  private tracers: Tracer[] = [];
  private tracerMesh: THREE.InstancedMesh;
  private tracerDirty = false;
  private flashes: Flash[] = [];
  private particles: Particle[] = [];
  private particleMeshes: THREE.InstancedMesh[] = [];
  private ropes = new Map<number, { line: THREE.Line; points: number }>();
  private shockwaves: Shockwave[] = [];
  private shockwavePools: Record<'normal' | 'additive', THREE.Mesh[]> = {
    normal: [],
    additive: [],
  };
  private time = 0;

  constructor() {
    // Keep blending variants in separate fixed pools. Changing blending and
    // material.needsUpdate during gameplay forced a cold shader/program stall
    // on the first shield break.
    const ringGeo = new THREE.RingGeometry(0.8, 1.15, 32);
    ringGeo.rotateX(-Math.PI / 2);
    for (const variant of ['normal', 'additive'] as const) {
      for (let i = 0; i < MAX_SHOCKWAVES; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xcfd8e2,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: variant === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        const mesh = new THREE.Mesh(ringGeo, mat);
        mesh.visible = false;
        this.group.add(mesh);
        this.shockwavePools[variant].push(mesh);
      }
    }

    // Tracer pool: ONE instanced mesh, per-instance color fade (additive)
    // At gameplay speeds a 3 cm / 90 ms segment vanishes between presented
    // frames, especially when travelling toward the camera. A slightly wider
    // luminous core with a longer persistence reads as a fast projectile
    // rather than a static laser line.
    const tracerGeo = new THREE.BoxGeometry(0.026, 0.026, 1);
    tracerGeo.translate(0, 0, -0.5);
    this.tracerMesh = new THREE.InstancedMesh(
      tracerGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.72,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      MAX_TRACERS,
    );
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.count = 0;
    this.group.add(this.tracerMesh);
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracers.push({ slot: i, life: 0, maxLife: 1, color: 0xffffff });
      _m4.makeScale(0, 0, 0);
      this.tracerMesh.setMatrixAt(i, _m4);
    }
    this.tracerMesh.instanceMatrix.needsUpdate = true;

    // Muzzle flash pool — two looks: compact core (pistol/SMG/AR) and
    // wide petal star (shotgun/sniper).
    const coreTex = this.makeFlashTexture(false);
    const starTex = this.makeFlashTexture(true);
    for (let i = 0; i < MAX_FLASHES; i++) {
      const mat = new THREE.SpriteMaterial({
        map: i % 3 === 2 ? starTex : coreTex, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      const light = i < MAX_FLASH_LIGHTS ? new THREE.PointLight(0xffc878, 0, 12, 2) : null;
      this.group.add(sprite);
      if (light) this.group.add(light);
      this.flashes.push({ sprite, light, life: 0, maxLife: 1, star: i % 3 === 2 });
    }

    // Particle pool via instanced quads (billboard-ish boxes)
    const pgeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
      const inst = new THREE.InstancedMesh(pgeo, mat, MAX_PARTICLES / 8);
      inst.count = 0;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(inst);
      this.particleMeshes.push(inst);
    }
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        mesh: null, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        life: 0, maxLife: 1, size: 0.05, color: new THREE.Color(), gravity: 20,
      });
    }
  }

  private makeFlashTexture(star: boolean): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,240,200,1)');
    grad.addColorStop(0.4, 'rgba(255,180,90,0.85)');
    grad.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    if (star) {
      // Petal rays for shotgun/sniper-class blasts.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.35;
        const len = i % 2 === 0 ? 30 : 20;
        const g2 = ctx.createLinearGradient(32, 32, 32 + Math.cos(a) * len, 32 + Math.sin(a) * len);
        g2.addColorStop(0, 'rgba(255,220,150,0.95)');
        g2.addColorStop(1, 'rgba(255,140,40,0)');
        ctx.strokeStyle = g2;
        ctx.lineWidth = i % 2 === 0 ? 7 : 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(32, 32);
        ctx.lineTo(32 + Math.cos(a) * len, 32 + Math.sin(a) * len);
        ctx.stroke();
      }
    }
    return new THREE.CanvasTexture(c);
  }

  spawnTracer(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, color: number): void {
    if (!finite(x1, y1, z1, x2, y2, z2, color)) return;
    const tracer = this.tracers.find((t) => t.life <= 0)
      ?? this.tracers.reduce((oldest, current) => current.life < oldest.life ? current : oldest, this.tracers[0]!);
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return;
    _v1.set(x1, y1, z1);
    _v2.set(x2, y2, z2);
    _lookM.lookAt(_v1, _v2, _up);
    _q.setFromRotationMatrix(_lookM);
    _m4.compose(_v1, _q, _scl.set(1, 1, len));
    this.tracerMesh.setMatrixAt(tracer.slot, _m4);
    this.tracerMesh.setColorAt(tracer.slot, _col.setHex(color));
    // Every physical projectile contributes successive substep segments.
    // Keeping more than about two presented frames stacks an entire flight
    // path into a solid laser. A 34 ms afterimage is still visible while the
    // gaps between rounds preserve the impression of discrete bullets.
    tracer.life = 0.034;
    tracer.maxLife = 0.034;
    tracer.color = color;
    this.tracerDirty = true;
  }

  muzzleFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number, scale = 1, heavy = false): void {
    if (!finite(x, y, z, dx, dy, dz, scale) || scale <= 0) return;
    // Prefer a star-texture flash for heavy weapon classes.
    const f = this.flashes.find((fl) => fl.life <= 0 && fl.star === heavy)
      ?? this.flashes.find((fl) => fl.life <= 0)
      ?? this.flashes.reduce((oldest, current) => current.life < oldest.life ? current : oldest, this.flashes[0]!);
    // `x/y/z` is the authored weapon muzzle when the rendered rig is
    // available. Keep only a small forward clearance so the flash sits on the
    // barrel rather than floating half a metre in front of it.
    f.sprite.position.set(x + dx * 0.12, y + dy * 0.12 - 0.02, z + dz * 0.12);
    // A metre-wide camera-facing disc reads as an energy orb, especially on
    // nearby bots. Keep ordinary report flashes close to real muzzle scale;
    // shotgun/sniper variants retain the larger petal texture.
    f.sprite.scale.setScalar((heavy ? 0.5 : 0.28) * scale + Math.random() * (heavy ? 0.1 : 0.06));
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.sprite.material.opacity = 1;
    f.sprite.visible = true;
    if (f.light) {
      f.light.position.copy(f.sprite.position);
      f.light.intensity = (heavy ? 5.5 : 3.2) * scale;
      f.light.color.setHex(heavy ? 0xffb060 : 0xffc878);
    }
    f.life = heavy ? 0.055 : 0.04;
    f.maxLife = f.life;
  }

  impactSparks(x: number, y: number, z: number, nx: number, ny: number, nz: number, count = 7): void {
    for (let i = 0; i < count; i++) {
      this.spawnParticle(
        x, y, z,
        nx * 4 + (Math.random() - 0.5) * 7,
        ny * 4 + Math.random() * 5,
        nz * 4 + (Math.random() - 0.5) * 7,
        0.35 + Math.random() * 0.3,
        0.045,
        0xffb050,
        22,
      );
    }
    // dust puff
    for (let i = 0; i < 3; i++) {
      this.spawnParticle(
        x + nx * 0.1, y + ny * 0.1, z + nz * 0.1,
        (Math.random() - 0.5) * 2 + nx, Math.random() * 1.6, (Math.random() - 0.5) * 2 + nz,
        0.55 + Math.random() * 0.3, 0.09, 0x9a9a92, 4,
      );
    }
  }

  glassShards(x: number, y: number, z: number, count = 14): void {
    for (let i = 0; i < count; i++) {
      this.spawnParticle(
        x + (Math.random() - 0.5) * 0.6, y + (Math.random() - 0.5) * 0.6, z + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 6, Math.random() * 3, (Math.random() - 0.5) * 6,
        0.8 + Math.random() * 0.4, 0.07, 0xbfe4f5, 24,
      );
    }
  }

  debrisBurst(x: number, y: number, z: number, baseColor: number, count = 16): void {
    for (let i = 0; i < count; i++) {
      this.spawnParticle(
        x + (Math.random() - 0.5) * 0.8, y + (Math.random() - 0.5) * 0.8, z + (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 9, 2 + Math.random() * 6, (Math.random() - 0.5) * 9,
        0.9 + Math.random() * 0.6, 0.08 + Math.random() * 0.06, baseColor, 24,
      );
    }
    // dust cloud
    for (let i = 0; i < 10; i++) {
      this.spawnParticle(
        x, y + 0.3, z,
        (Math.random() - 0.5) * 4, 1 + Math.random() * 2.5, (Math.random() - 0.5) * 4,
        1.2 + Math.random(), 0.16, 0xa8a49a, 3,
      );
    }
  }

  shellCasing(x: number, y: number, z: number, dx: number, dz: number): void {
    this.spawnParticle(
      x, y, z,
      dx * 2 + (Math.random() - 0.5), 2.4 + Math.random() * 1.4, dz * 2 + (Math.random() - 0.5),
      1.1, 0.05, 0xd8b45a, 24,
    );
  }

  /** Acquire a pooled ring mesh for an expanding shockwave. */
  private spawnShockwave(x: number, y: number, z: number, life: number, color: number, additive: boolean): void {
    if (!finite(x, y, z, life, color) || life <= 0) return;
    const pool = this.shockwavePools[additive ? 'additive' : 'normal'];
    let mesh = pool.find((m) => !m.visible);
    let entry: Shockwave | undefined;
    if (!mesh) {
      // Recycle the effect closest to expiry. Never create two active records
      // for one pooled mesh; competing updates caused flicker under bursts.
      for (const current of this.shockwaves) {
        if (!pool.includes(current.mesh)) continue;
        if (!entry || current.life < entry.life) entry = current;
      }
      if (!entry) return;
      mesh = entry.mesh;
    }
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.color.setHex(color);
    mesh.position.set(x, y + 0.15, z);
    mesh.scale.setScalar(1);
    mesh.visible = true;
    if (entry) {
      entry.life = life;
      entry.maxLife = life;
    } else {
      this.shockwaves.push({ mesh, life, maxLife: life });
    }
  }

  poundShockwave(x: number, y: number, z: number): void {
    this.spawnShockwave(x, y, z, 0.5, 0xcfd8e2, false);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawnParticle(
        x, y + 0.2, z,
        Math.cos(a) * (5 + Math.random() * 5), 2 + Math.random() * 4, Math.sin(a) * (5 + Math.random() * 5),
        0.8, 0.11, 0xa8a49a, 10,
      );
    }
  }

  explosion(x: number, y: number, z: number): void {
    // fireball flash
    this.muzzleFlash(x, y, z, 0, 0, 0, 5);
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 6 + Math.random() * 10;
      this.spawnParticle(
        x, y, z,
        Math.cos(a) * sp, 2 + Math.random() * 9, Math.sin(a) * sp,
        0.7 + Math.random() * 0.5, 0.13 + Math.random() * 0.1, i % 2 ? 0xff8030 : 0x50504a, 18,
      );
    }
    this.poundShockwave(x, y, z);
  }

  eliminationWisp(x: number, y: number, z: number, color: number): void {
    for (let i = 0; i < 18; i++) {
      this.spawnParticle(
        x + (Math.random() - 0.5) * 0.8, y + Math.random() * 1.6, z + (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 1.4, 2.5 + Math.random() * 3.5, (Math.random() - 0.5) * 1.4,
        1.0 + Math.random() * 0.5, 0.07, color, -2, // negative gravity: rise
      );
    }
  }

  /** Shield-break: expanding cyan ring + energy shards. */
  shieldBreakBurst(x: number, y: number, z: number): void {
    this.spawnShockwave(x, y - 0.15, z, 0.45, 0x6fd4ff, true);
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3.5 + Math.random() * 5;
      this.spawnParticle(
        x, y, z,
        Math.cos(a) * sp, (Math.random() - 0.2) * 4, Math.sin(a) * sp,
        0.7 + Math.random() * 0.4, 0.06, 0x8fdcff, 9,
      );
    }
  }

  setGrappleRope(actorId: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    if (!finite(actorId, ax, ay, az, bx, by, bz)) return;
    let entry = this.ropes.get(actorId);
    if (!entry) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x53e0ff }));
      this.group.add(line);
      entry = { line, points: 6 };
      this.ropes.set(actorId, entry);
    }
    const attr = entry.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, ax, ay, az);
    attr.setXYZ(1, bx, by, bz);
    attr.needsUpdate = true;
    entry.line.visible = true;
  }

  hideGrappleRope(actorId: number): void {
    const entry = this.ropes.get(actorId);
    if (entry) entry.line.visible = false;
  }

  private spawnParticle(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, color: number, gravity: number,
  ): void {
    if (!finite(x, y, z, vx, vy, vz, life, size, color, gravity) || life <= 0 || size <= 0) return;
    const p = this.particles.find((pp) => pp.life <= 0);
    if (!p) return;
    p.pos.set(x, y, z);
    p.vel.set(vx, vy, vz);
    p.life = life;
    p.maxLife = life;
    p.size = size;
    p.color.setHex(color);
    p.gravity = gravity;
  }

  update(dt: number, cameraPos: THREE.Vector3): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // A restored/background tab can report a very large frame. Capping the
    // presentation step prevents a single hitch from flinging pooled effects.
    const frameDt = Math.min(dt, 0.05);
    this.time += frameDt;

    let liveTracers = 0;
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= frameDt;
        const k = Math.max(0, t.life / t.maxLife);
        this.tracerMesh.setColorAt(
          t.slot,
          _col.setHex(t.color).multiplyScalar(k > 0 ? 0.82 + 0.18 * k : 0),
        );
        if (t.life <= 0) {
          // Collapse expired tracers so no stale instance stays visible.
          _m4.makeScale(0, 0, 0);
          this.tracerMesh.setMatrixAt(t.slot, _m4);
        } else {
          liveTracers++;
        }
      }
    }
    if (liveTracers > 0 || this.tracerDirty) {
      this.tracerMesh.count = MAX_TRACERS;
      this.tracerMesh.instanceMatrix.needsUpdate = true;
      if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;
      this.tracerDirty = liveTracers > 0;
    }

    for (const f of this.flashes) {
      if (f.life > 0) {
        f.life -= frameDt;
        if (f.light) f.light.intensity *= Math.exp(-frameDt * 26);
        f.sprite.material.opacity = Math.max(0, Math.min(1, f.life / f.maxLife));
        if (f.life <= 0) {
          f.sprite.visible = false;
          if (f.light) f.light.intensity = 0;
        }
      }
    }

    // Particles: assign to instanced meshes round-robin; per-instance color.
    for (const inst of this.particleMeshes) {
      inst.count = 0;
      inst.visible = false;
    }
    let bucket = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= frameDt;
      if (p.life <= 0) continue;
      p.vel.y -= p.gravity * frameDt;
      p.pos.addScaledVector(p.vel, frameDt);
      const k = p.life / p.maxLife;
      const inst = this.particleMeshes[bucket % this.particleMeshes.length]!;
      bucket++;
      inst.visible = true;
      if (inst.count >= (inst.instanceMatrix.count ?? MAX_PARTICLES / 8)) continue;
      const fade = Math.min(1, k * 2.4);
      _scl.setScalar(p.size * (0.6 + fade * 0.4));
      _q.setFromAxisAngle(_axis, this.time * 3 + p.pos.x);
      _m4.compose(p.pos, _q, _scl);
      inst.setMatrixAt(inst.count, _m4);
      _col.copy(p.color).multiplyScalar(fade);
      inst.setColorAt(inst.count, _col);
      inst.count++;
    }
    for (const inst of this.particleMeshes) {
      if (inst.count > 0) {
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      }
    }
    void cameraPos;

    // Shockwaves expand + fade
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i]!;
      s.life -= frameDt;
      const t = 1 - Math.max(0, s.life) / s.maxLife;
      s.mesh.scale.setScalar(1 + t * 7);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - t);
      if (s.life <= 0) {
        s.mesh.visible = false;
        (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
        this.shockwaves.splice(i, 1);
      }
    }
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const material = (object as THREE.Mesh | THREE.Sprite | THREE.Line).material;
      const list = Array.isArray(material) ? material : material ? [material] : [];
      for (const mat of list) {
        materials.add(mat);
        const map = (mat as THREE.Material & { map?: THREE.Texture | null }).map;
        if (map) textures.add(map);
      }
    });
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    this.ropes.clear();
    this.shockwaves.length = 0;
    this.group.clear();
  }
}
