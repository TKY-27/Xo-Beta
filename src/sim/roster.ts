import { BOT_PERSONALITIES, MATCH, type BotPersonality } from '../core/balance';
import type { SkinId } from '../core/settings';

export type PeerId = string;
export type TeamId = number;

export type ActorOwnership =
  | { kind: 'local-human'; peerId: PeerId }
  | { kind: 'remote-human'; peerId: PeerId }
  | { kind: 'bot' };

export type ConnectionState = 'connected' | 'disconnected' | 'bot';

export interface RosterEntry {
  slotId: number;
  actorId: number;
  displayName: string;
  ownership: ActorOwnership;
  connectionState: ConnectionState;
  teamId: TeamId | null;
  skinId: SkinId;
  accentColor: number;
}

export type MatchMode =
  | 'solo'
  | 'ffa-bot-fill'
  | 'ffa'
  | 'teams'
  | 'teams-bot-fill'
  | 'humans-vs-bots';

export interface RosterConfig {
  mode: MatchMode;
  humans: readonly RosterEntry[];
  /** Practice keeps the solo human but intentionally omits combatants. */
  practice?: boolean;
  seed: number;
}

export const VALID_SKIN_IDS: readonly SkinId[] = Object.freeze([
  'vanguard', 'pathfinder', 'specter', 'striker', 'warden', 'nova',
]);

const TEAM_IDS: readonly TeamId[] = Object.freeze([0, 1]);
const MAX_HUMANS = 4;

export function localHumanRosterEntry(opts: {
  slotId?: number;
  actorId?: number;
  peerId?: PeerId;
  displayName?: string;
  teamId?: TeamId | null;
  skinId?: SkinId;
  accentColor?: number;
  connectionState?: Exclude<ConnectionState, 'bot'>;
} = {}): RosterEntry {
  return {
    slotId: opts.slotId ?? 0,
    actorId: opts.actorId ?? 1,
    displayName: opts.displayName ?? 'YOU',
    ownership: { kind: 'local-human', peerId: opts.peerId ?? 'local' },
    connectionState: opts.connectionState ?? 'connected',
    teamId: opts.teamId ?? null,
    skinId: opts.skinId ?? 'vanguard',
    accentColor: opts.accentColor ?? 0x5fd0ff,
  };
}

export function remoteHumanRosterEntry(opts: {
  slotId: number;
  actorId: number;
  peerId: PeerId;
  displayName: string;
  teamId?: TeamId | null;
  skinId?: SkinId;
  accentColor?: number;
  connectionState?: Exclude<ConnectionState, 'bot'>;
}): RosterEntry {
  return {
    slotId: opts.slotId,
    actorId: opts.actorId,
    displayName: opts.displayName,
    ownership: { kind: 'remote-human', peerId: opts.peerId },
    connectionState: opts.connectionState ?? 'connected',
    teamId: opts.teamId ?? null,
    skinId: opts.skinId ?? VALID_SKIN_IDS[opts.slotId % VALID_SKIN_IDS.length]!,
    accentColor: opts.accentColor ?? (0x9b7dff + opts.slotId * 0x1100),
  };
}

export function buildSoloRoster(
  seed: number,
  opts: Parameters<typeof localHumanRosterEntry>[0] & { practice?: boolean } = {},
): RosterEntry[] {
  const { practice, ...humanOptions } = opts;
  return buildRoster({
    mode: 'solo',
    humans: [localHumanRosterEntry(humanOptions)],
    practice,
    seed,
  });
}

/** Build the complete deterministic combat roster from explicit human slots. */
export function buildRoster(config: RosterConfig): RosterEntry[] {
  const humans = config.humans.map(cloneEntry);
  validateHumanEntries(humans);
  validateModeHumans(config.mode, humans, config.practice === true);

  if (isTeamMode(config.mode)) assignAndValidateHumanTeams(config.mode, humans);
  else if (humans.some((human) => human.teamId !== null)) throw new Error('FFA humans cannot have a team ID');

  const roster = [...humans];
  if (!(config.practice === true && config.mode === 'solo')) {
    fillBots(config.mode, roster);
  }
  validateRoster(config.mode, roster, config.practice === true);
  return roster.sort((a, b) => a.slotId - b.slotId || a.actorId - b.actorId);
}

