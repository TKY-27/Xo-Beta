/**
 * Xo Beta — centralized game balance configuration.
 * Every tunable gameplay number lives here (or in map data), never scattered.
 *
 * World scale convention: 1 unit ~= one character step (~0.75 m).
 * Character height ~2.3u. Maps are ~500x500 units.
 */

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;

export type AmmoType = 'light' | 'medium' | 'shells' | 'heavy';
export type WeaponId = 'pistol' | 'shotgun' | 'ar' | 'smg' | 'sniper';

/** Melee (fists) balance. Permanent pseudo-weapon; Q selects it. */
export const MELEE = {
  name: 'Fists',
  /** Punches per minute. */
  rpm: 150,
  damage: 18,
  headMult: 1.5,
  range: 2.4,
  /** Horizontal cone half-angle for hit detection (rad). */
  arcCos: 0.5,
  radius: 0.9,
  knockback: 3.2,
} as const;

export interface WeaponDef {
  id: WeaponId;
  name: string;
  fireMode: 'semi' | 'auto' | 'bolt' | 'pump';
  rpm: number;
  /** Damage per bullet/pellet by rarity index (common..legendary). */
  damage: [number, number, number, number, number];
  pellets: number;
  magSize: number;
  reserveMax: number;
  ammoType: AmmoType;
  projectileSpeed: number;
  /** Fraction of world gravity applied to the projectile. */
  dropGravity: number;
  /** Cone half-angle radians, hip fire, standing. */
  spreadHip: number;
  spreadAds: number;
  /** Bloom added per shot (rad) and recovery per second. */
  bloomPerShot: number;
  bloomDecay: number;
  bloomMax: number;
  recoilKick: number;
  recoilRecover: number;
  adsTime: number;
  reloadTactical: number;
  reloadEmpty: number;
  swapInTime: number;
  /** Falloff: full damage until start, linear to endMult at end distance. */
  falloffStart: number;
  falloffEnd: number;
  falloffEndMult: number;
  headMult: number;
  legMult: number;
  /** Movement speed multiplier while held (heavy weapons slower). */
  mobility: number;
  tracerColor: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    // Semi-auto: one deliberate click per round, with a realistic 200 ms
    // minimum cycle time (300 rounds/minute).
    id: 'pistol', name: 'P9 Sidearm', fireMode: 'semi', rpm: 300,
    damage: [26, 29, 32, 35, 38], pellets: 1, magSize: 15, reserveMax: 240, ammoType: 'light',
    projectileSpeed: 340, dropGravity: 0.55,
    spreadHip: 0.017, spreadAds: 0.004, bloomPerShot: 0.006, bloomDecay: 0.05, bloomMax: 0.045,
    recoilKick: 0.011, recoilRecover: 7, adsTime: 0.16,
    reloadTactical: 1.5, reloadEmpty: 2.1, swapInTime: 0.35,
    falloffStart: 45, falloffEnd: 110, falloffEndMult: 0.6,
    headMult: 2.0, legMult: 0.75, mobility: 1.0, tracerColor: 0xffd27a,
  },
  smg: {
    id: 'smg', name: 'Viper SMG', fireMode: 'auto', rpm: 900,
    damage: [17, 18, 19, 20, 21], pellets: 1, magSize: 32, reserveMax: 480, ammoType: 'light',
    projectileSpeed: 380, dropGravity: 0.6,
    spreadHip: 0.03, spreadAds: 0.014, bloomPerShot: 0.0045, bloomDecay: 0.07, bloomMax: 0.08,
    recoilKick: 0.0075, recoilRecover: 8, adsTime: 0.19,
    reloadTactical: 1.9, reloadEmpty: 2.6, swapInTime: 0.4,
    falloffStart: 28, falloffEnd: 75, falloffEndMult: 0.5,
    headMult: 1.7, legMult: 0.8, mobility: 0.98, tracerColor: 0x9adcff,
  },
  ar: {
    id: 'ar', name: 'Kestrel AR', fireMode: 'auto', rpm: 700,
    damage: [24, 26, 28, 30, 32], pellets: 1, magSize: 30, reserveMax: 360, ammoType: 'medium',
    projectileSpeed: 480, dropGravity: 0.5,
    spreadHip: 0.02, spreadAds: 0.005, bloomPerShot: 0.005, bloomDecay: 0.06, bloomMax: 0.06,
    recoilKick: 0.010, recoilRecover: 6.5, adsTime: 0.24,
    reloadTactical: 2.2, reloadEmpty: 3.0, swapInTime: 0.45,
    falloffStart: 60, falloffEnd: 160, falloffEndMult: 0.68,
    headMult: 1.9, legMult: 0.78, mobility: 0.94, tracerColor: 0xffb36b,
  },
  shotgun: {
    id: 'shotgun', name: 'Breacher 12', fireMode: 'pump', rpm: 60,
    damage: [11, 12.5, 14, 17.5, 22], pellets: 10, magSize: 6, reserveMax: 96, ammoType: 'shells',
    projectileSpeed: 300, dropGravity: 0.7,
    spreadHip: 0.055, spreadAds: 0.042, bloomPerShot: 0.002, bloomDecay: 0.05, bloomMax: 0.01,
    recoilKick: 0.035, recoilRecover: 5, adsTime: 0.22,
    reloadTactical: 0.62, reloadEmpty: 0.62, swapInTime: 0.5,
    falloffStart: 11, falloffEnd: 38, falloffEndMult: 0.22,
    headMult: 1.6, legMult: 0.85, mobility: 0.92, tracerColor: 0xffe0a0,
  },
  sniper: {
    id: 'sniper', name: 'Longview Mk2', fireMode: 'bolt', rpm: 40,
    damage: [100, 115, 140, 205, 230], pellets: 1, magSize: 5, reserveMax: 60, ammoType: 'heavy',
    projectileSpeed: 900, dropGravity: 0.22,
    spreadHip: 0.05, spreadAds: 0.0008, bloomPerShot: 0.01, bloomDecay: 0.04, bloomMax: 0.02,
    recoilKick: 0.05, recoilRecover: 4, adsTime: 0.34,
    reloadTactical: 2.6, reloadEmpty: 3.4, swapInTime: 0.6,
    falloffStart: 300, falloffEnd: 500, falloffEndMult: 0.85,
    headMult: 2.2, legMult: 0.8, mobility: 0.88, tracerColor: 0xbfd4ff,
  },
};

