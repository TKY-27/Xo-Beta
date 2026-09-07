/**
 * CYCLE 35 — first-person hands/arms rig.
 *
 * Two gloved hands parented INSIDE each weapon model group at its grip
 * anchors (see ProceduralWeapon.gripR/gripL), so every weapon motion — sway,
 * ADS, recoil kick, reload — carries the hands for free. The rig is built to
 * human scale and counter-scaled against the weapon's presentation scale.
 *
 * Choreography (driven by ViewModel.update via `pose()`):
 * - right hand: planted on the pistol grip (trigger finger indexed),
 * - left hand: planted on the support anchor; during a reload it pulls the
 *   magazine, carries the fresh one in, rocks it home and returns to the
 *   support anchor; during pump/bolt cycles it rides the pump/bolt.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface HandRig {
  /** Right (trigger) hand group — parent into the weapon, at gripR. */
  right: THREE.Group;
  /** Left (support) hand group — parent into the weapon, at gripL. */
  left: THREE.Group;
  /** Point the rig's pose solver at the current weapon anchors. */
  configure(anchors: { gripR: THREE.Vector3; gripL: THREE.Vector3; scale: number }): void;
  /**
   * Per-frame hand pose.
   * @param reloadPhase 0..1 through the reload, or -1 when not reloading.
   * @param magLocal    magazine position in weapon-local space (null if none).
   * @param pumpOffset  weapon-local +z offset of the pump/bolt under cycle.
   * @param pumpHand    true when the LEFT hand operates the pump (shotgun).
   */
  pose(opts: {
    reloadPhase: number;
    magVisible: boolean;
    magLocal: THREE.Vector3 | null;
    pumpOffset: number;
    pumpHand: boolean;
    ads: number;
  }): void;
}

/** Material set shared by both hands. */
interface HandMats {
  glove: THREE.MeshStandardMaterial;
  shell: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
}

function makeHandMats(): HandMats {
  return {
    // Tactical glove: dark fabric with a harder armour shell.
    glove: new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.88, metalness: 0.04 }),
    shell: new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.6, metalness: 0.25 }),
    // Finger tips cut open → skin contact on the trigger/foregrip.
    skin: new THREE.MeshStandardMaterial({ color: 0xb98a68, roughness: 0.72, metalness: 0 }),
    plate: new THREE.MeshStandardMaterial({ color: 0x181b1f, roughness: 0.5, metalness: 0.35 }),
  };
}

/** One gloved hand: palm + wrapped fingers + thumb + armour plate + cuff.
 * Built reaching forward and curling around a ~32 mm grip; the caller
 * mirrors/rotates it onto the anchor. */
function buildHand(mats: HandMats, mirror: boolean): THREE.Group {
  const hand = new THREE.Group();
  const sx = mirror ? -1 : 1;

  // Palm: back of the hand faces up/outward.
  const palm = new THREE.Mesh(new RoundedBoxGeometry(0.034, 0.082, 0.05, 2, 0.011), mats.glove);
  palm.position.set(0, 0.004, 0.012);
  hand.add(palm);

  // Armour knuckle plate across the back of the hand.
  const plate = new THREE.Mesh(new RoundedBoxGeometry(0.038, 0.034, 0.014, 2, 0.004), mats.plate);
  plate.position.set(sx * 0.004, 0.014, 0.028);
  plate.rotation.x = -0.28;
  hand.add(plate);

  // Four fingers wrap around the grip: two segments each, curled ~85°.
  for (let i = 0; i < 4; i++) {
    const finger = new THREE.Group();
    finger.position.set(0, 0.026 - i * 0.019, 0.0);
    const seg1 = new THREE.Mesh(new THREE.CapsuleGeometry(0.0082, 0.03, 3, 8), mats.glove);
    seg1.rotation.x = Math.PI / 2;
    seg1.position.set(0, 0, -0.016);
    finger.add(seg1);
    const seg2 = new THREE.Mesh(new THREE.CapsuleGeometry(0.0076, 0.024, 3, 8), mats.glove);
    seg2.rotation.x = Math.PI / 2;
    seg2.position.set(0, -0.012, -0.036);
    seg2.rotation.x = Math.PI / 2 + 0.95;
    finger.add(seg2);
    // Exposed fingertip on index + middle (grip feel).
    if (i === 0 || i === 1) {
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0062, 8, 8), mats.skin);
      tip.position.set(0, -0.018, -0.046);
      finger.add(tip);
    }
    hand.add(finger);
  }

  // Thumb closes over the near side (wrap side depends on mirror).
  const thumb = new THREE.Group();
  thumb.position.set(sx * 0.02, 0.018, 0.014);
  const thumbSeg = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.032, 3, 8), mats.glove);
  thumbSeg.rotation.set(0.5, 0, sx * 0.9);
  thumbSeg.position.set(sx * 0.004, -0.006, -0.014);
  thumb.add(thumbSeg);
  hand.add(thumb);

  // Wrist cuff with a strap.
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.035, 0.03, 10), mats.shell);
  cuff.rotation.x = Math.PI / 2 + 0.35;
  cuff.position.set(0, 0.012, 0.062);
  hand.add(cuff);
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.004, 6, 14), mats.plate);
  strap.rotation.set(Math.PI / 2 + 0.35, 0, 0);
  strap.position.set(0, 0.012, 0.05);
  hand.add(strap);

  return hand;
}

