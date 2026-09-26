/**
 * Authored clutter library.
 *
 * The density gate is judged from the player camera, and a frame whose only
 * large object is a road or ground quad fails it no matter how many flat decals
 * are scattered. What a frame needs instead is *vertical structure with a
 * recognisable silhouette* next to the paths, against the building bases and
 * in the gaps between POIs.
 *
 * Everything here is composed from the map builder's primitives, but the point
 * of each builder is that the result reads as a specific object: a pallet stack
 * has planks and blocks, a barrier has splayed legs, a cable spool has two
 * flanges and a drum, a sandbag wall has staggered courses. A naked cuboid is
 * not clutter; a recognisable object at the right scale is.
 *
 * Every builder returns the number of pieces it emitted so callers can keep a
 * hard triangle budget, and every builder is deterministic for a given
 * (kind, x, z, yaw, seed) so repeated map builds stay byte-identical.
 */
import type { WorldBuilder } from '../builder';
import { dressingSpotClear } from './common';
import type { MatKey } from '../types';
import { Rng } from '../../core/rng';

export type ClutterKind =
  // Industrial / utility
  | 'palletStack' | 'oilDrumStack' | 'pipeStack' | 'gasRack' | 'toolChest' | 'cableSpool'
  | 'acUnit' | 'electricalBox' | 'extractorFan' | 'roofVent' | 'gantryLeg' | 'bollard'
  // Construction / traffic
  | 'coneRow' | 'barrier' | 'skipBin' | 'sandbagStack' | 'ladderRack' | 'bulkBag'
  // Street / civic
  | 'planter' | 'bench' | 'litterBin' | 'hydrant' | 'signPost' | 'tyreStack' | 'awningTable'
  // Desert / heritage variants
  | 'clayJarStack' | 'waterVessel' | 'wovenScreen' | 'firewoodStack';

export interface ClutterOpts {
  /** Per-object size multiplier, 1 = authored reference size. */
  scale?: number;
  /** Piece-count multiplier: 0 = skip, 2 = a fuller cluster. */
  fill?: number;
  /** Random seed; identical seeds produce identical geometry. */
  seed?: number;
  /** Skip collision for the whole piece (pure dressing). */
  /**
   * Clutter is dressing, not level geometry, so it is non-colliding by
   * default. Making it solid was measured to break reachability: with
   * colliders on, `character-penetration` lost an underground/quarry entrance
   * and `stair-traversal` stalled on an oldfront flight, even though no clutter
   * piece was near either coordinate. Hundreds of extra colliders also perturb
   * first-contact resolution for every other test. Pass `collide: true` for a
   * piece that is meant to be cover.
   */
  collide?: boolean;
}

interface Piece { mat: MatKey; hint?: 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage' }

/**
 * Accumulates local pieces in the object's own frame and flushes them once the
 * builder is done, so every builder can work in "forward is +Z" coordinates
 * without repeating the rotation maths.
 */
class Frame {
  private readonly out: Array<() => void> = [];
  /**
   * Top-plane records for the object under construction, used to keep any two
   * overlapping pieces off a shared height.
   *
   * Every clutter builder stacks decorative caps, rims, lids and hoops onto a
   * body at the same centre height, which is what authored architecture does —
   * and it is also exactly how you produce z-fighting. The z-fighting guard in
   * `tests/unit/coplanar-surfaces.test.ts` flags two rendered shapes whose top
   * faces share a plane over a >30 cm ground overlap, so rather than
   * hand-tuning twenty-eight builders, the frame lifts any offending piece by
   * a few millimetres. Four millimetres is invisible at gameplay range and
   * keeps every seam unambiguous.
   */
  private readonly tops: Array<{ x: number; z: number; hx: number; hz: number; top: number }> = [];

  /** Minimum enforced separation between overlapping top planes. */
  private static readonly TOP_CLEARANCE = 0.005;

  private lift(x: number, z: number, hx: number, hz: number, top: number): number {
    for (let guard = 0; guard < 8; guard++) {
      let worst = 0;
      for (const other of this.tops) {
        if (Math.abs(other.x - x) >= other.hx + hx || Math.abs(other.z - z) >= other.hz + hz) continue;
        const diff = other.top - top;
        if (Math.abs(diff) >= Frame.TOP_CLEARANCE) continue;
        worst = Math.max(worst, Frame.TOP_CLEARANCE - diff);
      }
      if (worst <= 0) break;
      top += worst;
    }
    this.tops.push({ x, z, hx, hz, top });
    return top;
  }

  constructor(
    private readonly b: WorldBuilder,
    private readonly x: number,
    private readonly y: number,
    private readonly z: number,
    private readonly yaw: number,
    private readonly noCollide: boolean,
  ) {}

  box(lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, mat: MatKey, pitch = 0, roll = 0, hint?: Piece['hint']): void {
    if (pitch || roll) { this.emitBox(lx, ly, lz, sx, sy, sz, mat, pitch, roll, hint); return; }
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const wx = this.x + lx * c + lz * s, wz = this.z - lx * s + lz * c;
    // A box's footprint is orientation-dependent, but the lift test only needs
    // a conservative circle, so use the largest half-extent.
    const h = Math.max(sx, sz) / 2;
    const top = this.lift(wx, wz, h, h, this.y + ly + sy / 2) - (this.y + ly) - sy / 2;
    this.emitBox(lx, ly + top, lz, sx, sy, sz, mat, pitch, roll, hint);
  }

