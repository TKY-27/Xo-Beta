/**
 * Per-match weather selection.
 *
 * Maps may author several WeatherProfile variants; the active one is picked
 * deterministically from the match seed so a given seed always replays with
 * the same weather (demos, QA runs and shareable seeds stay reproducible).
 * The first profile is the map's "usual" weather and carries the largest
 * weight — unusual skies stay special.
 */
import type { MapDef, WeatherProfile } from './types';
import { Rng } from '../core/rng';

const USUAL_WEIGHT = 3;

export function pickWeather(def: MapDef, seed: number): WeatherProfile | null {
  const profiles = def.weather;
  if (!profiles || profiles.length === 0) return null;
  if (profiles.length === 1) return profiles[0]!;
  const rng = new Rng(seed ^ 0x5eed_1a7);
  // Weighted pick: index 0 is the map's characteristic weather.
  const weights = profiles.map((_, index) => (index === 0 ? USUAL_WEIGHT : 1));
  let roll = rng.next() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < profiles.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return profiles[i]!;
  }
  return profiles[0]!;
}
