/**
 * Combat: weapon firing, projectile simulation (real travel time, drop, CCD),
 * regional damage resolution, falloff, ricochet, glass penetration.
 */

import {
  RARITY_MODS, WEAPONS, HIT_REGION_MULT,
  type Rarity, type WeaponId,
} from '../core/balance';
import type { Actor } from './actor';
import { MovementSystem } from './movement';
import type { PhysicsWorld } from '../physics/physics';
import type { WaterVolume } from '../world/types';
import { gameNext } from '../core/rng';

export interface Projectile {
  active: boolean;
  ownerId: number;
  weaponId: WeaponId;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  damage: number;
  headMult: number;
  legMult: number;
  falloffStart: number;
  falloffEnd: number;
  falloffEndMult: number;
  gravityScale: number;
  dist: number;
  life: number;
  tracerColor: number;
  isPellet: boolean;
  ricochets: number;
  inWater: boolean;
}

export interface CombatEvents {
  onMuzzleFlash(actor: Actor, weaponId: WeaponId): void;
  onShotFired(actor: Actor, weaponId: WeaponId, x: number, y: number, z: number): void;
  onImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, material: string, projectile: boolean): void;
  onActorHit(target: Actor, attacker: Actor | null, damage: number, region: string, weaponId: WeaponId, killed: boolean, headshot: boolean): void;
  onShieldBroken?(target: Actor): void;
  onTracer(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, color: number): void;
  onRicochet(x: number, y: number, z: number): void;
  onGlassBreak(x: number, y: number, z: number): void;
  onDestructibleDamaged(id: number, x: number, y: number, z: number, destroyed: boolean): void;
}

interface DestructibleRef {
  id: number;
  hp: number;
  collider: unknown;
  geo: { kind: string; x: number; y: number; z: number; sx?: number; sy?: number; sz?: number; r?: number; h?: number };
  type: string;
  alive: boolean;
}

const MAX_PROJECTILES = 512;

export class CombatSystem {
  projectiles: Projectile[] = [];
  private destructibles = new Map<number, DestructibleRef>();
  private nextDestructibleId = 1;

