/**
 * Xo Beta — main entry point. Boot flow: loading → main menu → play flow →
 * live match loop (fixed-step simulation + rendered presentation) → results.
 */

import * as THREE from 'three';
import { loadMap, MAP_LIST, ensureWorldReady } from './world';
import { Match } from './sim/match';
import { GROUPS as PHYS_GROUPS } from './physics/physics';
import { BotController } from './ai/bot';
import { MATCH, RARITY_CSS, SIM, WEAPONS } from './core/balance';
import type { WeaponId, Rarity } from './core/balance';
import { CAPSULE_CENTER_OFFSET, feetYFromBodyCenter } from './sim/movement';
import type { WeaponInstance } from './sim/inventory';
import type { Actor } from './sim/actor';
import { Rng } from './core/rng';
import { onSettingsChanged, updateSettings, getSettings, flushSettingsPersist } from './core/settings';
import { createMaterials, type MaterialLibrary } from './render/materials';
import { preloadAll } from './assets/assets';
import { PropLibrary } from './render/props';
import { LobbyScene } from './render/lobby';
import { GameRenderer } from './render/renderer';
import { WorldView } from './render/worldView';
import { VfxSystem } from './render/vfx';
import { CameraRig } from './render/cameraRig';
import { ViewModel } from './render/viewmodel';
import { CharacterFactory, updateEliminationFx, type CharacterRig } from './render/characters';
import { WeaponModelFactory } from './render/weaponModels';
import { loadGltf } from './assets/assets';
import { PlayerController } from './player/controller';
import { Hud, Menus, type PlaySelection, type LootPanelInfo } from './ui/ui';
import { t, initLang } from './core/i18n';
import { GamepadInput } from './player/gamepad';
import { AudioEngine, attachAudio } from './audio/audio';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const $canvas = (): HTMLCanvasElement => document.getElementById('game-canvas') as HTMLCanvasElement;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface LiveGame {
  generation: number;
  match: Match;
  renderer: GameRenderer;
  world: WorldView;
  vfx: VfxSystem;
  rig: CameraRig;
  viewmodel: ViewModel;
  rigs: Map<number, CharacterRig>;
  player: PlayerController;
  mats: MaterialLibrary;
  cleanup: Array<() => void>;
}

let live: LiveGame | null = null;
let hud: Hud;
let audio: AudioEngine;
let menus: Menus;
const disposers: Array<() => void> = [];
let matchGeneration = 0;
let pendingStart: { generation: number; cleanup: Array<() => void> } | null = null;

class MatchStartCancelled extends Error {}

function ensureCurrentStart(generation: number): void {
  if (pendingStart?.generation !== generation || generation !== matchGeneration) {
    throw new MatchStartCancelled();
  }
}

function registerStartCleanup(generation: number, cleanup: () => void): void {
  ensureCurrentStart(generation);
  pendingStart!.cleanup.push(cleanup);
}

function runCleanups(cleanups: Array<() => void>): void {
  for (let i = cleanups.length - 1; i >= 0; i--) {
    try { cleanups[i]!(); } catch (err) { console.warn('match cleanup failed', err); }
  }
  cleanups.length = 0;
}

function cancelPendingStart(): void {
  matchGeneration++;
  if (!pendingStart) return;
  const cleanups = pendingStart.cleanup;
  pendingStart = null;
  runCleanups(cleanups);
}

let paused = false;
let loopRunning = false;
let accumulator = 0;
let lastTime = 0;
/** Dev-only frame-cost EMAs (ms) surfaced via __xoState.perf for QA profiling. */
const perfStats = { simMs: 0, presentMs: 0, lastSimMs: 0, lastPresentMs: 0 };

// Frame-pacing telemetry: ring buffer of the last ~10 s of frame times plus
// cumulative spike counters. Average FPS alone hides interaction freezes;
// QA gates on p95/p99/worst and spike counts instead.
const FRAME_RING = 600;
const frameRing = new Float32Array(FRAME_RING);
let frameRingIdx = 0;
let framesTotal = 0;
let spikes33 = 0;
let spikes50 = 0;
let worstFrameMs = 0;
const recentSpikes: { t: number; ms: number; sim: number; pres: number; heapMB: number }[] = [];
let lastQaDomUpdate = 0;

function recordFrameMs(ms: number): void {
  frameRing[frameRingIdx] = ms;
  frameRingIdx = (frameRingIdx + 1) % FRAME_RING;
  framesTotal++;
  if (ms > worstFrameMs) worstFrameMs = ms;
  if (ms > 33) {
    spikes33++;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    recentSpikes.push({
      t: Math.round(performance.now()),
      ms: Math.round(ms),
      sim: Math.round(perfStats.lastSimMs * 10) / 10,
      pres: Math.round(perfStats.lastPresentMs * 10) / 10,
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1,
    });
    if (recentSpikes.length > 16) recentSpikes.shift();
  }
  if (ms > 50) spikes50++;
}

function resetPerfStats(): void {
  frameRing.fill(0);
  frameRingIdx = 0;
  framesTotal = 0;
  spikes33 = 0;
  spikes50 = 0;
  worstFrameMs = 0;
  recentSpikes.length = 0;
}

function framePercentile(p: number): number {
  const n = Math.min(framesTotal, FRAME_RING);
  if (n === 0) return 0;
  const copy: number[] = [];
  for (let i = 0; i < n; i++) copy.push(frameRing[i]!);
  copy.sort((a, b) => a - b);
  const out = copy[Math.min(n - 1, Math.floor(p * (n - 1)))];
  return out === undefined ? 0 : out;
}
let resultsShown = false;
let spectateTargetId = -1;
let wasInTransport = false;
let lastWeaponKey: string | null = null;

const WEAPON_KICK: Record<string, number> = {
  pistol: 0.7,
  smg: 0.45,
  ar: 0.8,
  shotgun: 2.2,
  sniper: 3,
};
const WEAPON_ICONS: Record<string, string> = {
  pistol: '⌐',
  smg: '⁝⁝',
  ar: '⟋',
  shotgun: '≡',
  sniper: '⌇',
};

