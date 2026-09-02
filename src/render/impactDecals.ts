/**
 * ImpactDecalSystem: pooled temporary bullet marks on solid world surfaces.
 *
 * One InstancedMesh serves every mark (no per-impact geometry/material/
 * texture creation). Marks are spawned only from authoritative impact events
 * — the host bus and the guest reliable-event path already deduplicate by
 * eventId, so a confirmed shot can never produce two marks. Decals are pure
 * presentation: no gameplay collision, no damage effect, no client authority.
 */

import * as THREE from 'three';
import type { QualityPreset } from '../core/settings';

/** Per-preset bounded pool budgets. */
export const DECAL_BUDGETS: Record<QualityPreset, number> = {
  low: 16,
  medium: 32,
  high: 64,
  ultra: 96,
  cinematic: 128,
};

/** Full visibility window before the fade begins. */
export const DECAL_LIFE = 6;
/** Smooth fade duration at the end of the life window. */
export const DECAL_FADE = 1;

/** Materials that must never receive a bullet mark. */
const EXCLUDED_MATERIALS = new Set(['water', 'foliage', 'glass']);

interface DecalRecord {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  size: number;
  life: number;
  age: number;
  tint: THREE.Color;
}

/** Deterministic 32-bit FNV-1a hash over an event identity string. */
function hashIdentity(identity: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tintForMaterial(material: string): THREE.Color {
  switch (material) {
    case 'metal': return new THREE.Color(0x14161a);
    case 'wood': return new THREE.Color(0x241407);
    case 'dirt': return new THREE.Color(0x33241a);
    default: return new THREE.Color(0x1b1b1d);
  }
}

function sizeForMaterial(material: string): number {
  switch (material) {
    case 'metal': return 0.13;
    case 'wood': return 0.19;
    case 'dirt': return 0.22;
    default: return 0.18;
  }
}

export class ImpactDecalSystem {
  private readonly scene: THREE.Scene;
  private mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private records: DecalRecord[] = [];
  /** Recent event identities: a re-delivered confirmed event never double-marks. */
  private readonly seenIds = new Set<string>();
  private capacity: number;
  private prewarmed = false;
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchSpin = new THREE.Quaternion();
  private readonly scratchNormal = new THREE.Vector3();
  private readonly scratchZ = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene, quality: QualityPreset) {
    this.scene = scene;
    this.capacity = DECAL_BUDGETS[quality];
    const texture = ImpactDecalSystem.makeBlotchTexture();
    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });
    this.mesh = this.buildMesh();
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** One shared irregular dark blotch generated once at construction. */
  private static makeBlotchTexture(): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    // Soft radial core with a ragged rim built from overlapping arcs.
    const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 26);
    gradient.addColorStop(0, 'rgba(8,8,8,0.95)');
    gradient.addColorStop(0.55, 'rgba(12,12,12,0.65)');
    gradient.addColorStop(1, 'rgba(16,16,16,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(32, 32, 26, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2 + 0.4;
      const radius = 14 + (i % 3) * 5;
      ctx.fillStyle = 'rgba(10,10,10,0.35)';
      ctx.beginPath();
      ctx.arc(32 + Math.cos(angle) * 10, 32 + Math.sin(angle) * 10, radius * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private buildMesh(): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.material, this.capacity);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = 4;
    return mesh;
  }

  /** Quality changes rebuild the pool with the new bounded budget. */
  setQuality(quality: QualityPreset): void {
    const capacity = DECAL_BUDGETS[quality];
    if (capacity === this.capacity) return;
    this.capacity = capacity;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.mesh = this.buildMesh();
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.records = this.records.slice(0, capacity);
  }

  /**
   * Spawn one mark from an authoritative impact. `identity` must be stable
   * per confirmed event (eventId) so orientation is deterministic and a
   * re-delivered event maps onto the same orientation.
   */
  spawn(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    material: string,
    identity: string,
  ): void {
    if (EXCLUDED_MATERIALS.has(material)) return;
    if (this.seenIds.has(identity)) return;
    this.seenIds.add(identity);
    if (this.seenIds.size > this.capacity * 2) {
      // Records older than the whole live window have already expired; any
      // event re-delivered this late was dropped upstream as well.
      this.seenIds.clear();
    }
    this.scratchNormal.set(nx, ny, nz);
    if (this.scratchNormal.lengthSq() < 0.5) this.scratchNormal.set(0, 1, 0);
    this.scratchNormal.normalize();
    this.scratchQuat.setFromUnitVectors(this.scratchZ, this.scratchNormal);
    const hash = hashIdentity(identity);
    const spin = (hash % 1024) / 1024 * Math.PI * 2;
    this.scratchSpin.setFromAxisAngle(this.scratchNormal, spin);
    this.scratchQuat.premultiply(this.scratchSpin);
    const jitter = ((hash >>> 10) % 256) / 256 * 0.012;
    const record: DecalRecord = {
      position: new THREE.Vector3(
        x + this.scratchNormal.x * (0.012 + jitter),
        y + this.scratchNormal.y * (0.012 + jitter),
        z + this.scratchNormal.z * (0.012 + jitter),
      ),
      quaternion: this.scratchQuat.clone(),
      // Deterministic per-event size variation.
      size: sizeForMaterial(material) * (0.85 + ((hash >>> 18) % 256) / 256 * 0.3),
      life: DECAL_LIFE + DECAL_FADE,
      age: 0,
      tint: tintForMaterial(material),
    };
    if (this.records.length >= this.capacity) {
      // Recycle the oldest mark.
      this.records.shift();
    }
    this.records.push(record);
    if (!this.prewarmed) this.prewarmed = true;
  }

  /** Advance ages and rewrite the instance buffers. */
  update(dt: number): void {
    const frameDt = Math.min(dt, 0.05);
    let writeIndex = 0;
    for (const record of this.records) {
      record.age += frameDt;
    }
    this.records = this.records.filter((record) => record.age < record.life);
    for (const record of this.records) {
      const remaining = record.life - record.age;
      const fade = Math.min(1, remaining / DECAL_FADE);
      const scale = record.size * (0.55 + 0.45 * fade);
      this.scratchMatrix.compose(
        record.position,
        record.quaternion,
        new THREE.Vector3(scale, scale, scale),
      );
      this.mesh.setMatrixAt(writeIndex, this.scratchMatrix);
      this.mesh.setColorAt(writeIndex, this.scratchColor.copy(record.tint).multiplyScalar(fade));
      writeIndex++;
    }
    this.mesh.count = writeIndex;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private readonly scratchColor = new THREE.Color();

  /**
   * Force the decal shader program to compile during match setup instead of
   * on the first combat impact: one degenerate instance is rendered for a
   * frame, then the pool returns to empty.
   */
  prewarm(): void {
    if (this.prewarmed) return;
    this.scratchMatrix.makeScale(0.0001, 0.0001, 0.0001);
    this.mesh.setMatrixAt(0, this.scratchMatrix);
    this.mesh.count = 1;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.prewarmed = true;
  }

  get activeCount(): number {
    return this.records.length;
  }

  get budget(): number {
    return this.capacity;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
    this.mesh.dispose();
    this.records = [];
    this.seenIds.clear();
  }
}
