/**
 * BotController: the per-bot brain. Utility-based decisions over a shared
 * high-quality core; personalities parameterize behavior. Produces the same
 * InputCommand as the human controller — bots play by identical rules.
 *
 * Modes: DROP, LOOT, COMBAT, HEAL, ROTATE, THIRD_PARTY, AMBUSH, WANDER, SEARCH
 */

import { DIFFICULTY, WEAPONS, type AmmoType, type BotPersonality, type Difficulty } from '../core/balance';
import { Rng } from '../core/rng';
import type { Actor } from '../sim/actor';
import { emptyCommand, type InputCommand } from '../sim/input';
import type { Match } from '../sim/match';
import type { WorldItem } from '../sim/loot';
import { Perception } from './perception';
import { BotNavigator } from './navigator';
import { BotCombat } from './combat';
import { feetYFromBodyCenter } from '../physics/physics';

export type BotMode = 'drop' | 'loot' | 'combat' | 'heal' | 'rotate' | 'thirdparty' | 'ambush' | 'wander' | 'search';

interface EffectiveParams {
  reaction: number;
  aimError: number;
  trackSpeed: number;
  decideInterval: number;
  moveSkill: number;
  awareness: number;
}

export class BotController {
  readonly kind = 'bot' as const;
  mode: BotMode = 'drop';
  perception: Perception;
  /** Cached LOS closure — rebuilt once per controller, not per tick. */
  private readonly cachedLos!: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean;
  navigator: BotNavigator;
  combat: BotCombat;
  private params: EffectiveParams;
  private decideTimer = 0;
  private goalPos: { x: number; y: number; z: number } | null = null;
  private targetItem: WorldItem | null = null;
  private targetChestId = -1;
  private strafeDir = 1;
  private strafeTimer = 0;
  private dropTarget: { x: number; z: number } | null = null;
  private dropTargetY = 0;
  private lastDamageResponse = 0;
  /** Match-local adaptation observations. */
  private observedEngageDist = 30;
  private observedAggression = 0.5;

  constructor(
    public actor: Actor,
    public match: Match,
    public rng: Rng,
    public personality: BotPersonality,
    difficulty: Difficulty,
  ) {
    this.perception = new Perception(actor, (other) => match.areHostile(actor, other));
    this.navigator = new BotNavigator(match.nav, actor);
    const base = DIFFICULTY[difficulty];
    if (personality.elite) {
      // Elite benchmark bots always run near-maximum capability.
      this.params = {
        reaction: 0.17 / (0.8 + personality.aimSkill * 0.4),
        aimError: 0.011 / (0.7 + personality.aimSkill * 0.6),
        trackSpeed: 9.5 * (0.75 + personality.aimSkill * 0.5),
        decideInterval: 0.2,
        moveSkill: 0.9,
        awareness: 1.15,
      };
    } else {
      const skill = personality.baseSkill;
      this.params = {
        reaction: (base.reaction / (0.8 + personality.aimSkill * 0.4)) * (1.6 - skill * 0.6),
        aimError: (base.aimError / (0.7 + personality.aimSkill * 0.6)) * (1.7 - skill * 0.7),
        trackSpeed: base.trackSpeed * (0.75 + personality.aimSkill * 0.5) * (0.7 + skill * 0.3),
        decideInterval: base.decideInterval,
        moveSkill: base.moveSkill * (0.6 + skill * 0.4),
        awareness: base.awareness,
      };
    }
    this.combat = new BotCombat(actor, {
      reaction: this.params.reaction,
      aimError: this.params.aimError,
      trackSpeed: this.params.trackSpeed,
    });
    // Subscribe to relevant world events for hearing. Walls muffle what they
    // hide: a blocked sound path keeps ~35% loudness (and Perception's
    // loudness scaling shrinks its effective range), so bots do not wallhack
    // with their ears. One cheap raycast per event, distance-gated first.
    match.events.on('shotFired', (e) => {
      if (e.actorId !== actor.id && !e.dry && match.areHostile(actor.id, e.actorId)) {
        this.perception.hear(
          this.sampleHeardSound(e.x, e.y, e.z, 1, 'shot', e.actorId, 90),
          this.params.awareness,
        );
      }
    });
    match.events.on('footstep', (e) => {
      if (e.actorId !== actor.id && match.areHostile(actor.id, e.actorId)) {
        this.perception.hear(
          this.sampleHeardSound(e.x, e.y, e.z, e.running ? 0.75 : 0.45, 'footstep', e.actorId, 40),
          this.params.awareness,
        );
      }
    });
    match.events.on('chestOpened', (e) => {
      if (match.areHostile(actor.id, e.actorId)) {
        this.perception.hear({ x: e.x, y: e.y, z: e.z, loudness: 0.4, kind: 'chest', actorId: e.actorId }, this.params.awareness);
      }
    });
    match.events.on('glassBreak', (e) => {
      if (e.actorId < 0 || match.areHostile(actor.id, e.actorId)) {
        this.perception.hear({ x: e.x, y: e.y, z: e.z, loudness: 0.55, kind: 'glass', actorId: e.actorId }, this.params.awareness);
      }
    });
    match.events.on('actorHit', (e) => {
      if (e.targetId === actor.id && e.attackerId > 0) {
        const attacker = match.actors.find((a) => a.id === e.attackerId);
        if (attacker && match.areHostile(actor, attacker)) {
          this.perception.onDamagedBy(attacker.body.position, attacker.id);
          this.lastDamageResponse = match.time;
        }
      }
    });
  }

