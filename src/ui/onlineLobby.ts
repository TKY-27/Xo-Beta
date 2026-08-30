import type { Difficulty } from '../core/balance';
import { getSettings, type SkinId } from '../core/settings';
import { t, type TextKey } from '../core/i18n';
import type { MatchMode, TeamId } from '../sim/roster';
import type { MapId } from '../world';
import { SkinSelector, skinName } from './skinSelector';
import type { MapMenuOption } from './ui';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export type RoomUiErrorCode =
  | 'invalid-invite'
  | 'invalid-name'
  | 'incompatible'
  | 'room-full'
  | 'wrong-secret'
  | 'discovery-failed'
  | 'direct-failed';

export class RoomUiError extends Error {
  constructor(readonly code: RoomUiErrorCode) {
    super(code);
    this.name = 'RoomUiError';
  }
}

export interface LobbyPlayerView {
  slotId: number;
  participantId: string;
  displayName: string;
  skinId: SkinId;
  teamId: TeamId | null;
  isHost: boolean;
  isLocal: boolean;
  connected: boolean;
  ready: boolean;
  pingMs: number | null;
  directState: 'connecting' | 'open' | 'failed' | 'disconnected';
}

export interface RelayHealthView {
  url: string;
  state: 'connecting' | 'open' | 'closed' | 'failed';
}

export interface LobbyViewModel {
  inviteCode: string;
  inviteLink: string;
  isHost: boolean;
  localParticipantId: string;
  players: readonly LobbyPlayerView[];
  map: MapId;
  mode: MatchMode;
  difficulty: Difficulty;
  rosterSummary: string;
  rosterLines: readonly string[];
  relays: readonly RelayHealthView[];
  startEligible: boolean;
  experimentalStartEnabled: boolean;
  statusMessage?: string;
}

export interface CreateRoomRequest {
  displayName: string;
  skinId: SkinId;
}

export interface JoinRoomRequest extends CreateRoomRequest {
  invite: string;
}

export interface OnlineLobbyActions {
  createRoom(request: CreateRoomRequest): Promise<void>;
  joinRoom(request: JoinRoomRequest): Promise<void>;
  leaveRoom(): Promise<void> | void;
  setReady(ready: boolean): Promise<void> | void;
  setOwnDisplayName(displayName: string): Promise<void> | void;
  setOwnSkin(skinId: SkinId): Promise<void> | void;
  setMap(map: MapId): Promise<void> | void;
  setMode(mode: MatchMode): Promise<void> | void;
  setBotFill(botFill: boolean): Promise<void> | void;
  setDifficulty(difficulty: Difficulty): Promise<void> | void;
  setTeam(participantId: string, teamId: TeamId): Promise<void> | void;
  requestStart(): Promise<void> | void;
}

interface OnlineLobbyUiOptions {
  maps: readonly MapMenuOption[];
  actions: OnlineLobbyActions;
  showScreen(id: 'main-menu' | 'create-room-menu' | 'join-room-menu' | 'online-lobby-menu'): void;
}

const MODE_OPTIONS: ReadonlyArray<[MatchMode, TextKey, boolean]> = [
  ['ffa-bot-fill', 'lobby.modeFfa', true],
  ['ffa', 'lobby.modeFfa', false],
  ['teams-bot-fill', 'lobby.modeTeams', true],
  ['teams', 'lobby.modeTeams', false],
  ['humans-vs-bots', 'lobby.modeHumansBots', true],
];

const errorKeys: Record<RoomUiErrorCode, TextKey> = {
  'invalid-invite': 'room.invalidInvite',
  'invalid-name': 'room.invalidName',
  incompatible: 'room.incompatible',
  'room-full': 'room.full',
  'wrong-secret': 'room.wrongSecret',
  'discovery-failed': 'room.discoveryFailed',
  'direct-failed': 'room.directFailed',
};

export class OnlineLobbyUi {
  private readonly skinSelectors: SkinSelector[];
  private view: LobbyViewModel | null = null;
  private busy = false;

