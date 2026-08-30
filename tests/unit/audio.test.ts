import { describe, expect, it } from 'vitest';
import {
  AUDIO_SAMPLE_TRIM_DB,
  gunshotDistanceBand,
  gunshotProfileFor,
  REMOTE_GUNSHOT_VOICE_LIMITS,
  sampleGainFor,
} from '../../src/audio/audio';

describe('audio sample calibration', () => {
  it('keeps firearm recordings in a consistent near-field range', () => {
    const firearmKeys = [
      'gun/pistol_a', 'gun/pistol_b', 'gun/pistol_c',
      'gun/smg_a', 'gun/smg_b', 'gun/ar_a', 'gun/ar_b',
      'gun/shotgun_a', 'gun/sniper_a',
    ];
    const gains = firearmKeys.map(sampleGainFor);
    expect(new Set(gains).size).toBe(1);
    expect(gains[0]).toBeCloseTo(10 ** (4.5 / 20), 8);
  });

  it('raises the unusually quiet chest reveal at the sample boundary', () => {
    expect(AUDIO_SAMPLE_TRIM_DB['chest/open_a']).toBe(12);
    expect(sampleGainFor('chest/open_a')).toBeCloseTo(10 ** (12 / 20), 8);
    expect(sampleGainFor('chest/open_a')).toBeGreaterThan(sampleGainFor('gun/pistol_a'));
  });

  it('does not apply hidden gain to uncalibrated sounds', () => {
    expect(sampleGainFor('impact/metal_a')).toBe(1);
  });

  it('selects local and remote firearm profiles by measured distance bands', () => {
    const distances = [10, 25, 50, 100, 150];
    expect(distances.map((distance) => gunshotDistanceBand(distance, false))).toEqual([
      'remote-near', 'remote-near', 'remote-mid', 'remote-far', 'remote-far',
    ]);
    expect(gunshotDistanceBand(150, true)).toBe('local');

    const near = gunshotProfileFor(10, false);
    const mid = gunshotProfileFor(50, false);
    const far = gunshotProfileFor(150, false);
    expect(near.reportGain).toBeGreaterThan(mid.reportGain);
    expect(mid.reportGain).toBeGreaterThan(far.reportGain);
    expect(far.reportLp).toBeLessThan(mid.reportLp);
    expect(far.tailGain).toBeGreaterThan(far.reportGain);
    expect(near.reportRolloff).toBeLessThan(far.reportRolloff);
  });

  it('gives near remote shots priority over capped far-shot voices', () => {
    expect(REMOTE_GUNSHOT_VOICE_LIMITS['remote-near']).toBeGreaterThan(REMOTE_GUNSHOT_VOICE_LIMITS['remote-mid']);
    expect(REMOTE_GUNSHOT_VOICE_LIMITS['remote-mid']).toBeGreaterThan(REMOTE_GUNSHOT_VOICE_LIMITS['remote-far']);
    expect(Object.values(REMOTE_GUNSHOT_VOICE_LIMITS).reduce((sum, limit) => sum + limit, 0)).toBe(9);
  });
});
