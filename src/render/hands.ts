/**
 * CYCLE 38 — first-person hands/arms rig (v4, AAA readability pass).
 *
 * Two gloved hands parented INSIDE each weapon model group at its grip
 * anchors (see ProceduralWeapon.gripR/gripL), so every weapon motion — sway,
 * ADS, recoil kick, reload — carries the hands for free. The rig is built to
 * human scale and counter-scaled against the weapon's presentation scale.
 *
 * v4 changes (Apex-class hip-framing pass):
 * - fingers now spread along the hand's WIDTH axis (v3 stacked them down
 *   the palm normal, reading as dangling finger chains), two segments each
 *   with a gentle per-finger wrap curl + rotation variance — silhouette
 *   unified, separations visible, no comb;
 * - chirality fixed: buildHand(thumbSide) builds real right/left hands (v3's
 *   "right" build was anatomically mirrored, forcing Euler pose hacks);
 * - poses authored as palm/fingers DIRECTIONS through handBasisQuat() —
 *   no more hand-solved Euler triples — with contact offsets per class;
 * - materials: fabric glove + lighter hard-shell panels + dark rubber palm
 *   pads + glossy knuckle armour + warm leather finger pads (one family,
 *   shared with ArmSolver sleeves via `shell`);
 * - sleeves tapered thinner with a stronger elbow drop so arms leave the
 *   bottom corners with a visible bend, never straight pipes.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export type SupportStyle = 'under' | 'side' | 'pump' | 'over';

export interface HandPoseInput {
  /** 0..1 through the reload, or -1 when not reloading. */
  reloadPhase: number;
  /** How the support hand holds this weapon class. */
  supportStyle: SupportStyle;
  /** Magazine position in weapon-local space (null if none). */
  magLocal: THREE.Vector3 | null;
  /** Weapon-local +z offset of the pump/bolt under cycle. */
  pumpOffset: number;
  /** True when the LEFT hand operates the pump (shotgun). */
  pumpHand: boolean;
  /** 0..1 aim blend — support hand tucks out of the sight line. */
  ads: number;
  /** 0..1 through the bolt cycle (sniper), or -1. Right hand works it. */
  boltPhase: number;
  /** Bolt handle position in weapon-local space (null if none). */
  boltLocal: THREE.Vector3 | null;
}

export interface HandRig {
  /** Right (trigger) hand group — parent into the weapon, at gripR. */
  right: THREE.Group;
  /** Left (support) hand group — parent into the weapon, at gripL. */
  left: THREE.Group;
  configure(anchors: { gripR: THREE.Vector3; gripL: THREE.Vector3; scale: number }): void;
  pose(input: HandPoseInput): void;
}

interface HandMats {
  glove: THREE.MeshStandardMaterial;
  shell: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  /** Dark rubberized palm/fingertip contact pads (grip surfaces read as gear). */
  palm: THREE.MeshStandardMaterial;
}

let fabricBump: THREE.CanvasTexture | null = null;

/** Woven-fabric bump for the gloves (tiny diagonal weave). */
function getFabricBump(): THREE.CanvasTexture | null {
  // Headless/QA environments have no DOM — the bump map is cosmetic.
  if (typeof document === 'undefined') return null;
  if (fabricBump) return fabricBump;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  for (let i = -size; i < size * 2; i += 4) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + size, size);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.moveTo(i + 2, 0);
    ctx.lineTo(i + size + 2, size);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.colorSpace = THREE.NoColorSpace;
  fabricBump = tex;
  return tex;
}


let handMatsSingleton: HandMats | null = null;

/** Shared hand materials — ONE instance used by the hands AND the arm
 * sleeves, so the chain reads as one person (round-2 review: three tones). */
export function getHandMaterialSet(): HandMats {
  if (handMatsSingleton) return handMatsSingleton;
  handMatsSingleton = makeHandMats();
  return handMatsSingleton;
}

function makeHandMats(): HandMats {
  const bump = getFabricBump();
  // One material FAMILY across hands + sleeves (ArmSolver shares `shell`):
  // mid-grey fabric base, lighter hard-shell panels, dark rubber grip pads,
  // near-black glossy knuckle armour that catches speculars, and warm
  // leather finger pads. Panel contrast comes from GEOMETRY (proud shell
  // plates over fabric), not just color swaps.
  const glove = new THREE.MeshStandardMaterial({ color: 0x5a626b, roughness: 0.76, metalness: 0.05 });
  if (bump) {
    glove.normalMap = bump;
    glove.normalScale.set(0.35, 0.35);
  }
  const shell = new THREE.MeshStandardMaterial({ color: 0x646d78, roughness: 0.5, metalness: 0.3 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x8f6b4f, roughness: 0.62, metalness: 0.02 });
  const plate = new THREE.MeshStandardMaterial({ color: 0x394049, roughness: 0.38, metalness: 0.55 });
  const palm = new THREE.MeshStandardMaterial({ color: 0x474e56, roughness: 0.88, metalness: 0.02 });
  return { glove, shell, skin, plate, palm };
}

