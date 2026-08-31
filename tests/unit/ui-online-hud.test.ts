import { describe, expect, it } from 'vitest';
import { onlineConnectionLabel, type OnlineHudState } from '../../src/ui/ui';

describe('online HUD presentation contract', () => {
  it('maps every transport state to a localized label key', () => {
    expect(onlineConnectionLabel('connecting')).toBe('hud.connectionConnecting');
    expect(onlineConnectionLabel('connected')).toBe('hud.onlineStatus');
    expect(onlineConnectionLabel('reconnecting')).toBe('hud.connectionReconnecting');
    expect(onlineConnectionLabel('disconnected')).toBe('hud.connectionDisconnected');
    expect(onlineConnectionLabel('failed')).toBe('hud.connectionFailed');
  });

  it('keeps diagnostics optional and teammate state presentation-only', () => {
    const state: OnlineHudState = {
      connection: 'connected',
      rttMs: 42,
      packetLossPercent: 1,
      teammates: [{ participantId: 'p2', displayName: 'Ally', alive: false }],
    };
    expect(state.diagnostics).toBeUndefined();
    expect(state.teammates?.[0]).toEqual({ participantId: 'p2', displayName: 'Ally', alive: false });
  });
});
