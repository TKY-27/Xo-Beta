/**
 * Headless deterministic match runner — drives a full 10-combatant match
 * with bot-only input. Used by the balance CLI (`npm run sim`) and by
 * integration tests. No rendering, no DOM.
 */

import { ensureWorldReady, loadMap, type MapId } from '../world/index';
import { Match } from './match';
import { BotController } from '../ai/bot';
import type { Difficulty } from '../core/balance';
import { BOT_PERSONALITIES, SIM } from '../core/balance';
import { Rng } from '../core/rng';
import {
  buildRoster,
  localHumanRosterEntry,
  type MatchMode,
  type RosterEntry,
} from './roster';

export interface SimResult {
  seed: number;
  mapId: MapId;
  difficulty: Difficulty;
  durationSec: number;
  winnerName: string;
  placements: Array<{ name: string; placement: number; kills: number; damage: number; survived: boolean }>;
  killFeedSize: number;
  stormDeaths: number;
  headshots: number;
  chestOpens: number;
  itemsPickedUp: number;
  navFailures: number;
  feed: Array<{ t: number; s: string }>;
  winnerTeamId: number | null;
  friendlyFireHits: number;
}

export async function runHeadlessMatch(opts: {
  mapId: MapId;
  seed: number;
  difficulty: Difficulty;
  maxSeconds?: number;
  onProgress?: (simTime: number, alive: number) => void;
  mode?: MatchMode;
  humans?: readonly RosterEntry[];
}): Promise<SimResult> {
  await ensureWorldReady();
  const loaded = loadMap(opts.mapId);
  const mode = opts.mode ?? 'solo';
  const humans = opts.humans ?? [localHumanRosterEntry()];
  const roster = buildRoster({ mode, humans, seed: opts.seed });
  const match = new Match({
    mapDef: loaded.def,
    seed: opts.seed,
    difficulty: opts.difficulty,
    mode,
    roster,
  });
  match.populateInitialLoot();

  // Headless QA supplies deterministic Bot controllers to every connected
  // roster slot. Ownership remains unchanged and is still what the Match
  // uses for peer/team/local semantics.
  let humanControllerIndex = 0;
  for (const actor of match.actors) {
    const personality = actor.personality
      ?? BOT_PERSONALITIES[(BOT_PERSONALITIES.length - 1 - humanControllerIndex++) % BOT_PERSONALITIES.length]!;
    const ctrl = new BotController(actor, match, new Rng(match.rng.next() * 0xffffffff), personality, opts.difficulty);
    match.controllers.set(actor.id, ctrl);
  }

  let chestOpens = 0;
  let itemsPickedUp = 0;
  const navFailures = 0;
  let friendlyFireHits = 0;
  match.events.on('chestOpened', () => chestOpens++);
  match.events.on('itemPickedUp', () => itemsPickedUp++);
  match.events.on('eliminated', (e) => {
    if (e.storm) void e;
  });
  match.events.on('actorHit', (event) => {
    if (event.attackerId > 0 && !match.areHostile(event.attackerId, event.targetId)) friendlyFireHits++;
  });

  const dt = SIM.fixedDt;
  const maxTicks = Math.floor((opts.maxSeconds ?? 60 * 30) / dt);
  let tick = 0;

  while (!match.finished && tick < maxTicks) {
    match.fixedUpdate(dt);
    tick++;
    if (opts.onProgress && tick % (60 * 30) === 0) {
      opts.onProgress(match.time, match.aliveCount);
    }
  }

  const stormDeaths = match.killFeed.filter((k) => k.storm).length;
  const headshots = match.killFeed.filter((k) => k.headshot).length;

  return {
    seed: opts.seed,
    mapId: opts.mapId,
    difficulty: opts.difficulty,
    durationSec: match.time,
    winnerName: match.winner?.name ?? 'NONE',
    placements: match.actors
      .map((a) => ({ name: a.name, placement: a.placement, kills: a.stats.kills, damage: Math.round(a.stats.damageDealt), survived: a.alive }))
      .sort((x, y) => x.placement - y.placement),
    killFeedSize: match.killFeed.length,
    stormDeaths,
    headshots,
    chestOpens,
    itemsPickedUp,
    navFailures,
    feed: match.killFeed.map((k) => ({ t: k.time, s: `${k.killerName ?? (k.storm ? 'STORM' : 'FALL')} ${k.headshot ? '[HS] ' : ''}-> ${k.victimName}`})),
    winnerTeamId: match.winnerView?.kind === 'team' ? match.winnerView.teamId : null,
    friendlyFireHits,
  };
}