/** One gloved hand, built reaching palm-down with fingers curling -y and
 * extending -z. The four fingers spread along the hand's WIDTH axis (x) —
 * v3 stacked them down the palm normal, which read as dangling finger
 * chains. `thumbSide` picks the chirality: -1 = anatomical right hand
 * (thumb on -x), +1 = anatomical left hand. 15 meshes/hand (38 total with
 * the ArmSolver — inside the low-poly budget). */
function buildHand(mats: HandMats, thumbSide: 1 | -1): THREE.Group {
  const hand = new THREE.Group();

  // Palm: widened (real palms are ~as wide as long) with a proud rubber
  // grip pad on the contact face (-y).
  const palm = new THREE.Mesh(new RoundedBoxGeometry(0.052, 0.032, 0.094, 3, 0.012), mats.glove);
  palm.position.set(0, 0, 0.012);
  hand.add(palm);
  const palmPad = new THREE.Mesh(new RoundedBoxGeometry(0.046, 0.011, 0.078, 2, 0.004), mats.palm);
  palmPad.position.set(0, -0.0155, 0.008);
  hand.add(palmPad);

  // Hard-shell back panel + knuckle armour across the back of the hand.
  const backPanel = new THREE.Mesh(new RoundedBoxGeometry(0.046, 0.012, 0.062, 2, 0.005), mats.shell);
  backPanel.position.set(0, 0.017, 0.014);
  hand.add(backPanel);
  const plate = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.014, 0.034, 2, 0.005), mats.plate);
  plate.position.set(0, 0.024, 0.006);
  hand.add(plate);

  // Four fingers side by side along x (spacing slightly under the segment
  // diameter so the silhouette unifies but separations still read), two
  // segments each with a gentle wrap curl that grows toward the pinky, and
  // a deterministic per-finger rotation variance so they never read as a
  // comb. Leather-toned distal segments do the contacting.
  for (let i = 0; i < 4; i++) {
    const wig = Math.sin(i * 12.9898 + 4.1) * 0.5; // -0.5..0.5 pseudo-random
    const finger = new THREE.Group();
    finger.position.set((i - 1.5) * 0.0142 + wig * 0.0012, -0.004 - Math.abs(wig) * 0.0012, -0.032 + (i === 1 ? -0.002 : i === 3 ? 0.004 : 0));
    finger.rotation.y = thumbSide * ((i - 1.5) * 0.045 + wig * 0.05);
    // Proximal segment: fabric glove.
    const seg1 = new THREE.Mesh(new THREE.CapsuleGeometry(0.0098, 0.024, 3, 10), mats.glove);
    seg1.rotation.x = Math.PI / 2;
    seg1.position.set(0, -0.01, -0.012);
    finger.add(seg1);
    // Distal segment: leather pad, curled down-and-under the grip surface.
    const curl = 0.72 + i * 0.09 + wig * 0.1;
    const seg2 = new THREE.Mesh(new THREE.CapsuleGeometry(0.0092, 0.02, 3, 10), mats.skin);
    seg2.rotation.x = Math.PI / 2 - curl;
    seg2.position.set(0, -0.01 - Math.sin(curl) * 0.015, -0.034 - (1 - Math.cos(curl)) * 0.015);
    finger.add(seg2);
    hand.add(finger);
  }

  // Thumb wrapping across the near face: base on the thumb-side edge just
  // under the tang line, angled forward-inward so the tip crosses in front
  // of the fingers (a higher base stabbed the tip past the grip top).
  const thumb = new THREE.Group();
  thumb.position.set(thumbSide * 0.026, -0.004, 0.012);
  thumb.rotation.set(-0.05, thumbSide * 0.55, thumbSide * -0.1);
  const thumbSeg = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.026, 3, 10), mats.glove);
  thumbSeg.rotation.x = Math.PI / 2 - 0.28;
  thumbSeg.position.set(0, -0.008, -0.015);
  thumb.add(thumbSeg);
  const thumbTip = new THREE.Mesh(new THREE.CapsuleGeometry(0.0098, 0.018, 3, 10), mats.skin);
  thumbTip.rotation.x = Math.PI / 2 - 0.75;
  thumbTip.position.set(0, -0.021, -0.029);
  thumb.add(thumbTip);
  hand.add(thumb);

  // Wrist cuff: 16-segment barrel aligned to the wrist joint (+z axis),
  // flaring toward the forearm where the ArmSolver sleeve meets it. Kept
  // narrower than the palm — v4's 5.7 cm cuff read as a second palm.
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.0235, 0.0205, 0.032, 16), mats.shell);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, -0.002, 0.062);
  hand.add(cuff);

  return hand;
}