/** Per-rarity global modifiers applied on top of the weapon class def. */
export interface RarityMods {
  reloadMult: number;
  spreadMult: number;
  recoilMult: number;
  adsMult: number;
  projSpeedMult: number;
}

export const RARITY_MODS: Record<Rarity, RarityMods> = {
  common:    { reloadMult: 1.0,  spreadMult: 1.0,  recoilMult: 1.0,  adsMult: 1.0,  projSpeedMult: 1.0 },
  uncommon:  { reloadMult: 0.96, spreadMult: 0.95, recoilMult: 0.95, adsMult: 0.97, projSpeedMult: 1.02 },
  rare:      { reloadMult: 0.92, spreadMult: 0.9,  recoilMult: 0.9,  adsMult: 0.94, projSpeedMult: 1.05 },
  epic:      { reloadMult: 0.88, spreadMult: 0.85, recoilMult: 0.84, adsMult: 0.9,  projSpeedMult: 1.08 },
  legendary: { reloadMult: 0.82, spreadMult: 0.8,  recoilMult: 0.76, adsMult: 0.86, projSpeedMult: 1.12 },
};

export const RARITY_COLORS: Record<Rarity, number> = {
  common: 0x9aa3ad,
  uncommon: 0x3fbf5f,
  rare: 0x3f8fdf,
  epic: 0xa45fd6,
  legendary: 0xf0a63a,
};

export const RARITY_CSS: Record<Rarity, string> = {
  common: '#9aa3ad',
  uncommon: '#4ecb6d',
  rare: '#4f9fe8',
  epic: '#b06ce8',
  legendary: '#ffb43a',
};