  constructor(private readonly options: OnlineLobbyUiOptions) {
    this.skinSelectors = [
      new SkinSelector($('create-room-skin-selector')),
      new SkinSelector($('join-room-skin-selector')),
      // The shared Settings source triggers the room controller's listener, so
      // one click updates both the 3D preview and exactly one lobby command.
      new SkinSelector($('lobby-skin-selector')),
    ];
    this.bindSetupFlows();
    this.bindLobbyControls();
    this.populateHostControls();
  }

  dispose(): void {
    for (const selector of this.skinSelectors) selector.dispose();
  }

  showCreate(): void {
    this.clearSetupErrors();
    this.options.showScreen('create-room-menu');
    requestAnimationFrame(() => $('create-display-name').focus());
  }

  showJoin(invite = ''): void {
    this.clearSetupErrors();
    const input = $<HTMLTextAreaElement>('join-room-invite');
    if (invite) input.value = invite;
    this.options.showScreen('join-room-menu');
    requestAnimationFrame(() => (input.value ? $('join-display-name').focus() : input.focus()));
  }

  renderLobby(view: LobbyViewModel): void {
    this.view = view;
    this.options.showScreen('online-lobby-menu');
    $('online-room-code').textContent = view.inviteCode;
    this.renderPlayers(view);
    this.renderHostControls(view);
    this.renderRoster(view);
    this.renderNetwork(view);
    this.renderStart(view);
  }

  showError(code: RoomUiErrorCode, target: 'create' | 'join' | 'lobby' = 'lobby'): void {
    const message = t(errorKeys[code]);
    if (target === 'lobby') $('lobby-status-message').textContent = message;
    else $(`${target}-room-error`).textContent = message;
  }

  hostLeft(): void {
    if (this.view?.isHost === false) $('lobby-status-message').textContent = t('room.hostLeft');
  }

