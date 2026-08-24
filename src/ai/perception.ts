/**
 * Bot perception + memory. Bots may ONLY act on information that flows
 * through this pipeline (vision cones + line of sight + gameplay sound
 * events). No direct reads of hidden transforms.
 */

import { GAMEPLAY } from '../core/balance';
import { gameNext } from '../core/rng';
import type { Actor } from '../sim/actor';

export interface MemoryEntry {
  actorId: number;
  /** Estimated world position (with perception error baked in). */
  x: number;
  y: number;
  z: number;
  /** Estimated velocity. */
  vx: number;
  vy: number;
  vz: number;
  time: number;
  /** 0..1 confidence; decays over time. */
  confidence: number;
  source: 'vision' | 'sound' | 'damage';
}

export interface SoundEvent {
  x: number;
  y: number;
  z: number;
  loudness: number; // 0..1
  kind: 'shot' | 'footstep' | 'chest' | 'glass' | 'explosion' | 'land';
  actorId: number;
}

const VISION_FOV = (100 * Math.PI) / 180;
const VISION_DIST = 88;

export class Perception {
  /** Enemies recently visible (entries persist ~0.4s for decision stability). */
  visible = new Map<number, { actor: Actor; dist: number; exposure: number; seenAt: number }>();
  memories = new Map<number, MemoryEntry>();

  private visionTimer = 0;
  private clock = 0;
  private self: Actor;

  constructor(self: Actor) {
    this.self = self;
  }

  /**
   * Periodic vision update. `actors` are all alive actors; we only use their
   * public transform (equivalent of what renders on screen).
   */
  updateVision(dt: number, actors: Actor[], losBlocked: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean, awarenessMult: number, rangeMult = 1): void {
    this.visionTimer -= dt;
    if (this.visionTimer > 0) return;
    this.visionTimer = 0.12;

    const p = this.self.body.position;
    const eyeY = p.y + 2.05;
    const fwdX = -Math.sin(this.self.yaw);
    const fwdZ = -Math.cos(this.self.yaw);
    const cosFov = Math.cos(VISION_FOV / 2);

    for (const other of actors) {
      if (other === this.self || !other.alive) continue;
      const op = other.body.position;
      const dx = op.x - p.x;
      const dz = op.z - p.z;
      const dy = op.y - p.y;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > VISION_DIST * awarenessMult * rangeMult) continue;

      // FOV check (generous when very close)
      const flatDist = Math.hypot(dx, dz);
      if (flatDist > 6) {
        const dot = (dx / flatDist) * fwdX + (dz / flatDist) * fwdZ;
        if (dot < cosFov) continue;
      }

      // Line of sight (chest height)
      if (losBlocked(p.x, eyeY, p.z, op.x, op.y + 1.3, op.z)) continue;

      // Exposure: moving/crouching affects effective detection range
      const speed = Math.hypot(other.body.velocity.x, other.body.velocity.z);
      let exposure = 1;
      if (other.crouched && speed < 2) exposure *= 0.55;
      else if (speed < 1.5) exposure *= 0.75;
      if (dist < 14) exposure = Math.max(exposure, 0.9);

      const effective = dist / Math.max(0.15, exposure);
      if (effective > VISION_DIST * awarenessMult * rangeMult) continue;

      this.visible.set(other.id, { actor: other, dist, exposure, seenAt: this.clock });

      // Update memory with slight positional error at long range
      const err = Math.max(0, (dist - 30) / 300);
      const m = this.memories.get(other.id) ?? {
        actorId: other.id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        time: -99, confidence: 0, source: 'vision' as const,
      };
      m.x = op.x + (gameNext() - 0.5) * err * 20;
      m.y = op.y;
      m.z = op.z + (gameNext() - 0.5) * err * 20;
      m.vx = other.body.velocity.x;
      m.vy = other.body.velocity.y;
      m.vz = other.body.velocity.z;
      m.time = 0;
      m.confidence = 1;
      m.source = 'vision';
      this.memories.set(other.id, m);
    }
  }

  hear(ev: SoundEvent, awarenessMult: number): void {
    const p = this.self.body.position;
    const dist = Math.hypot(ev.x - p.x, ev.y - p.y, ev.z - p.z);
    let range: number;
    switch (ev.kind) {
      case 'shot': range = GAMEPLAY.gunshotHearingRange; break;
      case 'footstep': range = GAMEPLAY.footstepHearingRange; break;
      case 'glass': range = 60; break;
      case 'chest': range = 26; break;
      case 'land': range = 40; break;
      default: range = 80;
    }
    range *= awarenessMult * (0.5 + ev.loudness * 0.5);
    if (dist > range || dist < 0.5) return;

    // Position uncertainty grows with distance
    const err = (dist / range) * (ev.kind === 'shot' ? 10 : 7);
    const m = this.memories.get(ev.actorId) ?? {
      actorId: ev.actorId, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      time: -99, confidence: 0, source: 'sound' as const,
    };
    m.x = ev.x + (gameNext() - 0.5) * err;
    m.y = ev.y;
    m.z = ev.z + (gameNext() - 0.5) * err;
    m.vx = 0; m.vy = 0; m.vz = 0;
    m.time = 0;
    m.confidence = ev.kind === 'shot' ? 0.85 : 0.55;
    m.source = 'sound';
    this.memories.set(ev.actorId, m);
  }

  onDamagedBy(attackerPos: { x: number; y: number; z: number }, attackerId: number): void {
    const m = this.memories.get(attackerId) ?? {
      actorId: attackerId, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      time: -99, confidence: 0, source: 'damage' as const,
    };
    m.x = attackerPos.x + (gameNext() - 0.5) * 4;
    m.y = attackerPos.y;
    m.z = attackerPos.z + (gameNext() - 0.5) * 4;
    m.time = 0;
    m.confidence = 0.9;
    m.source = 'damage';
    this.memories.set(attackerId, m);
  }

  tick(dt: number): void {
    this.clock += dt;
    // Expire stale visibility entries instead of clearing every tick.
    for (const [id, v] of this.visible) {
      if (this.clock - v.seenAt > 0.4) this.visible.delete(id);
    }
    for (const m of this.memories.values()) {
      m.time += dt;
      // Confidence decay: vision memory lingers longer than sound
      const halfLife = m.source === 'vision' ? 7 : m.source === 'damage' ? 9 : 4;
      m.confidence *= Math.exp(-dt / halfLife);
      if (m.confidence < 0.05) this.memories.delete(m.actorId);
    }
  }

  bestVisibleTarget(rangePref: number): { actor: Actor; dist: number } | null {
    let best: { actor: Actor; dist: number } | null = null;
    let bestScore = -Infinity;
    for (const v of this.visible.values()) {
      const rangeScore = 1 - Math.min(1, Math.abs(v.dist - rangePref) / 90);
      const score = rangeScore * 2 - v.dist / 200;
      if (score > bestScore) {
        bestScore = score;
        best = { actor: v.actor, dist: v.dist };
      }
    }
    return best;
  }

  mostConfidentMemory(maxAge: number): MemoryEntry | null {
    let best: MemoryEntry | null = null;
    for (const m of this.memories.values()) {
      if (m.time > maxAge) continue;
      if (!best || m.confidence > best.confidence) best = m;
    }
    return best;
  }
}