/** Validate a prebuilt roster at the authoritative Match boundary. */
export function validateRoster(mode: MatchMode, roster: readonly RosterEntry[], practice = false): void {
  if (roster.length === 0) throw new Error('Roster must contain at least one actor');
  if (roster.length > MATCH.combatantCount) throw new Error(`Roster exceeds ${MATCH.combatantCount} actors`);

  assertUnique(roster.map((entry) => entry.slotId), 'slot IDs');
  assertUnique(roster.map((entry) => entry.actorId), 'actor IDs');
  assertUnique(
    roster.flatMap((entry) => entry.ownership.kind === 'bot' ? [] : [entry.ownership.peerId]),
    'peer IDs',
  );

  let localHumans = 0;
  let humans = 0;
  const humanEntries: RosterEntry[] = [];
  for (const entry of roster) {
    validateEntry(entry);
    if (entry.ownership.kind === 'bot') {
      if (entry.connectionState !== 'bot') throw new Error('Bot connection state must be bot');
    } else {
      humans++;
      humanEntries.push(entry);
      if (entry.connectionState === 'bot') throw new Error('Human connection state cannot be bot');
      if (entry.ownership.kind === 'local-human') localHumans++;
    }
  }
  if (humans > MAX_HUMANS) throw new Error(`Roster supports at most ${MAX_HUMANS} humans`);
  if (localHumans > 1) throw new Error('Roster may contain at most one local human');
  validateModeHumans(mode, humanEntries, practice);

  if (!isTeamMode(mode)) {
    if (roster.some((entry) => entry.teamId !== null)) throw new Error('FFA actors cannot have a team ID');
  } else {
    const presentTeams = new Set(roster.map((entry) => entry.teamId));
    if (presentTeams.has(null) || presentTeams.size < 2) throw new Error('Team mode requires a hostile opposing team');
  }

  const expectedCount = mode === 'ffa' || mode === 'teams' || practice
    ? humans
    : MATCH.combatantCount;
  if (roster.length !== expectedCount) throw new Error(`Mode ${mode} requires ${expectedCount} actors`);

  if (mode === 'teams-bot-fill') {
    const team0 = roster.filter((entry) => entry.teamId === 0).length;
    const team1 = roster.filter((entry) => entry.teamId === 1).length;
    if (team0 !== MATCH.combatantCount / 2 || team1 !== MATCH.combatantCount / 2) {
      throw new Error('Team Bot fill requires a balanced 5v5 roster');
    }
  }
  if (mode === 'humans-vs-bots') {
    if (roster.some((entry) => entry.ownership.kind === 'bot' ? entry.teamId !== 1 : entry.teamId !== 0)) {
      throw new Error('Humans-versus-Bots requires humans on team 0 and Bots on team 1');
    }
  }
}

export function isTeamMode(mode: MatchMode): boolean {
  return mode === 'teams' || mode === 'teams-bot-fill' || mode === 'humans-vs-bots';
}

export function areRosterEntriesHostile(mode: MatchMode, a: RosterEntry, b: RosterEntry): boolean {
  if (a.actorId === b.actorId) return false;
  return !isTeamMode(mode) || a.teamId !== b.teamId;
}

/** The sole actor-to-actor damage/impulse/feedback authorization policy. */
export class ActorDamagePolicy {
  constructor(
    private readonly mode: MatchMode,
    private readonly entryForActor: (actorId: number) => RosterEntry | null,
  ) {}

  allows(attackerId: number, targetId: number): boolean {
    const attacker = this.entryForActor(attackerId);
    const target = this.entryForActor(targetId);
    return attacker !== null && target !== null && areRosterEntriesHostile(this.mode, attacker, target);
  }
}

export function personalityForRosterEntry(entry: RosterEntry): BotPersonality | null {
  if (entry.ownership.kind !== 'bot') return null;
  return BOT_PERSONALITIES.find((personality) => entry.displayName.startsWith(personality.name))
    ?? BOT_PERSONALITIES[0]!;
}

function validateModeHumans(mode: MatchMode, humans: readonly RosterEntry[], practice: boolean): void {
  const count = humans.length;
  if (practice && mode !== 'solo') throw new Error('Practice is available only in solo mode');
  switch (mode) {
    case 'solo':
      if (count !== 1 || humans[0]?.ownership.kind !== 'local-human') {
        throw new Error('Solo requires exactly one local human');
      }
      break;
    case 'ffa-bot-fill':
    case 'humans-vs-bots':
      if (count < 1 || count > MAX_HUMANS) throw new Error(`${mode} requires one to four humans`);
      break;
    case 'ffa':
    case 'teams':
    case 'teams-bot-fill':
      if (count < 2 || count > MAX_HUMANS) throw new Error(`${mode} requires two to four humans`);
      break;
  }
}

function validateHumanEntries(humans: readonly RosterEntry[]): void {
  for (const entry of humans) {
    if (entry.ownership.kind === 'bot') throw new Error('Human configuration cannot contain a Bot');
    validateEntry(entry);
  }
  assertUnique(humans.map((entry) => entry.slotId), 'slot IDs');
  assertUnique(humans.map((entry) => entry.actorId), 'actor IDs');
  assertUnique(humans.map((entry) => (entry.ownership as Exclude<ActorOwnership, { kind: 'bot' }>).peerId), 'peer IDs');
}

