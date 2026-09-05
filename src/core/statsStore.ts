/**
 * Local match history ("戦績") persistence.
 *
 * Straight localStorage, following the settings-store pattern: a versioned
 * key, strict validation on read, and a bounded record list. Data is local
 * to this browser — the game has no server, so there is nothing else to do.
 */

export interface MatchRecord {
  /** Finish time (Date.now()). */
  at: number;
  map: string;
  mode: string;
  won: boolean;
  placement: number;
  /** Total combatants in the match (placement context). */
  players: number;
  kills: number;
  damage: number;
  /** Shots hit / shots fired, 0..1. */
  accuracy: number;
  headshots: number;
  /** Seconds alive. */
  survivalTime: number;
}

export interface StatsSummary {
  matches: number;
  wins: number;
  winRate: number;
  bestPlacement: number;
  avgPlacement: number;
  avgKills: number;
  avgDamage: number;
  totalKills: number;
  totalDamage: number;
  headshots: number;
  /** Longest single-match survival, seconds. */
  bestSurvivalTime: number;
  /** Cumulative time in matches, seconds. */
  totalSurvivalTime: number;
}

const STORAGE_KEY = 'xo-beta-match-history-v1';
export const MAX_RECORDS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeMatchRecord(value: unknown): MatchRecord | null {
  if (!isRecord(value)) return null;
  const placement = Math.max(1, Math.round(num(value.placement, 1)));
  const players = Math.max(placement, Math.round(num(value.players, placement)));
  return {
    at: num(value.at, Date.now()),
    map: typeof value.map === 'string' ? value.map : 'unknown',
    mode: typeof value.mode === 'string' ? value.mode : 'solo',
    won: value.won === true,
    placement,
    players,
    kills: Math.max(0, Math.round(num(value.kills, 0))),
    damage: Math.max(0, num(value.damage, 0)),
    accuracy: Math.min(1, Math.max(0, num(value.accuracy, 0))),
    headshots: Math.max(0, Math.round(num(value.headshots, 0))),
    survivalTime: Math.max(0, num(value.survivalTime, 0)),
  };
}

export function loadMatchRecords(): MatchRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.records)) return [];
    return parsed.records
      .slice(0, MAX_RECORDS)
      .map(sanitizeMatchRecord)
      .filter((r): r is MatchRecord => r !== null);
  } catch {
    return [];
  }
}

/** Prepend a record, keep the list bounded, persist. Returns the new list. */
export function recordMatch(record: MatchRecord): MatchRecord[] {
  const clean = sanitizeMatchRecord(record) ?? record;
  const records = [clean, ...loadMatchRecords()].slice(0, MAX_RECORDS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, records }));
  } catch {
    /* storage full or unavailable — history is best-effort */
  }
  return records;
}

export function clearMatchRecords(): MatchRecord[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* unavailable — nothing to clear */
  }
  return [];
}

export function summarize(records: readonly MatchRecord[]): StatsSummary {
  const matches = records.length;
  if (matches === 0) {
    return {
      matches: 0, wins: 0, winRate: 0, bestPlacement: 0, avgPlacement: 0,
      avgKills: 0, avgDamage: 0, totalKills: 0, totalDamage: 0,
      headshots: 0, bestSurvivalTime: 0, totalSurvivalTime: 0,
    };
  }
  const wins = records.filter((r) => r.won).length;
  const placements = records.map((r) => r.placement);
  return {
    matches,
    wins,
    winRate: wins / matches,
    bestPlacement: Math.min(...placements),
    avgPlacement: placements.reduce((a, b) => a + b, 0) / matches,
    avgKills: records.reduce((a, r) => a + r.kills, 0) / matches,
    avgDamage: records.reduce((a, r) => a + r.damage, 0) / matches,
    totalKills: records.reduce((a, r) => a + r.kills, 0),
    totalDamage: records.reduce((a, r) => a + r.damage, 0),
    headshots: records.reduce((a, r) => a + r.headshots, 0),
    bestSurvivalTime: Math.max(...records.map((r) => r.survivalTime)),
    totalSurvivalTime: records.reduce((a, r) => a + r.survivalTime, 0),
  };
}
