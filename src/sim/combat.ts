/**
 * Combat: weapon firing, projectile simulation (real travel time, drop, CCD),
 * regional damage resolution, falloff, ricochet, glass penetration.
 */

import {
  MELEE, MOVE, RARITY_MODS, WEAPONS, HIT_REGION_MULT,
  type Rarity, type WeaponId,
} from '../core/balance';
import type { Actor } from './actor';
import { MovementSystem } from './movement';
import { eyeYFromBodyCenter, type PhysicsWorld } from '../physics/physics';
import type { MapDef, WaterVolume } from '../world/types';
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

/**
 * Server-owned historical firing pose. Network messages never populate this
 * structure: lag compensation reconstructs it from completed simulation
 * ticks, while `tryFireFromAuthoritativePose` still owns weapon/ammo/RPM
 * validation and projectile attributes.
 */
export interface AuthoritativeShotPose {
  bodyPosition: Readonly<{ x: number; y: number; z: number }>;
  crouched: boolean;
  aimDirection: Readonly<{ x: number; y: number; z: number }>;
  spread: number;
}

interface ProjectileCollisionHitBase {
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  dist: number;
}

export type ProjectileCollisionHit = ProjectileCollisionHitBase & (
  | { kind: 'actor'; actorId: number; region: string }
  | {
    kind: 'destructible';
    destructibleId: number;
    stableId: string;
    destructibleType: string;
    material: string;
  }
  | { kind: 'world'; material: string }
);

/** Pure collision seam used only while catching a late projectile up. */
export interface ProjectileCollisionQuery {
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): ProjectileCollisionHit | null;
  /** Lets a historical query stop returning glass removed by this catch-up. */
  onDestructibleResolved?(hit: Extract<ProjectileCollisionHit, { kind: 'destructible' }>, removed: boolean): void;
}

export interface CombatEvents {
  onMuzzleFlash(
    actor: Actor,
    weaponId: WeaponId,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
  ): void;
  /** `dry` is explicit so consumers do not infer it from post-shot ammo. */
  onShotFired(actor: Actor, weaponId: WeaponId, x: number, y: number, z: number, dry: boolean): void;
  /** Fired for both manual and empty-mag automatic reload starts. */
  onReloadStarted?(actor: Actor, empty: boolean): void;
  onImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, material: string, projectile: boolean): void;
  onActorHit(target: Actor, attacker: Actor | null, damage: number, region: string, weaponId: WeaponId, killed: boolean, headshot: boolean): void;
  onShieldBroken?(target: Actor): void;
  onTracer(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, color: number): void;
  onRicochet(x: number, y: number, z: number): void;
  onGlassBreak(destructibleId: string, x: number, y: number, z: number, actorId: number): void;
  onDestructibleDamaged(id: number, destructibleId: string, x: number, y: number, z: number, destroyed: boolean): void;
  onMeleeSwing(actor: Actor, x: number, y: number, z: number): void;
  onMeleeHit(target: Actor, attacker: Actor, damage: number, killed: boolean, headshot: boolean): void;
}

export interface DestructibleRef {
  id: number;
  stableId: string;
  /** Monotonic authoritative state revision; increments on a state edge. */
  revision: number;
  hp: number;
  collider: unknown;
  geo: MapDef['destructibles'][number]['geo'];
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
  /** Central Match policy for every actor-to-actor damage and impulse route. */
  canAffectActor: (attacker: Actor, target: Actor) => boolean = () => true;

