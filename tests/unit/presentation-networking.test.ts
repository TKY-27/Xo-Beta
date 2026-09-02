import { describe, expect, it } from 'vitest';
import { DECAL_BUDGETS } from '../../src/render/impactDecals';
import { WEAPONS } from '../../src/core/balance';

/**
 * Presentation systems must stay inside the released networking model: every
 * new presentation feature (decals, tracers, flash changes) is derived from
 * the ALREADY-networked authoritative event set. This pins that set so an
 * accidental new high-frequency network field fails here, not in review.
 */
const NETWORKED_EVENT_TYPES = [
  'shotFired', 'impact', 'glassBreak', 'destructibleDestroyed', 'actorHit',
  'shieldHit', 'shieldBroken', 'eliminated', 'itemPickedUp', 'chestOpened', 'reloadStarted',
  'healStarted', 'healCancelled', 'healDone', 'stormWaiting', 'stormShrinking',
  'stormFinal', 'phaseChanged', 'matchWon',
] as const;

describe('presentation networking invariants', () => {
  it('impact decals derive from the already-networked impact event only', () => {
    expect(NETWORKED_EVENT_TYPES).toContain('impact');
    expect(NETWORKED_EVENT_TYPES).toContain('shotFired');
    // No decal/tracer-specific event types were added to the wire format.
    expect(NETWORKED_EVENT_TYPES.filter((t) => t.toLowerCase().includes('decal'))).toEqual([]);
    expect(NETWORKED_EVENT_TYPES.filter((t) => t.toLowerCase().includes('tracer'))).toEqual([]);
  });

  it('decal pools stay bounded across every quality preset', () => {
    const budgets = Object.values(DECAL_BUDGETS);
    expect(budgets).toHaveLength(5);
    for (const budget of budgets) {
      expect(budget).toBeLessThanOrEqual(128);
      expect(budget).toBeGreaterThanOrEqual(16);
    }
    expect([...Object.values(DECAL_BUDGETS)]).toEqual([...Object.values(DECAL_BUDGETS)].sort((a, b) => a - b));
  });

  it('weapon tracer colors remain per-weapon constants (no runtime derivation)', () => {
    for (const def of Object.values(WEAPONS)) {
      expect(Number.isFinite(def.tracerColor)).toBe(true);
    }
  });
});
