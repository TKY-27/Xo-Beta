/**
 * Xo Beta — main entry point. Boot flow: loading → main menu → play flow →
 * live match loop (fixed-step simulation + rendered presentation) → results.
 */

import * as THREE from 'three';
import { loadMap, MAP_LIST, ensureWorldReady, type MapId } from './world';
import { Match } from './sim/match';
import { BotController } from './ai/bot';
import { SIM, type Difficulty, WEAPONS } from './core/balance';
import { Rng } from './core/rng';
import { onSettingsChanged, updateSettings, getSettings } from './core/settings';
import { createMaterials, type MaterialLibrary } from './render/materials';
import { GameRenderer } from './render/renderer';
import { WorldView } from './render/worldView';
import { VfxSystem } from './render/vfx';
import { CameraRig } from './render/cameraRig';
import { ViewModel } from './render/viewmodel';
import { animateCharacter, createCharacter, type CharacterRig } from './render/characters';
import { PlayerController } from './player/controller';
import { Hud, Menus, type PlaySelection } from './ui/ui';
import { AudioEngine, attachAudio } from './audio/audio';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const $canvas = (): HTMLCanvasElement => document.getElementById('game-canvas') as HTMLCanvasElement;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface LiveGame {
  match: Match;
  renderer: GameRenderer;
  world: WorldView;
  vfx: VfxSystem;
  rig: CameraRig;
  viewmodel: ViewModel;
  rigs: Map<number, CharacterRig>;
  player: PlayerController;
  mats: MaterialLibrary;
}

let live: LiveGame | null = null;
let hud: Hud;
let audio: AudioEngine;
let menus: Menus;
const disposers: Array<() => void> = [];

let paused = false;
let loopRunning = false;
let accumulator = 0;
let lastTime = 0;
let resultsShown = false;
let spectateTargetId = -1;
let lastWeaponKey: string | null = null;

const WEAPON_KICK: Record<string, number> = { pistol: 0.7, smg: 0.45, ar: 0.8, shotgun: 2.2, sniper: 3 };
const WEAPON_ICONS: Record<string, string> = { pistol: '⌐', smg: '⁝⁝', ar: '⟋', shotgun: '≡', sniper: '⌇' };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function isTouchOnlyDevice(): boolean {
  return 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches;
}

async function setLoad(pct: number, status: string): Promise<void> {
  $('loading-fill').style.width = `${Math.round(pct * 100)}%`;
  $('loading-status').textContent = status;
  await new Promise((r) => setTimeout(r, 20));
}

async function boot(): Promise<void> {
  if (isTouchOnlyDevice()) {
    $('loading-screen').classList.add('hidden');
    $('mobile-gate').classList.remove('hidden');
    return;
  }

  hud = new Hud();
  audio = new AudioEngine();

  await setLoad(0.08, 'Preparing systems…');
  await ensureWorldReady();
  await setLoad(0.35, 'Compiling materials…');
  const sharedMats = createMaterials();
  await setLoad(0.6, 'Warming up…');

  menus = new Menus(MAP_LIST);
  menus.onPlayRequested = (sel) => void startMatch(sel, sharedMats);
  menus.onResumeRequested = resumeFromPause;
  menus.onQuitRequested = quitToMenu;

  await setLoad(1, 'Ready');
  window.setTimeout(() => $('loading-screen').classList.add('hidden'), 240);

  // Audio unlock on first gesture (browser autoplay policy)
  const unlockAudio = () => {
    audio.init();
    audio.resume();
  };
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  onSettingsChanged(() => {
    live?.renderer.applyQuality();
    hud.applyCrosshair();
    audio.applyVolumes();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && live && !paused && live.match.phase !== 'results') openPause();
  });
  window.addEventListener('blur', () => {
    if (live && !paused && live.match.phase !== 'results' &&
        !menus.isAnyMenuOpen()) openPause();
  });

  function resumeFromPause(): void {
    menus.hidePause();
    if (!live) return;
    paused = false;
    live.player.requestLock();
  }

  function quitToMenu(): void {
    teardownMatch();
    menus.showMainMenu();
    audio.setMusicState('none');
  }
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

