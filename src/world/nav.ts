/**
 * Navigation: builds a multi-level nav graph from map platform records +
 * physics validation, then serves A* pathfinding with traversal-aware edges.
 *
 * Edge types map to bot movement commands:
 *  walk  — plain locomotion
 *  jump  — gap crossing (bot jumps)
 *  mantle— ledge climb (bot mantles toward next waypoint)
 *  drop  — controlled fall
 *  swim  — water traversal
 *  shore — leave water while surfacing toward dry support
 */

import type { MapDef } from './types';
import { CAPSULE_CENTER_OFFSET, GROUPS, type PhysicsWorld } from '../physics/physics';
import { MOVE } from '../core/balance';
import { Rng } from '../core/rng';

export type NavEdgeType = 'walk' | 'jump' | 'mantle' | 'drop' | 'swim' | 'shore';

export interface NavEdge {
  to: number;
  cost: number;
  type: NavEdgeType;
}

export interface NavNode {
  id: number;
  x: number;
  y: number;
  z: number;
  water: boolean;
  edges: NavEdge[];
}

export interface NavPath {
  nodes: number[];
  points: Array<{ x: number; y: number; z: number }>;
  /** Edge type used to arrive at points[i] (points[0] type is 'walk'). */
  entryTypes: NavEdgeType[];
}

function sampleAxis(min: number, max: number, spacing: number): number[] {
  const length = max - min;
  if (length <= spacing) return [(min + max) / 2];
  const out: number[] = [];
  for (let value = min + spacing / 2; value <= max - spacing / 2 + 0.01; value += spacing) {
    out.push(value);
  }
  return out.length > 0 ? out : [(min + max) / 2];
}

export class NavGraph {
  nodes: NavNode[] = [];
  private cellSize = 8;
  private grid = new Map<number, number[]>();

  private key(cx: number, cz: number): number {
    return (cx + 4096) * 16384 + (cz + 4096);
  }

  private addToGrid(node: NavNode): void {
    const cx = Math.floor(node.x / this.cellSize);
    const cz = Math.floor(node.z / this.cellSize);
    const k = this.key(cx, cz);
    let arr = this.grid.get(k);
    if (!arr) {
      arr = [];
      this.grid.set(k, arr);
    }
    arr.push(node.id);
  }

  build(def: MapDef, phys: PhysicsWorld): void {
    this.physRef = phys;
    // 1) Sample candidate points on every platform rect.
    for (const plat of def.platforms) {
      const w = plat.maxX - plat.minX;
      const d = plat.maxZ - plat.minZ;
      const area = w * d;
      const spacing = area > 400 ? 6 : area > 80 ? 4 : 3;
      if (plat.water) {
        // coarser sampling for open water
        const ws = Math.max(spacing, 8);
        for (let x = plat.minX + ws / 2; x < plat.maxX; x += ws) {
          for (let z = plat.minZ + ws / 2; z < plat.maxZ; z += ws) {
            // Water platforms can overlap piers, foundations and boathouses.
            // Use the swimming body centre at the authored surface layer and
            // omit nodes whose full capsule already occupies scenery. A
            // one-sided heightfield does not report a capsule placed beneath
            // its top surface as overlapping, so prove that the lake bed is
            // also below the swimmer's capsule bottom.
            if (!phys.findClearSwimmingPlacement(x, plat.y, z)) continue;
            this.addNode(x, plat.y, z, true);
          }
        }
        continue;
      }
      // Narrow authored platforms (especially 0.62-unit stair treads) used to
      // produce zero candidates because the generic spacing exceeded both
      // dimensions. Always publish at least the platform centre on each axis.
      for (const x of sampleAxis(plat.minX, plat.maxX, spacing)) {
        for (const z of sampleAxis(plat.minZ, plat.maxZ, spacing)) {
          const supportY = this.validatePoint(phys, x, plat.y, z);
          if (supportY === null) continue;
          this.addNode(x, supportY, z, false);
        }
      }
    }

    // 1b) Outdoor terrain sampling when the map has a heightfield.
    if (def.terrainHeight) {
      const hfn = def.terrainHeight;
      const half = def.size / 2;
      const spacing = 7;
      for (let x = -half + spacing / 2; x < half; x += spacing) {
        for (let z = -half + spacing / 2; z < half; z += spacing) {
          const y = hfn(x, z);
          // Skip points under water surfaces (swim nodes come from water platforms)
          let underwater = false;
          for (const wv of def.water) {
            if (x >= wv.minX && x <= wv.maxX && z >= wv.minZ && z <= wv.maxZ && y < wv.surfaceY - 0.4) {
              underwater = true;
              break;
            }
          }
          if (underwater) continue;
          const supportY = this.validatePoint(phys, x, y, z);
          if (supportY === null) continue;
          this.addNode(x, supportY, z, false);
        }
      }
    }

    // 2) Connect neighbors.
    this.connectNeighbors();

    // 3) Remove unreachable islands (keep only the largest component) so bots
    //    never path into disconnected fragments.
    this.pruneIslands();
  }

