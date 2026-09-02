/**
 * PlayerController: keyboard/mouse input → InputCommand. Handles pointer
 * lock, sensitivity, invert-Y, remappable bindings, and edge-triggered
 * presses consumed by the fixed-step simulation.
 */

import { emptyCommand, type InputCommand } from '../sim/input';
import type { ActorController } from '../sim/match';
import type { Actor } from '../sim/actor';
import { getSettings } from '../core/settings';
import type { GamepadInput } from './gamepad';
import type { EventBus } from '../core/events';

interface MatchEventsForInput {
  requestPointerLock: Record<string, never>;
}

// CUA emits a complete key press faster than a fixed simulation tick can
// reliably sample. Keep QA-only taps alive briefly—long enough for immediate
// recognition, short enough to remain a single deliberate step.
export const QA_TAP_HOLD_MS = 180;
export const QA_STUCK_KEY_TIMEOUT_MS = 5000;
export const QA_STUCK_MODIFIER_TIMEOUT_MS = 750;

export class PlayerController implements ActorController {
  private readonly listenerAbort = new AbortController();
  private offRequestPointerLock: () => void = () => undefined;
  private keys = new Set<string>();
  private mouseButtons = new Set<number>();
  private readonly qaUnlockedInput = import.meta.env.DEV
    && new URLSearchParams(location.search).has('qa');
  private readonly qaKeyDeadlines = new Map<string, number>();
  private readonly qaKeyDownAt = new Map<string, number>();
  private lookDx = 0;
  private lookDy = 0;
  yaw = 0;
  pitch = 0;
  private inputEnabled = false;
  get enabled(): boolean { return this.inputEnabled; }
  set enabled(value: boolean) {
    if (!value) this.clearGameplayInput();
    this.inputEnabled = value;
  }
  locked = false;
  private spectatorMode = false;
  /**
   * Current sniper scope magnification, mirrored from the renderer by the
   * game shell so scoped mouse deltas scale with the angular FOV.
   */
  scopedZoom = 1;
  /** Optional controller input merged into every command. */
  gamepad: GamepadInput | null = null;

  /** Edge-triggered actions accumulated since last update. */
  private pendingJump = false;
  private pendingFirePress = false;
  private pendingReload = false;
  private pendingInteract = false;
  private pendingDash = false;
  private pendingGrapple = false;
  private pendingGrappleRelease = false;
  private pendingPound = false;
  private pendingMedkit = false;
  private pendingShield = false;
  private pendingDropWeapon = false;
  private pendingMelee = false;
  private slotRequest: number | null = null;
  private lastCrouchDown = false;
  private crouchLatched = false;

