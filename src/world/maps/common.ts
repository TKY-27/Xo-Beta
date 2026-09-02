/**
 * Shared map construction helpers: terrain, generic buildings, interiors,
 * scatter props. Deterministic per-map seeds keep layouts stable.
 */

import { planStairs, WorldBuilder } from '../builder';
import { ROCK_CLEARANCE_RADIUS, type MatKey, type TerrainCutout } from '../types';
import { Rng } from '../../core/rng';

export interface BuildingOpts {
  x: number;
  z: number;
  /** World-space ground height at the building anchor. */
  baseY?: number;
  w: number;
  d: number;
  yaw?: number;
  floors?: number;
  floorHeight?: number;
  wallMat: MatKey;
  trimMat?: MatKey;
  floorMat?: MatKey;
  roofMat?: MatKey;
  /** Door gaps per side: [side(0:+z 1:+x 2:-z 3:-x), offset, width][] */
  doors?: Array<[0 | 1 | 2 | 3, number, number]>;
  windows?: boolean;
  roofAccess?: boolean;
  interiorDividers?: boolean;
  parapet?: boolean;
}

/**
 * Pick a stable construction pad for a building on sampled terrain.
 * Using only the centre point lets an uphill corner pierce the floor while a
 * downhill corner appears unsupported. The deep foundation handles the low
 * side; this highest-footprint sample keeps the finished floor above the high
 * side. A small clearance absorbs analytic-to-heightfield interpolation.
 */
export function structureBaseY(
  heightAt: (x: number, z: number) => number,
  x: number,
  z: number,
  width: number,
  depth: number,
): number {
  const sampleDivisions = 8;
  const halfW = width / 2 + 0.4;
  const halfD = depth / 2 + 0.4;
  let highest = -Infinity;
  for (let iz = 0; iz <= sampleDivisions; iz++) {
    for (let ix = 0; ix <= sampleDivisions; ix++) {
      const sx = x - halfW + (2 * halfW * ix) / sampleDivisions;
      const sz = z - halfD + (2 * halfD * iz) / sampleDivisions;
      highest = Math.max(highest, heightAt(sx, sz));
    }
  }
  return highest + 0.12;
}

/**
 * Generic enterable multi-floor building.
 * - Ground floor with door gaps, window sills
 * - Interior divider wall with doorway
 * - Stairwell to upper floors + optional roof access
 * - Registers walkable platforms for nav
 */
