import type {
  DataPayload,
  HandshakeReceiver,
  HandshakeSender,
} from 'trystero/nostr';
import { describe, expect, it } from 'vitest';
import { createAdmissionRequest } from '../../src/net/admission';
import { deriveInviteSecrets } from '../../src/net/crypto';
import { createInvite } from '../../src/net/invite';
import {
  LobbyState,
  type LobbySnapshot,
} from '../../src/net/lobbyState';
import {
  buildHandshake,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  type BuildIdentity,
} from '../../src/net/protocol';
import {
  MemoryReconnectStorage,
  ReconnectTokenManager,
} from '../../src/net/reconnect';
import { PrivateRoomController } from '../../src/net/privateRoom';
import type { GameConnectionState } from '../../src/net/gameConnection';

const build: BuildIdentity = {
  protocolVersion: PROTOCOL_VERSION,
  buildId: 'private-room-test-build',
  features: [...PROTOCOL_FEATURES],
};

interface HostHandshakeController {
  handleHostHandshake(peerId: string, send: HandshakeSender, receive: HandshakeReceiver): Promise<void>;
}

interface HostGameStateController {
  onGameState(peerId: string, state: GameConnectionState): void;
}

interface HostGameConnectionController {
  startGameConnection(
    peerId: string,
    role: 'host' | 'guest',
    sendSignal: (data: DataPayload, options?: { target?: string | string[] | null }) => Promise<void>,
  ): void;
}

interface HostControllerState {
  role: 'host';
  invite: Awaited<ReturnType<typeof createInvite>>;
  derived: Awaited<ReturnType<typeof deriveInviteSecrets>>;
  hostIdentity: Awaited<ReturnType<typeof createInvite>>['hostIdentity'];
  lobby: LobbyState;
  reconnectManager: ReconnectTokenManager;
  localParticipantId: string;
  signaling: { peerId: string; dispose(): Promise<void> };
}

function privateState(controller: PrivateRoomController): HostControllerState {
  return controller as unknown as HostControllerState;
}

function privateHandshake(controller: PrivateRoomController): HostHandshakeController {
  return controller as unknown as HostHandshakeController;
}

function privateGameState(controller: PrivateRoomController): HostGameStateController {
  return controller as unknown as HostGameStateController;
}

function privateGameConnection(controller: PrivateRoomController): HostGameConnectionController {
  return controller as unknown as HostGameConnectionController;
}