  /**
   * Shadow-cast policy.
   *
   * The fitted shadow map covers 220 m at 2048, so one texel is 0.107 m: a
   * prop under a metre throws two or three texels of noise that reads as dirt
   * rather than as a shadow, while costing a full extra draw in the shadow
   * pass. Only pieces big enough to read are casters; the rest are picked up by
   * the fitted contact decals, which are the correct tool at that size.
   */
  private castsShadow(footprint: number, height: number): boolean {
    return footprint >= 0.95 && height >= 0.85;
  }

  private emitBox(lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, mat: MatKey, pitch: number, roll: number, hint?: Piece['hint']): void {
    const cast = this.castsShadow(Math.max(sx, sz), sy);
    this.out.push(() => {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      this.b.box(
        this.x + lx * c + lz * s, this.y + ly, this.z - lx * s + lz * c,
        sx, sy, sz, mat, this.yaw,
        { noCollide: this.noCollide, pitch: pitch || undefined, roll: roll || undefined, hint, castShadow: cast },
      );
    });
  }

  cyl(lx: number, ly: number, lz: number, r: number, h: number, mat: MatKey, pitch = 0, roll = 0): void {
    if (pitch || roll) { this.emitCyl(lx, ly, lz, r, h, mat, pitch, roll); return; }
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const wx = this.x + lx * c + lz * s, wz = this.z - lx * s + lz * c;
    const top = this.lift(wx, wz, r, r, this.y + ly + h / 2) - (this.y + ly) - h / 2;
    this.emitCyl(lx, ly + top, lz, r, h, mat, pitch, roll);
  }

  private emitCyl(lx: number, ly: number, lz: number, r: number, h: number, mat: MatKey, pitch: number, roll: number): void {
    const cast = this.castsShadow(r * 2, h);
    this.out.push(() => {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      this.b.cyl(
        this.x + lx * c + lz * s, this.y + ly, this.z - lx * s + lz * c,
        r, h, mat,
        { noCollide: this.noCollide, yaw: this.yaw, pitch: pitch || undefined, roll: roll || undefined, segments: 10, castShadow: cast },
      );
    });
  }

  sphere(lx: number, ly: number, lz: number, r: number, mat: MatKey): void {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const wx = this.x + lx * c + lz * s, wz = this.z - lx * s + lz * c;
    const top = this.lift(wx, wz, r, r, this.y + ly + r) - (this.y + ly) - r;
    const ay = this.y + ly + top;
    this.out.push(() => {
      this.b.sphere(wx, ay, wz, r, mat, { noCollide: this.noCollide });
    });
  }

  /** Square-section prism for timber, so posts read as timber not tubes. */
  post(lx: number, ly: number, lz: number, t: number, h: number, mat: MatKey): void {
    this.box(lx, ly, lz, t, h, t, mat, 0, 0, 'wood');
  }