export function addBuilding(b: WorldBuilder, o: BuildingOpts): void {
  const fh = o.floorHeight ?? 3.6;
  const floors = o.floors ?? 1;
  const t = 0.4; // wall thickness
  const x = o.x, z = o.z;
  const baseY = o.baseY ?? 0;
  const hw = o.w / 2, hd = o.d / 2;
  const trim = o.trimMat ?? o.wallMat;
  const floorMat = o.floorMat ?? 'concreteDark';
  const roofMat = o.roofMat ?? trim;
  const requestedStairSteps = Math.ceil(fh / 0.55);
  const interiorStair = planStairs(requestedStairSteps, fh / requestedStairSteps, 0.62, 1.7);
  const hasInteriorStair = floors > 1 && interiorStair.run < o.d - 2;
  const stairX = x - hw + 1.4;
  // Leave a real standing-capsule landing behind the first tread. At 0.8 m
  // from the back wall, the stair builder's 0.55 m lower anchor sat only
  // 0.25 m from the wall centre and was necessarily embedded for a 0.42 m
  // radius actor. The disconnected flight was previously masked by false
  // long-distance jump edges across the room.
  const stairZ = z - hd + 1.55;
  const gapsOverlap = ([aStart, aWidth]: [number, number], [bStart, bWidth]: [number, number]): boolean =>
    aStart < bStart + bWidth && bStart < aStart + aWidth;
  const windowsWithoutDoorOverlap = (
    windows: Array<[number, number]>,
    doors: Array<[number, number]>,
  ): Array<[number, number]> => windows.filter((window) =>
    !doors.some((door) => gapsOverlap(window, door)));
  const navDoorway = (doorX: number, doorZ: number, tx: number, tz: number, y: number) => {
    const half = 0.05;
    for (const side of [-0.75, 0, 0.75]) {
      // Sample across the opening, not through the wall normal. The previous
      // anchors all shared one lateral coordinate, so path selection could
      // aim bots at a jamb even though the doorway centre itself was clear.
      const px = doorX + tx * side;
      const pz = doorZ + tz * side;
      b.platform(px - half, px + half, pz - half, pz + half, y);
    }
  };
  const addGroundFacadeWindow = (
    side: 1 | 2 | 3,
    offset: number,
    width: number,
    y0: number,
    sillH: number,
  ) => {
    const paneH = 1.42;
    const paneY = y0 + sillH + paneH / 2;
    const surfaceOffset = t / 2 + 0.025;
    if (side === 2) {
      const paneX = x - hw + offset + width / 2;
      const paneZ = z - hd - surfaceOffset;
      b.box(paneX, paneY, paneZ, width, paneH, 0.045, 'windowCool', 0, { noCollide: true });
      b.box(paneX, paneY, paneZ - 0.026, 0.075, paneH + 0.08, 0.055, trim, 0, { noCollide: true });
      b.box(paneX, paneY, paneZ - 0.026, width + 0.08, 0.075, 0.055, trim, 0, { noCollide: true });
    } else {
      const paneX = x + (side === 1 ? hw + surfaceOffset : -hw - surfaceOffset);
      const paneZ = z - hd + offset + width / 2;
      b.box(paneX, paneY, paneZ, 0.045, paneH, width, 'windowCool', 0, { noCollide: true });
      b.box(paneX + (side === 1 ? 0.026 : -0.026), paneY, paneZ, 0.055, paneH + 0.08, 0.075, trim, 0, { noCollide: true });
      b.box(paneX + (side === 1 ? 0.026 : -0.026), paneY, paneZ, 0.055, 0.075, width + 0.08, trim, 0, { noCollide: true });
    }
  };
  const addUpperWindowGlass = (
    side: 0 | 1 | 2 | 3,
    offset: number,
    width: number,
    y0: number,
    sillH: number,
  ) => {
    const paneH = Math.max(0.8, fh - sillH - 0.5);
    const paneY = y0 + sillH + paneH / 2;
    const inset = t / 2 + 0.045;
    if (side === 0 || side === 2) {
      const paneX = x - hw + offset + width / 2;
      const paneZ = z + (side === 0 ? hd - inset : -hd + inset);
      b.glassPane(paneX, paneY, paneZ, Math.max(0.08, width - 0.08), paneH, 'x');
      b.box(paneX, paneY, paneZ + (side === 0 ? 0.022 : -0.022), 0.055, paneH, 0.045, trim, 0, { noCollide: true });
    } else {
      const paneX = x + (side === 1 ? hw - inset : -hw + inset);
      const paneZ = z - hd + offset + width / 2;
      b.glassPane(paneX, paneY, paneZ, Math.max(0.08, width - 0.08), paneH, 'z');
      b.box(paneX + (side === 1 ? 0.022 : -0.022), paneY, paneZ, 0.045, paneH, 0.055, trim, 0, { noCollide: true });
    }
  };

  // Foundation slab — extends deep below grade so buildings on sloping
  // terrain (eden/oldfront heightfields) never show a floating downhill edge;
  // buried portion reads as a plinth.
  b.slab(x, baseY + 0.08, z, o.w + 0.8, o.d + 0.8, 2.2, trim);

  for (let f = 0; f < floors; f++) {
    const y0 = baseY + f * fh;

    // Floor slab (skip ground — foundation serves)
    if (f > 0) {
      const stairHole = {
        minX: stairX - interiorStair.width / 2 - 0.28,
        maxX: stairX + interiorStair.width / 2 + 0.28,
        minZ: stairZ - 0.18,
        maxZ: stairZ + interiorStair.run + 0.35,
      };
      if (hasInteriorStair) {
        slabWithHole(b, x, y0 + 0.18, z, o.w, o.d, 0.35, floorMat, stairHole);
        slabWithHole(b, x, y0 - 0.18, z, o.w - 0.5, o.d - 0.5, 0.04, 'interiorCeiling', stairHole, {
          noCollide: true,
        });
      } else {
        b.slab(x, y0 + 0.18, z, o.w, o.d, 0.35, floorMat);
        b.box(x, y0 - 0.2, z, o.w - 0.5, 0.04, o.d - 0.5, 'interiorCeiling', 0, {
          noCollide: true,
        });
      }
    }

    const sillH = f === 0 ? 1.1 : 0.9;

    // Walls with gaps: sides 0:+z(front) 1:+x(right) 2:-z(back) 3:-x(left)
    const frontDoors = (o.doors ?? []).filter((dd) => dd[0] === 0).map((dd) => [dd[1], dd[2]] as [number, number]);
    const backDoors = (o.doors ?? []).filter((dd) => dd[0] === 2).map((dd) => [dd[1], dd[2]] as [number, number]);
    const rightDoors = (o.doors ?? []).filter((dd) => dd[0] === 1).map((dd) => [dd[1], dd[2]] as [number, number]);
    const leftDoors = (o.doors ?? []).filter((dd) => dd[0] === 3).map((dd) => [dd[1], dd[2]] as [number, number]);
    const windowGapsFront: Array<[number, number]> = [];
    const windowGapsBack: Array<[number, number]> = [];
    const step = Math.max(3, o.w / 4);
    for (let wx = step / 2; wx < o.w - 0.5; wx += step) {
      windowGapsFront.push([wx, 1.4]);
      windowGapsBack.push([wx, 1.4]);
    }
    const windowGapsRight: Array<[number, number]> = [];
    const windowGapsLeft: Array<[number, number]> = [];
    const stepD = Math.max(3, o.d / 4);
    for (let wz = stepD / 2; wz < o.d - 0.5; wz += stepD) {
      windowGapsRight.push([wz, 1.4]);
      windowGapsLeft.push([wz, 1.4]);
    }
    const groundWindowGapsFront: Array<[number, number]> = [
      [o.w * 0.28 - 0.75, 1.5],
      [o.w * 0.72 - 0.75, 1.5],
    ];
    if (f === 0) {
      // Ground-floor glazing must be a real opening. Previously the opaque
      // front wall and glass pane occupied the same depth, causing
      // z-fighting and flickering highlights. Keep the sill as wall geometry,
      // then place glass just inside the opening below.
      b.wallWithGaps(x - hw, z + hd, o.w, fh, t, 'x', o.wallMat,
        o.windows === false ? frontDoors : [...frontDoors, ...groundWindowGapsFront],
        o.windows === false ? 0 : sillH, y0,
        o.windows === false ? undefined : windowsWithoutDoorOverlap(groundWindowGapsFront, frontDoors));
      b.wallWithGaps(x - hw, z - hd, o.w, fh, t, 'x', o.wallMat, backDoors, 0, y0);
      b.wallWithGaps(x + hw, z - hd, o.d, fh, t, 'z', o.wallMat, rightDoors, 0, y0);
      b.wallWithGaps(x - hw, z - hd, o.d, fh, t, 'z', o.wallMat, leftDoors, 0, y0);
      if (o.windows !== false) {
        // Ground-floor side and rear walls remain structurally solid to avoid
        // changing indoor collision/nav, but receive shallow, non-colliding
        // glazing and mullions. This removes the repeated blank-box facade
        // without implying a new traversable opening.
        for (const [offset, width] of windowsWithoutDoorOverlap(groundWindowGapsFront, backDoors)) {
          addGroundFacadeWindow(2, offset, width, y0, sillH);
        }
        const sideWindows: Array<[number, number]> = [
          [o.d * 0.28 - 0.75, 1.5],
          [o.d * 0.72 - 0.75, 1.5],
        ];
        for (const [offset, width] of windowsWithoutDoorOverlap(sideWindows, rightDoors)) {
          addGroundFacadeWindow(1, offset, width, y0, sillH);
        }
        for (const [offset, width] of windowsWithoutDoorOverlap(sideWindows, leftDoors)) {
          addGroundFacadeWindow(3, offset, width, y0, sillH);
        }
      }
      const floorY = y0 + 0.08;
      for (const [side, offset, width] of o.doors ?? []) {
        if (side === 0) navDoorway(x - hw + offset + width / 2, z + hd, 1, 0, floorY);
        else if (side === 2) navDoorway(x - hw + offset + width / 2, z - hd, 1, 0, floorY);
        else if (side === 1) navDoorway(x + hw, z - hd + offset + width / 2, 0, 1, floorY);
        else navDoorway(x - hw, z - hd + offset + width / 2, 0, 1, floorY);
      }
    } else {
      // Upper floors: windows (sill gaps) all around
      b.wallWithGaps(x - hw, z + hd, o.w, fh, t, 'x', o.wallMat,
        windowGapsFront, sillH, y0, windowGapsFront);
      b.wallWithGaps(x - hw, z - hd, o.w, fh, t, 'x', o.wallMat,
        windowGapsBack, sillH, y0, windowGapsBack);
      b.wallWithGaps(x + hw, z - hd, o.d, fh, t, 'z', o.wallMat,
        windowGapsRight, sillH, y0, windowGapsRight);
      b.wallWithGaps(x - hw, z - hd, o.d, fh, t, 'z', o.wallMat,
        windowGapsLeft, sillH, y0, windowGapsLeft);
      if (o.windows !== false) {
        for (const [offset, width] of windowGapsFront) {
          addUpperWindowGlass(0, offset, width, y0, sillH);
        }
        for (const [offset, width] of windowGapsBack) {
          addUpperWindowGlass(2, offset, width, y0, sillH);
        }
        for (const [offset, width] of windowGapsRight) {
          addUpperWindowGlass(1, offset, width, y0, sillH);
        }
        for (const [offset, width] of windowGapsLeft) {
          addUpperWindowGlass(3, offset, width, y0, sillH);
        }
      }
    }

    // Interior divider with doorway (alternating orientation per floor)
    if (o.interiorDividers !== false && o.w > 9 && o.d > 9) {
      const divOffset = f % 2 === 0 ? o.w * 0.33 : o.w * 0.66;
      const gapStart = o.d * 0.42;
      if (f % 2 === 0) {
        b.wallWithGaps(x - hw + divOffset, z - hd + t, o.d - t * 2, fh, 0.3, 'z', trim, [[gapStart, 1.6]], 0, y0);
        navDoorway(
          x - hw + divOffset,
          z - hd + t + gapStart + 0.8,
          1,
          0,
          y0 + (f > 0 ? 0.18 : 0.08),
        );
      } else {
        // The odd-floor divider runs straight across the stairwell. Without a
        // passage it formed a 3.6 m wall crossing the flight at mid-height:
        // real KCC ascent stalled against it and descent from the floor above
        // was impossible. Give the stairwell a full-height opening that clears
        // the whole flight width.
        const stairGapEnd = hasInteriorStair
          ? (stairX + interiorStair.width / 2 + 0.12) - (x - hw + t)
          : 0;
        b.wallWithGaps(x - hw + t, z - hd + divOffset, o.w - t * 2, fh, 0.3, 'x', trim,
          [[gapStart, 1.6], [0, Math.max(0, stairGapEnd)]], 0, y0);
        navDoorway(
          x - hw + t + gapStart + 0.8,
          z - hd + divOffset,
          0,
          1,
          y0 + (f > 0 ? 0.18 : 0.08),
        );
      }
    }

    // Stairs to next level (stairwell against back-left corner)
    if (f < floors - 1 && hasInteriorStair) {
      b.stairs(stairX, y0 + (f > 0 ? 0.18 : 0.08), stairZ, 0,
        interiorStair.steps, interiorStair.stepH, interiorStair.stepD, interiorStair.width, 'concreteDark');
    }
  }

  // Roof
  const roofY = baseY + floors * fh + 0.2;
  b.slab(x, roofY, z, o.w + 0.5, o.d + 0.5, 0.35, roofMat);
  // The exterior roof material used to remain visible on its underside,
  // giving occupied rooms a black repeated tile/grid instead of an interior
  // ceiling. Keep the physical roof untouched and add an inset finish with
  // shallow non-colliding beams for indoor scale and material separation.
  // roofY is the slab's top surface (WorldBuilder.slab), not its centre.
  // Place the finish below the 0.35 m roof volume with a small separation;
  // the previous centre-style offset embedded both finish and beams inside
  // the roof and left the exterior roof texture visible from the room.
  const ceilingY = roofY - 0.38;
  b.box(x, ceilingY, z, Math.max(1, o.w - 0.5), 0.04, Math.max(1, o.d - 0.5), 'interiorCeiling', 0, {
    noCollide: true,
  });
  if (o.w >= 8 && o.d >= 8) {
    const beamY = roofY - 0.47;
    const beamCount = Math.max(2, Math.min(5, Math.round(o.d / 3.8)));
    for (let i = 1; i <= beamCount; i++) {
      const bz = z - hd + (o.d * i) / (beamCount + 1);
      b.box(x, beamY, bz, o.w - 0.65, 0.12, 0.14, trim, 0, { noCollide: true });
    }
  }
  if (o.parapet !== false) {
    const ph = 0.8;
    b.box(x, roofY + ph / 2, z + hd + 0.25, o.w + 0.5, ph, 0.25, trim);
    b.box(x, roofY + ph / 2, z - hd - 0.25, o.w + 0.5, ph, 0.25, trim);
    b.box(x + hw + 0.25, roofY + ph / 2, z, 0.25, ph, o.d + 0.5, trim);
    if (!o.roofAccess) {
      // Left parapet is handled by the exterior-stair block when present.
      b.box(x - hw - 0.25, roofY + ph / 2, z, 0.25, ph, o.d + 0.5, trim);
    }
    b.platform(x - hw - 0.4, x + hw + 0.4, z - hd - 0.4, z + hd + 0.4, roofY);
  }

  // Exterior access staircase to the roof (along the left wall)
  if (o.roofAccess) {
    // structureBaseY levels the building to its highest footprint sample;
    // exterior stair posts can stand on the downhill side. Give every visible
    // support a common embedded footing instead of stopping at that level pad.
    const fireEscapeFoundationDepth = 1.6;
    const fireEscapeFoundationY = baseY - fireEscapeFoundationDepth;
    const ph = o.parapet === false ? 0 : 0.8;
    const totalRise = roofY - baseY;
    const steps = Math.ceil(totalRise / 0.52);
    const stepH = totalRise / steps;
    const stair = planStairs(steps, stepH, 0.64, 1.9);
    // Fit every flight between the building's front/back edges. Tall or
    // shallow buildings use switchbacks instead of letting a single run end
    // in empty space far beyond the roof.
    const frontZ = z + hd - 1.8;
    const usableRun = Math.max(3.2, o.d - 3.6);
    const maxStepsPerFlight = Math.max(3, Math.floor(usableRun / stair.stepD));
    const flightCount = Math.ceil(stair.steps / maxStepsPerFlight);
    const innerStairX = x - hw - stair.width / 2 - 0.35;
    const outerStairX = innerStairX - stair.width - 0.55;
    const landingCenterX = (innerStairX + outerStairX) / 2;
    const landingWidth = innerStairX - outerStairX + stair.width + 0.4;
    // A real bottom landing gives the stair sampler a capsule-clear node that
    // connects to the surrounding ground grid instead of an isolated point
    // trapped between the first riser and the fire-escape posts. It extends
    // 0.4 m under the first tread: a slab edge exactly at the riser line left
    // the approaching capsule half-supported there and its autostep never
    // completed.
    b.slab(outerStairX, baseY + 0.04, frontZ + 0.8, stair.width + 0.5, 2.4, 0.2, 'metalExterior');
    let remainingSteps = stair.steps;
    let currentY = baseY;
    let currentZ = frontZ;
    let topStairX = outerStairX;
    for (let flight = 0; flight < flightCount; flight++) {
      const flightsLeft = flightCount - flight;
      const flightSteps = Math.ceil(remainingSteps / flightsLeft);
      const dir = flight % 2 === 0 ? 2 : 0;
      const flightX = flight % 2 === 0 ? outerStairX : innerStairX;
      topStairX = flightX;
      const flightPlan = b.stairs(
        flightX,
        currentY,
        currentZ,
        dir,
        flightSteps,
        stair.stepH,
        stair.stepD,
        stair.width,
        'metalExterior',
      );
      const railSide = flight % 2 === 0 ? -1 : 1;
      const railX = flightX + railSide * (stair.width / 2 + 0.055);
      const travelSign = dir === 0 ? 1 : -1;
      const railPostSteps = new Set<number>();
      for (let step = 0; step <= flightSteps; step += 3) railPostSteps.add(step);
      railPostSteps.add(flightSteps);
      for (const step of [...railPostSteps].sort((a, b2) => a - b2)) {
        const railZ = currentZ + travelSign * step * stair.stepD;
        const railY = currentY + step * stair.stepH + 0.58;
        b.box(railX, railY, railZ, 0.085, 1.05, 0.085, 'metalExterior', 0, { noCollide: true });
      }
      // One true sloped handrail joins the posts. Horizontal per-step bars
      // read as detached floating strips at close range.
      const railRise = flightSteps * stair.stepH;
      const railRun = flightSteps * stair.stepD;
      b.box(
        railX,
        currentY + railRise / 2 + 1.1,
        currentZ + travelSign * railRun / 2,
        0.09,
        0.09,
        Math.hypot(railRun, railRise) + 0.08,
        'metalExterior',
        0,
        {
          noCollide: true,
          pitch: -travelSign * Math.atan2(railRise, railRun),
        },
      );
      // Continuous guard envelope behind the visible rail line: the
      // presentation-only posts and handrail now actually stop a capsule.
      b.guardRail(
        { x: railX, z: currentZ },
        { x: railX, z: currentZ + travelSign * railRun },
        currentY - 0.15,
        currentY + railRise + 1.2,
      );
      currentZ += (dir === 0 ? 1 : -1) * flightPlan.run;
      currentY += flightPlan.totalRise;
      remainingSteps -= flightSteps;
      if (flight < flightCount - 1) {
        // Bias the switchback landing FORWARD along the arrival direction. A
        // slab centred on the flight boundary hung 1.2 m back over the last
        // treads with only ~0.15 m of headroom, and real KCC ascent stalled
        // against its edge one riser below every switchback.
        const arriveSign = dir === 0 ? 1 : -1;
        const landingNear = currentZ - arriveSign * 0.25;
        const landingFar = currentZ + arriveSign * 2.15;
        b.slab(
          landingCenterX,
          currentY + 0.05,
          (landingNear + landingFar) / 2,
          landingWidth,
          Math.abs(landingFar - landingNear),
          0.25,
          'metalExterior',
        );
        // The switchback opens toward the next flight. Guard the far edge so
        // the rail alternates with the stair direction.
        const guardedZ = landingFar - arriveSign * 0.2;
        b.box(landingCenterX, currentY + 1.05, guardedZ, landingWidth, 0.09, 0.09, 'metalExterior', 0, { noCollide: true });
        for (const landingX of [landingCenterX - landingWidth / 2 + 0.08, landingCenterX + landingWidth / 2 - 0.08]) {
          b.box(landingX, currentY + 0.55, guardedZ, 0.085, 1.05, 0.085, 'metalExterior', 0, { noCollide: true });
        }
        b.guardRail(
          { x: landingCenterX - landingWidth / 2, z: guardedZ },
          { x: landingCenterX + landingWidth / 2, z: guardedZ },
          currentY - 0.1,
          currentY + 1.12,
        );
        const supportHeight = currentY - fireEscapeFoundationY;
        if (supportHeight > 0.4) {
          b.box(outerStairX, fireEscapeFoundationY + supportHeight / 2, currentZ, 0.14, supportHeight, 0.14, 'metalExterior', 0, { noCollide: true });
        }
      }
    }
    const zLand = currentZ;
    // Top landing bridges the wall gap and physically overlaps the roof edge.
    // It is biased forward along the arriving flight's direction (like the
    // switchback landings): a centred bridge hung 1.3 m back over the top
    // treads with ~0.15 m of headroom and blocked the last steps of every
    // fire escape.
    const arriveSign = (flightCount - 1) % 2 === 0 ? -1 : 1;
    const bridgeLo = arriveSign === 1
      ? zLand - 0.25
      : Math.max(zLand - 2.35, z - hd - 0.25);
    const bridgeHi = arriveSign === 1
      ? Math.min(zLand + 2.35, z + hd + 0.25)
      : zLand + 0.25;
    const roofLandingInnerEdge = x - hw + 0.25;
    const roofLandingOuterEdge = topStairX - stair.width / 2 - 0.2;
    b.slab(
      (roofLandingInnerEdge + roofLandingOuterEdge) / 2,
      roofY + 0.05,
      (bridgeLo + bridgeHi) / 2,
      roofLandingInnerEdge - roofLandingOuterEdge,
      Math.abs(bridgeHi - bridgeLo),
      0.25,
      'metalExterior',
    );
    // Guard and support the exposed outer edge of the roof bridge. These are
    // visual-only so the authored traversal width remains unchanged.
    b.box(
      roofLandingOuterEdge,
      roofY + 1.05,
      (bridgeLo + bridgeHi) / 2,
      0.09,
      0.09,
      Math.abs(bridgeHi - bridgeLo),
      'metalExterior',
      0,
      { noCollide: true },
    );
    for (const postZ of [bridgeLo + 0.2, (bridgeLo + bridgeHi) / 2, bridgeHi - 0.2]) {
      b.box(roofLandingOuterEdge, roofY + 0.55, postZ, 0.085, 1.05, 0.085, 'metalExterior', 0, { noCollide: true });
    }
    b.guardRail(
      { x: roofLandingOuterEdge, z: bridgeLo },
      { x: roofLandingOuterEdge, z: bridgeHi },
      roofY - 0.1,
      roofY + 1.15,
    );
    const topSupportHeight = roofY - fireEscapeFoundationY;
    b.box(
      roofLandingOuterEdge,
      fireEscapeFoundationY + topSupportHeight / 2,
      zLand,
      0.14,
      topSupportHeight,
      0.14,
      'metalExterior',
      0,
      { noCollide: true },
    );
    if (ph > 0) {
      b.wallWithGaps(x - hw - 0.25, z - hd - 0.25, o.d + 0.5, ph, 0.25, 'z', trim,
        [[Math.max(0, zLand - 1.5 - (z - hd - 0.25)), 3]], 0, roofY);
    }
    // Exterior fire-escape posts make every landing visibly supported.
    const postHeight = totalRise + fireEscapeFoundationDepth;
    for (const postZ of [frontZ, z - hd + 1.8]) {
      b.box(outerStairX - stair.width / 2, fireEscapeFoundationY + postHeight / 2, postZ, 0.18, postHeight, 0.18, 'metalExterior');
      b.box(innerStairX + stair.width / 2, fireEscapeFoundationY + postHeight / 2, postZ, 0.18, postHeight, 0.18, 'metalExterior');
    }
  }

  // Roof access hatch gap: leave a hole by splitting roof when requested
  if (o.roofAccess) {
    // simple approach: low parapet opening on back side (climb over)
    // (stairs already reach top floor; final hop is a mantle link)
  }

  // Windows glass on ground floor front
  if (o.windows !== false) {
    const gy = baseY + 1.1 + (fh - 1.1) / 2;
    const frontDoors = (o.doors ?? [])
      .filter((door) => door[0] === 0)
      .map((door) => [door[1], door[2]] as [number, number]);
    for (let i = 0; i < 2; i++) {
      const windowGap: [number, number] = [o.w * (0.28 + i * 0.44) - 0.75, 1.5];
      if (frontDoors.some((door) => gapsOverlap(windowGap, door))) continue;
      const wx = x - hw + o.w * (0.28 + i * 0.44);
      b.glassPane(wx, gy, z + hd - t / 2 - 0.08, 1.5, fh - 1.6, 'x');
    }
  }

  // Interior loot anchors
  const rng = new Rng(hashOf(o.x, o.z));
  b.loot(x + rng.range(-hw * 0.5, hw * 0.5), baseY + 0.35, z + rng.range(-hd * 0.5, hd * 0.5));
  if (floors > 1) {
    b.loot(x + rng.range(-hw * 0.4, hw * 0.4), baseY + fh + 0.55, z + rng.range(-hd * 0.4, hd * 0.4));
  }
}

