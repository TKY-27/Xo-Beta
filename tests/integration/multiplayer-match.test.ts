import { beforeAll, describe, expect, it } from 'vitest';
import { BotController } from '../../src/ai/bot';
import { BOT_PERSONALITIES, WEAPONS } from '../../src/core/balance';
import { Rng } from '../../src/core/rng';
import type { Actor } from '../../src/sim/actor';
import { emptyCommand, type InputCommand } from '../../src/sim/input';
import { Match, type ActorController } from '../../src/sim/match';
import { buildSoloRoster, type MatchMode } from '../../src/sim/roster';
import { loadMap } from '../../src/world';
import { RAPIER_READY } from '../../src/world/rapierReady';
import { rosterFixture } from '../fixtures/multiplayer';

beforeAll(async () => {
  await RAPIER_READY();
});

function makeMatch(mode: MatchMode, count: number, teams: readonly (number | null)[] = [], seed = 773): Match {
  return new Match({
    mapDef: loadMap('eden').def,
    seed,
    difficulty: 'normal',
    mode,
    roster: rosterFixture(mode, count, teams, seed),
  });
}

interface MatchInternals {
  pendingEliminations: Array<{ victim: Actor; killer: Actor | null; weaponId: null; headshot: boolean; storm: boolean }>;
  processEliminations(): void;
  checkWin(): void;
}

function internals(match: Match): MatchInternals {
  return match as unknown as MatchInternals;
}

function queueElimination(match: Match, victim: Actor, killer: Actor | null = null): void {
  victim.applyDamage(victim.effectiveHealth() + 1);
  internals(match).pendingEliminations.push({ victim, killer, weaponId: null, headshot: false, storm: false });
}

function resolveWin(match: Match): void {
  match.phase = 'live';
  internals(match).processEliminations();
  internals(match).checkWin();
}

function eliminateWhere(match: Match, predicate: (actor: Actor) => boolean, killer: Actor | null = null): void {
  for (const actor of match.actors) {
    if (actor.alive && predicate(actor)) queueElimination(match, actor, killer);
  }
}

describe('canonical ownership and team presentation', () => {
  it('looks up peer, slot, team, hostility, local identity, and read-only presentation data', () => {
    const match = makeMatch('teams', 4, [0, 0, 1, 1]);
    const local = match.localActor!;
    const teammate = match.actors[1]!;
    const enemy = match.actors[2]!;
    expect(match.rosterEntryForPeer('peer-1')?.actorId).toBe(local.id);
    expect(match.rosterEntryForSlot(1)?.actorId).toBe(teammate.id);
    expect(match.teamForActor(local)).toBe(0);
    expect(match.areTeammates(local, teammate)).toBe(true);
    expect(match.areHostile(local, enemy)).toBe(true);
    expect(match.isHumanActor(enemy)).toBe(true);
    expect(match.isBotActor(enemy)).toBe(false);
    expect(match.localTeamId).toBe(0);
    expect(match.enemyTeamIds).toEqual([1]);

    const view = match.toGameStateView();
    expect(view.localActorId).toBe(local.id);
    expect(view.mode).toBe('teams');
    expect(view.teams).toHaveLength(2);
    expect(view.teams[0]).toMatchObject({ teamId: 0, aliveCount: 2 });
    expect(view.teams[0]?.members[0]).toMatchObject({ displayName: 'HUMAN 1', alive: true });
    expect('position' in (view.teams[1]?.members[0] ?? {})).toBe(false);
    expect(Object.isFrozen(view.actors)).toBe(true);
    expect(Object.isFrozen(view.teams)).toBe(true);
    expect(Object.isFrozen(view.actors[0]?.position)).toBe(true);
    const snapshotX = view.actors[0]!.position.x;
    local.body.position.x += 10;
    expect(view.actors[0]?.position.x).toBe(snapshotX);
    match.dispose();
  }, 30_000);

  it('orders living teammates first for spectating, then falls back to normal living order', () => {
    const match = makeMatch('teams', 4, [0, 0, 1, 1]);
    const local = match.localActor!;
    queueElimination(match, local);
    internals(match).processEliminations();
    expect(match.spectatorTargets().map((actor) => actor.id)).toEqual([2, 3, 4]);
    queueElimination(match, match.actors[1]!);
    internals(match).processEliminations();
    expect(match.spectatorTargets().map((actor) => actor.id)).toEqual([3, 4]);
    match.dispose();
  });
});