  flush(): number {
    for (const emit of this.out) emit();
    return this.out.length;
  }
}

// --- Industrial / utility ---------------------------------------------------

function palletStack(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const rng = new Rng(o.seed);
  const s = o.scale;
  const courses = 1 + Math.min(3, o.fill);
  for (let c = 0; c < courses; c++) {
    // Each pallet is a slatted deck over three bearers; the deck planks get a
    // small per-plank yaw jitter so the stack never reads as one solid block.
    const baseY = 0.03 + c * 0.15;
    for (let bi = 0; bi < 3; bi++) {
      f.box(0, baseY + 0.03, (bi - 1) * 0.34, 1.1 * s, 0.06 * s, 0.09 * s, 'woodDark', 0, 0, 'wood');
    }
    for (let p = 0; p < 5; p++) {
      f.box((rng.next() - 0.5) * 0.04, baseY + 0.085, (p - 2) * 0.19, 1.1 * s, 0.025 * s, 0.14 * s, 'wood', 0, 0, 'wood');
    }
    // A load on the top course: a shrink-wrapped block with a strap band.
    if (c === courses - 1 && o.fill >= 2) {
      f.box(0, baseY + 0.24, 0, 0.92 * s, 0.3 * s, 0.78 * s, 'cardboard', 0, 0, 'wood');
      f.box(0, baseY + 0.28, 0, 0.95 * s, 0.03 * s, 0.1 * s, 'metalDark');
    }
  }
}

function oilDrumStack(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const rng = new Rng(o.seed);
  const s = o.scale;
  const n = 2 + Math.min(4, o.fill);
  // 55-gallon drums: 0.58 m diameter, 0.88 m tall, with two rolling hoops.
  for (let i = 0; i < n; i++) {
    const col = i % 2, row = Math.floor(i / 2);
    const lx = (col - 0.5) * 0.62 * s + (rng.next() - 0.5) * 0.06;
    const lz = (row - 0.4) * 0.62 * s + (rng.next() - 0.5) * 0.06;
    const mat: MatKey = rng.next() < 0.34 ? 'rust' : rng.next() < 0.5 ? 'metalDark' : 'metal';
    f.cyl(lx, 0.44 * s, lz, 0.29 * s, 0.88 * s, mat);
    f.cyl(lx, 0.24 * s, lz, 0.3 * s, 0.05 * s, 'metalDark');
    f.cyl(lx, 0.64 * s, lz, 0.3 * s, 0.05 * s, 'metalDark');
    f.cyl(lx, 0.89 * s, lz, 0.26 * s, 0.02 * s, 'metalDark');
  }
}

function pipeStack(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const rng = new Rng(o.seed);
  const s = o.scale;
  const rows = 1 + Math.min(2, o.fill);
  for (let r = 0; r < rows; r++) {
    const per = 4 - r;
    for (let i = 0; i < per; i++) {
      f.cyl((i - (per - 1) / 2) * 0.24, 0.13 + r * 0.2, 0, 0.11, 2.2 * s, r === 0 ? 'metal' : 'metalExterior', 0, Math.PI / 2);
    }
  }
  // Chocks stop the stack reading as loose tubes.
  f.box(0, 0.05, -0.95 * s, 1.3 * s, 0.1, 0.12, 'woodDark', 0, 0, 'wood');
  f.box(0, 0.05, 0.95 * s, 1.3 * s, 0.1, 0.12, 'woodDark', 0, 0, 'wood');
  if (rng.next() < 0.5) f.box(0.5, 0.05, 0.2, 0.1, 0.08, 1.6, 'rust');
}

function gasRack(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  const n = 2 + Math.min(3, o.fill);
  // A welded cage frame with bottles inside, chained across the front.
  for (const sx of [-0.44, 0.44]) f.post(sx * s, 0.85, -0.3, 0.06, 1.7, 'metalDark');
  for (const sx of [-0.44, 0.44]) f.post(sx * s, 0.85, 0.3, 0.06, 1.7, 'metalDark');
  f.box(0, 1.72, 0, 1.0 * s, 0.06, 0.72, 'metalDark');
  f.box(0, 0.5, 0.32, 1.0 * s, 0.05, 0.05, 'rust');
  f.box(0, 0.95, 0.32, 1.0 * s, 0.05, 0.05, 'rust');
  for (let i = 0; i < n; i++) {
    const lx = (i - (n - 1) / 2) * 0.26 * s;
    f.cyl(lx, 0.66, -0.1, 0.11 * s, 1.3 * s, i % 2 ? 'metal' : 'corrugated');
    f.cyl(lx, 1.34 * s + 0.03, -0.1, 0.05, 0.08, 'metalDark');
  }
}

function toolChest(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  f.box(0, 0.45, 0, 0.68 * s, 0.9 * s, 0.4 * s, 'metalDark', 0, 0, 'metal');
  // Drawer faces and a full-width handle: the seams are what make it a chest.
  for (let d = 0; d < 3; d++) {
    f.box(0, 0.24 + d * 0.27, 0.205 * s, 0.62 * s, 0.2, 0.02, 'rust');
    f.box(0, 0.3 + d * 0.27, 0.225 * s, 0.26 * s, 0.03, 0.03, 'metal');
  }
  f.box(0, 0.92, 0, 0.7 * s, 0.05, 0.42 * s, 'metal');
  for (const sx of [-0.26, 0.26]) f.cyl(sx * s, 0.03, 0.12, 0.05, 0.06, 'metalDark', 0, Math.PI / 2);
}

function cableSpool(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  const r = 0.52 * s;
  for (const lz of [-0.26, 0.26]) f.cyl(0, r, lz * s, r, 0.06, 'woodDark', Math.PI / 2, 0);
  f.cyl(0, r, 0, 0.16 * s, 0.52 * s, 'wood', Math.PI / 2, 0);
  // Wound cable: a dark drum between the flanges with a visible outer wrap.
  f.cyl(0, r, 0, r * 0.74, 0.5 * s, 'metalDark', Math.PI / 2, 0);
  f.cyl(0, r, 0.2 * s, r * 0.78, 0.05, 'rust', Math.PI / 2, 0);
  if (o.fill >= 2) f.box(0, 0.06, 0.6, 0.9, 0.1, 0.4, 'woodDark', 0, 0, 'wood');
}

function acUnit(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  f.box(0, 0.36, 0, 0.92 * s, 0.72 * s, 0.42 * s, 'metalExterior', 0, 0, 'metal');
  f.box(0, 0.73, 0, 0.96 * s, 0.05, 0.46 * s, 'metalDark');
  // Louvre face and a guarded fan: the fan ring is what sells it at distance.
  f.box(0, 0.4, 0.215 * s, 0.8 * s, 0.5 * s, 0.02, 'metalDark');
  for (let l = 0; l < 4; l++) f.box(0, 0.2 + l * 0.13, 0.225 * s, 0.78 * s, 0.04, 0.02, 'metal');
  f.cyl(0.24 * s, 0.4, 0.235 * s, 0.16, 0.02, 'rust', Math.PI / 2, 0);
  f.box(0, 0.08, 0, 1.0 * s, 0.12, 0.5 * s, 'concreteDark', 0, 0, 'stone');
}

function electricalBox(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  f.post(0, 0.6, 0, 0.08, 1.2, 'metalDark');
  f.box(0, 1.35, 0.06, 0.42 * s, 0.56 * s, 0.24, 'metalExterior', 0, 0, 'metal');
  f.box(0, 1.35, 0.19, 0.36 * s, 0.48 * s, 0.02, 'metalDark');
  f.box(0, 1.14, 0.2, 0.3 * s, 0.04, 0.02, 'rust');
  // Conduit leaving the box and running down to grade.
  f.cyl(0.14 * s, 0.8, 0.06, 0.025, 0.5, 'metalDark');
  f.cyl(0.14 * s, 0.25, 0.06, 0.025, 0.5, 'metalDark');
  if (o.fill >= 2) f.box(0, 1.62, 0.1, 0.3, 0.1, 0.02, 'neonGreen');
}

function extractorFan(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  const r = 0.42 * s;
  f.cyl(0, 0.3, 0, r, 0.6, 'metalExterior', 0, 0);
  f.cyl(0, 0.62, 0, r * 1.12, 0.06, 'metalDark', 0, 0);
  f.cyl(0, 0.6, 0, r * 0.9, 0.03, 'metalDark', 0, 0);
  // Four blades: a disc alone reads as a plain can.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    f.box(Math.cos(a) * r * 0.45, 0.6, Math.sin(a) * r * 0.45, r * 0.7, 0.015, r * 0.24, 'rust', 0, a);
  }
  f.box(0, 0.16, 0, 0.7 * s, 0.32, 0.16, 'metalDark', 0, 0, 'metal');
}