  /** Smoothed mouse velocity for weapon sway. */
  lookVelX = 0;
  lookVelY = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    bus: EventBus<MatchEventsForInput>,
    onCameraToggle: () => void,
    onPauseRequest: () => void,
    onSpectatePrev: () => void,
    onSpectateNext: () => void,
    onMapToggle: () => void,
    onShoulderSwap: () => void = () => undefined,
    onInventoryToggle: () => void = () => undefined,
  ) {
    window.addEventListener('keydown', (e) => {
      const code = e.code;
      if (e.repeat) {
        if (this.qaUnlockedInput && !this.locked) {
          const timeout = /^(Shift|Control|Alt|Meta)/.test(code)
            ? QA_STUCK_MODIFIER_TIMEOUT_MS
            : QA_STUCK_KEY_TIMEOUT_MS;
          this.qaKeyDeadlines.set(code, performance.now() + timeout);
        }
        return;
      }
      if (this.qaUnlockedInput && !this.locked && this.enabled && !this.spectatorMode) {
        // Pointer lock is intentionally unavailable in the headed Codex
        // browser. Arrow-key taps provide deterministic camera turns there;
        // ordinary mouse look remains unchanged and is still exercised.
        if (code === 'ArrowLeft' || code === 'ArrowRight') {
          this.yaw += code === 'ArrowLeft' ? Math.PI / 8 : -Math.PI / 8;
          this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
          e.preventDefault();
          return;
        }
        if (code === 'ArrowUp' || code === 'ArrowDown') {
          this.pitch = Math.max(
            -Math.PI / 2 + 0.02,
            Math.min(Math.PI / 2 - 0.02, this.pitch + (code === 'ArrowUp' ? Math.PI / 16 : -Math.PI / 16)),
          );
          e.preventDefault();
          return;
        }
      }
      if (this.qaUnlockedInput && !this.locked) {
        // Keep genuine holds responsive until keyup. A separate long fallback
        // clears the occasional CUA key that never emits keyup; modifiers use
        // a shorter ceiling because a stuck sprint/crouch is more disruptive.
        const now = performance.now();
        const timeout = /^(Shift|Control|Alt|Meta)/.test(code)
          ? QA_STUCK_MODIFIER_TIMEOUT_MS
          : QA_STUCK_KEY_TIMEOUT_MS;
        this.qaKeyDownAt.set(code, now);
        this.qaKeyDeadlines.set(code, now + timeout);
      }
      const b = getSettings().bindings;
      // Escape must remain available while gameplay input is disabled (pause
      // menu and spectator transition). All other gameplay actions stay
      // behind the enabled guard.
      if (code === 'Escape') {
        onPauseRequest();
        return;
      }
      // Inventory owns pointer focus and disables gameplay input while open,
      // so Tab must be handled before the enabled guard in both directions.
      if (code === 'Tab') {
        onInventoryToggle();
        e.preventDefault();
        return;
      }
      if (!this.enabled) {
        this.qaKeyDeadlines.delete(code);
        this.qaKeyDownAt.delete(code);
        return;
      }
      this.keys.add(code);
      if (code === b.jump) this.pendingJump = true;
      else if (code === b.reload) this.pendingReload = true;
      else if (code === b.interact) this.pendingInteract = true;
      else if (code === b.dash) this.pendingDash = true;
      else if (code === b.grapple) this.pendingGrapple = true;
      else if (code === b.groundPound) this.pendingPound = true;
      else if (code === b.useMedkit) this.pendingMedkit = true;
      else if (code === b.useShield) this.pendingShield = true;
      else if (code === b.dropWeapon) this.pendingDropWeapon = true;
      else if (code === b.melee) this.pendingMelee = true;
      else if (code === b.slot1) this.slotRequest = 0;
      else if (code === b.slot2) this.slotRequest = 1;
      else if (code === b.slot3) this.slotRequest = 2;
      else if (code === b.slot4) this.slotRequest = 3;
      else if (code === b.slot5) this.slotRequest = 4;
      else if (code === b.cameraToggle) onCameraToggle();
      else if (code === (b as typeof b & { shoulderSwap?: string }).shoulderSwap) onShoulderSwap();
      else if (code === b.spectatePrev) onSpectatePrev();
      else if (code === b.spectateNext) onSpectateNext();
      else if (code === b.mapToggle) onMapToggle();
      // Prevent page scroll etc.
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
        e.preventDefault();
      }
    }, { signal: this.listenerAbort.signal });
    window.addEventListener('keyup', (e) => {
      if (this.qaUnlockedInput && !this.locked) {
        const now = performance.now();
        const downAt = this.qaKeyDownAt.get(e.code) ?? now;
        const minimumRelease = downAt + QA_TAP_HOLD_MS;
        if (now < minimumRelease) {
          this.qaKeyDeadlines.set(e.code, minimumRelease);
        } else {
          this.qaKeyDeadlines.delete(e.code);
          this.qaKeyDownAt.delete(e.code);
          this.keys.delete(e.code);
        }
      } else {
        this.keys.delete(e.code);
      }
    }, { signal: this.listenerAbort.signal });
    window.addEventListener('mousedown', (e) => {
      if (!this.enabled || (!this.locked && !this.qaUnlockedInput)) return;
      this.mouseButtons.add(e.button);
      const b = getSettings().bindings;
      if (e.button === 0 && b.fire === 'Mouse0') this.pendingFirePress = true;
      if (e.button === 2 && b.ads === 'Mouse2') { /* ads is held */ }
    }, { signal: this.listenerAbort.signal });
    window.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
      // Do not clear the edge here. A click can begin and end between two
      // fixed simulation ticks; the edge is consumed exactly once by
      // updateCommand instead. Held state is still cleared immediately so
      // automatic weapons stop on mouseup.
    }, { signal: this.listenerAbort.signal });
    window.addEventListener('contextmenu', (e) => e.preventDefault(), { signal: this.listenerAbort.signal });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || (!this.locked && !this.qaUnlockedInput)) return;
      this.lookDx += e.movementX;
      this.lookDy += e.movementY;
      // Smoothed look velocity for viewmodel sway (decays each frame)
      this.lookVelX = this.lookVelX * 0.7 + e.movementX * 0.3;
      this.lookVelY = this.lookVelY * 0.7 + e.movementY * 0.3;
    }, { signal: this.listenerAbort.signal });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.keys.clear();
        this.mouseButtons.clear();
        this.pendingFirePress = false;
      }
    }, { signal: this.listenerAbort.signal });
    this.offRequestPointerLock = bus.on('requestPointerLock', () => this.requestLock());
  }

  requestLock(): void {
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    } catch {
      /* headless / unsupported contexts */
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  dispose(): void {
    this.enabled = false;
    this.releaseLock();
    this.listenerAbort.abort();
    this.offRequestPointerLock();
    this.keys.clear();
    this.mouseButtons.clear();
    this.qaKeyDeadlines.clear();
    this.qaKeyDownAt.clear();
  }

  private clearGameplayInput(): void {
    this.keys.clear();
    this.mouseButtons.clear();
    this.qaKeyDeadlines.clear();
    this.qaKeyDownAt.clear();
    this.lookDx = 0;
    this.lookDy = 0;
    this.lookVelX = 0;
    this.lookVelY = 0;
    this.pendingJump = false;
    this.pendingFirePress = false;
    this.pendingReload = false;
    this.pendingInteract = false;
    this.pendingDash = false;
    this.pendingGrapple = false;
    this.pendingGrappleRelease = false;
    this.pendingPound = false;
    this.pendingMedkit = false;
    this.pendingShield = false;
    this.pendingDropWeapon = false;
    this.pendingMelee = false;
    this.slotRequest = null;
    this.lastCrouchDown = false;
    this.crouchLatched = false;
  }

  resetLook(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
  }

  /** Queue an owner-permitted inventory selection for the next sampled tick. */
  requestInventorySlot(slot: number): boolean {
    if (!this.inputEnabled || !Number.isSafeInteger(slot) || slot < 0 || slot > 4) return false;
    this.slotRequest = slot;
    return true;
  }

  /** Queue a drop request; the authoritative host still validates ownership. */
  requestDropSelected(): boolean {
    if (!this.inputEnabled) return false;
    this.pendingDropWeapon = true;
    return true;
  }

  setSpectatorMode(active: boolean): void {
    this.spectatorMode = active;
    this.clearGameplayInput();
  }

  updateCommand(actor: Actor, dt: number): InputCommand {
    return this.sampleCommand(actor.wpn.adsAmount, dt);
  }

  /**
   * Sample local controls without requiring a mutable simulation Actor.
   * Online guests pass the owner-scoped authoritative ADS amount from their
   * read-only replica; only the host ever supplies this command to Match.
   */
  sampleCommand(adsAmount: number, dt: number): InputCommand {
    const cmd = emptyCommand();
    if (!this.enabled) {
      this.clearGameplayInput();
      return cmd;
    }
    if (this.qaUnlockedInput && !this.locked) {
      const now = performance.now();
      for (const [code, deadline] of this.qaKeyDeadlines) {
        if (now < deadline) continue;
        this.qaKeyDeadlines.delete(code);
        this.qaKeyDownAt.delete(code);
        this.keys.delete(code);
      }
    }
    const s = getSettings();
    const b = s.bindings;

    // Movement axes
    let x = 0;
    let z = 0;
    if (this.keys.has(b.forward)) z += 1;
    if (this.keys.has(b.back)) z -= 1;
    if (this.keys.has(b.left)) x -= 1;
    if (this.keys.has(b.right)) x += 1;
    cmd.moveX = x;
    cmd.moveZ = z;
    cmd.sprint = this.keys.has(b.sprint);

    const crouchDown = this.keys.has(b.crouch);
    const crouchPressed = crouchDown && !this.lastCrouchDown;
    if (crouchPressed) this.crouchLatched = !this.crouchLatched;
    this.lastCrouchDown = crouchDown;
    cmd.crouchPressed = crouchPressed;
    cmd.crouchHeld = this.crouchLatched;

    cmd.jumpPressed = this.pendingJump;
    cmd.jumpHeld = this.keys.has(b.jump);
    this.pendingJump = false;

    const firing = this.mouseButtons.has(0);
    cmd.fireHeld = firing;
    cmd.firePressed = this.pendingFirePress;
    this.pendingFirePress = false;

    cmd.adsHeld = this.mouseButtons.has(2);
    cmd.reloadPressed = this.pendingReload;
    this.pendingReload = false;
    cmd.interactPressed = this.pendingInteract;
    this.pendingInteract = false;
    cmd.dashPressed = this.pendingDash;
    this.pendingDash = false;
    cmd.grapplePressed = this.pendingGrapple;
    this.pendingGrapple = false;
    cmd.grappleRelease = this.pendingGrappleRelease; // unused by default binding
    cmd.poundPressed = this.pendingPound;
    this.pendingPound = false;
    cmd.medkitPressed = this.pendingMedkit;
    this.pendingMedkit = false;
    cmd.shieldPressed = this.pendingShield;
    this.pendingShield = false;
    cmd.dropWeaponPressed = this.pendingDropWeapon;
    this.pendingDropWeapon = false;
    cmd.meleePressed = this.pendingMelee;
    this.pendingMelee = false;
    cmd.slotRequest = this.slotRequest;
    this.slotRequest = null;

    const safeAdsAmount = Number.isFinite(adsAmount)
      ? Math.max(0, Math.min(1, adsAmount))
      : 0;
    if (this.gamepad) {
      this.gamepad.applyTo(cmd, dt, safeAdsAmount);
      if (this.gamepad.consumeCrouchToggle()) {
        this.crouchLatched = !this.crouchLatched;
        cmd.crouchPressed = true;
      }
      cmd.crouchHeld = this.crouchLatched;
    }

    // Look — gamepad is polled above, then consumed in the same simulation
    // tick so right-stick aiming cannot lag one frame behind movement.
    let lookDx = this.lookDx;
    let lookDy = this.lookDy;
    if (this.gamepad) {
      const padLook = this.gamepad.consumeLook();
      const padScale = s.padLookSens * 11.5 * dt * 60 * 0.016 * (safeAdsAmount > 0.5 ? 0.55 : 1);
      lookDx += padLook.dx * padScale / Math.max(0.0001, s.sensitivity * 0.0023);
      lookDy += padLook.dy * padScale / Math.max(0.0001, s.sensitivity * 0.0023);
    }
    let sens = s.sensitivity * 0.0023 * (safeAdsAmount > 0.5 ? s.adsSensitivity : 1);
    // Angular scaling while scoped: turning rate shrinks with the scope's
    // tangent ratio, so 4x feels controllable and 1x feels unchanged.
    if (this.scopedZoom > 1 && safeAdsAmount > 0.5) sens /= this.scopedZoom;
    this.yaw -= lookDx * sens;
    this.pitch -= lookDy * sens * (s.invertY ? -1 : 1);
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.lookDx = 0;
    this.lookDy = 0;

    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    return cmd;
  }
}
