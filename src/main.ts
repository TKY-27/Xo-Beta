/**
 * Xo Beta — main entry point. Boot flow: loading → main menu → play flow →
 * live match loop (fixed-step simulation + rendered presentation) → results.
 */

import * as THREE from 'three';
import { loadMap, MAP_LIST, ensureWorldReady } from './world';
import { normalizeMapForMatch } from './world/builder';
import type { MapDef } from './world/types';
import { Match } from './sim/match';
import type { ActorView, GameStateView } from './sim/gameStateView';
import { GROUPS as PHYS_GROUPS } from './physics/physics';
import { BotController } from './ai/bot';
import { MATCH, MOVE, RARITY_CSS, SIM, WEAPONS } from './core/balance';
import type { WeaponId, Rarity } from './core/balance';
import { feetYFromBodyCenter } from './sim/movement';
import type { WeaponInstance } from './sim/inventory';
import type { Actor } from './sim/actor';
import { emptyCommand, type InputCommand } from './sim/input';
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
import { Hud, Menus, type PlaySelection, type LootPanelInfo, type OnlineHudState } from './ui/ui';
import { OnlineLobbyUi } from './ui/onlineLobby';
import { PrivateRoomController } from './net/privateRoom';
import type { OnlineRoomMatchContext, SignalingFactory } from './net/privateRoom';
import type { GameNetworkMetrics } from './net/gameConnection';
import {
  OnlineMatchCoordinator,
  HOST_DISCONNECT_GRACE_MS,
  ONLINE_FIXED_DT,
  type GuestReplicaFactoryInput,
  type HostSessionFactoryInput,
  type OnlineMatchCoordinatorState,
  type OnlineMatchEndReason,
} from './net/onlineMatchCoordinator';
import {
  HostAuthoritativeMatchSession,
  type AuthoritativeMatchEvent,
} from './net/hostMatchSession';
import { HostLagCompensation } from './net/lagCompensation';
import {
  ClientMovementPredictionWorld,
  createClientMovementPredictionState,
  type ClientMovementPredictionState,
} from './net/clientMovementPrediction';
import { ClientReplica } from './net/clientReplica';
import type { MatchStartPayload, StartBarrierStatus } from './net/matchStart';
import { t, initLang } from './core/i18n';
import { EventBus } from './core/events';
import { GamepadInput } from './player/gamepad';
import { AudioEngine, attachAudio } from './audio/audio';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const $canvas = (): HTMLCanvasElement => document.getElementById('game-canvas') as HTMLCanvasElement;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface LivePresentation {
  generation: number;
  mapDef: MapDef;
  renderer: GameRenderer;
  world: WorldView;
  vfx: VfxSystem;
  rig: CameraRig;
  viewmodel: ViewModel;
  rigs: Map<number, CharacterRig>;
  characterFill: THREE.PointLight;
  player: PlayerController;
  weaponFactory: WeaponModelFactory;
  mats: MaterialLibrary;
  qaSceneCensus: string;
  qaGlassSpecs: Array<{ id: number; stableId: string; x: number; y: number; z: number; sx: number; sy: number; sz: number }>;
  qaGlassBreakFrames: Array<{ time: number; presentMs: number }>;
  worldConstructionMs: number;
  cleanup: Array<() => void>;
  onlineContext: OnlineRoomMatchContext | null;
  onlineMetrics: Map<string, GameNetworkMetrics>;
}

interface MatchLiveGame extends LivePresentation {
  kind: 'match';
  match: Match;
  coordinator: OnlineMatchCoordinator<ClientMovementPredictionState> | null;
}

interface ReplicaLiveGame extends LivePresentation {
  kind: 'replica';
  coordinator: OnlineMatchCoordinator<ClientMovementPredictionState>;
  replica: ClientReplica<ClientMovementPredictionState>;
  predictionWorld: ClientMovementPredictionWorld;
  payload: MatchStartPayload;
  localActorId: number;
  view: GameStateView | null;
  worldInitialized: boolean;
  lastRigWeaponKeys: Map<number, string>;
  nextPredictedShotAtMs: number;
}

type LiveGame = MatchLiveGame | ReplicaLiveGame;

interface PreparedGuestRuntime {
  readonly generation: number;
  readonly input: GuestReplicaFactoryInput;
  readonly presentation: LivePresentation;
  readonly predictionWorld: ClientMovementPredictionWorld;
}

let live: LiveGame | null = null;
let hud: Hud;
let audio: AudioEngine;
let menus: Menus;
const disposers: Array<() => void> = [];
let matchGeneration = 0;
let pendingStart: { generation: number; cleanup: Array<() => void> } | null = null;
let pendingGuestRuntime: PreparedGuestRuntime | null = null;
let activeOnlineCoordinator: OnlineMatchCoordinator<ClientMovementPredictionState> | null = null;
const presentationMuzzle = new THREE.Vector3();
const presentationMuzzleDirection = new THREE.Vector3();
const presentationFillDirection = new THREE.Vector3();

function livePhase(game: LiveGame | null = live): GameStateView['phase'] | null {
  if (!game) return null;
  return game.kind === 'match' ? game.match.phase : game.view?.phase ?? null;
}

function liveLocalAlive(game: LiveGame | null = live): boolean {
  if (!game) return false;
  return game.kind === 'match'
    ? game.match.localActor?.alive === true
    : game.view?.actors.find((actor) => actor.id === game.localActorId)?.alive === true;
}

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
if (QA_MODE) document.documentElement.dataset.xoQa = '1';
if (QA_HERO_MODE) document.documentElement.dataset.xoQaHero = '1';

interface QaWaterView {
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
  time?: number;
}

/**
 * Freeze only presentation inputs for repeatable renderer evidence. This is
 * development-only and deliberately leaves simulation, collision, and water
 * physics untouched.
 */
function applyQaWaterView(rig: CameraRig, world: WorldView, applyTime: boolean): void {
  if (!QA_MODE) return;
  const view = (window as unknown as { __xoWaterQaView?: QaWaterView }).__xoWaterQaView;
  if (!view) return;
  const values = [...view.position, ...view.target];
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) return;
  if (!applyTime) {
    rig.camera.position.fromArray(view.position);
    rig.camera.lookAt(...view.target);
    if (view.fov !== undefined && Number.isFinite(view.fov)) {
      rig.camera.fov = THREE.MathUtils.clamp(view.fov, 35, 110);
      rig.camera.updateProjectionMatrix();
    }
  } else if (view.time !== undefined && Number.isFinite(view.time)) {
    world.animateWater(Math.max(0, view.time));
  }
}