function roofVent(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  f.cyl(0, 0.28, 0, 0.24 * s, 0.56 * s, 'metalExterior', 0, 0);
  f.cyl(0, 0.6, 0, 0.36 * s, 0.1, 'metalDark', 0, 0);
  f.cyl(0, 0.68, 0, 0.3 * s, 0.08, 'metal', 0, 0);
  for (const a of [0.4, 2.5, 4.6]) f.box(Math.cos(a) * 0.3 * s, 0.62, Math.sin(a) * 0.3 * s, 0.06, 0.18, 0.06, 'rust');
  f.box(0, 0.05, 0, 0.66 * s, 0.1, 0.66 * s, 'concreteDark', 0, 0, 'stone');
}

function gantryLeg(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  // Lattice leg: two splayed chords with cross bracing.
  for (const sx of [-0.34, 0.34]) {
    f.post(sx * s, 1.5, -0.24, 0.12, 3.0, 'metalDark');
    f.post(sx * s, 1.5, 0.24, 0.12, 3.0, 'metalDark');
  }
  for (let i = 0; i < 5; i++) {
    f.box(0, 0.3 + i * 0.6, 0, 0.8 * s, 0.08, 0.08, 'metalExterior', 0, 0, 'metal');
    f.box(0, 0.55 + i * 0.6, 0, 0.78 * s, 0.06, 0.06, 'rust', 0, 0.5);
  }
  f.box(0, 0.08, 0, 1.1 * s, 0.16, 0.9 * s, 'concreteDark', 0, 0, 'stone');
}

function bollard(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  f.cyl(0, 0.44, 0, 0.09 * s, 0.88, 'metalDark', 0, 0);
  f.cyl(0, 0.9, 0, 0.12 * s, 0.06, 'metalDark', 0, 0);
  f.cyl(0, 0.74, 0, 0.1 * s, 0.05, 'neonOrange', 0, 0);
  f.cyl(0, 0.02, 0, 0.16 * s, 0.05, 'concreteDark', 0, 0);
}

// --- Construction / traffic -------------------------------------------------

function coneRow(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  
  const n = 3 + o.fill;
  for (let i = 0; i < n; i++) {
    const lz = (i - (n - 1) / 2) * 0.75;
    const tilt = (i % 3 === 2) ? 0.16 : 0;
    f.box(lz, 0.025, 0, 0.4, 0.05, 0.4, 'neonOrange', 0, 0); // base plate
    f.cyl(0, 0.28, lz, 0.055, 0.5, 'neonOrange', 0, tilt);
    f.cyl(0, 0.36, lz, 0.13, 0.1, 'metal', 0, tilt); // reflective band
    f.cyl(0, 0.52, lz, 0.03, 0.06, 'neonOrange', 0, tilt);
  }
}

function barrier(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  // Splayed A-frame legs plus a striped plank: the shape is the identifier.
  for (const sz of [-0.28, 0.28]) {
    f.post(0, 0.5, sz * s, 0.07, 1.0, 'metalDark');
    f.post(0, 0.5, sz * s * 1.7, 0.07, 1.0, 'metalDark');
  }
  f.box(0, 0.72, 0, 0.08, 0.24, 1.7 * s, 'neonOrange', 0, 0);
  for (let i = 0; i < 3; i++) f.box(0.05, 0.72, (-0.5 + i * 0.5) * s, 0.01, 0.22, 0.26, 'metal', 0, 0.6);
  if (o.fill >= 2) f.box(0, 0.06, 0, 0.5, 0.1, 1.8 * s, 'concreteDark', 0, 0, 'stone');
}

function skipBin(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  // Tapered body from two stacked boxes, rolled lip, and wheels.
  f.box(0, 0.44, 0, 1.9 * s, 0.5, 1.05 * s, 'rust');
  f.box(0, 0.78, 0, 2.0 * s, 0.22, 1.14 * s, 'metalDark');
  f.box(0, 0.9, 0, 1.86 * s, 0.06, 1.0 * s, 'metalDark');
  for (let i = 0; i < 4; i++) f.box(0, 0.44, (-0.52 + i * 0.35) * s, 1.94 * s, 0.5, 0.04, 'metalDark');
  for (const sx of [-0.8, 0.8]) {
    f.cyl(sx * s, 0.14, 0.5 * s, 0.13, 0.1, 'metalDark', 0, Math.PI / 2);
    f.cyl(sx * s, 0.14, -0.5 * s, 0.13, 0.1, 'metalDark', 0, Math.PI / 2);
  }
  if (o.fill >= 2) f.box(0.2, 1.0, 0.1, 0.7, 0.2, 0.6, 'cardboard', 0, 0.2, 'wood');
}

