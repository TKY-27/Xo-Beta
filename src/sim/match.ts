/**
 * Match: owns the full simulation — actors, controllers, transport/drop,
 * storm, loot, combat resolution, eliminations, win detection.
 *
 * Strictly renderer-independent: headless bot simulations run this directly.
 */

import {
  BOT_PERSONALITIES, DIFFICULTY, GAMEPLAY, HEALTH_MAX, HEAL_ITEMS, MATCH, MOVE,
  SHIELD_MAX, WEAPONS,
  type BotPersonality, type Difficulty, type WeaponId,
} from '../core/balance';
import { EventBus } from '../core/events';
import { Rng, setGameSeed } from '../core/rng';
import {
  CharBody,
  feetYFromBodyCenter,
  PhysicsWorld,
  GROUPS as PHYS_GROUPS,
} from '../physics/physics';
import {
  buildColliders,
  filterInvalidCrates,
  groundCrates,
  resolveSupportedChests,
} from '../world/builder';
import { NavGraph } from '../world/nav';
import type { MapDef, WaterVolume } from '../world/types';
import { Actor } from './actor';
import { emptyCommand, type InputCommand } from './input';
import { MovementSystem, CAPSULE_CENTER_OFFSET, type MovementEvents } from './movement';
import { CombatSystem, type CombatEvents } from './combat';
import { LootSystem, type LootEvents, type WorldItem } from './loot';
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

/** Test a point against the complete finite water volume, including its bed. */
export function waterVolumeContains(w: WaterVolume, x: number, y: number, z: number): boolean {
  return x >= w.minX && x <= w.maxX
    && z >= w.minZ && z <= w.maxZ
    && y >= w.surfaceY - w.depth
    && y <= w.surfaceY + 0.2;
}

export type GroundSurface = 'stone' | 'metal' | 'wood' | 'grass' | 'water';

/** Resolve the material directly under the soles, never under the capsule centre. */
export function groundSurfaceForActor(phys: PhysicsWorld, actor: Actor): GroundSurface {
  let surface: GroundSurface = 'stone';
  const feetY = feetYFromBodyCenter(actor.body.position.y);
  const hit = phys.raycast(actor.body.position.x, feetY + 0.55, actor.body.position.z,
    0, -1, 0, 0.9, PHYS_GROUPS.rayWorldOnly);
  if (!hit?.collider) return surface;
  const meta = phys.metaOf(hit.collider);
  if (!meta || meta.kind !== 'world') return surface;
  const material = meta.material as string;
  if (material === 'metal' || material === 'wood' || material === 'grass' || material === 'water') {
    surface = material;
  } else if (material === 'dirt' || material === 'foliage') {
    surface = 'grass';
  }
  return surface;
}

export interface MatchEventsMap {
  shotFired: { actorId: number; weaponId: WeaponId; x: number; y: number; z: number; dry: boolean };
  footstep: { actorId: number; x: number; y: number; z: number; running: boolean; surface: 'stone' | 'metal' | 'wood' | 'grass' | 'water' };
  muzzleFlash: { actorId: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; weaponId: WeaponId };
  impact: { x: number; y: number; z: number; nx: number; ny: number; nz: number; material: string };
  tracer: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; color: number };
  ricochet: { x: number; y: number; z: number };
  glassBreak: { destructibleId: string; x: number; y: number; z: number };
  destructibleDestroyed: { id: number; destructibleId: string; x: number; y: number; z: number };
  actorHit: { targetId: number; attackerId: number; damage: number; region: string; killed: boolean; headshot: boolean; weaponId: WeaponId | 'melee'; shieldDamage: number };
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
  land: { actorId: number; impactSpeed: number; fallDamage: number; surface: 'stone' | 'metal' | 'wood' | 'grass' | 'water' };
  slide: { actorId: number };
  wallrunStart: { actorId: number };
  mantle: { actorId: number };
  dash: { actorId: number };
  grappleAttach: { actorId: number; x: number; y: number; z: number };
  grappleRelease: { actorId: number };
  poundImpact: { actorId: number; x: number; y: number; z: number };
  splash: { actorId: number; x: number; y: number; z: number; heavy: boolean };
  transportJumped: { actorId: number };
  /** Fired once when the transport crosses into the playable bounds and the
   * jump gate unlocks. */
  transportGateOpened: Record<string, never>;
  phaseChanged: { phase: MatchPhase };
  matchWon: { winnerId: number; winnerName: string };
  reloadStarted: { actorId: number; empty: boolean };
  meleeSwing: { actorId: number; x: number; y: number; z: number; yaw: number };
  meleeHit: { targetId: number; attackerId: number; damage: number; killed: boolean; headshot: boolean };
}

