import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DECAL_BUDGETS, DECAL_FADE, DECAL_LIFE, ImpactDecalSystem } from '../../src/render/impactDecals';

beforeAll(() => {
  const gradient = { addColorStop: vi.fn() };
  const context = {
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    clearRect: vi.fn(),
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

interface DecalInternals {
  records: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; size: number; life: number; age: number }>;
  mesh: THREE.InstancedMesh;
  prewarm: () => void;
}

function makeSystem(quality: keyof typeof DECAL_BUDGETS = 'high'): ImpactDecalSystem {
  const scene = new THREE.Scene();
  return new ImpactDecalSystem(scene, quality);
}

describe('ImpactDecalSystem', () => {
  it('spawns one mark per impact with deterministic orientation from identity', () => {
    const system = makeSystem();
    const inner = system as unknown as DecalInternals;
    system.spawn(1, 2, 3, 0, 1, 0, 'stone', 'event-17');
    system.spawn(1, 2, 3, 0, 1, 0, 'stone', 'event-17');
    system.spawn(1, 2, 3, 0, 1, 0, 'stone', 'event-18');
    // A re-delivered identity is deduplicated instead of growing the pool.
    expect(inner.records).toHaveLength(2);
    expect(inner.records[0]!.quaternion.equals(inner.records[1]!.quaternion)).toBe(false);
    // Same identity reproduces the same orientation bit-for-bit.
    const scene2 = new THREE.Scene();
    const other = new ImpactDecalSystem(scene2, 'high');
    const otherInner = other as unknown as DecalInternals;
    other.spawn(1, 2, 3, 0, 1, 0, 'stone', 'event-17');
    expect(otherInner.records[0]!.quaternion.equals(inner.records[0]!.quaternion)).toBe(true);
    expect(otherInner.records[0]!.size).toBeCloseTo(inner.records[0]!.size, 10);
  });

  it('never spawns marks on excluded materials', () => {
    const system = makeSystem();
    const inner = system as unknown as DecalInternals;
    system.spawn(0, 0, 0, 0, 1, 0, 'water', 'a');
    system.spawn(0, 0, 0, 0, 1, 0, 'foliage', 'b');
    system.spawn(0, 0, 0, 0, 1, 0, 'glass', 'c');
    expect(inner.records).toHaveLength(0);
  });

  it('caps the pool at the quality budget and recycles the oldest', () => {
    const system = makeSystem('low');
    expect(system.budget).toBe(DECAL_BUDGETS.low);
    const inner = system as unknown as DecalInternals;
    for (let i = 0; i < DECAL_BUDGETS.low + 10; i++) {
      system.spawn(i * 3, 0, 0, 0, 1, 0, 'stone', `id-${i}`);
    }
    expect(system.activeCount).toBe(DECAL_BUDGETS.low);
    // Oldest recycled: the earliest identities are gone.
    expect(inner.records.some((r) => Math.abs(r.position.x) < 1)).toBe(false);
  });

  it('keeps marks fully visible for DECAL_LIFE and removes them after the fade', () => {
    const system = makeSystem();
    const inner = system as unknown as DecalInternals;
    system.spawn(0, 0, 0, 0, 1, 0, 'metal', 'x');
    const step = 1 / 60;
    for (let t = 0; t < DECAL_LIFE - 0.2; t += step) system.update(step);
    expect(system.activeCount).toBe(1);
    expect(inner.records[0]!.size).toBeGreaterThan(0);
    for (let t = 0; t < DECAL_FADE + 0.3; t += step) system.update(step);
    expect(system.activeCount).toBe(0);
    expect(inner.mesh.count).toBe(0);
  });

  it('quality change rebuilds the pool without exceeding the new budget', () => {
    const scene = new THREE.Scene();
    const system = new ImpactDecalSystem(scene, 'cinematic');
    expect(system.budget).toBe(DECAL_BUDGETS.cinematic);
    for (let i = 0; i < 40; i++) system.spawn(i, 0, 0, 0, 1, 0, 'stone', `q-${i}`);
    system.setQuality('low');
    expect(system.budget).toBe(DECAL_BUDGETS.low);
    expect(system.activeCount).toBeLessThanOrEqual(DECAL_BUDGETS.low);
    system.dispose();
  });

  it('offsets marks off the surface along the impact normal', () => {
    const system = makeSystem();
    const inner = system as unknown as DecalInternals;
    system.spawn(5, 5, 5, 0, 0, 1, 'concrete' as string, 'off-1');
    const record = inner.records[0]!;
    expect(record.position.z).toBeGreaterThan(5.005);
    expect(record.position.x).toBeCloseTo(5, 6);
  });
});
