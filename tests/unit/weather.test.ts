import { describe, expect, it } from 'vitest';
import { pickWeather } from '../../src/world/weather';
import { loadMap, type MapId } from '../../src/world';

describe('pickWeather', () => {
  it('returns null when the map has no weather variants', () => {
    const def = { weather: [] } as unknown as Parameters<typeof pickWeather>[0];
    expect(pickWeather(def, 1234)).toBeNull();
  });

  it('is deterministic for a given seed', () => {
    for (const seed of [1, 42, 999999, 0]) {
      const def = {
        weather: [{ id: 'usual' }, { id: 'rare' }, { id: 'rarer' }],
      } as unknown as Parameters<typeof pickWeather>[0];
      expect(pickWeather(def, seed)).toBe(pickWeather(def, seed));
    }
  });

  it('always returns one of the map profiles', () => {
    const profiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const def = { weather: profiles } as unknown as Parameters<typeof pickWeather>[0];
    for (let seed = 0; seed < 200; seed++) {
      expect(profiles).toContain(pickWeather(def, seed));
    }
  });

  it('favors the usual (first) profile across many seeds', () => {
    const profiles = [{ id: 'usual' }, { id: 'rare' }];
    const def = { weather: profiles } as unknown as Parameters<typeof pickWeather>[0];
    let usual = 0;
    const runs = 500;
    for (let seed = 0; seed < runs; seed++) {
      if (pickWeather(def, seed)?.id === 'usual') usual++;
    }
    // 3:1 weighting → expect ~75%; anything above half proves the bias.
    expect(usual / runs).toBeGreaterThan(0.5);
  });

  it('every shipped map defines weather variants with i18n-addressable ids', () => {
    for (const id of ['neocity', 'oldfront', 'eden', 'ashara'] satisfies MapId[]) {
      const { def } = loadMap(id);
      expect(def.weather?.length ?? 0).toBeGreaterThanOrEqual(2);
      for (const profile of def.weather ?? []) {
        expect(profile.id).toMatch(/^[a-zA-Z]+$/);
      }
    }
  });
});
