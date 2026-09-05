/**
 * Rain particle field.
 *
 * A recycled InstancedMesh of thin vertical streaks falling through a
 * cylinder that follows the viewer. Instances wrap around the camera rather
 * than spawning/despawning, so running rain costs a fixed draw call, zero
 * allocations per frame, and no CPU-side particle management beyond a
 * position/velocity integrate + wrap.
 */
import * as THREE from 'three';

const STREAK_COUNT = 900;
/** Rain cylinder radius around the viewer (m). */
const FIELD_RADIUS = 34;
/** Height band above the camera where streaks recycle. */
const FIELD_TOP = 26;
const FIELD_BOTTOM = -8;
/** Fall speed (m/s) at intensity 1 — heavy rain. */
const FALL_SPEED = 26;
/** Horizontal wind drift shared by all streaks (m/s). */
const WIND = new THREE.Vector2(3.4, 1.7);

interface Streak {
  x: number;
  y: number;
  z: number;
  speed: number;
}

export class RainSystem {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly streaks: Streak[] = [];
  private readonly m4 = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scale = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private intensity: number;
  private time = 0;

  constructor(intensity: number) {
    this.intensity = Math.max(0.15, Math.min(1, intensity));
    const geo = new THREE.BoxGeometry(0.016, 0.55, 0.016);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x9fb6c8,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      // Streaks read best as slightly glowing lines against dark scenes.
      blending: THREE.NormalBlending,
      fog: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, STREAK_COUNT);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'rain-field';
    for (let i = 0; i < STREAK_COUNT; i++) {
      this.streaks.push(this.spawnStreak({ x: 0, y: 0, z: 0 }, true));
    }
    this.group.add(this.mesh);
  }

  /** Random position inside the field cylinder; `warm` spreads initial
   * streaks through the full height so the first frame is already raining. */
  private spawnStreak(around: { x: number; y: number; z: number }, warm = false): Streak {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * FIELD_RADIUS;
    return {
      x: around.x + Math.cos(a) * r,
      y: warm
        ? FIELD_BOTTOM + Math.random() * (FIELD_TOP - FIELD_BOTTOM)
        : around.y + FIELD_TOP * (0.85 + Math.random() * 0.15),
      z: around.z + Math.sin(a) * r,
      speed: FALL_SPEED * (0.8 + Math.random() * 0.4),
    };
  }

  /** Rain tracks the viewer — the field is wrapped into a viewer-centred
   * cylinder each frame. */
  update(dt: number, viewer: { x: number; y: number; z: number }): void {
    this.time += dt;
    const fall = dt;
    const streakScale = 0.7 + 0.5 * this.intensity;
    const tilt = -Math.atan(WIND.x / FALL_SPEED);
    let write = 0;
    for (const s of this.streaks) {
      s.y -= s.speed * fall;
      s.x += WIND.x * fall;
      s.z += WIND.y * fall;
      if (s.y < viewer.y + FIELD_BOTTOM) {
        const fresh = this.spawnStreak(viewer);
        s.x = fresh.x;
        s.y = viewer.y + FIELD_TOP * (0.9 + Math.random() * 0.1);
        s.z = fresh.z;
      }
      // Wrap horizontal drift back into the cylinder.
      const dx = s.x - viewer.x;
      const dz = s.z - viewer.z;
      if (dx * dx + dz * dz > FIELD_RADIUS * FIELD_RADIUS) {
        const fresh = this.spawnStreak(viewer);
        s.x = fresh.x;
        s.z = fresh.z;
      }
      if (write < STREAK_COUNT) {
        this.euler.set(0, 0, tilt);
        this.quat.setFromEuler(this.euler);
        this.scale.set(1, streakScale, 1);
        this.pos.set(s.x, s.y, s.z);
        this.m4.compose(this.pos, this.quat, this.scale);
        this.mesh.setMatrixAt(write++, this.m4);
      }
    }
    this.mesh.count = write;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.group.clear();
  }
}