async function startMatch(sel: PlaySelection, sharedMats: MaterialLibrary): Promise<void> {
  teardownMatch();
  menus.hideAll();
  $('loading-screen').classList.remove('hidden');
  await setLoad(0.15, `Loading ${MAP_LIST.find((m) => m.id === sel.map)?.name ?? sel.map}…`);

  const loaded = loadMap(sel.map);
  const match = new Match({
    mapDef: loaded.def,
    seed: Date.now() % 1000000,
    difficulty: sel.difficulty,
    withPlayer: true,
  });
  match.populateInitialLoot();
  await setLoad(0.55, 'Deploying combatants…');

  // Presentation stack
  const canvas = $canvas();
  const renderer = new GameRenderer(canvas);
  renderer.setupSkyAndLights(loaded.def.sky);
  const world = new WorldView(loaded.def, sharedMats, match);
  renderer.scene.add(world.group);
  const vfx = new VfxSystem();
  renderer.scene.add(vfx.group);
  const rig = new CameraRig(window.innerWidth / window.innerHeight);
  renderer.buildComposer(rig.camera);
  renderer.applyQuality();
  rig.mode = getSettings().cameraMode;

  // Controllers
  const player = new PlayerController(
    canvas,
    match.events as never,
    () => {
      rig.toggleMode();
      updateSettings({ cameraMode: rig.mode });
      viewmodel.group.visible = rig.mode === 'fps';
    },
    () => openPause(),
    () => cycleSpectate(-1),
    () => cycleSpectate(1),
    () => undefined,
  );
  for (const actor of match.actors) {
    if (actor.isPlayer) {
      player.resetLook(actor.yaw, 0);
      match.controllers.set(actor.id, player);
    } else if (actor.personality) {
      match.controllers.set(
        actor.id,
        new BotController(actor, match, new Rng(match.rng.next() * 0xffffffff), actor.personality, sel.difficulty),
      );
    }
  }

  // Character rigs
  const rigs = new Map<number, CharacterRig>();
  for (const actor of match.actors) {
    const charRig = createCharacter(actor.name, actor.accentColor, actor.isPlayer);
    rigs.set(actor.id, charRig);
    world.group.add(charRig.group);
  }

  // Viewmodel
  const viewmodel = new ViewModel();
  viewmodel.group.visible = rig.mode === 'fps';
  renderer.scene.add(viewmodel.group);

  attachAudio(match as never, audio, match.events);

  live = { match, renderer, world, vfx, rig, viewmodel, rigs, player, mats: sharedMats };

  wirePresentation(match, world, vfx, rigs, hud, viewmodel, rig);

  await setLoad(0.85, 'Final checks…');
  window.setTimeout(() => {
    $('loading-screen').classList.add('hidden');
    hud.show(true);
    hud.applyCrosshair();
    player.enabled = true;
    player.requestLock();
    audio.init();
    audio.resume();
    audio.startAmbience(loaded.def.sky.preset);
    audio.setMusicState('explore');
    hud.banner('SPACE — JUMP FROM TRANSPORT · FIGHT TO BE THE LAST ONE STANDING', 5.5);
    startLoop();
  }, 180);
}

function teardownMatch(): void {
  if (!live) return;
  loopRunning = false;
  for (const d of disposers) d();
  disposers.length = 0;
  live.player.enabled = false;
  live.player.releaseLock();
  live.renderer.renderer.dispose();
  live = null;
  resultsShown = false;
  spectateTargetId = -1;
  lastWeaponKey = null;
  paused = false;
  hud?.show(false);
  hud?.hideSpectate();
  hud?.interactPrompt(null);
  audio?.stopAmbience();
  audio?.setMusicState('none');
}

// ---------------------------------------------------------------------------
// Pause / spectator
// ---------------------------------------------------------------------------

function openPause(): void {
  if (!live || paused || live.match.phase === 'results') return;
  paused = true;
  live.player.releaseLock();
  menus.showPause();
}

function cycleSpectate(dir: number): void {
  const m = live?.match;
  if (!m || m.player?.alive !== false) return;
  const targets = m.spectatorTargets();
  if (!targets.length) return;
  const idx = targets.findIndex((t) => t.id === spectateTargetId);
  const next = targets[((idx + dir + targets.length * 2) % targets.length + targets.length) % targets.length]!;
  spectateTargetId = next.id;
}

// ---------------------------------------------------------------------------
// Event wiring: simulation events → presentation
// ---------------------------------------------------------------------------

