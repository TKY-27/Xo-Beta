import { Match } from '../../../src/sim/match';
import { emptyCommand, type InputCommand } from '../../../src/sim/input';
import { ensureWorldReady, loadMap } from '../../../src/world';
import { normalizeMapForMatch } from '../../../src/world/builder';
import { HostLagCompensation } from '../../../src/net/lagCompensation';
import { ClientReplica } from '../../../src/net/clientReplica';
import {
  ClientMovementPredictionWorld,
  createClientMovementPredictionState,
  type ClientMovementPredictionState,
} from '../../../src/net/clientMovementPrediction';
import { MATCH } from '../../../src/core/balance';
import {
  HostAuthoritativeMatchSession,
  type HostNetworkMetrics,
} from '../../../src/net/hostMatchSession';
import {
  OnlineMatchCoordinator,
  type OnlineMatchCoordinatorState,
} from '../../../src/net/onlineMatchCoordinator';
import {
  PrivateRoomController,
  type OnlineRoomMatchContext,
  type SignalingFactory,
} from '../../../src/net/privateRoom';
import { getSettings, type SkinId } from '../../../src/core/settings';
import type { MatchStartPayload } from '../../../src/net/matchStart';
import type { LobbyViewModel } from '../../../src/ui/onlineLobby';

declare global {
  interface Window {
    __xoPhase3TestSignalingFactory?: SignalingFactory;
    __xoGameplayTest?: GameplayTestApi;
  }
}

interface GameplaySnapshot {
  readonly role: 'idle' | 'host' | 'guest';
  readonly screen: 'main' | 'create' | 'join' | 'lobby' | 'runtime';
  readonly coordinatorState: OnlineMatchCoordinatorState | 'none';
  readonly phase: string | null;
  readonly hostTick: number;
  readonly networkTick: number | null;
  readonly aliveCount: number | null;
  readonly localActorId: number | null;
  readonly actors: readonly {
    id: number;
    name: string;
    alive: boolean;
    deployed: boolean;
    health: number;
    shots: number;
    teamId: number | null;
    ownership: 'local-human' | 'remote-human' | 'bot';
    crouched: boolean;
    inventory: { selected: number; slots: readonly (unknown | null)[]; ammo: Readonly<Record<string, number>> } | null;
  }[];
  readonly destructibles: readonly { id: string; destroyed: boolean }[];
  readonly lobbyPlayers: readonly {
    participantId: string;
    displayName: string;
    skinId: SkinId;
    teamId: number | null;
    isHost: boolean;
    isLocal: boolean;
    connected: boolean;
    ready: boolean;
    directState: string;
  }[];
  readonly lobbyMap: LobbyViewModel['map'] | null;
  readonly lobbyMode: LobbyViewModel['mode'] | null;
  readonly winner: { readonly kind: 'actor'; readonly actorId: number; readonly displayName: string } | { readonly kind: 'team'; readonly teamId: number } | null;
  readonly events: readonly string[];
  readonly notices: readonly string[];
  readonly inviteLink: string;
  readonly inviteCode: string;
  readonly startPayload: MatchStartPayload | null;
  readonly error: string | null;
  readonly inputPackets: number;
  readonly directStates: readonly string[];
  readonly hostDestructibleCount: number | null;
  readonly guestDestructibleCount: number | null;
  readonly lagTelemetry: ReturnType<HostLagCompensation['resolveAcceptedShot']> | null;
  readonly hostMetrics: HostNetworkMetrics | null;
  readonly predictionTelemetry: ReturnType<ClientReplica['telemetry']> | null;
}

interface GameplayTestApi {
  latest: GameplaySnapshot;
  controller: PrivateRoomController;
  readonly actions: {
    setScreen(screen: GameplaySnapshot['screen']): void;
    setMode(mode: 'ffa' | 'ffa-bot-fill' | 'teams' | 'teams-bot-fill' | 'humans-vs-bots'): Promise<void>;
    setTeam(participantId: string, teamId: number): Promise<void>;
    setMap(mapId: 'neocity' | 'oldfront' | 'eden' | 'ashara'): Promise<void>;
    setSkin(skinId: SkinId): Promise<void>;
    setInput(input: Partial<InputCommand> | null): void;
    resetPredictionTelemetry(): void;
    fastForwardTransport(): boolean;
    prepareCombat(): boolean;
    fire(): void;
    breakGlass(): boolean;
    breakUpperGlass(): boolean;
    pickupWeapons(): readonly { actorId: number; slot: number }[];
    finishMatch(winnerActorId?: number): boolean;
    eliminateHost(): boolean;
    endHostMatch(): void;
    returnToMenu(): Promise<void>;
  };
}