function qaRequestedSeed(): number | null {
  if (!QA_MODE) return null;
  const raw = QA_PARAMS.get('seed');
  if (raw === null || !/^\d{1,9}$/.test(raw)) return null;
  const seed = Number(raw);
  return Number.isSafeInteger(seed) ? seed : null;
}

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
  let onlineUi: OnlineLobbyUi | null = null;
  let activeOnlineContextKey = '';
  const onlineMetrics = new Map<string, GameNetworkMetrics>();
  const onlineContextKey = (context: OnlineRoomMatchContext): string => (
    `${context.role}:${context.localParticipantId}:${context.matchSessionBinding}`
  );
  const showMainMenuAfterOnline = (reason: OnlineMatchEndReason | null): void => {
    const coordinator = activeOnlineCoordinator;
    activeOnlineCoordinator = null;
    activeOnlineContextKey = '';
    coordinator?.dispose();
    teardownMatch(false);
    void onlineRoom.leaveRoom();
    menus.showMainMenu();
    audio.setMusicState('lobby');
    audio.startAmbience('night', true);
    lobby.start($canvas(), characterFactory, weaponFactory);
    const cancel = document.getElementById('btn-online-start-cancel');
    cancel?.classList.add('hidden');
    if (reason === 'host-disconnected') {
      $('loading-fill').style.width = '100%';
      $('loading-status').textContent = t('hud.hostDisconnected');
      $('loading-screen').classList.remove('hidden');
      window.setTimeout(() => $('loading-screen').classList.add('hidden'), 1800);
    } else if (reason === 'protocol-error') {
      $('loading-status').textContent = t('online.protocolError');
      $('loading-screen').classList.add('hidden');
    } else if (reason === 'cancelled') {
      $('loading-status').textContent = t('online.startCancelled');
      $('loading-screen').classList.add('hidden');
    } else {
      $('loading-screen').classList.add('hidden');
    }
  };
  const ensureOnlineCoordinator = (provided?: OnlineRoomMatchContext): OnlineMatchCoordinator<ClientMovementPredictionState> => {
    const context = provided ?? onlineRoom.matchContext;
    if (!context) throw new Error('Online room match context is unavailable');
    const key = onlineContextKey(context);
    if (activeOnlineCoordinator && activeOnlineContextKey === key
      && activeOnlineCoordinator.state !== 'disposed'
      && activeOnlineCoordinator.state !== 'ended'
      && activeOnlineCoordinator.state !== 'failed') {
      return activeOnlineCoordinator;
    }
    activeOnlineCoordinator?.dispose();
    activeOnlineCoordinator = null;
    activeOnlineContextKey = key;
    onlineMetrics.clear();
    const coordinatorRef: { current: OnlineMatchCoordinator<ClientMovementPredictionState> | null } = { current: null };
    const requireCoordinator = (): OnlineMatchCoordinator<ClientMovementPredictionState> => {
      if (!coordinatorRef.current) throw new Error('Online coordinator is not initialized');
      return coordinatorRef.current;
    };
    const coordinator = new OnlineMatchCoordinator<ClientMovementPredictionState>({
      context,
      room: onlineRoom,
      resolveMap: (mapId) => normalizeMapForMatch(loadMap(mapId).def),
      createHostSession: (input) => prepareOnlineHostSession(
        input,
        requireCoordinator(),
        context,
        onlineMetrics,
        sharedMats,
        sharedProps,
        characterFactory,
        weaponFactory,
        lobby,
      ),
      loadGuest: (input) => prepareOnlineGuestRuntime(
        input,
        requireCoordinator(),
        context,
        onlineMetrics,
        sharedMats,
        sharedProps,
        characterFactory,
        weaponFactory,
        lobby,
      ),
      createGuestReplica: (input) => activatePreparedGuestReplica(input, requireCoordinator()),
      sampleLocalInput: () => {
        const game = live;
        if (!game || game.kind !== 'replica') return emptyCommand();
        const adsAmount = game.view?.localMovement?.actorId === game.localActorId
          ? game.view.localMovement.adsAmount
          : 0;
        return game.player.sampleCommand(adsAmount, ONLINE_FIXED_DT);
      },
      onLocalInputSubmitted: predictGuestFirePresentation,
      onStateChange: (state) => {
        if (import.meta.env.DEV) document.documentElement.dataset.xoOnlineState = state;
        if (state === 'reconnecting') hud.syncOnlineState({ connection: 'reconnecting' });
        if (state === 'waiting-ready' && context.role === 'guest') {
          $('loading-status').textContent = t('online.loadingGuest');
        }
      },
      onBarrierStatus: (status) => updateOnlineBarrierStatus(status),
      onRuntimeReady: (role) => {
        installOnlineMetricPolling(onlineRoom, context, onlineMetrics);
        if (role === 'guest') $('loading-status').textContent = t('online.startCountdown');
        startLoop();
      },
      onActivated: (role, payload) => activateOnlinePresentation(role, payload),
      onAuthoritativeEvent: presentOnlineAuthoritativeEvent,
      onPresenceNotice: (kind, displayName) => hud.showPresenceNotice(kind, displayName),
      onReconnectResult: (accepted) => {
        hud.banner(t(accepted ? 'online.reconnectAccepted' : 'online.reconnectRejected'), 3.2);
      },
      onEnd: (reason) => {
        if (activeOnlineCoordinator !== coordinatorRef.current) return;
        showMainMenuAfterOnline(reason);
      },
      onProtocolError: (peerId, error) => {
        console.warn(`online protocol error from ${peerId.slice(0, 12)}`, error.message);
      },
    });
    coordinatorRef.current = coordinator;
    activeOnlineCoordinator = coordinator;
    return coordinator;
  };
  const onlineRoom = new PrivateRoomController({
    // The deterministic headed harness injects signaling only in a dev/QA
    // build. Production always uses the repository's public signaling path.
    signalingFactory: QA_MODE
      ? (window as unknown as { __xoPhase3TestSignalingFactory?: SignalingFactory })
        .__xoPhase3TestSignalingFactory
      : undefined,
    onView: (view) => onlineUi?.renderLobby(view),
    onError: (code) => onlineUi?.showError(code),
    onGameMessage: (peerId, message) => {
      try {
        const coordinator = activeOnlineCoordinator
          ?? (onlineRoom.matchContext?.role === 'guest' ? ensureOnlineCoordinator() : null);
        if (coordinator) void coordinator.handleGameMessage(peerId, message);
      } catch (error) {
        console.error('online match message setup failed', error);
      }
    },
    onGameStateChange: (peerId, state) => activeOnlineCoordinator?.handleConnectionState(peerId, state),
    onGameDisconnected: ({ peerId, state }) => {
      activeOnlineCoordinator?.handleConnectionState(peerId, state);
    },
    onHostDisconnected: ({ peerId, state }) => {
      const coordinator = activeOnlineCoordinator;
      coordinator?.handleConnectionState(peerId, state);
      window.setTimeout(() => {
        if (activeOnlineCoordinator === coordinator) coordinator?.update(0);
      }, HOST_DISCONNECT_GRACE_MS + 50);
    },
    onGameNetworkMetrics: (peerId, metrics) => {
      onlineMetrics.set(peerId, metrics);
      activeOnlineCoordinator?.observeNetworkMetrics(peerId, metrics);
    },
    authorizeParticipantReconnect: ({ participantId, peerId }) => (
      activeOnlineCoordinator?.canAcceptReconnectedParticipant(participantId, peerId) === true
    ),
    onParticipantReconnected: ({ peerId, binding }) => {
      return activeOnlineCoordinator?.acceptReconnectedParticipant(binding.participantId, peerId).accepted === true;
    },
    onMatchStartAccepted: async (context) => {
      try {
        await ensureOnlineCoordinator(context).beginHost();
      } catch (error) {
        console.error('online host start failed', error);
        showMainMenuAfterOnline('protocol-error');
      }
    },
  });
  onlineUi = new OnlineLobbyUi({
    maps: MAP_LIST,
    actions: onlineRoom,
    showScreen: (id) => menus.showOnlineScreen(id),
  });
  menus.onUiSound = (kind) => audio.uiClick(kind);
  menus.onScreenChanged = (id) => lobby.compose(id === 'settings-menu' ? 'settings' : 'main');
  menus.onPlayRequested = (sel) => {
    if (activeOnlineCoordinator) {
      showMainMenuAfterOnline('host-ended');
      return;
    }
    void startMatch(sel, sharedMats, sharedProps, characterFactory, weaponFactory, lobby);
  };
  menus.onCreateRoomRequested = () => onlineUi?.showCreate();
  menus.onJoinRoomRequested = () => onlineUi?.showJoin();
  menus.onResumeRequested = resumeFromPause;
  menus.onQuitRequested = quitToMenu;
  $('btn-spectate-exit').addEventListener('click', () => menus.onQuitRequested());
  $('btn-online-start-cancel').addEventListener('click', () => activeOnlineCoordinator?.cancelStart());

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
      && liveLocalAlive(live)
      && !paused
      && livePhase(live) !== 'results'
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
      live?.world.setWaterQuality(s.quality);
    }
    hud.applyCrosshair();
    audio.applyVolumes();
  });
  window.addEventListener('pagehide', () => {
    flushSettingsPersist();
    const coordinator = activeOnlineCoordinator;
    activeOnlineCoordinator = null;
    activeOnlineContextKey = '';
    coordinator?.dispose();
    teardownMatch(false);
    // Keep a guest invite fragment across reload so its sessionStorage-only
    // reconnect token can reclaim the same slot with a new browser peer ID.
    void onlineRoom.leaveRoom(true);
  });

  const inviteOnLoad = location.hash.startsWith('#join=') ? location.href : '';
  if (inviteOnLoad) {
    const openInvite = () => onlineUi?.showJoin(inviteOnLoad);
    if (getSettings().onboarded) openInvite();
    else menus.onOnboardingDone = openInvite;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && live && !paused && livePhase(live) !== 'results') openPause();
  });
  window.addEventListener('blur', () => {
    if (live && !paused && livePhase(live) !== 'results' && !menus.isAnyMenuOpen()) openPause();
  });

  function quitToMenu(): void {
    const coordinator = activeOnlineCoordinator;
    if (coordinator) {
      if (coordinator.role === 'host') coordinator.endHostMatch();
      else {
        coordinator.dispose();
        showMainMenuAfterOnline(null);
      }
      return;
    }
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

function updateOnlineBarrierStatus(status: StartBarrierStatus): void {
  const cancel = document.getElementById('btn-online-start-cancel');
  const ready = status.readyParticipantIds.length + (status.hostReady ? 1 : 0);
  const total = ready + status.waitingParticipantIds.length + status.failedParticipantIds.length;
  $('loading-status').textContent = status.failedParticipantIds.length > 0
    ? t('online.loadFailed')
    : status.timedOut
      ? t('online.loadTimedOut')
    : status.countdown
    ? t('online.startCountdown')
    : t('online.readyStatus', { ready, total });
  cancel?.classList.toggle('hidden', status.cancelled || status.countdown !== null);
}

function installOnlineMetricPolling(
  room: PrivateRoomController,
  context: OnlineRoomMatchContext,
  metrics: Map<string, GameNetworkMetrics>,
): void {
  const game = live;
  if (!game || game.onlineContext?.matchSessionBinding !== context.matchSessionBinding) return;
  const peerIds = context.role === 'host'
    ? context.snapshot.participants
      .filter((participant) => !participant.isHost)
      .map((participant) => participant.peerId)
    : [context.hostPeerId];
  const sample = (): void => {
    for (const peerId of peerIds) {
      void room.getGameNetworkMetrics(peerId).then((value) => {
        if (value) metrics.set(peerId, value);
      });
    }
  };
  sample();
  const timer = window.setInterval(sample, 1_000);
  game.cleanup.push(() => window.clearInterval(timer));
}

function activateOnlinePresentation(role: 'host' | 'guest', payload: MatchStartPayload): void {
  const game = live;
  if (!game || game.onlineContext?.matchSessionBinding !== payload.protocolSession) {
    throw new Error('Prepared online presentation does not match the start payload');
  }
  $('btn-online-start-cancel').classList.add('hidden');
  $('loading-fill').style.width = '100%';
  $('loading-screen').classList.add('hidden');
  menus.hideAll();
  menus.setPlayEnabled(true);
  hud.show(true);
  hud.applyCrosshair();
  game.player.enabled = true;
  game.player.requestLock();
  audio.init();
  audio.resume();
  audio.startAmbience(game.mapDef.sky.preset, false);
  hud.banner(t('banner.drop', { jump: prettyBind(getSettings().bindings.jump) }), 5.5);
  if (import.meta.env.DEV) document.documentElement.dataset.xoOnlineRole = role;
  resetPerfStats();
  startLoop();
}

async function prepareOnlineHostSession(
  input: HostSessionFactoryInput,
  coordinator: OnlineMatchCoordinator<ClientMovementPredictionState>,
  context: OnlineRoomMatchContext,
  metrics: Map<string, GameNetworkMetrics>,
  sharedMats: MaterialLibrary,
  sharedProps: PropLibrary,
  charFactory: CharacterFactory,
  weaponFactory: WeaponModelFactory,
  lobby: LobbyScene,
): Promise<HostAuthoritativeMatchSession> {
  teardownMatch(false);
  const generation = ++matchGeneration;
  pendingStart = { generation, cleanup: [] };
  menus.setPlayEnabled(false);
  try {
    const match = await startMatchImpl(
      { map: input.payload.mapId, difficulty: input.payload.difficulty, practice: false },
      sharedMats,
      sharedProps,
      charFactory,
      weaponFactory,
      lobby,
      generation,
      { input, coordinator, context, metrics },
    );
    return new HostAuthoritativeMatchSession(
      match,
      input.bindings,
      input.transport,
      input.encodeSnapshot,
      {
        lagCompensation: new HostLagCompensation(),
        onEvent: input.onEvent,
        onPresenceNotice: input.onPresenceNotice,
      },
    );
  } catch (error) {
    if (generation === matchGeneration) teardownMatch(false);
    throw error;
  }
}

function initialReplicaPresentationView(
  input: GuestReplicaFactoryInput,
  predictionWorld: ClientMovementPredictionWorld,
): GameStateView {
  const position = Object.freeze({
    x: input.map.transportRoute.from[0],
    y: MATCH.transportAltitude,
    z: input.map.transportRoute.from[1],
  });
  const velocity = Object.freeze({ x: 0, y: 0, z: 0 });
  const actors: ActorView[] = input.payload.roster.map((entry) => Object.freeze({
    id: entry.actorId,
    displayName: entry.displayName,
    ownership: Object.freeze({ ...entry.ownership }),
    connectionState: entry.connectionState,
    teamId: entry.teamId,
    skinId: entry.skinId,
    accentColor: entry.accentColor,
    alive: true,
    health: 100,
    shield: 50,
    position,
    velocity,
    yaw: 0,
    pitch: 0,
    grounded: false,
    moveState: 'ground',
    crouched: false,
    deployed: false,
    equippedWeapon: null,
    inventory: null,
    placement: 0,
    stats: Object.freeze({
      kills: 0,
      damageDealt: 0,
      shotsFired: 0,
      shotsHit: 0,
      headshots: 0,
      survivalTime: 0,
    }),
  }));
  const teamIds = [...new Set(input.payload.roster.map((entry) => entry.teamId))]
    .filter((teamId): teamId is number => teamId !== null)
    .sort((a, b) => a - b);
  return Object.freeze({
    hostTick: 0,
    stateRevision: 0,
    time: 0,
    phaseTime: 0,
    phase: 'transport',
    actors: Object.freeze(actors),
    localActorId: input.localActorId,
    teams: Object.freeze(teamIds.map((teamId) => Object.freeze({
      teamId,
      members: Object.freeze(input.payload.roster
        .filter((entry) => entry.teamId === teamId)
        .map((entry) => Object.freeze({
          actorId: entry.actorId,
          slotId: entry.slotId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          alive: true,
          connectionState: entry.connectionState,
        }))),
      aliveCount: input.payload.roster.filter((entry) => entry.teamId === teamId).length,
    }))),
    mode: input.payload.mode,
    chests: predictionWorld.supportedChests,
    loot: Object.freeze([]),
    storm: Object.freeze({
      state: 'idle',
      phaseIndex: -1,
      timer: 0,
      centerX: 0,
      centerZ: 0,
      radius: input.map.size,
    }),
    transport: Object.freeze({ ...position, jumpAllowed: false }),
    localMovement: null,
    destructibles: Object.freeze(input.map.destructibles.map((value) => Object.freeze({
      id: value.stableId,
      revision: 0,
      destroyed: false,
    }))),
    winner: null,
    teamResults: Object.freeze([]),
  });
}

async function prepareOnlineGuestRuntime(
  input: GuestReplicaFactoryInput,
  coordinator: OnlineMatchCoordinator<ClientMovementPredictionState>,
  context: OnlineRoomMatchContext,
  metrics: Map<string, GameNetworkMetrics>,
  sharedMats: MaterialLibrary,
  sharedProps: PropLibrary,
  charFactory: CharacterFactory,
  weaponFactory: WeaponModelFactory,
  lobby: LobbyScene,
): Promise<void> {
  teardownMatch(false);
  const generation = ++matchGeneration;
  pendingStart = { generation, cleanup: [] };
  menus.setPlayEnabled(false);
  lobby.stop();
  menus.hideAll();
  $('loading-screen').classList.remove('hidden');
  $('btn-online-start-cancel').classList.add('hidden');
  await setLoad(0.12, t('online.loadingGuest'));
  try {
    ensureCurrentStart(generation);
    const predictionMap = input.map;
    const initialState = createClientMovementPredictionState({
      x: predictionMap.transportRoute.from[0],
      y: MATCH.transportAltitude,
      z: predictionMap.transportRoute.from[1],
    }, { deployed: false, grounded: false, state: 'ground' });
    const predictionWorld = await ClientMovementPredictionWorld.create({
      mapDef: predictionMap,
      actorId: input.localActorId,
      initialState,
      displayName: input.payload.roster.find((entry) => entry.actorId === input.localActorId)?.displayName,
      accentColor: input.payload.roster.find((entry) => entry.actorId === input.localActorId)?.accentColor,
    });
    registerStartCleanup(generation, () => predictionWorld.dispose());
    await setLoad(0.38, t('load.map', { name: t(`map.${input.payload.mapId}.name` as never) }));

    const canvas = $canvas();
    const renderer = new GameRenderer(canvas, QA_MODE);
    registerStartCleanup(generation, () => renderer.dispose());
    await renderer.setupSkyAndLights(input.map.sky);
    ensureCurrentStart(generation);
    if (input.map.sky.grade) renderer.setGrading(input.map.sky.grade);
    const worldStart = performance.now();
    const guestSkyTexture = (renderer.scene.background as THREE.Texture | null)?.isTexture
      ? renderer.scene.background as THREE.Texture
      : null;
    const world = await WorldView.create(input.map, sharedMats, null, sharedProps, {
      renderer: renderer.renderer,
      quality: getSettings().quality,
      skyTexture: guestSkyTexture,
      skyRotationY: renderer.scene.backgroundRotation.y,
      skyIntensity: input.map.sky.envIntensity,
    });
    const worldConstructionMs = performance.now() - worldStart;
    try {
      ensureCurrentStart(generation);
    } catch (error) {
      world.dispose();
      throw error;
    }
    renderer.scene.add(world.group);
    registerStartCleanup(generation, () => {
      renderer.scene.remove(world.group);
      world.dispose();
    });
    const bootstrapView = initialReplicaPresentationView(input, predictionWorld);
    world.initializeReplica(bootstrapView);

    const vfx = new VfxSystem();
    renderer.scene.add(vfx.group);
    registerStartCleanup(generation, () => {
      renderer.scene.remove(vfx.group);
      vfx.dispose();
    });
    const rig = new CameraRig(window.innerWidth / window.innerHeight);
    rig.onScopedChanged = (scoped) => {
      hud.setScoped(scoped);
      renderer.setScopeActive(scoped, rig.camera);
    };
    renderer.buildComposer(rig.camera);
    renderer.applyQuality();
    rig.mode = getSettings().cameraMode;

    const viewmodel = new ViewModel(weaponFactory);
    viewmodel.group.visible = rig.mode === 'fps';
    renderer.scene.add(viewmodel.group);
    registerStartCleanup(generation, () => {
      renderer.scene.remove(viewmodel.group);
      viewmodel.dispose();
    });
    viewmodel.setWeapon(null, 'common');

    const characterFill = new THREE.PointLight(0xcfe0ff, 2, 4.8, 2);
    characterFill.visible = false;
    renderer.scene.add(characterFill);
    registerStartCleanup(generation, () => renderer.scene.remove(characterFill));

    const females = new Set(['NOVA', 'KIRA', 'AXIS', 'ORBIT', 'VEX']);
    const rigs = new Map<number, CharacterRig>();
    for (const entry of input.payload.roster) {
      const character = charFactory.create(
        entry.displayName,
        entry.accentColor,
        females.has(entry.displayName),
        null,
        entry.skinId,
      );
      character.prewarmDeath?.();
      character.group.visible = false;
      rigs.set(entry.actorId, character);
      world.group.add(character.group);
    }
    registerStartCleanup(generation, () => {
      for (const character of rigs.values()) character.dispose();
      rigs.clear();
    });

    const toggleTacMap = (): void => {
      if (!liveLocalAlive() || livePhase() === 'results') return;
      if (hud.isInventoryOpen()) hud.setInventoryOpen(false);
      hud.toggleTacMap();
      if (hud.isTacMapOpen()) player.releaseLock();
      else if (!paused) player.requestLock();
    };
    const toggleInventory = (force?: boolean): void => {
      const currentlyOpen = hud.isInventoryOpen();
      const open = force ?? !currentlyOpen;
      if (open === currentlyOpen) return;
      if (open && (!liveLocalAlive() || livePhase() === 'results' || paused)) return;
      if (open && hud.isTacMapOpen()) hud.toggleTacMap(false);
      hud.setInventoryOpen(open);
      rig.resetAimState();
      renderer.setScopeActive(false);
      player.enabled = !open;
      if (open) player.releaseLock();
      else if (!paused) player.requestLock();
    };
    const requestAimPing = (): void => {
      if (!coordinator.active || hud.isTacMapOpen()) return;
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion).normalize();
      const origin = rig.camera.position.clone().addScaledVector(direction, 0.45);
      const hit = predictionWorld.cameraCast(
        origin.x, origin.y, origin.z,
        direction.x, direction.y, direction.z,
        250,
        0.04,
      );
      const distance = Math.max(1, Math.min(250, hit?.dist ?? 180));
      const point = origin.addScaledVector(direction, distance);
      coordinator.requestTacticalPing(point.x, point.z);
    };
    const inputBus = new EventBus<{ requestPointerLock: Record<string, never> }>();
    registerStartCleanup(generation, () => inputBus.clear());
    const player = new PlayerController(
      canvas,
      inputBus,
      () => {
        rig.toggleMode();
        updateSettings({ cameraMode: rig.mode });
        viewmodel.group.visible = rig.mode === 'fps';
      },
      () => handlePauseOrSpectateExit(),
      () => cycleSpectate(-1),
      () => cycleSpectate(1),
      toggleTacMap,
      () => updateSettings({
        tpsCharacterSide: getSettings().tpsCharacterSide === 'left' ? 'right' : 'left',
      }),
      () => toggleInventory(),
    );
    registerStartCleanup(generation, () => player.dispose());
    player.gamepad = new GamepadInput({
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
      onMapToggle: toggleTacMap,
      onPauseRequest: () => handlePauseOrSpectateExit(),
      onSlotRequest: (slot) => player.requestInventorySlot(slot),
      onMeleePress: () => undefined,
      onPingPress: requestAimPing,
    });
    const routeX = input.map.transportRoute.to[0] - input.map.transportRoute.from[0];
    const routeZ = input.map.transportRoute.to[1] - input.map.transportRoute.from[1];
    player.resetLook(Math.atan2(-routeX, -routeZ), -0.12);

    hud.setProjector((x, y, z) => {
      const projected = new THREE.Vector3(x, y, z).project(rig.camera);
      return { x: projected.x * 0.5 + 0.5, y: -projected.y * 0.5 + 0.5, visible: projected.z < 1 };
    });
    const tacCanvas = document.getElementById('tac-map') as HTMLCanvasElement | null;
    const onTacClick = (event: MouseEvent): void => {
      if (!hud.isTacMapOpen() || !tacCanvas || !coordinator.active) return;
      const rect = tacCanvas.getBoundingClientRect();
      const half = input.map.size / 2;
      const x = ((event.clientX - rect.left) / rect.width) * input.map.size - half;
      const z = ((event.clientY - rect.top) / rect.height) * input.map.size - half;
      if (coordinator.requestTacticalPing(x, z)) audio.uiClick('confirm');
    };
    tacCanvas?.addEventListener('click', onTacClick);
    registerStartCleanup(generation, () => tacCanvas?.removeEventListener('click', onTacClick));

    hud.onInventoryClose = () => toggleInventory(false);
    hud.onInventorySelect = (slot) => {
      toggleInventory(false);
      if (player.requestInventorySlot(slot)) audio.uiClick('click');
    };
    hud.onInventoryMove = () => undefined;
    hud.onInventoryDrop = (slot) => {
      toggleInventory(false);
      if (player.requestInventorySlot(slot) && player.requestDropSelected()) audio.uiClick('confirm');
    };
    registerStartCleanup(generation, () => {
      hud.setInventoryOpen(false);
      hud.onInventoryClose = () => undefined;
      hud.onInventorySelect = () => undefined;
      hud.onInventoryMove = () => undefined;
      hud.onInventoryDrop = () => undefined;
    });

    weaponFactory.prewarmAll();
    await setLoad(0.78, t('load.warming'));
    try {
      for (const character of rigs.values()) character.group.visible = true;
      viewmodel.group.visible = true;
      await renderer.renderer.compileAsync(renderer.scene, rig.camera);
      ensureCurrentStart(generation);
      renderer.renderer.render(renderer.scene, rig.camera);
      const aerial = renderer.captureAerial(input.map.size / 2, 1024, [
        world.stormMesh,
        world.transportGroup,
        ...[...rigs.values()].map((character) => character.group),
        viewmodel.group,
      ]);
      hud.setTacMapImage(aerial);
    } catch (error) {
      console.warn('guest presentation prewarm failed', error);
    }
    for (const character of rigs.values()) character.group.visible = false;
    viewmodel.group.visible = rig.mode === 'fps';
    ensureCurrentStart(generation);
    const cleanup = pendingStart!.cleanup;
    pendingStart = null;
    const presentation: LivePresentation = {
      generation,
      mapDef: input.map,
      renderer,
      world,
      vfx,
      rig,
      viewmodel,
      rigs,
      characterFill,
      player,
      weaponFactory,
      mats: sharedMats,
      qaSceneCensus: QA_MODE ? buildQaSceneCensus(world.group) : '',
      qaGlassSpecs: QA_MODE ? input.map.destructibles.flatMap((value, id) => (
        value.type === 'glass' && value.geo.kind === 'box'
          ? [{ id, stableId: value.stableId, ...value.geo }]
          : []
      )) : [],
      qaGlassBreakFrames: [],
      worldConstructionMs,
      cleanup,
      onlineContext: context,
      onlineMetrics: metrics,
    };
    pendingGuestRuntime = Object.freeze({ generation, input, presentation, predictionWorld });
    await setLoad(0.92, t('online.waitingForPlayers'));
  } catch (error) {
    if (generation === matchGeneration) teardownMatch(false);
    throw error;
  }
}

