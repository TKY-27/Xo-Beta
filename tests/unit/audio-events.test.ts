import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events';
import { attachAudio } from '../../src/audio/audio';
import type { MatchEventsMap } from '../../src/sim/match';

function setup() {
  const bus = new EventBus<MatchEventsMap>();
  const pickupFx = vi.fn();
  const cancelMatchEffects = vi.fn();
  const audio = { pickupFx, cancelMatchEffects };
  const match = { actors: [], localActorId: 7 };
  const dispose = attachAudio(match as never, audio as never, bus);
  return { bus, pickupFx, cancelMatchEffects, dispose };
}

function pickup(
  actorId: number,
  rare = false,
  kind: 'weapon' | 'ammo' | 'heal' | undefined = 'weapon',
): MatchEventsMap['itemPickedUp'] {
  return { itemId: 1, actorId, rare, kind };
}

describe('local-only pickup presentation', () => {
  it('plays exactly one common pickup sound for the local actor', () => {
    const { bus, pickupFx } = setup();

    bus.emit('itemPickedUp', pickup(7));

    expect(pickupFx).toHaveBeenCalledTimes(1);
    expect(pickupFx).toHaveBeenCalledWith('weapon', false);
  });

  it('keeps bot pickups silent', () => {
    const { bus, pickupFx } = setup();

    bus.emit('itemPickedUp', pickup(2));

    expect(pickupFx).not.toHaveBeenCalled();
  });

  it('keeps a remote human actor silent at the multiplayer presentation boundary', () => {
    const { bus, pickupFx } = setup();

    bus.emit('itemPickedUp', pickup(8));

    expect(pickupFx).not.toHaveBeenCalled();
  });

  it('preserves the rare local pickup variation', () => {
    const { bus, pickupFx } = setup();

    bus.emit('itemPickedUp', pickup(7, true));

    expect(pickupFx).toHaveBeenCalledTimes(1);
    expect(pickupFx).toHaveBeenCalledWith('weapon', true);
  });

  it('does not double-play one pickup event', () => {
    const { bus, pickupFx } = setup();

    bus.emit('itemPickedUp', pickup(7));

    expect(pickupFx).toHaveBeenCalledTimes(1);
  });

  it('forwards the pickup kind so the foley layer can match the item', () => {
    const { bus, pickupFx } = setup();

    bus.emit('itemPickedUp', pickup(7, false, 'ammo'));
    bus.emit('itemPickedUp', pickup(7, false, 'heal'));

    expect(pickupFx).toHaveBeenNthCalledWith(1, 'ammo', false);
    expect(pickupFx).toHaveBeenNthCalledWith(2, 'heal', false);
  });
});