const factory = window.__xoPhase3TestSignalingFactory;
if (!factory) throw new Error('Browser test signaling factory was not installed');

const screens = ['main-menu', 'create-room-menu', 'join-room-menu', 'online-lobby-menu', 'runtime-menu'] as const;
const showScreen = (screen: GameplaySnapshot['screen']): void => {
  const id = screen === 'main' ? 'main-menu'
    : screen === 'create' ? 'create-room-menu'
      : screen === 'join' ? 'join-room-menu'
        : screen === 'lobby' ? 'online-lobby-menu' : 'runtime-menu';
  for (const candidate of screens) document.getElementById(candidate)?.classList.toggle('hidden', candidate !== id);
};

let coordinator: OnlineMatchCoordinator<ClientMovementPredictionState> | null = null;
let contextKey = '';
let hostMatch: Match | null = null;
let hostSession: HostAuthoritativeMatchSession | null = null;
let predictionWorld: ClientMovementPredictionWorld | null = null;
let latestLobby: LobbyViewModel | null = null;
let latestError: string | null = null;
let currentInput: InputCommand = emptyCommand();
let inputPackets = 0;
let hostDestructibleCount: number | null = null;
let guestDestructibleCount: number | null = null;
let lagTelemetry: ReturnType<HostLagCompensation['resolveAcceptedShot']> | null = null;
let startPayload: MatchStartPayload | null = null;
const events: string[] = [];
const notices: string[] = [];
let screen: GameplaySnapshot['screen'] = 'main';

class ObservedLagCompensation extends HostLagCompensation {
  override resolveAcceptedShot(input: Parameters<HostLagCompensation['resolveAcceptedShot']>[0]) {
    const result = super.resolveAcceptedShot(input);
    lagTelemetry = result;
    return result;
  }
}

