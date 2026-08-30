import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events';
import { attachAudio } from '../../src/audio/audio';
import type { MatchEventsMap } from '../../src/sim/match';

function setup() {
  const bus = new EventBus<MatchEventsMap>();
  const pickupUi = vi.fn();
  const cancelMatchEffects = vi.fn();
  const audio = { pickupUi, cancelMatchEffects };
  const match = { actors: [], localActorId: 7 };
  const dispose = attachAudio(match as never, audio as never, bus);
  return { bus, pickupUi, cancelMatchEffects, dispose };
}

function pickup(actorId: number, rare = false): MatchEventsMap['itemPickedUp'] {
  return { itemId: 1, actorId, rare };
}

describe('local-only pickup presentation', () => {
  it('plays exactly one common pickup sound for the local actor', () => {
    const { bus, pickupUi } = setup();

    bus.emit('itemPickedUp', pickup(7));

    expect(pickupUi).toHaveBeenCalledTimes(1);
    expect(pickupUi).toHaveBeenCalledWith(false);
  });

  it('keeps bot pickups silent', () => {
    const { bus, pickupUi } = setup();

    bus.emit('itemPickedUp', pickup(2));

    expect(pickupUi).not.toHaveBeenCalled();
  });

  it('keeps a remote human actor silent at the multiplayer presentation boundary', () => {
    const { bus, pickupUi } = setup();

    bus.emit('itemPickedUp', pickup(8));

    expect(pickupUi).not.toHaveBeenCalled();
  });

  it('preserves the rare local pickup variation', () => {
    const { bus, pickupUi } = setup();

    bus.emit('itemPickedUp', pickup(7, true));

    expect(pickupUi).toHaveBeenCalledTimes(1);
    expect(pickupUi).toHaveBeenCalledWith(true);
  });

  it('does not double-play one pickup event', () => {
    const { bus, pickupUi } = setup();

    bus.emit('itemPickedUp', pickup(7));

    expect(pickupUi).toHaveBeenCalledTimes(1);
  });
});