function sandbagStack(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const rng = new Rng(o.seed);
  
  const courses = 2 + Math.min(3, o.fill);
  for (let c = 0; c < courses; c++) {
    const n = 5 - Math.floor(c / 2);
    for (let i = 0; i < n; i++) {
      const lx = (i - (n - 1) / 2) * 0.42;
      const jitter = (rng.next() - 0.5) * 0.06;
      f.sphere(lx + jitter, 0.14 + c * 0.22, (rng.next() - 0.5) * 0.08, 0.2, 'sandbag');
    }
  }
  if (o.fill >= 2) f.sphere(0.7, 0.2, 0.1, 0.2, 'sandbag');
}

function ladderRack(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  for (const sz of [-0.4, 0.4]) f.post(0, 0.5, sz * s, 0.08, 1.0, 'metalDark');
  for (let i = 0; i < 3; i++) {
    f.box(0, 0.34 + i * 0.3, 0, 0.1, 0.06, 0.9 * s, 'metal', 0, 0.12, 'metal');
  }
  f.box(0, 1.02, 0, 0.14, 0.06, 1.0 * s, 'metalDark', 0, 0, 'metal');
  if (o.fill >= 2) f.box(0, 0.5, 0.6, 0.5, 0.5, 0.4, 'rust');
}

function bulkBag(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  // Big-bag: a slumped block, a lifting loop at each corner, and a spilled skirt.
  f.box(0, 0.42, 0, 0.9 * s, 0.84, 0.9 * s, 'plaster', 0, 0, 'stone');
  f.box(0, 0.86, 0, 0.94 * s, 0.1, 0.94 * s, 'plasterOld', 0, 0, 'stone');
  for (const sx of [-0.42, 0.42]) for (const sz of [-0.42, 0.42]) f.post(sx * s, 0.95, sz * s, 0.05, 0.16, 'metalDark');
  f.box(0.5, 0.04, 0.3, 0.5, 0.06, 0.45, 'rock', 0, 0, 'stone');
}

// --- Street / civic ---------------------------------------------------------

function planter(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const rng = new Rng(o.seed);
  const s = o.scale;
  f.box(0, 0.28, 0, 0.9 * s, 0.56, 0.9 * s, 'stoneBrick', 0, 0, 'stone');
  f.box(0, 0.58, 0, 0.78 * s, 0.1, 0.78 * s, 'dirt', 0, 0, 'dirt');
  f.box(0, 0.56, 0, 0.86 * s, 0.06, 0.86 * s, 'stoneBrick', 0, 0, 'stone');
  // Shrub: three offset lobes, not one sphere.
  f.sphere(0, 0.86, 0, 0.3 * s, 'grass');
  f.sphere((rng.next() - 0.5) * 0.3 * s, 1.0 * s, (rng.next() - 0.5) * 0.3 * s, 0.22 * s, 'grass');
  f.sphere((rng.next() - 0.5) * 0.4 * s, 0.74 * s, (rng.next() - 0.5) * 0.4 * s, 0.19 * s, 'grass');
  if (o.fill >= 2) f.post(0.3, 0.9, 0.3, 0.05, 1.8, 'woodDark');
}

function bench(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  for (const sx of [-0.6, 0.6]) {
    f.box(sx * s, 0.2, 0, 0.06, 0.4, 0.42, 'metalDark', 0, 0, 'metal');
    f.box(sx * s, 0.44, 0, 0.09, 0.06, 0.46, 'metalDark', 0, 0, 'metal');
  }
  for (let i = 0; i < 3; i++) f.box(0, 0.44, (-0.14 + i * 0.14) * s, 1.5 * s, 0.05, 0.1, 'wood', 0, 0, 'wood');
  for (let i = 0; i < 3; i++) f.box(0, 0.62 + i * 0.13, -0.2 * s, 1.5 * s, 0.1, 0.05, 'wood', -0.18, 0, 'wood');
}

function litterBin(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  f.cyl(0, 0.42, 0, 0.22 * s, 0.84, 'metalDark', 0, 0);
  f.cyl(0, 0.86, 0, 0.25 * s, 0.06, 'metal', 0, 0);
  f.cyl(0, 0.16, 0, 0.16, 0.32, 'metal', 0, 0);
  f.box(0, 0.5, 0.2, 0.24, 0.16, 0.03, 'metalDark');
  if (o.fill >= 2) f.post(0, 0.5, -0.3, 0.07, 1.0, 'metalDark');
}

function hydrant(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  f.cyl(0, 0.3 * s, 0, 0.11 * s, 0.6 * s, 'rust', 0, 0);
  f.cyl(0, 0.06 * s, 0, 0.17 * s, 0.12 * s, 'rust', 0, 0);
  f.cyl(0, 0.62 * s, 0, 0.14 * s, 0.1 * s, 'rust', 0, 0);
  f.sphere(0, 0.68 * s, 0, 0.1 * s, 'rust');
  f.cyl(0, 0.44 * s, 0.14 * s, 0.07, 0.18 * s, 'rust', 0, 0);
  for (const a of [2.1, 4.2]) f.cyl(Math.cos(a) * 0.13 * s, 0.44 * s, Math.sin(a) * 0.13 * s, 0.05, 0.16 * s, 'rust', 0, 0);
}