const state: GameplayTestApi = {
  latest: makeSnapshot(),
  controller: null as unknown as PrivateRoomController,
  actions: {
    setScreen(next) {
      screen = next;
      showScreen(next);
      publish();
    },
    async setMode(mode) {
      await controller.setMode(mode);
    },
    async setTeam(participantId, teamId) {
      await controller.setTeam(participantId, teamId as 0 | 1);
    },
    async setMap(mapId) {
      await controller.setMap(mapId);
    },
    async setSkin(skinId) {
      await controller.setOwnSkin(skinId);
    },
    setInput(input) {
      currentInput = input ? { ...emptyCommand(), ...input } : emptyCommand();
      coordinator?.setLocalInput(currentInput);
    },
    resetPredictionTelemetry() {
      coordinator?.replica?.resetTelemetry();
    },
    fastForwardTransport() {
      if (!hostMatch) return false;
      hostMatch.transportT = 1;
      return true;
    },
    prepareCombat() {
      if (!hostMatch) return false;
      const host = hostMatch.actors.find((actor) => actor.id === 1);
      const guest = hostMatch.actors.find((actor) => actor.id === 2);
      if (!host || !guest) return false;
      const hostSurface = hostMatch.phys.surfaceAt(0, 0, 300, 500);
      const guestSurface = hostMatch.phys.surfaceAt(0, 6, 300, 500);
      if (hostSurface === null || guestSurface === null) return false;
      host.body.teleport(0, hostSurface + 1.05, 0);
      guest.body.teleport(0, guestSurface + 1.05, 6);
      host.body.velocity.x = 0; host.body.velocity.y = 0; host.body.velocity.z = 0;
      guest.body.velocity.x = 0; guest.body.velocity.y = 0; guest.body.velocity.z = 0;
      host.deployed = true; guest.deployed = true;
      host.state = 'ground'; guest.state = 'ground';
      // Keep the host alive through the single test shot; elimination is
      // asserted separately through the authoritative match pipeline below.
      host.health = 100; host.shield = 0;
      guest.health = 100; guest.shield = 0;
      const def = 'pistol' as const;
      const weapon = { kind: 'weapon' as const, weaponId: def, rarity: 'common' as const, ammoInMag: 12 };
      const added = guest.inv.add(weapon);
      if (!added.ok || added.slot === undefined) return false;
      guest.inv.ammo.light = 60;
      guest.inv.select(added.slot);
      // Yaw zero points toward -Z in the shared movement/weapon convention;
      // the guest stands at z=6 and must aim back toward the host at z=0.
      guest.yaw = 0;
      guest.pitch = 0;
      hostMatch.phase = 'live';
      hostMatch.phaseTime = 0;
      return true;
    },
    fire() {
      currentInput = { ...emptyCommand(), firePressed: true, yaw: 0, pitch: 0 };
      coordinator?.setLocalInput(currentInput);
    },
    breakGlass() {
      const destructible = hostMatch?.combat.destructibleList().find((candidate) => candidate.type === 'glass' && candidate.alive);
      if (!destructible || !hostMatch) return false;
      return hostMatch.combat.damageDestructible(destructible.id, destructible.hp + 1);
    },
    breakUpperGlass() {
      const destructible = hostMatch?.combat.destructibleList().find((candidate) => (
        candidate.type === 'glass' && candidate.alive && candidate.geo.y > 4.5
      ));
      if (!destructible || !hostMatch) return false;
      return hostMatch.combat.damageDestructible(destructible.id, destructible.hp + 1);
    },
    pickupWeapons() {
      if (!hostMatch) return [];
      const picked: Array<{ actorId: number; slot: number }> = [];
      for (const actor of hostMatch.actors.filter((candidate) => hostMatch!.isHumanActor(candidate))) {
        const position = actor.body.position;
        const item = hostMatch.loot.spawnWeapon(position.x, position.y, position.z, {
          kind: 'weapon', weaponId: 'pistol', rarity: 'common', ammoInMag: 12,
        }, hostMatch.rng);
        const result = hostMatch.loot.pickup(item, actor, false, actor.preferredItemSlots);
        if (result === false) continue;
        const slot = actor.inv.slots.findIndex((candidate) => candidate?.kind === 'weapon' && candidate.weaponId === 'pistol');
        if (slot >= 0) {
          actor.inv.select(slot);
          picked.push({ actorId: actor.id, slot });
        }
      }
      return picked;
    },
    eliminateHost() {
      const host = hostMatch?.actors.find((actor) => actor.id === 1);
      return hostMatch !== null && host !== undefined ? hostMatch.eliminateActor(host) : false;
    },
    finishMatch(winnerActorId = 1) {
      if (!hostMatch) return false;
      const winner = hostMatch.actors.find((actor) => actor.id === winnerActorId && actor.alive);
      if (!winner) return false;
      const winnerTeam = hostMatch.rosterEntryForActor(winner.id)?.teamId ?? null;
      let eliminated = false;
      for (const actor of hostMatch.actors) {
        if (!actor.alive || actor.id === winner.id) continue;
        if (winnerTeam !== null && hostMatch.rosterEntryForActor(actor.id)?.teamId === winnerTeam) continue;
        eliminated = hostMatch.eliminateActor(actor) || eliminated;
      }
      return eliminated;
    },
    endHostMatch() {
      coordinator?.endHostMatch();
    },
    async returnToMenu() {
      coordinator?.dispose();
      coordinator = null;
      hostSession?.dispose();
      hostSession = null;
      predictionWorld?.dispose();
      predictionWorld = null;
      hostMatch = null;
      await controller.leaveRoom(true);
      latestLobby = null;
      latestError = null;
      startPayload = null;
      events.length = 0;
      notices.length = 0;
      inputPackets = 0;
      hostDestructibleCount = null;
      guestDestructibleCount = null;
      lagTelemetry = null;
      contextKey = '';
      screen = 'main';
      showScreen('main');
      publish();
    },
  },
};

