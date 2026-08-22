/**
 * InputCommand: the complete per-tick intent produced by ANY controller
 * (human player or bot). Simulation only ever consumes this structure,
 * which keeps the door open for future network controllers.
 */

export interface InputCommand {
  /** Local-space move axes: x = right(+)/left(-), z = forward(+)/back(-). */
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
  sprint: boolean;
  crouchHeld: boolean;
  crouchPressed: boolean;
  fireHeld: boolean;
  firePressed: boolean;
  adsHeld: boolean;
  reloadPressed: boolean;
  interactPressed: boolean;
  slotRequest: number | null;
  dropWeaponPressed: boolean;
  dashPressed: boolean;
  grapplePressed: boolean;
  grappleRelease: boolean;
  poundPressed: boolean;
  shieldPressed: boolean;
  medkitPressed: boolean;
}

export function emptyCommand(): InputCommand {
  return {
    moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
    jumpPressed: false, jumpHeld: false,
    sprint: false, crouchHeld: false, crouchPressed: false,
    fireHeld: false, firePressed: false, adsHeld: false,
    reloadPressed: false, interactPressed: false,
    slotRequest: null, dropWeaponPressed: false,
    dashPressed: false, grapplePressed: false, grappleRelease: false,
    poundPressed: false, shieldPressed: false, medkitPressed: false,
  };
}
