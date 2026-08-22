/**
 * CLI: run headless bot-only matches and print balance statistics.
 * Usage: npm run sim [-- map=neocity seed=1234 difficulty=hard count=3]
 */

import { runHeadlessMatch } from '../../src/sim/simRunner';
import type { MapId } from '../../src/world/index';
import type { Difficulty } from '../../src/core/balance';

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.split('=')[1]! : def;
}

async function main(): Promise<void> {
  const map = arg('map', 'neocity') as MapId;
  const difficulty = arg('difficulty', 'hard') as Difficulty;
  const count = parseInt(arg('count', '1'), 10);
  const baseSeed = parseInt(arg('seed', String(Date.now() % 100000)), 10);

  console.log(`\n=== Xo Beta bot simulation: map=${map} difficulty=${difficulty} matches=${count} ===\n`);

  const results = [];
  for (let i = 0; i < count; i++) {
    const seed = baseSeed + i * 7919;
    const t0 = performance.now();
    const r = await runHeadlessMatch({ mapId: map, seed, difficulty });
    const wallMs = performance.now() - t0;
    results.push(r);
    console.log(`Match ${i + 1} (seed ${seed}): winner=${r.winnerName} duration=${(r.durationSec / 60).toFixed(1)}min kills=${r.killFeedSize} stormDeaths=${r.stormDeaths} chests=${r.chestOpens} pickups=${r.itemsPickedUp} [sim ${wallMs.toFixed(0)}ms wall]`);
    if (process.env.SIM_VERBOSE) {
      for (const k of (r as unknown as { feed?: Array<{ t: number; s: string }> }).feed ?? []) {
        console.log(`   t=${k.t.toFixed(0)}s ${k.s}`);
      }
    }
    for (const p of r.placements) {
      console.log(`   #${p.placement} ${p.name.padEnd(8)} kills=${p.kills} dmg=${p.damage}${p.survived ? '  <-- WINNER' : ''}`);
    }
  }

  // Aggregate
  const avgDur = results.reduce((s, r) => s + r.durationSec, 0) / results.length;
  const avgKills = results.reduce((s, r) => s + r.killFeedSize, 0) / results.length;
  const avgStorm = results.reduce((s, r) => s + r.stormDeaths, 0) / results.length;
  const avgChests = results.reduce((s, r) => s + r.chestOpens, 0) / results.length;
  const winsByBot: Record<string, number> = {};
  for (const r of results) winsByBot[r.winnerName] = (winsByBot[r.winnerName] ?? 0) + 1;

  console.log('\n--- AGGREGATE ---');
  console.log(`avg duration: ${(avgDur / 60).toFixed(1)} min (target 15-20)`);
  console.log(`avg eliminations: ${avgKills.toFixed(1)} (max possible 9)`);
  console.log(`avg storm deaths: ${avgStorm.toFixed(1)}`);
  console.log(`avg chests opened: ${avgChests.toFixed(1)}`);
  console.log('wins:', winsByBot);
}

void main();