export interface MatchConfig {
  mapDef: MapDef;
  seed: number;
  difficulty: Difficulty;
  withPlayer: boolean;
  /** Solo exploration mode: no bots, no storm, no win condition. */
  practice?: boolean;
}

export interface ActorController {
  updateCommand(actor: Actor, dt: number): InputCommand;
}

interface DestructibleInstance {
  id: number;
  stableId: string;
  hp: number;
  collider: import('@dimforge/rapier3d-compat').Collider;
  geo: MapDef['destructibles'][number]['geo'];
  type: string;
  alive: boolean;
}

export class Match {
  readonly events = new EventBus<MatchEventsMap>();
  readonly seed: number;
  readonly rng: Rng;
  readonly phys: PhysicsWorld;
  readonly nav = new NavGraph();
  readonly movement: MovementSystem;
  readonly combat: CombatSystem;
  readonly loot: LootSystem;
  readonly storm: Storm;
  readonly mapDef: MapDef;
  readonly difficulty: Difficulty;
  readonly practice: boolean;
  practiceStart: { x: number; y: number; z: number; poi: string } | null = null;
  /** QA-only input override applied to the player command (see fixedUpdate). */
  qaInput: Partial<InputCommand> | null = null;

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
  /** Match seconds after which the transport is inside the playable bounds
   * and the jump gate unlocks (5 s with the default approach). */
  transportEnterTime = 0;
  private transportGateOpen = false;
  transportPos = { x: 0, y: MATCH.transportAltitude, z: 0 };
  /** Previous fixed-step transport position for render interpolation. */
  previousTransportPos = { x: 0, y: MATCH.transportAltitude, z: 0 };

  chests: ChestEntity[] = [];
  killFeed: KillFeedEntry[] = [];
  /** Sequentially-claimed drop targets so bots spread across the map. */
  dropClaims: Array<{ x: number; z: number }> = [];
  winner: Actor | null = null;
  aliveCount = 0;
  finished = false;

  private waterVolumes: WaterVolume[];
  private commands = new Map<number, InputCommand>();
  private pendingEliminations: Array<{ victim: Actor; killer: Actor | null; weaponId: WeaponId | null; headshot: boolean; storm: boolean }> = [];
  private processedEliminations = new Set<number>();

  constructor(cfg: MatchConfig) {
    this.seed = cfg.seed;
    this.mapDef = cfg.mapDef;
    this.difficulty = cfg.difficulty;
    this.practice = cfg.practice === true;
    this.rng = new Rng(cfg.seed);
    setGameSeed(cfg.seed ^ 0x5f3759df);
    this.phys = new PhysicsWorld();

    // Static world colliders
    buildColliders(this.mapDef, this.phys);
    this.phys.flush();

    // Loose props use the same finished geometry/heightfield as characters.
    // Do this before adding chest/destructible colliders so probes can never
    // ground an object on itself or on another loose pickup prop.
    groundCrates(this.mapDef, this.phys);
    filterInvalidCrates(this.mapDef);

    // Authored chest heights are hints, not a second ground system. Resolve
    // them against the finished physical world before adding their colliders,
    // so the probe cannot hit the chest itself and every visible base is
    // guaranteed to rest on the same surface actors collide with.
    const supportedChests = resolveSupportedChests(this.mapDef, this.phys);
    for (const chest of supportedChests) {
      this.phys.addStaticBox(chest.x, chest.y + 0.4, chest.z, 0.55, 0.4, 0.38, 0, 'wood');
    }
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
      drefs.push({ id, stableId: d.stableId, hp: d.hp, collider, geo: d.geo, type: d.type, alive: true });
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
    this.transportEnterTime = this.computeTransportEnterTime();
    // Start both presentation samples at the authored route origin. Leaving
    // the default (0, altitude, 0) here would create a large first-frame
    // interpolation jump on maps whose route starts elsewhere.
    this.transportPos.x = this.transportFrom[0];
    this.transportPos.y = MATCH.transportAltitude;
    this.transportPos.z = this.transportFrom[1];
    this.previousTransportPos.x = this.transportPos.x;
    this.previousTransportPos.y = this.transportPos.y;
    this.previousTransportPos.z = this.transportPos.z;

    // Chest entities
    let cid = 1;
    for (const c of supportedChests) {
      this.chests.push({ id: cid++, kind: c.kind, x: c.x, y: c.y, z: c.z, opened: false, openT: 0 });
    }

    // Actors start aboard the transport
    this.spawnActors(cfg);

    if (this.practice) {
      // Solo exploration: already deployed on the ground, match never ends.
      for (const a of this.actors) a.deployed = true;
      this.phase = 'live';
    }

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
    const botCount = this.practice ? 0 : MATCH.combatantCount - (cfg.withPlayer ? 1 : 0);
    for (let i = 0; i < botCount; i++) {
      const p = roster[i % roster.length]!;
      names.push(p.name);
      colors.push(p.accentColor);
      pers.push(p);
    }

    for (let i = 0; i < names.length; i++) {
      const sx = this.practice ? this.practiceSpawn().x : this.transportPos.x;
      const sy = this.practice ? this.practiceSpawn().y : this.transportPos.y;
      const sz = this.practice ? this.practiceSpawn().z : this.transportPos.z;
      const body = new CharBody(this.phys, i + 1, sx, sy, sz);
      const actor = new Actor(names[i]!, i === 0 && cfg.withPlayer, body, colors[i]!, pers[i]);
      this.actors.push(actor);
      if (actor.isPlayer) this.player = actor;
    }
  }