// Powerful browser-inspection hooks must never be reachable from a production
// deployment merely by adding a query parameter. Vite replaces DEV with false
// during build, allowing Rollup to remove the entire QA surface.
const QA_MODE = import.meta.env.DEV && new URLSearchParams(location.search).has('qa');

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
  initLang();
  if (isTouchOnlyDevice()) {
    $('loading-screen').classList.add('hidden');
    $('mobile-gate').classList.remove('hidden');
    return;
  }

  hud = new Hud();
  audio = new AudioEngine();

  await setLoad(0.08, t('load.preparing'));
  await ensureWorldReady();
  await setLoad(0.3, t('load.assets'));
  await preloadAll((pct, _label) => {
    $('loading-fill').style.width = `${Math.round((0.3 + pct * 0.55) * 100)}%`;
    // Asset identifiers are implementation details and were previously shown
    // only in English. Keep real progress while presenting localized copy.
    $('loading-status').textContent = t('load.assets');
  });
  await audio.loadSamples();
  const sharedProps = new PropLibrary();
  await sharedProps.load();
  await setLoad(0.9, t('load.materials'));
  const sharedMats = await createMaterials();
  const characterFactory = new CharacterFactory();
  const weaponFactory = new WeaponModelFactory(sharedProps);
  {
    const [male, female, ual] = await Promise.all([
      loadGltf('characters/hero_male.gltf'),
      loadGltf('characters/hero_female.gltf'),
      loadGltf('characters/ual_standard.glb'),
    ]);
    await characterFactory.init(male.scene, female.scene, ual.animations);
  }

  // 3D lobby behind the main menu
  const lobby = new LobbyScene();
  lobby.start($canvas(), characterFactory, weaponFactory);

  await setLoad(0.6, t('load.warming'));

  menus = new Menus(MAP_LIST);
  menus.onUiSound = (kind) => audio.uiClick(kind);
  menus.onScreenChanged = (id) => lobby.compose(id === 'settings-menu' ? 'settings' : 'main');
  menus.onPlayRequested = (sel) =>
    void startMatch(sel, sharedMats, sharedProps, characterFactory, weaponFactory, lobby);
  menus.onResumeRequested = resumeFromPause;
  menus.onQuitRequested = quitToMenu;

  await setLoad(1, t('load.ready'));
  window.setTimeout(() => $('loading-screen').classList.add('hidden'), 240);

  // Audio unlock on first gesture (browser autoplay policy)
  const unlockAudio = () => {
    audio.init();
    audio.resume();
  };
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  // Loading can outlive the PLAY click's transient user activation, causing
  // the initial pointer-lock request to be rejected. Let a subsequent click
  // on the game canvas recover controls without forcing a pause round-trip.
  const onCanvasClick = () => {
    if (
      live
      && live.player.enabled
      && !paused
      && live.match.phase !== 'results'
      && !menus.isAnyMenuOpen()
      && !hud.isTacMapOpen()
      && document.pointerLockElement !== $canvas()
    ) {
      live.player.requestLock();
    }
  };
  $canvas().addEventListener('click', onCanvasClick);

  // Only graphics-relevant changes may touch the render pipeline. Settings
  // writes fire for every toggle (camera mode, crosshair, volume…); rebuilding
  // quality state on each of those caused interaction hitches (V switching).
  const GFX_KEYS = [
    'quality', 'resolutionScale', 'shadows', 'shadowQuality', 'postProcessing',
    'bloom', 'reflections', 'ao', 'aa', 'motionBlur', 'dof', 'fpsLimit',
  ] as const;
  let lastGfxKey = '';
  onSettingsChanged((s) => {
    const key = GFX_KEYS.map((k) => String(s[k])).join('|');
    if (key !== lastGfxKey) {
      lastGfxKey = key;
      live?.renderer.applyQuality();
    }
    hud.applyCrosshair();
    audio.applyVolumes();
  });
  window.addEventListener('pagehide', flushSettingsPersist);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && live && !paused && live.match.phase !== 'results') openPause();
  });
  window.addEventListener('blur', () => {
    if (live && !paused && live.match.phase !== 'results' && !menus.isAnyMenuOpen()) openPause();
  });

  function resumeFromPause(): void {
    menus.hidePause();
    if (!live) return;
    paused = false;
    live.player.enabled = true;
    live.player.requestLock();
  }

  function quitToMenu(): void {
    teardownMatch();
    menus.showMainMenu();
    audio.setMusicState('lobby');
    audio.startAmbience('night', true);
    lobby.start($canvas(), characterFactory, weaponFactory);
  }
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

async function startMatch(
  sel: PlaySelection,
  sharedMats: MaterialLibrary,
  sharedProps: PropLibrary,
  charFactory: CharacterFactory,
  weaponFactory: WeaponModelFactory,
  lobby: LobbyScene,
): Promise<void> {
  teardownMatch();
  const generation = ++matchGeneration;
  pendingStart = { generation, cleanup: [] };
  menus.setPlayEnabled(false);
  try {
    await startMatchImpl(
      sel, sharedMats, sharedProps, charFactory, weaponFactory, lobby, generation,
    );
    if (generation === matchGeneration) menus.setPlayEnabled(true);
  } catch (err) {
    if (err instanceof MatchStartCancelled || generation !== matchGeneration) return;
    console.error('match start failed', err);
    teardownMatch();
    $('loading-status').textContent = t('notice.loadFailed');
    $('loading-screen').classList.add('hidden');
    hud.show(false);
    menus.setPlayEnabled(true);
    menus.showMainMenu();
    audio.setMusicState('lobby');
    audio.startAmbience('night', true);
    lobby.start($canvas(), charFactory, weaponFactory);
  }
}

