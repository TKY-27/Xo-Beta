/**
 * Match: owns the full simulation — actors, controllers, transport/drop,
 * storm, loot, combat resolution, eliminations, win detection.
 *
 * Strictly renderer-independent: headless bot simulations run this directly.
 */

import {
  BOT_PERSONALITIES, DIFFICULTY, GAMEPLAY, MATCH, MOVE, WEAPONS,
  type BotPersonality, type Difficulty, type WeaponId,
} from '../core/balance';
import { EventBus } from '../core/events';
import { Rng, setGameSeed } from '../core/rng';
import { CharBody, PhysicsWorld, GROUPS as PHYS_GROUPS } from '../physics/physics';
import { buildColliders } from '../world/builder';
import { NavGraph } from '../world/nav';
import type { MapDef, WaterVolume } from '../world/types';
import { Actor } from './actor';
import { emptyCommand, type InputCommand } from './input';
import { MovementSystem, type MovementEvents } from './movement';
import { CombatSystem, type CombatEvents } from './combat';
import { LootSystem, type LootEvents } from './loot';
import { Storm, type StormEvents } from './storm';

export type MatchPhase = 'transport' | 'drop' | 'live' | 'results';

export interface KillFeedEntry {
  time: number;
  killerName: string | null;
  killerId: number;
  victimName: string;
  victimId: number;
  weaponId: WeaponId | null;
  headshot: boolean;
  storm: boolean;
}

export interface ChestEntity {
  id: number;
  kind: 'standard' | 'elite' | 'vault';
  x: number;
  y: number;
  z: number;
  opened: boolean;
  openT: number;
}

export interface MatchEventsMap {
  shotFired: { actorId: number; weaponId: WeaponId; x: number; y: number; z: number; dry: boolean };
  footstep: { actorId: number; x: number; y: number; z: number; running: boolean; surface: 'stone' | 'metal' | 'wood' | 'grass' | 'water' };
  muzzleFlash: { actorId: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; weaponId: WeaponId };
  impact: { x: number; y: number; z: number; nx: number; ny: number; nz: number; material: string };
  tracer: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; color: number };
  ricochet: { x: number; y: number; z: number };
  glassBreak: { x: number; y: number; z: number };
  destructibleDestroyed: { id: number; x: number; y: number; z: number };
  actorHit: { targetId: number; attackerId: number; damage: number; region: string; killed: boolean; headshot: boolean; weaponId: WeaponId; shieldDamage: number };
  shieldBroken: { actorId: number };
  headshotFeedback: { attackerId: number };
  eliminated: { victimId: number; killerId: number; weaponId: WeaponId | null; headshot: boolean; storm: boolean; placement: number };
  itemSpawned: { itemId: number };
  itemPickedUp: { itemId: number; actorId: number; rare?: boolean };
  chestOpened: { chestId: number; kind: string; tier: number; x: number; y: number; z: number };
  stormWaiting: { index: number; waitTime: number; targetRadius: number };
  stormShrinking: { index: number; shrinkTime: number };
  stormFinal: Record<string, never>;
  healStarted: { actorId: number; item: string };
  healDone: { actorId: number; item: string };
  healCancelled: { actorId: number };
  jump: { actorId: number; kind: string };
  land: { actorId: number; impactSpeed: number; fallDamage: number };
  slide: { actorId: number };
  wallrunStart: { actorId: number };
  mantle: { actorId: number };
  dash: { actorId: number };
  grappleAttach: { actorId: number; x: number; y: number; z: number };
  grappleRelease: { actorId: number };
  poundImpact: { actorId: number; x: number; y: number; z: number };
  splash: { actorId: number; heavy: boolean };
  transportJumped: { actorId: number };
  phaseChanged: { phase: MatchPhase };
  matchWon: { winnerId: number; winnerName: string };
  reloadStarted: { actorId: number; empty: boolean };
}

export interface MatchConfig {
  mapDef: MapDef;
  seed: number;
  difficulty: Difficulty;
  withPlayer: boolean;
}

export interface ActorController {
  updateCommand(actor: Actor, dt: number): InputCommand;
}

interface DestructibleInstance {
  id: number;
  hp: number;
  collider: import('@dimforge/rapier3d-compat').Collider;
  geo: MapDef['destructibles'][number]['geo'];
  type: string;
  alive: boolean;
}