  /** Seeded ground spawn used to vary practice exploration routes. */
  private practiceSpawnCache: { x: number; y: number; z: number } | null = null;
  private practiceSpawn(): { x: number; y: number; z: number } {
    if (this.practiceSpawnCache) return this.practiceSpawnCache;
    const poi = this.mapDef.pois.length > 0
      ? this.mapDef.pois[this.rng.int(0, this.mapDef.pois.length - 1)]
      : undefined;
    const candidates = poi
      ? this.nav.nodesWithin(poi.x, poi.z, poi.radius).filter((node) => !node.water && node.edges.length > 0)
      : [];
    // Practice should open into a readable exploration space, not a narrow
    // interior where the TPS boom immediately collapses against a wall. Rank
    // valid navigation nodes by horizontal scenery clearance and then retain
    // seeded variety among the best candidates.
    const scored = candidates.map((node) => {
      let clearance = 0;
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        const dx = Math.sin(angle);
        const dz = Math.cos(angle);
        const hit = this.phys.raycast(node.x, node.y + 1.35, node.z, dx, 0, dz, 5.4, PHYS_GROUPS.rayWorldOnly);
        clearance += hit ? Math.min(1, hit.dist / 5.4) : 1;
      }
      return { node, clearance };
    }).sort((a, b) => b.clearance - a.clearance);
    const bestClearance = scored[0]?.clearance ?? 0;
    const spacious = scored.filter((entry) => entry.clearance >= bestClearance - 0.55).slice(0, 12);
    const node = spacious.length > 0 ? this.rng.pick(spacious).node : candidates.length > 0 ? this.rng.pick(candidates) : null;
    const x = node?.x ?? poi?.x ?? 0;
    const z = node?.z ?? poi?.z ?? 0;
    const surf = node?.y ?? this.phys.surfaceAt(x, z, 300, 500) ?? 2;
    const y = surf + CAPSULE_CENTER_OFFSET + 0.05;
    this.practiceSpawnCache = { x, y, z };
    this.practiceStart = { x, y, z, poi: poi?.name ?? 'Map centre' };
    return this.practiceSpawnCache;
  }

  waterAt(x: number, y: number, z: number): WaterVolume | null {
    for (const w of this.waterVolumes) {
      if (waterVolumeContains(w, x, y, z)) return w;
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
        const surface = groundSurfaceForActor(this.phys, a);
        this.events.emit('footstep', {
          actorId: a.id,
          x: a.body.position.x,
          y: feetYFromBodyCenter(a.body.position.y),
          z: a.body.position.z,
          running,
          surface,
        });
      },
      onLand: (a, speed, dmg) => {
        const surface = groundSurfaceForActor(this.phys, a);
        this.events.emit('land', { actorId: a.id, impactSpeed: speed, fallDamage: dmg, surface });
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
      onSplash: (a, heavy) =>
        this.events.emit('splash', {
          actorId: a.id,
          x: a.body.position.x,
          y: a.waterSurfaceY,
          z: a.body.position.z,
          heavy,
        }),
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
      onMuzzleFlash: (a, weaponId, x, y, z, dx, dy, dz) => {
        this.events.emit('muzzleFlash', {
          actorId: a.id, x, y, z, dx, dy, dz, weaponId,
        });
      },
      onShotFired: (a, weaponId, x, y, z, dry) => {
        this.events.emit('shotFired', { actorId: a.id, weaponId, x, y, z, dry });
      },
      onReloadStarted: (a, empty) => {
        this.events.emit('reloadStarted', { actorId: a.id, empty });
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
      onGlassBreak: (destructibleId, x, y, z) => this.events.emit('glassBreak', { destructibleId, x, y, z }),
      onDestructibleDamaged: (id, destructibleId, x, y, z, destroyed) => {
        if (destroyed) this.events.emit('destructibleDestroyed', { id, destructibleId, x, y, z });
      },
      onMeleeSwing: (a, x, y, z) => {
        this.events.emit('meleeSwing', { actorId: a.id, x, y, z, yaw: a.yaw });
      },
      onMeleeHit: (target, attacker, damage, killed, headshot) => {
        this.events.emit('meleeHit', { targetId: target.id, attackerId: attacker.id, damage, killed, headshot });
        this.events.emit('actorHit', {
          targetId: target.id, attackerId: attacker.id, damage, region: headshot ? 'head' : 'chest',
          killed, headshot, weaponId: 'melee',
          shieldDamage: target.lastShieldDamage,
        });
        if (target.healing) {
          target.healing = null;
          this.events.emit('healCancelled', { actorId: target.id });
        }
        if (killed) {
          this.pendingEliminations.push({ victim: target, killer: attacker, weaponId: null, headshot, storm: false });
        }
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
    // Capture the authoritative value before this fixed step mutates it. The
    // renderer can interpolate previousTransportPos -> transportPos using its
    // accumulator remainder without changing simulation state.
    this.previousTransportPos.x = this.transportPos.x;
    this.previousTransportPos.y = this.transportPos.y;
    this.previousTransportPos.z = this.transportPos.z;

    // Controllers produce commands
    const commands = this.commands;
    commands.clear();
    for (const a of this.actors) {
      if (!a.alive) continue;
      const ctrl = this.controllers.get(a.id);
      const cmd = ctrl ? ctrl.updateCommand(a, dt) : emptyCommand();
      // QA-harness override (browser automation cannot engage pointer lock,
      // so it drives fire/ADS through here; null during normal play).
      if (a.isPlayer && this.qaInput) Object.assign(cmd, this.qaInput);
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

    if (this.phase !== 'transport' && !this.practice) {
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

    // Jump gate: disabled until the transport crosses into the playable
    // bounds (exactly the first ~5 s of the approach).
    if (!this.transportGateOpen && t * this.transportDuration >= this.transportEnterTime) {
      this.transportGateOpen = true;
      this.events.emit('transportGateOpened', {});
    }

    let allOut = true;
    for (const a of this.actors) {
      // `deployed` marks "has exited the transport" — a landed early jumper
      // must never be re-captured by the ride.
      if (!a.alive || a.deployed) continue;
      allOut = false;
      const cmd = commands.get(a.id)!;
      a.yaw = cmd.yaw;
      a.pitch = cmd.pitch;
      const forced = t >= 1;
      if ((cmd.jumpPressed && this.transportGateOpen) || forced) {
        a.body.teleport(this.transportPos.x, this.transportPos.y - MATCH.transportHangOffset, this.transportPos.z);
        a.body.velocity.x = 0; a.body.velocity.y = -6; a.body.velocity.z = 0;
        this.movement.beginFreefall(a);
        this.events.emit('transportJumped', { actorId: a.id });
      }
    }

    // Everyone who has left the transport — airborne OR already landed —
    // simulates immediately with the exact same rules as the drop/live
    // phases. No actor ever waits on another actor, the route end, or the
    // phase flip (a landed early jumper keeps full control while bots ride).
    this.updateLive(dt, commands);

    if (allOut) this.setPhase('drop');
  }

  /** Match-time at which the transport path first crosses into playable
   * bounds, derived from the route geometry so custom routes stay correct. */
  private computeTransportEnterTime(): number {
    const half = this.mapDef.size / 2;
    const steps = 400;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = this.transportFrom[0] + (this.transportTo[0] - this.transportFrom[0]) * t;
      const z = this.transportFrom[1] + (this.transportTo[1] - this.transportFrom[1]) * t;
      if (Math.abs(x) <= half && Math.abs(z) <= half) return t * this.transportDuration;
    }
    return 0;
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
      // "Landed" = exited the transport AND no longer in a flight state.
      const anyLanded = this.actors.some((a) => a.alive && a.deployed &&
        a.state !== 'freefall' && a.state !== 'glide');
      if (anyLanded) this.setPhase('live');
    }

    for (const a of this.actors) {
      if (!a.alive) continue;
      // During the transport phase, actors still aboard are driven by
      // updateTransport's ride loop — never by live simulation.
      if (this.phase === 'transport' && !a.deployed) continue;
      const cmd = commands.get(a.id)!;
      a.stats.survivalTime += dt;
      if (a.lastDamageTime < 90) a.lastDamageTime += dt;

      a.adsHeld = cmd.adsHeld;
      a.yaw = cmd.yaw;
      a.pitch = clampPitch(cmd.pitch);

      if (cmd.slotRequest !== null) {
        this.selectInventorySlot(a, cmd.slotRequest);
      }
      if (cmd.meleePressed) {
        a.inv.selectMelee();
        this.cancelReload(a);
        a.wpn.swapTimer = 0.18;
      }
      if (cmd.dropWeaponPressed) this.dropSelectedWeapon(a);

      const selectedBeforeHealing = a.inv.selectedItem;
      this.updateHealing(a, cmd, dt);

      this.combat.updateWeaponTimers(a, dt);
      const selected = a.inv.selectedItem;
      const w = a.inv.selectedWeapon;
      if (w) {
        const def = WEAPONS[w.weaponId];
        // Auto weapons use the held state; semi-auto, pump and bolt weapons
        // consume one press edge per shot. A click is valid even when mouseup
        // happened before this fixed step sampled it.
        const wantsFire = def.fireMode === 'auto' ? cmd.fireHeld : cmd.firePressed;
        if (wantsFire) this.combat.tryFire(a, dt, undefined, cmd.firePressed);
      } else if (!selected && !(selectedBeforeHealing?.kind === 'heal' && cmd.firePressed)
        && (cmd.fireHeld || cmd.firePressed)) {
        this.combat.tryMelee(a, dt, this.actors);
      }
      if (cmd.reloadPressed) this.combat.tryReload(a);

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
    a.wpn.reloadTotal = 0;
    a.wpn.reloadingEmpty = false;
    a.wpn.reloadWeaponId = null;
    a.wpn.reloadInitialAmmo = 0;
    a.wpn.reloadRoundsLoaded = 0;
  }

  private swapTimeFor(a: Actor): number {
    const w = a.inv.selectedWeapon;
    return w ? WEAPONS[w.weaponId].swapInTime : 0.3;
  }

  /** Select a live player's inventory slot from the UI. */
  selectPlayerInventorySlot(slot: number): boolean {
    const player = this.player;
    if (!player || !player.alive) return false;
    return this.selectInventorySlot(player, slot);
  }

  private selectInventorySlot(a: Actor, slot: number): boolean {
    if (a.inv.selected === slot) return true;
    if (!a.inv.select(slot)) return false;
    this.cancelReload(a);
    a.wpn.swapTimer = this.swapTimeFor(a);
    return true;
  }

  /** Reorder two live player's inventory slots from the inventory UI. */
  reorderPlayerInventory(from: number, to: number): boolean {
    const player = this.player;
    if (!player || !player.alive) return false;
    if (from === to) return player.inv.swapSlots(from, to);
    const selectedWeapon = player.inv.selectedWeapon;
    const touchesSelected = player.inv.selected === from || player.inv.selected === to;
    const swapped = player.inv.swapSlots(from, to);
    if (!swapped) return false;
    // Selection follows the dragged item, but its reload animation must not
    // continue across an inventory move. Rounds already committed remain in
    // the weapon and reserve is never refunded.
    if (touchesSelected && selectedWeapon) this.cancelReload(player);
    return true;
  }

  /** Drop any live player's inventory item, including healing stacks. */
  dropPlayerInventorySlot(slot: number): boolean {
    const player = this.player;
    if (!player || !player.alive) return false;
    return this.dropInventorySlot(player, slot);
  }

  private dropSelectedWeapon(a: Actor): void {
    const slot = a.inv.selected;
    const item = slot >= 0 ? a.inv.slots[slot] : null;
    if (!item || item.kind !== 'weapon') return;
    this.dropInventorySlot(a, slot);
  }

  private dropInventorySlot(a: Actor, slot: number): boolean {
    if (slot < 0 || slot >= a.inv.slots.length) return false;
    const item = a.inv.slots[slot];
    if (!item) return false;
    const p = a.body.position;
    const fwd = { x: -Math.sin(a.yaw), z: -Math.cos(a.yaw) };
    if (a.inv.selected === slot) this.cancelReload(a);
    const removed = a.inv.removeSlot(slot);
    if (!removed) return false;
    const x = p.x + fwd.x * 1.4;
    const y = feetYFromBodyCenter(p.y) + 1.2;
    const z = p.z + fwd.z * 1.4;
    const dropped = removed.kind === 'weapon'
      ? this.loot.spawnWeapon(x, y, z, removed, this.rng, false)
      : this.loot.spawnHeal(x, y, z, removed.itemId, removed.count, this.rng, false);
    dropped.dropperId = a.id;
    dropped.pickupLockedUntil = this.loot.time + GAMEPLAY.dropPickupDelaySelf;
    return true;
  }

  private updateHealing(a: Actor, cmd: InputCommand, dt: number): void {
    if (a.healing) {
      a.healing.remaining -= dt;
      const interrupted = cmd.firePressed || cmd.jumpPressed || cmd.dashPressed;
      if (a.healing.remaining <= 0) {
        const def = HEAL_ITEMS[a.healing.itemId];
        if (a.healing.itemId === 'medkit') a.healHealth(def.amount);
        else a.addShield(def.amount);
        this.events.emit('healDone', { actorId: a.id, item: a.healing.itemId });
        a.healing = null;
      } else if (interrupted) {
        this.events.emit('healCancelled', { actorId: a.id });
        a.healing = null;
      }
      return;
    }
    // G/H keep their quick-use semantics. A selected heal stack can also be
    // activated with the same left-click edge used by weapons; held fire is
    // deliberately ignored so holding the mouse cannot repeatedly consume it.
    const selected = a.inv.selectedItem;
    const selectedHeal = selected?.kind === 'heal' ? selected.itemId : null;
    const requested = cmd.medkitPressed ? 'medkit'
      : cmd.shieldPressed ? 'shieldpot'
      : cmd.firePressed ? selectedHeal
      : null;
    if (!requested) return;

    const def = HEAL_ITEMS[requested];
    const canUse = requested === 'medkit' ? a.health < HEALTH_MAX : a.shield < SHIELD_MAX;
    if (!canUse) return;
    const slot = selectedHeal === requested ? a.inv.selected : a.inv.findHeal(requested)?.slot ?? -1;
    const stack = slot >= 0 ? a.inv.slots[slot] : null;
    if (!stack || stack.kind !== 'heal' || stack.itemId !== requested || stack.count <= 0) return;
    stack.count--;
    if (stack.count <= 0) a.inv.removeSlot(slot);
    a.healing = { itemId: requested, remaining: def.useTime, total: def.useTime };
    this.events.emit('healStarted', { actorId: a.id, item: requested });
  }

  tryInteract(a: Actor): void {
    const p = a.body.position;
    const feetY = p.y - CAPSULE_CENTER_OFFSET;
    const bestChest = this.nearestInteractableChest(a);
    if (bestChest) {
      bestChest.opened = true;
      a.interactTimer = 0.6;
      this.loot.openChest(bestChest.kind, bestChest.x, bestChest.y + 0.4, bestChest.z, this.rng);
      const chestTier = bestChest.kind === 'vault' ? 2 : bestChest.kind === 'elite' ? 1 : 0;
      this.events.emit('chestOpened', { chestId: bestChest.id, kind: bestChest.kind, tier: chestTier, x: bestChest.x, y: bestChest.y, z: bestChest.z });
      return;
    }
    const candidates = this.interactableItems(a);
    for (const item of candidates) {
      // Standard FPS behavior: interacting with your first floor weapon equips it
      // immediately instead of leaving the actor on fists. If the closest item
      // cannot be stored (for example a full heal stack while unarmed), try the
      // next deterministic candidate rather than making the prompt a dead end.
      const hadWeapon = a.inv.slots.some((s) => s !== null && s.kind === 'weapon');
      const displaced = this.loot.pickup(item, a, !a.isPlayer);
      if (displaced === false) continue;
      a.interactTimer = 0.5;
      if (displaced && displaced.kind === 'weapon') {
        this.loot.spawnWeapon(p.x, feetY + 1, p.z, displaced, this.rng, true);
      } else if (displaced && displaced.kind === 'heal') {
        this.loot.spawnHeal(p.x, feetY + 1, p.z, displaced.itemId, displaced.count, this.rng, true);
      }
      if (!hadWeapon) {
        const idx = a.inv.slots.findIndex((s) => s !== null && s.kind === 'weapon');
        if (idx >= 0) {
          a.inv.select(idx);
          this.cancelReload(a);
          a.wpn.swapTimer = this.swapTimeFor(a);
        }
      }
      break;
    }
  }

  /**
   * Shared chest resolver for both the HUD and the interaction itself. Chest
   * reach is horizontal from the actor's feet, with a floor-height guard so a
   * chest above or below the player cannot steal the prompt through a ceiling.
   */
  chestHasLineOfSightFrom(x: number, eyeY: number, z: number, chest: ChestEntity): boolean {
    // Chests have a real static collider. Aim the visibility segment at the
    // near face instead of its centre, otherwise the target chest blocks its
    // own interaction ray. Any wall before that face still rejects it.
    const towardActorX = x - chest.x;
    const towardActorZ = z - chest.z;
    const faceDistance = Math.max(
      Math.abs(towardActorX) / 0.55,
      Math.abs(towardActorZ) / 0.38,
    );
    if (faceDistance < 1e-6) return false;
    const faceScale = 1 / faceDistance;
    const targetX = chest.x + towardActorX * faceScale;
    const targetZ = chest.z + towardActorZ * faceScale;
    return !this.phys.losBlocked(x, eyeY, z, targetX, chest.y + 0.45, targetZ);
  }

  nearestInteractableChest(a: Actor, maxDist = GAMEPLAY.interactionRange): ChestEntity | null {
    const p = a.body.position;
    const feetY = feetYFromBodyCenter(p.y);
    const maxDistSq = maxDist * maxDist;
    let best: ChestEntity | null = null;
    let bestDistance = maxDistSq;
    for (const chest of this.chests) {
      if (chest.opened || Math.abs(chest.y - feetY) > 2.8) continue;
      const dx = chest.x - p.x;
      const dz = chest.z - p.z;
      const distance = dx * dx + dz * dz;
      if (distance > maxDistSq) continue;
      if (!this.chestHasLineOfSightFrom(p.x, a.eyeY, p.z, chest)) continue;
      if (distance < bestDistance || (distance === bestDistance && (best === null || chest.id < best.id))) {
        best = chest;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Resolve the one floor item an interaction prompt should describe.
   * Distance is measured from the actor's feet, matching the actual pickup
   * reach rather than the capsule centre, and ties use the stable world-item
   * id so a pile never changes target because of array iteration order.
   */
  nearestInteractableItem(a: Actor, maxDist = GAMEPLAY.interactionRange + 0.8): WorldItem | null {
    return this.interactableItems(a, maxDist)[0] ?? null;
  }

  private interactableItems(a: Actor, maxDist = GAMEPLAY.interactionRange + 0.8): WorldItem[] {
    const p = a.body.position;
    const feetY = feetYFromBodyCenter(p.y);
    const maxDistSq = maxDist * maxDist;
    return this.loot.items
      .filter((item) => item.kind !== 'ammo' && this.loot.canActorPickup(item, a))
      .map((item) => {
        const dx = item.x - p.x;
        const dy = item.y - feetY;
        const dz = item.z - p.z;
        return { item, distance: dx * dx + dy * dy + dz * dz };
      })
      .filter(({ item, distance }) => distance <= maxDistSq
        && !this.phys.losBlocked(p.x, a.eyeY, p.z, item.x, item.y, item.z))
      .sort((a, b) => a.distance - b.distance || a.item.id - b.item.id)
      .map(({ item }) => item);
  }

  private autoPickupAmmo(a: Actor): void {
    const p = a.body.position;
    for (const it of [...this.loot.items]) {
      if (it.kind !== 'ammo') continue;
      const dx = it.x - p.x, dy = it.y - p.y, dz = it.z - p.z;
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
      if (this.processedEliminations.has(victim.id)) continue;
      this.processedEliminations.add(victim.id);
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

      // Stop any in-flight staged reload before the death drop. Rounds that
      // already entered the magazine stay on the dropped weapon; the
      // not-yet-loaded portion remains in the reserve because reload loading
      // is committed one round at a time.
      this.cancelReload(victim);
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
    if (this.practice) return;
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
    const placedAt: Array<{ x: number; z: number }> = [];
    const tooClose = (x: number, z: number): boolean => {
      for (const p of placedAt) {
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz < 1.69) return true; // < 1.3 m spacing
      }
      return false;
    };
    for (const spawn of this.mapDef.loot) {
      if (tooClose(spawn.x, spawn.z)) continue;
      // Authored heights drift out of sync as maps are rebuilt — re-snap every
      // authored spawn to the real surface so nothing floats or buries.
      const node = this.nav.nearest(spawn.x, spawn.y, spawn.z, 14);
      let y = spawn.y;
      const refY = node ? Math.max(spawn.y, node.y) : spawn.y;
      const surf = this.phys.surfaceAt(spawn.x, spawn.z, refY + 2.5, 7);
      if (surf !== null && Math.abs(surf - refY) <= 2.6) {
        y = surf + 0.02;
      } else if (!node || Math.abs(spawn.y - node.y) > 2.6) {
        continue; // stale authored height, no trustworthy surface — drop it
      }
      placedAt.push({ x: spawn.x, z: spawn.z });
      this.loot.spawnFloorLoot(spawn.x, y, spawn.z, spawn.bias, this.rng);
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
      const approximateY = this.phys.surfaceAt(x, z, 300, 500) ?? 0;
      const node = this.nav.nearest(x, approximateY, z, 18);
      if (!node || node.water) continue;
      // Controlled randomness: never sit exactly on the nav lattice. Offset
      // each item, then re-snap to the real surface so nothing floats or
      // clips while still breaking up the grid read.
      const ox = this.rng.range(-2.6, 2.6);
      const oz = this.rng.range(-2.6, 2.6);
      const ix = Math.max(-this.mapDef.size / 2 + 4, Math.min(this.mapDef.size / 2 - 4, node.x + ox));
      const iz = Math.max(-this.mapDef.size / 2 + 4, Math.min(this.mapDef.size / 2 - 4, node.z + oz));
      if (tooClose(ix, iz)) continue;
      const surf = this.phys.surfaceAt(ix, iz, node.y + 3, 8);
      if (surf === null) continue;
      if (Math.abs(surf - node.y) > 1.6) continue; // slid off a ledge/wall — skip
      placedAt.push({ x: ix, z: iz });
      const kindRoll = this.rng.weighted([50, 32, 18]);
      const bias2 = kindRoll === 0 ? 'weapon' : kindRoll === 1 ? 'ammo' : 'heal';
      this.loot.spawnFloorLoot(ix, surf + 0.02, iz, bias2 as 'weapon' | 'ammo' | 'heal', this.rng);
      placed++;
    }
  }

  spectatorTargets(): Actor[] {
    return this.actors.filter((a) => a.alive);
  }

  /**
   * Apply a deterministic elimination through the same queued pipeline used
   * by combat, fall and storm deaths. This keeps integration/QA controls from
   * manufacturing a half-dead actor with stale placement, loot and counters.
   */
  eliminateActor(a: Actor): boolean {
    if (!a.alive) return false;
    a.applyDamage(a.effectiveHealth() + 1);
    this.pendingEliminations.push({ victim: a, killer: null, weaponId: null, headshot: false, storm: false });
    return true;
  }

  dispose(): void {
    this.controllers.clear();
    this.phys.dispose();
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
