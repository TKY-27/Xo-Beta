import { describe, expect, it } from 'vitest';
import { summarizeFrameDeltas, summarizeFrameProfile } from '../browser/frame-metrics';

describe('browser frame metrics', () => {
  it('keeps the best window chronological instead of sorting samples first', () => {
    const metrics = summarizeFrameDeltas([10, 100, 10, 100], 2);
    expect(metrics.bestFps).toBe(18);
  });

  it('reports slow-frame percentiles and one-percent-low FPS from a sorted copy', () => {
    const samples = Array.from({ length: 99 }, () => 10).concat(100);
    const metrics = summarizeFrameDeltas(samples, 60);
    expect(metrics.p95Ms).toBe(10);
    expect(metrics.p99Ms).toBe(10);
    expect(metrics.onePercentLowFps).toBe(10);
    expect(metrics.worstMs).toBe(100);
    expect(metrics.over33).toBe(1);
    expect(metrics.over50).toBe(1);
    expect(metrics.durationMs).toBe(1090);
    expect(samples.at(-1)).toBe(100);
  });

  it('uses the available sample count when the requested window is larger', () => {
    expect(summarizeFrameDeltas([20, 20], 60).bestFps).toBe(50);
  });

  it('returns finite zeroes for an empty or invalid sample', () => {
    expect(summarizeFrameDeltas([0, Number.NaN, -1])).toEqual({
      avgFps: 0,
      bestFps: 0,
      onePercentLowFps: 0,
      p95Ms: 0,
      p99Ms: 0,
      worstMs: 0,
      over33: 0,
      over50: 0,
      durationMs: 0,
      n: 0,
    });
  });

  it('separates warm-up from steady state without assigning a crossing frame', () => {
    const profile = summarizeFrameProfile([10, 10, 85, 10, 10, 15], 100, 30, 2);
    expect(profile.warmup.n).toBe(2);
    expect(profile.warmup.worstMs).toBe(10);
    expect(profile.steady.n).toBe(2);
    expect(profile.steady.worstMs).toBe(10);
    expect(profile.discardedBoundaryFrames).toBe(2);
  });

  it('keeps invalid samples out of both phase durations', () => {
    const profile = summarizeFrameProfile([Number.NaN, -1, 20, 20, 20], 40, 20);
    expect(profile.warmup.durationMs).toBe(40);
    expect(profile.steady.durationMs).toBe(20);
  });
});