const controller = new PrivateRoomController({
  buildId: 'browser-test-build',
  baseUrl: `${location.origin}${location.pathname}`,
  signalingFactory: factory,
  onView(view) {
    latestLobby = view;
    if (screen !== 'runtime') screen = 'lobby';
    showScreen(screen);
    if (view.inviteLink) document.getElementById('online-room-code')!.textContent = view.inviteCode;
    renderLobby(view);
    publish();
  },
  onError(code) {
    latestError = code;
    const status = document.getElementById('lobby-status');
    if (status) { status.dataset.state = 'error'; status.textContent = code; }
    publish();
  },
  onGameMessage(peerId, message) {
    const active = ensureCoordinator();
    void active.handleGameMessage(peerId, message).catch((error: unknown) => {
      latestError = error instanceof Error ? error.message : String(error);
      publish();
    });
  },
  onGameStateChange(peerId, connectionState) {
    coordinator?.handleConnectionState(peerId, connectionState);
    publish();
  },
  onGameDisconnected(event) {
    coordinator?.handleConnectionState(event.peerId, event.state);
    publish();
  },
  onHostDisconnected(event) {
    coordinator?.handleConnectionState(event.peerId, event.state);
    publish();
  },
  authorizeParticipantReconnect({ participantId, peerId }) {
    return coordinator?.canAcceptReconnectedParticipant(participantId, peerId) === true;
  },
  onParticipantReconnected({ peerId, binding }) {
    const result = coordinator?.prepareAcceptedReconnectedParticipant(binding.participantId, peerId);
    if (!result?.accepted) return false;
    return {
      accepted: true as const,
      commit: result.commit,
      rollback: result.rollback,
    };
  },
  onMatchStartAccepted: async (matchContext) => {
    const active = ensureCoordinator(matchContext);
    try {
      startPayload = await active.beginHost();
    } catch (error) {
      latestError = error instanceof Error ? error.stack ?? error.message : String(error);
      publish();
    }
  },
});
state.controller = controller;
window.__xoGameplayTest = state;

document.getElementById('open-create')?.addEventListener('click', () => {
  screen = 'create'; showScreen('create'); publish();
});
document.getElementById('open-join')?.addEventListener('click', () => {
  screen = 'join'; showScreen('join'); publish();
});
document.getElementById('create-room-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  void controller.createRoom({
    displayName: inputValue('create-display-name'),
    skinId: 'vanguard',
    preferredItemSlots: getSettings().preferredItemSlots,
  }).catch(recordError);
});
document.getElementById('join-room-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  void controller.joinRoom({
    invite: inputValue('join-room-invite'),
    displayName: inputValue('join-display-name'),
    skinId: 'vanguard',
    preferredItemSlots: getSettings().preferredItemSlots,
  }).catch(recordError);
});
document.getElementById('btn-lobby-ready')?.addEventListener('click', () => {
  const local = latestLobby?.players.find((player) => player.isLocal);
  void controller.setReady(!(local?.ready ?? false)).catch(recordError);
});
document.getElementById('btn-lobby-start')?.addEventListener('click', () => void controller.requestStart().catch(recordError));
document.getElementById('btn-lobby-leave')?.addEventListener('click', () => void state.actions.returnToMenu().catch(recordError));
document.getElementById('lobby-mode')?.addEventListener('change', (event) => {
  const value = (event.target as HTMLSelectElement).value;
  if (value === 'ffa' || value === 'ffa-bot-fill' || value === 'teams' || value === 'teams-bot-fill' || value === 'humans-vs-bots') void state.actions.setMode(value).catch(recordError);
});
document.getElementById('btn-runtime-deploy')?.addEventListener('click', () => {
  state.actions.fastForwardTransport();
  publish();
});
document.getElementById('btn-runtime-combat-setup')?.addEventListener('click', () => {
  state.actions.prepareCombat(); publish();
});
document.getElementById('btn-runtime-fire')?.addEventListener('click', () => state.actions.fire());
document.getElementById('btn-runtime-glass')?.addEventListener('click', () => { state.actions.breakGlass(); publish(); });
document.getElementById('btn-runtime-eliminate')?.addEventListener('click', () => { state.actions.eliminateHost(); publish(); });
document.getElementById('btn-runtime-end')?.addEventListener('click', () => state.actions.endHostMatch());
document.getElementById('btn-runtime-leave')?.addEventListener('click', () => void state.actions.returnToMenu().catch(recordError));

window.setInterval(() => {
  coordinator?.update(1 / 60);
  publish();
}, 16);

