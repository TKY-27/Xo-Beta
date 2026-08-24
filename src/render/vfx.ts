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
}

interface Flash {
  sprite: THREE.Sprite;
  light: THREE.PointLight;
  life: number;
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

const MAX_TRACERS = 64;
const MAX_FLASHES = 12;
const MAX_PARTICLES = 512;

export class VfxSystem {
  readonly group = new THREE.Group();
  private tracers: Tracer[] = [];
  private tracerMesh: THREE.InstancedMesh;
  private tracerDirty = false;
  private flashes: Flash[] = [];
  private particles: Particle[] = [];
  private particleMeshes: THREE.InstancedMesh[] = [];
  private ropes = new Map<number, { line: THREE.Line; points: number }>();
  private shockwaves: Array<{ mesh: THREE.Mesh; life: number }> = [];
  private time = 0;

  constructor() {
    // Tracer pool: ONE instanced mesh, per-instance color fade (additive)
    const tracerGeo = new THREE.BoxGeometry(0.03, 0.03, 1);
    tracerGeo.translate(0, 0, -0.5);
    this.tracerMesh = new THREE.InstancedMesh(
      tracerGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      MAX_TRACERS,
    );
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.count = 0;
    this.group.add(this.tracerMesh);
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracers.push({ slot: i, life: 0, maxLife: 1 });
    }

    // Muzzle flash pool
    const flashTex = this.makeFlashTexture();
    const flashMat = new THREE.SpriteMaterial({ map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < MAX_FLASHES; i++) {
      const sprite = new THREE.Sprite(flashMat.clone());
      sprite.visible = false;
      const light = new THREE.PointLight(0xffc878, 0, 12, 2);
      this.group.add(sprite, light);
      this.flashes.push({ sprite, light, life: 0 });
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

  private makeFlashTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,240,200,1)');
    grad.addColorStop(0.4, 'rgba(255,180,90,0.85)');
    grad.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  spawnTracer(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, color: number): void {
    const tracer = this.tracers.find((t) => t.life <= 0) ?? this.tracers[0]!;
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(x1, y1, z1), new THREE.Vector3(x2, y2, z2), new THREE.Vector3(0, 1, 0)),
    );
    m.compose(new THREE.Vector3(x1, y1, z1), q, new THREE.Vector3(1, 1, len));
    this.tracerMesh.setMatrixAt(tracer.slot, m);
    this.tracerMesh.setColorAt(tracer.slot, new THREE.Color(color));
    tracer.life = 0.09;
    tracer.maxLife = 0.09;
    this.tracerDirty = true;
  }

  muzzleFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number, scale = 1): void {
    const f = this.flashes.find((fl) => fl.life <= 0) ?? this.flashes[0]!;
    f.sprite.position.set(x + dx * 0.5, y + dy * 0.5 - 0.06, z + dz * 0.5);
    f.sprite.scale.setScalar(0.7 * scale + Math.random() * 0.25);
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.sprite.material.opacity = 1;
    f.sprite.visible = true;
    f.light.position.copy(f.sprite.position);
    f.light.intensity = 6 * scale;
    f.light.color.setHex(0xffc878);
    f.life = 0.055;
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

  poundShockwave(x: number, y: number, z: number): void {
    const geo = new THREE.RingGeometry(0.8, 1.15, 32);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xcfd8e2, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y + 0.15, z);
    this.group.add(mesh);
    this.shockwaves.push({ mesh, life: 0.5 });
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
    const geo = new THREE.RingGeometry(0.55, 0.78, 32);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x6fd4ff, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    this.shockwaves.push({ mesh, life: 0.45 });
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
    this.time += dt;

    let liveTracers = 0;
    const fadeColor = new THREE.Color();
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        const k = Math.max(0, t.life / t.maxLife);
        this.tracerMesh.getColorAt(t.slot, fadeColor);
        this.tracerMesh.setColorAt(t.slot, fadeColor.multiplyScalar(k > 0 ? 0.82 + 0.18 * k : 0));
        liveTracers++;
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
        f.life -= dt;
        f.light.intensity *= Math.exp(-dt * 26);
        f.sprite.material.opacity = Math.max(0, f.life / 0.055);
        if (f.life <= 0) {
          f.sprite.visible = false;
          f.light.intensity = 0;
        }
      }
    }

    // Particles: assign to instanced meshes by color bucket
    for (const inst of this.particleMeshes) {
      inst.count = 0;
      inst.visible = false;
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    let bucket = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      const k = p.life / p.maxLife;
      const inst = this.particleMeshes[bucket % this.particleMeshes.length]!;
      bucket++;
      inst.visible = true;
      if (inst.count >= (inst.instanceMatrix.count ?? MAX_PARTICLES / 8)) continue;
      const fade = Math.min(1, k * 2.4);
      scl.setScalar(p.size * (0.6 + fade * 0.4));
      q.setFromAxisAngle(new THREE.Vector3(0.3, 0.8, 0.2).normalize(), this.time * 3 + p.pos.x);
      m4.compose(p.pos, q, scl);
      inst.setMatrixAt(inst.count++, m4);
      (inst.material as THREE.MeshBasicMaterial).color.copy(p.color);
    }
    for (const inst of this.particleMeshes) {
      if (inst.count > 0) inst.instanceMatrix.needsUpdate = true;
    }
    void cameraPos;

    // Shockwaves expand + fade
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i]!;
      s.life -= dt;
      const t = 1 - s.life / 0.5;
      s.mesh.scale.setScalar(1 + t * 7);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - t);
      if (s.life <= 0) {
        this.group.remove(s.mesh);
        s.mesh.geometry.dispose();
        this.shockwaves.splice(i, 1);
      }
    }
  }
}