function wirePresentation(
  match: Match,
  _world: WorldView,
  vfx: VfxSystem,
  _rigs: Map<number, CharacterRig>,
  hud: Hud,
  viewmodel: ViewModel,
  rig: CameraRig,
): void {
  const offs: Array<() => void> = [];
  const on = <K extends Parameters<typeof match.events.on>[0]>(k: K, fn: never) => {
    offs.push(match.events.on(k, fn as never));
  };

  match.events.on('muzzleFlash', (e) => {
    const isPlayer = e.actorId === match.player?.id;
    if (isPlayer && rig.mode === 'fps') {
      viewmodel.kick(WEAPON_KICK[e.weaponId] ?? 1);
    } else {
      vfx.muzzleFlash(e.x, e.y - 0.25, e.z, e.dx, e.dy, e.dz, isPlayer ? 0.8 : 1.15);
    }
  });
  match.events.on('tracer', (e) => vfx.spawnTracer(e.x1, e.y1, e.z1, e.x2, e.y2, e.z2, e.color));
  match.events.on('impact', (e) => vfx.impactSparks(e.x, e.y, e.z, e.nx, e.ny, e.nz, e.material === 'metal' ? 10 : 6));
  match.events.on('glassBreak', (e) => vfx.glassShards(e.x, e.y, e.z));
  match.events.on('destructibleDestroyed', (e) => vfx.debrisBurst(e.x, e.y, e.z, 0xa07848));
  match.events.on('actorHit', (e) => {
    if (e.attackerId === match.player?.id) hud.hitmarker(e.headshot);
    if (e.targetId === match.player?.id) rig.addShake(Math.min(0.5, e.damage / 60));
  });
  match.events.on('eliminated', (e) => {
    const victim = match.actors.find((a) => a.id === e.victimId);
    const killer = match.actors.find((a) => a.id === e.killerId);
    if (victim) {
      vfx.eliminationWisp(victim.body.position.x, victim.body.position.y + 1, victim.body.position.z, victim.accentColor);
    }
    hud.addKillfeed(
      killer?.name ?? null,
      victim?.name ?? '?',
      e.weaponId ? WEAPON_ICONS[e.weaponId] ?? '' : '',
      e.headshot,
      e.storm,
    );
    if (killer?.isPlayer && victim) hud.elimination(`ELIMINATED ${victim.name}`);
    if (victim?.isPlayer) hud.banner('YOU WERE ELIMINATED — SPECTATING (←/→ SWITCH)', 4);
  });
  match.events.on('shotFired', (e) => {
    if (e.actorId === match.player?.id && !e.dry && match.player) {
      const a = match.player;
      const dirX = Math.sin(a.yaw);
      const dirZ = Math.cos(a.yaw);
      vfx.shellCasing(a.body.position.x - dirZ * 0.3, a.eyeY - 0.3, a.body.position.z - dirX * 0.3, dirZ, -dirX);
    }
  });
  match.events.on('poundImpact', (e) => {
    vfx.poundShockwave(e.x, e.y, e.z);
    rig.addShake(0.35);
  });
  match.events.on('land', (e) => {
    if (e.actorId === match.player?.id) rig.addShake(Math.min(0.4, e.impactSpeed / 70));
  });
  match.events.on('stormWaiting', (e) =>
    hud.stormWarning(`STORM ADVANCING · CIRCLE ${e.index + 1} IN ${Math.round(e.waitTime)}s`));
  match.events.on('stormShrinking', () => {
    hud.stormWarning('THE STORM IS CLOSING IN', 3);
    rig.addShake(0.1);
  });
  match.events.on('phaseChanged', (e) => {
    if (e.phase === 'live') hud.banner('LAST ONE STANDING WINS', 3);
  });
  match.events.on('chestOpened', () => audio.chestOpen(cameraPos().x, 1, cameraPos().z));

  // Weapon swap sync
  const interval = window.setInterval(() => {
    const p = match.player;
    if (!p) return;
    const w = p.inv.selectedWeapon;
    const key = w ? `${w.weaponId}:${w.rarity}` : null;
    if (key !== lastWeaponKey) {
      lastWeaponKey = key;
      viewmodel.setWeapon(w ? w.weaponId : null, w?.rarity ?? 'common');
      if (w) audio.reloadClick(false);
    }
    if (w && p.wpn.reloadTimer <= 0) {
      const def = WEAPONS[w.weaponId];
      void def;
    }
  }, 120);
  disposers.push(() => window.clearInterval(interval));

  // Keep unused handler signature referenced (typed event bus)
  on('matchWon' as never, (() => undefined) as never);
}

