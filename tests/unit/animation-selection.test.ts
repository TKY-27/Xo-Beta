import { describe, expect, it } from 'vitest';
import { CLIP_MAP, locomotionTimeScale } from '../../src/render/characters';


describe('shared animation selection', () => {
  it('maps the licensed melee one-shots for every rig', () => {
    const keys = CLIP_MAP.map(([key]) => key);
    expect(keys).toContain('punch_jab');
    expect(keys).toContain('punch_cross');
    const authored = CLIP_MAP.map(([, clip]) => clip);
    expect(authored).toContain('Punch_Jab');
    expect(authored).toContain('Punch_Cross');
    // Every rig key resolves to exactly one authored clip.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rates locomotion clips from actual ground speed with bounded warping', () => {
    // Below nominal: slowed proportionally while inside the clamp window.
    expect(locomotionTimeScale('walk', 2.0)).toBeCloseTo(2.0 / 2.35, 6);
    // Under the lower clamp the rate stops shrinking.
    expect(locomotionTimeScale('walk', 1.2)).toBe(0.65);
    // At nominal: exactly 1.
    expect(locomotionTimeScale('jog', 5.9)).toBe(1);
    // Above nominal: clamped so legs never blur.
    expect(locomotionTimeScale('sprint', 30)).toBe(1.42);
    expect(locomotionTimeScale('sprint', 30, true)).toBe(1.55);
    // Lower clamp keeps stops from freezing mid-stride.
    expect(locomotionTimeScale('crouch_walk', 1.6)).toBeCloseTo(0.8, 6);
    // Non-locomotion clips always play at authored rate.
    expect(locomotionTimeScale('idle', 5)).toBe(1);
    expect(locomotionTimeScale('punch_jab', 5)).toBe(1);
  });

  it('is deterministic for identical inputs (frame-rate independent rate)', () => {
    const a = locomotionTimeScale('sprint', 10.8);
    const b = locomotionTimeScale('sprint', 10.8);
    expect(a).toBe(b);
  });


});
