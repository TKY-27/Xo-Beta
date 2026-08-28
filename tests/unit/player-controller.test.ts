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

function mouseEvent(type: 'mousedown' | 'mouseup', button: number): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'button', { value: button });
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

  it('toggles the Tab inventory even while gameplay input is disabled', () => {
    const canvas = { requestPointerLock: () => undefined } as unknown as HTMLCanvasElement;
    const onInventory = vi.fn();
    const controller = new PlayerController(
      canvas,
      new EventBus(),
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      onInventory,
    );
    controller.enabled = false;
    const tab = keyEvent('keydown', 'Tab');
    window.dispatchEvent(tab);
    expect(onInventory).toHaveBeenCalledTimes(1);
    expect(tab.defaultPrevented).toBe(true);
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

  it('retains a mouse click edge until a fixed sample consumes it', () => {
    const controller = makeController();
    // QA mode intentionally allows input without pointer lock, matching the
    // browser harness. The mousedown/up pair is completed before sampling.
    window.dispatchEvent(mouseEvent('mousedown', 0));
    window.dispatchEvent(mouseEvent('mouseup', 0));

    const first = controller.updateCommand(actor, 1 / 60);
    expect(first.firePressed).toBe(true);
    expect(first.fireHeld).toBe(false);
    expect(controller.updateCommand(actor, 1 / 60).firePressed).toBe(false);
    controller.dispose();
  });

  it('clears held and edge-triggered gameplay input when an overlay disables controls', () => {
    const controller = makeController();
    window.dispatchEvent(keyEvent('keydown', 'KeyW'));
    window.dispatchEvent(keyEvent('keydown', 'KeyR'));
    window.dispatchEvent(mouseEvent('mousedown', 0));
    controller.enabled = false;

    // Key presses that occur while an overlay owns focus must not become a
    // latent movement/action after gameplay is re-enabled either.
    window.dispatchEvent(keyEvent('keydown', 'KeyW'));
    controller.enabled = true;
    const command = controller.updateCommand(actor, 1 / 60);
    expect(command.moveZ).toBe(0);
    expect(command.reloadPressed).toBe(false);
    expect(command.firePressed).toBe(false);
    expect(command.fireHeld).toBe(false);
    controller.dispose();
  });

  it('keeps Escape reachable while gameplay input is disabled', () => {
    let pauses = 0;
    const canvas = { requestPointerLock: () => undefined } as unknown as HTMLCanvasElement;
    const controller = new PlayerController(
      canvas,
      new EventBus(),
      () => undefined,
      () => { pauses++; },
      () => undefined,
      () => undefined,
      () => undefined,
    );
    controller.enabled = false;
    window.dispatchEvent(keyEvent('keydown', 'Escape'));
    expect(pauses).toBe(1);
    controller.dispose();
  });

  it('routes QA arrow keys to spectator cycling instead of camera nudging', () => {
    const previous = vi.fn();
    const next = vi.fn();
    const canvas = { requestPointerLock: () => undefined } as unknown as HTMLCanvasElement;
    const controller = new PlayerController(
      canvas,
      new EventBus(),
      () => undefined,
      () => undefined,
      previous,
      next,
      () => undefined,
    );
    controller.enabled = true;
    controller.setSpectatorMode(true);
    window.dispatchEvent(keyEvent('keydown', 'ArrowLeft'));
    window.dispatchEvent(keyEvent('keydown', 'ArrowRight'));
    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('turns an RT threshold crossing into one fire edge while held remains continuous', () => {
    const buttons = Array.from({ length: 20 }, () => ({ pressed: false, value: 0 }));
    const pad = { connected: true, axes: [0, 0, 0, 0], buttons } as unknown as Gamepad;
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

    buttons[7] = { pressed: false, value: 0.8 };
    const first = controller.updateCommand(actor, 1 / 60);
    expect(first.fireHeld).toBe(true);
    expect(first.firePressed).toBe(true);

    const second = controller.updateCommand(actor, 1 / 60);
    expect(second.fireHeld).toBe(true);
    expect(second.firePressed).toBe(false);

    buttons[7] = { pressed: false, value: 0.1 };
    controller.updateCommand(actor, 1 / 60);
    buttons[7] = { pressed: false, value: 0.8 };
    const third = controller.updateCommand(actor, 1 / 60);
    expect(third.firePressed).toBe(true);
    controller.dispose();
  });
});