function validateEntry(entry: RosterEntry): void {
  if (!Number.isInteger(entry.slotId) || entry.slotId < 0 || entry.slotId >= MATCH.combatantCount) {
    throw new Error(`Invalid roster slot ID: ${entry.slotId}`);
  }
  if (!Number.isSafeInteger(entry.actorId) || entry.actorId <= 0) throw new Error(`Invalid actor ID: ${entry.actorId}`);
  if (!validDisplayName(entry.displayName)) throw new Error(`Invalid display name: ${JSON.stringify(entry.displayName)}`);
  if (!VALID_SKIN_IDS.includes(entry.skinId)) throw new Error(`Invalid skin ID: ${String(entry.skinId)}`);
  if (!Number.isInteger(entry.accentColor) || entry.accentColor < 0 || entry.accentColor > 0xffffff) {
    throw new Error(`Invalid accent color: ${entry.accentColor}`);
  }
  if (entry.teamId !== null && !TEAM_IDS.includes(entry.teamId)) throw new Error(`Invalid team ID: ${entry.teamId}`);
  if (entry.ownership.kind !== 'bot' && !validPeerId(entry.ownership.peerId)) {
    throw new Error(`Invalid peer ID: ${JSON.stringify(entry.ownership.peerId)}`);
  }
}

function assignAndValidateHumanTeams(mode: MatchMode, humans: RosterEntry[]): void {
  if (mode === 'humans-vs-bots') {
    for (const human of humans) {
      if (human.teamId !== null && human.teamId !== 0) throw new Error('Humans-versus-Bots humans must be on team 0');
      human.teamId = 0;
    }
    return;
  }

  let team0 = humans.filter((entry) => entry.teamId === 0).length;
  let team1 = humans.filter((entry) => entry.teamId === 1).length;
  for (const human of humans) {
    if (human.teamId !== null) continue;
    human.teamId = team0 <= team1 ? 0 : 1;
    if (human.teamId === 0) team0++;
    else team1++;
  }
  if (mode === 'teams' && (team0 === 0 || team1 === 0)) throw new Error('Bot-off team mode requires a non-empty opposing team');
}

function fillBots(mode: MatchMode, roster: RosterEntry[]): void {
  const desired = mode === 'ffa' || mode === 'teams' ? roster.length : MATCH.combatantCount;
  if (roster.length >= desired) return;
  const usedSlots = new Set(roster.map((entry) => entry.slotId));
  const usedActorIds = new Set(roster.map((entry) => entry.actorId));
  const nextFree = (used: Set<number>, start: number): number => {
    let value = start;
    while (used.has(value)) value++;
    used.add(value);
    return value;
  };

  let team0 = roster.filter((entry) => entry.teamId === 0).length;
  let team1 = roster.filter((entry) => entry.teamId === 1).length;
  let botIndex = 0;
  while (roster.length < desired) {
    const personality = BOT_PERSONALITIES[botIndex % BOT_PERSONALITIES.length]!;
    const slotId = nextFree(usedSlots, 0);
    const actorId = nextFree(usedActorIds, 1);
    let teamId: TeamId | null = null;
    if (mode === 'humans-vs-bots') teamId = 1;
    else if (mode === 'teams-bot-fill') {
      teamId = team0 <= team1 ? 0 : 1;
      if (teamId === 0) team0++;
      else team1++;
    }
    const nameSuffix = botIndex >= BOT_PERSONALITIES.length ? `-${Math.floor(botIndex / BOT_PERSONALITIES.length) + 1}` : '';
    roster.push({
      slotId,
      actorId,
      displayName: `${personality.name}${nameSuffix}`,
      ownership: { kind: 'bot' },
      connectionState: 'bot',
      teamId,
      skinId: skinIdForName(`${personality.name}${nameSuffix}`),
      accentColor: personality.accentColor,
    });
    botIndex++;
  }
}

function skinIdForName(name: string): SkinId {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return VALID_SKIN_IDS[(hash >>> 0) % VALID_SKIN_IDS.length]!;
}

function validDisplayName(name: string): boolean {
  return name === name.trim() && name.length >= 1 && name.length <= 24 && !hasControlCharacter(name);
}

function validPeerId(peerId: string): boolean {
  return peerId === peerId.trim() && peerId.length >= 1 && peerId.length <= 128 && !hasControlCharacter(peerId);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function assertUnique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

function cloneEntry(entry: RosterEntry): RosterEntry {
  return {
    ...entry,
    ownership: entry.ownership.kind === 'bot'
      ? { kind: 'bot' }
      : { kind: entry.ownership.kind, peerId: entry.ownership.peerId },
  };
}