async function startMatchImpl(
  sel: PlaySelection,
  sharedMats: MaterialLibrary,
  sharedProps: PropLibrary,
  charFactory: CharacterFactory,
  weaponFactory: WeaponModelFactory,
  lobby: LobbyScene,
  generation: number,
): Promise<void> {
  lobby.stop();
  menus.hideAll();
  $('loading-screen').classList.remove('hidden');
  await setLoad(0.15, t('load.map', { name: t(`map.${sel.map}.name` as never) }));
  ensureCurrentStart(generation);

  const loaded = loadMap(sel.map);
  const match = new Match({
    mapDef: loaded.def,
    seed: Date.now() % 1000000,
    difficulty: sel.difficulty,
    withPlayer: true,
    practice: sel.practice === true,
  });
  registerStartCleanup(generation, () => match.dispose());
  match.populateInitialLoot();
  await setLoad(0.55, t('load.deploying'));
  ensureCurrentStart(generation);

  // Presentation stack
  const canvas = $canvas();
  const renderer = new GameRenderer(canvas);
  registerStartCleanup(generation, () => renderer.dispose());
  await renderer.setupSkyAndLights(loaded.def.sky);
  ensureCurrentStart(generation);
  if (loaded.def.sky.grade) renderer.setGrading(loaded.def.sky.grade);
  const world = await WorldView.create(loaded.def, sharedMats, match, sharedProps);
  ensureCurrentStart(generation);
  renderer.scene.add(world.group);
  registerStartCleanup(generation, () => {
    renderer.scene.remove(world.group);
    world.dispose();
  });
  const vfx = new VfxSystem();
  renderer.scene.add(vfx.group);
  registerStartCleanup(generation, () => {
    renderer.scene.remove(vfx.group);
    vfx.dispose();
  });
  const rig = new CameraRig(window.innerWidth / window.innerHeight);
  rig.sunAzimuth = renderer.sunAzimuth();
  rig.onScopedChanged = (s) => hud.setScoped(s);
  renderer.buildComposer(rig.camera);
  renderer.applyQuality();
  rig.mode = getSettings().cameraMode;

  // Controllers
  const gamepad = new GamepadInput({
    onJumpPress: () => undefined,
    onReloadPress: () => undefined,
    onInteractPress: () => undefined,
    onDashPress: () => undefined,
    onGrapplePress: () => undefined,
    onPoundPress: () => undefined,
    onMedkitPress: () => undefined,
    onShieldPress: () => undefined,
    onDropWeaponPress: () => undefined,
    onCameraToggle: () => {
      rig.toggleMode();
      updateSettings({ cameraMode: rig.mode });
      viewmodel.group.visible = rig.mode === 'fps';
    },
    onMapToggle: () => toggleTacMap(),
    onPauseRequest: () => openPause(),
    onSlotRequest: () => undefined,
    onMeleePress: () => {
      const p = live?.match.player;
      if (p?.alive) {
        p.inv.selectMelee();
        lastWeaponKey = null;
      }
    },
    onPingPress: () => placePingAtAim(),
  });
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
    () => toggleTacMap(),
  );
  registerStartCleanup(generation, () => player.dispose());
  player.gamepad = gamepad;

  // Damage-number world→screen projector
  hud.setProjector((x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(rig.camera);
    return { x: v.x * 0.5 + 0.5, y: -v.y * 0.5 + 0.5, visible: v.z < 1 };
  });

  // Tactical map interactions (click to move marker)
  const tacCanvas = document.getElementById('tac-map') as HTMLCanvasElement | null;
  const onTacClick = (ev: MouseEvent) => {
    if (!hud.isTacMapOpen() || !tacCanvas) return;
    const rect = tacCanvas.getBoundingClientRect();
    const half = match.mapDef.size / 2;
    hud.tacMarker = {
      x: ((ev.clientX - rect.left) / rect.width) * match.mapDef.size - half,
      z: ((ev.clientY - rect.top) / rect.height) * match.mapDef.size - half,
    };
    audio.uiClick('click');
  };
  tacCanvas?.addEventListener('click', onTacClick);
  registerStartCleanup(generation, () => tacCanvas?.removeEventListener('click', onTacClick));

  function toggleTacMap(): void {
    if (!match.player?.alive || match.phase === 'results') return;
    hud.toggleTacMap();
    if (hud.isTacMapOpen()) {
      player.releaseLock();
    } else if (!paused) {
      player.requestLock();
    }
  }

  function placePingAtAim(): void {
    if (!match.player?.alive || hud.isTacMapOpen()) return;
    const p = match.player.body.position;
    const dirX = -Math.sin(match.player.yaw) * Math.cos(match.player.pitch);
    const dirY = Math.sin(match.player.pitch);
    const dirZ = -Math.cos(match.player.yaw) * Math.cos(match.player.pitch);
    const hit = match.phys.raycast(p.x, match.player.eyeY, p.z, dirX, dirY, dirZ, 260, PHYS_GROUPS.rayWorldOnly);
    if (hit) {
      hud.tacMarker = { x: hit.point.x, z: hit.point.z };
      audio.uiClick('confirm');
    }
  }
  for (const actor of match.actors) {
    if (actor.isPlayer) {
      // Open the transport shot facing along the flight line, city below.
      const fdx = match.transportTo[0] - match.transportFrom[0];
      const fdz = match.transportTo[1] - match.transportFrom[1];
      const fl = Math.hypot(fdx, fdz) || 1;
      player.resetLook(Math.atan2(-fdx / fl, -fdz / fl), -0.38);
      match.controllers.set(actor.id, player);
    } else if (actor.personality) {
      match.controllers.set(
        actor.id,
        new BotController(actor, match, new Rng(match.rng.next() * 0xffffffff), actor.personality, sel.difficulty),
      );
    }
  }

  // Character rigs (skinned GLB combatants)
  const females = ['NOVA', 'KIRA', 'AXIS', 'ORBIT', 'VEX'];
  const rigs = new Map<number, CharacterRig>();
  for (const actor of match.actors) {
    const charRig = charFactory.create(actor.name, actor.accentColor, females.includes(actor.name));
    // QA metadata (read-only; used by the automated browser harness).
    charRig.group.userData.isCharacterRig = true;
    charRig.group.userData.isPlayerRig = actor.isPlayer;
    rigs.set(actor.id, charRig);
    world.group.add(charRig.group);
  }
  registerStartCleanup(generation, () => {
    for (const charRig of rigs.values()) charRig.dispose();
    rigs.clear();
  });
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__xoRigs = rigs;
  }
  live_weaponWatcher(rigs, match, weaponFactory);

  // Viewmodel
  const viewmodel = new ViewModel(weaponFactory);
  viewmodel.group.visible = rig.mode === 'fps';
  renderer.scene.add(viewmodel.group);
  registerStartCleanup(generation, () => {
    renderer.scene.remove(viewmodel.group);
    viewmodel.dispose();
  });
  {
    const w0 = match.player?.inv.selectedWeapon;
    // Player starts unarmed on the permanent fists slot.
    viewmodel.setWeapon(w0 ? w0.weaponId : null, w0?.rarity ?? 'common');
  }

  const detachAudio = attachAudio(match as never, audio, match.events);
  registerStartCleanup(generation, detachAudio);

  // Prewarm: build every weapon archetype now (loading screen) so mid-match
  // pickups/swaps only cheap-clone shared geometry, never allocate GPU state.
  weaponFactory.prewarmAll();

  // One-shot aerial capture for the tactical map while the loading screen is
  // still up (single GPU readback, ~50 ms).
  try {
    const aerial = renderer.captureAerial(match.mapDef.size / 2, 1024, [
      world.stormMesh,
      world.transportGroup,
      ...[...rigs.values()].map((r) => r.group),
      viewmodel.group,
    ]);
    hud.setTacMapImage(aerial);
    if (import.meta.env.DEV && aerial) {
      (window as unknown as { __xoAerial?: HTMLCanvasElement }).__xoAerial = aerial;
    }
  } catch (err) {
    console.error('aerial capture failed', err);
    /* aerial capture is cosmetic — fall back to the drawn map */
  }

  // Compile all shader programs before gameplay starts. Rigs are made visible
  // for the pass so first TPS reveal never stalls on program compilation
  // (V-switch freeze). present() restores per-mode visibility each frame.
  try {
    for (const r of rigs.values()) r.group.visible = true;
    viewmodel.group.visible = true;
    await renderer.renderer.compileAsync(renderer.scene, rig.camera);
    ensureCurrentStart(generation);
    // Warm the shadow/depth program variants too — compileAsync only covers
    // the main pass, and the first shadow render of a skinned rig otherwise
    // stalls ~50 ms on the first FP→TPS flip.
    renderer.renderer.render(renderer.scene, rig.camera);
  } catch {
    /* parallel shader compile unsupported — runtime compile still works */
  }
  viewmodel.group.visible = rig.mode === 'fps';

  ensureCurrentStart(generation);
  const cleanup = pendingStart!.cleanup;
  pendingStart = null;

  live = {
    generation,
    match,
    renderer,
    world,
    vfx,
    rig,
    viewmodel,
    rigs,
    player,
    mats: sharedMats,
    cleanup,
  };

  wirePresentation(match, world, vfx, rigs, hud, viewmodel, rig);

  await setLoad(0.85, t('load.final'));
  if (generation !== matchGeneration || live?.generation !== generation) throw new MatchStartCancelled();
  const startTimer = window.setTimeout(() => {
    if (live?.generation !== generation || generation !== matchGeneration) return;
    $('loading-screen').classList.add('hidden');
    hud.show(true);
    hud.applyCrosshair();
    player.enabled = true;
    player.requestLock();
    audio.init();
    audio.resume();
    audio.startAmbience(loaded.def.sky.preset, false);
    if (!sel.practice) {
      hud.banner(t('banner.drop', { jump: prettyBind(getSettings().bindings.jump) }), 5.5);
    }
    else hud.banner(t('menu.practice'), 2.4);
    // Measure live interaction only; lobby, map loading and shader warm-up
    // must not pollute the gameplay p95/p99/worst-frame regression signal.
    resetPerfStats();
    startLoop();
  }, 180);
  live.cleanup.push(() => window.clearTimeout(startTimer));
}