/**
 * Floor-loot rarity weights (index-aligned with RARITIES).
 * Epic and Legendary are chest/reward exclusives — floor loot tops out at
 * Rare, with progressively scarcer tiers.
 */
export const FLOOR_RARITY_WEIGHTS = [46, 32, 22, 0, 0] as const;

export type ChestKind = 'standard' | 'elite' | 'vault';

export const CHESTS: Record<ChestKind, {
  name: string;
  rarityWeights: readonly number[];
  rolls: [number, number];
  healChance: number;
  glowColor: number;
}> = {
  standard: { name: 'Chest', rarityWeights: [50, 35, 15, 0, 0], rolls: [1, 2], healChance: 0.45, glowColor: 0x66c2ff },
  elite: { name: 'Elite Chest', rarityWeights: [0, 10, 60, 30, 0], rolls: [2, 3], healChance: 0.6, glowColor: 0xc06bff },
  vault: { name: 'Vault Cache', rarityWeights: [0, 0, 5, 55, 40], rolls: [3, 4], healChance: 0.8, glowColor: 0xffb43a },
};

export type HealItemId = 'medkit' | 'shieldpot';

export interface HealItemDef {
  id: HealItemId;
  name: string;
  stackSize: number;
  useTime: number;
  moveSpeedMult: number;
  amount: number;
  color: number;
}

export const HEAL_ITEMS: Record<HealItemId, HealItemDef> = {
  medkit: { id: 'medkit', name: 'Med Kit', stackSize: 2, useTime: 5.0, moveSpeedMult: 0.25, amount: 75, color: 0xff5f6d },
  shieldpot: { id: 'shieldpot', name: 'Shield Cell', stackSize: 3, useTime: 3.0, moveSpeedMult: 0.25, amount: 50, color: 0x53d8ff },
};

export const AMMO_PICKUP_AMOUNTS: Record<AmmoType, number> = {
  light: 72, medium: 60, shells: 16, heavy: 12,
};

// ---------------------------------------------------------------------------
// Combatants
// ---------------------------------------------------------------------------

export const HEALTH_MAX = 100;
export const SHIELD_MAX = 100;

export const HIT_REGION_MULT = {
  head: 2.0,
  chest: 1.0,
  abdomen: 0.9,
  arms: 0.75,
  legs: 0.7,
} as const;

export type HitRegion = keyof typeof HIT_REGION_MULT;

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export const MOVE = {
  // Readable Fortnite-like jump arc: a softer rise and slightly firmer fall
  // keep the apex controllable without making landings feel weightless.
  gravity: 24.5,
  jumpRiseGravityScale: 0.92,
  fallGravityScale: 1.15,
  walkSpeed: 6.6,
  sprintSpeed: 10.8,
  crouchSpeed: 4.4,
  adsMoveMult: 0.6,
  // Acceleration coefficients (gain rate = coeff * wishSpeed):
  // ground reaches sprint in ~0.15s, air steering is meaningful but
  // momentum-preserving instead of the old instant redirects.
  accelGround: 13,
  accelAir: 4.0,
  frictionGround: 11,
  stopSpeed: 2.4,

  jumpVel: 9.2,
  sprintJumpMultiplier: 1.06,
  doubleJumpVel: 8.7,
  maxJumps: 2,
  coyoteTime: 0.12,
  jumpBufferTime: 0.12,

  dashSpeed: 23,
  dashDuration: 0.16,
  dashChargesGround: 2,
  dashChargesAir: 1,
  dashRegenTime: 3.0,

  slideBoostMin: 13.5,
  slideBoostAdd: 4.0,
  slideFriction: 4.2,
  slideMinEntrySpeed: 6.5,
  slideCooldown: 1.1,
  slideMinHeight: 1.35,

  wallRunMinSpeed: 6.0,
  wallRunMaxTime: 1.9,
  wallRunGravityScale: 0.18,
  wallRunStickAccel: 14,
  wallRunMinHeight: 1.0,
  wallJumpUpVel: 9.4,
  wallJumpOutVel: 8.5,
  wallrunReentryCooldown: 0.5,
  wallRunSameWallDot: 0.985,
  wallRunMaxChains: 2,

  mantleMaxLedge: 2.7,
  mantleMinDepth: 0.5,
  mantleDuration: 0.42,

  grappleRange: 72,
  grappleCooldown: 6.0,
  grapplePullAccel: 58,
  grappleMaxSpeed: 36,
  grappleDetachDot: -0.15,

  poundWindup: 0.16,
  poundFallSpeed: 46,
  poundRadius: 6.5,
  poundDamageMax: 45,
  poundKnockback: 12,

  bhopWindow: 0.1,
  softSpeedCap: 16.5,

  fallDamageMinSpeed: 15,
  fallDamageMaxSpeed: 34,
  fallDamageMax: 100,

  swimSurfaceSpeed: 5.2,
  swimDiveSpeed: 4.6,
  waterDrag: 3.2,

  eyeHeight: 2.05,
  crouchEyeHeight: 1.35,
  capsuleRadius: 0.42,
  capsuleHalfHeight: 1.15,
  stepHeight: 0.68,
} as const;

