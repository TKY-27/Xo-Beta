export interface FrameMetrics {
  avgFps: number;
  bestFps: number;
  onePercentLowFps: number;
  p95Ms: number;
  p99Ms: number;
  worstMs: number;
  over33: number;
  over50: number;
  durationMs: number;
  n: number;
}

export interface FrameProfile {
  warmup: FrameMetrics;
  steady: FrameMetrics;
  discardedBoundaryFrames: number;
}

const EMPTY_METRICS: FrameMetrics = {
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
};

/** Summarize frame deltas without destroying their chronological order. */
export function summarizeFrameDeltas(samples: number[], requestedWindow = 60): FrameMetrics {
  const deltas = samples.filter((sample) => Number.isFinite(sample) && sample > 0);
  if (deltas.length === 0) {
    return { ...EMPTY_METRICS };
  }

  const durationMs = deltas.reduce((sum, sample) => sum + sample, 0);
  const average = durationMs / deltas.length;
  const sorted = [...deltas].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;

  const slowCount = Math.max(1, Math.ceil(deltas.length * 0.01));
  const slowest = sorted.slice(sorted.length - slowCount);
  const slowAverage = slowest.reduce((sum, sample) => sum + sample, 0) / slowest.length;

  const windowSize = Math.max(1, Math.min(requestedWindow, deltas.length));
  let windowSum = 0;
  for (let i = 0; i < windowSize; i++) windowSum += deltas[i]!;
  let bestAverage = windowSum / windowSize;
  for (let i = windowSize; i < deltas.length; i++) {
    windowSum += deltas[i]! - deltas[i - windowSize]!;
    bestAverage = Math.min(bestAverage, windowSum / windowSize);
  }

  return {
    avgFps: Math.round(1000 / average),
    bestFps: Math.round(1000 / bestAverage),
    onePercentLowFps: Math.round(1000 / slowAverage),
    p95Ms: +percentile(0.95).toFixed(2),
    p99Ms: +percentile(0.99).toFixed(2),
    worstMs: +sorted[sorted.length - 1]!.toFixed(2),
    over33: deltas.filter((sample) => sample > 33).length,
    over50: deltas.filter((sample) => sample > 50).length,
    durationMs: +durationMs.toFixed(2),
    n: deltas.length,
  };
}

/**
 * Split one chronological capture into explicit warm-up and steady-state
 * intervals. A frame crossing either boundary is discarded instead of being
 * attributed to the wrong phase; this is important for shader/streaming
 * hitches near the transition.
 */
export function summarizeFrameProfile(
  samples: number[],
  warmupDurationMs = 4000,
  steadyDurationMs = 6000,
  requestedWindow = 60,
): FrameProfile {
  const warmup: number[] = [];
  const steady: number[] = [];
  const warmupEnd = Math.max(0, warmupDurationMs);
  const steadyEnd = warmupEnd + Math.max(0, steadyDurationMs);
  let elapsed = 0;
  let discardedBoundaryFrames = 0;

  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample <= 0) continue;
    const start = elapsed;
    const end = elapsed + sample;
    elapsed = end;
    if (end <= warmupEnd) {
      warmup.push(sample);
    } else if (start >= warmupEnd && end <= steadyEnd) {
      steady.push(sample);
    } else if (start < steadyEnd && end > warmupEnd) {
      discardedBoundaryFrames++;
    }
    if (start >= steadyEnd) break;
  }

  return {
    warmup: summarizeFrameDeltas(warmup, requestedWindow),
    steady: summarizeFrameDeltas(steady, requestedWindow),
    discardedBoundaryFrames,
  };
}
