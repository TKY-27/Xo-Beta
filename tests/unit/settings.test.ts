import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('persistent settings boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  async function loadWith(value: unknown) {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify(value),
      setItem: () => undefined,
    });
    return import('../../src/core/settings');
  }

  it('accepts valid stored values and preserves valid partial bindings', async () => {
    const { getSettings } = await loadWith({
      quality: 'low',
      fov: 96,
      reducedMotion: true,
      tpsCharacterSide: 'right',
      playerSkin: 'specter',
      bindings: { forward: 'KeyI' },
    });

    expect(getSettings()).toMatchObject({ quality: 'low', fov: 96, reducedMotion: true, tpsCharacterSide: 'right', playerSkin: 'specter' });
    expect(getSettings().bindings.forward).toBe('KeyI');
    expect(getSettings().bindings.back).toBe('KeyS');
  });

  it('rejects invalid types and clamps finite numeric values', async () => {
    const { getSettings } = await loadWith({
      quality: '__invalid__',
      fov: 1_000,
      masterVolume: -5,
      resolutionScale: Number.NaN,
      crosshairColor: 'url(javascript:bad)',
      bindings: { forward: '\n', jump: 'Space', __proto__: { fire: 'Bad' } },
    });
    const settings = getSettings();

    expect(settings.quality).toBe('high');
    expect(settings.fov).toBe(110);
    expect(settings.masterVolume).toBe(0);
    expect(settings.resolutionScale).toBe(0.5);
    expect(settings.shadowQuality).toBe('medium');
    expect(settings.aa).toBe('fxaa');
    expect(settings.crosshairColor).toBe('#eaf6ff');
    expect(settings.bindings.forward).toBe('KeyW');
    expect(settings.bindings.jump).toBe('Space');
    expect(settings.tpsCharacterSide).toBe('left');
    expect(settings.playerSkin).toBe('vanguard');
    expect(settings.bindings.shoulderSwap).toBe('KeyZ');
  });

  it('falls back cleanly for arrays and null', async () => {
    let module = await loadWith([]);
    expect(module.getSettings().bindings.forward).toBe('KeyW');
    expect(module.getSettings().fov).toBe(80);

    vi.resetModules();
    module = await loadWith(null);
    expect(module.getSettings().quality).toBe('high');
  });
});
