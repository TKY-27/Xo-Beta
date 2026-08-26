/**
 * Storm: shrinking safe zone with escalating damage, randomized (non-concentric)
 * circle placement, phase announcements.
 */

import { STORM_INITIAL_RADIUS, STORM_PHASES } from '../core/balance';
import type { Rng } from '../core/rng';

export type StormState = 'idle' | 'waiting' | 'shrinking' | 'done';

export interface StormEvents {
  onPhaseWaiting(index: number, waitTime: number, targetRadius: number): void;
  onShrinkStart(index: number, shrinkTime: number): void;
  onFinalCircle(): void;
}

export class Storm {
  state: StormState = 'idle';
  phaseIndex = -1; // index of the phase currently waiting/shrinking
  timer = 0;

  centerX = 0;
  centerZ = 0;
  radius = STORM_INITIAL_RADIUS;

  private fromX = 0;
  private fromZ = 0;
  private fromR = STORM_INITIAL_RADIUS;
  private toX = 0;
  private toZ = 0;
  private toR = STORM_INITIAL_RADIUS;

  /** Current damage per second outside the circle. */
  dps = 1;

  constructor(
    public mapSize: number,
    public rng: Rng,
    public events: StormEvents,
  ) {}

  begin(): void {
    this.state = 'waiting';
    this.phaseIndex = 0;
    this.radius = STORM_INITIAL_RADIUS;
    this.centerX = 0;
    this.centerZ = 0;
    this.pickNextCircle();
    this.timer = STORM_PHASES[0]!.wait;
    this.dps = STORM_PHASES[0]!.dps * 0.6; // gentler before first shrink
    this.events.onPhaseWaiting(0, this.timer, this.toR);
  }

  private pickNextCircle(): void {
    const phase = STORM_PHASES[this.phaseIndex]!;
    const maxOffset = Math.max(0, this.radius - phase.radius);
    const ang = this.rng.angle();
    const dist = Math.sqrt(this.rng.next()) * maxOffset * 0.85;
    let nx = this.centerX + Math.cos(ang) * dist;
    let nz = this.centerZ + Math.sin(ang) * dist;
    // Keep mostly inside map bounds
    const lim = this.mapSize / 2 - 20;
    nx = Math.max(-lim, Math.min(lim, nx));
    nz = Math.max(-lim, Math.min(lim, nz));
    this.fromX = this.centerX;
    this.fromZ = this.centerZ;
    this.fromR = this.radius;
    this.toX = nx;
    this.toZ = nz;
    this.toR = phase.radius;
  }

  update(dt: number): void {
    if (this.state === 'idle' || this.state === 'done') return;
    this.timer -= dt;

    if (this.state === 'waiting') {
      if (this.timer <= 0) {
        this.state = 'shrinking';
        const phase = STORM_PHASES[this.phaseIndex]!;
        this.timer = phase.shrink;
        this.dps = phase.dps;
        this.events.onShrinkStart(this.phaseIndex, phase.shrink);
        if (this.phaseIndex >= STORM_PHASES.length - 1) this.events.onFinalCircle();
      }
      return;
    }

    // Shrinking
    if (this.timer <= 0) {
      this.centerX = this.toX;
      this.centerZ = this.toZ;
      this.radius = this.toR;
      const nextIdx = this.phaseIndex + 1;
      if (nextIdx < STORM_PHASES.length) {
        this.phaseIndex = nextIdx;
        this.state = 'waiting';
        this.timer = STORM_PHASES[nextIdx]!.wait;
        this.dps = STORM_PHASES[nextIdx]!.dps;
        this.pickNextCircle();
        this.events.onPhaseWaiting(nextIdx, this.timer, this.toR);
      } else {
        this.state = 'done';
      }
      return;
    }

    const phase = STORM_PHASES[this.phaseIndex]!;
    const t = 1 - this.timer / phase.shrink;
    this.centerX = this.fromX + (this.toX - this.fromX) * t;
    this.centerZ = this.fromZ + (this.toZ - this.fromZ) * t;
    this.radius = this.fromR + (this.toR - this.fromR) * t;
  }

  isOutside(x: number, z: number, margin = 0): boolean {
    const dx = x - this.centerX;
    const dz = z - this.centerZ;
    return dx * dx + dz * dz > (this.radius - margin) * (this.radius - margin);
  }

  distanceOutside(x: number, z: number): number {
    const d = Math.hypot(x - this.centerX, z - this.centerZ);
    return d - this.radius;
  }

  /** Next announced circle (for UI + AI planning). */
  nextCircle(): { x: number; z: number; r: number } {
    return { x: this.toX, z: this.toZ, r: this.toR };
  }

  /** QA/testing helper: jump straight into a shrinking phase. */
  qaForceShrink(toX: number, toZ: number, toR: number, duration: number): void {
    if (this.state === 'idle') this.begin();
    this.state = 'shrinking';
    this.phaseIndex = Math.min(this.phaseIndex, STORM_PHASES.length - 1);
    this.fromX = this.centerX;
    this.fromZ = this.centerZ;
    this.fromR = this.radius;
    this.toX = toX;
    this.toZ = toZ;
    this.toR = toR;
    this.timer = duration;
    this.dps = STORM_PHASES[this.phaseIndex]!.dps;
  }
}
