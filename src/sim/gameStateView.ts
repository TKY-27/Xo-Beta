import type { Rarity } from '../core/balance';
import type { SkinId } from '../core/settings';
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
  readonly yaw: number;
  readonly pitch: number;
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

export interface ChestView {
  readonly id: number;
  readonly kind: 'standard' | 'elite' | 'vault';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly opened: boolean;
}

export interface LootView {
  readonly id: number;
  readonly kind: WorldItemKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rarity: Rarity;
}

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
  readonly phase: MatchPhase;
  readonly actors: readonly ActorView[];
  readonly localActorId: number | null;
  readonly teams: readonly TeamView[];
  readonly mode: MatchMode;
  readonly chests: readonly ChestView[];
  readonly loot: readonly LootView[];
  readonly storm: StormView;
  readonly winner: MatchWinnerView | null;
  readonly teamResults: readonly TeamResult[];
}
