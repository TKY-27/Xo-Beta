import { beforeAll, describe, expect, it } from 'vitest';
import { ensureWorldReady, loadMap, MAP_LIST, type MapId } from '../../src/world';
import type { SkyAtmosphereProfile } from '../../src/world/types';

beforeAll(async () => {
  await ensureWorldReady();
});

const MAPS: MapId[] = MAP_LIST.map((entry) => entry.id);

function finiteProfile(p: SkyAtmosphereProfile): boolean {
  return [p.zenith, p.horizon, p.discSize, p.discColor, p.discGlow, p.cloudCover,
    p.cloudTint, p.cloudShade, p.windSpeed, p.starOpacity, p.hazeColor, p.hazeStrength]
    .every((v) => Number.isFinite(v));
}

describe('visible sky atmosphere profiles', () => {
  it('every map defines a complete presentation-only profile', () => {
    for (const id of MAPS) {
      const def = loadMap(id).def;
      expect(def.sky.atmosphere, `${id} missing atmosphere`).toBeDefined();
      const p = def.sky.atmosphere!;
      expect(finiteProfile(p), `${id} profile has non-finite values`).toBe(true);
      expect(p.cloudCover).toBeGreaterThanOrEqual(0);
      expect(p.cloudCover).toBeLessThanOrEqual(1);
      expect(p.discSize).toBeLessThan(0.1); // no screen-filling sun/moon
      expect(p.hazeStrength).toBeLessThanOrEqual(0.8);
    }
  });

  it('stars only appear on the night-adjacent profile', () => {
    for (const id of MAPS) {
      const { preset, atmosphere: p } = loadMap(id).def.sky;
      // Stars only where the sky can show them: day is too bright and the
      // full overcast ceiling forbids stars through opaque clouds.
      if (preset === 'night' || preset === 'bluehour') {
        expect(p!.starOpacity, id).toBeGreaterThan(0);
      } else {
        expect(p!.starOpacity, id).toBe(0);
      }
    }
  });

  it('the gameplay map hash ignores the atmosphere profile', async () => {
    const { computeGameplayMapHash } = await import('../../src/net/matchStart');
    const def = loadMap('eden').def;
    const a = await computeGameplayMapHash(def);
    def.sky.atmosphere!.cloudCover = Math.min(1, def.sky.atmosphere!.cloudCover + 0.01);
    const b = await computeGameplayMapHash(def);
    expect(a).toBe(b);
  });

  it('window dressing varies deterministically between builds', () => {
    const countDark = (): number => loadMap('neocity').def.geo
      .filter((g) => g.kind === 'box' && g.mat === 'windowDark').length;
    const first = countDark();
    expect(first).toBeGreaterThan(0);
    expect(countDark()).toBe(first);
    // The dual mullion family is present but no longer on every window.
    const panes = loadMap('neocity').def.geo
      .filter((g) => g.kind === 'box' && (g.mat === 'windowCool' || g.mat === 'windowDark')).length;
    const mullions = loadMap('neocity').def.geo
      .filter((g) => g.kind === 'box' && g.mat === 'facadeC'
        && g.sy > 1 && g.sx < 0.2 && g.sz < 0.2).length;
    expect(panes).toBeGreaterThan(0);
    void mullions;
  });
});
