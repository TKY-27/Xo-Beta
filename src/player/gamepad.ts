/**
 * Gamepad support: polls the Gamepad API and merges controller input into
 * the player's InputCommand (movement axes, look, fire/ADS, jump/dash/
 * interact/reload/slots). Look sensitivity + deadzone configurable.
 */

import type { InputCommand } from '../sim/input';
import { getSettings } from '../core/settings';

export interface GamepadCallbacks {
  onJumpPress(): void;
  onReloadPress(): void;
  onInteractPress(): void;
  onDashPress(): void;
  onGrapplePress(): void;
  onPoundPress(): void;
  onMedkitPress(): void;
  onShieldPress(): void;
  onDropWeaponPress(): void;
  onCameraToggle(): void;
  onMapToggle(): void;
  onPauseRequest(): void;
  onSlotRequest(slot: number): void;
  onMeleePress(): void;
  onPingPress(): void;
  onCrouchPress?(): void;
}

const BUTTON = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
  L3: 10, R3: 11,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15,
} as const;

function deadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  const sign = Math.sign(v);
  return sign! * ((a - dz) / (1 - dz));
}

export class GamepadInput {
  private prevButtons = new Array<boolean>(20).fill(false);
  private prevFireDown = false;
  private lookX = 0;
  private lookY = 0;
  connected = false;

  constructor(private cb: GamepadCallbacks) {}

  private pad(): Gamepad | null {
    if (!getSettings().gamepadEnabled || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p && p.connected) return p;
    }
    return null;
  }

  /** Consume look deltas; call once per rendered frame. */
  consumeLook(): { dx: number; dy: number } {
    const out = { dx: this.lookX, dy: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  private pressed(pad: Gamepad, idx: number): boolean {
    return !!pad.buttons[idx]?.pressed;
  }

  private edge(pad: Gamepad, idx: number): boolean {
    const now = this.pressed(pad, idx);
    const was = this.prevButtons[idx]!;
    this.prevButtons[idx] = now;
    return now && !was;
  }

  /**
   * Merge gamepad state into an existing command. Returns rumble intensity
   * requested this frame (0..1).
   */
  applyTo(cmd: InputCommand, dt: number, adsScale: number): number {
    const pad = this.pad();
    this.connected = !!pad;
    if (!pad) {
      // Treat a disconnected controller as released so reconnecting while RT
      // is already down still produces one well-defined rising edge.
      this.prevFireDown = false;
      return 0;
    }

    const s = getSettings();
    const dz = s.padDeadzone;
    const rumble = 0;

    // Right stick is sampled in the same tick as the command so aiming has no
    // extra frame of latency. PlayerController consumes these normalized
    // deltas after applyTo returns and applies sensitivity/invert-Y.
    this.lookX = deadzone(pad.axes[2] ?? 0, dz);
    this.lookY = deadzone(pad.axes[3] ?? 0, dz);

    // Movement (merge: keyboard wins on conflict)
    const mx = deadzone(pad.axes[0] ?? 0, dz);
    const mz = -deadzone(pad.axes[1] ?? 0, dz);
    if (Math.abs(mx) > 0.01) cmd.moveX = mx;
    if (Math.abs(mz) > 0.01) cmd.moveZ = mz;
    const l3 = (pad.buttons[BUTTON.L3]?.value ?? 0) > 0.5;
    if (l3) cmd.sprint = true;

    // Triggers
    const rt = pad.buttons[BUTTON.RT]?.value ?? 0;
    const lt = pad.buttons[BUTTON.LT]?.value ?? 0;
    const fireDown = rt > 0.35;
    if (fireDown) cmd.fireHeld = true;
    // RT is an analog trigger; GamepadButton.pressed is not reliable across
    // browsers for partially pressed triggers. Keep a thresholded edge so a
    // short press is delivered to semi-auto/bolt/pump weapons once.
    if (fireDown && !this.prevFireDown) cmd.firePressed = true;
    this.prevFireDown = fireDown;
    if (lt > 0.35) cmd.adsHeld = true;
    void adsScale;

    // Face buttons
    cmd.jumpHeld ||= this.pressed(pad, BUTTON.A);
    if (this.edge(pad, BUTTON.A)) { cmd.jumpPressed = true; this.cb.onJumpPress(); }
    cmd.crouchHeld ||= this.pressed(pad, BUTTON.B);
    if (this.edge(pad, BUTTON.B)) { cmd.crouchPressed = true; this.cb.onCrouchPress?.(); }
    if (this.edge(pad, BUTTON.X)) { cmd.reloadPressed = true; this.cb.onReloadPress(); }
    if (this.edge(pad, BUTTON.Y)) { cmd.interactPressed = true; this.cb.onInteractPress(); }

    // Bumpers: alone = heal items, both together = switch to fists.
    const lbDown = !!pad.buttons[BUTTON.LB]?.pressed;
    const rbDown = !!pad.buttons[BUTTON.RB]?.pressed;
    if (this.edge(pad, BUTTON.LB)) {
      if (rbDown) { cmd.meleePressed = true; this.cb.onMeleePress(); }
      else { cmd.medkitPressed = true; this.cb.onMedkitPress(); }
    }
    if (this.edge(pad, BUTTON.RB)) {
      if (lbDown) { cmd.meleePressed = true; this.cb.onMeleePress(); }
      else { cmd.shieldPressed = true; this.cb.onShieldPress(); }
    }

    // D-pad
    if (this.edge(pad, BUTTON.DPAD_UP)) { cmd.grapplePressed = true; this.cb.onGrapplePress(); }
    if (this.edge(pad, BUTTON.DPAD_DOWN)) { cmd.poundPressed = true; this.cb.onPoundPress(); }
    if (this.edge(pad, BUTTON.DPAD_LEFT)) { cmd.dropWeaponPressed = true; this.cb.onDropWeaponPress(); }
    if (this.edge(pad, BUTTON.DPAD_RIGHT)) { cmd.dashPressed = true; this.cb.onDashPress(); }

    // System
    if (this.edge(pad, BUTTON.START)) this.cb.onPauseRequest();
    if (this.edge(pad, BUTTON.BACK)) this.cb.onMapToggle();
    if (this.edge(pad, BUTTON.R3)) this.cb.onCameraToggle();
    if (this.edge(pad, BUTTON.L3)) this.cb.onPingPress();

    return rumble;
  }

  /** Optional haptic feedback through the browser API. */
  vibrate(strength: number, ms: number): void {
    const s = getSettings();
    if (!s.vibration) return;
    const pad = this.pad() as (Gamepad & { vibrationActuator?: { playEffect(t: string, o: object): Promise<unknown> } }) | null;
    if (!pad?.vibrationActuator) return;
    try {
      void pad.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: ms,
        weakMagnitude: strength * 0.7,
        strongMagnitude: strength,
      });
    } catch { /* unsupported */ }
  }
}