// Pose-scratch vectors/quats (module-level: pose() runs once per frame).
const _palm = new THREE.Vector3();
const _fingers = new THREE.Vector3();
const _bp = new THREE.Vector3();
const _bf = new THREE.Vector3();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _quatA = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();

/**
 * Build the hand orientation from two anatomical directions: `palm` (the
 * way the open palm faces) and `fingers` (the way the finger chain extends
 * at the knuckles). Replaces v3's hand-solved Euler triples — poses are now
 * authored as "palm here, fingers there", which is how a grip is described.
 * `mirrored` selects the left-hand chirality (thumb = palm×fingers).
 */
function handBasisQuat(
  out: THREE.Quaternion,
  palm: THREE.Vector3,
  fingers: THREE.Vector3,
  mirrored: boolean,
): THREE.Quaternion {
  _bp.copy(palm).normalize();
  _bf.copy(fingers).addScaledVector(_bp, -fingers.dot(_bp)).normalize();
  // Hand-local axes: +x thumb side, +y back of hand, +z opposite the
  // finger-extend direction.
  if (mirrored) _axisX.copy(_bp).cross(_bf);
  else _axisX.copy(_bf).cross(_bp);
  _axisY.copy(_bp).negate();
  _axisZ.copy(_bf).negate();
  _basis.makeBasis(_axisX, _axisY, _axisZ);
  return out.setFromRotationMatrix(_basis);
}

