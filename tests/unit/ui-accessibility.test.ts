import { describe, expect, it } from 'vitest';
import {
  colorVisionCue,
  combatAlertPriority,
  orderCombatAlerts,
  type ColorVisionCueKind,
} from '../../src/ui/ui';

const cueKinds: ColorVisionCueKind[] = ['health', 'shield', 'ammo', 'storm', 'elimination', 'alert', 'hit', 'damage'];

describe('HUD accessibility presentation helpers', () => {
  it('adds a symbol and localized label for every non-default color-vision mode', () => {
    for (const mode of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      for (const kind of cueKinds) {
        const cue = colorVisionCue(mode, kind);
        expect(cue.symbol).not.toBe('');
        expect(cue.label).not.toBe('');
      }
    }
    expect(colorVisionCue('none', 'health')).toEqual({ symbol: '', label: '' });
  });

  it('uses distinct redundant symbols across color-vision modes', () => {
    const symbols = (['protanopia', 'deuteranopia', 'tritanopia'] as const)
      .map((mode) => colorVisionCue(mode, 'health').symbol);
    expect(new Set(symbols).size).toBe(3);
  });

  it('orders active combat alerts by safety priority and drops expired entries', () => {
    const ordered = orderCombatAlerts([
      { kind: 'banner', remaining: 3 },
      { kind: 'storm', remaining: 4 },
      { kind: 'elimination', remaining: 2 },
      { kind: 'banner', remaining: 0 },
    ]);
    expect(ordered.map((entry) => entry.kind)).toEqual(['elimination', 'storm', 'banner']);
    expect(combatAlertPriority('elimination')).toBeGreaterThan(combatAlertPriority('storm'));
    expect(combatAlertPriority('storm')).toBeGreaterThan(combatAlertPriority('banner'));
  });
});