  private addNode(x: number, y: number, z: number, water: boolean): number {
    const node: NavNode = { id: this.nodes.length, x, y, z, water, edges: [] };
    this.nodes.push(node);
    this.addToGrid(node);
    return node.id;
  }

  private validatePoint(phys: PhysicsWorld, x: number, y: number, z: number): number | null {
    // Surface must be close to the declared platform height.
    const hit = phys.raycast(x, y + 1.2, z, 0, -1, 0, 2.4, GROUPS.rayWorldOnly);
    if (!hit || Math.abs(hit.point.y - y) > 0.9) return null;
    const supportY = hit.point.y;
    // Store the measured physical support and validate the complete standing
    // volume. This one query covers headroom as well as wall edges, doorway
    // jambs, stair sides and low overhangs; a separate fixed-length headroom
    // ray rejected valid stacked stairs after the capsule scale was corrected.
    if (!phys.isCharacterPositionClear(x, supportY + CAPSULE_CENTER_OFFSET, z)) return null;
    return supportY;
  }

  private connectNeighbors(): void {
    // Jump links can span farther than one spatial-hash cell. Searching only
    // adjacent cells silently omitted valid neighbours that straddled two
    // cell boundaries despite being within the 13-unit traversal limit.
    const cellRadius = Math.ceil(13 / this.cellSize);
    for (const node of this.nodes) {
      const cx = Math.floor(node.x / this.cellSize);
      const cz = Math.floor(node.z / this.cellSize);
      const candidates: number[] = [];
      for (let ix = cx - cellRadius; ix <= cx + cellRadius; ix++) {
        for (let iz = cz - cellRadius; iz <= cz + cellRadius; iz++) {
          const arr = this.grid.get(this.key(ix, iz));
          if (arr) candidates.push(...arr);
        }
      }
      for (const otherId of candidates) {
        if (otherId <= node.id) continue;
        const other = this.nodes[otherId]!;
        const dx = other.x - node.x;
        const dz = other.z - node.z;
        const dy = other.y - node.y;
        const distH = Math.hypot(dx, dz);

        if (node.water !== other.water) {
          // Water nodes store the swimming body centre while dry nodes store
          // feet/support Y. Prove the interpolated full-capsule corridor in
          // that mixed coordinate space before exposing a shore transition.
          if (distH <= 9 && Math.abs(dy) <= 2.2 && this.shorePathClear(node, other)) {
            const water = node.water ? node : other;
            const dry = node.water ? other : node;
            this.linkDirected(water, dry, 'shore', distH * 1.6);
            this.linkDirected(dry, water, 'walk', distH * 1.6);
          }
          continue;
        }
        if (node.water && other.water) {
          if (distH <= 12 && this.swimPathClear(node, other)) {
            this.link(node, other, 'swim', distH * 1.5);
          }
          continue;
        }

        if (Math.abs(dy) <= 1.1) {
          if (distH <= 9 && this.walkClear(node, other)) {
            this.link(node, other, 'walk', distH);
          } else if (distH > 9 && distH <= 13
            && this.hasSupportGap(node, other)
            && this.jumpPathClear(node, other)
            && this.jumpPathClear(other, node)) {
            // Only a real unsupported gap is a jump. The previous distance-
            // only rule classified every 9–13 m diagonal on open terrain as
            // a jump and published tens of thousands of false transitions.
            this.link(node, other, 'jump', distH * 2.2);
          }
        } else {
          // Node id/order is unrelated to elevation. Build traversal edges in
          // their physical direction: lower→higher mantle, higher→lower drop.
          // The old symmetric link made exactly half of both edge types point
          // the wrong way and could ask bots to mantle down or drop upward.
          const lower = dy > 0 ? node : other;
          const higher = dy > 0 ? other : node;
          const rise = higher.y - lower.y;
          const cost = distH + rise * 2.4;
          if (rise <= 2.85 && distH <= 3.6 && this.mantlePathClear(lower, higher)) {
            this.linkDirected(lower, higher, 'mantle', cost);
          }
          if (rise <= 8 && distH <= 4.5 && this.dropPathClear(higher, lower)) {
            this.linkDirected(higher, lower, 'drop', distH + rise * 0.8);
          }
        }
      }
    }
  }