export function slabWithHole(
  b: WorldBuilder,
  x: number,
  yTop: number,
  z: number,
  width: number,
  depth: number,
  thickness: number,
  mat: MatKey,
  hole: { minX: number; maxX: number; minZ: number; maxZ: number },
  opts?: { noCollide?: boolean },
): void {
  const minX = x - width / 2;
  const maxX = x + width / 2;
  const minZ = z - depth / 2;
  const maxZ = z + depth / 2;
  const hx0 = Math.max(minX, Math.min(maxX, hole.minX));
  const hx1 = Math.max(hx0, Math.min(maxX, hole.maxX));
  const hz0 = Math.max(minZ, Math.min(maxZ, hole.minZ));
  const hz1 = Math.max(hz0, Math.min(maxZ, hole.maxZ));
  const add = (x0: number, x1: number, z0: number, z1: number) => {
    if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
    if (opts?.noCollide) {
      b.box(
        (x0 + x1) / 2,
        yTop - thickness / 2,
        (z0 + z1) / 2,
        x1 - x0,
        thickness,
        z1 - z0,
        mat,
        0,
        { noCollide: true },
      );
    } else {
      b.slab((x0 + x1) / 2, yTop, (z0 + z1) / 2, x1 - x0, z1 - z0, thickness, mat);
    }
  };
  add(minX, hx0, minZ, maxZ);
  add(hx1, maxX, minZ, maxZ);
  add(hx0, hx1, minZ, hz0);
  add(hx0, hx1, hz1, maxZ);
}