function ensureCoordinator(provided?: OnlineRoomMatchContext): OnlineMatchCoordinator<ClientMovementPredictionState> {
  const context = provided ?? controller.matchContext;
  if (!context) throw new Error('Online room context is unavailable');
  const key = `${context.role}:${context.localParticipantId}:${context.matchSessionBinding}`;
  if (coordinator && contextKey === key) return coordinator;
  coordinator?.dispose();
  contextKey = key;
  coordinator = new OnlineMatchCoordinator({
    context,
    room: controller,
    resolveMap: async (mapId) => {
      await ensureWorldReady();
      return normalizeMapForMatch(loadMap(mapId).def);
    },
    createHostSession: async (input) => {
      await ensureWorldReady();
      hostMatch = new Match({
        mapDef: input.map,
        seed: input.payload.seed,
        difficulty: input.payload.difficulty,
        mode: input.payload.mode,
        roster: input.payload.roster,
      });
      hostDestructibleCount = input.map.destructibles.length;
      hostSession = new HostAuthoritativeMatchSession(
        hostMatch,
        input.bindings,
        input.transport,
        input.encodeSnapshot,
        {
          lagCompensation: new ObservedLagCompensation(),
          onEvent: input.onEvent,
          onPresenceNotice: input.onPresenceNotice,
        },
      );
      return hostSession;
    },
    loadGuest: async (input) => {
      guestDestructibleCount = input.map.destructibles.length;
      predictionWorld?.dispose();
      const predictionMap = input.map;
      const initialState = createClientMovementPredictionState({
        x: predictionMap.transportRoute.from[0],
        y: MATCH.transportAltitude,
        z: predictionMap.transportRoute.from[1],
      }, { deployed: false, grounded: false, state: 'ground' });
      predictionWorld = await ClientMovementPredictionWorld.create({
        mapDef: predictionMap,
        actorId: input.localActorId,
        initialState,
        displayName: input.payload.roster.find((entry) => entry.actorId === input.localActorId)?.displayName,
        accentColor: input.payload.roster.find((entry) => entry.actorId === input.localActorId)?.accentColor,
      });
    },
    createGuestReplica: ({ localActorId }) => {
      if (!predictionWorld) throw new Error('Guest prediction world was not prepared');
      const initialState = predictionWorld.captureState();
      return new ClientReplica<ClientMovementPredictionState>({
        localActorId,
        movementStep: predictionWorld.movementStep,
        initialPredictionState: initialState,
        prediction: { initialState },
      });
    },
    sampleLocalInput: () => {
      inputPackets++;
      const sampled = currentInput;
      // Browser actions represent one input sample. Consume edge bits after
      // returning them so a single test click cannot replay fire/break/jump
      // on every subsequent 60 Hz packet.
      currentInput = {
        ...currentInput,
        jumpPressed: false,
        crouchPressed: false,
        firePressed: false,
        reloadPressed: false,
        interactPressed: false,
        meleePressed: false,
        dropWeaponPressed: false,
        dashPressed: false,
        grapplePressed: false,
        grappleRelease: false,
        poundPressed: false,
        shieldPressed: false,
        medkitPressed: false,
        slotRequest: null,
      };
      return sampled;
    },
    onStateChange: (next) => {
      if (next === 'active' || next === 'countdown') screen = 'runtime';
      publish();
    },
    onRuntimeReady: (role, payload) => {
      // Both roles receive the same canonical payload; retaining it here lets
      // the browser assertion prove that the guest validated the host's map,
      // roster, seed, and start tick rather than merely entering the lobby.
      startPayload = payload;
      if (role === 'host') screen = 'runtime';
      publish();
    },
    onActivated: () => publish(),
    onAuthoritativeEvent: (event) => {
      events.push(event.type);
      if (events.length > 80) events.shift();
      publish();
    },
    onPresenceNotice: (kind, name) => {
      notices.push(`${kind}:${name}`);
      publish();
    },
    onEnd: (reason) => {
      notices.push(`end:${reason}`);
      publish();
    },
    onProtocolError: (_peerId, error) => {
      latestError = error.message;
      publish();
    },
  });
  return coordinator;
}

function renderLobby(view: LobbyViewModel): void {
  const participants = document.getElementById('lobby-participants');
  if (participants) participants.textContent = view.players.map((player) => `${player.displayName}:${player.connected ? 'connected' : 'disconnected'}:${player.ready ? 'ready' : 'waiting'}`).join(' | ');
  const mode = document.getElementById('lobby-mode') as HTMLSelectElement | null;
  if (mode && mode.value !== view.mode && [...mode.options].some((option) => option.value === view.mode)) mode.value = view.mode;
  const status = document.getElementById('lobby-status');
  if (status) { status.dataset.state = view.statusMessage ? 'error' : 'ok'; status.textContent = view.statusMessage ?? `${view.players.length} participant(s)`; }
}