/** Forearm sleeve running from the hand back toward the shoulder (off-screen).
 * `yaw` fans the right arm outward, the left arm inward. */
function buildForearm(mats: HandMats, dir: THREE.Vector3): THREE.Group {
  const arm = new THREE.Group();
  const len = 0.24;
  const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.031, len, 4, 10), mats.shell);
  sleeve.position.copy(dir).multiplyScalar(len / 2 + 0.03);
  sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  arm.add(sleeve);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.032, 10), mats.plate);
  cuff.position.copy(dir).multiplyScalar(0.028);
  cuff.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  arm.add(cuff);
  return arm;
}

export function createHandRig(): HandRig {
  const mats = makeHandMats();
  const right = buildHand(mats, false);
  const left = buildHand(mats, true);
  // Left hand approaches from the other side: mirror the wrap direction.
  left.rotation.y = Math.PI;

  // Right arm exits bottom-right; left arm crosses to bottom-left-centre.
  const forearmR = buildForearm(mats, new THREE.Vector3(0.55, -0.72, 0.55));
  const forearmL = buildForearm(mats, new THREE.Vector3(-0.42, -0.78, 0.62));
  right.add(forearmR);
  left.add(forearmL);

  // Anchors + scale for the pose solver.
  let gripR = new THREE.Vector3();
  let gripL = new THREE.Vector3();
  let scale = 1;

  return {
    right,
    left,
    configure(anchors) {
      gripR.copy(anchors.gripR);
      gripL.copy(anchors.gripL);
      scale = anchors.scale;
      right.position.copy(gripR);
      right.scale.setScalar(1.3 / scale);
      left.position.copy(gripL);
      left.scale.setScalar(1.3 / scale);
    },
    pose({ reloadPhase, magLocal, pumpOffset, pumpHand, ads }) {
      // Right hand: planted on the grip — palm behind, fingers wrapped
      // around; a firmer inward cant while aiming.
      right.position.set(gripR.x + 0.012, gripR.y, gripR.z + 0.018);
      right.rotation.set(-0.55 + ads * 0.1, -0.25, 0.12);

      // Left hand: support anchor → magazine choreography → pump/bolt ride.
      if (pumpHand) {
        // Shotgun: hand rides the pump through its cycle.
        left.position.set(gripL.x, gripL.y, gripL.z + pumpOffset);
        left.rotation.set(-0.15, 0, 0);
        return;
      }
      if (reloadPhase >= 0 && magLocal) {
        // Timeline: reach to the mag (0-0.3), pull down with it (0.3-0.5),
        // carry back up (0.5-0.7), seat + slap (0.7-1).
        const p = reloadPhase;
        const target = new THREE.Vector3();
        if (p < 0.3) {
          target.lerpVectors(gripL, magLocal, smooth(p / 0.3));
        } else if (p < 0.5) {
          target.copy(magLocal);
          target.y -= 0.09 * smooth((p - 0.3) / 0.2);
        } else if (p < 0.7) {
          target.copy(magLocal);
          target.y -= 0.09 * (1 - smooth((p - 0.5) / 0.2));
        } else {
          target.lerpVectors(magLocal, gripL, smooth((p - 0.7) / 0.3));
        }
        left.position.copy(target);
        left.rotation.set(-0.35, 0, -0.2);
        return;
      }
      // Default support pose: palm cups the underside, fingers curling up
      // around the far side of the handguard/foregrip.
      left.position.set(gripL.x, gripL.y - 0.028, gripL.z);
      left.rotation.set(-1.35, 0, 0.2);
    },
  };
}

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}