function orientHand(group: THREE.Object3D, palm: THREE.Vector3, fingers: THREE.Vector3, mirrored: boolean): void {
  group.quaternion.copy(handBasisQuat(_quatA, palm, fingers, mirrored));
}

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export function createHandRig(): HandRig {
  const mats = getHandMaterialSet();

  // Left hand: anatomically built (thumbSide +1) inside a WRAPPER group —
  // the pose solver composes orientations around it, so no pose can undo
  // the chirality (the v1 Euler clobber dangled the fingers frame one).
  const leftWrap = new THREE.Group();
  leftWrap.add(buildHand(mats, 1));
  const left = leftWrap;

  const right = buildHand(mats, -1);

  let gripR = new THREE.Vector3();
  let gripL = new THREE.Vector3();

  return {
    right,
    left,
    configure(anchors) {
      gripR.copy(anchors.gripR);
      gripL.copy(anchors.gripL);
      const s = 1 / anchors.scale;
      right.position.copy(gripR);
      right.scale.setScalar(s);
      left.position.copy(gripL);
      left.scale.setScalar(s);
    },
    pose({ reloadPhase, supportStyle, magLocal, pumpOffset, pumpHand, ads, boltPhase, boltLocal }) {
      // ---- Right (trigger) hand ---------------------------------------
      // High power grip: the BACK of the hand (knuckle plate + shell panel)
      // faces up-right-REAR toward the camera so the hand reads at hip
      // framing; the palm presses the grip's front-right corner and the
      // fingers wrap down the front strap. ADS settles it flatter.
      const gripPalm = _palm.set(-0.45, -0.7, -0.42);
      const gripFingers = _fingers.set(0.72, -0.66, -0.2);
      if (ads > 0) {
        gripPalm.z += ads * 0.2;
        gripFingers.x -= ads * 0.1;
      }
      if (boltPhase >= 0 && boltLocal) {
        // Sniper: the firing hand leaves the grip and works the bolt through
        // the cycle, then re-seats. Grip → bolt → ride → return.
        const target = new THREE.Vector3();
        if (boltPhase < 0.3) {
          target.lerpVectors(gripR, boltLocal, smooth(boltPhase / 0.3));
        } else if (boltPhase < 0.7) {
          target.copy(boltLocal);
          const swing = boltPhase < 0.5
            ? smooth((boltPhase - 0.3) / 0.2)
            : smooth((0.7 - boltPhase) / 0.2);
          target.z += 0.05 * swing;
        } else {
          target.lerpVectors(boltLocal, gripR, smooth((boltPhase - 0.7) / 0.3));
        }
        right.position.copy(target);
        orientHand(right, gripPalm, gripFingers, false);
      } else {
        right.position.set(gripR.x + 0.02, gripR.y - 0.003 + ads * 0.004, gripR.z + 0.002);
        orientHand(right, gripPalm, gripFingers, false);
      }

      // ---- Left (support) hand ----------------------------------------
      if (pumpHand || supportStyle === 'pump') {
        // Shotgun: palm cups UNDER the pump body, fingers wrapping up its
        // front face only (a taller curl speared the tips past the pump
        // top); the hand rides the pump travel.
        left.position.set(gripL.x, gripL.y - 0.066, gripL.z - 0.04 + pumpOffset);
        orientHand(left, _palm.set(0, 0.9, -0.44), _fingers.set(0, -0.55, -0.84), true);
        return;
      }
      if (reloadPhase >= 0 && magLocal) {
        // Reach to the mag (0-0.3), pull down with it (0.3-0.5), carry back
        // up and seat (0.5-0.85), slap + re-grip (0.85-1). The palm rides ON
        // the mag body; orientation blends from the support grip to a
        // mag-carry cup and back.
        const p = reloadPhase;
        const target = new THREE.Vector3();
        let blend: number;
        if (p < 0.3) {
          target.lerpVectors(gripL, magLocal, smooth(p / 0.3));
          blend = smooth(p / 0.3);
        } else if (p < 0.85) {
          target.copy(magLocal);
          target.y -= 0.02;
          blend = 1;
        } else {
          target.lerpVectors(magLocal, gripL, smooth((p - 0.85) / 0.15));
          blend = 1 - smooth((p - 0.85) / 0.15);
        }
        left.position.copy(target);
        const tuck = ads * 0.035;
        handBasisQuat(_quatA, _palm.set(0, 0.96 - ads * 0.1, -0.28), _fingers.set(0, -0.28, -0.96), true);
        handBasisQuat(_quatB, _palm.set(0.85, -0.35, 0.2), _fingers.set(0, -0.5, -0.86), true);
        leftWrap.quaternion.slerpQuaternions(_quatA, _quatB, blend);
        left.position.y -= tuck * (1 - blend);
        return;
      }
      // Support poses per class (review: the shared pitch speared
      // fingertips through the solid forends on every long gun).
      const tuck = ads * 0.035;
      if (supportStyle === 'side') {
        // SMG: horizontal wrap around the vertical foregrip — palm faces
        // into the grip from the left, fingers curl around the far side,
        // thumb riding up the near edge.
        left.position.set(gripL.x - 0.028, gripL.y + 0.025 - tuck, gripL.z);
        orientHand(left, _palm.set(0.95, -0.2, 0.2), _fingers.set(0.1, -0.4, -0.9), true);
        return;
      }
      if (supportStyle === 'over') {
        // Pistol: hand-over-hand — the left hand cups the firing hand from
        // below-left-front, fingers wrapping up around it.
        left.position.set(gripL.x - 0.008, gripL.y - 0.025, gripL.z - 0.028);
        orientHand(left, _palm.set(0.45, 0.7, 0.55), _fingers.set(0.1, 0.6, -0.79), true);
        return;
      }
      // 'under' (AR/sniper): palm up under the handguard, fingers running
      // forward and curling up its far side (shallow enough to stay under
      // the rail line — a taller curl stabbed through the forend).
      left.position.set(gripL.x, gripL.y - 0.016 - tuck, gripL.z + 0.008);
      orientHand(left, _palm.set(0, 0.96 - ads * 0.1, -0.28), _fingers.set(0, -0.2, -0.98), true);
    },
  };
}

/**
 * CYCLE 36 (user pass) — connected arm chain.
 *
 * The v2 hands floated: short sleeve stubs parented at the wrist read as
 * detached tubes. Real first-person arms are a continuous chain from an
 * off-screen shoulder through an elbow to the wrist — solved here with
 * analytic two-bone IK against the live hand positions, so the arms follow
 * every grip, reload carry and pump ride the way APEX-class shooters read.
 * Sleeves are tapered unit cylinders stretched between the joints.
 */