  registerDestructibles(list: DestructibleRef[]): void {
    for (const d of list) this.destructibles.set(d.id, d);
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  /** Attempt to fire the actor's selected weapon. Returns true if a shot happened. */
  tryFire(
    a: Actor,
    _dt: number,
    aimDirOverride?: { x: number; y: number; z: number },
    triggerPressed = true,
  ): boolean {
    return this.tryFireInternal(a, aimDirOverride, triggerPressed, null).fired;
  }

  /**
   * Fire from a pose previously captured by the authoritative host. The
   * caller receives exactly the projectiles created by this trigger so it can
   * catch only those rounds up through historical geometry.
   */
  tryFireFromAuthoritativePose(
    a: Actor,
    _dt: number,
    pose: AuthoritativeShotPose,
    triggerPressed = true,
  ): readonly Projectile[] | null {
    const aim = normalizeDirection(pose.aimDirection);
    if (!aim || !finitePoint(pose.bodyPosition) || !Number.isFinite(pose.spread)) return null;
    const result = this.tryFireInternal(a, aim, triggerPressed, {
      bodyPosition: pose.bodyPosition,
      crouched: pose.crouched,
      spread: Math.max(0, Math.min(Math.PI / 2, pose.spread)),
    });
    return result.fired ? result.projectiles : null;
  }

  private tryFireInternal(
    a: Actor,
    aimDirOverride: { x: number; y: number; z: number } | undefined,
    triggerPressed: boolean,
    historicalPose: {
      bodyPosition: Readonly<{ x: number; y: number; z: number }>;
      crouched: boolean;
      spread: number;
    } | null,
  ): { fired: boolean; projectiles: Projectile[] } {
    const w = a.inv.selectedWeapon;
    if (!w || !a.alive) return { fired: false, projectiles: [] };
    const def = WEAPONS[w.weaponId];
    const rt = a.wpn;

    // A trigger press during a staged reload is allowed to use rounds that
    // have already been transferred. It cancels only the remaining reload;
    // an empty magazine keeps reloading because there is no physical round to
    // fire yet.
    if (rt.reloadTimer > 0) {
      if (!triggerPressed) return { fired: false, projectiles: [] };
      if (w.ammoInMag <= 0) return { fired: false, projectiles: [] };
      // Do not throw away a partial reload for a click that arrives before
      // the weapon's normal cycle/bolt delay has elapsed. The next click can
      // still interrupt once a shot is actually legal.
      if (rt.fireCooldown > 0 || rt.boltTimer > 0 || rt.swapTimer > 0 || a.healing) {
        return { fired: false, projectiles: [] };
      }
      this.cancelReload(a);
    }
    if (rt.swapTimer > 0 || a.healing) return { fired: false, projectiles: [] };
    if (rt.boltTimer > 0) return { fired: false, projectiles: [] };
    if (rt.fireCooldown > 0) return { fired: false, projectiles: [] };

    if (w.ammoInMag <= 0) {
      // Keep dry fire separate from a real shot. In particular, the last
      // round decrements the magazine to zero but is still a live shot.
      rt.fireCooldown = 0.25;
      this.events.onShotFired(a, w.weaponId, a.body.position.x, a.eyeY, a.body.position.z, true);
      return { fired: false, projectiles: [] };
    }

    rt.fireCooldown = 60 / def.rpm;
    rt.lastShotTime = 0;
    w.ammoInMag--;
    a.stats.shotsFired++;

    if (def.fireMode === 'bolt') rt.boltTimer = Math.max(0.9, 60 / def.rpm - 0.35);
    if (def.fireMode === 'pump') rt.boltTimer = Math.max(0.55, 60 / def.rpm - 0.3);

    // Direction with recoil + spread
    const baseDir = aimDirOverride ?? this.movement.lookDir(a);
    const spread = historicalPose?.spread ?? this.currentSpread(a);

    const bodyPosition = historicalPose?.bodyPosition ?? a.body.position;
    const eyeY = historicalPose
      ? eyeYFromBodyCenter(bodyPosition.y, historicalPose.crouched)
      : a.eyeY;
    const px = bodyPosition.x;
    const pz = bodyPosition.z;
    // Canonical logical muzzle shared by projectile, flash fallback and audio.
    // Rendered rigs may refine the visual flash to the authored weapon marker,
    // but simulation consumers must never fall back to the actor's chest.
    const muzzleX = px + baseDir.x * 0.7;
    const muzzleY = eyeY + baseDir.y * 0.7 - 0.12;
    const muzzleZ = pz + baseDir.z * 0.7;

    const firedProjectiles: Projectile[] = [];
    for (let p = 0; p < def.pellets; p++) {
      const dir = coneSample(baseDir, spread);
      const proj = this.alloc();
      const speed = def.projectileSpeed * RARITY_MODS[w.rarity].projSpeedMult * (p === 0 ? 1 : 0.96 + ((p * 37) % 10) * 0.008);
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
      firedProjectiles.push(proj);
    }

    // Recoil & bloom
    const rMod = RARITY_MODS[w.rarity].recoilMult;
    rt.recoilPitch += def.recoilKick * rMod * (0.85 + gameNext() * 0.3);
    rt.recoilYaw += (gameNext() - 0.5) * def.recoilKick * 0.7 * rMod;
    rt.bloom = Math.min(def.bloomMax, rt.bloom + def.bloomPerShot);

    this.events.onMuzzleFlash(a, w.weaponId, muzzleX, muzzleY, muzzleZ, baseDir.x, baseDir.y, baseDir.z);
    this.events.onShotFired(a, w.weaponId, muzzleX, muzzleY, muzzleZ, false);
    if (w.ammoInMag === 0) this.tryReload(a);
    return { fired: true, projectiles: firedProjectiles };
  }

  /** Attempt a punch with the permanent fists pseudo-weapon. */
  tryMelee(a: Actor, _dt: number, actors: readonly Actor[]): boolean {
    if (!a.alive || a.healing) return false;
    const rt = a.wpn;
    if (rt.swapTimer > 0) return false;
    if (rt.fireCooldown > 0) return false;
    rt.fireCooldown = 60 / MELEE.rpm;
    rt.lastShotTime = 0;
    a.punchTimer = 0.32;

    const fwd = this.movement.lookDir(a);
    const px = a.body.position.x;
    const py = a.body.position.y;
    const pz = a.body.position.z;
    this.events.onMeleeSwing(a, px, py, pz);

    for (const t of actors) {
      if (t === a || !t.alive) continue;
      if (!this.canAffectActor(a, t)) continue;
      const dx = t.body.position.x - px;
      const dy = t.body.position.y - py;
      const dz = t.body.position.z - pz;
      const distH = Math.hypot(dx, dz);
      const reach = MELEE.range + MOVE.capsuleRadius;
      if (distH > reach || Math.abs(dy) > 1.7) continue;
      const invLen = 1 / Math.max(1e-6, Math.hypot(dx, dy, dz));
      const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) * invLen;
      if (dot < MELEE.arcCos) continue;

      const hitY = a.eyeY + Math.tan(a.pitch) * distH;
      const headshot = hitY > t.body.position.y + 1.45 && dot > 0.86;
      const dmg = headshot ? Math.round(MELEE.damage * MELEE.headMult) : MELEE.damage;
      const wasAlive = t.alive;
      const dealt = t.applyDamage(dmg);
      a.stats.damageDealt += dealt;
      if (headshot) a.stats.headshots++;
      t.lastDamageTime = 0;
      t.lastAttackerId = a.id;
      // Shove: light knockback along punch direction.
      t.body.velocity.x += fwd.x * MELEE.knockback;
      t.body.velocity.z += fwd.z * MELEE.knockback;
      this.events.onMeleeHit(t, a, dealt, wasAlive && !t.alive, headshot);
      break;
    }
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
    return this.beginReload(a, w);
  }