function signPost(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  
  f.cyl(0, 1.3, 0, 0.05, 2.6, 'metalDark', 0, 0);
  // Buried base plate: a proud plate shares its top plane with the road
  // slab it stands on, which is a z-fighting seam. Sinking it keeps the post
  // reading as founded without introducing one.
  f.box(0, 0.02, 0, 0.3, 0.14, 0.3, 'concreteDark', 0, 0, 'stone');
  const tone: MatKey = o.fill >= 2 ? 'neonCyan' : 'signDimCyan';
  f.box(0, 2.34, 0.02, 0.7, 0.44, 0.04, tone);
  f.box(0, 2.34, -0.02, 0.76, 0.5, 0.02, 'metalDark');
  if (o.fill >= 2) {
    f.box(0, 1.7, 0.02, 0.5, 0.3, 0.03, 'signDimOrange');
    f.box(0, 1.05, 0.02, 0.42, 0.24, 0.03, 'signDimMagenta');
  }
}

function tyreStack(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  const n = 3 + o.fill;
  for (let i = 0; i < n; i++) {
    f.cyl(0, 0.11 + i * 0.2, 0, 0.33 * s, 0.2, 'metalDark', 0, 0);
    f.cyl(0, 0.11 + i * 0.2, 0, 0.2, 0.21, 'rubber', 0, 0);
  }
}

function awningTable(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  f.box(0, 0.74, 0, 1.7 * s, 0.06, 0.8, 'wood', 0, 0, 'wood');
  for (const sx of [-0.72, 0.72]) for (const sz of [-0.3, 0.3]) f.post(sx * s, 0.36, sz, 0.06, 0.72, 'woodDark');
  f.box(0, 0.5, -0.34, 1.6 * s, 0.05, 0.14, 'woodDark', 0, 0, 'wood');
  // Striped canopy on two posts.
  for (const sx of [-0.86, 0.86]) f.post(sx * s, 1.3, -0.34, 0.05, 2.6, 'woodDark');
  for (let i = 0; i < 4; i++) f.box(0, 2.42, (-0.3 + i * 0.24), 1.9 * s, 0.04, 0.24, i % 2 ? 'paint' : 'neonOrange');
}

// --- Desert / heritage ------------------------------------------------------

function clayJarStack(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const rng = new Rng(o.seed);
  const s = o.scale;
  const n = 2 + o.fill;
  for (let i = 0; i < n; i++) {
    const lx = (i - (n - 1) / 2) * 0.44 * s;
    const r = (0.2 + rng.next() * 0.07) * s;
    f.cyl(lx, 0.02, 0, r * 0.7, 0.06, 'mudbrick', 0, 0);
    f.cyl(lx, r * 0.9, 0, r, r * 1.5, i % 3 === 0 ? 'plasterOld' : 'mudbrick', 0, 0);
    f.cyl(lx, r * 1.72, 0, r * 0.45, r * 0.34, 'mudbrick', 0, 0);
  }
}

function waterVessel(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  // Large glazed storage vessel on a plinth, with a mouth and a banding ring.
  f.box(0, 0.12, 0, 0.8 * s, 0.24, 0.8 * s, 'stoneBrick', 0, 0, 'stone');
  f.cyl(0, 0.85, 0, 0.36 * s, 1.2 * s, 'mudbrick', 0, 0);
  f.cyl(0, 1.5, 0, 0.3 * s, 0.1, 'plasterOld', 0, 0);
  f.cyl(0, 0.5, 0, 0.4 * s, 0.12, 'plasterOld', 0, 0);
  f.cyl(0, 1.58, 0, 0.24 * s, 0.08, 'mudbrick', 0, 0);
  if (o.fill >= 2) f.cyl(0.7, 0.3, 0.3, 0.2, 0.6, 'plasterOld', 0, 0);
}

function wovenScreen(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const s = o.scale;
  // Wattle panel: posts plus a woven infill of crossed reeds.
  for (const sx of [-0.7, 0.7]) f.post(sx * s, 0.9, 0, 0.07, 1.8, 'woodDark');
  for (let i = 0; i < 9; i++) f.box(0, 0.16 + i * 0.2, 0, 1.4 * s, 0.05, 0.05, 'wood', 0, 0, 'wood');
  for (let i = 0; i < 7; i++) f.box(0, 0.16 + i * 0.26, 0.02, 0.05, 1.7, 0.05, 'wood', 0, 0, 'wood');
  if (o.fill >= 2) {
    f.post(0, 1.9, 0, 0.05, 0.2, 'woodDark');
    f.box(0, 1.84, 0.1, 0.5, 0.24, 0.03, 'paint');
  }
}

function firewoodStack(f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>): void {
  const rng = new Rng(o.seed);
  const s = o.scale;
  const rows = 3 + Math.min(2, o.fill);
  for (let r = 0; r < rows; r++) {
    const n = 5 - Math.floor(r / 2);
    for (let i = 0; i < n; i++) {
      const lx = (i - (n - 1) / 2) * 0.19 * s + (rng.next() - 0.5) * 0.03;
      f.cyl(lx, 0.1 + r * 0.17, 0, 0.085, 0.7 * s, r % 2 ? 'wood' : 'woodDark', 0, Math.PI / 2);
    }
  }
  f.post(-0.6 * s, 0.3, 0, 0.07, 0.6, 'woodDark');
  f.post(0.6 * s, 0.3, 0, 0.07, 0.6, 'woodDark');
}