function teardownMatch(): void {
  cancelPendingStart();
  loopRunning = false;
  menus?.setPlayEnabled(true);
  const ending = live;
  live = null;
  if (import.meta.env.DEV) {
    delete (window as unknown as Record<string, unknown>).__xoRigs;
    delete (window as unknown as Record<string, unknown>).__xoAerial;
  }
  for (const d of disposers) d();
  disposers.length = 0;
  if (ending) runCleanups(ending.cleanup);
  resultsShown = false;
  spectateTargetId = -1;
  lastWeaponKey = null;
  paused = false;
  hud?.show(false);
  hud?.hideSpectate();
  hud?.interactPrompt(null);
  hud?.setTacMapImage(null);
  audio?.stopAmbience();
  audio?.setMusicState('none');
}

// ---------------------------------------------------------------------------
// Pause / spectator
// ---------------------------------------------------------------------------

function openPause(): void {
  if (!live || paused || live.match.phase === 'results') return;
  paused = true;
  // World keeps simulating; only local input is suspended.
  live.player.enabled = false;
  live.player.releaseLock();
  menus.showPause();
}

function cycleSpectate(dir: number): void {
  const m = live?.match;
  if (!m || m.player?.alive !== false) return;
  const targets = m.spectatorTargets();
  if (!targets.length) return;
  const idx = targets.findIndex((t) => t.id === spectateTargetId);
  const next = targets[(((idx + dir + targets.length * 2) % targets.length) + targets.length) % targets.length]!;
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

  const HEAVY_FLASH: Partial<Record<WeaponId, boolean>> = { shotgun: true, sniper: true };
  match.events.on('muzzleFlash', (e) => {
    const isPlayer = e.actorId === match.player?.id;
    if (isPlayer && rig.mode === 'fps') {
      viewmodel.kick(WEAPON_KICK[e.weaponId] ?? 1);
      viewmodel.muzzlePulse(isPlayer ? 0.8 : 1.15);
    } else {
      vfx.muzzleFlash(e.x, e.y - 0.25, e.z, e.dx, e.dy, e.dz, isPlayer ? 0.8 : 1.15, HEAVY_FLASH[e.weaponId] === true);
    }
  });
  match.events.on('tracer', (e) => vfx.spawnTracer(e.x1, e.y1, e.z1, e.x2, e.y2, e.z2, e.color));
  match.events.on('impact', (e) => vfx.impactSparks(e.x, e.y, e.z, e.nx, e.ny, e.nz, e.material === 'metal' ? 10 : 6));
  match.events.on('glassBreak', (e) => vfx.glassShards(e.x, e.y, e.z));
  match.events.on('destructibleDestroyed', (e) => vfx.debrisBurst(e.x, e.y, e.z, 0xa07848));
  match.events.on('actorHit', (e) => {
    if (e.attackerId === match.player?.id) {
      hud.hitmarker(e.headshot);
      if (!e.headshot) audio.play('ui/click', { bus: 'ui', vol: 0.2, rate: 2.1 });
      const target = match.actors.find((a) => a.id === e.targetId);
      if (target) {
        hud.spawnDamageNumber(
          target.body.position.x,
          target.body.position.y + 1.35,
          target.body.position.z,
          e.damage,
          e.killed ? 'kill' : e.headshot ? 'headshot' : e.shieldDamage > 0 ? 'shield' : 'normal',
        );
      }
    }
    if (e.targetId === match.player?.id) rig.addShake(Math.min(0.5, e.damage / 60));
  });
  match.events.on('shieldBroken', (e) => {
    const a = match.actors.find((x) => x.id === e.actorId);
    if (a) {
      vfx.shieldBreakBurst(a.body.position.x, a.body.position.y + 1.1, a.body.position.z);
      if (a.isPlayer) hud.caption(t('cap.shieldBreak'), true);
    }
  });
  match.events.on('eliminated', (e) => {
    const victim = match.actors.find((a) => a.id === e.victimId);
    const killer = match.actors.find((a) => a.id === e.killerId);
    if (victim) {
      vfx.eliminationWisp(
        victim.body.position.x,
        victim.body.position.y + 1,
        victim.body.position.z,
        victim.accentColor,
      );
    }
    hud.addKillfeed(
      killer?.name ?? null,
      victim?.name ?? '?',
      e.weaponId ? (WEAPON_ICONS[e.weaponId] ?? '') : '',
      e.headshot,
      e.storm,
    );
    hud.caption(t('cap.elimination'), false);
    if (killer?.isPlayer && victim) hud.elimination(`✕ ${victim.name}`);
    if (victim?.isPlayer) hud.banner(t('banner.eliminatedYou'), 4);
  });
  match.events.on('shotFired', (e) => {
    if (e.actorId === match.player?.id && !e.dry && match.player) {
      const a = match.player;
      // Eject toward the camera-right side, slightly back
      const rx = Math.cos(a.yaw);
      const rz = -Math.sin(a.yaw);
      vfx.shellCasing(a.body.position.x + rx * 0.32, a.eyeY - 0.28, a.body.position.z + rz * 0.32, rx * 2.1, rz * 2.1);
    }
  });
  match.events.on('poundImpact', (e) => {
    vfx.poundShockwave(e.x, e.y, e.z);
    rig.addShake(0.35);
  });
  match.events.on('meleeSwing', (e) => {
    const attacker = match.actors.find((a) => a.id === e.actorId);
    audio.meleeSwing(e.x, attacker?.eyeY ?? e.y, e.z);
    if (e.actorId === match.player?.id && rig.mode === 'fps') viewmodel.punch();
  });
  match.events.on('meleeHit', (e) => {
    const target = match.actors.find((a) => a.id === e.targetId);
    if (target) audio.meleeHit(target.body.position.x, target.body.position.y + 0.3, target.body.position.z);
    if (e.attackerId === match.player?.id) {
      hud.hitmarker(e.headshot);
      rig.addShake(e.killed ? 0.22 : 0.08);
    }
    if (e.targetId === match.player?.id) rig.addShake(0.18);
  });
  match.events.on('land', (e) => {
    if (e.actorId === match.player?.id) rig.addShake(Math.min(0.4, e.impactSpeed / 70));
  });
  match.events.on('stormWaiting', (e) => {
    hud.stormWarning(t('storm.advancing', { n: e.index + 1, s: Math.round(e.waitTime) }), 4);
    hud.caption(t('cap.storm'), true);
  });
  match.events.on('stormShrinking', () => {
    hud.stormWarning(t('storm.closing'), 3);
    rig.addShake(0.1);
  });
  match.events.on('phaseChanged', (e) => {
    if (e.phase === 'live') hud.banner(t('banner.lastStanding'), 3);
  });
  match.events.on('transportGateOpened', () => {
    hud.banner(t('banner.jumpUnlocked', { jump: prettyBind(getSettings().bindings.jump) }), 2.6);
  });
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
  }, 120);
  disposers.push(() => window.clearInterval(interval));

  // Keep unused handler signature referenced (typed event bus)
  on('matchWon' as never, (() => undefined) as never);
}