export class Match {
  readonly events = new EventBus<MatchEventsMap>();
  readonly rng: Rng;
  readonly phys: PhysicsWorld;
  readonly nav = new NavGraph();
  readonly movement: MovementSystem;
  readonly combat: CombatSystem;
  readonly loot: LootSystem;
  readonly storm: Storm;
  readonly mapDef: MapDef;
  readonly difficulty: Difficulty;

  actors: Actor[] = [];
  player: Actor | null = null;
  controllers = new Map<number, ActorController>();

  phase: MatchPhase = 'transport';
  time = 0;
  phaseTime = 0;

  transportT = 0;
  transportFrom: [number, number];
  transportTo: [number, number];
  transportDuration: number;
  transportPos = { x: 0, y: MATCH.transportAltitude, z: 0 };

  chests: ChestEntity[] = [];
  killFeed: KillFeedEntry[] = [];
  /** Sequentially-claimed drop targets so bots spread across the map. */
  dropClaims: Array<{ x: number; z: number }> = [];
  winner: Actor | null = null;
  aliveCount = 0;
  finished = false;

  private waterVolumes: WaterVolume[];
  private pendingEliminations: Array<{ victim: Actor; killer: Actor | null; weaponId: WeaponId | null; headshot: boolean; storm: boolean }> = [];

  constructor(cfg: MatchConfig) {
    this.mapDef = cfg.mapDef;
    this.difficulty = cfg.difficulty;
    this.rng = new Rng(cfg.seed);
    setGameSeed(cfg.seed ^ 0x5f3759df);
    this.phys = new PhysicsWorld();

    // Static world colliders
    buildColliders(this.mapDef, this.phys);
    this.phys.flush();

    this.waterVolumes = this.mapDef.water;

    // Core systems
    this.movement = new MovementSystem(this.phys, this.movementEvents());
    this.combat = new CombatSystem(this.phys, this.movement, this.combatEvents());
    this.loot = new LootSystem(this.lootEvents());
    this.storm = new Storm(this.mapDef.size, this.rng, this.stormEvents());

    this.movement.waterAt = (x, y, z) => this.waterAt(x, y, z);
    this.movement.bounds = { half: this.mapDef.size / 2 - 8 };
    this.combat.waterAt = (x, y, z) => this.waterAt(x, y, z);
    this.combat.attackerLookup = (id) => this.actors.find((a) => a.id === id) ?? null;

    // Fall damage can kill — route those deaths through the elimination pipeline.
    this.events.on('land', (e) => {
      if (e.fallDamage <= 0) return;
      const victim = this.actors.find((a) => a.id === e.actorId);
      if (victim && !victim.alive) {
        this.pendingEliminations.push({ victim, killer: null, weaponId: null, headshot: false, storm: false });
      }
    });

    // Destructibles: colliders + combat registration
    const drefs: DestructibleInstance[] = [];
    let did = 1;
    for (const d of this.mapDef.destructibles) {
      const id = did++;
      const hint = hintOf(d.type);
      const collider =
        d.geo.kind === 'box'
          ? this.phys.addDestructibleBox(id, d.geo.x, d.geo.y, d.geo.z, d.geo.sx / 2, d.geo.sy / 2, d.geo.sz / 2, hint)
          : this.phys.addDestructibleBox(id, d.geo.x, d.geo.y, d.geo.z, (d.geo.r ?? 0.5) * 0.85, (('h' in d.geo ? d.geo.h : undefined) ?? 1) / 2, (d.geo.r ?? 0.5) * 0.85, hint);
      drefs.push({ id, hp: d.hp, collider, geo: d.geo, type: d.type, alive: true });
    }
    this.combat.registerDestructibles(drefs as never);
    this.phys.flush();

    // Navigation graph
    this.nav.build(this.mapDef, this.phys);

    // Transport route
    this.transportFrom = this.mapDef.transportRoute.from;
    this.transportTo = this.mapDef.transportRoute.to;
    const dist = Math.hypot(this.transportTo[0] - this.transportFrom[0], this.transportTo[1] - this.transportFrom[1]);
    this.transportDuration = dist / MATCH.transportSpeed;

    // Chest entities
    let cid = 1;
    for (const c of this.mapDef.chests) {
      this.chests.push({ id: cid++, kind: c.kind, x: c.x, y: c.y, z: c.z, opened: false, openT: 0 });
    }

    // Actors start aboard the transport
    this.spawnActors(cfg);

    this.aliveCount = this.actors.length;
  }

