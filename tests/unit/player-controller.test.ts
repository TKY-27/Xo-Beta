import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events';
import { MOVE } from '../../src/core/balance';
import {
  PlayerController,
  QA_TAP_HOLD_MS,
} from '../../src/player/controller';
import { GamepadInput, type GamepadCallbacks } from '../../src/player/gamepad';

class FakeWindow extends EventTarget {
  setTimeout = setTimeout;
}

class FakeDocument extends EventTarget {
  pointerLockElement: unknown = null;
  exitPointerLock(): void {
    this.pointerLockElement = null;
  }
}

function keyEvent(type: 'keydown' | 'keyup', code: string, repeat = false): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    repeat: { value: repeat },
  });
  return event;
}

describe('QA input timing', () => {
  let now = 0;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('window', new FakeWindow());
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('location', { search: '?qa=1' });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  function makeController(): PlayerController {
    const canvas = {
      requestPointerLock: () => undefined,
    } as unknown as HTMLCanvasElement;
    const controller = new PlayerController(
      canvas,
      new EventBus(),
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );
    controller.enabled = true;
    return controller;
  }

  const actor = { wpn: { adsAmount: 0 } } as never;

  it('reacts on the first production input sample and stops on the first sample after keyup', () => {
    vi.stubGlobal('location', { search: '' });
    const controller = makeController();

    window.dispatchEvent(keyEvent('keydown', 'KeyW'));
    expect(controller.updateCommand(actor, 1 / 60).moveZ).toBe(1);

    window.dispatchEvent(keyEvent('keyup', 'KeyW'));
    expect(controller.updateCommand(actor, 1 / 60).moveZ).toBe(0);
    controller.dispose();
  });

  it('samples a very short tap promptly, then releases after the minimum window', () => {
    expect(MOVE.sprintSpeed * (QA_TAP_HOLD_MS / 1000)).toBeLessThan(2.5);
    const controller = makeController();
    window.dispatchEvent(keyEvent('keydown', 'KeyW'));
    now = 10;
    window.dispatchEvent(keyEvent('keyup', 'KeyW'));
    expect(controller.updateCommand(actor, 1 / 60).moveZ).toBe(1);
    now = QA_TAP_HOLD_MS + 1;
    expect(controller.updateCommand(actor, 1 / 60).moveZ).toBe(0);
    controller.dispose();
  });

  it('preserves a genuine hold and stops on keyup without added travel', () => {
    const controller = makeController();
    window.dispatchEvent(keyEvent('keydown', 'KeyW'));
    now = 400;
    expect(controller.updateCommand(actor, 1 / 60).moveZ).toBe(1);
    window.dispatchEvent(keyEvent('keyup', 'KeyW'));
    expect(controller.updateCommand(actor, 1 / 60).moveZ).toBe(0);
    controller.dispose();
  });

  it('moves promptly but only about one walking step for a very short W tap', () => {
    const controller = makeController();
    window.dispatchEvent(keyEvent('keydown', 'KeyW'));
    now = 10;
    window.dispatchEvent(keyEvent('keyup', 'KeyW'));
    let movedOnFirstFrame = false;
    let distance = 0;
    for (let frame = 0; frame < 24; frame++) {
      now = 10 + frame * (1000 / 60);
      const command = controller.updateCommand(actor, 1 / 60);
      if (frame === 0) movedOnFirstFrame = command.moveZ > 0;
      // Conservative upper bound: assumes the actor instantly reaches walk
      // speed, while real acceleration covers less distance.
      distance += command.moveZ * MOVE.walkSpeed / 60;
    }
    expect(movedOnFirstFrame).toBe(true);
    expect(distance).toBeGreaterThan(0.05);
    expect(distance).toBeLessThan(1.6);
    controller.dispose();
  });

  it('applies gamepad edge actions and right-stick look in the same tick', () => {
    const buttons = Array.from({ length: 20 }, () => ({ pressed: false, value: 0 }));
    buttons[2] = { pressed: true, value: 1 }; // X / reload
    const pad = { connected: true, axes: [0, 0, 0.75, -0.5], buttons } as unknown as Gamepad;
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    const noop = () => undefined;
    const callbacks: GamepadCallbacks = {
      onJumpPress: noop, onReloadPress: noop, onInteractPress: noop,
      onDashPress: noop, onGrapplePress: noop, onPoundPress: noop,
      onMedkitPress: noop, onShieldPress: noop, onDropWeaponPress: noop,
      onCameraToggle: noop, onMapToggle: noop, onPauseRequest: noop,
      onSlotRequest: noop, onMeleePress: noop, onPingPress: noop,
    };
    const controller = makeController();
    controller.gamepad = new GamepadInput(callbacks);

    const first = controller.updateCommand(actor, 1 / 60);
    expect(first.reloadPressed).toBe(true);
    expect(first.yaw).not.toBe(0);
    expect(first.pitch).not.toBe(0);

    const second = controller.updateCommand(actor, 1 / 60);
    expect(second.reloadPressed).toBe(false);
    controller.dispose();
  });
});
