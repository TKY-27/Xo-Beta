/**
 * Headless deterministic match runner — drives a full 10-combatant match
 * with bot-only input. Used by the balance CLI (`npm run sim`) and by
 * integration tests. No rendering, no DOM.
 */

import { ensureWorldReady, loadMap, type MapId } from '../world/index';
import { Match } from './match';
import { BotController } from '../ai/bot';
import type { Difficulty } from '../core/balance';
import { SIM } from '../core/balance';
import { Rng } from '../core/rng';

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
}

export async function runHeadlessMatch(opts: {
  mapId: MapId;
  seed: number;
  difficulty: Difficulty;
  maxSeconds?: number;
  onProgress?: (simTime: number, alive: number) => void;
}): Promise<SimResult> {
  await ensureWorldReady();
  const loaded = loadMap(opts.mapId);
  const match = new Match({
    mapDef: loaded.def,
    seed: opts.seed,
    difficulty: opts.difficulty,
    withPlayer: false,
  });
  match.populateInitialLoot();

  // Attach bot controllers (10 bots; roster wraps with suffixes)
  let dup = 0;
  for (const actor of match.actors) {
    if (!actor.personality) continue;
    let name = actor.name;
    if (match.actors.filter((a) => a.name === name).length > 1 && actor.name.length <= 5) {
      dup++;
      name = `${actor.name}-${dup}`;
      Object.defineProperty(actor, 'name', { value: name });
    }
    const ctrl = new BotController(actor, match, new Rng(match.rng.next() * 0xffffffff), actor.personality, opts.difficulty);
    match.controllers.set(actor.id, ctrl);
  }

  let chestOpens = 0;
  let itemsPickedUp = 0;
  let navFailures = 0;
  match.events.on('chestOpened', () => chestOpens++);
  match.events.on('itemPickedUp', () => itemsPickedUp++);
  match.events.on('eliminated', (e) => {
    if (e.storm) void e;
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
  };
}