  // -------------------------------------------------------------------------
  // Setup helpers
  // -------------------------------------------------------------------------

  private spawnActors(cfg: MatchConfig): void {
    const roster = BOT_PERSONALITIES;
    const names: string[] = [];
    const colors: number[] = [];
    const pers: (BotPersonality | null)[] = [];
    if (cfg.withPlayer) {
      names.push('YOU');
      colors.push(0x5fd0ff);
      pers.push(null);
    }
    const botCount = MATCH.combatantCount - (cfg.withPlayer ? 1 : 0);
    for (let i = 0; i < botCount; i++) {
      const p = roster[i % roster.length]!;
      names.push(p.name);
      colors.push(p.accentColor);
      pers.push(p);
    }

    for (let i = 0; i < names.length; i++) {
      const body = new CharBody(this.phys, i + 1, this.transportPos.x, this.transportPos.y, this.transportPos.z);
      const actor = new Actor(names[i]!, i === 0 && cfg.withPlayer, body, colors[i]!, pers[i]);
      this.actors.push(actor);
      if (actor.isPlayer) this.player = actor;
    }
  }

  waterAt(x: number, y: number, z: number): WaterVolume | null {
    for (const w of this.waterVolumes) {
      if (x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ && y <= w.surfaceY + 0.2) return w;
    }
    return null;
  }

  surfaceQuery = (x: number, z: number, fromY: number): number | null => {
    return this.phys.surfaceAt(x, z, fromY, 60);
  };

  difficultyProfile() {
    return DIFFICULTY[this.difficulty];
  }

  // -------------------------------------------------------------------------
  // Event adapters
  // -------------------------------------------------------------------------

  private movementEvents(): MovementEvents {
    return {
      onFootstep: (a, running) => {
        // Resolve ground material for audio (cheap downward ray at stride rate).
        let surface: 'stone' | 'metal' | 'wood' | 'grass' | 'water' = 'stone';
        const hit = this.phys.raycast(a.body.position.x, a.body.position.y + 0.4, a.body.position.z, 0, -1, 0, 1.6, PHYS_GROUPS.rayWorldOnly);
        if (hit?.collider) {
          const meta = this.phys.metaOf(hit.collider);
          if (meta && meta.kind === 'world') {
            const m = meta.material as string;
            if (m === 'metal' || m === 'wood' || m === 'grass' || m === 'water') surface = m;
            else if (m === 'dirt' || m === 'foliage') surface = 'grass';
          }
        }
        this.events.emit('footstep', { actorId: a.id, x: a.body.position.x, y: a.body.position.y, z: a.body.position.z, running, surface });
      },
      onLand: (a, speed, dmg) => {
        this.events.emit('land', { actorId: a.id, impactSpeed: speed, fallDamage: dmg });
      },
      onJump: (a, kind) => this.events.emit('jump', { actorId: a.id, kind }),
      onSlide: (a) => this.events.emit('slide', { actorId: a.id }),
      onWallrunStart: (a) => this.events.emit('wallrunStart', { actorId: a.id }),
      onMantle: (a) => this.events.emit('mantle', { actorId: a.id }),
      onGrappleAttach: (a) =>
        this.events.emit('grappleAttach', { actorId: a.id, x: a.grapplePoint.x, y: a.grapplePoint.y, z: a.grapplePoint.z }),
      onGrappleRelease: (a) => this.events.emit('grappleRelease', { actorId: a.id }),
      onPoundImpact: (a, x, y, z) => {
        this.events.emit('poundImpact', { actorId: a.id, x, y, z });
        this.poundAoE(a, x, y, z);
      },
      onDash: (a) => this.events.emit('dash', { actorId: a.id }),
      onSplash: (a, heavy) => this.events.emit('splash', { actorId: a.id, heavy }),
    };
  }