  private bindSetupFlows(): void {
    $('btn-create-room-back').addEventListener('click', () => this.options.showScreen('main-menu'));
    $('btn-join-room-back').addEventListener('click', () => this.options.showScreen('main-menu'));
    $('create-room-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitCreate();
    });
    $('join-room-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitJoin();
    });
  }

  private bindLobbyControls(): void {
    $('btn-copy-invite-link').addEventListener('click', () => void this.copyInvite('link'));
    $('btn-copy-room-code').addEventListener('click', () => void this.copyInvite('code'));
    $('btn-leave-room').addEventListener('click', () => void this.leave());
    $('btn-lobby-ready').addEventListener('click', () => {
      const local = this.view?.players.find((player) => player.isLocal);
      if (local) void this.options.actions.setReady(!local.ready);
    });
    $('btn-online-start').addEventListener('click', () => void this.options.actions.requestStart());
    $<HTMLSelectElement>('lobby-arena').addEventListener('change', (event) => {
      void this.options.actions.setMap((event.currentTarget as HTMLSelectElement).value as MapId);
    });
    $<HTMLSelectElement>('lobby-mode').addEventListener('change', (event) => {
      void this.options.actions.setMode((event.currentTarget as HTMLSelectElement).value as MatchMode);
    });
    $<HTMLSelectElement>('lobby-bot-fill').addEventListener('change', (event) => {
      const enabled = (event.currentTarget as HTMLSelectElement).value === 'on';
      void this.options.actions.setBotFill(enabled);
    });
    $<HTMLSelectElement>('lobby-bot-difficulty').addEventListener('change', (event) => {
      void this.options.actions.setDifficulty((event.currentTarget as HTMLSelectElement).value as Difficulty);
    });
  }

  private populateHostControls(): void {
    const arena = $<HTMLSelectElement>('lobby-arena');
    arena.replaceChildren(...this.options.maps.map((map) => option(map.id, map.nameKey ? t(map.nameKey as TextKey) : map.name)));
    const mode = $<HTMLSelectElement>('lobby-mode');
    mode.replaceChildren(...MODE_OPTIONS.map(([value, label, bots]) => option(value, `${t(label)} — ${t(bots ? 'common.on' : 'common.off')}`)));
    $<HTMLSelectElement>('lobby-bot-fill').replaceChildren(
      option('on', t('common.on')),
      option('off', t('common.off')),
    );
    $<HTMLSelectElement>('lobby-bot-difficulty').replaceChildren(
      option('normal', t('diff.normal')),
      option('hard', t('diff.hard')),
      option('elite', t('diff.elite')),
      option('nightmare', t('diff.nightmare')),
    );
  }

  private async submitCreate(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    $('create-room-error').textContent = '';
    try {
      await this.options.actions.createRoom({
        displayName: $<HTMLInputElement>('create-display-name').value,
        skinId: getSettings().playerSkin,
      });
    } catch (error) {
      this.showError(error instanceof RoomUiError ? error.code : 'discovery-failed', 'create');
    } finally {
      this.setBusy(false);
    }
  }

  private async submitJoin(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    $('join-room-error').textContent = '';
    try {
      await this.options.actions.joinRoom({
        invite: $<HTMLTextAreaElement>('join-room-invite').value,
        displayName: $<HTMLInputElement>('join-display-name').value,
        skinId: getSettings().playerSkin,
      });
    } catch (error) {
      this.showError(error instanceof RoomUiError ? error.code : 'discovery-failed', 'join');
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    $<HTMLButtonElement>('btn-confirm-create-room').disabled = busy;
    $<HTMLButtonElement>('btn-confirm-join-room').disabled = busy;
  }

  private clearSetupErrors(): void {
    $('create-room-error').textContent = '';
    $('join-room-error').textContent = '';
  }

  private async copyInvite(kind: 'link' | 'code'): Promise<void> {
    if (!this.view) return;
    const value = kind === 'link' ? this.view.inviteLink : this.view.inviteCode;
    try {
      await navigator.clipboard.writeText(value);
      $('lobby-status-message').textContent = t('room.copied');
    } catch {
      $('lobby-status-message').textContent = t('room.invalidInvite');
    }
  }

  private async leave(): Promise<void> {
    await this.options.actions.leaveRoom();
    this.view = null;
    this.options.showScreen('main-menu');
  }

  private renderPlayers(view: LobbyViewModel): void {
    const slots = $('lobby-player-slots');
    slots.replaceChildren();
    for (let slotId = 0; slotId < 4; slotId++) {
      const player = view.players.find((candidate) => candidate.slotId === slotId);
      slots.append(player ? this.playerSlot(player) : this.emptySlot(slotId));
    }
    const local = view.players.find((player) => player.isLocal);
    const ready = $<HTMLButtonElement>('btn-lobby-ready');
    ready.disabled = !local?.connected;
    ready.setAttribute('aria-pressed', String(local?.ready === true));
    ready.textContent = t(local?.ready ? 'lobby.notReady' : 'lobby.ready');
  }

  private playerSlot(player: LobbyPlayerView): HTMLElement {
    const row = document.createElement('article');
    row.className = `lobby-player-slot${player.isLocal ? ' local' : ''}`;
    const index = document.createElement('span');
    index.className = 'lobby-slot-index';
    index.textContent = String(player.slotId + 1).padStart(2, '0');
    const main = document.createElement('div');
    main.className = 'lobby-player-main';
    const name = document.createElement('div');
    name.className = 'lobby-player-name';
    if (player.isLocal && !player.ready) {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 24;
      input.value = player.displayName;
      input.setAttribute('aria-label', t('room.displayName'));
      input.addEventListener('change', () => void this.options.actions.setOwnDisplayName(input.value));
      name.append(input);
    } else {
      const strong = document.createElement('strong');
      strong.textContent = player.displayName;
      name.append(strong);
    }
    if (player.isHost) {
      const badge = document.createElement('span');
      badge.className = 'lobby-host-badge';
      badge.textContent = t('lobby.host');
      name.append(badge);
    }
    const meta = document.createElement('p');
    meta.className = 'lobby-player-meta';
    const connection = t(player.connected ? 'lobby.connected' : 'lobby.disconnected');
    const direct = t(player.directState === 'open' ? 'lobby.direct' : player.directState === 'failed' ? 'lobby.failed' : 'lobby.connecting');
    const ping = player.pingMs === null ? '—' : t('lobby.ping', { ms: Math.round(player.pingMs) });
    meta.textContent = `${skinName(player.skinId)} · ${connection} · ${direct} · ${ping}`;
    main.append(name, meta);
    const ready = document.createElement('span');
    ready.className = `lobby-ready-state${player.ready ? ' ready' : ''}`;
    ready.textContent = t(player.ready ? 'lobby.ready' : 'lobby.notReady');
    row.append(index, main, ready);
    return row;
  }

  private emptySlot(slotId: number): HTMLElement {
    const row = document.createElement('article');
    row.className = 'lobby-player-slot empty';
    const index = document.createElement('span');
    index.className = 'lobby-slot-index';
    index.textContent = String(slotId + 1).padStart(2, '0');
    const label = document.createElement('span');
    label.className = 'lobby-player-meta';
    label.textContent = t('lobby.empty');
    row.append(index, label);
    return row;
  }

  private renderHostControls(view: LobbyViewModel): void {
    const arena = $<HTMLSelectElement>('lobby-arena');
    const mode = $<HTMLSelectElement>('lobby-mode');
    const fill = $<HTMLSelectElement>('lobby-bot-fill');
    const difficulty = $<HTMLSelectElement>('lobby-bot-difficulty');
    arena.value = view.map;
    mode.value = view.mode;
    fill.value = view.mode === 'ffa' || view.mode === 'teams' ? 'off' : 'on';
    difficulty.value = view.difficulty;
    fill.disabled = !view.isHost || view.mode === 'humans-vs-bots';
    for (const control of [arena, mode, difficulty]) control.disabled = !view.isHost;

    const teams = $('lobby-team-controls');
    teams.replaceChildren();
    if (view.mode !== 'teams' && view.mode !== 'teams-bot-fill') return;
    for (const player of view.players) {
      const row = document.createElement('label');
      row.className = 'lobby-team-row';
      const name = document.createElement('span');
      name.textContent = player.displayName;
      const select = document.createElement('select');
      select.className = 'lobby-team-select';
      select.replaceChildren(option('0', t('lobby.teamA')), option('1', t('lobby.teamB')));
      select.value = String(player.teamId ?? 0);
      select.disabled = !view.isHost;
      select.addEventListener('change', () => void this.options.actions.setTeam(player.participantId, Number(select.value) as TeamId));
      row.append(name, select);
      teams.append(row);
    }
  }

  private renderRoster(view: LobbyViewModel): void {
    $('lobby-roster-summary').textContent = view.rosterSummary;
    const list = $('lobby-roster-list');
    list.replaceChildren(...view.rosterLines.map((line) => {
      const item = document.createElement('li');
      item.textContent = line;
      return item;
    }));
  }

  private renderNetwork(view: LobbyViewModel): void {
    const relays = $('lobby-relay-status');
    relays.replaceChildren();
    for (const relay of view.relays) appendStatus(relays, relay.url.replace(/^wss:\/\//, ''), relay.state, relay.state === 'open');
    const direct = $('lobby-direct-status');
    direct.replaceChildren();
    for (const player of view.players.filter((candidate) => !candidate.isLocal)) {
      appendStatus(direct, player.displayName, player.directState, player.directState === 'open');
    }
    $('lobby-status-message').textContent = view.statusMessage ?? '';
  }

  private renderStart(view: LobbyViewModel): void {
    const start = $<HTMLButtonElement>('btn-online-start');
    const enabled = view.isHost && view.experimentalStartEnabled && view.startEligible;
    start.disabled = !enabled;
    start.textContent = t(view.experimentalStartEnabled ? 'lobby.startExperimental' : 'lobby.startPhase3');
    $('lobby-start-note').textContent = t('lobby.phase3Gate');
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const result = document.createElement('option');
  result.value = value;
  result.textContent = label;
  return result;
}

function appendStatus(root: HTMLElement, label: string, state: string, ok: boolean): void {
  const term = document.createElement('dt');
  term.textContent = label;
  const value = document.createElement('dd');
  value.className = ok ? 'ok' : state === 'failed' || state === 'closed' ? 'bad' : '';
  value.textContent = state.toUpperCase();
  root.append(term, value);
}