export class ArmSolver {
  readonly group = new THREE.Group();
  /** Shoulder anchors in view (pivot) space — off the bottom corners. */
  // CYCLE 37 (review): shoulders near the eye plane and a chain long enough
  // for the worst-case reach (sniper support hand) — v2's left sleeve ended
  // 20-40 cm short of the hand in EVERY long-gun frame by construction.
  private readonly shoulders = [
    new THREE.Vector3(0.27, -0.4, -0.12),
    new THREE.Vector3(-0.27, -0.4, -0.12),
  ];
  private readonly upperLen = 0.42;
  private readonly foreLen = 0.4;
  // Bend hints: strong downward+outward elbow drop — v3's shallow hints
  // projected nearly parallel to the reach and read as straight pipes.
  private readonly bends = [new THREE.Vector3(1.8, -1.05, 0.1), new THREE.Vector3(-1.8, -1.05, 0.1)];
  private readonly sleeves: Array<{ upper: THREE.Mesh; fore: THREE.Mesh }> = [];
  private joints: THREE.Mesh[] = [];
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpElbow = new THREE.Vector3();

  constructor() {
    const shell = getHandMaterialSet().shell;
    const make = (rTop: number, rBottom: number): THREE.Mesh => {
      // Unit-height tapered cylinder, stretched between joints per frame.
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, 1, 10, 1, true), shell);
      mesh.matrixAutoUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      return mesh;
    };
    for (let i = 0; i < 2; i++) {
      // Taper: thicker at the shoulder, thinnest at the wrist (aim() maps
      // +Y to the SECOND joint, so rTop is the far end — v2 had it inverted).
      this.sleeves.push({ upper: make(0.04, 0.05), fore: make(0.03, 0.04) });
    }
    // Elbow joint spheres close the open cylinder ends; wrist spheres cover
    // the forearm-to-cuff seam (round-3: hollow tube rims showed on clamp).
    this.joints = [
      new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), shell),
      new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), shell),
      new THREE.Mesh(new THREE.SphereGeometry(0.021, 10, 8), shell),
      new THREE.Mesh(new THREE.SphereGeometry(0.021, 10, 8), shell),
    ];
    void this.joints;
    for (const j of this.joints) {
      j.castShadow = false;
      j.receiveShadow = false;
      this.group.add(j);
    }
    this.group.visible = false;
  }

  /** Stretch a sleeve mesh between two points. */
  private aim(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    this.tmpA.copy(b).sub(a);
    const len = this.tmpA.length();
    if (len < 1e-4) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.position.copy(a).addScaledVector(this.tmpA, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.tmpA.multiplyScalar(1 / len));
    mesh.scale.set(1, len, 1);
  }

  /**
   * Solve both arms so the wrists land on the given hand positions.
   * `pivot` is the view-space root (hands are converted from world space).
   */
  solve(pivot: THREE.Object3D, wristWorld: THREE.Vector3[]): void {
    this.group.visible = true;
    for (let i = 0; i < 2; i++) {
      const shoulder = this.shoulders[i]!;
      const wrist = pivot.worldToLocal(this.tmpB.copy(wristWorld[i]!));
      const { upper, fore } = this.sleeves[i]!;

      // Analytic two-bone IK: clamp the reach, then place the elbow off the
      // law-of-cosines angle along the bend hint (down/outward). At the
      // short viewmodel reaches the raw sinA folds the elbow ~30 cm off the
      // line (v4 round 1: pipe-arms), so the offset is damped — the stretched
      // forearm absorbs the residual, keeping a subtle visible bend.
      const elbowDamp = 0.5;
      const delta = this.tmpA.copy(wrist).sub(shoulder);
      let d = delta.length();
      const maxReach = this.upperLen + this.foreLen - 0.02;
      const clamped = Math.min(d, maxReach);
      delta.multiplyScalar(d > 1e-5 ? clamped / d : 0);
      d = Math.max(clamped, Math.abs(this.upperLen - this.foreLen) + 0.02);
      const wristC = shoulder.clone().add(delta);

      const cosA = (this.upperLen * this.upperLen + d * d - this.foreLen * this.foreLen) / (2 * this.upperLen * d);
      const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA)) * elbowDamp;
      const along = delta.clone().normalize();
      const bend = this.bends[i]!.clone().addScaledVector(along, -this.bends[i]!.dot(along));
      if (bend.lengthSq() < 1e-6) bend.set(0, -1, 0);
      bend.normalize();
      this.tmpElbow.copy(shoulder)
        .addScaledVector(along, this.upperLen * cosA)
        .addScaledVector(bend, this.upperLen * sinA);

      this.aim(upper, shoulder, this.tmpElbow);
      // Clamp safety: when the chain cannot reach, aim the forearm at the
      // TRUE wrist (never render a floating open tube end short of the hand).
      const short = wrist.distanceTo(shoulder) > maxReach + 1e-3;
      this.aim(fore, this.tmpElbow, short ? wrist : wristC);
      this.joints[i]!.position.copy(this.tmpElbow);
      this.joints[this.joints.length - 2 + i]!.position.copy(short ? wrist : wristC);
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}
