/**
 * CYCLE 35/36 — first-person hands/arms rig (v2 after critical review).
 *
 * Two gloved hands parented INSIDE each weapon model group at its grip
 * anchors (see ProceduralWeapon.gripR/gripL), so every weapon motion — sway,
 * ADS, recoil kick, reload — carries the hands for free. The rig is built to
 * human scale and counter-scaled against the weapon's presentation scale.
 *
 * v2 review fixes baked in:
 * - the left-hand mirror lives in a dedicated wrapper group, and the pose
 *   solver composes rotations around it (the v1 Euler clobber un-mirrored
 *   the hand on frame one, dangling the fingers into the air),
 * - forearms tuned per hand so they exit the bottom frame corners in the
 *   default poses, thinner, and stay attached through reload swings,
 * - one human hand scale (no per-weapon size jumps),
 * - lighter glove material with fabric bump so hands read against dark
 *   polymer weapons,
 * - support-hand tuck while aiming (never crosses the sight line),
 * - dedicated magazine-carry offset (palm ON the mag body) and a bolt-cycle
 *   timeline for the sniper (right hand leaves the grip, works the bolt,
 *   returns).
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface HandPoseInput {
  /** 0..1 through the reload, or -1 when not reloading. */
  reloadPhase: number;
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


function makeHandMats(): HandMats {
  const bump = getFabricBump();
  // CYCLE 36 (review): lifted from near-black — hands must read against dark
  // polymer weapons. Warm dark-grey glove + harder shell accents.
  const glove = new THREE.MeshStandardMaterial({ color: 0x5c646c, roughness: 0.72, metalness: 0.06 });
  if (bump) {
    glove.normalMap = bump;
    glove.normalScale.set(0.5, 0.5);
  }
  const shell = new THREE.MeshStandardMaterial({ color: 0x565d64, roughness: 0.55, metalness: 0.3 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc0906c, roughness: 0.7, metalness: 0 });
  const plate = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.45, metalness: 0.4 });
  return { glove, shell, skin, plate };
}

/** One gloved hand, built reaching palm-down with fingers curling -y and
 * extending -z. The caller mirrors it for the left hand via a wrapper group
 * so pose rotations can never undo the mirror. */
function buildHand(mats: HandMats): THREE.Group {
  const hand = new THREE.Group();

  const palm = new THREE.Mesh(new RoundedBoxGeometry(0.036, 0.03, 0.088, 2, 0.011), mats.glove);
  palm.position.set(0, 0, 0.01);
  hand.add(palm);

  // Knuckle armour across the back.
  const plate = new THREE.Mesh(new RoundedBoxGeometry(0.04, 0.013, 0.04, 2, 0.004), mats.plate);
  plate.position.set(0, 0.02, 0.016);
  hand.add(plate);

  // Four fingers: two segments, curled to wrap a ~30 mm grip; tight spacing
  // so the silhouette reads as one hand (v1's 4 mm gaps read as a comb).
  for (let i = 0; i < 4; i++) {
    const finger = new THREE.Group();
    finger.position.set(0, 0.008 - i * 0.0165, -0.03);
    const seg1 = new THREE.Mesh(new THREE.CapsuleGeometry(0.0092, 0.026, 3, 8), mats.glove);
    seg1.rotation.x = Math.PI / 2;
    seg1.position.set(0, -0.008, -0.012);
    finger.add(seg1);
    const seg2 = new THREE.Mesh(new THREE.CapsuleGeometry(0.0086, 0.022, 3, 8), mats.glove);
    seg2.position.set(0, -0.022, -0.026);
    seg2.rotation.x = Math.PI / 2 + 1.0;
    finger.add(seg2);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0066, 8, 8), mats.skin);
    tip.position.set(0, -0.024, -0.04);
    finger.add(tip);
    hand.add(finger);
  }

  // Thumb closing across the near face.
  const thumb = new THREE.Group();
  thumb.position.set(0.02, 0.008, 0.006);
  const thumbSeg = new THREE.Mesh(new THREE.CapsuleGeometry(0.0095, 0.03, 3, 8), mats.glove);
  thumbSeg.rotation.set(0.3, 0, -1.15);
  thumbSeg.position.set(0.01, -0.004, -0.012);
  thumb.add(thumbSeg);
  const thumbTip = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 8), mats.skin);
  thumbTip.position.set(0.008, -0.01, -0.03);
  thumb.add(thumbTip);
  hand.add(thumb);

  // Wrist cuff.
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.03, 10), mats.shell);
  cuff.rotation.x = Math.PI / 2 - 0.3;
  cuff.position.set(0, 0.004, 0.055);
  hand.add(cuff);

  return hand;
}

/** Forearm sleeve: child of the hand, running from the wrist off-screen.
 * Direction is authored in HAND space for the DEFAULT pose, so it exits the
 * bottom frame corners; reload swings carry it naturally. */