function publish(): void {
  const active = coordinator;
  const view = active?.replica?.view ?? (hostMatch ? hostMatch.toGameStateView(hostMatch.localActorId ?? 1) : null);
  const actors = view?.actors.map((actor) => ({
    id: actor.id,
    name: actor.displayName,
    alive: actor.alive,
    deployed: actor.deployed,
    health: Math.round(actor.health),
    shots: Math.round(actor.stats.shotsFired),
    teamId: actor.teamId,
    ownership: actor.ownership.kind === 'bot' ? 'bot' as const : actor.ownership.kind === 'local-human' ? 'local-human' as const : 'remote-human' as const,
    crouched: actor.crouched,
    inventory: actor.inventory ? {
      selected: actor.inventory.selected,
      slots: actor.inventory.slots.map((item) => item ? { ...item } : null),
      ammo: {
        light: actor.inventory.ammo.light,
        medium: actor.inventory.ammo.medium,
        shells: actor.inventory.ammo.shells,
        heavy: actor.inventory.ammo.heavy,
      },
    } : null,
  })) ?? [];
  const snapshot: GameplaySnapshot = Object.freeze({
    role: controller.active ? controller.matchContext?.role ?? 'idle' : 'idle',
    screen,
    coordinatorState: active?.state ?? 'none',
    phase: view?.phase ?? hostMatch?.phase ?? null,
    hostTick: view?.hostTick ?? hostMatch?.hostTick ?? 0,
    networkTick: active ? Number((active as unknown as { networkTick?: number }).networkTick ?? 0) : null,
    aliveCount: view ? view.actors.filter((actor) => actor.alive).length : hostMatch?.aliveCount ?? null,
    localActorId: view?.localActorId ?? hostMatch?.localActorId ?? null,
    actors,
    destructibles: Object.freeze(view?.destructibles.map((destructible) => ({
      id: destructible.id,
      destroyed: destructible.destroyed,
    })) ?? []),
    lobbyPlayers: Object.freeze(latestLobby?.players.map((player) => ({
      participantId: player.participantId,
      displayName: player.displayName,
      skinId: player.skinId,
      teamId: player.teamId,
      isHost: player.isHost,
      isLocal: player.isLocal,
      connected: player.connected,
      ready: player.ready,
      directState: player.directState,
    })) ?? []),
    lobbyMap: latestLobby?.map ?? null,
    lobbyMode: latestLobby?.mode ?? null,
    winner: view?.winner ?? null,
    events: Object.freeze([...events]),
    notices: Object.freeze([...notices]),
    inviteLink: latestLobby?.inviteLink ?? '',
    inviteCode: latestLobby?.inviteCode ?? '',
    startPayload,
    error: latestError,
    inputPackets,
    directStates: Object.freeze(latestLobby?.players.map((player) => player.directState) ?? []),
    hostDestructibleCount,
    guestDestructibleCount,
    lagTelemetry,
    hostMetrics: hostSession?.metrics ?? null,
    predictionTelemetry: active?.replica?.telemetry() ?? null,
  });
  state.latest = snapshot;
  document.documentElement.dataset.xoGameplayState = snapshot.coordinatorState;
  document.documentElement.dataset.xoGameplayPhase = snapshot.phase ?? '';
  document.documentElement.dataset.xoGameplayEvents = snapshot.events.join(',');
  const lobbyState = document.getElementById('lobby-state');
  if (lobbyState && screen === 'lobby') lobbyState.textContent = JSON.stringify(snapshot, null, 2);
  const runtimeState = document.getElementById('runtime-state');
  if (runtimeState && screen === 'runtime') runtimeState.textContent = JSON.stringify(snapshot, null, 2);
  const runtimeStatus = document.getElementById('runtime-status');
  if (runtimeStatus) runtimeStatus.textContent = `${snapshot.coordinatorState} / ${snapshot.phase ?? 'not started'}`;
}

function makeSnapshot(): GameplaySnapshot {
  return Object.freeze({
    role: 'idle', screen: 'main', coordinatorState: 'none', phase: null, hostTick: 0, networkTick: null,
    aliveCount: null, localActorId: null, actors: Object.freeze([]), destructibles: Object.freeze([]), lobbyPlayers: Object.freeze([]), lobbyMap: null, lobbyMode: null, winner: null, events: Object.freeze([]),
    notices: Object.freeze([]), inviteLink: '', inviteCode: '', startPayload: null,
    error: null, inputPackets: 0, directStates: Object.freeze([]),
    hostDestructibleCount: null, guestDestructibleCount: null, lagTelemetry: null,
    hostMetrics: null, predictionTelemetry: null,
  });
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value;
}

function recordError(error: unknown): void {
  latestError = error instanceof Error ? error.stack ?? error.message : String(error);
  publish();
}

void publish();
