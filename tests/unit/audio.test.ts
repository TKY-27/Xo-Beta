import { describe, expect, it } from 'vitest';
import { AUDIO_SAMPLE_TRIM_DB, sampleGainFor } from '../../src/audio/audio';

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
});
