/**
 * Rapier WASM bootstrap shared by browser and headless (Node) entry points.
 */

import RAPIER from '@dimforge/rapier3d-compat';

let ready: Promise<void> | null = null;

export function RAPIER_READY(): Promise<void> {
  if (!ready) ready = RAPIER.init();
  return ready;
}

export { RAPIER };