describe('team-aware Bot targeting', () => {
  it('drops a stale teammate target and ignores teammate gunfire as hostile memory', () => {
    const match = makeMatch('teams-bot-fill', 2, [0, 1]);
    const bot = match.actors.find((actor) => match.isBotActor(actor) && match.teamForActor(actor) === 0)!;
    const ally = match.actors.find((actor) => actor !== bot && match.teamForActor(actor) === 0)!;
    const enemy = match.actors.find((actor) => match.teamForActor(actor) === 1)!;
    const controller = new BotController(bot, match, new Rng(9), bot.personality ?? BOT_PERSONALITIES[0]!, 'normal');
    controller.combat.acquire(ally);
    const p = bot.body.position;
    match.events.emit('shotFired', { actorId: ally.id, weaponId: 'pistol', x: p.x + 10, y: p.y, z: p.z, dry: false });
    match.events.emit('shotFired', { actorId: enemy.id, weaponId: 'pistol', x: p.x + 10, y: p.y, z: p.z, dry: false });

    controller.updateCommand(bot, 1 / 60);

    expect(controller.combat.target).toBeNull();
    expect(controller.perception.memories.has(ally.id)).toBe(false);
    expect(controller.perception.memories.has(enemy.id)).toBe(true);
    match.dispose();
  });
});

describe('FFA and team win conditions', () => {
  it('preserves the FFA last-living-actor winner', () => {
    const match = makeMatch('ffa', 2);
    queueElimination(match, match.actors[1]!, match.actors[0]!);
    resolveWin(match);
    expect(match.winnerView).toEqual({ kind: 'actor', actorId: 1, displayName: 'HUMAN 1' });
    expect(match.localActor?.placement).toBe(1);
    match.dispose();
  });

  it.each([
    ['1v1', 2, [0, 1]],
    ['2v2', 4, [0, 0, 1, 1]],
  ] as const)('declares the surviving team in %s', (_name, count, teams) => {
    const match = makeMatch('teams', count, teams);
    const killer = match.actors.find((actor) => match.teamForActor(actor) === 0)!;
    eliminateWhere(match, (actor) => match.teamForActor(actor) === 1, killer);
    resolveWin(match);
    expect(match.winnerView).toEqual({ kind: 'team', teamId: 0 });
    expect(match.teamResults.find((result) => result.teamId === 0)).toMatchObject({ won: true, eliminations: count / 2 });
    expect(match.teamResults.find((result) => result.teamId === 0)?.survivingActorIds.length).toBe(count / 2);
    match.dispose();
  });

  it('declares a valid 5v5 team winner', () => {
    const match = makeMatch('teams-bot-fill', 4, [0, 0, 1, 1]);
    eliminateWhere(match, (actor) => match.teamForActor(actor) === 1);
    resolveWin(match);
    expect(match.winnerView).toEqual({ kind: 'team', teamId: 0 });
    expect(match.teams.find((team) => team.teamId === 0)?.aliveCount).toBe(5);
    match.dispose();
  });

  it('supports both humans-versus-Bots outcomes', () => {
    const humanWin = makeMatch('humans-vs-bots', 4);
    eliminateWhere(humanWin, (actor) => humanWin.isBotActor(actor));
    resolveWin(humanWin);
    expect(humanWin.winnerView).toEqual({ kind: 'team', teamId: 0 });
    humanWin.dispose();

    const botWin = makeMatch('humans-vs-bots', 4);
    eliminateWhere(botWin, (actor) => botWin.isHumanActor(actor));
    resolveWin(botWin);
    expect(botWin.winnerView).toEqual({ kind: 'team', teamId: 1 });
    botWin.dispose();
  }, 30_000);

  it('does not win before deferred eliminations are processed and counts a disconnected living actor', () => {
    const match = makeMatch('teams', 4, [0, 0, 1, 1]);
    expect(match.markPeerDisconnected('peer-2')).toBe(true);
    eliminateWhere(match, (actor) => match.teamForActor(actor) === 1);
    match.phase = 'live';
    internals(match).checkWin();
    expect(match.finished).toBe(false);
    resolveWin(match);
    expect(match.winnerView).toEqual({ kind: 'team', teamId: 0 });
    expect(match.teamResults.find((result) => result.teamId === 0)?.survivingActorIds).toContain(2);
    match.dispose();
  });
});