  /** Start a staged reload and publish the edge exactly once. */
  private beginReload(a: Actor, w: NonNullable<Actor['inv']['selectedWeapon']>): boolean {
    const rt = a.wpn;
    const def = WEAPONS[w.weaponId];
    if (rt.reloadTimer > 0 || rt.swapTimer > 0 || a.healing) return false;
    if (w.ammoInMag >= def.magSize || a.inv.ammo[def.ammoType] <= 0) return false;
    rt.reloadingEmpty = w.ammoInMag === 0;
    rt.reloadTotal = (w.ammoInMag === 0 ? def.reloadEmpty : def.reloadTactical) * RARITY_MODS[w.rarity].reloadMult;
    rt.reloadTimer = rt.reloadTotal;
    rt.reloadWeaponId = w.weaponId;
    rt.reloadInitialAmmo = w.ammoInMag;
    rt.reloadRoundsLoaded = 0;
    this.events.onReloadStarted?.(a, rt.reloadingEmpty);
    return true;
  }

  updateWeaponTimers(a: Actor, dt: number): void {
    const rt = a.wpn;
    if (rt.fireCooldown > 0) rt.fireCooldown = Math.max(0, rt.fireCooldown - dt);
    if (rt.boltTimer > 0) rt.boltTimer -= dt;
    if (rt.lastShotTime < 90) rt.lastShotTime += dt;
    if (a.punchTimer > 0) a.punchTimer = Math.max(0, a.punchTimer - dt);

    // Bloom decay
    const w = a.inv.selectedWeapon;
    if (w) {
      const def = WEAPONS[w.weaponId];
      rt.bloom = Math.max(0, rt.bloom - def.bloomDecay * dt);
      rt.currentSpread = this.currentSpread(a);
    } else {
      rt.currentSpread = 0;
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

    // Staged reload progress. The simulation remains authoritative at the
    // round level: at each elapsed fraction we load the corresponding number
    // of rounds, consuming reserve only when that round enters the magazine.
    if (rt.reloadTimer > 0) {
      const wsel = a.inv.selectedWeapon;
      if (!wsel || rt.reloadWeaponId !== wsel.weaponId) {
        this.cancelReload(a);
      } else {
        this.advanceReload(a, wsel, dt);
      }
    }
    if (rt.swapTimer > 0) rt.swapTimer -= dt;
  }

  private advanceReload(a: Actor, w: NonNullable<Actor['inv']['selectedWeapon']>, dt: number): void {
    const rt = a.wpn;
    const total = Math.max(1e-6, rt.reloadTotal);
    const beforeTimer = Math.max(0, rt.reloadTimer);
    const elapsedBefore = Math.max(0, total - beforeTimer);
    const elapsedAfter = Math.min(total, elapsedBefore + Math.max(0, dt));
    const missing = Math.max(0, WEAPONS[w.weaponId].magSize - rt.reloadInitialAmmo);
    const targetLoaded = Math.min(missing, Math.floor((elapsedAfter / total) * missing + 1e-9));
    const requested = targetLoaded - rt.reloadRoundsLoaded;
    if (requested > 0) {
      const loaded = a.inv.loadReloadRounds(w, requested);
      rt.reloadRoundsLoaded += loaded;
    }

    rt.reloadTimer = Math.max(0, beforeTimer - Math.max(0, dt));
    // A depleted reserve cannot produce any further rounds. Ending the
    // animation here avoids a misleading reload state and leaves the
    // already-loaded magazine/reserve values untouched.
    const ammoType = WEAPONS[w.weaponId].ammoType;
    if (rt.reloadTimer <= 0
      || (a.inv.ammo[ammoType] <= 0 && rt.reloadRoundsLoaded < missing)) {
      rt.reloadTimer = 0;
      rt.reloadTotal = 0;
      rt.reloadingEmpty = false;
      rt.reloadWeaponId = null;
      rt.reloadInitialAmmo = 0;
      rt.reloadRoundsLoaded = 0;
    }
  }

  private cancelReload(a: Actor): void {
    const rt = a.wpn;
    rt.reloadTimer = 0;
    rt.reloadTotal = 0;
    rt.reloadingEmpty = false;
    rt.reloadWeaponId = null;
    rt.reloadInitialAmmo = 0;
    rt.reloadRoundsLoaded = 0;
  }

  /**
   * Live cone half-angle (radians) for the actor's next shot. Shared by the
   * firing path and per-tick weapon updates so UI reticles can mirror the
   * simulation's actual dispersion.
   */
  currentSpread(a: Actor): number {
    const w = a.inv.selectedWeapon;
    if (!w) return 0;
    const def = WEAPONS[w.weaponId];
    const rt = a.wpn;
    const mods = RARITY_MODS[w.rarity];
    const speedH = Math.hypot(a.body.velocity.x, a.body.velocity.z);
    const airPenalty = a.body.grounded ? 1 : 1.8;
    const movePenalty = 1 + Math.min(1.2, speedH / MOVE_REF_SPEED) * 0.8;
    const crouchBonus = a.crouched ? 0.72 : 1;
    const spreadBase = (rt.adsAmount > 0.6 ? def.spreadAds : def.spreadHip) * mods.spreadMult;
    return (spreadBase + rt.bloom) * movePenalty * airPenalty * crouchBonus;
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
        this.stepProjectile(p, sdt, actors, null);
      }
    }
  }

  /** Advance one projectile substep against a server-owned historical query. */
  stepProjectileWithQuery(
    p: Projectile,
    dt: number,
    actors: Actor[],
    query: ProjectileCollisionQuery,
  ): void {
    if (!p.active || !Number.isFinite(dt) || dt <= 0) return;
    this.stepProjectile(p, dt, actors, query);
  }

  private stepProjectile(
    p: Projectile,
    dt: number,
    actors: Actor[],
    query: ProjectileCollisionQuery | null,
  ): void {
    p.life -= dt;
    if (p.life <= 0) {
      p.active = false;
      return;
    }

    const startX = p.x;
    const startY = p.y;
    const startZ = p.z;
    const emitTracer = (x: number, y: number, z: number): void => {
      if (Math.hypot(x - startX, y - startY, z - startZ) > 1e-4) {
        this.events.onTracer(startX, startY, startZ, x, y, z, p.tracerColor);
      }
    };

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
    let cursorX = p.x;
    let cursorY = p.y;
    let cursorZ = p.z;
    let remaining = stepLen;
    let collisionPasses = 0;

    // A single fixed tick can cross several metres at firearm speeds. Resolve
    // the remainder of that segment after a glass pane is removed; otherwise
    // the old one-ray path advanced past an actor behind the pane and made the
    // first upper-floor hit look like a solid stop.
    while (remaining > 1e-5 && collisionPasses++ < 12) {
      const hit = query
        ? query.raycast(cursorX, cursorY, cursorZ, dx, dy, dz, remaining + 0.05)
        : this.liveProjectileRaycast(cursorX, cursorY, cursorZ, dx, dy, dz, remaining + 0.05);
      if (!hit || hit.dist > remaining + 1e-4) {
        cursorX += dx * remaining;
        cursorY += dy * remaining;
        cursorZ += dz * remaining;
        p.dist += remaining;
        remaining = 0;
        break;
      }

      const consumed = Math.min(remaining, Math.max(hit.dist, 0.01));
      p.dist += consumed;
      if (hit.kind === 'actor') {
        const target = actors.find((ac) => ac.id === hit.actorId);
        if (target && target.alive && target.id !== p.ownerId) {
          const attacker = this.attackerLookup?.(p.ownerId) ?? null;
          if (attacker && !this.canAffectActor(attacker, target)) {
            // Allied hit regions are transparent to friendly rounds. Advance
            // through this bounded swept segment and retain the remaining
            // travel so an enemy behind the ally can still be hit.
            cursorX = hit.point.x + dx * 0.05;
            cursorY = hit.point.y + dy * 0.05;
            cursorZ = hit.point.z + dz * 0.05;
            remaining = Math.max(0, remaining - Math.max(consumed, 0.05));
            continue;
          }
          emitTracer(hit.point.x, hit.point.y, hit.point.z);
          this.resolveActorHit(p, target, hit.point.x, hit.point.y, hit.point.z, hit.region);
          p.active = false;
          return;
        }
        // Own collider or dead actor: advance beyond the hit and continue.
        cursorX = hit.point.x + dx * 0.05;
        cursorY = hit.point.y + dy * 0.05;
        cursorZ = hit.point.z + dz * 0.05;
        remaining = Math.max(0, remaining - Math.max(consumed, 0.05));
        continue;
      }

      if (hit.kind === 'destructible') {
        const d = this.destructibles.get(hit.destructibleId);
        let removed = false;
        if (d && d.alive) {
          emitTracer(hit.point.x, hit.point.y, hit.point.z);
          d.hp -= p.damage;
          const gone = d.type === 'glass' || d.hp <= 0;
          if (gone) {
            removed = true;
            d.alive = false;
            d.revision = (d.revision + 1) >>> 0;
            this.phys.removeCollider(d.collider as never);
            if (d.type === 'glass') this.events.onGlassBreak(d.stableId, d.geo.x, d.geo.y, d.geo.z, p.ownerId);
            else this.events.onDestructibleDamaged(hit.destructibleId, d.stableId, d.geo.x, d.geo.y, d.geo.z, true);
          } else {
            this.events.onDestructibleDamaged(hit.destructibleId, d.stableId, hit.point.x, hit.point.y, hit.point.z, false);
          }
        }
        const destructibleType = d?.type ?? hit.destructibleType;
        query?.onDestructibleResolved?.(hit, removed || destructibleType === 'glass');
        if (destructibleType !== 'glass') {
          // Historical non-glass remains an obstruction even if a later live
          // revision has already removed it. Applying damage is still guarded
          // by the current authoritative `alive` state above.
          this.events.onImpact(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z, hit.material, true);
          p.active = false;
          return;
        }
        // Glass is transparent after the one authoritative break edge. Keep
        // the remainder so an actor immediately behind the pane remains hit.
        cursorX = hit.point.x + dx * 0.05;
        cursorY = hit.point.y + dy * 0.05;
        cursorZ = hit.point.z + dz * 0.05;
        remaining = Math.max(0, remaining - Math.max(consumed, 0.05));
        continue;
      }

      // World geometry (or unknown): impact or ricochet.
      const shallowDot = -(dx * hit.normal.x + dy * hit.normal.y + dz * hit.normal.z);
      const canRicochet =
        p.weaponId === 'sniper' && p.ricochets < 1 && shallowDot < 0.22;
      if (canRicochet) {
        emitTracer(hit.point.x, hit.point.y, hit.point.z);
        p.ricochets++;
        // Reflect velocity.
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
      emitTracer(hit.point.x, hit.point.y, hit.point.z);
      this.events.onImpact(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z, 'stone', true);
      p.active = false;
      return;
    }

    p.x = cursorX;
    p.y = cursorY;
    p.z = cursorZ;

    // Publish the segment that was actually simulated. This keeps the tracer
    // event path alive even though renderers do not poll projectile state.
    emitTracer(p.x, p.y, p.z);
  }

  private liveProjectileRaycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): ProjectileCollisionHit | null {
    const hit = this.phys.raycast(ox, oy, oz, dx, dy, dz, maxDist);
    if (!hit) return null;
    const meta = this.phys.metaOf(hit.collider);
    const base = { point: hit.point, normal: hit.normal, dist: hit.dist };
    if (meta?.kind === 'actor') {
      return { ...base, kind: 'actor', actorId: meta.actorId, region: meta.region };
    }
    if (meta?.kind === 'destructible') {
      const d = this.destructibles.get(meta.id);
      return {
        ...base,
        kind: 'destructible',
        destructibleId: meta.id,
        stableId: d?.stableId ?? `destructible:${meta.id}`,
        destructibleType: d?.type ?? 'unknown',
        material: meta.material,
      };
    }
    return { ...base, kind: 'world', material: 'stone' };
  }

  private resolveActorHit(p: Projectile, target: Actor, hx: number, hy: number, hz: number, region: string): void {
    const attacker = this.attackerLookup?.(p.ownerId) ?? null;
    if (attacker && !this.canAffectActor(attacker, target)) return;
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
      d.revision = (d.revision + 1) >>> 0;
      this.phys.removeCollider(d.collider as never);
      if (d.type === 'glass') this.events.onGlassBreak(d.stableId, d.geo.x, d.geo.y, d.geo.z, -1);
      else this.events.onDestructibleDamaged(id, d.stableId, d.geo.x, d.geo.y, d.geo.z, true);
      return true;
    }
    return false;
  }

  destructibleList(): DestructibleRef[] {
    return [...this.destructibles.values()];
  }

  /** Iterate the authoritative map without allocating a snapshot. */
  forEachDestructible(fn: (destructible: DestructibleRef) => void): void {
    this.destructibles.forEach(fn);
  }

  destructibleCount(): number {
    return this.destructibles.size;
  }

  aliveGlassCount(): number {
    let count = 0;
    this.destructibles.forEach((destructible) => {
      if (destructible.type === 'glass' && destructible.alive) count++;
    });
    return count;
  }

  private alloc(): Projectile {
    for (const p of this.projectiles) {
      if (!p.active) return p;
    }
    // Saturation must not produce a fake shot (ammo/audio/flash with no
    // projectile). Recycle the projectile closest to natural expiry so a new
    // trigger pull always has a physical round while disturbing the least
    // remaining flight time.
    return this.projectiles.reduce((oldest, candidate) => (
      candidate.life < oldest.life ? candidate : oldest
    ), this.projectiles[0]!);
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

function finitePoint(point: Readonly<{ x: number; y: number; z: number }>): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function normalizeDirection(
  direction: Readonly<{ x: number; y: number; z: number }>,
): { x: number; y: number; z: number } | null {
  if (!finitePoint(direction)) return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length < 1e-6) return null;
  return {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
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