function cameraPos(): THREE.Vector3 {
  return live ? live.rig.camera.position : new THREE.Vector3();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let fpsAccum = 0;
let fpsCount = 0;
let musicTimer = 0;

function startLoop(): void {
  if (loopRunning) return;
  loopRunning = true;
  lastTime = performance.now();
  accumulator = 0;
  requestAnimationFrame(frame);
}

function frame(now: number): void {
  if (!live) {
    loopRunning = false;
    return;
  }
  requestAnimationFrame(frame);

  const dtReal = Math.min(SIM.maxFrameDt, (now - lastTime) / 1000);
  lastTime = now;

  fpsAccum += dtReal;
  fpsCount++;
  if (fpsAccum >= 0.5) {
    hud.setFps(fpsCount / fpsAccum);
    fpsAccum = 0;
    fpsCount = 0;
  }

  const m = live.match;
  if (!paused) {
    accumulator += dtReal;
    let steps = 0;
    while (accumulator >= SIM.fixedDt && steps < 8) {
      m.fixedUpdate(SIM.fixedDt);
      accumulator -= SIM.fixedDt;
      steps++;
    }
    musicTimer -= dtReal;
    if (musicTimer <= 0) {
      musicTimer = 2;
      updateMusicState(m);
    }
  }

  present(dtReal);
}

function updateMusicState(m: Match): void {
  const p = m.player;
  if (!audio) return;
  if (m.phase === 'results') {
    audio.setMusicState(m.winner?.isPlayer ? 'victory' : 'defeat');
    return;
  }
  const inCombat = !!p && (m.time - p.lastDamageTime < 8 || p.wpn.lastShotTime < 5);
  if (m.aliveCount <= 3 || (m.storm.state !== 'idle' && m.storm.radius < 30)) {
    audio.setMusicState('final');
  } else if (inCombat) {
    audio.setMusicState('combat');
  } else {
    audio.setMusicState('explore');
  }
  if (p) {
    const distOut = m.storm.state === 'idle' ? -999 : m.storm.distanceOutside(p.body.position.x, p.body.position.z);
    audio.setStormNearby(distOut > -45);
  }
}

// ---------------------------------------------------------------------------
// Frame presentation
// ---------------------------------------------------------------------------

function present(dtReal: number): void {
  if (!live) return;
  const { match: m, renderer, world, vfx, rig, viewmodel, rigs, player } = live;

  // Debug/QA introspection hook (read-only).
  (window as unknown as Record<string, unknown>).__xoState = {
    phase: m.phase,
    time: m.time,
    aliveCount: m.aliveCount,
    stormRadius: m.storm.radius,
    items: m.loot.items.length,
    scene: renderer.scene,
    worldGroup: world.group,
    sceneInfo: {
      children: renderer.scene.children.length,
      lights: renderer.scene.children.filter((c) => (c as THREE.Light).isLight).map((c) => ({
        type: (c as THREE.Light).type,
        intensity: (c as THREE.Light).intensity,
        color: (c as THREE.Light).color.getHexString(),
      })),
      drawCalls: renderer.renderer.info.render.calls,
      triangles: renderer.renderer.info.render.triangles,
    },
    player: m.player ? {
      x: +m.player.body.position.x.toFixed(1),
      y: +m.player.body.position.y.toFixed(1),
      z: +m.player.body.position.z.toFixed(1),
      state: m.player.state,
      grounded: m.player.body.grounded,
      weapon: m.player.inv.selectedWeapon?.weaponId ?? null,
      health: Math.round(m.player.health),
    } : null,
  };

  const spectating = !m.player?.alive && m.phase !== 'results';
  if (spectating) {
    const targets = m.spectatorTargets();
    const target = targets.find((t) => t.id === spectateTargetId) ?? targets[0];
    if (target) {
      spectateTargetId = target.id;
      rig.updateSpectate(target, dtReal);
      hud.showSpectate(target.name);
    }
  } else if (m.player) {
    rig.update(m.player, dtReal, m.phys, {});
    hud.hideSpectate();
  }
  rig.tick(dtReal);

  // Characters
  for (const a of m.actors) {
    const charRig = rigs.get(a.id);
    if (!charRig) continue;
    if (a.isPlayer && rig.mode === 'fps' && a.alive && !spectating) {
      charRig.group.visible = false;
      continue;
    }
    animateCharacter(charRig, a, now() / 1000, dtReal);
    charRig.group.position.set(a.body.position.x, a.body.position.y, a.body.position.z);
  }

  // Grapple ropes
  for (const a of m.actors) {
    if (a.grappleActive) {
      vfx.setGrappleRope(a.id, a.body.position.x, a.body.position.y + 1.6, a.body.position.z,
        a.grapplePoint.x, a.grapplePoint.y, a.grapplePoint.z);
    } else {
      vfx.hideGrappleRope(a.id);
    }
  }

  // Viewmodel
  if (m.player?.alive && rig.mode === 'fps') {
    const speed = Math.hypot(m.player.body.velocity.x, m.player.body.velocity.z);
    viewmodel.update(m.player, dtReal, player.lookDxSmooth(), player.lookDySmooth(), speed);
    viewmodel.group.visible = true;
  } else {
    viewmodel.update(null, dtReal, 0, 0, 0);
    viewmodel.group.visible = false;
  }

  world.update(dtReal, m);
  vfx.update(dtReal, rig.camera.position);

  AudioEngine.setListenerPos(rig.camera.position.x, rig.camera.position.z);
  renderer.followSunTarget(new THREE.Vector3(
    m.player?.body.position.x ?? 0, 0, m.player?.body.position.z ?? 0));
  renderer.followViewer(rig.camera.position);

  hud.syncPlayerState(m);
  hud.drawMinimap(m, () => hud.minimapContext());
  hud.interactPrompt(!spectating && m.player?.alive && !paused ? findInteractPrompt(m) : null);

  if (m.phase === 'results' && !resultsShown) {
    resultsShown = true;
    showResults(m);
  }

  renderer.render(dtReal);
}

function findInteractPrompt(m: Match): string | null {
  const p = m.player;
  if (!p) return null;
  const pos = p.body.position;
  for (const c of m.chests) {
    if (c.opened) continue;
    const d = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
    if (d < 3.4) {
      return c.kind === 'vault' ? 'Open Vault Cache' : c.kind === 'elite' ? 'Open Elite Chest' : 'Open Chest';
    }
  }
  const item = m.loot.nearestItem(pos.x, pos.y + 1, pos.z, 4, (it) => it.kind !== 'ammo');
  if (item) {
    if (item.kind === 'weapon' && item.weapon) {
      return `Pick up ${item.weapon.rarity.toUpperCase()} ${WEAPONS[item.weapon.weaponId].name}`;
    }
    if (item.kind === 'heal' && item.heal) {
      return item.heal.itemId === 'medkit' ? 'Pick up Med Kit' : 'Pick up Shield Cell';
    }
  }
  return null;
}

function showResults(m: Match): void {
  const p = m.player;
  const won = m.winner?.isPlayer === true;
  hud.show(false);
  live?.player.releaseLock();
  audio.setMusicState(won ? 'victory' : 'defeat');
  audio.victoryFanfare(won);
  menus.showResults({
    won,
    winnerName: m.winner?.name ?? '—',
    placement: p?.placement ?? m.actors.length,
    kills: p?.stats.kills ?? 0,
    damage: p?.stats.damageDealt ?? 0,
    accuracy: p && p.stats.shotsFired > 0 ? p.stats.shotsHit / p.stats.shotsFired : 0,
    headshots: p?.stats.headshots ?? 0,
    survivalTime: p?.stats.survivalTime ?? 0,
  });
}

/** High-res time source shared by animation code. */
function now(): number {
  return performance.now();
}

// ---------------------------------------------------------------------------
// PlayerController look-delta smoothing accessors (added dynamically below)
// ---------------------------------------------------------------------------

declare module './player/controller' {
  interface PlayerController {
    lookDxSmooth(): number;
    lookDySmooth(): number;
  }
}

Object.defineProperty(PlayerController.prototype, 'lookDxSmooth', {
  value(this: { lookVelX?: number }) { return this.lookVelX ?? 0; },
});
Object.defineProperty(PlayerController.prototype, 'lookDySmooth', {
  value(this: { lookVelY?: number }) { return this.lookVelY ?? 0; },
});

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

void boot().catch((err) => {
  console.error('Xo Beta failed to boot:', err);
  $('loading-status').textContent = 'Failed to load — please reload the page.';
});