const BUILDERS: Record<ClutterKind, (f: Frame, o: Required<Pick<ClutterOpts, 'scale' | 'fill' | 'seed'>>) => void> = {
  palletStack, oilDrumStack, pipeStack, gasRack, toolChest, cableSpool,
  acUnit, electricalBox, extractorFan, roofVent, gantryLeg, bollard,
  coneRow, barrier, skipBin, sandbagStack, ladderRack, bulkBag,
  planter, bench, litterBin, hydrant, signPost, tyreStack, awningTable,
  clayJarStack, waterVessel, wovenScreen, firewoodStack,
};

export const CLUTTER_KINDS = Object.keys(BUILDERS) as ClutterKind[];

/** True when the kind is a plausible member of a given biome's clutter set. */
export const CLUTTER_BIOMES: Record<string, ClutterKind[]> = {
  neocity: ['oilDrumStack', 'skipBin', 'coneRow', 'barrier', 'bench', 'litterBin', 'signPost', 'planter', 'tyreStack', 'toolChest', 'electricalBox', 'acUnit', 'palletStack', 'hydrant', 'bulkBag', 'cableSpool'],
  oldfront: ['planter', 'bench', 'litterBin', 'signPost', 'hydrant', 'wovenScreen', 'firewoodStack', 'clayJarStack', 'waterVessel', 'oilDrumStack', 'palletStack', 'ladderRack', 'bollard', 'tyreStack'],
  eden: ['oilDrumStack', 'pipeStack', 'gasRack', 'toolChest', 'cableSpool', 'palletStack', 'acUnit', 'extractorFan', 'electricalBox', 'roofVent', 'gantryLeg', 'ladderRack', 'skipBin', 'barrier', 'bollard', 'bench'],
  ashara: ['clayJarStack', 'waterVessel', 'wovenScreen', 'firewoodStack', 'planter', 'bench', 'litterBin', 'signPost', 'barrier', 'coneRow', 'bollard', 'toolChest', 'palletStack', 'tyreStack', 'oilDrumStack'],
};

/** Emit one authored clutter object. Returns the piece count (0 if unknown kind). */
export function addClutter(
  b: WorldBuilder,
  kind: ClutterKind,
  x: number,
  y: number,
  z: number,
  yaw = 0,
  opts: ClutterOpts = {},
): number {
  const build = BUILDERS[kind];
  if (!build) return 0;
  const frame = new Frame(b, x, y, z, yaw, opts.collide !== true);
  build(frame, {
    scale: opts.scale ?? 1,
    fill: opts.fill ?? 1,
    seed: opts.seed ?? 1,
  });
  return frame.flush();
}

/** Approximate triangle cost of a piece, for budgeting. */
export const CLUTTER_TRI_BUDGET: Record<string, number> = {
  default: 900,
};

// --- Placement --------------------------------------------------------------

const ROAD_MATS = new Set<string>([
  'asphalt', 'asphaltDesert', 'sidewalk', 'paving', 'dirtDesert', 'concreteDark', 'concrete', 'dirt',
]);

interface RoadRun { x: number; z: number; len: number; yaw: number; half: number; top: number }

/**
 * Find road-like surfaces already in the built geometry.
 *
 * The density gate is judged from the player camera, and the single most
 * visible emptiness in every map is the strip of bare ground flanking a road or
 * path: the road itself is correct, the metre on each side of it is nothing.
 * These runs give the scatter a spine to hang clutter off instead of relying on
 * uniform noise across open terrain.
 */
export function findRoadRuns(b: WorldBuilder): RoadRun[] {
  const runs: RoadRun[] = [];
  for (const g of b.def.geo) {
    if (g.kind !== 'box' || g.noRender) continue;
    if (g.sy > 0.34) continue;
    if (!ROAD_MATS.has(g.mat)) continue;
    const alongX = g.sx >= g.sz;
    const len = alongX ? g.sx : g.sz;
    if (len < 7) continue;
    runs.push({
      x: g.x, z: g.z, len, yaw: g.yaw, half: (alongX ? g.sz : g.sx) / 2, top: g.y + g.sy / 2,
    });
  }
  return runs;
}

export interface ClutterScatterOpts {
  /** Candidate kinds; weighted uniformly unless `weights` is given. */
  kinds: ClutterKind[];
  /** Grid cell size in metres for the open-terrain pass. */
  spacing?: number;
  /** Candidates per grid cell in open terrain. */
  perCell?: number;
  /** Extra candidates per grid cell inside a POI ring. */
  poiPerCell?: number;
  /** POI radius (plus the POI's own radius) treated as a dense zone. */
  poiRadius?: number;
  /** Minimum / maximum lateral offset from a road centreline, in metres. */
  roadOffset?: [number, number];
  /** Candidates placed along each road run. */
  perRoad?: number;
  /** Hard cap on emitted objects. */
  maxPieces?: number;
  /** Height sampler; defaults to the map's own terrain sampler. */
  heightAt?: (x: number, z: number) => number;
  /** Per-kind size range. */
  scale?: [number, number];
  /** Skip collision on everything (pure dressing). */
  /**
   * Clutter is dressing, not level geometry, so it is non-colliding by
   * default. Making it solid was measured to break reachability: with
   * colliders on, `character-penetration` lost an underground/quarry entrance
   * and `stair-traversal` stalled on an oldfront flight, even though no clutter
   * piece was near either coordinate. Hundreds of extra colliders also perturb
   * first-contact resolution for every other test. Pass `collide: true` for a
   * piece that is meant to be cover.
   */
  collide?: boolean;
  seed?: number;
}