/** Keep each combatant's hand-held weapon model in sync with their inventory. */
function live_weaponWatcher(rigs: Map<number, CharacterRig>, match: Match, weaponFactory: WeaponModelFactory): void {
  const lastKey = new Map<number, string>();
  const interval = window.setInterval(() => {
    for (const a of match.actors) {
      const rig = rigs.get(a.id);
      if (!rig?.attachWeapon) continue;
      const w = a.inv.selectedWeapon;
      const key = w ? `${w.weaponId}:${w.rarity}` : '';
      if ((lastKey.get(a.id) ?? null) === key) continue;
      lastKey.set(a.id, key);
      if (!w) {
        rig.attachWeapon(null);
        continue;
      }
      const model = weaponFactory.build(w.weaponId, w.rarity);
      rig.attachWeapon(model?.group ?? null);
    }
  }, 200);
  disposers.push(() => window.clearInterval(interval));
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
  recordFrameMs(dtReal * 1000);

  fpsAccum += dtReal;
  fpsCount++;
  if (fpsAccum >= 0.5) {
    hud.setFps(fpsCount / fpsAccum);
    fpsAccum = 0;
    fpsCount = 0;
  }

  // The match simulation never freezes: ESC opens the in-game menu over the
  // still-running world (user requirement). Only the local player's input is
  // suspended while a menu is open.
  const m = live.match;
  {
    accumulator += dtReal;
    let steps = 0;
    const simT0 = performance.now();
    while (accumulator >= SIM.fixedDt && steps < 8) {
      m.fixedUpdate(SIM.fixedDt);
      accumulator -= SIM.fixedDt;
      steps++;
    }
    const simDt = performance.now() - simT0;
    perfStats.simMs = perfStats.simMs * 0.9 + simDt * 0.1;
    perfStats.lastSimMs = simDt;
    musicTimer -= dtReal;
    if (musicTimer <= 0) {
      musicTimer = 2;
      updateMusicState(m);
    }
  }

  const presT0 = performance.now();
  present(dtReal);
  const presDt = performance.now() - presT0;
  perfStats.presentMs = perfStats.presentMs * 0.9 + presDt * 0.1;
  perfStats.lastPresentMs = presDt;
}

