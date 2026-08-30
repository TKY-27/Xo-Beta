/**
 * Xo Beta — main entry point. Boot flow: loading → main menu → play flow →
 * live match loop (fixed-step simulation + rendered presentation) → results.
 */

import * as THREE from 'three';
import { loadMap, MAP_LIST, ensureWorldReady } from './world';
import { Match } from './sim/match';
import { GROUPS as PHYS_GROUPS } from './physics/physics';
import { BotController } from './ai/bot';
import { MATCH, MOVE, RARITY_CSS, SIM, WEAPONS } from './core/balance';
import type { WeaponId, Rarity } from './core/balance';
import { feetYFromBodyCenter } from './sim/movement';
import type { WeaponInstance } from './sim/inventory';
import type { Actor } from './sim/actor';
import {
  buildRoster,
  localHumanRosterEntry,
  remoteHumanRosterEntry,
  type MatchMode,
  type RosterEntry,
} from './sim/roster';
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
  characterFill: THREE.PointLight;
  player: PlayerController;
  mats: MaterialLibrary;
  qaSceneCensus: string;
  qaGlassSpecs: Array<{ id: number; stableId: string; x: number; y: number; z: number; sx: number; sy: number; sz: number }>;
  qaGlassBreakFrames: Array<{ time: number; presentMs: number }>;
  worldConstructionMs: number;
  cleanup: Array<() => void>;
}

let live: LiveGame | null = null;
let hud: Hud;
let audio: AudioEngine;
let menus: Menus;
const disposers: Array<() => void> = [];
let matchGeneration = 0;
let pendingStart: { generation: number; cleanup: Array<() => void> } | null = null;
const presentationMuzzle = new THREE.Vector3();
const presentationMuzzleDirection = new THREE.Vector3();
const presentationFillDirection = new THREE.Vector3();

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

function buildQaSceneCensus(root: THREE.Object3D): string {
  const count = (object: THREE.Object3D) => {
    let renderables = 0;
    let instanced = 0;
    let triangles = 0;
    let shadowCasters = 0;
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh && !(child as THREE.Points).isPoints && !(child as THREE.Line).isLine) return;
      renderables++;
      if (mesh.castShadow) shadowCasters++;
      const instances = (mesh as THREE.InstancedMesh).isInstancedMesh
        ? Math.max(0, (mesh as THREE.InstancedMesh).count)
        : 1;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) instanced++;
      const geometry = mesh.geometry;
      if (!geometry) return;
      const primitiveCount = geometry.index
        ? geometry.index.count / 3
        : (geometry.getAttribute('position')?.count ?? 0) / 3;
      triangles += primitiveCount * instances;
    });
    return { renderables, instanced, shadowCasters, triangles: Math.round(triangles) };
  };
  const groups = root.children.map((child) => ({ name: child.name || child.type, ...count(child) }));
  groups.sort((a, b) => b.triangles - a.triangles || b.renderables - a.renderables);
  return JSON.stringify({ total: count(root), groups: groups.slice(0, 12) });
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
let lastQaTeleportRequest = '';
let lastQaPerfResetRequest = '';
let lastQaGpuSyncRequest = '';

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
let wasSpectating = false;
let lastWeaponKey: string | null = null;
const presentationTransportPos = new THREE.Vector3();
let qaGlassBreakTimes: number[] = [];
let qaGlassBreakFrames: Array<{ time: number; presentMs: number }> = [];

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
const QA_PARAMS = new URLSearchParams(location.search);
const QA_MODE = import.meta.env.DEV && QA_PARAMS.has('qa');
const QA_HERO_MODE = QA_MODE && QA_PARAMS.has('hero');
if (QA_HERO_MODE) document.documentElement.dataset.xoQaHero = '1';

function qaRosterFixture(seed: number): { mode: MatchMode; roster: RosterEntry[] } | null {
  if (!QA_MODE) return null;
  const fixture = QA_PARAMS.get('roster');
  if (fixture !== '2v2' && fixture !== '5v5' && fixture !== '4v6') return null;
  const teamIds = fixture === '4v6' ? [0, 0, 0, 0] : [0, 0, 1, 1];
  const humans = [
    localHumanRosterEntry({
      peerId: 'qa-local',
      displayName: 'QA LOCAL',
      teamId: teamIds[0],
      skinId: getSettings().playerSkin,
    }),
    ...teamIds.slice(1).map((teamId, index) => remoteHumanRosterEntry({
      slotId: index + 1,
      actorId: index + 2,
      peerId: `qa-peer-${index + 2}`,
      displayName: `QA HUMAN ${index + 2}`,
      teamId,
    })),
  ];
  const mode: MatchMode = fixture === '2v2'
    ? 'teams'
    : fixture === '5v5'
      ? 'teams-bot-fill'
      : 'humans-vs-bots';
  return { mode, roster: buildRoster({ mode, humans, seed }) };
}

interface QaConsoleCapture {
  issues: string[];
}