class AggressiveController implements ActorController {
  calls = 0;
  updateCommand(actor: Actor): InputCommand {
    this.calls++;
    const command = emptyCommand();
    command.moveZ = 1;
    command.fireHeld = true;
    command.firePressed = true;
    command.adsHeld = true;
    command.jumpPressed = true;
    command.dashPressed = true;
    command.interactPressed = true;
    command.yaw = actor.yaw;
    command.pitch = actor.pitch;
    return command;
  }
}

describe('deterministic connection-state simulation', () => {
  it('zeros stale input, stops healing/pickup/shooting, keeps gravity, and restores live control', () => {
    const seed = 991;
    const match = new Match({
      mapDef: loadMap('eden').def,
      seed,
      difficulty: 'normal',
      mode: 'solo',
      roster: buildSoloRoster(seed, { practice: true }),
      practice: true,
    });
    const actor = match.localActor!;
    actor.inv.add({ kind: 'weapon', weaponId: 'pistol', rarity: 'common', ammoInMag: WEAPONS.pistol.magSize });
    actor.inv.select(0);
    const controller = new AggressiveController();
    match.controllers.set(actor.id, controller);
    match.fixedUpdate(1 / 60);
    const shotsBeforeDisconnect = actor.stats.shotsFired;
    expect(controller.calls).toBe(1);
    expect(shotsBeforeDisconnect).toBe(1);

    actor.healing = { itemId: 'medkit', remaining: 4, total: 5 };
    actor.interactTimer = 1;
    const p = actor.body.position;
    actor.body.teleport(p.x, p.y + 8, p.z);
    const ammo = match.loot.spawnAmmo(p.x, p.y + 8, p.z, 'light', 12, match.rng);
    match.movement.beginFreefall(actor);
    const startY = actor.body.position.y;

    expect(match.markPeerDisconnected('local')).toBe(true);
    expect(actor.healing).toBeNull();
    expect(actor.interactTimer).toBe(0);
    for (let i = 0; i < 12; i++) match.fixedUpdate(1 / 60);

    expect(controller.calls).toBe(1);
    expect(actor.stats.shotsFired).toBe(shotsBeforeDisconnect);
    expect(actor.adsHeld).toBe(false);
    expect(match.loot.items).toContain(ammo);
    expect(actor.body.position.y).toBeLessThan(startY);
    expect(match.connectionStateForActor(actor)).toBe('disconnected');

    expect(match.restorePeerControl('local')).toBe(true);
    match.fixedUpdate(1 / 60);
    expect(controller.calls).toBe(2);
    expect(actor.stats.shotsFired).toBe(shotsBeforeDisconnect + 1);
    expect(match.connectionStateForActor(actor)).toBe('connected');
    match.dispose();
  });

  it('keeps a disconnected actor vulnerable and reconnects a dead local actor into spectator semantics', () => {
    const match = makeMatch('ffa', 2);
    const local = match.localActor!;
    const enemy = match.actors[1]!;
    local.body.teleport(0, local.body.position.y, 0);
    enemy.body.teleport(0, enemy.body.position.y, 1.2);
    enemy.yaw = 0;
    local.shield = 0;
    local.health = 1;
    expect(match.markPeerDisconnected('peer-1')).toBe(true);
    match.combat.tryMelee(enemy, 1 / 60, [enemy, local]);
    expect(local.alive).toBe(false);
    internals(match).processEliminations();
    expect(match.restorePeerControl('peer-1')).toBe(true);
    expect(match.localActor?.alive).toBe(false);
    expect(match.spectatorTargets()).toContain(enemy);
    match.dispose();
  });
});