function updateMusicState(m: Match): void {
  if (!audio) return;
  // Matches carry no continuous score — soundscape only. Stings at results.
  if (m.phase === 'results') {
    audio.setMusicState(m.winner?.isPlayer ? 'victory' : 'defeat');
  }
}

// ---------------------------------------------------------------------------
// Frame presentation
// ---------------------------------------------------------------------------

function present(dtReal: number): void {
  if (!live) return;
  const { match: m, renderer, world, vfx, rig, viewmodel, rigs, player } = live;

  // Debug/QA introspection hook. Development-only because the related helpers
  // below can mutate match state and must not ship as a production backdoor.
  if (QA_MODE) {
    (window as unknown as Record<string, unknown>).__xoState = {
      map: m.mapDef.id,
      seed: m.seed,
      practiceStart: m.practiceStart,
      phase: m.phase,
      time: m.time,
      aliveCount: m.aliveCount,
      stormRadius: m.storm.radius,
      stormCenterX: m.storm.centerX,
      stormCenterZ: m.storm.centerZ,
      stormState: m.storm.state,
      stormOutside: m.player ? m.storm.distanceOutside(m.player.body.position.x, m.player.body.position.z) : null,
      items: m.loot.items.length,
      scene: renderer.scene,
      cameraMode: rig.mode,
      camera: rig.camera,
      viewmodel: viewmodel.group,
      THREE,
      perf: {
        simMs: +perfStats.simMs.toFixed(2),
        presentMs: +perfStats.presentMs.toFixed(2),
        p95: +framePercentile(0.95).toFixed(1),
        p99: +framePercentile(0.99).toFixed(1),
        worst: +worstFrameMs.toFixed(1),
        spikes33,
        spikes50,
        frames: framesTotal,
        recentSpikes,
      },
      resetPerf: resetPerfStats,
      worldGroup: world.group,
      threeRenderer: renderer.renderer,
      sceneInfo: {
        children: renderer.scene.children.length,
        lights: renderer.scene.children
          .filter((c) => (c as THREE.Light).isLight)
          .map((c) => ({
            type: (c as THREE.Light).type,
            intensity: (c as THREE.Light).intensity,
            color: (c as THREE.Light).color.getHexString(),
          })),
        drawCalls: renderer.renderer.info.render.calls,
        triangles: renderer.renderer.info.render.triangles,
      },
      actors: m.actors
        .filter((a) => a.alive)
        .slice(0, 10)
        .map((a) => ({
          id: a.id,
          name: a.name,
          alive: a.alive,
          hp: Math.round(a.health),
          x: +a.body.position.x.toFixed(1),
          y: +a.body.position.y.toFixed(1),
          z: +a.body.position.z.toFixed(1),
          yaw: +a.yaw.toFixed(2),
          state: a.state,
        })),
      chests: m.chests.slice(0, 14).map((c) => ({
        x: +c.x.toFixed(1),
        z: +c.z.toFixed(1),
        opened: c.opened,
        tier: c.kind === 'vault' ? 2 : c.kind === 'elite' ? 1 : 0,
      })),
      lootNear: m.player
        ? m.loot.items
            .map((it) => ({ it, d: Math.hypot(it.x - m.player!.body.position.x, it.z - m.player!.body.position.z) }))
            .sort((a, b) => a.d - b.d)
            .filter(({ it }) => it.kind === 'weapon' || it.kind === 'heal')
            .slice(0, 8)
            .map(({ it, d }) => ({
              kind: it.kind,
              weapon: it.weapon?.weaponId ?? null,
              rarity: it.rarity,
              x: +it.x.toFixed(0),
              y: +it.y.toFixed(1),
              z: +it.z.toFixed(0),
              d: +d.toFixed(1),
            }))
        : [],
      player: m.player
        ? {
            x: +m.player.body.position.x.toFixed(1),
            y: +m.player.body.position.y.toFixed(1),
            z: +m.player.body.position.z.toFixed(1),
            state: m.player.state,
            grounded: m.player.body.grounded,
            weapon: m.player.inv.selectedWeapon?.weaponId ?? null,
            ads: +m.player.wpn.adsAmount.toFixed(2),
            spread: +m.player.wpn.currentSpread.toFixed(4),
            bloom: +m.player.wpn.bloom.toFixed(4),
            shots: m.player.stats.shotsFired,
            health: Math.round(m.player.health),
            vy: +m.player.body.velocity.y.toFixed(2),
            jumpsUsed: m.player.jumpsUsed,
            coyote: +m.player.coyote.toFixed(2),
            jumpBuffered: +m.player.jumpBuffered.toFixed(2),
            fov: Math.round(rig.camera.fov),
            anim: rigs.get(m.player.id)?.animName ?? null,
          }
        : null,
    };

    // The Codex headed browser evaluates page scripts in an isolated world,
    // so window expandos are not observable there. Mirror only the small,
    // non-sensitive QA status needed to record exploration routes onto the
    // shared document at a low cadence; it remains invisible to players.
    const qaNow = performance.now();
    if (qaNow - lastQaDomUpdate >= 250) {
      lastQaDomUpdate = qaNow;
      const p = m.player?.body.position;
      const start = m.practiceStart;
      const data = document.documentElement.dataset;
      data.xoQaMap = m.mapDef.id;
      data.xoQaSeed = String(m.seed);
      data.xoQaPhase = m.phase;
      data.xoQaPosition = p ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : '';
      data.xoQaLook = m.player
        ? `${m.player.yaw.toFixed(2)},${m.player.pitch.toFixed(2)},${rig.mode}`
        : '';
      data.xoQaMovement = m.player
        ? `${rigs.get(m.player.id)?.animName ?? 'none'}|vy=${m.player.body.velocity.y.toFixed(2)}|dash=${m.player.dashTimer.toFixed(2)}`
        : '';
      data.xoQaStart = start
        ? `${start.poi}|${start.x.toFixed(1)},${start.y.toFixed(1)},${start.z.toFixed(1)}`
        : '';
      data.xoQaPerf = `${framePercentile(0.95).toFixed(1)},${framePercentile(0.99).toFixed(1)},${worstFrameMs.toFixed(1)}`;
    }
  }

  // QA-only teleport hook (?qa=1) for screenshot navigation.
  if (QA_MODE) {
    (window as unknown as Record<string, unknown>).__xoTeleport = (x: number, z: number, yaw = 0, refY?: number) => {
      const p = m.player;
      if (!p || !p.alive) return;
      // Snap to the surface so the capsule never spawns inside terrain.
      // Optional refY anchors the downward query near a known height
      // (e.g. a loot item) instead of landing on the highest roof/canopy.
      const anchored = typeof refY === 'number';
      const surf = anchored ? m.phys.surfaceAt(x, z, refY + 2.5, 80) : m.phys.surfaceAt(x, z, 400, 500);
      if (surf !== null) {
        p.body.teleport(x, surf + CAPSULE_CENTER_OFFSET + 0.05, z);
      } else if (anchored) {
        p.body.teleport(x, refY + CAPSULE_CENTER_OFFSET + 0.05, z);
      } else {
        p.body.position.x = x;
        p.body.position.z = z;
      }
      p.body.velocity.x = 0;
      p.body.velocity.y = 0;
      p.body.velocity.z = 0;
      if (live && p.state !== 'swim') {
        if (p.state === 'freefall' || p.state === 'glide') p.state = 'ground';
        live.player.resetLook(yaw, -0.12);
      }
    };
    // QA stress hook: ring all living bots tightly around the player to
    // force maximum concurrent AI/combat/VFX load. Dev builds only.
    (window as unknown as Record<string, unknown>).__xoStress = () => {
      const p = m.player;
      if (!p) return;
      const alive = m.actors.filter((a) => a.alive && !a.isPlayer);
      alive.forEach((a, i) => {
        const ang = (i / Math.max(1, alive.length)) * Math.PI * 2;
        const x = p.body.position.x + Math.cos(ang) * 18;
        const z = p.body.position.z + Math.sin(ang) * 18;
        const surf = m.phys.surfaceAt(x, z, 400, 500);
        if (surf !== null) a.body.teleport(x, surf + 1.1, z);
        else { a.body.position.x = x; a.body.position.z = z; }
        a.body.velocity.x = 0; a.body.velocity.y = 0; a.body.velocity.z = 0;
      });
    };
    // QA helper: grant + equip a weapon by id ('pistol'|'smg'|'ar'|
    // 'shotgun'|'sniper', optional rarity). Dev/QA builds only.
    (window as unknown as Record<string, unknown>).__xoGive = (weaponId: string, rarity?: string) => {
      const p = m.player;
      if (!p || !p.alive) return false;
      const def = WEAPONS[weaponId as WeaponId];
      if (!def) return false;
      const rarityNames = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
      const item: WeaponInstance = {
        kind: 'weapon',
        weaponId: weaponId as WeaponId,
        rarity: (rarityNames.includes(rarity ?? '') ? rarity : 'common') as Rarity,
        ammoInMag: def.magSize,
      };
      const res = p.inv.add(item);
      if (!res.ok || res.slot === undefined) return false;
      p.inv.ammo[def.ammoType] = Math.max(p.inv.ammo[def.ammoType], def.reserveMax);
      p.inv.select(res.slot);
      lastWeaponKey = null;
      return true;
    };
    // QA helper: drive player fire/ADS through the real command pipeline
    // (browser automation cannot engage pointer lock). Pass null to clear.
    // fireHeld implies firePressed so semi/pump weapons also cycle.
    (window as unknown as Record<string, unknown>).__xoQaInput = (
      o: { fireHeld?: boolean; adsHeld?: boolean } | null,
    ) => {
      m.qaInput =
        o && (o.fireHeld || o.adsHeld)
          ? { ...o, firePressed: o.fireHeld === true }
          : null;
    };
    // QA helper: jump the storm to a mid-shrink state so the wall, outside
    // tint, map fill and route-to-safety line can be verified without
    // waiting out the real phase timers.
    (window as unknown as Record<string, unknown>).__xoStorm = () => {
      m.storm.qaForceShrink(90, -60, 130, 20);
      return { toX: 90, toZ: -60, toR: 130 };
    };
  }

  const spectating = !m.player?.alive && m.phase !== 'results';
  const playerAboard = !!m.player && !m.player.deployed;
  const inTransport = m.phase === 'transport' && !spectating && playerAboard;
  // Drop-rig slots: combatants hang in a row beneath the hull, spread along
  // the flight axis. The player rides the front slot with the line of
  // combatants receding behind them.
  const flightDx = m.transportTo[0] - m.transportFrom[0];
  const flightDz = m.transportTo[1] - m.transportFrom[1];
  const flightL = Math.hypot(flightDx, flightDz) || 1;
  const dirX = flightDx / flightL;
  const dirZ = flightDz / flightL;
  const slotOffset = (index: number): { x: number; z: number; y: number } => {
    const k = (4.5 - index) * 1.32;
    return { x: dirX * k, z: dirZ * k, y: (index % 2) * 0.24 };
  };
  const slotOf = (a: Actor): { x: number; z: number; y: number } => slotOffset(Math.max(0, m.actors.indexOf(a)));
  if (spectating) {
    const targets = m.spectatorTargets();
    const target = targets.find((t) => t.id === spectateTargetId) ?? targets[0];
    if (target) {
      spectateTargetId = target.id;
      rig.updateSpectate(target, dtReal);
      hud.showSpectate(target.name);
    }
  } else if (inTransport && m.player) {
    const slot = slotOf(m.player);
    rig.updateTransport(m.transportPos, slot, m.player.yaw, m.player.pitch, now() / 1000, dtReal);
    hud.hideSpectate();
  } else if (m.player) {
    if (wasInTransport) {
      const slot = slotOf(m.player);
      rig.beginGameplayBlend(new THREE.Vector3(
        m.transportPos.x + slot.x,
        m.transportPos.y - MATCH.transportHangOffset + slot.y + 1.6,
        m.transportPos.z + slot.z,
      ));
    }
    rig.update(m.player, dtReal, m.phys, {});
    hud.hideSpectate();
  }
  wasInTransport = inTransport && m.phase === 'transport';
  rig.tick(dtReal);

  // Characters
  const freezeRigs = import.meta.env.DEV
    && (window as unknown as { __xoFreezeRigs?: boolean }).__xoFreezeRigs === true;
  for (const a of m.actors) {
    const charRig = rigs.get(a.id);
    if (!charRig) continue;
    if (a.isPlayer && rig.mode === 'fps' && a.alive && !spectating) {
      charRig.group.visible = false;
      continue;
    }
    charRig.group.visible = true;
    if (!freezeRigs) {
      // Combatants ride the drop rig beneath the transport hull until they
      // jump; `deployed` (not the anim state) is the source of truth so a
      // landed early jumper is never snapped back to the hull.
      const aboard = inTransport && !a.deployed;
      if (aboard) {
        const slot = slotOf(a);
        charRig.group.position.set(
          m.transportPos.x + slot.x,
          m.transportPos.y - MATCH.transportHangOffset + slot.y,
          m.transportPos.z + slot.z,
        );
      } else {
        // CharBody.position is the capsule centre; character assets are
        // authored from the soles upward. Anchor the presentation at the
        // physical feet so the model and contact shadow share ground truth.
        charRig.group.position.set(
          a.body.position.x,
          feetYFromBodyCenter(a.body.position.y),
          a.body.position.z,
        );
      }
      if (a.alive) {
        charRig.update?.(a, now() / 1000, dtReal);
      } else {
        updateEliminationFx(charRig, dtReal);
      }
    }
  }

  // Grapple ropes
  for (const a of m.actors) {
    if (a.grappleActive) {
      vfx.setGrappleRope(
        a.id,
        a.body.position.x,
        feetYFromBodyCenter(a.body.position.y) + 1.6,
        a.body.position.z,
        a.grapplePoint.x,
        a.grapplePoint.y,
        a.grapplePoint.z,
      );
    } else {
      vfx.hideGrappleRope(a.id);
    }
  }

  // Viewmodel (hidden while riding the transport — the unified transport
  // camera frames the drop rig instead of a weapon; hidden at full sniper
  // scope where the scope overlay replaces the world view).
  if (m.player?.alive && rig.mode === 'fps' && !inTransport && !rig.scoped) {
    const speed = Math.hypot(m.player.body.velocity.x, m.player.body.velocity.z);
    viewmodel.update(m.player, dtReal, player.lookDxSmooth(), player.lookDySmooth(), speed);
    viewmodel.group.visible = true;
  } else {
    viewmodel.update(null, dtReal, 0, 0, 0);
    viewmodel.group.visible = false;
  }

  world.setViewPos(rig.camera.position);
  world.update(dtReal, m);
  vfx.update(dtReal, rig.camera.position);

  {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
    AudioEngine.setListener(rig.camera.position.x, rig.camera.position.y, rig.camera.position.z, fwd.x, fwd.z);
    const eyeUnder = world.isEyeUnderwater(rig.camera.position);
    audio.setEnvironmentState(eyeUnder ? 'underwater' : 'open');
  }
  renderer.followSunTarget(new THREE.Vector3(m.player?.body.position.x ?? 0, 0, m.player?.body.position.z ?? 0));
  renderer.followViewer(rig.camera.position);

  hud.syncPlayerState(m);
  hud.drawMinimap(m, () => hud.minimapContext());
  if (hud.isTacMapOpen()) hud.drawTacMap(m);
  {
    const info = !spectating && m.player?.alive && !paused && !hud.isTacMapOpen() ? findInteractInfo(m) : null;
    hud.interactPrompt(info && info.prompt ? info.prompt : null);
    hud.showLootPanel(info?.loot ?? null);
  }

  if (m.phase === 'results' && !resultsShown) {
    resultsShown = true;
    showResults(m);
  }

  renderer.render(dtReal);
}

