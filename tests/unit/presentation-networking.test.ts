import { describe, expect, it } from 'vitest';
import { AUTHORITATIVE_EVENT_TYPES } from '../../src/net/hostMatchSession';
import { DECAL_BUDGETS } from '../../src/render/impactDecals';
import { WEAPONS } from '../../src/core/balance';



describe('presentation networking invariants', () => {
  it('impact decals derive from the already-networked impact event only', () => {
    // v0.4 deliberately added meleeSwing (bounded, low frequency) so guests
    // see punches; melee hits stay host-authoritative in the meleeHit flow.
    expect(AUTHORITATIVE_EVENT_TYPES).toContain('meleeSwing');
    // No decal/tracer-specific event types were added to the wire format.
    expect(AUTHORITATIVE_EVENT_TYPES.filter((t) => t.toLowerCase().includes('decal'))).toEqual([]);
    expect(AUTHORITATIVE_EVENT_TYPES.filter((t) => t.toLowerCase().includes('tracer'))).toEqual([]);
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