function installQaConsoleCapture(): string[] {
  if (!QA_MODE) return [];
  const host = window as unknown as Record<string, unknown>;
  const existing = host.__xoQaConsoleCapture as QaConsoleCapture | undefined;
  if (existing) return existing.issues;
  const issues: string[] = [];
  const record = (kind: string, args: unknown[]): void => {
    const text = args.map((arg) => {
      if (arg instanceof Error) {
        // Keep the first stack frames in the headed-QA ledger. A message-only
        // capture made recurring render/simulation faults impossible to map
        // back to their source when Chrome kept the game loop alive.
        return arg.stack ?? `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).join(' ');
    issues.push(`${kind}: ${text}`.slice(0, 500));
    if (issues.length > 40) issues.shift();
  };
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args: unknown[]) => { record('warn', args); originalWarn(...args); };
  console.error = (...args: unknown[]) => { record('error', args); originalError(...args); };
  window.addEventListener('error', (event) => record('pageerror', [event.error ?? event.message]));
  window.addEventListener('unhandledrejection', (event) => record('rejection', [event.reason]));
  host.__xoQaConsoleCapture = { issues } satisfies QaConsoleCapture;
  return issues;
}

const qaRuntimeIssues = installQaConsoleCapture();

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
  $('btn-spectate-exit').addEventListener('click', () => menus.onQuitRequested());

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
      && live.match.localActor?.alive === true
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
  qaGlassBreakTimes = [];
  qaGlassBreakFrames = [];
  const matchSeed = Date.now() % 1000000;
  const qaFixture = sel.practice ? null : qaRosterFixture(matchSeed);
  const mode = qaFixture?.mode ?? 'solo';
  const roster = qaFixture?.roster ?? buildRoster({
      mode,
      humans: [localHumanRosterEntry({ skinId: getSettings().playerSkin })],
      practice: sel.practice === true,
      seed: matchSeed,
    });
  const match = new Match({
    mapDef: loaded.def,
    seed: matchSeed,
    difficulty: sel.difficulty,
    mode,
    roster,
    practice: sel.practice === true,
  });
  registerStartCleanup(generation, () => match.dispose());
  match.populateInitialLoot();
  await setLoad(0.55, t('load.deploying'));
  ensureCurrentStart(generation);

  // Presentation stack
  const canvas = $canvas();
  const renderer = new GameRenderer(canvas, QA_MODE);
  registerStartCleanup(generation, () => renderer.dispose());
  await renderer.setupSkyAndLights(loaded.def.sky);
  ensureCurrentStart(generation);
  if (loaded.def.sky.grade) renderer.setGrading(loaded.def.sky.grade);
  const worldStart = performance.now();
  const world = await WorldView.create(loaded.def, sharedMats, match, sharedProps);
  const worldConstructionMs = performance.now() - worldStart;
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
  rig.onScopedChanged = (s) => {
    hud.setScoped(s);
    renderer.setScopeActive(s, rig.camera);
  };
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
    onPauseRequest: () => handlePauseOrSpectateExit(),
    onSlotRequest: () => undefined,
    onMeleePress: () => {
      const p = live?.match.localActor;
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
    () => handlePauseOrSpectateExit(),
    () => cycleSpectate(-1),
    () => cycleSpectate(1),
    () => toggleTacMap(),
    () => updateSettings({
      tpsCharacterSide: getSettings().tpsCharacterSide === 'left' ? 'right' : 'left',
    }),
    () => toggleInventory(),
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
    if (!match.localActor?.alive || match.phase === 'results') return;
    if (hud.isInventoryOpen()) hud.setInventoryOpen(false);
    hud.toggleTacMap();
    if (hud.isTacMapOpen()) {
      player.releaseLock();
    } else if (!paused) {
      player.requestLock();
    }
  }

  function toggleInventory(force?: boolean): void {
    const currentlyOpen = hud.isInventoryOpen();
    const open = force ?? !currentlyOpen;
    if (open === currentlyOpen) return;
    if (open && (!match.localActor?.alive || match.phase === 'results' || paused)) return;
    if (open && hud.isTacMapOpen()) hud.toggleTacMap();
    hud.setInventoryOpen(open);
    rig.resetAimState();
    renderer.setScopeActive(false);
    player.enabled = !open;
    if (open) player.releaseLock();
    else if (!paused) player.requestLock();
  }

  hud.onInventoryClose = () => toggleInventory(false);
  hud.onInventorySelect = (slot) => {
    if (match.selectPlayerInventorySlot(slot)) {
      lastWeaponKey = null;
      audio.uiClick('click');
    }
  };
  hud.onInventoryMove = (from, to) => {
    if (match.reorderPlayerInventory(from, to)) {
      audio.uiClick('click');
    }
  };
  hud.onInventoryDrop = (slot) => {
    if (match.dropPlayerInventorySlot(slot)) {
      lastWeaponKey = null;
      audio.uiClick('confirm');
    }
  };
  registerStartCleanup(generation, () => {
    hud.setInventoryOpen(false);
    hud.onInventoryClose = () => undefined;
    hud.onInventorySelect = () => undefined;
    hud.onInventoryMove = () => undefined;
    hud.onInventoryDrop = () => undefined;
  });

  function placePingAtAim(): void {
    if (!match.localActor?.alive || hud.isTacMapOpen()) return;
    const p = match.localActor.body.position;
    const dirX = -Math.sin(match.localActor.yaw) * Math.cos(match.localActor.pitch);
    const dirY = Math.sin(match.localActor.pitch);
    const dirZ = -Math.cos(match.localActor.yaw) * Math.cos(match.localActor.pitch);
    const hit = match.phys.raycast(p.x, match.localActor.eyeY, p.z, dirX, dirY, dirZ, 260, PHYS_GROUPS.rayWorldOnly);
    if (hit) {
      hud.tacMarker = { x: hit.point.x, z: hit.point.z };
      audio.uiClick('confirm');
    }
  }
  for (const actor of match.actors) {
    if (match.isLocalActor(actor)) {
      // Transport follows the flight line. Practice instead faces toward the
      // map centre from its spacious seeded spawn, avoiding a first frame into
      // a nearby wall and preserving the requested full-body TPS composition.
      const fdx = match.practice ? -actor.body.position.x : match.transportTo[0] - match.transportFrom[0];
      const fdz = match.practice ? -actor.body.position.z : match.transportTo[1] - match.transportFrom[1];
      const fl = Math.hypot(fdx, fdz) || 1;
      player.resetLook(Math.atan2(-fdx / fl, -fdz / fl), -0.12);
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
  const deathPipelineActors = new Set<number>();
  const firstFemaleBot = match.actors.find((actor) => match.isBotActor(actor) && females.includes(actor.name));
  const firstMaleBot = match.actors.find((actor) => match.isBotActor(actor) && !females.includes(actor.name));
  if (firstFemaleBot) deathPipelineActors.add(firstFemaleBot.id);
  if (firstMaleBot) deathPipelineActors.add(firstMaleBot.id);
  const rigs = new Map<number, CharacterRig>();
  for (const actor of match.actors) {
    const charRig = charFactory.create(actor.name, actor.accentColor, females.includes(actor.name), null, actor.skinId);
    // Keep one representative of each body archetype on the death pipeline
    // from loading onward. Opacity 1 remains visually opaque, while avoiding
    // transparent sorting overhead on every living actor.
    for (const material of [...charRig.baseMats, ...charRig.accentMats]) {
      material.transparent = deathPipelineActors.has(actor.id);
      material.opacity = 1;
      material.needsUpdate = true;
    }
    // QA metadata (read-only; used by the automated browser harness).
    charRig.group.userData.isCharacterRig = true;
    charRig.group.userData.isPlayerRig = match.isLocalActor(actor);
    charRig.prewarmDeath?.();
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

  // A restrained camera-side fill preserves the local TPS silhouette against
  // NeoCity's dark streets. It is a real inverse-square light (not an unlit
  // character shader), affects only the immediate player area, and is hidden
  // in FPS/spectator views.
  const characterFill = new THREE.PointLight(0xcfe0ff, 2.0, 4.8, 2);
  characterFill.visible = false;
  renderer.scene.add(characterFill);
  registerStartCleanup(generation, () => renderer.scene.remove(characterFill));

  // Viewmodel
  const viewmodel = new ViewModel(weaponFactory);
  viewmodel.group.visible = rig.mode === 'fps';
  renderer.scene.add(viewmodel.group);
  registerStartCleanup(generation, () => {
    renderer.scene.remove(viewmodel.group);
    viewmodel.dispose();
  });
  {
    const w0 = match.localActor?.inv.selectedWeapon;
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
  const rigPrewarmStates = [...rigs.values()].map((characterRig) => ({
    group: characterRig.group,
    visible: characterRig.group.visible,
    position: characterRig.group.position.clone(),
  }));
  try {
    const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
    const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.camera.quaternion);
    rigPrewarmStates.forEach(({ group }, index) => {
      group.visible = true;
      group.position.copy(rig.camera.position)
        .addScaledVector(cameraForward, 6 + Math.floor(index / 5) * 2)
        .addScaledVector(cameraRight, (index % 5 - 2) * 1.1);
    });
    viewmodel.group.visible = true;
    const prewarmObjects: Array<{
      object: THREE.Object3D;
      visible: boolean;
      scale: THREE.Vector3;
    }> = [];
    const prewarmedVfxVariants = new Set<string>();
    vfx.group.traverse((object) => {
      const renderable = object as THREE.Object3D & {
        isMesh?: boolean;
        isSprite?: boolean;
        isLine?: boolean;
        isInstancedMesh?: boolean;
        material?: THREE.Material | THREE.Material[];
      };
      if (!renderable.isMesh && !renderable.isSprite && !renderable.isLine) return;
      const material = Array.isArray(renderable.material) ? renderable.material[0] : renderable.material;
      if (!material) return;
      const variantKey = `${material.type}:${material.blending}:${renderable.isSprite ? 'sprite' : renderable.isInstancedMesh ? 'instanced' : 'mesh'}`;
      if (prewarmedVfxVariants.has(variantKey)) return;
      prewarmedVfxVariants.add(variantKey);
      prewarmObjects.push({ object, visible: object.visible, scale: object.scale.clone() });
      object.visible = true;
      object.scale.setScalar(0.001);
    });
    const vfxPosition = vfx.group.position.clone();
    const transportVisible = world.transportGroup.visible;
    const transportPosition = world.transportGroup.position.clone();
    vfx.group.position.copy(rig.camera.position).addScaledVector(cameraForward, 2);
    world.transportGroup.visible = true;
    world.transportGroup.position.copy(rig.camera.position).addScaledVector(cameraForward, 12);
    const deathMaterials = new Set<THREE.MeshStandardMaterial>();
    const representativeDeathRig = rigs.get(match.actors.find((actor) => match.isBotActor(actor))?.id ?? -1);
    if (representativeDeathRig) {
      const characterRig = representativeDeathRig;
      for (const material of [...characterRig.baseMats, ...characterRig.accentMats]) deathMaterials.add(material);
    }
    const deathStates = [...deathMaterials].map((material) => ({
      material,
      transparent: material.transparent,
      opacity: material.opacity,
    }));
    for (const { material } of deathStates) {
      material.transparent = true;
      material.opacity = 0;
      material.needsUpdate = true;
    }
    try {
      // Compile pooled impact/shield/elimination renderables and the death
      // transparency variant while the loading screen owns the frame.
      await renderer.renderer.compileAsync(renderer.scene, rig.camera);
      ensureCurrentStart(generation);
      renderer.renderer.render(renderer.scene, rig.camera);
    } finally {
      for (const { object, visible, scale } of prewarmObjects) {
        object.visible = visible;
        object.scale.copy(scale);
      }
      vfx.group.position.copy(vfxPosition);
      world.transportGroup.visible = transportVisible;
      world.transportGroup.position.copy(transportPosition);
      for (const { material, transparent, opacity } of deathStates) {
        material.transparent = transparent;
        material.opacity = opacity;
        material.needsUpdate = true;
      }
    }
    // Restore and compile the normal opaque gameplay variants last.
    await renderer.renderer.compileAsync(renderer.scene, rig.camera);
    ensureCurrentStart(generation);
    // Warm the shadow/depth program variants too — compileAsync only covers
    // the main pass, and the first shadow render of a skinned rig otherwise
    // stalls ~50 ms on the first FP→TPS flip.
    renderer.renderer.render(renderer.scene, rig.camera);
  } catch {
    /* parallel shader compile unsupported — runtime compile still works */
  } finally {
    for (const { group, visible, position } of rigPrewarmStates) {
      group.visible = visible;
      group.position.copy(position);
    }
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
    characterFill,
    player,
    mats: sharedMats,
    qaSceneCensus: QA_MODE ? buildQaSceneCensus(world.group) : '',
    qaGlassSpecs: QA_MODE
      ? match.combat.destructibleList()
        .flatMap((d) => d.type === 'glass' && d.geo.kind === 'box'
          ? [{
              id: d.id, stableId: d.stableId, x: d.geo.x, y: d.geo.y, z: d.geo.z,
              sx: d.geo.sx, sy: d.geo.sy, sz: d.geo.sz,
            }]
          : [])
      : [],
    qaGlassBreakFrames,
    worldConstructionMs,
    cleanup,
  };

  if (QA_MODE) {
    // Internal-browser shortcuts seed deterministic state while every action
    // under test (selection, click edge, firing/healing, spectating) still
    // travels through the normal controller and fixed-step pipeline.
    let qaAdsLatched = false;
    const setQaAds = (held: boolean) => {
      qaAdsLatched = held;
      window.dispatchEvent(new MouseEvent(held ? 'mousedown' : 'mouseup', { button: 2, bubbles: true }));
    };
    const placeQaSwimmerAtShore = (): boolean => {
      const p = match.localActor;
      if (!p) return false;
      const candidates = match.nav.nodes.flatMap((source) => {
        if (!source.water) return [];
        return source.edges
          .filter((edge) => edge.type === 'shore')
          .map((edge) => ({ source, target: match.nav.nodes[edge.to]! }));
      }).sort((a, b) => {
        const aDist = Math.hypot(a.target.x - a.source.x, a.target.z - a.source.z);
        const bDist = Math.hypot(b.target.x - b.source.x, b.target.z - b.source.z);
        return Math.abs(a.target.y - a.source.y) + aDist * 0.08
          - Math.abs(b.target.y - b.source.y) - bDist * 0.08;
      });
      for (const { source, target } of candidates) {
        const water = match.waterAt(source.x, source.y, source.z);
        if (!water) continue;
        const placement = match.phys.findClearSwimmingPlacement(
          source.x,
          water.surfaceY,
          source.z,
          p.body.body,
        );
        if (!placement) continue;
        p.body.teleport(placement.x, placement.y, placement.z);
        p.body.velocity.x = 0; p.body.velocity.y = 0; p.body.velocity.z = 0;
        p.state = 'swim';
        p.inWater = true;
        p.submerged = false;
        p.waterSurfaceY = water.surfaceY;
        p.peakFallSpeed = 0;
        player.resetLook(
          Math.atan2(-(target.x - source.x), -(target.z - source.z)),
          -0.08,
        );
        return true;
      }
      return false;
    };
    const onQaKey = (e: KeyboardEvent) => {
      const p = match.localActor;
      if (!p) return;
      if (e.code === 'F5') {
        const stress = (window as unknown as Record<string, unknown>).__xoStress;
        if (typeof stress === 'function') stress();
      } else if (e.code === 'F6') {
        const chest = match.chests
          .filter((c) => !c.opened)
          .sort((a, b) =>
            Math.hypot(a.x - p.body.position.x, a.z - p.body.position.z)
            - Math.hypot(b.x - p.body.position.x, b.z - p.body.position.z))[0];
        if (chest) {
          // Choose a same-floor interaction point with the most room behind
          // the player. A fixed +X offset frequently put the TPS boom inside
          // a facade, producing unusable chest recordings that did not
          // represent an approach a player would choose.
          const approaches = Array.from({ length: 8 }, (_, i) => {
            const angle = i * Math.PI / 4;
            const outwardX = Math.cos(angle);
            const outwardZ = Math.sin(angle);
            const x = chest.x + outwardX * 3.0;
            const z = chest.z + outwardZ * 3.0;
            const surface = match.phys.surfaceAt(x, z, chest.y + 1.8, 4);
            if (surface === null || Math.abs(surface - chest.y) > 1.2) return null;
            if (!match.chestHasLineOfSightFrom(x, surface + MOVE.eyeHeight, z, chest)) return null;
            const obstruction = match.phys.raycast(
              x, surface + 1.45, z, outwardX, 0, outwardZ, 5.2, PHYS_GROUPS.rayWorldOnly,
            );
            return { x, z, surface, clearance: obstruction?.dist ?? 5.2 };
          }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
            .sort((a, b) => b.clearance - a.clearance);
          const approach = approaches[0];
          const x = approach?.x ?? chest.x + 3.0;
          const z = approach?.z ?? chest.z;
          // Keep the browser harness on the chest's floor layer. Casting from
          // far above selected a roof in multi-storey NeoCity and made the
          // mandatory flicker recording stare at a wall instead of the chest.
          const surface = approach?.surface ?? match.phys.surfaceAt(x, z, chest.y + 1.8, 4) ?? chest.y;
          const placement = match.phys.findClearStandingPlacement(x, surface, z, p.body.body);
          if (!placement) return;
          p.body.teleport(placement.x, placement.y, placement.z);
          p.body.velocity.x = 0; p.body.velocity.y = 0; p.body.velocity.z = 0;
          if (p.state !== 'swim') p.state = 'air';
          player.resetLook(Math.atan2(-(chest.x - x), -(chest.z - z)), -0.08);
        }
      } else if (e.code === 'F7') {
        if (e.shiftKey) {
          placeQaSwimmerAtShore();
          return;
        }
        const water = match.mapDef.water[0];
        if (water) {
          // Stand just outside the nearest authored water edge and face the
          // surface for repeatable transparency/reflection QA.
          const x = (water.minX + water.maxX) * 0.5;
          const z = water.minZ - 3.2;
          const surface = match.phys.surfaceAt(x, z, water.surfaceY + 8, 30) ?? water.surfaceY;
          const placement = match.phys.findClearStandingPlacement(x, surface, z, p.body.body);
          if (!placement) return;
          p.body.teleport(placement.x, placement.y, placement.z);
          p.body.velocity.x = 0; p.body.velocity.y = 0; p.body.velocity.z = 0;
          if (p.state !== 'swim') p.state = 'air';
          player.resetLook(Math.PI, -0.18);
        }
      } else if (e.code === 'F8') {
        const def = WEAPONS.pistol;
        const result = p.inv.add({ kind: 'weapon', weaponId: 'pistol', rarity: 'common', ammoInMag: def.magSize });
        if (result.ok && result.slot !== undefined) {
          p.inv.ammo.light = Math.max(p.inv.ammo.light, 30);
          p.inv.select(result.slot);
          lastWeaponKey = null;
        }
      } else if (e.code === 'F9') {
        const result = p.inv.add({ kind: 'heal', itemId: 'medkit', count: 1 });
        p.shield = 0;
        p.applyDamage(45);
        if (result.ok && result.slot !== undefined) p.inv.select(result.slot);
      } else if (e.code === 'F10') {
        const result = p.inv.add({ kind: 'heal', itemId: 'shieldpot', count: 1 });
        p.shield = 0;
        if (result.ok && result.slot !== undefined) p.inv.select(result.slot);
      } else if (e.code === 'F11') {
        const def = WEAPONS.sniper;
        const result = p.inv.add({ kind: 'weapon', weaponId: 'sniper', rarity: 'rare', ammoInMag: def.magSize });
        if (result.ok && result.slot !== undefined) {
          p.inv.ammo.heavy = Math.max(p.inv.ammo.heavy, 12);
          p.inv.select(result.slot);
          lastWeaponKey = null;
        }
      } else if (e.code === 'F12') {
        // Chrome CUA cannot hold RMB across frames. This QA-only latch emits
        // the same DOM button events consumed by PlayerController so scope
        // engagement and teardown still exercise the real input path.
        setQaAds(!qaAdsLatched);
      } else if (e.code === 'End') {
        match.eliminateActor(p);
      }
    };
    window.addEventListener('keydown', onQaKey);
    live.cleanup.push(() => {
      if (qaAdsLatched) setQaAds(false);
      window.removeEventListener('keydown', onQaKey);
    });
  }

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
    else hud.banner(t('menu.practice'), 1.35);
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
  ending?.rig.resetAimState();
  ending?.renderer.setScopeActive(false);
  if (import.meta.env.DEV) {
    const qaWindow = window as unknown as Record<string, unknown>;
    for (const key of [
      '__xoRigs', '__xoAerial', '__xoState', '__xoTeleport', '__xoStress',
      '__xoGive', '__xoQaInput', '__xoStorm',
    ]) delete qaWindow[key];
    delete document.documentElement.dataset.xoQaTeleportRequest;
    delete document.documentElement.dataset.xoQaTeleportResult;
    delete document.documentElement.dataset.xoQaPerfResetRequest;
    delete document.documentElement.dataset.xoQaPerfResetResult;
    delete document.documentElement.dataset.xoQaPerfDetail;
    delete document.documentElement.dataset.xoQaPerfSpikes;
    delete document.documentElement.dataset.xoQaGpuDevice;
    delete document.documentElement.dataset.xoQaGpuSyncResult;
    delete document.documentElement.dataset.xoQaCensus;
    delete document.documentElement.dataset.xoQaWorld;
    delete document.documentElement.dataset.xoQaRuntime;
    document.getElementById('xo-qa-teleport-command')?.remove();
    document.getElementById('xo-qa-perf-command')?.remove();
    document.getElementById('xo-qa-gpu-sync-command')?.remove();
    lastQaTeleportRequest = '';
    lastQaPerfResetRequest = '';
    lastQaGpuSyncRequest = '';
  }
  for (const d of disposers) d();
  disposers.length = 0;
  if (ending) runCleanups(ending.cleanup);
  resultsShown = false;
  spectateTargetId = -1;
  wasSpectating = false;
  lastWeaponKey = null;
  paused = false;
  hud?.show(false);
  hud?.setInventoryOpen(false);
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
  hud.setInventoryOpen(false);
  paused = true;
  // World keeps simulating; only local input is suspended.
  live.player.enabled = false;
  live.player.releaseLock();
  menus.showPause();
}

function resumeFromPause(): void {
  menus.hidePause();
  if (!live) return;
  paused = false;
  live.player.enabled = true;
  live.player.requestLock();
}

function handlePauseOrSpectateExit(): void {
  if (hud.isInventoryOpen()) {
    hud.setInventoryOpen(false);
    if (live) {
      live.player.enabled = true;
      live.player.requestLock();
    }
    return;
  }
  if (live?.match.localActor?.alive === false && live.match.phase !== 'results') {
    menus.onQuitRequested();
    return;
  }
  if (paused) {
    resumeFromPause();
    return;
  }
  openPause();
}

function cycleSpectate(dir: number): void {
  const m = live?.match;
  if (!m || m.localActor?.alive !== false) return;
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
  rigs: Map<number, CharacterRig>,
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
    const isPlayer = e.actorId === match.localActor?.id;
    if (isPlayer && rig.mode === 'fps') {
      viewmodel.kick(WEAPON_KICK[e.weaponId] ?? 1);
      viewmodel.muzzlePulse(isPlayer ? 0.8 : 1.15);
    } else {
      const renderedMuzzle = rigs.get(e.actorId)?.muzzleWorld?.(
        presentationMuzzle,
        presentationMuzzleDirection,
      ) === true;
      vfx.muzzleFlash(
        renderedMuzzle ? presentationMuzzle.x : e.x,
        renderedMuzzle ? presentationMuzzle.y : e.y - 0.25,
        renderedMuzzle ? presentationMuzzle.z : e.z,
        renderedMuzzle ? presentationMuzzleDirection.x : e.dx,
        renderedMuzzle ? presentationMuzzleDirection.y : e.dy,
        renderedMuzzle ? presentationMuzzleDirection.z : e.dz,
        isPlayer ? 0.9 : 1.35,
        HEAVY_FLASH[e.weaponId] === true,
      );
    }
  });
  match.events.on('tracer', (e) => vfx.spawnTracer(e.x1, e.y1, e.z1, e.x2, e.y2, e.z2, e.color));
  match.events.on('impact', (e) => vfx.impactSparks(e.x, e.y, e.z, e.nx, e.ny, e.nz, e.material === 'metal' ? 10 : 6));
  match.events.on('glassBreak', (e) => vfx.glassShards(e.x, e.y, e.z));
  if (QA_MODE) match.events.on('glassBreak', () => {
    const time = performance.now();
    qaGlassBreakTimes.push(time);
    qaGlassBreakFrames.push({ time, presentMs: perfStats.lastPresentMs });
  });
  match.events.on('destructibleDestroyed', (e) => vfx.debrisBurst(e.x, e.y, e.z, 0xa07848));
  match.events.on('actorHit', (e) => {
    if (e.attackerId === match.localActor?.id) {
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
    if (e.targetId === match.localActor?.id) rig.addShake(Math.min(0.5, e.damage / 60));
  });
  match.events.on('shieldBroken', (e) => {
    const a = match.actors.find((x) => x.id === e.actorId);
    if (a) {
      vfx.shieldBreakBurst(a.body.position.x, a.body.position.y + 1.1, a.body.position.z);
      if (match.isLocalActor(a)) hud.caption(t('cap.shieldBreak'), true);
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
    if (killer && match.isLocalActor(killer) && victim) hud.elimination(`✕ ${victim.name}`);
    if (victim && match.isLocalActor(victim)) hud.banner(t('banner.eliminatedYou'), 4);
  });
  match.events.on('shotFired', (e) => {
    if (e.actorId === match.localActor?.id && !e.dry && match.localActor) {
      const a = match.localActor;
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
    if (e.actorId === match.localActor?.id && rig.mode === 'fps') viewmodel.punch();
  });
  match.events.on('meleeHit', (e) => {
    const target = match.actors.find((a) => a.id === e.targetId);
    if (target) audio.meleeHit(target.body.position.x, target.body.position.y + 0.3, target.body.position.z);
    if (e.attackerId === match.localActor?.id) {
      hud.hitmarker(e.headshot);
      rig.addShake(e.killed ? 0.22 : 0.08);
    }
    if (e.targetId === match.localActor?.id) rig.addShake(0.18);
  });
  match.events.on('land', (e) => {
    if (e.actorId === match.localActor?.id) rig.addShake(Math.min(0.4, e.impactSpeed / 70));
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
    const p = match.localActor;
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
    audio.setMusicState(didLocalActorWin(m) ? 'victory' : 'defeat');
  }
}

// ---------------------------------------------------------------------------
// Frame presentation
// ---------------------------------------------------------------------------

function present(dtReal: number): void {
  if (!live) return;
  const { match: m, renderer, world, vfx, rig, viewmodel, rigs, player, characterFill } = live;

  // Debug/QA introspection hook. Development-only because the related helpers
  // below can mutate match state and must not ship as a production backdoor.
  if (QA_MODE) {
    const qaPlayerPosition = m.localActor?.body.position;
    const qaPenetrations = m.localActor && qaPlayerPosition
      ? m.phys.characterPenetrationsAt(
        qaPlayerPosition.x,
        qaPlayerPosition.y,
        qaPlayerPosition.z,
        m.localActor.body.body,
      )
      : [];
    const qaMaxPenetration = qaPenetrations.reduce((max, hit) => Math.max(max, hit.depth), 0);
    const qaFeetY = qaPlayerPosition ? feetYFromBodyCenter(qaPlayerPosition.y) : null;
    const qaSupportY = qaPlayerPosition && qaFeetY !== null
      ? m.phys.surfaceAt(qaPlayerPosition.x, qaPlayerPosition.z, qaFeetY + 0.6, 1.5)
      : null;
    const qaSupportError = qaFeetY !== null && qaSupportY !== null ? qaFeetY - qaSupportY : null;
    const qaTerrainY = qaPlayerPosition
      ? m.phys.terrainSurfaceAt(qaPlayerPosition.x, qaPlayerPosition.z)
      : null;
    const qaTerrainDelta = qaFeetY !== null && qaTerrainY !== null ? qaFeetY - qaTerrainY : null;
    const qaTerrainSide = qaTerrainDelta === null
      ? 'none'
      : qaTerrainDelta < -0.08 ? 'below' : qaTerrainDelta > 0.18 ? 'above' : 'on';
    const qaCameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
    const qaCameraHit = m.phys.cameraCast(
      rig.camera.position.x,
      rig.camera.position.y,
      rig.camera.position.z,
      qaCameraForward.x,
      qaCameraForward.y,
      qaCameraForward.z,
      8,
      0.08,
    );
    const qaCameraForwardClearance = qaCameraHit?.dist ?? null;
    (window as unknown as Record<string, unknown>).__xoState = {
      map: m.mapDef.id,
      seed: m.seed,
      practiceStart: m.practiceStart,
      phase: m.phase,
      transportPos: {
        x: +m.transportPos.x.toFixed(3),
        y: +m.transportPos.y.toFixed(3),
        z: +m.transportPos.z.toFixed(3),
      },
      time: m.time,
      aliveCount: m.aliveCount,
      stormRadius: m.storm.radius,
      stormCenterX: m.storm.centerX,
      stormCenterZ: m.storm.centerZ,
      stormState: m.storm.state,
      stormOutside: m.localActor ? m.storm.distanceOutside(m.localActor.body.position.x, m.localActor.body.position.z) : null,
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
      playerSkin: getSettings().playerSkin,
      playerRigSkin: m.localActor ? rigs.get(m.localActor.id)?.group.userData.xoSkinId ?? null : null,
      worldConstructionMs: +live.worldConstructionMs.toFixed(2),
      destructibleCount: m.combat.destructibleCount(),
      aliveGlassCount: m.combat.aliveGlassCount(),
      destructibleRender: world.getDestructibleRenderStats(),
      glassSpecs: live.qaGlassSpecs,
      glassBreakTimes: qaGlassBreakTimes.slice(),
      glassBreakFrames: qaGlassBreakFrames.slice(),
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
      lootNear: m.localActor
        ? m.loot.items
            .map((it) => ({ it, d: Math.hypot(it.x - m.localActor!.body.position.x, it.z - m.localActor!.body.position.z) }))
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
      player: m.localActor
        ? {
            x: +m.localActor.body.position.x.toFixed(1),
            y: +m.localActor.body.position.y.toFixed(1),
            z: +m.localActor.body.position.z.toFixed(1),
            state: m.localActor.state,
            grounded: m.localActor.body.grounded,
            inWater: m.localActor.inWater,
            submerged: m.localActor.submerged,
            waterSurfaceY: Number.isFinite(m.localActor.waterSurfaceY)
              ? +m.localActor.waterSurfaceY.toFixed(4)
              : null,
            weapon: m.localActor.inv.selectedWeapon?.weaponId ?? null,
            ads: +m.localActor.wpn.adsAmount.toFixed(2),
            spread: +m.localActor.wpn.currentSpread.toFixed(4),
            bloom: +m.localActor.wpn.bloom.toFixed(4),
            shots: m.localActor.stats.shotsFired,
            health: Math.round(m.localActor.health),
            vy: +m.localActor.body.velocity.y.toFixed(2),
            jumpsUsed: m.localActor.jumpsUsed,
            coyote: +m.localActor.coyote.toFixed(2),
            jumpBuffered: +m.localActor.jumpBuffered.toFixed(2),
            penetrationCount: qaPenetrations.length,
            maxPenetration: +qaMaxPenetration.toFixed(4),
            supportError: qaSupportError === null ? null : +qaSupportError.toFixed(4),
            terrainY: qaTerrainY === null ? null : +qaTerrainY.toFixed(4),
            terrainDelta: qaTerrainDelta === null ? null : +qaTerrainDelta.toFixed(4),
            terrainSide: qaTerrainSide,
            cameraForwardClearance: qaCameraForwardClearance === null
              ? null
              : +qaCameraForwardClearance.toFixed(4),
            fov: Math.round(rig.camera.fov),
            anim: rigs.get(m.localActor.id)?.animName ?? null,
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
      const p = m.localActor?.body.position;
      const start = m.practiceStart;
      const data = document.documentElement.dataset;
      data.xoQaMap = m.mapDef.id;
      data.xoQaSeed = String(m.seed);
      data.xoQaPhase = m.phase;
      data.xoQaPosition = p ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : '';
      data.xoQaLook = m.localActor
        ? `${m.localActor.yaw.toFixed(2)},${m.localActor.pitch.toFixed(2)},${rig.mode}`
        : '';
      data.xoQaMovement = m.localActor
        ? `${m.localActor.state}|${rigs.get(m.localActor.id)?.animName ?? 'none'}|hs=${Math.hypot(m.localActor.body.velocity.x, m.localActor.body.velocity.z).toFixed(2)}|vx=${m.localActor.body.velocity.x.toFixed(2)}|vy=${m.localActor.body.velocity.y.toFixed(2)}|vz=${m.localActor.body.velocity.z.toFixed(2)}|jumps=${m.localActor.jumpsUsed}|wallChains=${m.localActor.wallrunChains}|wallLanded=${m.localActor.wallrunLanded ? 1 : 0}|dash=${m.localActor.dashTimer.toFixed(2)}`
        : '';
      data.xoQaWater = m.localActor
        ? `in=${m.localActor.inWater ? 1 : 0}|submerged=${m.localActor.submerged ? 1 : 0}|surface=${Number.isFinite(m.localActor.waterSurfaceY) ? m.localActor.waterSurfaceY.toFixed(4) : 'none'}`
        : 'none';
      data.xoQaCollision = m.localActor
        ? `count=${qaPenetrations.length}|depth=${qaMaxPenetration.toFixed(4)}|support=${qaSupportError?.toFixed(4) ?? 'none'}|grounded=${m.localActor.body.grounded ? 1 : 0}`
        : 'none';
      data.xoQaWorld = m.localActor
        ? `terrain=${qaTerrainY?.toFixed(4) ?? 'none'}|delta=${qaTerrainDelta?.toFixed(4) ?? 'none'}|side=${qaTerrainSide}|view=${qaCameraForwardClearance?.toFixed(4) ?? 'clear'}`
        : 'none';
      data.xoQaStart = start
        ? `${start.poi}|${start.x.toFixed(1)},${start.y.toFixed(1)},${start.z.toFixed(1)}`
        : '';
      const nearestChest = m.localActor
        ? m.chests
          .filter((chest) => !chest.opened)
          .sort((a, b) =>
            Math.hypot(a.x - m.localActor!.body.position.x, a.z - m.localActor!.body.position.z)
            - Math.hypot(b.x - m.localActor!.body.position.x, b.z - m.localActor!.body.position.z))[0]
        : undefined;
      data.xoQaChest = nearestChest
        ? `${nearestChest.x.toFixed(1)},${nearestChest.y.toFixed(1)},${nearestChest.z.toFixed(1)}|open=0`
        : 'none';
      data.xoQaPlayer = m.localActor
        ? `${m.localActor.inv.selectedWeapon?.weaponId ?? m.localActor.inv.selectedItem?.kind ?? 'empty'}|shots=${m.localActor.stats.shotsFired}|hp=${Math.round(m.localActor.health)}|shield=${Math.round(m.localActor.shield)}|heal=${m.localActor.healing?.itemId ?? 'none'}`
        : 'none';
      data.xoQaPerf = `${framePercentile(0.95).toFixed(1)},${framePercentile(0.99).toFixed(1)},${worstFrameMs.toFixed(1)}`;
      data.xoQaPerfDetail = `frames=${framesTotal}|gt33=${spikes33}|gt50=${spikes50}`;
      data.xoQaPerfSpikes = JSON.stringify(recentSpikes.slice(-8));
      data.xoQaGpuDevice = renderer.gpuDeviceLabel();
      data.xoQaCensus = live.qaSceneCensus;
      data.xoQaRuntime = qaRuntimeIssues.length === 0
        ? 'count=0'
        : `count=${qaRuntimeIssues.length}|last=${qaRuntimeIssues.at(-1)}`;
      data.xoQaRender = `${renderer.renderer.info.render.calls},${renderer.renderer.info.render.triangles}|sim=${perfStats.simMs.toFixed(2)}|present=${perfStats.presentMs.toFixed(2)}`;
    }
  }

  // QA-only teleport hook (?qa=1) for screenshot navigation.
  if (QA_MODE) {
    const performQaTeleport = (
      x: number,
      z: number,
      yaw = 0,
      refY?: number,
      pitch = -0.12,
      mode: 'standing' | 'swim' = 'standing',
    ): boolean => {
      const p = m.localActor;
      if (!p || !p.alive) return false;
      if (mode === 'swim') {
        const water = m.mapDef.water.find((candidate) => (
          x >= candidate.minX && x <= candidate.maxX
          && z >= candidate.minZ && z <= candidate.maxZ
        ));
        if (!water) return false;
        const placement = m.phys.findClearSwimmingPlacement(x, water.surfaceY, z, p.body.body);
        if (!placement) return false;
        p.body.teleport(placement.x, placement.y, placement.z);
        p.body.velocity.x = 0; p.body.velocity.y = 0; p.body.velocity.z = 0;
        p.state = 'swim';
        p.inWater = true;
        p.submerged = false;
        p.waterSurfaceY = water.surfaceY;
        p.peakFallSpeed = 0;
        live?.player.resetLook(yaw, THREE.MathUtils.clamp(pitch, -1.25, 1.25));
        return true;
      }
      // Snap to the surface so the capsule never spawns inside terrain.
      // Optional refY anchors the downward query near a known height
      // (e.g. a loot item) instead of landing on the highest roof/canopy.
      const anchored = typeof refY === 'number';
      const surf = anchored ? m.phys.surfaceAt(x, z, refY + 2.5, 80) : m.phys.surfaceAt(x, z, 400, 500);
      // Anchors are a selection hint, not a synthetic floor. Failing closed
      // here prevents a stale/incorrect QA reference height from placing the
      // actor below a one-sided terrain heightfield.
      if (surf === null) return false;
      const placement = m.phys.findClearStandingPlacement(x, surf, z, p.body.body);
      if (!placement) return false;
      p.body.teleport(placement.x, placement.y, placement.z);
      p.body.velocity.x = 0;
      p.body.velocity.y = 0;
      p.body.velocity.z = 0;
      p.state = 'air';
      p.inWater = false;
      p.submerged = false;
      live?.player.resetLook(yaw, THREE.MathUtils.clamp(pitch, -1.25, 1.25));
      return true;
    };
    (window as unknown as Record<string, unknown>).__xoTeleport = performQaTeleport;

    // The headed Codex browser runs evaluation in an isolated JS world, so
    // window expandos and direct dataset writes are intentionally unavailable.
    // A normal off-screen input can still be filled through browser semantics;
    // accept its nonce-tagged JSON and mirror a small result so landmark QA can
    // target roads, stairs and façades instead of random Practice spawns. This
    // bridge exists only in DEV + ?qa=1.
    const qaData = document.documentElement.dataset;
    qaData.xoQaTeleportRequest ??= '';
    qaData.xoQaTeleportResult ??= '';
    let qaTeleportInput = document.getElementById('xo-qa-teleport-command') as HTMLInputElement | null;
    if (!qaTeleportInput) {
      qaTeleportInput = document.createElement('input');
      qaTeleportInput.id = 'xo-qa-teleport-command';
      qaTeleportInput.type = 'text';
      qaTeleportInput.tabIndex = -1;
      qaTeleportInput.setAttribute('aria-hidden', 'true');
      Object.assign(qaTeleportInput.style, {
        position: 'fixed', left: '1px', top: '1px', width: '1px', height: '1px',
        opacity: '0', pointerEvents: 'none', zIndex: '-1',
      });
      document.body.appendChild(qaTeleportInput);
    }
    let qaPerfInput = document.getElementById('xo-qa-perf-command') as HTMLInputElement | null;
    if (!qaPerfInput) {
      qaPerfInput = document.createElement('input');
      qaPerfInput.id = 'xo-qa-perf-command';
      qaPerfInput.type = 'text';
      qaPerfInput.tabIndex = -1;
      qaPerfInput.setAttribute('aria-hidden', 'true');
      Object.assign(qaPerfInput.style, {
        position: 'fixed', left: '1px', top: '1px', width: '1px', height: '1px',
        opacity: '0', pointerEvents: 'none', zIndex: '-1',
      });
      document.body.appendChild(qaPerfInput);
    }
    let qaGpuSyncInput = document.getElementById('xo-qa-gpu-sync-command') as HTMLInputElement | null;
    if (!qaGpuSyncInput) {
      qaGpuSyncInput = document.createElement('input');
      qaGpuSyncInput.id = 'xo-qa-gpu-sync-command';
      qaGpuSyncInput.type = 'text';
      qaGpuSyncInput.tabIndex = -1;
      qaGpuSyncInput.setAttribute('aria-hidden', 'true');
      Object.assign(qaGpuSyncInput.style, {
        position: 'fixed', left: '1px', top: '1px', width: '1px', height: '1px',
        opacity: '0', pointerEvents: 'none', zIndex: '-1',
      });
      document.body.appendChild(qaGpuSyncInput);
    }
    const gpuSyncRequest = qaGpuSyncInput.value;
    if (gpuSyncRequest && gpuSyncRequest !== lastQaGpuSyncRequest) {
      lastQaGpuSyncRequest = gpuSyncRequest;
      qaGpuSyncInput.value = '';
      const ms = renderer.measureSynchronousFrame();
      qaData.xoQaGpuSyncResult = JSON.stringify({ nonce: gpuSyncRequest, ms: +ms.toFixed(2) });
    }
    const perfResetRequest = qaPerfInput.value || qaData.xoQaPerfResetRequest || '';
    if (perfResetRequest && perfResetRequest !== lastQaPerfResetRequest) {
      lastQaPerfResetRequest = perfResetRequest;
      qaPerfInput.value = '';
      resetPerfStats();
      qaData.xoQaPerfResetResult = perfResetRequest;
    }
    const request = qaTeleportInput.value || qaData.xoQaTeleportRequest;
    if (request && request !== lastQaTeleportRequest) {
      lastQaTeleportRequest = request;
      qaTeleportInput.value = '';
      let nonce = '';
      let ok = false;
      try {
        const parsed = JSON.parse(request) as {
          nonce?: unknown;
          x?: unknown;
          z?: unknown;
          yaw?: unknown;
          refY?: unknown;
          pitch?: unknown;
          mode?: unknown;
        };
        nonce = typeof parsed.nonce === 'string' ? parsed.nonce : '';
        const x = Number(parsed.x);
        const z = Number(parsed.z);
        const yaw = parsed.yaw === undefined ? 0 : Number(parsed.yaw);
        const refY = parsed.refY === undefined ? undefined : Number(parsed.refY);
        const pitch = parsed.pitch === undefined ? -0.12 : Number(parsed.pitch);
        const mode = parsed.mode === 'swim' ? 'swim' : parsed.mode === undefined ? 'standing' : null;
        if (nonce && Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(yaw)
          && Number.isFinite(pitch) && mode !== null
          && (refY === undefined || Number.isFinite(refY))) {
          ok = performQaTeleport(x, z, yaw, refY, pitch, mode);
        }
      } catch {
        // Invalid QA commands fail closed and are acknowledged as unsuccessful.
      }
      const resolved = ok && m.localActor
        ? {
            x: +m.localActor.body.position.x.toFixed(4),
            y: +m.localActor.body.position.y.toFixed(4),
            z: +m.localActor.body.position.z.toFixed(4),
          }
        : null;
      qaData.xoQaTeleportResult = JSON.stringify({ nonce, ok, resolved });
    }
    // QA stress hook: ring all living bots tightly around the player to
    // force maximum concurrent AI/combat/VFX load. Dev builds only.
    (window as unknown as Record<string, unknown>).__xoStress = () => {
      const p = m.localActor;
      if (!p) return {
        ok: false, expected: 0, placed: 0, rejected: 0, placedIds: [], rejectedIds: [],
      };
      p.deployed = true;
      p.state = p.body.grounded ? 'ground' : 'air';
      p.body.velocity.x = 0; p.body.velocity.y = 0; p.body.velocity.z = 0;
      const alive = m.actors.filter((a) => a.alive && !m.isLocalActor(a));
      const placedIds: number[] = [];
      const rejectedIds: number[] = [];
      alive.forEach((a, i) => {
        // Put the first opponent in the player's current view and spread the
        // rest around a wider ring. Probe near the player's floor layer so a
        // city stress test does not silently place combatants on rooftops.
        const ang = i === 0
          ? Math.atan2(-Math.cos(p.yaw), -Math.sin(p.yaw))
          : (i / Math.max(1, alive.length - 1)) * Math.PI * 2;
        const radius = i === 0 ? 10 : 42;
        const x = p.body.position.x + Math.cos(ang) * radius;
        const z = p.body.position.z + Math.sin(ang) * radius;
        const surf = m.phys.surfaceAt(x, z, p.body.position.y + 5, 14);
        const floorY = surf ?? feetYFromBodyCenter(p.body.position.y);
        const placement = m.phys.findClearStandingPlacement(x, floorY, z, a.body.body);
        if (!placement) {
          rejectedIds.push(a.id);
          return;
        }
        a.body.teleport(placement.x, placement.y, placement.z);
        placedIds.push(a.id);
        a.body.velocity.x = 0; a.body.velocity.y = 0; a.body.velocity.z = 0;
        a.deployed = true;
        a.state = 'air';
        if (!a.inv.slots.some((slot) => slot?.kind === 'weapon')) {
          const def = WEAPONS.ar;
          const result = a.inv.add({
            kind: 'weapon', weaponId: 'ar', rarity: 'rare', ammoInMag: def.magSize,
          });
          if (result.ok && result.slot !== undefined) a.inv.select(result.slot);
          a.inv.ammo[def.ammoType] = Math.max(a.inv.ammo[def.ammoType], def.reserveMax);
        }
      });
      return {
        ok: rejectedIds.length === 0 && placedIds.length === alive.length,
        expected: alive.length,
        placed: placedIds.length,
        rejected: rejectedIds.length,
        placedIds,
        rejectedIds,
      };
    };
    // QA helper: grant + equip a weapon by id ('pistol'|'smg'|'ar'|
    // 'shotgun'|'sniper', optional rarity). Dev/QA builds only.
    (window as unknown as Record<string, unknown>).__xoGive = (weaponId: string, rarity?: string) => {
      const p = m.localActor;
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
    // (browser automation cannot engage pointer lock). Press and held remain
    // independent so automation cannot conceal a lost short-click edge.
    (window as unknown as Record<string, unknown>).__xoQaInput = (
      o: { firePressed?: boolean; fireHeld?: boolean; adsHeld?: boolean } | null,
    ) => {
      m.qaInput =
        o && (o.firePressed || o.fireHeld || o.adsHeld)
          ? { ...o }
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

  const spectating = !m.localActor?.alive && m.phase !== 'results';
  const presentationAlpha = THREE.MathUtils.clamp(accumulator / SIM.fixedDt, 0, 1);
  presentationTransportPos.set(
    THREE.MathUtils.lerp(m.previousTransportPos.x, m.transportPos.x, presentationAlpha),
    THREE.MathUtils.lerp(m.previousTransportPos.y, m.transportPos.y, presentationAlpha),
    THREE.MathUtils.lerp(m.previousTransportPos.z, m.transportPos.z, presentationAlpha),
  );
  if (spectating && !wasSpectating) {
    // Death can occur while pause, map or inventory owns input. Spectator
    // controls are a new interaction state, so close every overlay and
    // explicitly re-enable its keyboard-only controls before showing it.
    paused = false;
    menus.hidePause();
    hud.setInventoryOpen(false);
    if (hud.isTacMapOpen()) hud.toggleTacMap(false);
    player.enabled = true;
    player.setSpectatorMode(true);
    player.releaseLock();
    rig.resetAimState();
  } else if (!spectating && wasSpectating) {
    player.setSpectatorMode(false);
    rig.endSpectate();
  }
  wasSpectating = spectating;
  const playerAboard = !!m.localActor && !m.localActor.deployed;
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
      rig.updateSpectate(target, dtReal, m.phys);
      hud.showSpectate(target.name);
    } else {
      // Keep the explicit exit action reachable even after the final target
      // disappears (including solo practice QA).
      hud.showSpectate(t('hud.spectateNoTarget'));
      rig.resetAimState();
      const fallback = new THREE.Vector3(0, 65, 35);
      rig.camera.position.lerp(fallback, 1 - Math.exp(-dtReal * 4));
      rig.camera.lookAt(0, 0, 0);
    }
  } else if (inTransport && m.localActor) {
    const slot = slotOf(m.localActor);
    rig.updateTransport(presentationTransportPos, slot, m.localActor.yaw, m.localActor.pitch, now() / 1000, dtReal);
    hud.hideSpectate();
  } else if (m.localActor) {
    if (wasInTransport) {
      rig.beginGameplayBlend();
    }
    rig.update(m.localActor, dtReal, m.phys, {});
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
    if (m.isLocalActor(a) && rig.mode === 'fps' && a.alive && !spectating) {
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
          presentationTransportPos.x + slot.x,
          presentationTransportPos.y - MATCH.transportHangOffset + slot.y,
          presentationTransportPos.z + slot.z,
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

  if (!spectating && rig.mode === 'tps' && m.localActor?.alive) {
    const p = m.localActor.body.position;
    const towardCamera = presentationFillDirection.set(
      rig.camera.position.x - p.x,
      0,
      rig.camera.position.z - p.z,
    ).normalize();
    characterFill.position.set(
      p.x + towardCamera.x * 1.5,
      feetYFromBodyCenter(p.y) + 1.65,
      p.z + towardCamera.z * 1.5,
    );
    characterFill.visible = true;
  } else {
    characterFill.visible = false;
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
  if (m.localActor?.alive && rig.mode === 'fps' && !inTransport && !rig.scoped) {
    const speed = Math.hypot(m.localActor.body.velocity.x, m.localActor.body.velocity.z);
    viewmodel.update(m.localActor, dtReal, player.lookDxSmooth(), player.lookDySmooth(), speed);
    viewmodel.group.visible = true;
  } else {
    viewmodel.update(null, dtReal, 0, 0, 0);
    viewmodel.group.visible = false;
  }
  if (QA_HERO_MODE) viewmodel.group.visible = false;

  world.setViewPos(rig.camera.position);
  world.update(dtReal, m, { position: presentationTransportPos });
  vfx.update(dtReal, rig.camera.position);

  {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
    AudioEngine.setListener(rig.camera.position.x, rig.camera.position.y, rig.camera.position.z, fwd.x, fwd.z);
    const eyeUnder = world.isEyeUnderwater(rig.camera.position);
    audio.setEnvironmentState(eyeUnder ? 'underwater' : 'open');
  }
  renderer.followSunTarget(new THREE.Vector3(rig.camera.position.x, 0, rig.camera.position.z));
  renderer.followViewer(rig.camera.position);

  hud.syncPlayerState(m, dtReal);
  hud.drawMinimap(m, () => hud.minimapContext(), dtReal);
  if (hud.isTacMapOpen()) hud.drawTacMap(m);
  {
    const info = !spectating && m.localActor?.alive && !paused && !hud.isTacMapOpen() && !hud.isInventoryOpen()
      ? findInteractInfo(m)
      : null;
    hud.interactPrompt(info && info.prompt ? info.prompt : null);
    hud.showLootPanel(info?.loot ?? null);
  }

  if (m.phase === 'results' && !resultsShown) {
    rig.resetAimState();
    renderer.setScopeActive(false);
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
  const p = m.localActor;
  if (!p) return null;
  const chest = m.nearestInteractableChest(p);
  if (chest) {
    const label =
      chest.kind === 'vault'
        ? t('interact.openVault')
        : chest.kind === 'elite'
          ? t('interact.openElite')
          : t('interact.openChest');
    return { prompt: label, loot: null };
  }
  // Use the simulation's exact resolver so the card always describes the
  // same closest item E will pick up, including stable ties in loot piles.
  const item = m.nearestInteractableItem(p, 4);
  if (!item) return null;

  const invFull = item.kind === 'weapon' && p.inv.slots.every((s) => s !== null);
  if (item.kind === 'weapon' && item.weapon) {
    const def = WEAPONS[item.weapon.weaponId];
    const rarityText = t(`rarity.${item.weapon.rarity}` as never);
    return {
      prompt: '',
      loot: {
        iconId: item.weapon.weaponId,
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
        iconId: item.heal.itemId,
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
  const p = m.localActor;
  const won = didLocalActorWin(m);
  hud.show(false);
  live?.player.releaseLock();
  audio.setMusicState(won ? 'victory' : 'defeat');
  audio.victoryFanfare(won);
  menus.showResults({
    won,
    winnerName: m.winnerView?.kind === 'team'
      ? t('results.teamName', { n: m.winnerView.teamId + 1 })
      : m.winnerView?.displayName ?? '—',
    placement: p?.placement ?? m.actors.length,
    kills: p?.stats.kills ?? 0,
    damage: p?.stats.damageDealt ?? 0,
    accuracy: p && p.stats.shotsFired > 0 ? p.stats.shotsHit / p.stats.shotsFired : 0,
    headshots: p?.stats.headshots ?? 0,
    survivalTime: p?.stats.survivalTime ?? 0,
  });
}

function didLocalActorWin(match: Match): boolean {
  if (match.localActorId === null || match.winnerView === null) return false;
  return match.winnerView.kind === 'team'
    ? match.localTeamId === match.winnerView.teamId
    : match.localActorId === match.winnerView.actorId;
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