describe('PrivateRoomController reconnect admission', () => {
  it('opens token reclaim when only the direct gameplay connection fails', () => {
    const lobby = new LobbyState({
      roomId: 'room-direct-failure',
      hostPeerId: 'host-peer',
      hostParticipantId: 'host-participant',
      hostDisplayName: 'HOST',
      build,
      seed: 321,
    });
    lobby.addParticipant({
      handshake: buildHandshake({
        roomId: 'room-direct-failure',
        peerId: 'guest-peer',
        participantId: 'guest-participant',
        role: 'participant',
        protocolSession: 'guest-session',
        build,
      }),
      displayName: 'GUEST',
      channelOpen: true,
    });
    lobby.setReady('guest-peer', true);
    expect(lobby.requestStart('host-peer').accepted).toBe(true);
    const observed: GameConnectionState[] = [];
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
      onGameStateChange: (_peerId, state) => observed.push(state),
    });
    const state = privateState(controller);
    state.role = 'host';
    state.lobby = lobby;

    // The signaling peer is deliberately not removed. Only the direct game
    // path reaches a terminal state.
    privateGameState(controller).onGameState('guest-peer', 'failed');

    expect(observed).toEqual(['failed']);
    expect(lobby.getParticipantByPeer('guest-peer')).toMatchObject({
      connected: false,
      channelsOpen: false,
      ready: false,
    });
    controller.dispose();
  });

  it('turns a synchronous gameplay connection construction error into terminal disconnect state', () => {
    const lobby = new LobbyState({
      roomId: 'room-construction-failure',
      hostPeerId: 'host-peer',
      hostParticipantId: 'host-participant',
      hostDisplayName: 'HOST',
      build,
      seed: 654,
    });
    lobby.addParticipant({
      handshake: buildHandshake({
        roomId: 'room-construction-failure',
        peerId: 'guest-peer',
        participantId: 'guest-participant',
        role: 'participant',
        protocolSession: 'guest-session',
        build,
      }),
      displayName: 'GUEST',
      channelOpen: true,
    });
    const observed: GameConnectionState[] = [];
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
      onGameStateChange: (_peerId, state) => observed.push(state),
      gameConnectionFactory: () => { throw new Error('RTCPeerConnection unavailable'); },
    });
    const state = privateState(controller);
    state.role = 'host';
    state.lobby = lobby;
    state.localParticipantId = 'host-participant';
    state.signaling = { peerId: 'host-peer', dispose: async () => undefined };

    privateGameConnection(controller).startGameConnection(
      'guest-peer',
      'host',
      async () => undefined,
    );

    expect(observed).toEqual(['failed']);
    expect(lobby.getParticipantByPeer('guest-peer')).toMatchObject({
      connected: false,
      channelsOpen: false,
    });
    controller.dispose();
  });

  it('rejects a match-window-expired reconnect before rotating a still-valid lobby token', async () => {
    const invite = await createInvite({ baseUrl: 'https://example.test/' });
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const now = Date.now();
    const hostPeerId = 'host-peer';
    const previousPeerId = 'guest-peer-old';
    const nextPeerId = 'guest-peer-new';
    const participantId = 'guest-participant';
    const lobby = new LobbyState({
      roomId: derived.discoveryRoomId,
      hostPeerId,
      hostParticipantId: 'host-participant',
      hostDisplayName: 'HOST',
      build,
      seed: 123,
    });
    lobby.addParticipant({
      handshake: buildHandshake({
        roomId: derived.discoveryRoomId,
        peerId: previousPeerId,
        participantId,
        role: 'participant',
        protocolSession: 'guest-session-old',
        build,
      }),
      displayName: 'GUEST',
      channelOpen: true,
    });
    lobby.setReady(previousPeerId, true);
    expect(lobby.requestStart(hostPeerId).accepted).toBe(true);
    lobby.markDisconnected(previousPeerId);
    const before: LobbySnapshot = lobby.snapshot();

    const reconnectManager = new ReconnectTokenManager({
      storage: new MemoryReconnectStorage(),
      now: () => now,
      ttlMs: 60_000,
    });
    const token = reconnectManager.issue({
      roomId: derived.discoveryRoomId,
      slotId: 1,
      participantId,
      protocolSession: 'guest-session-old',
    });
    const request = await createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: null,
      protocolSession: 'guest-session-new',
      displayName: 'GUEST',
      skinId: 'vanguard',
      requestedSlot: 1,
      reconnectToken: token,
      lobbyAuthenticationKey: derived.lobbyAuthenticationKey,
      now,
      nonce: 'reconnect-expired-window',
    });
    const sent: DataPayload[] = [];
    const send: HandshakeSender = async (data) => {
      sent.push(data);
    };
    const receive: HandshakeReceiver = async () => ({ data: request as unknown as DataPayload });
    const authorizeAttempts: Array<{ participantId: string; previousPeerId: string; peerId: string }> = [];
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
      authorizeParticipantReconnect: (attempt) => {
        authorizeAttempts.push(attempt);
        return false;
      },
    });
    const state = privateState(controller);
    state.role = 'host';
    state.invite = invite;
    state.derived = derived;
    state.hostIdentity = invite.hostIdentity;
    state.lobby = lobby;
    state.reconnectManager = reconnectManager;

    await expect(privateHandshake(controller).handleHostHandshake(nextPeerId, send, receive))
      .rejects.toThrow(/reconnect window/i);

    expect(authorizeAttempts).toEqual([{ participantId, previousPeerId, peerId: nextPeerId }]);
    expect(reconnectManager.getRecord(token)).toMatchObject({
      participantId,
      protocolSession: 'guest-session-old',
      generation: 0,
    });
    expect(lobby.snapshot()).toEqual(before);
    expect(lobby.getParticipantByPeer(previousPeerId)?.connected).toBe(false);
    expect(lobby.getParticipantByPeer(nextPeerId)).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      payload: {
        accepted: false,
        code: 'invalid-reconnect',
      },
    });
    controller.dispose();
  });

  it('rejects a locked-room admission when the authoritative Actor rebind fails', async () => {
    const invite = await createInvite({ baseUrl: 'https://example.test/' });
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const now = Date.now();
    const hostPeerId = 'host-peer';
    const previousPeerId = 'guest-peer-old';
    const nextPeerId = 'guest-peer-new';
    const participantId = 'guest-participant';
    const lobby = new LobbyState({
      roomId: derived.discoveryRoomId,
      hostPeerId,
      hostParticipantId: 'host-participant',
      hostDisplayName: 'HOST',
      build,
      seed: 456,
    });
    lobby.addParticipant({
      handshake: buildHandshake({
        roomId: derived.discoveryRoomId,
        peerId: previousPeerId,
        participantId,
        role: 'participant',
        protocolSession: 'guest-session-old',
        build,
      }),
      displayName: 'GUEST',
      channelOpen: true,
    });
    lobby.setReady(previousPeerId, true);
    expect(lobby.requestStart(hostPeerId).accepted).toBe(true);
    lobby.markDisconnected(previousPeerId);
    const before = lobby.snapshot();

    const reconnectManager = new ReconnectTokenManager({
      storage: new MemoryReconnectStorage(),
      now: () => now,
      ttlMs: 60_000,
    });
    const token = reconnectManager.issue({
      roomId: derived.discoveryRoomId,
      slotId: 1,
      participantId,
      protocolSession: 'guest-session-old',
    });
    const request = await createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: null,
      protocolSession: 'guest-session-new',
      displayName: 'GUEST',
      skinId: 'vanguard',
      requestedSlot: 1,
      reconnectToken: token,
      lobbyAuthenticationKey: derived.lobbyAuthenticationKey,
      now,
      nonce: 'reconnect-authority-rejected',
    });
    const staleSessionRequest = await createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: null,
      protocolSession: 'guest-session-old',
      displayName: 'GUEST',
      skinId: 'vanguard',
      requestedSlot: 1,
      reconnectToken: token,
      lobbyAuthenticationKey: derived.lobbyAuthenticationKey,
      now,
      nonce: 'reconnect-session-not-rotated',
    });
    const sent: DataPayload[] = [];
    const committedGenerations: number[] = [];
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
      authorizeParticipantReconnect: () => true,
      onParticipantReconnected: ({ binding }) => {
        committedGenerations.push(binding.generation);
        return false;
      },
    });
    const state = privateState(controller);
    state.role = 'host';
    state.invite = invite;
    state.derived = derived;
    state.hostIdentity = invite.hostIdentity;
    state.lobby = lobby;
    state.reconnectManager = reconnectManager;

    await expect(privateHandshake(controller).handleHostHandshake(
      `${nextPeerId}-retry`,
      async (data) => { sent.push(data); },
      async () => ({ data: staleSessionRequest as unknown as DataPayload }),
    )).rejects.toThrow(/protocol session is unavailable/i);
    expect(committedGenerations).toEqual([]);
    expect(reconnectManager.getRecord(token)).toMatchObject({
      protocolSession: 'guest-session-old',
      generation: 0,
    });
    expect(lobby.snapshot()).toEqual(before);
    expect(sent).toHaveLength(1);
    sent.length = 0;

    await expect(privateHandshake(controller).handleHostHandshake(
      nextPeerId,
      async (data) => { sent.push(data); },
      async () => ({ data: request as unknown as DataPayload }),
    )).rejects.toThrow(/authoritative match rejected/i);

    expect(committedGenerations).toEqual([1]);
    expect(reconnectManager.getRecord(token)).toBeNull();
    expect(lobby.snapshot()).toEqual(before);
    expect(lobby.getParticipantByPeer(previousPeerId)?.connected).toBe(false);
    expect(lobby.getParticipantByPeer(nextPeerId)).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      payload: {
        accepted: false,
        code: 'invalid-reconnect',
      },
    });
    controller.dispose();
  });
});
