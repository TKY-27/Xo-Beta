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
 */

import type { MapDef } from './types';
import type { PhysicsWorld } from '../physics/physics';
import { Rng } from '../core/rng';

export type NavEdgeType = 'walk' | 'jump' | 'mantle' | 'drop' | 'swim';

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

const HEADROOM = 2.35;

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
            this.addNode(x, plat.y, z, true);
          }
        }
        continue;
      }
      for (let x = plat.minX + spacing / 2; x <= plat.maxX - spacing / 2 + 0.01; x += spacing) {
        for (let z = plat.minZ + spacing / 2; z <= plat.maxZ - spacing / 2 + 0.01; z += spacing) {
          if (!this.validatePoint(phys, x, plat.y, z)) continue;
          this.addNode(x, plat.y, z, false);
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
          if (!this.validatePoint(phys, x, y, z)) continue;
          this.addNode(x, y, z, false);
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

  private validatePoint(phys: PhysicsWorld, x: number, y: number, z: number): boolean {
    // Surface must be close to the declared platform height.
    const hit = phys.raycast(x, y + 1.2, z, 0, -1, 0, 2.4);
    if (!hit || Math.abs(hit.point.y - y) > 0.9) return false;
    // Headroom: no ceiling within capsule height above the surface.
    const up = phys.raycast(x, hit.point.y + 0.3, z, 0, 1, 0, HEADROOM);
    if (up) return false;
    return true;
  }

  private connectNeighbors(): void {
    const near = this.cellSize * 2;
    for (const node of this.nodes) {
      const cx = Math.floor(node.x / this.cellSize);
      const cz = Math.floor(node.z / this.cellSize);
      const candidates: number[] = [];
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iz = cz - 1; iz <= cz + 1; iz++) {
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
          // Shore transitions: allow modest height difference.
          if (distH <= 9 && Math.abs(dy) <= 2.2) {
            this.link(node, other, 'walk', distH * 1.6);
          }
          continue;
        }
        if (node.water && other.water) {
          if (distH <= 12) this.link(node, other, 'swim', distH * 1.5);
          continue;
        }

        if (Math.abs(dy) <= 1.1) {
          if (distH <= 9 && this.walkClear(node, other)) {
            this.link(node, other, 'walk', distH);
          } else if (distH > 9 && distH <= 13 && dy >= -0.4 && this.losAtHeight(node, other, 1.3)) {
            // wide gap jump link
            this.link(node, other, 'jump', distH * 2.2);
          }
        } else if (dy >= 1.1 && dy <= 2.85 && distH <= 3.6) {
          if (this.losAtHeight(node, other, 1.0)) this.link(node, other, 'mantle', distH + dy * 2.4);
        } else if (dy <= -1.1 && dy >= -8 && distH <= 4.5) {
          if (this.losAtHeight(node, other, 1.0)) this.link(node, other, 'drop', distH + Math.abs(dy) * 0.8);
        }
      }
    }
    void near;
  }

  private link(a: NavNode, b: NavNode, type: NavEdgeType, cost: number): void {
    a.edges.push({ to: b.id, cost, type });
    b.edges.push({ to: a.id, cost, type });
  }

  private walkClear(a: NavNode, b: NavNode): boolean {
    // Ground continuity at midpoint + chest-height line of sight.
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const my = (a.y + b.y) / 2;
    const down = this.rayDownCache(mx, my + 1.2, mz);
    if (down === null || Math.abs(down - my) > 1.15) return false;
    return this.losAtHeight(a, b, 1.25);
  }

  private losAtHeight(a: NavNode, b: NavNode, h: number): boolean {
    const ax = a.x, ay = a.y + h, az = a.z;
    const bx = b.x, by = b.y + h, bz = b.z;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    const hit = this.physRef!.raycast(ax, ay, az, dx / len, dy / len, dz / len, len - 0.1);
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