interface InteractInfo {
  prompt: string;
  loot: LootPanelInfo | null;
}

function findInteractInfo(m: Match): InteractInfo | null {
  const p = m.player;
  if (!p) return null;
  const pos = p.body.position;
  for (const c of m.chests) {
    if (c.opened) continue;
    const d = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
    if (d < 3.4) {
      const label =
        c.kind === 'vault'
          ? t('interact.openVault')
          : c.kind === 'elite'
            ? t('interact.openElite')
            : t('interact.openChest');
      return { prompt: label, loot: null };
    }
  }
  const item = m.loot.nearestItem(pos.x, pos.y + 1, pos.z, 4, (it) => it.kind !== 'ammo');
  if (!item) return null;

  const invFull = p.inv.selectedWeapon !== null && item.kind === 'weapon' && p.inv.slots.every((s) => s !== null);
  if (item.kind === 'weapon' && item.weapon) {
    const def = WEAPONS[item.weapon.weaponId];
    const rarityText = t(`rarity.${item.weapon.rarity}` as never);
    return {
      prompt: '',
      loot: {
        name: t(`wpn.${item.weapon.weaponId}` as never),
        typeText: t('loot.type.weapon'),
        rarityText: rarityText.toUpperCase(),
        rarityColor: RARITY_CSS[item.weapon.rarity],
        metaText: `${t(`ammo.${def.ammoType}` as never)} · ${item.weapon.ammoInMag}/${def.magSize}`,
        keyLabel: prettyBind(getSettings().bindings.interact),
        inventoryFull: invFull,
      },
    };
  }
  if (item.kind === 'heal' && item.heal) {
    const med = item.heal.itemId === 'medkit';
    return {
      prompt: '',
      loot: {
        name: med ? t('bind.useMedkit') : t('bind.useShield'),
        typeText: t('loot.type.heal'),
        rarityText: med ? t('rarity.rare').toUpperCase() : t('rarity.uncommon').toUpperCase(),
        rarityColor: med ? '#ff7d89' : '#53d8ff',
        metaText: `×${item.heal.count}`,
        keyLabel: prettyBind(getSettings().bindings.interact),
        inventoryFull: false,
      },
    };
  }
  return null;
}

function prettyBind(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.toUpperCase();
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
  value(this: { lookVelX?: number }) {
    return this.lookVelX ?? 0;
  },
});
Object.defineProperty(PlayerController.prototype, 'lookDySmooth', {
  value(this: { lookVelY?: number }) {
    return this.lookVelY ?? 0;
  },
});

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

void boot().catch((err) => {
  console.error('Xo Beta failed to boot:', err);
  $('loading-status').textContent = t('notice.loadFailed');
});