  private link(a: NavNode, b: NavNode, type: NavEdgeType, cost: number): void {
    a.edges.push({ to: b.id, cost, type });
    b.edges.push({ to: a.id, cost, type });
  }

  private linkDirected(from: NavNode, to: NavNode, type: NavEdgeType, cost: number): void {
    from.edges.push({ to: to.id, cost, type });
  }

  private bodyCenter(node: NavNode): { x: number; y: number; z: number } {
    return {
      x: node.x,
      // Water nodes retain the authored surface layer for graph height/cost,
      // but the runtime swimmer must sit below it far enough for the torso
      // probe to remain inside water on the following movement tick.
      y: node.water ? node.y - MOVE.swimSurfaceCenterDepth : node.y + CAPSULE_CENTER_OFFSET,
      z: node.z,
    };
  }

  /** Sample a complete capsule densely enough that a thin side obstacle cannot hide between poses. */
  private poseSegmentClear(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    spacing = MOVE.capsuleRadius * 0.6,
  ): boolean {
    const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const samples = Math.max(1, Math.ceil(distance / spacing));
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      if (!this.physRef!.isCharacterPositionClear(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        from.z + (to.z - from.z) * t,
      )) return false;
    }
    return true;
  }

  private swimPathClear(a: NavNode, b: NavNode): boolean {
    return this.physRef!.isCharacterSweepClear(this.bodyCenter(a), this.bodyCenter(b));
  }

  private shorePathClear(a: NavNode, b: NavNode): boolean {
    const water = a.water ? this.bodyCenter(a) : this.bodyCenter(b);
    const dry = a.water ? this.bodyCenter(b) : this.bodyCenter(a);
    if (this.physRef!.isCharacterSweepClear(water, dry)) return true;
    // A bank or low quay is traversed like the movement system's swim mantle:
    // rise in open water, then cross at standing height. A direct diagonal
    // capsule line incorrectly cuts through the solid bank and disconnects
    // otherwise valid exits.
    const raised = { x: water.x, y: dry.y, z: water.z };
    return this.physRef!.isCharacterSweepClear(water, raised)
      && this.physRef!.isCharacterSweepClear(raised, dry);
  }

  private mantlePathClear(lower: NavNode, higher: NavNode): boolean {
    const from = this.bodyCenter(lower);
    const target = this.bodyCenter(higher);
    const raised = { x: from.x, y: target.y, z: from.z };
    return this.physRef!.isCharacterSweepClear(from, raised)
      && this.physRef!.isCharacterSweepClear(raised, target);
  }

  private dropPathClear(higher: NavNode, lower: NavNode): boolean {
    const from = this.bodyCenter(higher);
    const target = this.bodyCenter(lower);
    const aboveTarget = { x: target.x, y: from.y, z: target.z };
    return this.poseSegmentClear(from, aboveTarget)
      && this.poseSegmentClear(aboveTarget, target);
  }

  private hasSupportGap(a: NavNode, b: NavNode): boolean {
    const samples = Math.max(3, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2.5));
    let previousSupport = a.y;
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const expectedY = a.y + (b.y - a.y) * t;
      const supportY = this.rayDownCache(
        a.x + (b.x - a.x) * t,
        expectedY + 1.2,
        a.z + (b.z - a.z) * t,
      );
      if (supportY === null || Math.abs(supportY - expectedY) > 1.15) return true;
      if (Math.abs(supportY - previousSupport) > MOVE.stepHeight + 0.08) return true;
      previousSupport = supportY;
    }
    return Math.abs(b.y - previousSupport) > MOVE.stepHeight + 0.08;
  }

  private jumpPathClear(a: NavNode, b: NavNode): boolean {
    const from = this.bodyCenter(a);
    const to = this.bodyCenter(b);
    const distH = Math.hypot(to.x - from.x, to.z - from.z);
    const samples = Math.max(8, Math.ceil(distH / (MOVE.capsuleRadius * 0.6)));
    const apex = Math.min(2.1, 1.45 + distH * 0.04);
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const y = from.y + (to.y - from.y) * t + 4 * apex * t * (1 - t);
      if (!this.physRef!.isCharacterPositionClear(
        from.x + (to.x - from.x) * t,
        y,
        from.z + (to.z - from.z) * t,
      )) return false;
    }
    return true;
  }

  private walkClear(a: NavNode, b: NavNode): boolean {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const distH = Math.hypot(dx, dz);
    if (distH < 1e-4) return true;

    // Follow the actual support surface instead of sweeping a capsule through
    // the floor tangent. Sampling at less than the capsule diameter catches
    // doorway jambs, wall corners and thin dividers that a centre ray misses,
    // while measuring Y at every sample lets ordinary stairs and terrain
    // slopes retain their KCC-supported walk links.
    // Continuous rails below cover wall volume between samples, so the more
    // expensive full-shape/support probes only need to stay within one capsule
    // diameter. This keeps production map construction near its previous load
    // budget while still detecting unsupported spans and isolated low props.
    const samples = Math.max(2, Math.ceil(distH / (MOVE.capsuleRadius * 2)));
    let previousSupport = a.y;
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const expectedY = a.y + (b.y - a.y) * t;
      const supportY = this.rayDownCache(x, expectedY + 1.2, z);
      if (supportY === null || Math.abs(supportY - expectedY) > 1.15) return false;
      if (Math.abs(supportY - previousSupport) > MOVE.stepHeight + 0.08) return false;
      let poseSupport = supportY;
      if (!this.physRef!.isCharacterPositionClear(x, poseSupport + CAPSULE_CENTER_OFFSET, z)) {
        // Immediately before a legal riser, the downward ray still sees the
        // lower floor while the capsule nose already overlaps the step. Test
        // the same pose after the KCC's bounded autostep lift; a full-height
        // wall remains blocked, while a real tread becomes tangent/clear.
        const steppedSupport = Math.min(
          Math.max(a.y, b.y),
          supportY + MOVE.stepHeight + 0.08,
        );
        if (steppedSupport <= supportY + 1e-4
          || !this.physRef!.isCharacterPositionClear(
            x,
            steppedSupport + CAPSULE_CENTER_OFFSET,
            z,
          )) return false;
        poseSupport = steppedSupport;
      }
      previousSupport = poseSupport;
    }
    if (Math.abs(b.y - previousSupport) > MOVE.stepHeight + 0.08) return false;

    // The sampled volumes prove each pose, while these continuous offset rays
    // close the small longitudinal gaps between samples. Rays begin above the
    // maximum autostep height, so a valid curb or stair riser is not mistaken
    // for a wall. The upper rail protects capsule headroom under overhangs.
    const invLen = 1 / distH;
    const sideX = -dz * invLen;
    const sideZ = dx * invLen;
    const clearance = MOVE.capsuleRadius + 0.025;
    const rails = [
      { lateral: 0, height: MOVE.stepHeight + 0.08 },
      { lateral: 0, height: 1.82 },
      { lateral: -clearance, height: 1.28 },
      { lateral: -clearance * 0.5, height: 1.28 },
      { lateral: 0, height: 1.28 },
      { lateral: clearance * 0.5, height: 1.28 },
      { lateral: clearance, height: 1.28 },
    ];
    for (const rail of rails) {
      if (!this.losAtOffsetHeight(a, b, rail.height, sideX * rail.lateral, sideZ * rail.lateral)) {
        return false;
      }
    }
    return true;
  }

  private losAtOffsetHeight(
    a: NavNode,
    b: NavNode,
    h: number,
    offsetX: number,
    offsetZ: number,
  ): boolean {
    const ax = a.x + offsetX, ay = a.y + h, az = a.z + offsetZ;
    const bx = b.x + offsetX, by = b.y + h, bz = b.z + offsetZ;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    const hit = this.physRef!.raycast(
      ax, ay, az,
      dx / len, dy / len, dz / len,
      Math.max(0, len - 0.1),
      GROUPS.rayWorldOnly,
    );
    return hit === null;
  }

  private rayDownCache(x: number, y: number, z: number): number | null {
    const k = `${Math.round(x * 2)},${Math.round(y * 2)},${Math.round(z * 2)}`;
    const cached = this.downCache.get(k);
    if (cached !== undefined) return cached;
    const hit = this.physRef!.raycast(x, y, z, 0, -1, 0, 2.6);
    const res = hit ? hit.point.y : null;
    this.downCache.set(k, res);
    return res;
  }
  private downCache = new Map<string, number | null>();

  private physRef: PhysicsWorld | null = null;

  private pruneIslands(): void {
    const n = this.nodes.length;
    const comp = new Int32Array(n).fill(-1);
    let numComps = 0;
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (comp[i] !== -1) continue;
      stack.length = 0;
      stack.push(i);
      comp[i] = numComps;
      while (stack.length) {
        const cur = this.nodes[stack.pop()!]!;
        for (const e of cur.edges) {
          if (comp[e.to] === -1) {
            comp[e.to] = numComps;
            stack.push(e.to);
          }
        }
      }
      numComps++;
    }
    if (numComps <= 1) return;
    const sizes = new Array(numComps).fill(0);
    for (let i = 0; i < n; i++) sizes[comp[i]!]++;
    let best = 0;
    for (let c = 1; c < numComps; c++) if (sizes[c]! > sizes[best]!) best = c;
    // Sever edges into smaller components (keeps node ids stable).
    for (const node of this.nodes) {
      if (comp[node.id] !== best) {
        node.edges.length = 0;
        continue;
      }
      node.edges = node.edges.filter((e) => comp[e.to] === best);
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  nearest(x: number, y: number, z: number, maxDist = 30): NavNode | null {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    let best: NavNode | null = null;
    let bestScore = Infinity;
    for (let r = 0; r <= Math.ceil(maxDist / this.cellSize); r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iz = cz - r; iz <= cz + r; iz++) {
          if (r > 0 && Math.abs(ix - cx) !== r && Math.abs(iz - cz) !== r) continue;
          const arr = this.grid.get(this.key(ix, iz));
          if (!arr) continue;
          for (const id of arr) {
            const nd = this.nodes[id]!;
            // pruneIslands preserves ids for stable edge references but
            // deliberately severs smaller components. Never route an actor
            // back onto one of those orphaned floors/roofs.
            if (nd.edges.length === 0) continue;
            const dy = Math.abs(nd.y - y);
            if (dy > 6) continue;
            const score = Math.hypot(nd.x - x, nd.z - z) + dy * 2.5;
            if (score < bestScore) {
              bestScore = score;
              best = nd;
            }
          }
        }
      }
      if (best && bestScore < r * this.cellSize) break;
    }
    return best;
  }

  /** Nodes within horizontal radius of a point (for loot/cover/poi queries). */
  nodesWithin(x: number, z: number, radius: number, refY?: number, maxYDiff = 5): NavNode[] {
    const out: NavNode[] = [];
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    const r = Math.ceil(radius / this.cellSize);
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const arr = this.grid.get(this.key(ix, iz));
        if (!arr) continue;
        for (const id of arr) {
          const nd = this.nodes[id]!;
          if (nd.edges.length === 0) continue;
          if (refY !== undefined && Math.abs(nd.y - refY) > maxYDiff) continue;
          if (Math.hypot(nd.x - x, nd.z - z) <= radius) out.push(nd);
        }
      }
    }
    return out;
  }

  findPath(fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number): NavPath | null {
    const start = this.nearest(fromX, fromY, fromZ, 24);
    const goal = this.nearest(toX, toY, toZ, 24);
    if (!start || !goal) return null;
    if (start.id === goal.id) {
      return { nodes: [start.id], points: [{ x: start.x, y: start.y, z: start.z }], entryTypes: ['walk'] };
    }

    const n = this.nodes.length;
    const gScore = new Float32Array(n).fill(Infinity);
    const fScore = new Float32Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const cameEdge = new Int32Array(n).fill(-1); // edge index in came-from node
    const closed = new Uint8Array(n);
    const heapIds: number[] = [];
    const heapF: number[] = [];

    const push = (id: number, f: number) => {
      heapIds.push(id);
      heapF.push(f);
      let i = heapIds.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if ((heapF[p] as number) <= heapF[i]!) break;
        swap(heapIds, heapF, i, p);
        i = p;
      }
    };
    const pop = (): number => {
      const top = heapIds[0] as number;
      const lastId = heapIds.pop()!;
      const lastF = heapF.pop()!;
      if (heapIds.length) {
        heapIds[0] = lastId;
        heapF[0] = lastF;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heapIds.length && (heapF[l] as number) < (heapF[m] as number)) m = l;
          if (r < heapIds.length && (heapF[r] as number) < (heapF[m] as number)) m = r;
          if (m === i) break;
          swap(heapIds, heapF, i, m);
          i = m;
        }
      }
      return top;
    };

    const h = (nd: NavNode) => Math.hypot(nd.x - goal.x, nd.y - goal.y, nd.z - goal.z);

    gScore[start.id] = 0;
    fScore[start.id] = h(start);
    push(start.id, fScore[start.id]!);

    let found = false;
    let iterations = 0;
    while (heapIds.length && iterations++ < 60000) {
      const curId = pop();
      if (curId === goal.id) { found = true; break; }
      if (closed[curId]) continue;
      closed[curId] = 1;
      const cur = this.nodes[curId]!;
      for (let ei = 0; ei < cur.edges.length; ei++) {
        const e = cur.edges[ei]!;
        if (closed[e.to]) continue;
        const tentative = gScore[curId]! + e.cost;
        if (tentative < gScore[e.to]!) {
          gScore[e.to] = tentative;
          cameFrom[e.to] = curId;
          cameEdge[e.to] = ei;
          const nb = this.nodes[e.to]!;
          const f = tentative + h(nb) * 1.02;
          fScore[e.to] = f;
          push(e.to, f);
        }
      }
    }

    if (!found) return null;

    // Reconstruct
    const revNodes: number[] = [];
    const revTypes: NavEdgeType[] = [];
    let cur = goal.id;
    while (cur !== -1) {
      revNodes.push(cur);
      const prev = cameFrom[cur]!;
      if (prev !== -1) {
        const e = this.nodes[prev]!.edges[cameEdge[cur]!]!;
        revTypes.push(e.type);
      }
      cur = prev;
    }
    revNodes.reverse();
    revTypes.reverse();
    const points = revNodes.map((id) => {
      const nd = this.nodes[id]!;
      return { x: nd.x, y: nd.y, z: nd.z };
    });
    return { nodes: revNodes, points, entryTypes: ['walk', ...revTypes] };
  }

  randomNodeIn(pois: Array<{ x: number; z: number; radius: number }>, rng: Rng): NavNode | null {
    if (!pois.length) return null;
    const poi = pois[rng.int(0, pois.length - 1)]!;
    const list = this.nodesWithin(poi.x, poi.z, poi.radius);
    if (!list.length) return null;
    return list[rng.int(0, list.length - 1)]!;
  }
}

function swap(ids: number[], fs: number[], i: number, j: number): void {
  const ti = ids[i]!; ids[i] = ids[j]!; ids[j] = ti;
  const tf = fs[i]!; fs[i] = fs[j]!; fs[j] = tf;
}