function buildForearm(mats: HandMats, dir: THREE.Vector3): THREE.Group {
  const arm = new THREE.Group();
  const len = 0.4;
  const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, len, 4, 10), mats.shell);
  sleeve.position.copy(dir).multiplyScalar(len / 2 + 0.02);
  sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  arm.add(sleeve);
  return arm;
}

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export function createHandRig(): HandRig {
  const mats = makeHandMats();

  // Left hand: the mirror lives in a WRAPPER so pose rotations can never
  // undo it (v1 clobbered rotation.y = Math.PI on the first frame).
  const leftWrap = new THREE.Group();
  leftWrap.rotation.y = Math.PI;
  const leftHand = buildHand(mats);
  leftWrap.add(leftHand);
  const left = leftWrap;

  const right = buildHand(mats);

  // Forearms exit bottom-right (right) / bottom-left-centre (left) in the
  // default poses. Thinner sleeve — v1's read as grey clubs.
  right.add(buildForearm(mats, new THREE.Vector3(0.5, -0.95, 0.5).normalize()));
  left.add(buildForearm(mats, new THREE.Vector3(-0.35, -1.0, 0.55).normalize()));

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
    pose({ reloadPhase, magLocal, pumpOffset, pumpHand, ads, boltPhase, boltLocal }) {
      // ---- Right hand -------------------------------------------------
      // Sniper: the firing hand leaves the grip and works the bolt through
      // the cycle, then re-seats. Grip → bolt → ride → return.
      if (boltPhase >= 0 && boltLocal) {
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
        right.rotation.set(-0.4, -0.2, 0.2);
      } else {
        right.position.set(gripR.x + 0.014, gripR.y - 0.018, gripR.z + 0.03);
        right.rotation.set(-0.55 + ads * 0.1, -0.25, 0.12);
      }

      // ---- Left hand ----------------------------------------------------
      if (pumpHand) {
        // Shotgun: hand rides ON the pump (anchor sits at its rear-top).
        left.position.set(gripL.x, gripL.y, gripL.z + pumpOffset);
        leftWrap.rotation.set(-0.15, Math.PI, 0);
        return;
      }
      if (reloadPhase >= 0 && magLocal) {
        // Reach to the mag (0-0.3), pull down with it (0.3-0.5), carry back
        // up and seat (0.5-0.85), slap + re-grip (0.85-1). The palm rides ON
        // the mag body (small offset — v1 hovered 9 cm below it).
        const p = reloadPhase;
        const target = new THREE.Vector3();
        if (p < 0.3) {
          target.lerpVectors(gripL, magLocal, smooth(p / 0.3));
          leftWrap.rotation.set(-0.2, Math.PI, 0.1);
        } else if (p < 0.85) {
          target.copy(magLocal);
          target.y -= 0.02;
          leftWrap.rotation.set(-0.3, Math.PI, -0.15);
        } else {
          target.lerpVectors(magLocal, gripL, smooth((p - 0.85) / 0.15));
          leftWrap.rotation.set(-0.2, Math.PI, 0.1);
        }
        left.position.copy(target);
        return;
      }
      // Default support pose: palm cups the underside, fingers curling up
      // around the far side — tucked lower while aiming so it never crosses
      // the sight line (round-6 review: ADS was blocked by the glove).
      const tuck = ads * 0.035;
      left.position.set(gripL.x, gripL.y - 0.03 - tuck, gripL.z + ads * 0.01);
      leftWrap.rotation.set(-1.15 - ads * 0.25, Math.PI, 0.2);
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
  private readonly shoulders = [
    new THREE.Vector3(0.24, -0.38, 0.26),
    new THREE.Vector3(-0.22, -0.36, 0.24),
  ];
  private readonly upperLen = 0.32;
  private readonly foreLen = 0.34;
  private readonly bends = [new THREE.Vector3(1.2, -0.9, 0.1), new THREE.Vector3(-1.2, -0.9, 0.1)];
  private readonly sleeves: Array<{ upper: THREE.Mesh; fore: THREE.Mesh }> = [];
  private joints: THREE.Mesh[] = [];
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpElbow = new THREE.Vector3();

  constructor(shell: THREE.MeshStandardMaterial) {
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
      this.sleeves.push({ upper: make(0.052, 0.046), fore: make(0.045, 0.034) });
    }
    // Joint spheres close the open cylinder ends at elbow and wrist.
    this.joints = [
      new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), shell),
      new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), shell),
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
      // law-of-cosines angle along the bend hint (down/outward).
      const delta = this.tmpA.copy(wrist).sub(shoulder);
      let d = delta.length();
      const maxReach = this.upperLen + this.foreLen - 0.02;
      const clamped = Math.min(d, maxReach);
      delta.multiplyScalar(d > 1e-5 ? clamped / d : 0);
      d = Math.max(clamped, Math.abs(this.upperLen - this.foreLen) + 0.02);
      const wristC = shoulder.clone().add(delta);

      const cosA = (this.upperLen * this.upperLen + d * d - this.foreLen * this.foreLen) / (2 * this.upperLen * d);
      const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      const along = delta.clone().normalize();
      const bend = this.bends[i]!.clone().addScaledVector(along, -this.bends[i]!.dot(along));
      if (bend.lengthSq() < 1e-6) bend.set(0, -1, 0);
      bend.normalize();
      this.tmpElbow.copy(shoulder)
        .addScaledVector(along, this.upperLen * cosA)
        .addScaledVector(bend, this.upperLen * sinA);

      this.aim(upper, shoulder, this.tmpElbow);
      this.aim(fore, this.tmpElbow, wristC);
      this.joints[i]!.position.copy(this.tmpElbow);
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}
