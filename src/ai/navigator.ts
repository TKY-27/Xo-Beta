/**
 * Bot navigation wrapper: path requests, waypoint following, traversal-edge
 * execution (jump/mantle/drop/swim), stuck detection.
 */

import type { NavGraph, NavPath } from '../world/nav';
import { gameNext } from '../core/rng';
import type { Actor } from '../sim/actor';
import type { InputCommand } from '../sim/input';
import { feetYFromBodyCenter } from '../physics/physics';

export interface NavGoal {
  x: number;
  y: number;
  z: number;
  /** Recompute path if goal moved further than this from the requested one. */
  tolerance?: number;
}

const REPATH_INTERVAL = 1.4;
const WAYPOINT_REACH = 1.6;

export class BotNavigator {
  private path: NavPath | null = null;
  private pathIndex = 0;
  private repathTimer = 0;
  private lastGoal: NavGoal | null = null;
  private stuckTimer = 0;
  private lastX = 0;
  private lastZ = 0;
  private jumpCooldown = 0;
  /** Set when crossing a jump/mantle edge; consumed by movement next ticks. */
  wantJump = false;

  constructor(private nav: NavGraph, private actor: Actor) {
    this.lastX = actor.body.position.x;
    this.lastZ = actor.body.position.z;
  }

  setGoal(goal: NavGoal): void {
    const tol = goal.tolerance ?? 3;
    const g = this.lastGoal;
    if (g && Math.hypot(g.x - goal.x, g.z - goal.z) < tol && this.path) return;
    this.requestPath(goal);
  }

  hasPath(): boolean {
    return this.path !== null && this.pathIndex < this.path.points.length;
  }

  clear(): void {
    this.path = null;
    this.lastGoal = null;
  }

  requestPath(goal: NavGoal): void {
    const p = this.actor.body.position;
    this.path = this.nav.findPath(p.x, feetYFromBodyCenter(p.y), p.z, goal.x, goal.y, goal.z);
    this.pathIndex = this.path ? 1 : 0; // skip current node
    this.repathTimer = REPATH_INTERVAL;
    this.lastGoal = goal;
    if (!this.path) {
      // Fall back to direct steering toward goal
      this.path = {
        nodes: [],
        points: [{ x: goal.x, y: goal.y, z: goal.z }],
        entryTypes: ['walk'],
      };
      this.pathIndex = 0;
    }
  }

  /**
   * Produce steering input toward the current waypoint.
   * Returns true while navigating; false when arrived (or no path).
   */
  steer(cmd: InputCommand, dt: number, arriveDist = WAYPOINT_REACH): boolean {
    const a = this.actor;
    const p = a.body.position;

    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
    this.repathTimer -= dt;
    if (this.repathTimer <= 0 && this.lastGoal) {
      this.requestPath(this.lastGoal);
    }

    if (!this.path || this.pathIndex >= this.path.points.length) {
      // Arrived (or nothing to do)
      this.stuckCheck(dt);
      return false;
    }

    const wp = this.path.points[this.pathIndex]!;
    const dx = wp.x - p.x;
    const dz = wp.z - p.z;
    const dy = wp.y - feetYFromBodyCenter(p.y);
    const distH = Math.hypot(dx, dz);

    const edgeType = this.path.entryTypes[Math.min(this.pathIndex, this.path.entryTypes.length - 1)] ?? 'walk';

    // Waypoint arrival
    const reach = edgeType === 'mantle' ? 1.2 : arriveDist;
    if (distH < reach && Math.abs(dy) < 3.5) {
      this.pathIndex++;
      if (this.pathIndex >= this.path.points.length) {
        this.path = null;
        return false;
      }
      return true;
    }

    // Face + move toward waypoint
    const targetYaw = Math.atan2(-dx, -dz);
    cmd.yaw = targetYaw;
    cmd.pitch = clamp(-Math.atan2(dy + 1.2, Math.max(distH, 0.5)), -1.2, 1.2);
    cmd.moveZ = 1;
    cmd.sprint = true;

    // Traversal edge handling
    if (edgeType === 'jump' && distH < 4.6 && this.jumpCooldown <= 0) {
      cmd.jumpPressed = true;
      cmd.jumpHeld = true;
      this.jumpCooldown = 0.8;
    } else if (edgeType === 'mantle' && distH < 2.4) {
      // walk into ledge; mantle triggers via movement system
      cmd.jumpPressed = this.jumpCooldown <= 0;
      cmd.jumpHeld = true;
      if (cmd.jumpPressed) this.jumpCooldown = 0.9;
    } else if (edgeType === 'drop') {
      // just walk off
    } else if (edgeType === 'swim') {
      cmd.moveZ = 1;
    } else if (edgeType === 'shore') {
      // Surface into the bank; updateSwim will either establish supported
      // ground contact or reuse the collision-safe mantle path at a ledge.
      cmd.moveZ = 1;
      if (a.state === 'swim') {
        cmd.jumpHeld = true;
        if (this.jumpCooldown <= 0) {
          cmd.jumpPressed = true;
          this.jumpCooldown = 0.9;
        }
      }
    }

    // Stuck detection & recovery
    this.stuckCheck(dt);
    if (this.stuckTimer > 1.1) {
      this.stuckTimer = 0;
      if (a.body.grounded) {
        cmd.jumpPressed = true;
        cmd.jumpHeld = true;
        // occasional dash unstick
        if (gameNext() < 0.35 && a.dashCharges > 0) cmd.dashPressed = true;
      }
      if (gameNext() < 0.5 && this.lastGoal) {
        this.requestPath(this.lastGoal);
      }
    }

    return true;
  }

  private stuckCheck(dt: number): void {
    const p = this.actor.body.position;
    const moved = Math.hypot(p.x - this.lastX, p.z - this.lastZ);
    if (moved < 0.25 * (dt * 60) * 0.05) {
      this.stuckTimer += dt;
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
    }
    this.lastX = p.x;
    this.lastZ = p.z;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
