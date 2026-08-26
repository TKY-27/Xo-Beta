import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { VfxSystem } from '../../src/render/vfx';

beforeAll(() => {
  const gradient = { addColorStop: vi.fn() };
  const context = {
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalCompositeOperation: 'source-over',
  };
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  });
});

interface VfxInternals {
  spawnParticle: (
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, color: number, gravity: number,
  ) => void;
  spawnShockwave: (x: number, y: number, z: number, life: number, color: number, additive: boolean) => void;
  particles: Array<{ life: number; pos: THREE.Vector3 }>;
  shockwaves: Array<{ mesh: THREE.Mesh }>;
}

describe('VFX pool stability', () => {
  it('integrates each particle once and caps a stalled-frame delta', () => {
    const vfx = new VfxSystem();
    const inner = vfx as unknown as VfxInternals;
    inner.spawnParticle(0, 0, 0, 1, 0, 0, 1, 0.1, 0xffffff, 0);
    vfx.update(0.5, new THREE.Vector3());
    const live = inner.particles.find((particle) => particle.life > 0);
    expect(live?.pos.x).toBeCloseTo(0.05, 6);
    expect(Number.isFinite(live?.pos.x)).toBe(true);
  });

  it('never assigns one pooled shockwave mesh to multiple active records', () => {
    const vfx = new VfxSystem();
    const inner = vfx as unknown as VfxInternals;
    for (let i = 0; i < 12; i++) inner.spawnShockwave(i, 0, 0, 1, 0xffffff, false);
    expect(inner.shockwaves).toHaveLength(8);
    expect(new Set(inner.shockwaves.map((wave) => wave.mesh)).size).toBe(inner.shockwaves.length);
  });
});