// ---------------------------------------------------------------------------
// Storm — tuned for 500x500 maps, 10 combatants, ~15-20 minute matches.
// ---------------------------------------------------------------------------

export interface StormPhase {
  /** Seconds the current circle holds before shrinking. */
  wait: number;
  /** Seconds the shrink takes. */
  shrink: number;
  /** Target radius (units) after this phase completes. */
  radius: number;
  /** Damage per second outside the circle during this phase. */
  dps: number;
}

export const STORM_PHASES: readonly StormPhase[] = [
  { wait: 220, shrink: 65, radius: 195, dps: 1 },
  { wait: 145, shrink: 60, radius: 128, dps: 1.5 },
  { wait: 110, shrink: 55, radius: 80, dps: 2 },
  { wait: 85, shrink: 50, radius: 48, dps: 3 },
  { wait: 55, shrink: 40, radius: 26, dps: 5 },
  { wait: 45, shrink: 35, radius: 12, dps: 8 },
  { wait: 30, shrink: 30, radius: 3.5, dps: 10 },
  { wait: 25, shrink: 25, radius: 0.5, dps: 12 },
];

export const STORM_INITIAL_RADIUS = 340;

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

export const MATCH = {
  combatantCount: 10,
  transportAltitude: 120,
  transportSpeed: 26,
  /** Drop-rig hang distance below the transport center (hull radius ≈ 3.4). */
  transportHangOffset: 5.6,
  freefallDiveSpeed: 52,
  glideFallSpeed: 7.5,
  glideForwardSpeed: 21,
  deployAltitude: 55,
} as const;

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

export type Difficulty = 'normal' | 'hard' | 'elite' | 'nightmare';

export interface DifficultyProfile {
  name: Difficulty;
  /** Base reaction delay seconds (before difficulty modifiers). */
  reaction: number;
  /** Aim error standard deviation in radians at reference range. */
  aimError: number;
  /** How fast the bot's aim tracks its target point (rad/s). */
  trackSpeed: number;
  /** Decision re-evaluation interval seconds. */
  decideInterval: number;
  /** Probability of using advanced movement when useful. */
  moveSkill: number;
  /** Multiplier on perception memory quality. */
  awareness: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  normal:    { name: 'normal',    reaction: 0.55, aimError: 0.055, trackSpeed: 3.2, decideInterval: 0.5, moveSkill: 0.25, awareness: 0.7 },
  hard:      { name: 'hard',      reaction: 0.38, aimError: 0.034, trackSpeed: 5.0, decideInterval: 0.35, moveSkill: 0.5, awareness: 0.9 },
  elite:     { name: 'elite',     reaction: 0.26, aimError: 0.02,  trackSpeed: 7.5, decideInterval: 0.25, moveSkill: 0.75, awareness: 1.05 },
  nightmare: { name: 'nightmare', reaction: 0.18, aimError: 0.012, trackSpeed: 10,  decideInterval: 0.18, moveSkill: 0.95, awareness: 1.2 },
};