  constructor(
    public phys: PhysicsWorld,
    public movement: MovementSystem,
    public events: CombatEvents,
  ) {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.projectiles.push({
        active: false, ownerId: -1, weaponId: 'pistol',
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        damage: 0, headMult: 2, legMult: 0.75,
        falloffStart: 50, falloffEnd: 150, falloffEndMult: 0.6,
        gravityScale: 0.5, dist: 0, life: 0, tracerColor: 0xffffff,
        isPellet: false, ricochets: 0, inWater: false,
      });
    }
  }

  waterAt: (x: number, y: number, z: number) => WaterVolume | null = () => null;

  registerDestructibles(list: DestructibleRef[]): void {
    for (const d of list) this.destructibles.set(d.id, d);
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  /** Attempt to fire the actor's selected weapon. Returns true if a shot happened. */
  tryFire(a: Actor, dt: number, aimDirOverride?: { x: number; y: number; z: number }): boolean {
    const w = a.inv.selectedWeapon;
    if (!w || !a.alive) return false;
    const def = WEAPONS[w.weaponId];
    const rt = a.wpn;

    if (rt.reloadTimer > 0 || rt.swapTimer > 0 || a.healing) return false;
    if (rt.boltTimer > 0) return false;
    rt.fireCooldown -= dt;
    if (rt.fireCooldown > 0) return false;

    if (w.ammoInMag <= 0) {
      // dry click event handled by audio layer via shot event with empty flag
      rt.fireCooldown = 0.25;
      this.events.onShotFired(a, w.weaponId, a.body.position.x, a.eyeY, a.body.position.z);
      return false;
    }

    rt.fireCooldown = 60 / def.rpm;
    rt.lastShotTime = 0;
    w.ammoInMag--;
    a.stats.shotsFired++;

    if (def.fireMode === 'bolt') rt.boltTimer = Math.max(0.9, 60 / def.rpm - 0.35);
    if (def.fireMode === 'pump') rt.boltTimer = Math.max(0.55, 60 / def.rpm - 0.3);

    // Direction with recoil + spread
    const baseDir = aimDirOverride ?? this.movement.lookDir(a);
    const mods = RARITY_MODS[w.rarity];
    const speedH = Math.hypot(a.body.velocity.x, a.body.velocity.z);
    const airPenalty = a.body.grounded ? 1 : 1.8;
    const movePenalty = 1 + Math.min(1.2, speedH / MOVE_REF_SPEED) * 0.8;
    const crouchBonus = a.crouched ? 0.72 : 1;
    const spreadBase = (rt.adsAmount > 0.6 ? def.spreadAds : def.spreadHip) * mods.spreadMult;
    const spread = (spreadBase + rt.bloom) * movePenalty * airPenalty * crouchBonus;

    const eyeY = a.eyeY;
    const px = a.body.position.x;
    const pz = a.body.position.z;

    for (let p = 0; p < def.pellets; p++) {
      const dir = coneSample(baseDir, spread);
      const proj = this.alloc();
      if (!proj) break;
      const speed = def.projectileSpeed * mods.projSpeedMult * (p === 0 ? 1 : 0.96 + ((p * 37) % 10) * 0.008);
      proj.active = true;
      proj.ownerId = a.id;
      proj.weaponId = w.weaponId;
      proj.x = px + dir.x * 0.7;
      proj.y = eyeY + dir.y * 0.7 - 0.12;
      proj.z = pz + dir.z * 0.7;
      proj.vx = dir.x * speed;
      proj.vy = dir.y * speed;
      proj.vz = dir.z * speed;
      proj.damage = def.damage[rarityIndex(w.rarity)] ?? def.damage[0]!;
      proj.headMult = def.headMult;
      proj.legMult = def.legMult;
      proj.falloffStart = def.falloffStart;
      proj.falloffEnd = def.falloffEnd;
      proj.falloffEndMult = def.falloffEndMult;
      proj.gravityScale = def.dropGravity;
      proj.dist = 0;
      proj.life = 3.2;
      proj.tracerColor = def.tracerColor;
      proj.isPellet = def.pellets > 1;
      proj.ricochets = 0;
      proj.inWater = false;
    }

    // Recoil & bloom
    const rMod = mods.recoilMult;
    rt.recoilPitch += def.recoilKick * rMod * (0.85 + gameNext() * 0.3);
    rt.recoilYaw += (gameNext() - 0.5) * def.recoilKick * 0.7 * rMod;
    rt.bloom = Math.min(def.bloomMax, rt.bloom + def.bloomPerShot);

    this.events.onMuzzleFlash(a, w.weaponId);
    this.events.onShotFired(a, w.weaponId, px, eyeY, pz);
    return true;
  }

  /** Reload request. Returns true if reload started. */
  tryReload(a: Actor): boolean {
    const w = a.inv.selectedWeapon;
    if (!w || !a.alive) return false;
    const rt = a.wpn;
    if (rt.reloadTimer > 0 || rt.swapTimer > 0 || a.healing) return false;
    const def = WEAPONS[w.weaponId];
    if (w.ammoInMag >= def.magSize) return false;
    if (a.inv.ammo[def.ammoType] <= 0) return false;
    rt.reloadingEmpty = w.ammoInMag === 0;
    rt.reloadTotal = (w.ammoInMag === 0 ? def.reloadEmpty : def.reloadTactical) * RARITY_MODS[w.rarity].reloadMult;
    rt.reloadTimer = rt.reloadTotal;
    return true;
  }

  updateWeaponTimers(a: Actor, dt: number): void {
    const rt = a.wpn;
    if (rt.boltTimer > 0) rt.boltTimer -= dt;
    if (rt.lastShotTime < 90) rt.lastShotTime += dt;

    // Bloom decay
    const w = a.inv.selectedWeapon;
    if (w) {
      const def = WEAPONS[w.weaponId];
      rt.bloom = Math.max(0, rt.bloom - def.bloomDecay * dt);
    }

    // Recoil recovery (view returns toward original aim)
    if (rt.recoilPitch !== 0 || rt.recoilYaw !== 0) {
      const k = Math.exp(-6 * dt);
      rt.recoilPitch *= k;
      rt.recoilYaw *= k;
      if (Math.abs(rt.recoilPitch) < 1e-4) rt.recoilPitch = 0;
      if (Math.abs(rt.recoilYaw) < 1e-4) rt.recoilYaw = 0;
    }

    // ADS blend
    const adsTarget = a.adsHeld && !a.healing && rt.reloadTimer <= 0 ? 1 : 0;
    if (w) {
      const def = WEAPONS[w.weaponId];
      const rate = dt / Math.max(0.05, def.adsTime * RARITY_MODS[w.rarity].adsMult);
      rt.adsAmount += Math.sign(adsTarget - rt.adsAmount) * Math.min(Math.abs(adsTarget - rt.adsAmount), rate);
    } else {
      rt.adsAmount = 0;
    }

    // Reload completion
    if (rt.reloadTimer > 0) {
      rt.reloadTimer -= dt;
      if (rt.reloadTimer <= 0) {
        rt.reloadTimer = 0;
        const wsel = a.inv.selectedWeapon;
        if (wsel) a.inv.finishReload(wsel);
        rt.reloadingEmpty = false;
      }
    }
    if (rt.swapTimer > 0) rt.swapTimer -= dt;
  }

  // -------------------------------------------------------------------------
  // Projectile stepping
  // -------------------------------------------------------------------------

  update(dt: number, actors: Actor[]): void {
    const substeps = 2;
    const sdt = dt / substeps;
    for (let s = 0; s < substeps; s++) {
      for (const p of this.projectiles) {
        if (!p.active) continue;
        this.stepProjectile(p, sdt, actors);
      }
    }
  }

  private stepProjectile(p: Projectile, dt: number, actors: Actor[]): void {
    p.life -= dt;
    if (p.life <= 0) {
      p.active = false;
      return;
    }

    const vol = this.waterAt(p.x, p.y, p.z);
    const wasInWater = p.inWater;
    p.inWater = vol !== null && p.y < vol.surfaceY;
    if (p.inWater && !wasInWater) {
      this.events.onImpact(p.x, vol!.surfaceY, p.z, 0, 1, 0, 'water', true);
    }

    const speed = Math.hypot(p.vx, p.vy, p.vz);
    const drag = p.inWater ? Math.exp(-4.5 * dt) : 1;
    p.vx *= drag; p.vy *= drag; p.vz *= drag;

    // Gravity
    p.vy -= 26 * p.gravityScale * (p.inWater ? 0.4 : 1) * dt;

    const stepLen = Math.max(speed * dt, 0.001);
    const dx = p.vx / speed, dy = p.vy / speed, dz = p.vz / speed;

    const hit = this.phys.raycast(p.x, p.y, p.z, dx, dy, dz, stepLen + 0.05);
    if (hit) {
      const meta = this.phys.metaOf(hit.collider);
      if (meta?.kind === 'actor') {
        const target = actors.find((ac) => ac.id === meta.actorId);
        if (target && target.alive && target.id !== p.ownerId) {
          this.resolveActorHit(p, target, hit.point.x, hit.point.y, hit.point.z, meta.region);
          p.active = false;
          return;
        }
        // Own collider or dead actor: pass through
      } else if (meta?.kind === 'destructible') {
        const d = this.destructibles.get(meta.id);
        if (d && d.alive) {
          const destroyed = d.type === 'glass' ? true : d.hp <= p.damage * 2;
          d.hp -= p.damage;
          const gone = d.type === 'glass' || d.hp <= 0;
          if (gone) {
            d.alive = false;
            this.phys.removeCollider(d.collider as never);
            if (d.type === 'glass') this.events.onGlassBreak(d.geo.x, d.geo.y, d.geo.z);
            else this.events.onDestructibleDamaged(meta.id, d.geo.x, d.geo.y, d.geo.z, true);
          } else {
            this.events.onDestructibleDamaged(meta.id, hit.point.x, hit.point.y, hit.point.z, false);
          }
          if (d.type !== 'glass') {
            // Non-glass destructibles stop the round
            this.events.onImpact(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z, meta.material, true);
            p.active = false;
            return;
          }
          // Glass penetrated: continue flight with slight deviation
        } else {
          // Already-destroyed leftover collider (shouldn't happen) — ignore
        }
      } else {
        // World geometry (or unknown): impact or ricochet
        const shallowDot = -(dx * hit.normal.x + dy * hit.normal.y + dz * hit.normal.z);
        const canRicochet =
          p.weaponId === 'sniper' && p.ricochets < 1 && shallowDot < 0.22;
        if (canRicochet) {
          p.ricochets++;
          // Reflect velocity
          const dot = p.vx * hit.normal.x + p.vy * hit.normal.y + p.vz * hit.normal.z;
          p.vx -= 2 * dot * hit.normal.x;
          p.vy -= 2 * dot * hit.normal.y;
          p.vz -= 2 * dot * hit.normal.z;
          p.vx *= 0.55; p.vy *= 0.55; p.vz *= 0.55;
          p.damage *= 0.5;
          p.x = hit.point.x + hit.normal.x * 0.05;
          p.y = hit.point.y + hit.normal.y * 0.05;
          p.z = hit.point.z + hit.normal.z * 0.05;
          this.events.onRicochet(hit.point.x, hit.point.y, hit.point.z);
          return;
        }
        this.events.onImpact(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z, 'stone', true);
        p.active = false;
        return;
      }
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.dist += stepLen;

    // Tracer sampling is done by the renderer reading active projectiles.
  }

  private resolveActorHit(p: Projectile, target: Actor, hx: number, hy: number, hz: number, region: string): void {
    const attacker = this.attackerLookup?.(p.ownerId) ?? null;
    let mult = 1;
    let headshot = false;
    if (region === 'head') { mult = p.headMult; headshot = true; }
    else if (region === 'legs') mult = p.legMult;
    else if (region === 'abdomen') mult = HIT_REGION_MULT.abdomen;
    else if (region === 'arms') mult = HIT_REGION_MULT.arms;

    // Falloff by distance traveled
    let dmg = p.damage * mult;
    if (p.dist > p.falloffStart) {
      const t = Math.min(1, (p.dist - p.falloffStart) / Math.max(1, p.falloffEnd - p.falloffStart));
      dmg *= 1 + (p.falloffEndMult - 1) * t;
    }
    dmg = Math.max(1, dmg);

    const wasAlive = target.alive;
    const dealt = target.applyDamage(dmg);
    target.lastDamageTime = 0;
    if (attacker) {
      attacker.stats.damageDealt += dealt;
      attacker.stats.shotsHit++;
      if (headshot) attacker.stats.headshots++;
      target.lastAttackerId = attacker.id;
    }
    this.events.onActorHit(target, attacker, dealt, region, p.weaponId, wasAlive && !target.alive, headshot);
    if (wasAlive && target.alive && target.lastShieldBroken) this.events.onShieldBroken?.(target);
    void hx; void hy; void hz;
  }

  attackerLookup: ((id: number) => Actor | null) | null = null;

  /** Damage a destructible from explosions etc. */
  damageDestructible(id: number, amount: number): boolean {
    const d = this.destructibles.get(id);
    if (!d || !d.alive) return false;
    d.hp -= amount;
    if (d.hp <= 0) {
      d.alive = false;
      this.phys.removeCollider(d.collider as never);
      this.events.onDestructibleDamaged(id, d.geo.x, d.geo.y, d.geo.z, true);
      return true;
    }
    return false;
  }

  destructibleList(): DestructibleRef[] {
    return [...this.destructibles.values()];
  }

  private alloc(): Projectile | null {
    for (const p of this.projectiles) {
      if (!p.active) return p;
    }
    return null;
  }
}

function rarityIndex(r: Rarity): number {
  switch (r) {
    case 'common': return 0;
    case 'uncommon': return 1;
    case 'rare': return 2;
    case 'epic': return 3;
    case 'legendary': return 4;
  }
}

/** Random direction within a cone around `dir` (half-angle `angle` radians). */
export function coneSample(dir: { x: number; y: number; z: number }, angle: number): { x: number; y: number; z: number } {
  if (angle <= 0) return { ...dir };
  // Build orthonormal basis around dir
  const upAbs = Math.abs(dir.y) > 0.95;
  const rx = upAbs ? 1 : 0, ry = upAbs ? 0 : 0, rz = upAbs ? 0 : 1;
  // right = normalize(cross(dir, up))
  let cx = dir.y * rz - dir.z * ry;
  let cy = dir.z * rx - dir.x * rz;
  let cz = dir.x * ry - dir.y * rx;
  const cl = Math.hypot(cx, cy, cz) || 1;
  cx /= cl; cy /= cl; cz /= cl;
  // up2 = cross(right, dir)
  const ux = cy * dir.z - cz * dir.y;
  const uy = cz * dir.x - cx * dir.z;
  const uz = cx * dir.y - cy * dir.x;

  const theta = gameNext() * Math.PI * 2;
  const r = Math.sqrt(gameNext()) * angle;
  const ox = Math.cos(theta) * r;
  const oy = Math.sin(theta) * r;
  const x = dir.x + cx * ox + ux * oy;
  const y = dir.y + cy * ox + uy * oy;
  const z = dir.z + cz * ox + uz * oy;
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

const MOVE_REF_SPEED = 9.8;