function activatePreparedGuestReplica(
  input: GuestReplicaFactoryInput,
  coordinator: OnlineMatchCoordinator<ClientMovementPredictionState>,
): ClientReplica<ClientMovementPredictionState> {
  const prepared = pendingGuestRuntime;
  if (!prepared
    || prepared.generation !== matchGeneration
    || prepared.input.payload.protocolSession !== input.payload.protocolSession
    || prepared.input.localActorId !== input.localActorId
    || prepared.input.payload.mapHash !== input.payload.mapHash) {
    throw new Error('Guest runtime was not prepared for this canonical payload');
  }
  const initialState = prepared.predictionWorld.captureState();
  const replica = new ClientReplica<ClientMovementPredictionState>({
    localActorId: input.localActorId,
    movementStep: prepared.predictionWorld.movementStep,
    initialPredictionState: initialState,
    prediction: { initialState },
    interpolation: {
      constrainExtrapolatedPosition: (from, candidate) => {
        const dx = candidate.x - from.x;
        const dy = candidate.y - from.y;
        const dz = candidate.z - from.z;
        const distance = Math.hypot(dx, dy, dz);
        if (distance <= 1e-5) return candidate;
        const hit = prepared.predictionWorld.cameraCast(
          from.x, from.y, from.z,
          dx / distance, dy / distance, dz / distance,
          distance,
          0.34,
        );
        if (!hit) return candidate;
        const safeDistance = Math.max(0, hit.dist - 0.06);
        return {
          x: from.x + (dx / distance) * safeDistance,
          y: from.y + (dy / distance) * safeDistance,
          z: from.z + (dz / distance) * safeDistance,
        };
      },
    },
  });
  pendingGuestRuntime = null;
  live = {
    ...prepared.presentation,
    kind: 'replica',
    coordinator,
    replica,
    predictionWorld: prepared.predictionWorld,
    payload: input.payload,
    localActorId: input.localActorId,
    view: null,
    worldInitialized: true,
    lastRigWeaponKeys: new Map(),
    nextPredictedShotAtMs: 0,
  };
  return replica;
}

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
  onlineHost: {
    readonly input: HostSessionFactoryInput;
    readonly coordinator: OnlineMatchCoordinator<ClientMovementPredictionState>;
    readonly context: OnlineRoomMatchContext;
    readonly metrics: Map<string, GameNetworkMetrics>;
  } | null = null,
): Promise<Match> {
  lobby.stop();
  menus.hideAll();
  $('loading-screen').classList.remove('hidden');
  const mapId = onlineHost?.input.payload.mapId ?? sel.map;
  await setLoad(0.15, t('load.map', { name: t(`map.${mapId}.name` as never) }));
  ensureCurrentStart(generation);

  const loaded = onlineHost ? { def: onlineHost.input.map } : loadMap(sel.map);
  qaGlassBreakTimes = [];
  qaGlassBreakFrames = [];
  const matchSeed = onlineHost?.input.payload.seed ?? qaRequestedSeed() ?? Date.now() % 1000000;
  const qaFixture = onlineHost || sel.practice ? null : qaRosterFixture(matchSeed);
  const mode = onlineHost?.input.payload.mode ?? qaFixture?.mode ?? 'solo';
  const roster = onlineHost?.input.payload.roster ?? qaFixture?.roster ?? buildRoster({
      mode,
      humans: [localHumanRosterEntry({ skinId: getSettings().playerSkin })],
      practice: sel.practice === true,
      seed: matchSeed,
    });
  const match = new Match({
    mapDef: loaded.def,
    seed: matchSeed,
    difficulty: onlineHost?.input.payload.difficulty ?? sel.difficulty,
    mode,
    roster,
    practice: !onlineHost && sel.practice === true,
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
  const hostSkyTexture = (renderer.scene.background as THREE.Texture | null)?.isTexture
    ? renderer.scene.background as THREE.Texture
    : null;
  const world = await WorldView.create(loaded.def, sharedMats, match, sharedProps, {
    renderer: renderer.renderer,
    quality: getSettings().quality,
    skyTexture: hostSkyTexture,
    skyRotationY: renderer.scene.backgroundRotation.y,
    skyIntensity: loaded.def.sky.envIntensity,
  });
  const worldConstructionMs = performance.now() - worldStart;
  try {
    ensureCurrentStart(generation);
  } catch (error) {
    world.dispose();
    throw error;
  }
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
      const p = match.localActor;
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
    const x = ((ev.clientX - rect.left) / rect.width) * match.mapDef.size - half;
    const z = ((ev.clientY - rect.top) / rect.height) * match.mapDef.size - half;
    if (onlineHost) {
      if (onlineHost.coordinator.requestTacticalPing(x, z)) audio.uiClick('confirm');
    } else {
      hud.tacMarker = { x, z };
      audio.uiClick('click');
    }
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
      if (onlineHost) {
        if (onlineHost.coordinator.requestTacticalPing(hit.point.x, hit.point.z)) audio.uiClick('confirm');
      } else {
        hud.tacMarker = { x: hit.point.x, z: hit.point.z };
        audio.uiClick('confirm');
      }
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
        new BotController(actor, match, new Rng(match.rng.next() * 0xffffffff), actor.personality, match.difficulty),
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
    kind: 'match',
    generation,
    mapDef: loaded.def,
    match,
    coordinator: onlineHost?.coordinator ?? null,
    renderer,
    world,
    vfx,
    rig,
    viewmodel,
    rigs,
    characterFill,
    player,
    weaponFactory,
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
    onlineContext: onlineHost?.context ?? null,
    onlineMetrics: onlineHost?.metrics ?? new Map(),
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
  if (onlineHost) {
    $('loading-status').textContent = t('online.waitingForPlayers');
    return match;
  }
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
  return match;
}

function teardownMatch(disposeOnline = true): void {
  if (disposeOnline) {
    const coordinator = activeOnlineCoordinator;
    activeOnlineCoordinator = null;
    coordinator?.dispose();
  }
  cancelPendingStart();
  const preparedGuest = pendingGuestRuntime;
  pendingGuestRuntime = null;
  if (preparedGuest) runCleanups(preparedGuest.presentation.cleanup);
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
      '__xoGive', '__xoQaInput', '__xoStorm', '__xoWaterQaView', '__xoReplicaState',
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
    delete document.documentElement.dataset.xoOnlineState;
    delete document.documentElement.dataset.xoOnlineRole;
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
  hud?.resetOnlineHud();
  hud?.setInventoryOpen(false);
  hud?.hideSpectate();
  hud?.interactPrompt(null);
  hud?.setTacMapImage(null);
  document.getElementById('btn-online-start-cancel')?.classList.add('hidden');
  audio?.cancelMatchEffects();
  audio?.stopAmbience();
  audio?.setMusicState('none');
}

// ---------------------------------------------------------------------------
// Pause / spectator
// ---------------------------------------------------------------------------

function openPause(): void {
  if (!live || paused || livePhase(live) === 'results') return;
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
  if (live && !liveLocalAlive(live) && livePhase(live) !== null && livePhase(live) !== 'results') {
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
  if (!live || liveLocalAlive(live)) return;
  const targets = live.kind === 'match'
    ? live.match.spectatorTargets().map((actor) => ({ id: actor.id }))
    : replicaSpectatorTargets(live.view, live.localActorId).map((actor) => ({ id: actor.id }));
  if (!targets.length) return;
  const idx = targets.findIndex((t) => t.id === spectateTargetId);
  const next = targets[(((idx + dir + targets.length * 2) % targets.length) + targets.length) % targets.length]!;
  spectateTargetId = next.id;
}

function replicaSpectatorTargets(view: GameStateView | null, localActorId: number): readonly ActorView[] {
  if (!view) return [];
  const local = view.actors.find((actor) => actor.id === localActorId);
  return view.actors
    .filter((actor) => actor.alive && actor.id !== localActorId)
    .sort((left, right) => {
      const leftMate = local?.teamId !== null && left.teamId === local?.teamId ? 0 : 1;
      const rightMate = local?.teamId !== null && right.teamId === local?.teamId ? 0 : 1;
      return leftMate - rightMate || left.id - right.id;
    });
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

function presentOnlineAuthoritativeEvent(
  event: AuthoritativeMatchEvent,
  matchedLocalPrediction: boolean,
): void {
  const game = live;
  if (!game) return;
  const payload = event.payload;
  const number = (key: string, fallback = 0): number => {
    const value = payload[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const integer = (key: string, fallback = -1): number => {
    const value = payload[key];
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
  };
  const actorView = (actorId: number): ActorView | null => {
    if (game.kind === 'replica') return game.view?.actors.find((actor) => actor.id === actorId) ?? null;
    const actor = game.match.actors.find((candidate) => candidate.id === actorId);
    return actor ? game.match.toGameStateView(game.match.localActorId).actors.find((item) => item.id === actorId) ?? null : null;
  };

  if (event.type === 'tacticalPing') {
    const x = number('x', Number.NaN);
    const z = number('z', Number.NaN);
    if (Number.isFinite(x) && Number.isFinite(z)) {
      const expires = integer('expiresHostTick', event.hostTick + 300);
      hud.showTacticalPing(x, z, Math.max(0.5, Math.min(6, (expires - event.hostTick) / 60)));
    }
    return;
  }
  if (event.type === 'playerLeave' || event.type === 'playerRejoin') {
    const actor = actorView(integer('actorId'));
    hud.showPresenceNotice(event.type === 'playerLeave' ? 'left' : 'rejoined', actor?.displayName ?? '');
    return;
  }

  // The host already consumes the Match EventBus directly. Only non-Match
  // coordinator events above need a second presentation path there.
  if (game.kind !== 'replica') return;
  const view = game.view;
  const localActorId = game.localActorId;

  if (event.type === 'shotFired') {
    const actorId = integer('actorId');
    const isLocal = actorId === localActorId;
    if (isLocal && matchedLocalPrediction) return;
    const weapon = payload.weaponId;
    if (typeof weapon !== 'string' || !(weapon in WEAPONS)) return;
    const weaponId = weapon as WeaponId;
    const dry = payload.dry === true;
    const x = number('x');
    const y = number('y');
    const z = number('z');
    audio.gunshot(weaponId, x, y, z, dry, isLocal);
    if (dry) return;
    const actor = actorView(actorId);
    if (isLocal && game.rig.mode === 'fps') {
      game.viewmodel.kick(WEAPON_KICK[weaponId] ?? 1);
      game.viewmodel.muzzlePulse(0.8);
      return;
    }
    const hasMuzzle = game.rigs.get(actorId)?.muzzleWorld?.(
      presentationMuzzle,
      presentationMuzzleDirection,
    ) === true;
    const yaw = actor?.yaw ?? 0;
    const pitch = actor?.pitch ?? 0;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);
    game.vfx.muzzleFlash(
      hasMuzzle ? presentationMuzzle.x : x,
      hasMuzzle ? presentationMuzzle.y : y,
      hasMuzzle ? presentationMuzzle.z : z,
      hasMuzzle ? presentationMuzzleDirection.x : dx,
      hasMuzzle ? presentationMuzzleDirection.y : dy,
      hasMuzzle ? presentationMuzzleDirection.z : dz,
      isLocal ? 0.9 : 1.35,
      weaponId === 'shotgun' || weaponId === 'sniper',
    );
    return;
  }
  if (event.type === 'impact') {
    const material = typeof payload.material === 'string' ? payload.material : 'stone';
    const x = number('x'); const y = number('y'); const z = number('z');
    game.vfx.impactSparks(x, y, z, number('nx'), number('ny', 1), number('nz'), material === 'metal' ? 10 : 6);
    audio.impact(x, y, z, material);
    return;
  }
  if (event.type === 'glassBreak') {
    const x = number('x'); const y = number('y'); const z = number('z');
    game.vfx.glassShards(x, y, z);
    audio.glassBreak(x, y, z);
    return;
  }
  if (event.type === 'destructibleDestroyed') {
    const x = number('x'); const y = number('y'); const z = number('z');
    game.vfx.debrisBurst(x, y, z, 0xa07848);
    audio.debrisCrack(x, y, z);
    return;
  }
  if (event.type === 'actorHit') {
    const targetId = integer('targetId');
    const attackerId = integer('attackerId');
    const damage = Math.max(0, number('damage'));
    const target = actorView(targetId);
    if (attackerId === localActorId && target) {
      const headshot = payload.headshot === true;
      hud.hitmarker(headshot);
      hud.spawnDamageNumber(
        target.position.x, target.position.y + 1.35, target.position.z,
        damage,
        payload.killed === true ? 'kill' : headshot ? 'headshot' : number('shieldDamage') > 0 ? 'shield' : 'normal',
      );
    }
    if (targetId === localActorId) game.rig.addShake(Math.min(0.5, damage / 60));
    return;
  }
  if (event.type === 'shieldHit' || event.type === 'shieldBroken') {
    const actor = actorView(integer('actorId'));
    if (!actor) return;
    if (event.type === 'shieldHit') audio.shieldHit(actor.position.x, actor.position.y + 1, actor.position.z);
    else {
      game.vfx.shieldBreakBurst(actor.position.x, actor.position.y + 1.1, actor.position.z);
      audio.shieldBreakFx(actor.position.x, actor.position.y + 1, actor.position.z);
      if (actor.id === localActorId) hud.caption(t('cap.shieldBreak'), true);
    }
    return;
  }
  if (event.type === 'eliminated') {
    const victim = actorView(integer('victimId'));
    const killer = actorView(integer('killerId'));
    if (victim) {
      game.vfx.eliminationWisp(
        victim.position.x, victim.position.y + 1, victim.position.z, victim.accentColor,
      );
      audio.eliminationFx(victim.position.x, victim.position.y, victim.position.z);
    }
    const weapon = typeof payload.weaponId === 'string' ? payload.weaponId : '';
    hud.addKillfeed(
      killer?.displayName ?? null,
      victim?.displayName ?? '?',
      WEAPON_ICONS[weapon] ?? '',
      payload.headshot === true,
      payload.storm === true,
    );
    if (killer?.id === localActorId && victim) hud.elimination(`✕ ${victim.displayName}`);
    if (victim?.id === localActorId) hud.banner(t('banner.eliminatedYou'), 4);
    return;
  }
  if (event.type === 'itemPickedUp') {
    if (integer('actorId') === localActorId) audio.pickupUi(payload.rare === true);
    return;
  }
  if (event.type === 'chestOpened') {
    audio.chestOpen(number('x'), number('y'), number('z'), integer('tier', 0));
    return;
  }
  if (event.type === 'reloadStarted') {
    if (integer('actorId') === localActorId) audio.reloadClick(payload.empty === true);
    return;
  }
  if (event.type === 'healDone') {
    if (integer('actorId') === localActorId) audio.healComplete();
    return;
  }
  if (event.type === 'stormWaiting') {
    audio.stormWarningSting();
    hud.stormWarning(t('storm.advancing', {
      n: integer('index', 0) + 1,
      s: Math.round(number('waitTime')),
    }), 4);
    return;
  }
  if (event.type === 'stormShrinking') {
    hud.stormWarning(t('storm.closing'), 3);
    game.rig.addShake(0.1);
    return;
  }
  if (event.type === 'phaseChanged' && payload.phase === 'live') {
    hud.banner(t('banner.lastStanding'), 3);
  }
  void view;
}

function predictGuestFirePresentation(inputSequence: number, command: Readonly<InputCommand>): boolean {
  void inputSequence;
  const game = live;
  if (!game || game.kind !== 'replica' || !game.view) return false;
  const actor = game.view.actors.find((candidate) => candidate.id === game.localActorId);
  const weaponId = actor?.equippedWeapon;
  if (!actor?.alive || !weaponId) return false;
  const def = WEAPONS[weaponId];
  const intendsShot = def.fireMode === 'auto' ? command.fireHeld || command.firePressed : command.firePressed;
  if (!intendsShot) return false;
  const selected = actor.inventory && actor.inventory.selected >= 0
    ? actor.inventory.slots[actor.inventory.selected]
    : null;
  if (selected?.kind !== 'weapon' || selected.weaponId !== weaponId || selected.ammoInMag <= 0) return false;
  const time = performance.now();
  if (time + 0.5 < game.nextPredictedShotAtMs) return false;
  game.nextPredictedShotAtMs = time + 60_000 / def.rpm;
  audio.gunshot(weaponId, actor.position.x, actor.position.y, actor.position.z, false, true);
  if (game.rig.mode === 'fps') {
    game.viewmodel.kick(WEAPON_KICK[weaponId] ?? 1);
    game.viewmodel.muzzlePulse(0.8);
  } else {
    const yaw = actor.yaw;
    const pitch = actor.pitch;
    game.vfx.muzzleFlash(
      actor.position.x,
      actor.position.y + 1.3,
      actor.position.z,
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
      0.9,
      weaponId === 'shotgun' || weaponId === 'sniper',
    );
  }
  return true;
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

  // The first rAF timestamp can marginally predate the performance.now()
  // sampled by startLoop. Never feed that impossible negative delta into the
  // fixed-step online coordinator.
  const dtReal = Math.max(0, Math.min(SIM.maxFrameDt, (now - lastTime) / 1000));
  lastTime = now;
  recordFrameMs(dtReal * 1000);

  fpsAccum += dtReal;
  fpsCount++;
  if (fpsAccum >= 0.5) {
    hud.setFps(fpsCount / fpsAccum);
    fpsAccum = 0;
    fpsCount = 0;
  }

  // Production match simulation never freezes: ESC opens the in-game menu over
  // the still-running world. The development-only water benchmark freezes a
  // settled scene so renderer measurements are not distorted by Bot decisions
  // or match progression between otherwise identical captures.
  const current = live;
  const freezeForWaterQa = QA_MODE
    && (window as unknown as { __xoWaterQaFreezeSimulation?: boolean })
      .__xoWaterQaFreezeSimulation === true;
  {
    const simT0 = performance.now();
    if (freezeForWaterQa) {
      accumulator = 0;
    } else {
      accumulator += dtReal;
      if (current.kind === 'match' && current.coordinator === null) {
        let steps = 0;
        while (accumulator >= SIM.fixedDt && steps < 8) {
          current.match.fixedUpdate(SIM.fixedDt);
          accumulator -= SIM.fixedDt;
          steps++;
        }
      } else {
        current.coordinator?.update(dtReal);
        accumulator %= SIM.fixedDt;
      }
    }
    const simDt = performance.now() - simT0;
    perfStats.simMs = perfStats.simMs * 0.9 + simDt * 0.1;
    perfStats.lastSimMs = simDt;
    musicTimer -= dtReal;
    if (musicTimer <= 0) {
      musicTimer = 2;
      updateMusicState(current);
    }
  }

  const presT0 = performance.now();
  present(dtReal);
  const presDt = performance.now() - presT0;
  perfStats.presentMs = perfStats.presentMs * 0.9 + presDt * 0.1;
  perfStats.lastPresentMs = presDt;
}

function updateMusicState(game: LiveGame): void {
  if (!audio) return;
  // Matches carry no continuous score — soundscape only. Stings at results.
  if (livePhase(game) === 'results') {
    const won = game.kind === 'match'
      ? didLocalActorWin(game.match)
      : didLocalActorWinView(game.view, game.localActorId);
    audio.setMusicState(won ? 'victory' : 'defeat');
  }
}

// ---------------------------------------------------------------------------
// Frame presentation
// ---------------------------------------------------------------------------

function present(dtReal: number): void {
  if (!live) return;
  if (live.kind === 'replica') {
    presentReplica(live, dtReal);
    return;
  }
  presentMatch(live, dtReal);
}

function presentMatch(game: MatchLiveGame, dtReal: number): void {
  const { match: m, renderer, world, vfx, rig, viewmodel, rigs, player, characterFill } = game;

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
      worldConstructionMs: +game.worldConstructionMs.toFixed(2),
      water: world.getWaterQaStats(),
      onlineRole: game.onlineContext?.role ?? 'solo',
      destructibleCount: m.combat.destructibleCount(),
      aliveGlassCount: m.combat.aliveGlassCount(),
      destructibleRender: world.getDestructibleRenderStats(),
      glassSpecs: game.qaGlassSpecs,
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
      data.xoQaCensus = game.qaSceneCensus;
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
  applyQaWaterView(rig, world, false);

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
  applyQaWaterView(rig, world, true);
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
  hud.syncOnlineState(game.coordinator ? matchOnlineHudState(game) : null);
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

function presentReplica(game: ReplicaLiveGame, dtReal: number): void {
  const { renderer, world, vfx, rig, viewmodel, rigs, player, characterFill } = game;
  const view = game.replica.update(performance.now());
  game.view = view;
  if (!view) {
    characterFill.visible = false;
    viewmodel.group.visible = false;
    for (const character of rigs.values()) character.group.visible = false;
    hud.syncOnlineState(replicaOnlineHudState(game, null));
    renderer.render(dtReal);
    return;
  }
  if (QA_MODE) {
    document.documentElement.dataset.xoQaRuntime = qaRuntimeIssues.length === 0
      ? 'count=0'
      : `count=${qaRuntimeIssues.length}|last=${qaRuntimeIssues.at(-1)}`;
    (window as unknown as Record<string, unknown>).__xoReplicaState = {
      map: game.mapDef.id,
      seed: game.payload.seed,
      time: view.time,
      phase: view.phase,
      water: world.getWaterQaStats(),
      worldGroup: world.group,
      camera: rig.camera,
      threeRenderer: renderer.renderer,
      worldConstructionMs: +game.worldConstructionMs.toFixed(2),
      localActorId: game.localActorId,
      onlineRole: 'guest',
    };
  }

  if (!game.worldInitialized) {
    world.initializeReplica(view);
    game.worldInitialized = true;
  }
  game.predictionWorld.setTransportDeploymentAllowed(view.transport.jumpAllowed);
  game.predictionWorld.syncDestructibles(view.destructibles);

  const local = view.actors.find((actor) => actor.id === game.localActorId) ?? null;
  const spectating = local?.alive === false && view.phase !== 'results';
  if (spectating && !wasSpectating) {
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

  presentationTransportPos.set(view.transport.x, view.transport.y, view.transport.z);
  const inTransport = view.phase === 'transport' && !spectating && local?.deployed === false;
  const route = game.mapDef.transportRoute;
  const routeX = route.to[0] - route.from[0];
  const routeZ = route.to[1] - route.from[1];
  const routeLength = Math.hypot(routeX, routeZ) || 1;
  const dirX = routeX / routeLength;
  const dirZ = routeZ / routeLength;
  const slotOffset = (index: number): { x: number; z: number; y: number } => {
    const k = (4.5 - index) * 1.32;
    return { x: dirX * k, z: dirZ * k, y: (index % 2) * 0.24 };
  };

  if (spectating) {
    const targets = replicaSpectatorTargets(view, game.localActorId);
    const target = targets.find((actor) => actor.id === spectateTargetId) ?? targets[0];
    if (target) {
      spectateTargetId = target.id;
      rig.updateSpectateView(target, dtReal, game.predictionWorld);
      hud.showSpectate(target.displayName);
    } else {
      hud.showSpectate(t('hud.spectateNoTarget'));
      rig.resetAimState();
      const fallback = new THREE.Vector3(0, 65, 35);
      rig.camera.position.lerp(fallback, 1 - Math.exp(-dtReal * 4));
      rig.camera.lookAt(0, 0, 0);
    }
  } else if (inTransport && local) {
    const slot = slotOffset(Math.max(0, view.actors.findIndex((actor) => actor.id === local.id)));
    rig.updateTransport(presentationTransportPos, slot, local.yaw, local.pitch, now() / 1000, dtReal);
    hud.hideSpectate();
  } else if (local) {
    if (wasInTransport) rig.beginGameplayBlend();
    rig.updateView(local, dtReal, game.predictionWorld, {
      adsAmount: view.localMovement?.actorId === local.id ? view.localMovement.adsAmount : 0,
    });
    hud.hideSpectate();
  }
  wasInTransport = inTransport;
  rig.tick(dtReal);
  applyQaWaterView(rig, world, false);

  for (const actor of view.actors) {
    const character = rigs.get(actor.id);
    if (!character) continue;
    if (actor.id === game.localActorId && rig.mode === 'fps' && actor.alive && !spectating) {
      character.group.visible = false;
    } else {
      character.group.visible = true;
      character.updateView?.(actor, now() / 1000, dtReal);
      if (inTransport && !actor.deployed) {
        const slot = slotOffset(Math.max(0, view.actors.findIndex((candidate) => candidate.id === actor.id)));
        character.group.position.set(
          presentationTransportPos.x + slot.x,
          presentationTransportPos.y - MATCH.transportHangOffset + slot.y,
          presentationTransportPos.z + slot.z,
        );
      }
      if (!actor.alive) updateEliminationFx(character, dtReal);
    }

    const selected = actor.inventory && actor.inventory.selected >= 0
      ? actor.inventory.slots[actor.inventory.selected]
      : null;
    const rarity = selected?.kind === 'weapon' && selected.weaponId === actor.equippedWeapon
      ? selected.rarity : 'common';
    const weaponKey = actor.equippedWeapon ? `${actor.equippedWeapon}:${rarity}` : '';
    if (game.lastRigWeaponKeys.get(actor.id) !== weaponKey) {
      game.lastRigWeaponKeys.set(actor.id, weaponKey);
      const model = actor.equippedWeapon
        ? game.weaponFactory.build(actor.equippedWeapon, rarity)?.group ?? null
        : null;
      character.attachWeapon?.(model);
    }
  }

  if (!spectating && rig.mode === 'tps' && local?.alive) {
    const towardCamera = presentationFillDirection.set(
      rig.camera.position.x - local.position.x,
      0,
      rig.camera.position.z - local.position.z,
    ).normalize();
    characterFill.position.set(
      local.position.x + towardCamera.x * 1.5,
      feetYFromBodyCenter(local.position.y) + 1.65,
      local.position.z + towardCamera.z * 1.5,
    );
    characterFill.visible = true;
  } else characterFill.visible = false;

  if (local && view.localMovement?.actorId === local.id && view.localMovement.grappleActive) {
    vfx.setGrappleRope(
      local.id,
      local.position.x,
      feetYFromBodyCenter(local.position.y) + 1.6,
      local.position.z,
      view.localMovement.grapplePoint.x,
      view.localMovement.grapplePoint.y,
      view.localMovement.grapplePoint.z,
    );
  } else if (local) vfx.hideGrappleRope(local.id);

  if (local?.alive && rig.mode === 'fps' && !inTransport && !rig.scoped) {
    const speed = Math.hypot(local.velocity.x, local.velocity.z);
    viewmodel.updateView(
      local,
      dtReal,
      player.lookDxSmooth(),
      player.lookDySmooth(),
      speed,
      { adsAmount: view.localMovement?.actorId === local.id ? view.localMovement.adsAmount : 0 },
    );
    viewmodel.group.visible = true;
  } else {
    viewmodel.updateView(null, dtReal, 0, 0, 0);
    viewmodel.group.visible = false;
  }
  if (QA_HERO_MODE) viewmodel.group.visible = false;

  world.setViewPos(rig.camera.position);
  world.updateReplica(dtReal, view);
  applyQaWaterView(rig, world, true);
  vfx.update(dtReal, rig.camera.position);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
  AudioEngine.setListener(
    rig.camera.position.x, rig.camera.position.y, rig.camera.position.z,
    forward.x, forward.z,
  );
  audio.setEnvironmentState(world.isEyeUnderwater(rig.camera.position) ? 'underwater' : 'open');
  renderer.followSunTarget(new THREE.Vector3(rig.camera.position.x, 0, rig.camera.position.z));
  renderer.followViewer(rig.camera.position);

  hud.syncReplicaState(view, dtReal);
  hud.syncOnlineState(replicaOnlineHudState(game, view));
  hud.drawMinimapReplica(game.mapDef, view, () => hud.minimapContext(), dtReal);
  if (hud.isTacMapOpen()) hud.drawTacMapReplica(game.mapDef, view);
  const interaction = !spectating && local?.alive && !paused && !hud.isTacMapOpen() && !hud.isInventoryOpen()
    ? findReplicaInteractInfo(view, local)
    : null;
  hud.interactPrompt(interaction?.prompt || null);
  hud.showLootPanel(interaction?.loot ?? null);

  if (view.phase === 'results' && !resultsShown) {
    rig.resetAimState();
    renderer.setScopeActive(false);
    resultsShown = true;
    showReplicaResults(view, game.localActorId);
  }
  renderer.render(dtReal);
}

function replicaOnlineHudState(game: ReplicaLiveGame, view: GameStateView | null): OnlineHudState {
  const state = game.coordinator.state;
  const metric = game.onlineMetrics.get(game.onlineContext?.hostPeerId ?? '');
  const local = view?.actors.find((actor) => actor.id === game.localActorId) ?? null;
  const teammates = !view || local?.teamId === null || local?.teamId === undefined
    ? []
    : view.actors
      .filter((actor) => actor.id !== game.localActorId && actor.teamId === local.teamId)
      .map((actor) => ({
        participantId: `actor:${actor.id}`,
        displayName: actor.displayName,
        alive: actor.alive,
      }));
  return {
    connection: coordinatorHudConnection(state),
    rttMs: metric?.rttMs ?? null,
    packetLossPercent: metric?.packetLossPercent ?? null,
    teammates,
    diagnostics: view ? {
      hostTick: view.hostTick,
      snapshotBytes: undefined,
      inputRate: 60,
    } : null,
  };
}

function coordinatorHudConnection(state: OnlineMatchCoordinatorState): OnlineHudState['connection'] {
  if (state === 'active') return 'connected';
  if (state === 'reconnecting') return 'reconnecting';
  if (state === 'failed') return 'failed';
  if (state === 'ended' || state === 'disposed') return 'disconnected';
  return 'connecting';
}

function matchOnlineHudState(game: MatchLiveGame): OnlineHudState {
  const values = [...game.onlineMetrics.values()];
  const finiteRtt = values.map((metric) => metric.rttMs).filter((value): value is number => value !== null);
  const finiteLoss = values
    .map((metric) => metric.packetLossPercent)
    .filter((value): value is number => value !== null);
  const local = game.match.localActor;
  const view = local ? game.match.toGameStateView(local.id) : null;
  const localTeamId = game.match.localTeamId;
  const teammates = !local || localTeamId === null || !view
    ? []
    : view.actors
      .filter((actor) => actor.id !== local.id && actor.teamId === localTeamId)
      .map((actor) => ({
        participantId: `actor:${actor.id}`,
        displayName: actor.displayName,
        alive: actor.alive,
      }));
  const network = game.coordinator?.hostSession?.metrics;
  return {
    connection: coordinatorHudConnection(game.coordinator?.state ?? 'idle'),
    rttMs: finiteRtt.length > 0 ? Math.max(...finiteRtt) : null,
    packetLossPercent: finiteLoss.length > 0 ? Math.max(...finiteLoss) : null,
    teammates,
    diagnostics: network ? {
      hostTick: game.match.hostTick,
      snapshotBytes: network.snapshotSizes.p50,
      inputRate: 60,
    } : null,
  };
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

/** Read-only proximity hint. The host remains the sole pickup/open resolver. */
function findReplicaInteractInfo(view: GameStateView, actor: ActorView): InteractInfo | null {
  const chest = view.chests
    .filter((candidate) => !candidate.opened)
    .map((candidate) => ({
      candidate,
      distance: Math.hypot(candidate.x - actor.position.x, candidate.z - actor.position.z),
    }))
    .filter(({ candidate, distance }) => distance <= 4 && Math.abs(candidate.y - actor.position.y) <= 3)
    .sort((left, right) => left.distance - right.distance || left.candidate.id - right.candidate.id)[0]?.candidate;
  if (chest) {
    const prompt = chest.kind === 'vault'
      ? t('interact.openVault')
      : chest.kind === 'elite'
        ? t('interact.openElite')
        : t('interact.openChest');
    return { prompt, loot: null };
  }

  const item = view.loot
    .map((candidate) => ({
      candidate,
      distance: Math.hypot(candidate.x - actor.position.x, candidate.z - actor.position.z),
    }))
    .filter(({ candidate, distance }) => distance <= 4 && Math.abs(candidate.y - actor.position.y) <= 3)
    .sort((left, right) => left.distance - right.distance || left.candidate.id - right.candidate.id)[0]?.candidate;
  if (!item) return null;

  const inventoryFull = item.kind === 'weapon'
    && actor.inventory?.slots.every((slot) => slot !== null) === true;
  if (item.kind === 'weapon') {
    const def = WEAPONS[item.weaponId];
    return {
      prompt: '',
      loot: {
        iconId: item.weaponId,
        name: t(`wpn.${item.weaponId}` as never),
        typeText: t('loot.type.weapon'),
        rarityText: t(`rarity.${item.rarity}` as never).toUpperCase(),
        rarityColor: RARITY_CSS[item.rarity],
        metaText: `${t(`ammo.${def.ammoType}` as never)} · ${item.ammoInMag}/${def.magSize}`,
        keyLabel: prettyBind(getSettings().bindings.interact),
        inventoryFull,
      },
    };
  }
  if (item.kind === 'heal') {
    const medkit = item.itemId === 'medkit';
    return {
      prompt: '',
      loot: {
        iconId: item.itemId,
        name: medkit ? t('bind.useMedkit') : t('bind.useShield'),
        typeText: t('loot.type.heal'),
        rarityText: t(medkit ? 'rarity.rare' : 'rarity.uncommon').toUpperCase(),
        rarityColor: medkit ? '#ff7d89' : '#53d8ff',
        metaText: `×${item.count}`,
        keyLabel: prettyBind(getSettings().bindings.interact),
        inventoryFull: false,
      },
    };
  }
  return { prompt: '', loot: null };
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

function showReplicaResults(view: GameStateView, localActorId: number): void {
  const actor = view.actors.find((candidate) => candidate.id === localActorId) ?? null;
  const won = didLocalActorWinView(view, localActorId);
  hud.show(false);
  live?.player.releaseLock();
  audio.setMusicState(won ? 'victory' : 'defeat');
  audio.victoryFanfare(won);
  menus.showResults({
    won,
    winnerName: view.winner?.kind === 'team'
      ? t('results.teamName', { n: view.winner.teamId + 1 })
      : view.winner?.displayName ?? '—',
    placement: actor?.placement ?? view.actors.length,
    kills: actor?.stats.kills ?? 0,
    damage: actor?.stats.damageDealt ?? 0,
    accuracy: actor && actor.stats.shotsFired > 0 ? actor.stats.shotsHit / actor.stats.shotsFired : 0,
    headshots: actor?.stats.headshots ?? 0,
    survivalTime: actor?.stats.survivalTime ?? 0,
  });
}

function didLocalActorWin(match: Match): boolean {
  if (match.localActorId === null || match.winnerView === null) return false;
  return match.winnerView.kind === 'team'
    ? match.localTeamId === match.winnerView.teamId
    : match.localActorId === match.winnerView.actorId;
}

function didLocalActorWinView(view: GameStateView | null, localActorId: number): boolean {
  if (!view?.winner) return false;
  if (view.winner.kind === 'actor') return view.winner.actorId === localActorId;
  const local = view.actors.find((actor) => actor.id === localActorId);
  return local?.teamId !== null && local?.teamId === view.winner.teamId;
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