  updateCommand(_actor: Actor, dt: number): InputCommand {
    const a = this.actor;
    const cmd = emptyCommand();

    if (!a.alive || matchOver(this.match)) return cmd;

    // Perception tick
    this.perception.tick(dt);
    const staleTarget = this.combat.target;
    if (staleTarget && !this.match.areHostile(this.actor, staleTarget)) {
      this.perception.forgetActor(staleTarget.id);
      this.combat.clearTarget();
    }
    for (const actorId of this.perception.memories.keys()) {
      const remembered = this.match.actors.find((candidate) => candidate.id === actorId);
      if (remembered && !this.match.areHostile(this.actor, remembered)) this.perception.forgetActor(actorId);
    }
    // Early game, bots are loot-focused: reduced sight range keeps the first
    // minute or two about gearing up, not long-range engagements.
    const earlyFactor = this.match.time < 90 ? 0.5 : this.match.time < 130 ? 0.75 : 1;
    this.perception.updateVision(dt, this.match.actors, losFn(this.match), this.params.awareness, earlyFactor);

    // Airborne actors steer their own descent regardless of the global
    // transport phase — an early jumper never re-enters transport logic.
    if (a.state === 'freefall' || a.state === 'glide') {
      return this.dropSteer(cmd);
    }
    // Drop phase steering — `deployed` actors (landed early jumpers) run
    // normal ground AI even while the ride is still in the air.
    if (this.match.phase === 'transport' && !a.deployed) {
      return this.transportCommand(cmd);
    }

    // Decision cadence
    this.decideTimer -= dt;
    if (this.mode === 'search') this.searchPatience -= dt;
    if (this.decideTimer <= 0) {
      this.decideTimer = this.params.decideInterval * (0.8 + this.rng.next() * 0.4);
      this.decide();
    }

    switch (this.mode) {
      case 'combat':
        this.doCombat(cmd, dt);
        break;
      case 'heal':
        this.doHeal(cmd, dt);
        break;
      case 'loot':
        this.doLoot(cmd, dt);
        break;
      case 'rotate':
      case 'thirdparty':
      case 'wander':
      case 'ambush':
      case 'search':
        this.doTravel(cmd, dt);
        break;
    }

    // Global stuck failsafe: if we've been commanding movement but barely
    // moved, force a re-plan (and hop/dash).
    this.stuckCheckTick(cmd, dt);

    return cmd;
  }

  private failSafeX = 0;
  private failSafeZ = 0;
  private failSafeTimer = 0;

  /**
   * Hearing pre-pass: wall-check a sound before handing it to Perception.
   * Blocked paths keep ~35% loudness; beyond `gate` metres the raycast is
   * skipped (a beyond-gate sound is already marginal for detection).
   */
  private sampleHeardSound(
    x: number, y: number, z: number,
    loudness: number,
    kind: 'shot' | 'footstep',
    actorId: number,
    gate: number,
  ): { x: number; y: number; z: number; loudness: number; kind: 'shot' | 'footstep'; actorId: number } {
    const p = this.actor.body.position;
    if (Math.hypot(x - p.x, z - p.z) < gate
      && this.match.phys.losBlocked(p.x, p.y + 1.4, p.z, x, y, z)) {
      loudness *= 0.35;
    }
    return { x, y, z, loudness, kind, actorId };
  }