export interface BotPersonality {
  id: string;
  name: string;
  accentColor: number;
  /** Elite benchmark bots keep maximum reasoning regardless of difficulty. */
  elite: boolean;
  aggression: number;
  caution: number;
  lootGreed: number;
  preferredRange: number;
  ambush: number;
  thirdParty: number;
  rotationDiscipline: number;
  aimSkill: number;
  baseSkill: number;
}

export const BOT_PERSONALITIES: readonly BotPersonality[] = [
  { id: 'vex',   name: 'VEX',   accentColor: 0x7ad7ff, elite: true,  aggression: 0.75, caution: 0.45, lootGreed: 0.5, preferredRange: 55, ambush: 0.4, thirdParty: 0.6, rotationDiscipline: 0.8, aimSkill: 1.0,  baseSkill: 1.0 },
  { id: 'razor', name: 'RAZOR', accentColor: 0xff5f5f, elite: true,  aggression: 0.95, caution: 0.2,  lootGreed: 0.4, preferredRange: 12, ambush: 0.5, thirdParty: 0.7, rotationDiscipline: 0.5, aimSkill: 0.9,  baseSkill: 1.0 },
  { id: 'orbit', name: 'ORBIT', accentColor: 0xa98bff, elite: true,  aggression: 0.5,  caution: 0.7,  lootGreed: 0.75, preferredRange: 40, ambush: 0.6, thirdParty: 0.9, rotationDiscipline: 1.0, aimSkill: 0.88, baseSkill: 1.0 },
  { id: 'nova',  name: 'NOVA',  accentColor: 0x7dffc4, elite: false, aggression: 0.6,  caution: 0.5,  lootGreed: 0.55, preferredRange: 30, ambush: 0.4, thirdParty: 0.5, rotationDiscipline: 0.65, aimSkill: 0.7, baseSkill: 0.75 },
  { id: 'ghost', name: 'GHOST', accentColor: 0xc9d4dd, elite: false, aggression: 0.45, caution: 0.75, lootGreed: 0.5, preferredRange: 20, ambush: 0.95, thirdParty: 0.6, rotationDiscipline: 0.6, aimSkill: 0.72, baseSkill: 0.7 },
  { id: 'kira',  name: 'KIRA',  accentColor: 0xff8ac2, elite: false, aggression: 0.9,  caution: 0.3,  lootGreed: 0.35, preferredRange: 18, ambush: 0.35, thirdParty: 0.75, rotationDiscipline: 0.4, aimSkill: 0.75, baseSkill: 0.72 },
  { id: 'hex',   name: 'HEX',   accentColor: 0xd6ff5f, elite: false, aggression: 0.55, caution: 0.55, lootGreed: 0.8, preferredRange: 25, ambush: 0.55, thirdParty: 0.85, rotationDiscipline: 0.55, aimSkill: 0.68, baseSkill: 0.68 },
  { id: 'axis',  name: 'AXIS',  accentColor: 0xffb35f, elite: false, aggression: 0.4,  caution: 0.7,  lootGreed: 0.5, preferredRange: 60, ambush: 0.3, thirdParty: 0.45, rotationDiscipline: 0.85, aimSkill: 0.74, baseSkill: 0.7 },
  { id: 'zero',  name: 'ZERO',  accentColor: 0x8fa8ff, elite: false, aggression: 0.35, caution: 0.85, lootGreed: 0.6, preferredRange: 35, ambush: 0.5, thirdParty: 0.4, rotationDiscipline: 0.95, aimSkill: 0.66, baseSkill: 0.66 },
];

// ---------------------------------------------------------------------------
// Misc gameplay constants
// ---------------------------------------------------------------------------

export const GAMEPLAY = {
  /** Max distance at which footstep sounds generate perception events. */
  footstepHearingRange: 34,
  gunshotHearingRange: 160,
  interactionRange: 3.2,
  pickupRadius: 2.2,
  /** Seconds before a dropped inventory item becomes pickable by its dropper. */
  dropPickupDelaySelf: 0.8,
  spectatorSwitchCooldown: 0.4,
} as const;

export const SIM = {
  fixedDt: 1 / 60,
  maxFrameDt: 0.25,
} as const;
