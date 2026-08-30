import type { GameConnectionOptions, GameConnectionState, SignalMessage } from '../../src/net/gameConnection';
import {
  PrivateRoomController,
  type GameConnectionHandle,
  type SignalingFactory,
} from '../../src/net/privateRoom';
import { OnlineLobbyUi, type LobbyViewModel, type RoomUiErrorCode } from '../../src/ui/onlineLobby';
import type { MapMenuOption } from '../../src/ui/ui';

declare global {
  interface Window {
    __xoPhase3TestSignalingFactory?: SignalingFactory;
    __xoLobbyTest?: {
      readonly controller: PrivateRoomController;
      latest: LobbyViewModel | null;
      lastError: RoomUiErrorCode | null;
    };
  }
}

class FailedGameConnection implements GameConnectionHandle {
  state: GameConnectionState = 'new';

  constructor(private readonly options: GameConnectionOptions) {}

  async start(): Promise<void> {
    this.state = 'failed';
    this.options.onStateChange?.('failed');
    this.options.onError?.(new Error('Deterministic direct-P2P failure'));
  }

  async handleSignal(_signal: SignalMessage): Promise<void> {
    throw new Error('Deterministic direct-P2P failure');
  }

  dispose(): void {
    this.state = 'disposed';
  }
}

const factory = window.__xoPhase3TestSignalingFactory;
if (!factory) throw new Error('Browser test signaling factory was not installed');

const maps: MapMenuOption[] = [
  { id: 'neocity', name: 'NEOCITY', description: '', traits: { verticality: '', visibility: '', combatRange: '' } },
  { id: 'oldfront', name: 'OLDFRONT', description: '', traits: { verticality: '', visibility: '', combatRange: '' } },
  { id: 'eden', name: 'EDEN', description: '', traits: { verticality: '', visibility: '', combatRange: '' } },
  { id: 'ashara', name: 'ASHARA', description: '', traits: { verticality: '', visibility: '', combatRange: '' } },
];
const screens = ['main-menu', 'create-room-menu', 'join-room-menu', 'online-lobby-menu'] as const;
const showScreen = (id: (typeof screens)[number]) => {
  for (const screen of screens) document.getElementById(screen)?.classList.toggle('hidden', screen !== id);
};
const params = new URLSearchParams(location.search);
let ui: OnlineLobbyUi | null = null;
const state = { controller: null as unknown as PrivateRoomController, latest: null as LobbyViewModel | null, lastError: null as RoomUiErrorCode | null };
const controller = new PrivateRoomController({
  buildId: params.get('build') ?? 'browser-test-build',
  baseUrl: `${location.origin}${location.pathname}`,
  experimentalStartEnabled: true,
  signalingFactory: factory,
  gameConnectionFactory: params.has('direct-fail')
    ? (options) => new FailedGameConnection(options)
    : undefined,
  onView(view) {
    state.latest = view;
    ui?.renderLobby(view);
  },
  onError(code) {
    state.lastError = code;
    ui?.showError(code);
  },
});
state.controller = controller;
ui = new OnlineLobbyUi({ maps, actions: controller, showScreen });
window.__xoLobbyTest = state;

document.getElementById('open-create')?.addEventListener('click', () => ui?.showCreate());
document.getElementById('open-join')?.addEventListener('click', () => ui?.showJoin());
if (location.hash.startsWith('#join=')) ui.showJoin(location.href);
window.addEventListener('pagehide', () => void controller.leaveRoom(true));