  private stuckCheckTick(cmd: InputCommand, dt: number): void {
    const p = this.actor.body.position;
    this.failSafeTimer += dt;
    if (this.failSafeTimer >= 2.2) {
      const moved = Math.hypot(p.x - this.failSafeX, p.z - this.failSafeZ);
      this.failSafeTimer = 0;
      this.failSafeX = p.x;
      this.failSafeZ = p.z;
      const traveling = this.mode === 'loot' || this.mode === 'rotate' || this.mode === 'wander' ||
        this.mode === 'search' || this.mode === 'thirdparty';
      if (traveling && moved < 0.9 && !this.actor.body.grounded === false) {
        // wedged: blacklist goal, repath, hop
        if (this.targetItem) {
          this.lootBlacklist.set(this.targetItem.id, this.match.time + 30);
          this.targetItem = null;
        }
        if (this.targetChestId > 0) {
          this.lootBlacklist.set(this.targetChestId, this.match.time + 30);
          this.targetChestId = -1;
        }
        this.navigator.clear();
        this.pickWanderGoal();
        this.mode = 'wander';
        cmd.jumpPressed = true;
        cmd.jumpHeld = true;
        if (this.actor.dashCharges > 0 && this.rng.bool(0.5)) {
          cmd.dashPressed = true;
          // Dash diagonally out of the wedge (local-space axes)
          cmd.moveZ = 1;
          cmd.moveX = this.rng.bool(0.5) ? 0.8 : -0.8;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Decision making (utility scoring)
  // -------------------------------------------------------------------------

  private decide(): void {
    const a = this.actor;
    const m = this.match;
    const p = this.personality;

    // Visible enemy → strong combat bias. Keep an existing engagement alive
    // on fresh memory so aim/fire aren't disrupted by vision refresh gaps.
    // Exception: deep in the storm, survival outranks a distant fight.
    const outsideNow = m.storm.isOutside(a.body.position.x, a.body.position.z);
    const vis = this.perception.bestVisibleTarget(lerp(p.preferredRange, this.observedEngageDist, 0.25));
    if (vis && (!outsideNow || vis.dist < 45)) {
      this.mode = 'combat';
      this.combat.acquire(vis.actor);
      this.searchPatience = 6 + p.aggression * 6;
      return;
    }
    const currentTarget = this.combat.target;
    if (currentTarget && currentTarget.alive && m.areHostile(a, currentTarget) && this.mode === 'combat' && !outsideNow) {
      const mem = this.perception.memories.get(currentTarget.id);
      if (mem && mem.time < 2.2) {
        return; // hold engagement
      }
    }
    this.combat.clearTarget();

    // Storm urgency — rotate when outside now, or when the next circle is
    // closing and we are far from safety.
    const outside = m.storm.isOutside(a.body.position.x, a.body.position.z);
    const distOutside = m.storm.distanceOutside(a.body.position.x, a.body.position.z);
    const nextCircle = m.storm.nextCircle();
    const distToSafe = Math.max(0, Math.hypot(a.body.position.x - nextCircle.x, a.body.position.z - nextCircle.z) - nextCircle.r);
    const stormUrgent =
      outside ||
      (m.storm.state === 'shrinking' && distToSafe > 12) ||
      (m.storm.state === 'waiting' && m.storm.timer < 45 && distToSafe > 25);

    // Health evaluation (never channel heals while standing in the storm)
    const hpFrac = a.health / 100;
    const shFrac = a.shield / 100;
    const wantsHeal = !outside && (hpFrac < 0.55 || (hpFrac < 0.85 && shFrac < 0.35)) &&
      (a.inv.findHeal('medkit') !== null || a.inv.findHeal('shieldpot') !== null);

    // Threat memory nearby?
    const threat = this.perception.mostConfidentMemory(6);

    // Scores
    let bestMode: BotMode = 'wander';
    let bestScore = 8; // wander baseline

    if (stormUrgent) {
      // Survival first: outside the circle overrides nearly everything.
      const s = (outside ? 150 : 105) + distOutside * 0.5 + p.rotationDiscipline * 20;
      if (s > bestScore) { bestScore = s; bestMode = 'rotate'; }
    }

    if (wantsHeal && (!threat || threat.confidence < 0.5 || hpFrac < 0.3)) {
      const s = 65 + (1 - hpFrac) * 40 - (threat ? threat.confidence * 25 : 0);
      if (s > bestScore) { bestScore = s; bestMode = 'heal'; }
    }

    // Combat on confident recent memory (hunt/search) — but search has a
    // patience budget so bots return to looting/rotating. After recent
    // combat, bots keep their head down for a while. Distant memories only
    // pull strong-confidence hunts.
    const postFightCautious = this.match.time - this.lastCombatEnd < 18;
    const threatDist = threat ? Math.hypot(threat.x - a.body.position.x, threat.z - a.body.position.z) : 999;
    if (threat && threat.confidence > 0.45 && this.searchPatience > 0 && !postFightCautious &&
        (threatDist < 70 || threat.confidence > 0.85)) {
      const s = 40 + threat.confidence * 30 + p.aggression * 25;
      if (s > bestScore) { bestScore = s; bestMode = 'search'; }
    }

    // Third-party opportunity: recent distant gunfire (mid/late game only —
    // early game everyone should be looting their own area).
    if (p.thirdParty > 0.3 && (m.storm.phaseIndex >= 1 || m.time > 150)) {
      const fight = this.findRecentFight();
      if (fight) {
        const dist = Math.hypot(fight.x - a.body.position.x, fight.z - a.body.position.z);
        if (dist > 25 && dist < 130) {
          const s = 30 + p.thirdParty * 45 - dist * 0.12;
          if (s > bestScore) { bestScore = s; bestMode = 'thirdparty'; this.thirdPartySpot = { x: fight.x, y: fight.y, z: fight.z }; }
        }
      }
    }

    // Ambush personality: sit near hot areas
    if (p.ambush > 0.7 && threat && threat.confidence > 0.3 && this.rng.bool(0.4)) {
      const s = 35 + p.ambush * 30;
      if (s > bestScore) { bestScore = s; bestMode = 'ambush'; }
    }

    // Loot needs (wider search when desperate for a weapon). Loot loses
    // priority when the storm is closing and we are far from safety.
    const weaponsOwned = a.inv.slots.filter((s) => s?.kind === 'weapon').length;
    const desperate = weaponsOwned === 0 || this.noUsableAmmo();
    const lootNeed = this.lootNeedScore();
    if (lootNeed > 0) {
      const spot = this.findLootSpot(desperate ? 90 : 55);
      if (spot) {
        const dist = Math.hypot(spot.x - a.body.position.x, spot.z - a.body.position.z);
        const distSpotToSafe = Math.max(0,
          Math.hypot(spot.x - nextCircle.x, spot.z - nextCircle.z) - nextCircle.r);
        const stormPenalty = m.storm.state === 'shrinking' ? Math.max(0, distSpotToSafe - 15) * 0.8 : 0;
        const s = lootNeed * 60 - dist * (desperate ? 0.12 : 0.35) + p.lootGreed * 18 + (desperate ? 30 : 0) - stormPenalty;
        if (s > bestScore) {
          bestScore = s;
          bestMode = 'loot';
          if (spot.kind === 'chest') this.targetChestId = spot.chestId!;
          else this.targetItem = spot.item!;
        }
      }
    }

    if (bestMode === 'wander') {
      this.pickWanderGoal();
    }
    if (bestMode !== this.mode || bestMode === 'rotate' || bestMode === 'thirdparty') {
      this.mode = bestMode;
      this.refreshGoal();
    }
  }

  private thirdPartySpot: { x: number; y: number; z: number } | null = null;
  private recentFights: Array<{ x: number; y: number; z: number; t: number }> = [];
  private fightWatchInit = false;
  /** Items/chests that failed to be reached recently (id -> expiry time). */
  private lootBlacklist = new Map<number, number>();
  private lootAttemptStart = -1;
  private lootAttemptBestDist = Infinity;
  /** Seconds of search budget left before giving up on a memory trail. */
  private searchPatience = 0;
  private combatBlindTime = 0;
  private lastCombatEnd = -99;
  private rotateGoal: { x: number; z: number } | null = null;
  private rotatePhaseKey = -1;
  private lastRotateRefreshTime = -99;

  private watchFights(): void {
    if (this.fightWatchInit) return;
    this.fightWatchInit = true;
    this.match.events.on('shotFired', (e) => {
      if (e.actorId !== this.actor.id && this.match.areHostile(this.actor.id, e.actorId)) {
        this.recentFights.push({ x: e.x, y: e.y, z: e.z, t: this.match.time });
        if (this.recentFights.length > 24) this.recentFights.shift();
      }
    });
  }

  private findRecentFight(): { x: number; y: number; z: number } | null {
    this.watchFights();
    const now = this.match.time;
    for (let i = this.recentFights.length - 1; i >= 0; i--) {
      const f = this.recentFights[i]!;
      if (now - f.t < 14) return f;
    }
    return null;
  }

  private noUsableAmmo(): boolean {
    const a = this.actor;
    for (const s of a.inv.slots) {
      if (s?.kind === 'weapon') {
        if (s.ammoInMag > 0 || a.inv.ammo[WEAPONS[s.weaponId].ammoType] > 0) return false;
      }
    }
    return true;
  }

  private lootNeedScore(): number {
    const a = this.actor;
    let need = 0;
    const weapons = a.inv.slots.filter((s) => s?.kind === 'weapon');
    if (weapons.length === 0) need += 1;
    else if (weapons.length === 1) need += 0.5;
    // Ammo check for selected weapon classes
    let hasAmmo = false;
    for (const w of weapons) {
      if (w && w.kind === 'weapon') {
        const def = WEAPONS[w.weaponId];
        if (a.inv.ammo[def.ammoType] > 8 || w.ammoInMag > 5) hasAmmo = true;
      }
    }
    if (!hasAmmo) need += 0.8;
    if (!a.inv.findHeal('medkit')) need += 0.35;
    if (!a.inv.findHeal('shieldpot')) need += 0.3;
    return Math.min(1.6, need);
  }

  private findLootSpot(radius = 42): { x: number; y: number; z: number; kind: 'item' | 'chest'; item?: WorldItem; chestId?: number } | null {
    const a = this.actor;
    const p = a.body.position;
    // Nearby valuable items (skip blacklisted + big height gaps + things we
    // cannot actually store — prevents pick/drop ping-pong churn).
    const item = this.match.loot.nearestItem(p.x, p.y, p.z, radius, (it) => {
      if (this.lootBlacklist.has(it.id)) return false;
      if (Math.abs(it.y - p.y) > 5) return false;
      if (it.kind === 'weapon') {
        if (!it.weapon || !a.inv.wouldUpgradeWeapon(it.weapon)) return false;
        return true;
      }
      if (it.kind === 'ammo') {
        // only if we own a weapon of that ammo type and are low
        return this.ownsAmmoTypeNeeding(it.ammo!.type);
      }
      return !a.inv.findHeal(it.heal!.itemId) && a.inv.canStore({ kind: 'heal', itemId: it.heal!.itemId, count: it.heal!.count });
    });

    // Unopened chest within range — chests stay competitive against scattered
    // floor items so bots actually engage the chest loot pipeline.
    let bestChest = null as null | { x: number; y: number; z: number; chestId: number };
    let bestD = radius + 6;
    for (const c of this.match.chests) {
      if (c.opened) continue;
      if (this.lootBlacklist.has(c.id)) continue;
      if (Math.abs(c.y - p.y) > 6) continue;
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < bestD) {
        bestD = d;
        bestChest = { x: c.x, y: c.y, z: c.z, chestId: c.id };
      }
    }
    if (bestChest) {
      const itemD = item ? Math.hypot(item.x - p.x, item.z - p.z) : Infinity;
      if (!item || bestD < Math.min(18, itemD - 4)) return { ...bestChest, kind: 'chest' };
    }
    if (item) return { x: item.x, y: item.y, z: item.z, kind: 'item', item };
    return null;
  }

  private ownsAmmoTypeNeeding(type: AmmoType): boolean {
    const a = this.actor;
    for (const s of a.inv.slots) {
      if (s?.kind === 'weapon') {
        if (WEAPONS[s.weaponId].ammoType === type && a.inv.ammo[type] < 20) return true;
      }
    }
    return false;
  }

  private pickWanderGoal(): void {
    // Patrol locally: random nav node near current position (keeps bots in
    // their area early game; the storm handles global convergence later).
    const p = this.actor.body.position;
    const list = this.match.nav.nodesWithin(p.x, p.z, 62, feetYFromBodyCenter(p.y), 8);
    if (list.length) {
      const node = list[this.rng.int(0, list.length - 1)]!;
      this.goalPos = { x: node.x, y: node.y, z: node.z };
    } else {
      const node = this.match.nav.randomNodeIn(this.match.mapDef.pois, this.rng);
      if (node) this.goalPos = { x: node.x, y: node.y, z: node.z };
    }
  }

  private refreshGoal(): void {
    const a = this.actor;
    const m = this.match;
    const p = a.body.position;
    switch (this.mode) {
      case 'rotate': {
        // Keep one rotation goal until it expires or the circle phase changes —
        // re-rolling every decision tick makes bots zigzag and never arrive.
        const nc = m.storm.nextCircle();
        const phaseKey = m.storm.phaseIndex * 10 + (m.storm.state === 'shrinking' ? 1 : 0);
        const since = m.time - this.lastRotateRefreshTime;
        if (this.rotateGoal && this.rotatePhaseKey === phaseKey && since < 8) {
          break;
        }
        this.lastRotateRefreshTime = m.time;
        this.rotatePhaseKey = phaseKey;
        const ang = this.rng.angle();
        const rad = Math.sqrt(this.rng.next()) * nc.r * 0.55;
        this.goalPos = { x: nc.x + Math.cos(ang) * rad, y: p.y, z: nc.z + Math.sin(ang) * rad };
        this.rotateGoal = { x: this.goalPos.x, z: this.goalPos.z };
        this.navigator.clear();
        break;
      }
      case 'thirdparty': {
        if (this.thirdPartySpot) {
          // Approach but stop short — set up on the winner
          const dx = this.thirdPartySpot.x - p.x;
          const dz = this.thirdPartySpot.z - p.z;
          const l = Math.hypot(dx, dz) || 1;
          const stopShort = Math.max(0, l - 22);
          this.goalPos = { x: p.x + (dx / l) * stopShort, y: p.y, z: p.z + (dz / l) * stopShort };
          this.navigator.clear();
        }
        break;
      }
      case 'ambush': {
        const threat = this.perception.mostConfidentMemory(10);
        if (threat) {
          this.goalPos = { x: threat.x, y: threat.y, z: threat.z };
          this.navigator.clear();
        }
        break;
      }
      case 'search': {
        const threat = this.perception.mostConfidentMemory(8);
        if (threat) {
          this.goalPos = { x: threat.x, y: threat.y, z: threat.z };
          this.navigator.clear();
        }
        break;
      }
      case 'loot':
        this.navigator.clear();
        break;
      default:
        this.navigator.clear();
    }
  }

  // -------------------------------------------------------------------------
  // Mode behaviors
  // -------------------------------------------------------------------------

  private doCombat(cmd: InputCommand, dt: number): void {
    const a = this.actor;
    const visEntry = this.perception.visible.get(this.combat.target?.id ?? -1);
    const visible = visEntry !== undefined && this.combat.target !== null;
    const t = this.combat.target;

    if (!t || !this.match.areHostile(a, t)) {
      if (t) this.perception.forgetActor(t.id);
      this.combat.clearTarget();
      this.mode = 'wander';
      return;
    }

    // Unarmed or dry: try switching to any usable weapon first; if none,
    // close in and punch — fists are a real option, not a disengage.
    const w = a.inv.selectedWeapon;
    const dryW = w && w.ammoInMag === 0 && a.inv.ammo[WEAPONS[w.weaponId].ammoType] === 0;
    if (!w || dryW) {
      let switched = false;
      for (let i = 0; i < a.inv.slots.length; i++) {
        const s = a.inv.slots[i];
        if (s?.kind === 'weapon' && (s.ammoInMag > 0 || a.inv.ammo[WEAPONS[s.weaponId].ammoType] > 0)) {
          a.inv.select(i);
          switched = true;
          break;
        }
      }
      if (!switched) {
        // Melee: charge the target and punch when within reach.
        if (!a.inv.isMeleeSelected) {
          a.inv.selectMelee();
          return;
        }
        const dx = t.body.position.x - a.body.position.x;
        const dz = t.body.position.z - a.body.position.z;
        const distH = Math.hypot(dx, dz);
        cmd.yaw = Math.atan2(-dx, -dz);
        cmd.pitch = 0;
        cmd.moveZ = distH > 1.6 ? 1 : 0.2;
        cmd.sprint = distH > 4;
        cmd.fireHeld = true;
        return;
      }
    }

    const losClear = visible ? !losBlockedPoint(this.match, a, t) : false;
    const intent = this.combat.update(dt, visible, losClear, (w2) => WEAPONS[w2.weaponId].projectileSpeed);

    // Break off prolonged hunts: relocate away from the last fight area so
    // winners don't sit in a hot zone waiting to be third-partied.
    if (!visible) {
      this.combatBlindTime += dt;
      if (this.combatBlindTime > 3.5) {
        this.combatBlindTime = 0;
        this.lastCombatEnd = this.match.time;
        this.mode = 'wander';
        const p2 = a.body.position;
        const list = this.match.nav.nodesWithin(p2.x, p2.z, 90, feetYFromBodyCenter(p2.y), 9)
          .filter((n) => Math.hypot(n.x - p2.x, n.z - p2.z) > 45);
        if (list.length) {
          const node = list[this.rng.int(0, list.length - 1)]!;
          this.goalPos = { x: node.x, y: node.y, z: node.z };
          this.navigator.clear();
        } else {
          this.pickWanderGoal();
        }
        return;
      }
    } else {
      this.combatBlindTime = 0;
    }

    cmd.yaw = intent.yaw;
    cmd.pitch = intent.pitch;
    cmd.fireHeld = intent.fire;
    cmd.firePressed = intent.fire;
    cmd.adsHeld = visEntry ? visEntry.dist > 22 : false;

    // Range management + strafing
    const mem = this.perception.memories.get(t.id);
    const dist = visEntry?.dist ?? (mem ? Math.hypot(mem.x - a.body.position.x, mem.z - a.body.position.z) : 60);
    const pref = this.personality.preferredRange;
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 0.5 + this.rng.next() * 0.9;
      this.strafeDir = this.rng.bool() ? 1 : -1;
    }
    const def = w ? WEAPONS[w.weaponId] : null;

    // Weapon switching for range
    if (def && this.shouldSwitchWeapon(dist)) {
      this.switchToBestWeapon(dist);
    }

    if (dist > pref * 1.5) {
      // Hold and scan instead of always pushing (positioning discipline),
      // unless aggressive/close-quarters personality or late game.
      const holdThreshold = this.match.time < 120 ? pref * 1.9 : pref * 1.5;
      if (dist > holdThreshold && this.personality.aggression < 0.85) {
        cmd.moveZ = this.rng.bool(0.02) ? 0.4 : 0;
        if (this.rng.bool(0.3)) cmd.crouchHeld = true;
      } else {
        cmd.moveZ = 1;
        cmd.sprint = dist > pref * 2.2;
      }
    } else if (dist < pref * 0.5) {
      cmd.moveZ = -0.7;
      cmd.moveX = this.strafeDir * 0.6;
    } else {
      cmd.moveX = this.strafeDir;
      cmd.moveZ = this.rng.bool(0.3) ? 0.4 : 0;
    }

    // Disengage when badly hurt and outmatched (caution-driven retreat)
    const hurtBadly = a.health + a.shield < 70;
    if (hurtBadly && this.personality.caution > this.personality.aggression * 0.7 && this.rng.next() < 0.03) {
      this.mode = 'heal';
      this.refreshGoal();
      return;
    }
    // Reload when safe-ish or mag empty
    if (w && w.ammoInMag === 0) {
      cmd.reloadPressed = true;
    } else if (w && w.ammoInMag <= Math.ceil(WEAPONS[w.weaponId].magSize * 0.25) && !visible) {
      cmd.reloadPressed = true;
    }

    // Advanced movement usage gated by moveSkill
    if (this.rng.next() < this.params.moveSkill * 0.02) {
      if (a.dashCharges > 0 && a.body.grounded) cmd.dashPressed = true;
    }
    if (this.rng.next() < this.params.moveSkill * 0.008 && !a.body.grounded) {
      cmd.grapplePressed = true;
    }
    // Disengage when low health & losing
    if (a.health < 32 && this.personality.caution > 0.5 && this.rng.next() < 0.02) {
      this.mode = 'heal';
      this.refreshGoal();
    }
  }

  private shouldSwitchWeapon(dist: number): boolean {
    const a = this.actor;
    const cur = a.inv.selectedWeapon;
    if (!cur) return true;
    const curDef = WEAPONS[cur.weaponId];
    const curFit = weaponRangeFit(curDef.id, dist);
    let bestFit = curFit;
    let better = false;
    for (const s of a.inv.slots) {
      if (s?.kind === 'weapon' && s !== cur) {
        const fit = weaponRangeFit(s.weaponId, dist);
        const rarityBonus = rarityIdx(s.rarity) - rarityIdx(cur.rarity);
        if (fit > bestFit + 0.15 || (fit >= bestFit - 0.05 && rarityBonus >= 2)) {
          bestFit = fit;
          better = true;
        }
      }
    }
    return better && curFit < 0.85;
  }

  private switchToBestWeapon(dist: number): void {
    const a = this.actor;
    let bestSlot = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < a.inv.slots.length; i++) {
      const s = a.inv.slots[i];
      if (s?.kind === 'weapon') {
        const score = weaponRangeFit(s.weaponId, dist) + rarityIdx(s.rarity) * 0.06 +
          (a.inv.ammo[WEAPONS[s.weaponId].ammoType] > 0 || s.ammoInMag > 0 ? 0.2 : -0.5);
        if (score > bestScore) {
          bestScore = score;
          bestSlot = i;
        }
      }
    }
    if (bestSlot >= 0 && bestSlot !== a.inv.selected) {
      a.inv.select(bestSlot);
      const sel = a.inv.slots[bestSlot];
      a.wpn.swapTimer = sel && sel.kind === 'weapon' ? WEAPONS[sel.weaponId].swapInTime : 0.4;
    }
  }

  private doHeal(cmd: InputCommand, _dt: number): void {
    const a = this.actor;
    // Stand still-ish while healing; small chance to seek cover direction
    cmd.moveZ = 0;
    const threat = this.perception.mostConfidentMemory(4);
    if (threat && threat.confidence > 0.6) {
      // face threat while healing
      cmd.yaw = Math.atan2(-(threat.x - a.body.position.x), -(threat.z - a.body.position.z));
    }
    if (a.healing) return;
    if (a.health < 97 && a.inv.findHeal('medkit')) {
      cmd.medkitPressed = true;
      return;
    }
    if (a.shield < 97 && a.inv.findHeal('shieldpot')) {
      cmd.shieldPressed = true;
      return;
    }
    // Done healing
    this.mode = 'loot';
    this.refreshGoal();
  }

  private doLoot(cmd: InputCommand, dt: number): void {
    const a = this.actor;
    const p = a.body.position;
    void dt;

    // Prune blacklist
    for (const [id, until] of this.lootBlacklist) {
      if (this.match.time > until) this.lootBlacklist.delete(id);
    }

    // Validate current targets still exist (and aren't blacklisted)
    if (this.targetItem && (!this.match.loot.items.includes(this.targetItem) || this.lootBlacklist.has(this.targetItem.id))) {
      this.targetItem = null;
    }
    if (this.targetChestId > 0 && this.lootBlacklist.has(this.targetChestId)) {
      this.targetChestId = -1;
    }
    if (this.targetChestId > 0) {
      const c = this.match.chests.find((cc) => cc.id === this.targetChestId);
      if (!c || c.opened) this.targetChestId = -1;
    }

    let goal: { x: number; y: number; z: number } | null = null;
    let goalId = -1;
    if (this.targetItem) {
      goal = { x: this.targetItem.x, y: this.targetItem.y, z: this.targetItem.z };
      goalId = this.targetItem.id;
    } else if (this.targetChestId > 0) {
      const c = this.match.chests.find((cc) => cc.id === this.targetChestId)!;
      goal = { x: c.x, y: c.y, z: c.z };
      goalId = this.targetChestId;
    } else {
      const spot = this.findLootSpot();
      if (spot) {
        goal = { x: spot.x, y: spot.y, z: spot.z };
        if (spot.kind === 'chest') this.targetChestId = spot.chestId!;
        else this.targetItem = spot.item!;
        goalId = spot.kind === 'chest' ? spot.chestId! : spot.item!.id;
        this.lootAttemptStart = this.match.time;
        this.lootAttemptBestDist = Infinity;
      } else {
        this.mode = 'wander';
        this.pickWanderGoal();
        return;
      }
    }

    const dist = Math.hypot(goal.x - p.x, goal.z - p.z);
    const heightDiff = Math.abs(goal.y - p.y);

    // Progress tracking: blacklist unreachable loot
    if (goalId > 0) {
      if (this.lootAttemptStart < 0) {
        this.lootAttemptStart = this.match.time;
        this.lootAttemptBestDist = dist;
      }
      this.lootAttemptBestDist = Math.min(this.lootAttemptBestDist, dist);
      const elapsed = this.match.time - this.lootAttemptStart;
      const noProgress = elapsed > 2.2 && this.lootAttemptBestDist < 6 && dist > 1.8;
      const tooLong = elapsed > 14;
      if (noProgress || tooLong) {
        this.lootBlacklist.set(goalId, this.match.time + 45);
        this.targetItem = null;
        this.targetChestId = -1;
        this.lootAttemptStart = -1;
        this.decideTimer = 0.05;
        return;
      }
    }

    if (dist < 2.8 && heightDiff < 3.5) {
      cmd.interactPressed = true;
      this.targetItem = null;
      this.targetChestId = -1;
      this.lootAttemptStart = -1;
      // After pickup, re-decide soon
      this.decideTimer = 0.1;
      return;
    }
    if (dist < 3.4 && heightDiff >= 3.5) {
      // Loot is far above/below (roof, underground) — treat as unreachable for now
      if (goalId > 0) this.lootBlacklist.set(goalId, this.match.time + 30);
      this.targetItem = null;
      this.targetChestId = -1;
      return;
    }

    this.navigator.setGoal(goal);
    this.navigator.steer(cmd, dt);
  }

  private doTravel(cmd: InputCommand, dt: number): void {
    const a = this.actor;
    if (!this.goalPos) {
      this.pickWanderGoal();
      if (!this.goalPos) return;
    }
    const arrived = Math.hypot(this.goalPos!.x - a.body.position.x, this.goalPos!.z - a.body.position.z) < 4;
    if (arrived) {
      if (this.mode === 'ambush') {
        // hold position, crouch, scan
        cmd.crouchHeld = true;
        cmd.yaw += Math.sin(this.match.time * 0.7) * 0.02;
        return;
      }
      this.decideTimer = 0.05;
      return;
    }
    this.navigator.setGoal(this.goalPos!);
    const navigating = this.navigator.steer(cmd, dt);
    if (!navigating) {
      this.decideTimer = 0.05;
    }
    // Ambushers & ghosts crouch more while traveling near threats
    if ((this.mode === 'search' || this.mode === 'ambush') && this.personality.ambush > 0.6) {
      const threat = this.perception.mostConfidentMemory(6);
      if (threat && Math.hypot(threat.x - a.body.position.x, threat.z - a.body.position.z) < 30) {
        cmd.crouchHeld = true;
        cmd.sprint = false;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Transport & drop
  // -------------------------------------------------------------------------

  private transportCommand(cmd: InputCommand): InputCommand {
    this.watchFights();
    if (!this.dropTarget) this.chooseDropTarget();
    const t = this.dropTarget!;
    // Jump at the closest approach of the transport route to our drop target.
    const ax = this.match.transportFrom[0];
    const az = this.match.transportFrom[1];
    const bx = this.match.transportTo[0];
    const bz = this.match.transportTo[1];
    const abx = bx - ax, abz = bz - az;
    const len2 = abx * abx + abz * abz;
    const tClosest = len2 === 0 ? 0 : ((t.x - ax) * abx + (t.z - az) * abz) / len2;
    const jumpT = Math.max(0.02, Math.min(0.985, tClosest));
    if (this.match.transportT >= jumpT) {
      cmd.jumpPressed = true;
    }
    const tx = this.match.transportPos.x;
    const tz = this.match.transportPos.z;
    cmd.yaw = Math.atan2(-(t.x - tx), -(t.z - tz));
    return cmd;
  }

  private chooseDropTarget(): void {
    const pois = this.match.mapDef.pois;
    const p = this.personality;
    // Score every POI, then pick among the least-contested ends of the ranking.
    const scored = pois.map((poi) => {
      let crowd = 0;
      for (const claim of this.match.dropClaims) {
        const d = Math.hypot(claim.x - poi.x, claim.z - poi.z);
        if (d < 85) crowd += 1;
      }
      const routeDist = pointSegDist(poi.x, poi.z,
        this.match.transportFrom[0], this.match.transportFrom[1],
        this.match.transportTo[0], this.match.transportTo[1]);
      const base =
        poi.radius * 0.02 +
        -routeDist * 0.03 +
        p.aggression * this.rng.range(-8, 8) +
        this.rng.range(-4, 4);
      return { poi, score: base - Math.pow(crowd, 1.4) * (9 + p.caution * 7) };
    });
    scored.sort((a, b2) => b2.score - a.score);
    // Among acceptable candidates prefer uncontested ones.
    const bestScored = scored.find((s) => !this.match.dropClaims.some((c) => Math.hypot(c.x - s.poi.x, c.z - s.poi.z) < 85))
      ?? scored[0]!;
    const best = bestScored.poi;
    const ang = this.rng.angle();
    const r = Math.sqrt(this.rng.next()) * best.radius * 0.7;
    const lim = this.match.mapDef.size / 2 - 40;
    const clampAbs = (v: number) => Math.max(-lim, Math.min(lim, v));
    this.dropTarget = { x: clampAbs(best.x + Math.cos(ang) * r), z: clampAbs(best.z + Math.sin(ang) * r) };
    this.match.dropClaims.push({ ...this.dropTarget });
    // Estimate ground height at the target for glide management.
    const surf = this.match.phys.surfaceAt(this.dropTarget.x, this.dropTarget.z, 300, 400);
    this.dropTargetY = surf ?? 0;
  }

  private dropSteer(cmd: InputCommand): InputCommand {
    const t = this.dropTarget ?? { x: 0, z: 0 };
    const p = this.actor.body.position;
    const dx = t.x - p.x;
    const dz = t.z - p.z;
    const distH = Math.hypot(dx, dz);
    cmd.yaw = Math.atan2(-dx, -dz);
    if (this.actor.state === 'glide') {
      // Manage the glide ratio so far targets are actually reachable:
      // flatten (or even hold altitude) when undershooting, dive when close.
      const alt = Math.max(1, p.y - (this.dropTargetY ?? 0));
      const ratio = distH / alt;
      if (ratio > 2.6) cmd.pitch = 0.35;        // need distance: flatten hard
      else if (ratio > 1.8) cmd.pitch = 0;      // hold
      else if (ratio > 0.9) cmd.pitch = -0.4;   // moderate dive
      else cmd.pitch = -0.9;                    // kill altitude, we're on top
    } else {
      cmd.pitch = distH > 40 ? -1.2 : distH > 18 ? -0.5 : -0.1;
    }
    cmd.moveZ = 1;
    return cmd;
  }

  /** Called externally when this bot takes damage (adaptation signal). */
  notePlayerBehavior(playerDist: number, aggressive: boolean): void {
    this.observedEngageDist = this.observedEngageDist * 0.95 + playerDist * 0.05;
    this.observedAggression = this.observedAggression * 0.97 + (aggressive ? 1 : 0) * 0.03;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function losFn(m: Match) {
  return (ax: number, ay: number, az: number, bx: number, by: number, bz: number) =>
    m.phys.losBlocked(ax, ay, az, bx, by, bz);
}

function losBlockedPoint(m: Match, a: Actor, t: Actor): boolean {
  return m.phys.losBlocked(
    a.body.position.x, a.eyeY, a.body.position.z,
    t.body.position.x, t.eyeY - 0.25, t.body.position.z,
  );
}

function matchOver(m: Match): boolean {
  return m.phase === 'results';
}

function weaponRangeFit(id: string, dist: number): number {
  switch (id) {
    case 'shotgun': return dist < 16 ? 1 : dist < 28 ? 0.55 : 0.15;
    case 'smg': return dist < 30 ? 1 : dist < 55 ? 0.6 : 0.25;
    case 'pistol': return dist < 40 ? 0.8 : 0.45;
    case 'ar': return dist < 90 ? 1 : 0.75;
    case 'sniper': return dist > 45 ? 1 : dist > 22 ? 0.6 : 0.3;
    default: return 0.5;
  }
}

function rarityIdx(r: string): number {
  return ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(r);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function pointSegDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax, abz = bz - az;
  const apx = px - ax, apz = pz - az;
  const len2 = abx * abx + abz * abz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apz * abz) / len2));
  const cx = ax + abx * t, cz = az + abz * t;
  return Math.hypot(px - cx, pz - cz);
}