  private poundAoE(source: Actor, x: number, y: number, z: number): void {
    for (const other of this.actors) {
      if (!other.alive || other === source) continue;
      const dx = other.body.position.x - x;
      const dy = other.body.position.y - y;
      const dz = other.body.position.z - z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > MOVE.poundRadius) continue;
      const falloff = 1 - dist / MOVE.poundRadius;
      const dealt = other.applyDamage(MOVE.poundDamageMax * falloff);
      source.stats.damageDealt += dealt;
      other.lastAttackerId = source.id;
      const kb = MOVE.poundKnockback * falloff;
      const l = Math.max(dist, 0.01);
      other.body.velocity.x += (dx / l) * kb;
      other.body.velocity.z += (dz / l) * kb;
      other.body.velocity.y += kb * 0.45;
      if (!other.alive) {
        this.pendingEliminations.push({ victim: other, killer: source, weaponId: null, headshot: false, storm: false });
      }
    }
  }

  private combatEvents(): CombatEvents {
    return {
      onMuzzleFlash: (a, weaponId) => {
        const dir = this.movement.lookDir(a);
        this.events.emit('muzzleFlash', {
          actorId: a.id, x: a.body.position.x, y: a.eyeY, z: a.body.position.z,
          dx: dir.x, dy: dir.y, dz: dir.z, weaponId,
        });
      },
      onShotFired: (a, weaponId, x, y, z) => {
        const w = a.inv.selectedWeapon;
        const dry = !w || w.ammoInMag === 0;
        this.events.emit('shotFired', { actorId: a.id, weaponId, x, y, z, dry });
      },
      onImpact: (x, y, z, nx, ny, nz, material) => {
        this.events.emit('impact', { x, y, z, nx, ny, nz, material });
      },
      onActorHit: (target, attacker, damage, region, weaponId, killed, headshot) => {
        this.events.emit('actorHit', {
          targetId: target.id, attackerId: attacker?.id ?? -1, damage, region, killed, headshot, weaponId,
          shieldDamage: target.lastShieldDamage,
        });
        if (headshot && attacker?.isPlayer && !killed) {
          this.events.emit('headshotFeedback', { attackerId: attacker.id });
        }
        if (target.healing) {
          target.healing = null;
          this.events.emit('healCancelled', { actorId: target.id });
        }
        if (killed && attacker) {
          this.pendingEliminations.push({ victim: target, killer: attacker, weaponId, headshot, storm: false });
        } else if (killed) {
          this.pendingEliminations.push({ victim: target, killer: null, weaponId, headshot, storm: false });
        }
      },
      onShieldBroken: (target) => {
        this.events.emit('shieldBroken', { actorId: target.id });
      },
      onTracer: (x1, y1, z1, x2, y2, z2, color) => {
        this.events.emit('tracer', { x1, y1, z1, x2, y2, z2, color });
      },
      onRicochet: (x, y, z) => this.events.emit('ricochet', { x, y, z }),
      onGlassBreak: (x, y, z) => this.events.emit('glassBreak', { x, y, z }),
      onDestructibleDamaged: (id, x, y, z, destroyed) => {
        if (destroyed) this.events.emit('destructibleDestroyed', { id, x, y, z });
      },
    };
  }

  private lootEvents(): LootEvents {
    return {
      onSpawn: (item) => this.events.emit('itemSpawned', { itemId: item.id }),
      onPickup: (item, actor) => this.events.emit('itemPickedUp', { itemId: item.id, actorId: actor.id, rare: item.kind === 'weapon' && (item.rarity === 'epic' || item.rarity === 'legendary') }),
    };
  }

  private stormEvents(): StormEvents {
    return {
      onPhaseWaiting: (index, waitTime, targetRadius) =>
        this.events.emit('stormWaiting', { index, waitTime, targetRadius }),
      onShrinkStart: (index, shrinkTime) => this.events.emit('stormShrinking', { index, shrinkTime }),
      onFinalCircle: () => this.events.emit('stormFinal', {}),
    };
  }

  // -------------------------------------------------------------------------
  // Fixed update
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (this.finished && this.phase === 'results') return;
    this.time += dt;
    this.phaseTime += dt;

    // Controllers produce commands
    const commands = new Map<number, InputCommand>();
    for (const a of this.actors) {
      if (!a.alive) continue;
      const ctrl = this.controllers.get(a.id);
      const cmd = ctrl ? ctrl.updateCommand(a, dt) : emptyCommand();
      commands.set(a.id, cmd);
    }

    switch (this.phase) {
      case 'transport':
        this.updateTransport(dt, commands);
        break;
      case 'drop':
      case 'live':
        this.updateLive(dt, commands);
        break;
      case 'results':
        break;
    }

    // Advance the physics world (syncs query pipelines, integrates bodies).
    this.phys.fixedStep(dt);

    this.processEliminations();

    if (this.phase !== 'transport') {
      this.storm.update(dt);
      this.applyStormDamage(dt);
    }

    this.checkWin();
  }

  private updateTransport(dt: number, commands: Map<number, InputCommand>): void {
    this.transportT += dt / this.transportDuration;
    const t = Math.min(1, this.transportT);
    this.transportPos.x = this.transportFrom[0] + (this.transportTo[0] - this.transportFrom[0]) * t;
    this.transportPos.z = this.transportFrom[1] + (this.transportTo[1] - this.transportFrom[1]) * t;
    this.transportPos.y = MATCH.transportAltitude;

    let allOut = true;
    for (const a of this.actors) {
      if (!a.alive || a.state === 'freefall' || a.state === 'glide') continue;
      allOut = false;
      const cmd = commands.get(a.id)!;
      a.yaw = cmd.yaw;
      a.pitch = cmd.pitch;
      a.body.teleport(this.transportPos.x, this.transportPos.y, this.transportPos.z);
      const forced = t >= 1;
      if (cmd.jumpPressed || forced) {
        a.body.teleport(this.transportPos.x, this.transportPos.y - 3, this.transportPos.z);
        a.body.velocity.x = 0; a.body.velocity.y = -6; a.body.velocity.z = 0;
        this.movement.beginFreefall(a);
        this.events.emit('transportJumped', { actorId: a.id });
      }
    }

    if (allOut) this.setPhase('drop');
  }

  private setPhase(p: MatchPhase): void {
    this.phase = p;
    this.phaseTime = 0;
    this.events.emit('phaseChanged', { phase: p });
    if (p === 'live') {
      this.storm.begin();
    }
  }

  private updateLive(dt: number, commands: Map<number, InputCommand>): void {
    if (this.phase === 'drop') {
      const anyLanded = this.actors.some((a) => a.alive && a.deployed);
      if (anyLanded) this.setPhase('live');
    }

    for (const a of this.actors) {
      if (!a.alive) continue;
      const cmd = commands.get(a.id)!;
      a.stats.survivalTime += dt;
      if (a.lastDamageTime < 90) a.lastDamageTime += dt;

      a.adsHeld = cmd.adsHeld;
      a.yaw = cmd.yaw;
      a.pitch = clampPitch(cmd.pitch);

      if (cmd.slotRequest !== null) {
        if (a.inv.select(cmd.slotRequest)) {
          this.cancelReload(a);
          a.wpn.swapTimer = this.swapTimeFor(a);
        }
      }
      if (cmd.dropWeaponPressed) this.dropSelectedWeapon(a);

      this.updateHealing(a, cmd, dt);

      this.combat.updateWeaponTimers(a, dt);
      const w = a.inv.selectedWeapon;
      if (w && cmd.fireHeld) {
        const def = WEAPONS[w.weaponId];
        const wantsFire = def.fireMode === 'auto' ? true : cmd.firePressed;
        if (wantsFire) this.combat.tryFire(a, dt);
      }
      if (cmd.reloadPressed && this.combat.tryReload(a)) {
        this.events.emit('reloadStarted', { actorId: a.id, empty: a.wpn.reloadingEmpty });
      }

      if (cmd.grapplePressed) {
        if (a.grappleActive) this.movement.releaseGrapple(a);
        else this.movement.tryGrapple(a);
      }
      if (cmd.grappleRelease) this.movement.releaseGrapple(a);

      this.movement.update(a, cmd, dt);

      if (cmd.interactPressed) this.tryInteract(a);

      this.autoPickupAmmo(a);
    }

    this.combat.update(dt, this.actors);
    this.loot.update(dt, this.surfaceQuery);

    for (const c of this.chests) {
      if (c.opened && c.openT < 1) c.openT = Math.min(1, c.openT + dt * 2.4);
    }
  }

  private cancelReload(a: Actor): void {
    a.wpn.reloadTimer = 0;
    a.wpn.reloadingEmpty = false;
  }

  private swapTimeFor(a: Actor): number {
    const w = a.inv.selectedWeapon;
    return w ? WEAPONS[w.weaponId].swapInTime : 0.3;
  }

  private dropSelectedWeapon(a: Actor): void {
    const w = a.inv.selectedWeapon;
    if (!w) return;
    const p = a.body.position;
    const fwd = { x: Math.sin(a.yaw), z: Math.cos(a.yaw) };
    this.cancelReload(a);
    a.inv.removeSlot(a.inv.selected);
    this.loot.spawnWeapon(p.x + fwd.x * 1.4, p.y + 1.2, p.z + fwd.z * 1.4, w, this.rng, false);
  }

  private updateHealing(a: Actor, cmd: InputCommand, dt: number): void {
    if (a.healing) {
      a.healing.remaining -= dt;
      const interrupted = cmd.firePressed || cmd.jumpPressed || cmd.dashPressed;
      if (a.healing.remaining <= 0) {
        if (a.healing.itemId === 'medkit') a.healHealth(75);
        else a.addShield(50);
        this.events.emit('healDone', { actorId: a.id, item: a.healing.itemId });
        a.healing = null;
      } else if (interrupted) {
        this.events.emit('healCancelled', { actorId: a.id });
        a.healing = null;
      }
      return;
    }
    if (cmd.medkitPressed && a.health < 100) {
      if (a.inv.findHeal('medkit')) {
        a.inv.consumeHeal('medkit');
        a.healing = { itemId: 'medkit', remaining: 5, total: 5 };
        this.events.emit('healStarted', { actorId: a.id, item: 'medkit' });
      }
      return;
    }
    if (cmd.shieldPressed && a.shield < 100) {
      if (a.inv.findHeal('shieldpot')) {
        a.inv.consumeHeal('shieldpot');
        a.healing = { itemId: 'shieldpot', remaining: 3, total: 3 };
        this.events.emit('healStarted', { actorId: a.id, item: 'shieldpot' });
      }
    }
  }

  tryInteract(a: Actor): void {
    const p = a.body.position;
    let bestChest: ChestEntity | null = null;
    let bestCD = GAMEPLAY.interactionRange * GAMEPLAY.interactionRange;
    for (const c of this.chests) {
      if (c.opened) continue;
      const dx = c.x - p.x, dy = c.y - (p.y + 1), dz = c.z - p.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestCD) {
        bestCD = d;
        bestChest = c;
      }
    }
    if (bestChest) {
      bestChest.opened = true;
      this.loot.openChest(bestChest.kind, bestChest.x, bestChest.y + 0.4, bestChest.z, this.rng);
      const chestTier = bestChest.kind === 'vault' ? 2 : bestChest.kind === 'elite' ? 1 : 0;
      this.events.emit('chestOpened', { chestId: bestChest.id, kind: bestChest.kind, tier: chestTier, x: bestChest.x, y: bestChest.y, z: bestChest.z });
      return;
    }
    const item = this.loot.nearestItem(p.x, p.y + 1, p.z, GAMEPLAY.interactionRange + 0.8, (it) => it.kind !== 'ammo');
    if (item) {
      const displaced = this.loot.pickup(item, a, !a.isPlayer);
      if (displaced && displaced.kind === 'weapon') {
        this.loot.spawnWeapon(p.x, p.y + 1, p.z, displaced, this.rng, true);
      } else if (displaced && displaced.kind === 'heal') {
        this.loot.spawnHeal(p.x, p.y + 1, p.z, displaced.itemId, displaced.count, this.rng, true);
      }
    }
  }

  private autoPickupAmmo(a: Actor): void {
    const p = a.body.position;
    for (const it of [...this.loot.items]) {
      if (it.kind !== 'ammo') continue;
      const dx = it.x - p.x, dy = it.y - (p.y + 1), dz = it.z - p.z;
      if (dx * dx + dy * dy + dz * dz < GAMEPLAY.pickupRadius * GAMEPLAY.pickupRadius) {
        this.loot.pickup(it, a);
      }
    }
  }

  private applyStormDamage(dt: number): void {
    if (this.storm.state === 'idle') return;
    for (const a of this.actors) {
      if (!a.alive) continue;
      const p = a.body.position;
      if (this.storm.isOutside(p.x, p.z)) {
        a.applyDamage(this.storm.dps * dt);
        if (!a.alive) {
          this.pendingEliminations.push({ victim: a, killer: null, weaponId: null, headshot: false, storm: true });
        }
      }
    }
  }

  private processEliminations(): void {
    while (this.pendingEliminations.length) {
      const e = this.pendingEliminations.shift()!;
      const victim = e.victim;
      if (victim.alive) continue;
      const aliveBefore = this.actors.filter((a) => a.alive).length + 1;
      victim.placement = aliveBefore;
      victim.deathTime = this.time;
      if (e.killer && e.killer !== victim) e.killer.stats.kills++;

      this.killFeed.push({
        time: this.time,
        killerName: e.killer ? e.killer.name : null,
        killerId: e.killer?.id ?? -1,
        victimName: victim.name,
        victimId: victim.id,
        weaponId: e.weaponId,
        headshot: e.headshot,
        storm: e.storm,
      });
      if (this.killFeed.length > 30) this.killFeed.shift();

      this.loot.dropInventory(victim, this.rng);
      this.aliveCount = this.actors.filter((a) => a.alive).length;
      this.events.emit('eliminated', {
        victimId: victim.id,
        killerId: e.killer?.id ?? -1,
        weaponId: e.weaponId,
        headshot: e.headshot,
        storm: e.storm,
        placement: victim.placement,
      });
    }
  }

  private checkWin(): void {
    if (this.finished || this.phase === 'results') return;
    if (this.phase === 'transport' || this.phase === 'drop') return;
    const alive = this.actors.filter((a) => a.alive);
    if (alive.length <= 1) {
      this.finished = true;
      const winner = alive[0] ?? this.actors.reduce((last, a) => (a.deathTime > last.deathTime ? a : last), this.actors[0]!);
      winner.placement = 1;
      this.winner = winner;
      // Final placements: survivors first (by survival time), then by death order.
      const sorted = [...this.actors].sort((x, y) => {
        if (x.alive !== y.alive) return x.alive ? -1 : 1;
        return y.deathTime - x.deathTime;
      });
      sorted.forEach((a, i) => { a.placement = i + 1; });
      this.setPhase('results');
      this.events.emit('matchWon', { winnerId: winner.id, winnerName: winner.name });
    }
  }

  /** Initial world loot scatter (call once after construction). */
  populateInitialLoot(): void {
    for (const spawn of this.mapDef.loot) {
      this.loot.spawnFloorLoot(spawn.x, spawn.y, spawn.z, spawn.bias, this.rng);
    }
    // Density pass: distribute additional floor loot around POIs on the nav
    // graph so every match supports 10 combatants' equipment needs.
    const pois = this.mapDef.pois;
    const extraTarget = Math.max(80, Math.floor(this.mapDef.size * 0.3));
    let placed = 0;
    let guard = 0;
    while (placed < extraTarget && guard++ < extraTarget * 8) {
      const poi = pois[this.rng.int(0, pois.length - 1)]!;
      const ang = this.rng.angle();
      const rad = Math.sqrt(this.rng.next()) * poi.radius;
      const x = poi.x + Math.cos(ang) * rad;
      const z = poi.z + Math.sin(ang) * rad;
      const node = this.nav.nearest(x, z, 18);
      if (!node || node.water) continue;
      const bias = this.rng.weighted([46, 34, 20]) === 0 ? undefined : undefined;
      void bias;
      const kindRoll = this.rng.weighted([50, 32, 18]);
      const bias2 = kindRoll === 0 ? 'weapon' : kindRoll === 1 ? 'ammo' : 'heal';
      this.loot.spawnFloorLoot(node.x, node.y + 0.35, node.z, bias2 as 'weapon' | 'ammo' | 'heal', this.rng);
      placed++;
    }
  }

  spectatorTargets(): Actor[] {
    return this.actors.filter((a) => a.alive);
  }
}

function hintOf(type: string): 'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'foliage' {
  switch (type) {
    case 'glass': return 'glass';
    case 'crate': case 'fence': case 'furniture': return 'wood';
    case 'lamp': case 'sign': return 'metal';
    default: return 'stone';
  }
}

function clampPitch(p: number): number {
  const lim = Math.PI / 2 - 0.02;
  return Math.max(-lim, Math.min(lim, p));
}
