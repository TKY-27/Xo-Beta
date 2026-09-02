/**
 * Measured collider profiles for the licensed Quaternius rock variants.
 * Generated from scripts/measure-rock-profiles.mjs against the source GLTF
 * POSITION accessors (see qa/v04-qa-plan.md); hand-tuned to satisfy the
 * bounds documented below.
 *
 * Provenance (scripts/measure-rock-profiles.mjs, GLTF node transforms applied,
 * bottom-normalised frame, metres at source scale 1):
 *
 *   medium-1  public/assets/models/nature/Rock_Medium_1.gltf
 *     351 vertices, source AABB x[-1.7273, 1.4979] y[-0.2711, 1.9887]
 *     z[-1.1499, 1.8393]; normalised height 2.2598; footprint radius
 *     (max sqrt(x*x+z*z) from the mesh origin) 1.8557.
 *   medium-2  public/assets/models/nature/Rock_Medium_2.gltf
 *     249 vertices, source AABB x[-1.7136, 1.3351] y[-0.0508, 1.8481]
 *     z[-1.1591, 1.3199]; normalised height 1.8990; footprint radius 1.8763.
 *
 * Per-slice radii (16 equal horizontal slices between the source bottom and
 * top; max sqrt(x*x+z*z) from the vertical axis at (0,0) over each slice):
 *
 *   medium-1: y0.0706 r1.1757 | y0.2119 r1.5932 | y0.3531 r1.8237
 *             y0.4943 r1.8557 | y0.6356 r1.8070 | y0.7768 r1.7476
 *             y0.9180 r1.6887 | y1.0593 r1.6643 | y1.2005 r1.6808
 *             y1.3418 r1.2235 | y1.4830 r1.2818 | y1.6242 r1.4337
 *             y1.7655 r1.3184 | y1.9067 r1.5742 | y2.0479 r1.5230
 *             y2.1892 r1.2124
 *   medium-2: y0.0593 r1.8763 | y0.1780 r1.4383 | y0.2967 r1.5133
 *             y0.4154 r1.5244 | y0.5341 r1.5733 | y0.6528 r1.7197
 *             y0.7715 r1.6413 | y0.8902 r1.5503 | y1.0088 r1.4782
 *             y1.1275 r1.6387 | y1.2462 r1.3062 | y1.3649 r1.4627
 *             y1.4836 r1.4480 | y1.6023 r1.3365 | y1.7210 r1.1463
 *             y1.8397 r1.0433
 *
 * Frame conventions (matching the renderer):
 *   - The horizontal origin (0,0) is the mesh origin; the render composes
 *     each rock instance at its authored (x, z), so all radii and box
 *     centres are measured from (0,0), not from the AABB centre.
 *   - Box `y` is measured from the source mesh bottom (the prop loader
 *     normalises both source bottoms to y=0; see extractGeometries in
 *     src/render/props.ts and the baseOffset comment in
 *     src/render/worldView.ts). The render additionally buries each rock by
 *     0.22 * scale, so the lowest ~0.22 of this profile sits underground.
 *   - `yaw` is a right-handed rotation about +Y in radians, the same
 *     convention as GeoSpec yaw / phys.addStaticBox. No pitch or roll.
 *
 * Acceptance contract (verified by tests/unit/rock-profiles.test.ts, which
 * re-measures the GLTF vertex clouds): at each of the 16 fine slice mid
 * heights above, the profile boxes' horizontal radius (max corner distance
 * from the vertical axis over boxes covering that height) must not exceed
 * the measured mesh radius by more than 0.12 m (no invisible corners) and
 * must not undershoot it by more than 0.35 m (no walk-through visible mass).
 * Tuned worst-case margins: medium-1 overshoot 0.0951 / undershoot 0.3266;
 * medium-2 overshoot 0.0980 / undershoot 0.3214.
 *
 * Shape notes:
 *   - Both rocks are lumpy with lobes, not stepped cones; the widest lobes
 *     lean toward +z (medium-1 also has a secondary -x lobe). Boxes are
 *     yawed/offset so their farthest corners sit on the measured lobes.
 *   - medium-1's crown (y > ~1.28) overhangs: the mesh has no mass at z < 0
 *     up there, so the crown slab's leeward corners intentionally poke into
 *     empty air within the +0.12 overshoot budget; the alternative (a fourth
 *     box) was rejected to keep the 2-3 box budget.
 *   - The base slabs are fully underground after the render's 0.22 burial;
 *     they exist to satisfy the bottom-band contract and ground the stack.
 *   - When wiring these into buildColliders, scale x/z/hx/hz by the rock's
 *     render x/z factors (s * 1.12 / s * 1.04) or accept the ~8% miss, scale
 *     y/hy by the render height variation, and add the -0.22 * scale burial
 *     offset to the box centres' world y.
 */

export type RockVariant = 'medium-1' | 'medium-2';

export interface RockColliderBox {
  /** Local centre offset from the rock origin (x/z) and source bottom (y). */
  x: number; y: number; z: number;
  /** Full extents divided by two (half extents), unscaled source units. */
  hx: number; hy: number; hz: number;
  /** Yaw rotation about the local vertical axis (radians). */
  yaw: number;
}

export interface RockColliderProfile {
  variant: RockVariant;
  boxes: RockColliderBox[];
  /** Max horizontal distance from the origin over all boxes (unscaled). */
  footprintRadius: number;
  /** Max y over all boxes above the source bottom (unscaled). */
  height: number;
}

export const ROCK_COLLIDER_PROFILES: Record<RockVariant, RockColliderProfile> = {
  'medium-1': {
    variant: 'medium-1',
    // Buried base slab (bottom rim, corner radius 1.0542), yawed mid mass
    // (corners on the +z / -x lobes, radius 1.5562) and yawed crown slab
    // (corners on the +z crown lobe, radius 1.2476).
    boxes: [
      { x: 0, y: 0.07, z: 0, hx: 0.83, hy: 0.07, hz: 0.65, yaw: 0 },
      { x: -0.085, y: 0.71, z: 0.085, hx: 0.835, hy: 0.57, hz: 1.193, yaw: -0.7854 },
      { x: -0.125, y: 1.7699, z: 0.2165, hx: 0.345, hy: 0.4899, hz: 0.949, yaw: -0.5236 },
    ],
    footprintRadius: 1.556194,
    height: 2.2598,
  },
  'medium-2': {
    variant: 'medium-2',
    // Buried base slab biased to the big -x bottom lobe (corner radius
    // 1.9379), axis-aligned mid block (corners on the -x lobe, radius
    // 1.4648) and slimmer top block (radius 1.1413).
    boxes: [
      { x: -0.24, y: 0.06, z: -0.1, hx: 1.16, hy: 0.06, hz: 1.24, yaw: 0 },
      { x: 0, y: 0.65, z: 0, hx: 1.2, hy: 0.53, hz: 0.84, yaw: 0 },
      { x: 0, y: 1.5395, z: 0, hx: 1.04, hy: 0.3595, hz: 0.47, yaw: 0 },
    ],
    footprintRadius: 1.937937,
    height: 1.899,
  },
};

export function rockColliderProfile(variant: RockVariant): RockColliderProfile {
  return ROCK_COLLIDER_PROFILES[variant];
}
