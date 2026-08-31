import { describe, expect, it } from 'vitest';
import {
  HostClockEstimator,
  RemoteInterpolationBuffer,
  type InterpolationState,
} from '../../src/net/interpolation';

interface FixtureState extends InterpolationState {
  readonly marker: string;
}

function state(x: number, alive = true, phase: string = 'live', velocityX = 0): FixtureState {
  return {
    marker: `x-${x}`,
    phase,
    actors: [{
      id: 1,
      alive,
      position: { x, y: 0, z: 0 },
      velocity: { x: velocityX, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
    }],
  };
}

describe('adaptive remote interpolation', () => {
  it('estimates host offset/RTT and keeps the adaptive buffer within 80–120 ms', () => {
    const clock = new HostClockEstimator();
    expect(clock.bufferMs).toBe(100);
    const estimate = clock.observe({ clientSentAt: 0, clientReceivedAt: 40, hostTime: 120 });
    expect(estimate.offsetMs).toBe(100);
    expect(estimate.rttMs).toBe(40);
    expect(estimate.bufferMs).toBeGreaterThanOrEqual(80);
    expect(estimate.bufferMs).toBeLessThanOrEqual(120);
    for (let i = 1; i < 8; i++) clock.observe({ clientSentAt: i * 100, clientReceivedAt: i * 100 + 400, hostTime: i * 100 + 500 });
    expect(clock.bufferMs).toBe(120);
  });

  it('orders snapshots by host time, interpolates in the past, and drops stale revisions', () => {
    const buffer = new RemoteInterpolationBuffer<FixtureState>({ baseBufferMs: 80, maxExtrapolationMs: 60 });
    expect(buffer.push({ revision: 2, hostTime: 100, state: state(10) }, 100)).toBe(true);
    expect(buffer.push({ revision: 1, hostTime: 0, state: state(0) }, 0)).toBe(false);
    // The presentation timestamp is 90 ms, so this is close to the older
    // sample rather than the raw newest x=10 sample.
    expect(buffer.sample(180)?.actors[0]?.position.x).toBeCloseTo(10);
    expect(buffer.droppedCount).toBe(1);
  });

  it('supports a short capped extrapolation and applies death/phase changes immediately', () => {
    const buffer = new RemoteInterpolationBuffer<FixtureState>({
      baseBufferMs: 80,
      maxExtrapolationMs: 30,
      maxExtrapolationDistance: 1,
    });
    // Revision order is authoritative even when host timestamps arrive out of order.
    buffer.push({ revision: 1, hostTime: 0, state: state(0) }, 0);
    buffer.push({ revision: 2, hostTime: 100, state: state(10) }, 100);
    buffer.push({ revision: 3, hostTime: 200, state: state(10, false) }, 200);
    const dead = buffer.sample(300);
    expect(dead?.actors[0]?.alive).toBe(false);
    expect(dead?.actors[0]?.position.x).toBe(10);

    const phaseBuffer = new RemoteInterpolationBuffer<FixtureState>({ baseBufferMs: 0, minBufferMs: 0, maxBufferMs: 120 });
    phaseBuffer.push({ revision: 1, hostTime: 0, state: state(0, true, 'transport') }, 0);
    phaseBuffer.push({ revision: 2, hostTime: 100, state: state(10, true, 'live') }, 100);
    expect(phaseBuffer.sample(60)?.phase).toBe('live');
  });

  it('interpolates velocity for remote animation instead of stepping at the midpoint', () => {
    const buffer = new RemoteInterpolationBuffer<FixtureState>({
      baseBufferMs: 20,
      minBufferMs: 20,
      maxBufferMs: 20,
    });
    buffer.push({ revision: 1, hostTime: 0, state: state(0, true, 'live', 0) }, 0);
    buffer.push({ revision: 2, hostTime: 100, state: state(10, true, 'live', 10) }, 100);
    const sampled = buffer.sample(70);
    expect(sampled?.actors[0]?.position.x).toBeCloseTo(5);
    expect(sampled?.actors[0]?.velocity?.x).toBeCloseTo(5);
  });

  it('lets a read-only world sweep stop extrapolation before scenery', () => {
    const buffer = new RemoteInterpolationBuffer<FixtureState>({
      baseBufferMs: 80,
      minBufferMs: 80,
      maxBufferMs: 80,
      maxExtrapolationMs: 60,
      constrainExtrapolatedPosition: (from) => ({ ...from }),
    });
    buffer.push({ revision: 1, hostTime: 0, state: state(0) }, 0);
    buffer.push({ revision: 2, hostTime: 100, state: state(10) }, 100);
    expect(buffer.sample(240)?.actors[0]?.position.x).toBe(10);
  });
});
