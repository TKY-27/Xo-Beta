/**
 * Actor: one combatant (human or bot). Holds all authoritative simulation
 * state; controllers only write InputCommands.
 */

import type { BotPersonality, HitRegion, WeaponId } from '../core/balance';
import { HEALTH_MAX, SHIELD_MAX } from '../core/balance';
import { eyeYFromBodyCenter, type CharBody } from '../physics/physics';
import { Inventory } from './inventory';

export type MoveState =
  | 'ground' | 'air' | 'slide' | 'wallrun' | 'mantle'
  | 'grapple' | 'poundWindup' | 'poundFall' | 'swim'
  | 'freefall' | 'glide';

export interface WeaponRuntime {
  fireCooldown: number;
  /** > 0 while reloading; counts down. */
  reloadTimer: number;
  reloadTotal: number;
  reloadingEmpty: boolean;
  /** Weapon being incrementally filled; null when no reload is active. */
  reloadWeaponId: WeaponId | null;
  /** Magazine count at reload start, used to derive deterministic progress. */
  reloadInitialAmmo: number;
  /** Number of rounds already transferred during this reload. */
  reloadRoundsLoaded: number;
  boltTimer: number;
  bloom: number;
  recoilPitch: number;
  recoilYaw: number;
  adsAmount: number;
  swapTimer: number;
  lastShotTime: number;
  /** Live cone half-angle (radians) the next shot disperses within. */
  currentSpread: number;
}

export interface HealRuntime {
  itemId: 'medkit' | 'shieldpot';
  remaining: number;
  total: number;
}

export interface ActorStats {
  kills: number;
  damageDealt: number;
  shotsFired: number;
  shotsHit: number;
  headshots: number;
  survivalTime: number;
}

export class Actor {
  /** Match-local identity shared with every collider on this body. */
  readonly id: number;
  readonly name: string;
  readonly isPlayer: boolean;
  personality: BotPersonality | null;
  accentColor: number;

  body: CharBody;
  yaw = 0;
  pitch = 0;

  health = HEALTH_MAX;
  shield = SHIELD_MAX;
  alive = true;
  placement = 0;
  eliminatedById = -1;
  deathTime = -1;

  inv = new Inventory();
  wpn: WeaponRuntime = {
    fireCooldown: 0,
    reloadTimer: 0,
    reloadTotal: 0,
    reloadingEmpty: false,
    reloadWeaponId: null,
    reloadInitialAmmo: 0,
    reloadRoundsLoaded: 0,
    boltTimer: 0,
    bloom: 0,
    recoilPitch: 0,
    recoilYaw: 0,
    adsAmount: 0,
    swapTimer: 0,
    lastShotTime: -99,
    currentSpread: 0,
  };
  healing: HealRuntime | null = null;

  // Movement state
  state: MoveState = 'ground';
  crouched = false;
  slideTimer = 0;
  slideDirX = 0;
  slideDirZ = 0;
  slideCooldown = 0;
  wallrunTimer = 0;
  wallSide = 0; // -1 left, +1 right
  wallNormalX = 0;
  wallNormalZ = 0;
  mantleTimer = 0;
  mantleFrom = { x: 0, y: 0, z: 0 };
  mantleTo = { x: 0, y: 0, z: 0 };
  grappleActive = false;
  grapplePoint = { x: 0, y: 0, z: 0 };
  grappleCooldown = 0;
  dashCharges = 2;
  dashRegen = 0;
  dashTimer = 0;
  dashDirX = 0;
  dashDirZ = 0;
  jumpsUsed = 0;
  coyote = 0;
  jumpBuffered = 0;
  bhopWindow = 0;
  /** Anti-exploit: blocks wallrun re-entry for a short time after leaving a wall. */
  wallrunCooldown = 0;
  /** True once the actor has touched the ground since its last wall jump. */
  wallrunLanded = true;
  /** Consecutive wall runs since last grounded contact (anti-elevator cap). */
  wallrunChains = 0;
  lastWallNx = 0;
  lastWallNz = 0;
  peakFallSpeed = 0;
  /** Debug/QA invariant: seconds spent in a ground-locomotion state while the
   * physics body reports airborne. Sustained nonzero values indicate an
   * impossible "floating bot" state. */
  airborneGroundTime = 0;
  /** Melee presentation timer: counts down from MELEE_PUNCH_TIME while a
   * punch is animating. */
  punchTimer = 0;
  /** Render-side interaction animation timer (chest open / loot pickup). */
  interactTimer = 0;
  poundTimer = 0;
  footstepAccum = 0;
  inWater = false;
  submerged = false;
  waterSurfaceY = -Infinity;

  // Drop phase
  deployed = false;

  // Combat bookkeeping
  lastDamageTime = -99;
  lastAttackerId = -1;
  /** Set each tick from the controller command (used by weapon timers). */
  adsHeld = false;
  stats: ActorStats = {
    kills: 0, damageDealt: 0, shotsFired: 0, shotsHit: 0, headshots: 0, survivalTime: 0,
  };

  constructor(name: string, isPlayer: boolean, body: CharBody, accentColor: number, personality: BotPersonality | null = null) {
    // Collider metadata is authoritative for projectile hit resolution. A
    // module-global actor counter used to diverge from the 1..10 collider IDs
    // on the second headless match in one process, making every bullet miss.
    this.id = body.actorId;
    this.name = name;
    this.isPlayer = isPlayer;
    this.body = body;
    this.accentColor = accentColor;
    this.personality = personality;
  }

  get eyeY(): number {
    return eyeYFromBodyCenter(this.body.position.y, this.crouched);
  }

  get position(): { x: number; y: number; z: number } {
    return this.body.position;
  }

  effectiveHealth(): number {
    return this.health + this.shield;
  }

  maxEffectiveHealth(): number {
    return HEALTH_MAX + SHIELD_MAX;
  }

  /** Apply damage after regional multiplier. Shield absorbs first.
   * Returns total dealt; sets lastShieldDamage/lastShieldBroken for event plumbing. */
  lastShieldDamage = 0;
  lastShieldBroken = false;

  applyDamage(amount: number): number {
    let dmg = amount;
    let dealt = 0;
    this.lastShieldDamage = 0;
    this.lastShieldBroken = false;
    if (this.shield > 0) {
      const toShield = Math.min(this.shield, dmg);
      this.shield -= toShield;
      dmg -= toShield;
      dealt += toShield;
      this.lastShieldDamage = toShield;
      if (this.shield <= 0) this.lastShieldBroken = true;
    }
    if (dmg > 0) {
      const toHealth = Math.min(this.health, dmg);
      this.health -= toHealth;
      dealt += toHealth;
    }
    if (this.health <= 0 && this.alive) {
      this.alive = false;
    }
    return dealt;
  }

  healHealth(amount: number): void {
    this.health = Math.min(HEALTH_MAX, this.health + amount);
  }

  addShield(amount: number): void {
    this.shield = Math.min(SHIELD_MAX, this.shield + amount);
  }
}

export type HitRegionName = HitRegion;