function hashOf(x: number, z: number): number {
  return ((x * 73856093) ^ (z * 19349663)) >>> 0;
}

/** Flat ground plane with walkable platform registration. */
export function addGround(
  b: WorldBuilder,
  size: number,
  mat: MatKey,
  y = 0,
  registerPlatform = true,
  cutouts: TerrainCutout[] = [],
): void {
  if (cutouts.length === 0) {
    b.box(0, y - 1, 0, size + 200, 2, size + 200, mat, 0, { terrain: true });
    if (registerPlatform) b.platform(-size / 2, size / 2, -size / 2, size / 2, y);
    return;
  }
  for (const cutout of cutouts) b.terrainCutout(cutout);
  const half = (size + 200) / 2;
  const uniqueSorted = (values: number[]) => [...new Set(values)]
    .filter((value) => value >= -half && value <= half)
    .sort((a, b) => a - b);
  const xs = uniqueSorted([-half, ...cutouts.flatMap((hole) => [hole.minX, hole.maxX]), half]);
  const zs = uniqueSorted([-half, ...cutouts.flatMap((hole) => [hole.minZ, hole.maxZ]), half]);
  for (let xi = 0; xi < xs.length - 1; xi++) {
    for (let zi = 0; zi < zs.length - 1; zi++) {
      const minX = xs[xi]!;
      const maxX = xs[xi + 1]!;
      const minZ = zs[zi]!;
      const maxZ = zs[zi + 1]!;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      if (cutouts.some((hole) => cx >= hole.minX && cx <= hole.maxX && cz >= hole.minZ && cz <= hole.maxZ)) continue;
      b.box(cx, y - 1, cz, maxX - minX, 2, maxZ - minZ, mat, 0, { terrain: true });
    }
  }
  if (registerPlatform) b.platform(-size / 2, size / 2, -size / 2, size / 2, y);
}

