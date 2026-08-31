import type { AmmoType, HealItemId, Rarity, WeaponId } from '../core/balance';
import type { SkinId } from '../core/settings';
import type { MoveState } from './actor';
import type { AmmoPools, InventoryItem } from './inventory';
import type { MatchPhase } from './match';
import type { WorldItemKind } from './loot';
import type { ActorOwnership, ConnectionState, MatchMode, TeamId } from './roster';
import type { Storm } from './storm';

export interface ActorView {
  readonly id: number;
  readonly displayName: string;
  readonly ownership: Readonly<ActorOwnership>;
  readonly connectionState: ConnectionState;
  readonly teamId: TeamId | null;
  readonly skinId: SkinId;
  readonly accentColor: number;
  readonly alive: boolean;
  readonly health: number;
  readonly shield: number;
  readonly position: Readonly<{ x: number; y: number; z: number }>;
  readonly velocity: Readonly<{ x: number; y: number; z: number }>;
  readonly yaw: number;
  readonly pitch: number;
  readonly grounded: boolean;
  readonly moveState: MoveState;
  readonly crouched: boolean;
  readonly deployed: boolean;
  readonly equippedWeapon: WeaponId | null;
  /** Only the owning participant receives inventory/ammo contents over the network. */
  readonly inventory: InventoryView | null;
  readonly placement: number;
  readonly stats: Readonly<{
    kills: number;
    damageDealt: number;
    shotsFired: number;
    shotsHit: number;
    headshots: number;
    survivalTime: number;
  }>;
}

export interface InventoryView {
  readonly selected: number;
  readonly slots: readonly (Readonly<InventoryItem> | null)[];
  readonly ammo: Readonly<AmmoPools>;
  readonly healing: Readonly<{ itemId: 'medkit' | 'shieldpot'; remaining: number; total: number }> | null;
}

export interface DestructibleView {
  readonly id: string;
  readonly revision: number;
  readonly destroyed: boolean;
}

export interface TransportView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Host-owned drop gate; guests may predict deployment only while true. */
  readonly jumpAllowed: boolean;
}

/** Owner-scoped mobility runtime used only to restore the local guest's
 * shared movement predictor before replay. Gameplay authority (health,
 * inventory, damage, loot, and results) is deliberately absent. */
export interface LocalMovementView {
  readonly actorId: number;
  readonly groundNormalY: number;
  readonly hitCeiling: boolean;
  readonly slidAlongWall: boolean;
  readonly slideTimer: number;
  readonly slideDirX: number;
  readonly slideDirZ: number;
  readonly slideCooldown: number;
  readonly wallrunTimer: number;
  readonly wallSide: number;
  readonly wallNormalX: number;
  readonly wallNormalZ: number;
  readonly mantleTimer: number;
  readonly mantleCooldown: number;
  readonly mantleFrom: Readonly<{ x: number; y: number; z: number }>;
  readonly mantleTo: Readonly<{ x: number; y: number; z: number }>;
  readonly grappleActive: boolean;
  readonly grapplePoint: Readonly<{ x: number; y: number; z: number }>;
  readonly grappleCooldown: number;
  readonly dashCharges: number;
  readonly dashRegen: number;
  readonly dashTimer: number;
  readonly dashDirX: number;
  readonly dashDirZ: number;
  readonly jumpsUsed: number;
  readonly coyote: number;
  readonly jumpBuffered: number;
  readonly bhopWindow: number;
  readonly wallrunCooldown: number;
  readonly wallrunLanded: boolean;
  readonly wallrunChains: number;
  readonly lastWallNx: number;
  readonly lastWallNz: number;
  readonly peakFallSpeed: number;
  readonly airborneGroundTime: number;
  readonly poundTimer: number;
  readonly footstepAccum: number;
  readonly inWater: boolean;
  readonly submerged: boolean;
  /** Null represents the actor's internal no-water sentinel. */
  readonly waterSurfaceY: number | null;
  readonly adsAmount: number;
  readonly healingMovementPenalty: boolean;
}

export interface ChestView {
  readonly id: number;
  readonly kind: 'standard' | 'elite' | 'vault';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly opened: boolean;
}

interface LootViewBase {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly rarity: Rarity;
}

/** Public world-loot identity. This is visible on the map and is not an
 * actor's private inventory. */
export type LootView =
  | (LootViewBase & {
    readonly kind: Extract<WorldItemKind, 'weapon'>;
    readonly weaponId: WeaponId;
    readonly ammoInMag: number;
  })
  | (LootViewBase & {
    readonly kind: Extract<WorldItemKind, 'ammo'>;
    readonly ammoType: AmmoType;
    readonly amount: number;
  })
  | (LootViewBase & {
    readonly kind: Extract<WorldItemKind, 'heal'>;
    readonly itemId: HealItemId;
    readonly count: number;
  });

export interface StormView {
  readonly state: Storm['state'];
  readonly phaseIndex: number;
  readonly timer: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
}

export interface TeamMemberView {
  readonly actorId: number;
  readonly slotId: number;
  readonly displayName: string;
  readonly accentColor: number;
  readonly alive: boolean;
  readonly connectionState: ConnectionState;
}

export interface TeamView {
  readonly teamId: TeamId;
  readonly members: readonly TeamMemberView[];
  readonly aliveCount: number;
}

export interface TeamResult {
  readonly teamId: TeamId;
  readonly won: boolean;
  readonly eliminations: number;
  readonly survivingActorIds: readonly number[];
}

export type MatchWinnerView =
  | { readonly kind: 'actor'; readonly actorId: number; readonly displayName: string }
  | { readonly kind: 'team'; readonly teamId: TeamId };

/** Renderer/UI contract. Consumers receive authoritative state but no mutators. */
export interface GameStateView {
  readonly hostTick: number;
  readonly stateRevision: number;
  readonly time: number;
  readonly phaseTime: number;
  readonly phase: MatchPhase;
  readonly actors: readonly ActorView[];
  readonly localActorId: number | null;
  readonly teams: readonly TeamView[];
  readonly mode: MatchMode;
  readonly chests: readonly ChestView[];
  readonly loot: readonly LootView[];
  readonly storm: StormView;
  readonly transport: TransportView;
  /** Present only for localActorId; remote actors never expose predictor
   * internals and a spectator has no local movement baseline. */
  readonly localMovement: LocalMovementView | null;
  readonly destructibles: readonly DestructibleView[];
  readonly winner: MatchWinnerView | null;
  readonly teamResults: readonly TeamResult[];
}