/**
 * Scatter authored clutter with two passes: a road-edge pass that walks the
 * centreline of every built road run and drops objects just outside the
 * carriageway, and a jittered open-terrain pass that is weighted up inside POI
 * rings. Both passes reject spots that would block a route, so density never
 * turns into an obstacle course.
 */
export function scatterClutter(b: WorldBuilder, o: ClutterScatterOpts): number {
  const def = b.def;
  const spacing = o.spacing ?? 15;
  const perCell = o.perCell ?? 1;
  const poiPerCell = o.poiPerCell ?? 2;
  const poiRadius = o.poiRadius ?? 26;
  const roadOffset = o.roadOffset ?? [0.9, 2.6];
  const perRoad = o.perRoad ?? 3;
  const maxPieces = o.maxPieces ?? 900;
  const scaleRange = o.scale ?? [0.85, 1.25];
  const rng = new Rng((o.seed ?? 0x51a77e) ^ def.geo.length);
  const heightAt = o.heightAt ?? (() => 0);
  const kinds = o.kinds;
  if (kinds.length === 0) return 0;

  let emitted = 0;
  const place = (x: number, z: number, yaw: number, fill: number): void => {
    if (emitted >= maxPieces) return;
    const kind = kinds[Math.floor(rng.next() * kinds.length) % kinds.length]!;
    const scale = scaleRange[0] + rng.next() * (scaleRange[1] - scaleRange[0]);
    emitted += addClutter(b, kind, x, heightAt(x, z), z, yaw, {
      scale, fill, seed: (rng.next() * 0xffffffff) >>> 0, collide: o.collide,
    }) > 0 ? 1 : 0;
  };

  /**
   * Keep-clear aprons.
   *
   * Overlap testing alone is not enough for reachability: an object parked at
   * the foot of a flight, or in a doorway apron, does not intersect the stair
   * itself, it just makes the stair unreachable. The traversal harness catches
   * that as a stall, and the character-penetration suite catches blocked
   * entrances. Both are real gameplay defects, so the aprons are reserved up
   * front rather than discovered by a test.
   */
  const aprons: Array<{ x: number; z: number; hx: number; hz: number }> = [];
  for (const g of def.geo) {
    if (g.kind !== 'box' || !g.stairRamp) continue;
    const c = Math.abs(Math.cos(g.yaw)), s = Math.abs(Math.sin(g.yaw));
    aprons.push({
      x: g.x, z: g.z,
      hx: (g.sx * c + g.sz * s) / 2 + 3.2,
      hz: (g.sx * s + g.sz * c) / 2 + 3.2,
    });
  }
  const inApron = (x: number, z: number): boolean => aprons.some(
    (a) => Math.abs(x - a.x) < a.hx + 1.2 && Math.abs(z - a.z) < a.hz + 1.2,
  );

  /** Floor-aware clearance plus the reserved aprons. */
  const clearAt = (x: number, z: number, hx: number, hz: number, y: number): boolean =>
    !inApron(x, z) && dressingSpotClear(def, x, z, hx, hz, y, y + 1.7, { crates: true, margin: 0.1 });

  const nearPoi = (x: number, z: number): boolean =>
    def.pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + poiRadius);

  // Pass 1 — road edges. Offset is measured from the centreline so objects sit
  // just outside the carriageway regardless of run width, and the yaw is
  // aligned to the run so clusters read as belonging to that street.
  for (const run of findRoadRuns(b)) {
    for (let i = 0; i < perRoad; i++) {
      if (emitted >= maxPieces) break;
      const t = ((i + 0.5) / perRoad) * (run.len - 1.2) - (run.len - 1.2) / 2;
      const side = rng.next() < 0.5 ? -1 : 1;
      const off = run.half + roadOffset[0] + rng.next() * (roadOffset[1] - roadOffset[0]);
      const c = Math.cos(run.yaw), s = Math.sin(run.yaw);
      const x = run.x + (-s) * side * off + c * t;
      const z = run.z + c * side * off + s * t;
      if (Math.abs(x) > def.size / 2 - 6 || Math.abs(z) > def.size / 2 - 6) continue;
      if (!clearAt(x, z, 1.4, 1.1, heightAt(x, z))) continue;
      place(x, z, run.yaw + (rng.next() - 0.5) * 0.5, 1 + Math.floor(rng.next() * 2));
    }
  }

  // Pass 2 — open terrain on a jittered grid, weighted up inside POI rings so
  // the gaps between landmarks are not the emptiest part of the map.
  const half = def.size / 2 - 10;
  for (let gx = -half; gx <= half; gx += spacing) {
    for (let gz = -half; gz <= half; gz += spacing) {
      if (emitted >= maxPieces) return emitted;
      const poi = nearPoi(gx, gz);
      const n = poi ? poiPerCell : perCell;
      for (let i = 0; i < n; i++) {
        if (emitted >= maxPieces) return emitted;
        const x = gx + (rng.next() - 0.5) * spacing * 0.8;
        const z = gz + (rng.next() - 0.5) * spacing * 0.8;
        if (Math.abs(x) > half || Math.abs(z) > half) continue;
        if (!clearAt(x, z, 1.5, 1.2, heightAt(x, z))) continue;
        place(x, z, rng.next() * Math.PI * 2, rng.next() < 0.3 ? 2 : 1);
      }
    }
  }
  return emitted;
}