/** Scatter trees avoiding building rectangles (simple min-distance check). */
export function scatterTrees(
  b: WorldBuilder, rng: Rng, count: number,
  area: { minX: number; maxX: number; minZ: number; maxZ: number },
  variant: 'pine' | 'oak' | 'palm' | 'dead',
  avoid: Array<{ x: number; z: number; r: number }> = [],
  heightAt?: (x: number, z: number) => number,
): void {
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts++ < count * 12) {
    const x = rng.range(area.minX, area.maxX);
    const z = rng.range(area.minZ, area.maxZ);
    if (avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
    const y = heightAt ? heightAt(x, z) : 0;
    if (b.tree({ x, z, y, scale: rng.range(0.8, 1.5), variant })) placed++;
  }
}

export function scatterRocks(
  b: WorldBuilder, rng: Rng, count: number,
  area: { minX: number; maxX: number; minZ: number; maxZ: number },
  avoid: Array<{ x: number; z: number; r: number }> = [],
  heightAt?: (x: number, z: number) => number,
): void {
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts++ < count * 20) {
    const x = rng.range(area.minX, area.maxX);
    const z = rng.range(area.minZ, area.maxZ);
    const scale = rng.range(0.6, 2.4);
    const radius = ROCK_CLEARANCE_RADIUS * scale;
    if (avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r + radius)) continue;
    if (b.def.rocks.some((rock) => (
      Math.hypot(rock.x - x, rock.z - z)
        < (ROCK_CLEARANCE_RADIUS * rock.scale + radius) * 0.82
    ))) continue;
    b.rock(x, z, heightAt ? heightAt(x, z) : 0, scale);
    placed++;
  }
}
