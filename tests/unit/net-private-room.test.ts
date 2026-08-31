import type {
  DataPayload,
  HandshakeReceiver,
  HandshakeSender,
} from 'trystero/nostr';
import { describe, expect, it } from 'vitest';
import { createAdmissionRequest, signAdmissionResponse } from '../../src/net/admission';
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
  GuestReconnectSessionStore,
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
  handleHostHandshake(
    peerId: string,
    send: HandshakeSender,
    receive: HandshakeReceiver,
    generation?: number,
  ): Promise<void>;
}

interface HostBroadcastController {
  broadcastLobby(target?: string | null): Promise<void>;
}

interface GuestHandshakeController {
  handleGuestHandshake(peerId: string, send: HandshakeSender, receive: HandshakeReceiver): Promise<void>;
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
  reconnectBindings: Map<string, unknown>;
  sendLobbyMessage: ((payload: unknown, target?: string | null) => Promise<void>) | null;
  localParticipantId: string;
  signaling: { peerId: string; dispose(): Promise<void> };
  roomGeneration: number;
}

function privateState(controller: PrivateRoomController): HostControllerState {
  return controller as unknown as HostControllerState;
}

function privateHandshake(controller: PrivateRoomController): HostHandshakeController {
  return controller as unknown as HostHandshakeController;
}

function privateGuestHandshake(controller: PrivateRoomController): GuestHandshakeController {
  return controller as unknown as GuestHandshakeController;
}

function privateBroadcast(controller: PrivateRoomController): HostBroadcastController {
  return controller as unknown as HostBroadcastController;
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
    expect(reconnectManager.getRecord(token)).toMatchObject({
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

  it('rolls back a fresh slot and reconnect credential when acceptance delivery fails', async () => {
    const invite = await createInvite({ baseUrl: 'https://example.test/' });
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const hostPeerId = 'host-peer';
    const participantId = 'fresh-participant';
    const lobby = new LobbyState({
      roomId: derived.discoveryRoomId,
      hostPeerId,
      hostParticipantId: 'host-participant',
      hostDisplayName: 'HOST',
      build,
      seed: 789,
    });
    const reconnectManager = new ReconnectTokenManager({
      storage: new MemoryReconnectStorage(),
      ttlMs: 60_000,
    });
    const request = await createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId,
      protocolSession: 'fresh-session',
      displayName: 'FRESH',
      skinId: 'vanguard',
      lobbyAuthenticationKey: derived.lobbyAuthenticationKey,
      nonce: 'fresh-send-failure',
    });
    let acceptedToken: string | null = null;
    const send: HandshakeSender = async (data) => {
      const payload = (data as { payload?: { accepted?: boolean; reconnectToken?: string } }).payload;
      if (payload?.accepted) {
        acceptedToken = payload.reconnectToken ?? null;
        throw new Error('acceptance delivery failed');
      }
    };
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
    });
    const state = privateState(controller);
    state.role = 'host';
    state.invite = invite;
    state.derived = derived;
    state.hostIdentity = invite.hostIdentity;
    state.lobby = lobby;
    state.reconnectManager = reconnectManager;

    await expect(privateHandshake(controller).handleHostHandshake(
      'fresh-peer',
      send,
      async () => ({ data: request as unknown as DataPayload }),
    )).rejects.toThrow(/acceptance delivery failed/i);

    expect(lobby.getParticipantByPeer('fresh-peer')).toBeNull();
    expect(lobby.getParticipant(participantId)).toBeNull();
    expect(state.reconnectBindings.get(participantId)).toBeUndefined();
    expect(acceptedToken).not.toBeNull();
    expect(reconnectManager.getRecord(acceptedToken!)).toBeNull();
    controller.dispose();
  });

  it('rolls back a locked reconnect token, slot, Actor transaction, and binding on acceptance failure', async () => {
    const invite = await createInvite({ baseUrl: 'https://example.test/' });
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
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
      seed: 987,
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
    const before = lobby.getParticipant(participantId);
    const reconnectManager = new ReconnectTokenManager({
      storage: new MemoryReconnectStorage(),
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
      nonce: 'locked-send-failure',
    });
    let rolledBack = 0;
    let committed = 0;
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
      authorizeParticipantReconnect: () => true,
      onParticipantReconnected: () => ({
        accepted: true as const,
        commit: () => { committed += 1; },
        rollback: () => { rolledBack += 1; },
      }),
    });
    const state = privateState(controller);
    state.role = 'host';
    state.invite = invite;
    state.derived = derived;
    state.hostIdentity = invite.hostIdentity;
    state.lobby = lobby;
    state.reconnectManager = reconnectManager;

    await expect(privateHandshake(controller).handleHostHandshake(
      nextPeerId,
      async (data) => {
        if ((data as { payload?: { accepted?: boolean } }).payload?.accepted) {
          throw new Error('locked acceptance delivery failed');
        }
      },
      async () => ({ data: request as unknown as DataPayload }),
    )).rejects.toThrow(/locked acceptance delivery failed/i);

    expect(committed).toBe(0);
    expect(rolledBack).toBe(1);
    expect(reconnectManager.getRecord(token)).toMatchObject({
      protocolSession: 'guest-session-old',
      generation: 0,
    });
    expect(lobby.getParticipant(participantId)).toEqual(before);
    expect(lobby.getParticipantByPeer(previousPeerId)).toMatchObject({ connected: false, channelsOpen: false });
    expect(lobby.getParticipantByPeer(nextPeerId)).toBeNull();
    expect(state.reconnectBindings.get(participantId)).toBeUndefined();
    controller.dispose();
  });

  it('does not broadcast a staged admission while acceptance delivery is pending', async () => {
    const invite = await createInvite({ baseUrl: 'https://example.test/' });
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const lobby = new LobbyState({
      roomId: derived.discoveryRoomId,
      hostPeerId: 'host-peer',
      hostParticipantId: 'host-participant',
      hostDisplayName: 'HOST',
      build,
      seed: 654321,
    });
    const reconnectManager = new ReconnectTokenManager({ storage: new MemoryReconnectStorage(), ttlMs: 60_000 });
    const request = await createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: 'pending-participant',
      protocolSession: 'pending-session',
      displayName: 'PENDING',
      skinId: 'vanguard',
      lobbyAuthenticationKey: derived.lobbyAuthenticationKey,
      nonce: 'pending-acceptance-send',
    });
    let acceptedSendStarted = false;
    let releaseAcceptedSend!: () => void;
    const acceptedSend = new Promise<void>((resolve) => { releaseAcceptedSend = resolve; });
    const lobbyMessages: unknown[] = [];
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
    });
    const state = privateState(controller);
    state.role = 'host';
    state.invite = invite;
    state.derived = derived;
    state.hostIdentity = invite.hostIdentity;
    state.lobby = lobby;
    state.reconnectManager = reconnectManager;
    state.sendLobbyMessage = async (payload) => { lobbyMessages.push(payload); };

    const pendingAdmission = privateHandshake(controller).handleHostHandshake(
      'pending-peer',
      async (data) => {
        if ((data as { payload?: { accepted?: boolean } }).payload?.accepted) {
          acceptedSendStarted = true;
          await acceptedSend;
        }
      },
      async () => ({ data: request as unknown as DataPayload }),
    );
    for (let attempt = 0; attempt < 100 && !acceptedSendStarted; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(acceptedSendStarted).toBe(true);
    await privateBroadcast(controller).broadcastLobby();
    expect(lobbyMessages).toHaveLength(0);

    releaseAcceptedSend();
    await pendingAdmission;
    for (let attempt = 0; attempt < 100 && lobbyMessages.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(lobbyMessages).toHaveLength(1);
    expect((lobbyMessages[0] as { payload: { participants: unknown[] } }).payload.participants).toHaveLength(2);
    controller.dispose();
  });

  it('serializes concurrent admissions so a pending guest is never disclosed to another guest', async () => {
    const invite = await createInvite({ baseUrl: 'https://example.test/' });
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const lobby = new LobbyState({
      roomId: derived.discoveryRoomId,
      hostPeerId: 'host-peer',
      hostParticipantId: 'host-participant',
      hostDisplayName: 'HOST',
      build,
      seed: 777,
    });
    const reconnectManager = new ReconnectTokenManager({ storage: new MemoryReconnectStorage(), ttlMs: 60_000 });
    const makeRequest = (participantId: string, nonce: string) => createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId,
      protocolSession: `${participantId}-session`,
      displayName: participantId,
      skinId: 'vanguard',
      lobbyAuthenticationKey: derived.lobbyAuthenticationKey,
      nonce,
    });
    const [firstRequest, secondRequest] = await Promise.all([
      makeRequest('first-participant', 'first-admission'),
      makeRequest('second-participant', 'second-admission'),
    ]);
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
    });
    const state = privateState(controller);
    state.role = 'host';
    state.invite = invite;
    state.derived = derived;
    state.hostIdentity = invite.hostIdentity;
    state.lobby = lobby;
    state.reconnectManager = reconnectManager;

    let firstAcceptedSendStarted = false;
    let releaseFirstAcceptedSend!: () => void;
    const firstAcceptedSend = new Promise<void>((resolve) => { releaseFirstAcceptedSend = resolve; });
    let secondReceiveStarted = false;
    const secondSent: DataPayload[] = [];
    const firstAdmission = privateHandshake(controller).handleHostHandshake(
      'first-peer',
      async (data) => {
        if ((data as { payload?: { accepted?: boolean } }).payload?.accepted) {
          firstAcceptedSendStarted = true;
          await firstAcceptedSend;
        }
      },
      async () => ({ data: firstRequest as unknown as DataPayload }),
    );
    for (let attempt = 0; attempt < 100 && !firstAcceptedSendStarted; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(firstAcceptedSendStarted).toBe(true);

    const secondAdmission = privateHandshake(controller).handleHostHandshake(
      'second-peer',
      async (data) => { secondSent.push(data); },
      async () => {
        secondReceiveStarted = true;
        return { data: secondRequest as unknown as DataPayload };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondReceiveStarted).toBe(false);
    expect(lobby.snapshot().participants.map((participant) => participant.peerId)).toEqual(['host-peer', 'first-peer']);

    releaseFirstAcceptedSend();
    await Promise.all([firstAdmission, secondAdmission]);
    expect(secondReceiveStarted).toBe(true);
    expect(secondSent).toHaveLength(1);
    expect(secondSent[0]).toMatchObject({
      payload: {
        accepted: true,
        lobby: { participants: [{ peerId: 'host-peer' }, { peerId: 'first-peer' }, { peerId: 'second-peer' }] },
      },
    });
    controller.dispose();
  });

  it('does not activate a guest session from a signed but malformed accepted response', async () => {
    const invite = await createInvite({ baseUrl: 'https://example.test/' });
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const admissionWait = deferredAdmission();
    void admissionWait.promise.catch(() => undefined);
    const guestReconnect = new GuestReconnectSessionStore({
      namespace: derived.reconnectNamespace,
      storage: new MemoryReconnectStorage(),
    });
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
    });
    const state = controller as unknown as {
      role: 'guest';
      invite: Awaited<ReturnType<typeof createInvite>>;
      derived: Awaited<ReturnType<typeof deriveInviteSecrets>>;
      guestProfile: {
        displayName: string;
        skinId: 'vanguard';
        preferredItemSlots: typeof import('../../src/core/preferredSlots').DEFAULT_PREFERRED_ITEM_SLOTS;
        proposedParticipantId: string;
        protocolSession: string;
        reconnectToken: null;
      };
      signaling: { peerId: string; dispose(): Promise<void> };
      guestReconnect: GuestReconnectSessionStore;
      admissionWait: typeof admissionWait;
      hostPeerId: string;
      localParticipantId: string;
      localProtocolSession: string;
      remoteSnapshot: LobbySnapshot | null;
    };
    state.role = 'guest';
    state.invite = invite;
    state.derived = derived;
    state.guestProfile = {
      displayName: 'GUEST',
      skinId: 'vanguard',
      preferredItemSlots: {
        enabled: false,
        slots: ['none', 'none', 'none', 'none', 'none'],
      },
      proposedParticipantId: 'guest-participant',
      protocolSession: 'guest-session',
      reconnectToken: null,
    };
    state.signaling = { peerId: 'guest-peer', dispose: async () => undefined };
    state.guestReconnect = guestReconnect;
    state.admissionWait = admissionWait;
    state.hostPeerId = '';
    state.localParticipantId = '';
    state.localProtocolSession = '';
    state.remoteSnapshot = null;

    let requestNonce = '';
    const receive: HandshakeReceiver = async () => {
      const response = await signAdmissionResponse(invite.hostIdentity, {
        type: 'admission-response',
        version: 1,
        accepted: true,
        role: 'host',
        requestNonce,
        hostPeerId: 'host-peer',
        participantId: 'guest-participant',
        slotId: 1,
        protocolSession: 'guest-session',
        reconnectToken: 'reconnect-token',
        build,
        lobby: {},
      });
      return { data: response as unknown as DataPayload };
    };

    await expect(privateGuestHandshake(controller).handleGuestHandshake(
      'host-peer',
      async (data) => {
        requestNonce = (data as { nonce: string }).nonce;
      },
      receive,
    )).rejects.toThrow();

    expect(state.hostPeerId).toBe('');
    expect(state.localParticipantId).toBe('');
    expect(state.localProtocolSession).toBe('');
    expect(state.remoteSnapshot).toBeNull();
    await expect(admissionWait.promise).rejects.toMatchObject({ code: 'wrong-secret' });
    controller.dispose();
  });

  it('does not let a stale handshake mutate a replacement room', async () => {
    const invite = await createInvite({ baseUrl: 'https://example.test/' });
    const derived = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const lobby = new LobbyState({
      roomId: derived.discoveryRoomId,
      hostPeerId: 'host-peer',
      hostParticipantId: 'host-participant',
      hostDisplayName: 'HOST',
      build,
      seed: 2468,
    });
    const reconnectManager = new ReconnectTokenManager({ storage: new MemoryReconnectStorage(), ttlMs: 60_000 });
    const request = await createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: 'stale-participant',
      protocolSession: 'stale-session',
      displayName: 'STALE',
      skinId: 'vanguard',
      lobbyAuthenticationKey: derived.lobbyAuthenticationKey,
      nonce: 'stale-room-generation',
    });
    let releaseReceive!: () => void;
    const receiveGate = new Promise<void>((resolve) => { releaseReceive = resolve; });
    const sent: DataPayload[] = [];
    const controller = new PrivateRoomController({
      buildId: build.buildId,
      baseUrl: 'https://example.test/',
      onView: () => undefined,
    });
    const state = privateState(controller);
    state.role = 'host';
    state.invite = invite;
    state.derived = derived;
    state.hostIdentity = invite.hostIdentity;
    state.lobby = lobby;
    state.reconnectManager = reconnectManager;
    const before = lobby.snapshot();

    const pending = privateHandshake(controller).handleHostHandshake(
      'stale-peer',
      async (data) => { sent.push(data); },
      async () => {
        await receiveGate;
        return { data: request as unknown as DataPayload };
      },
      state.roomGeneration,
    );
    state.roomGeneration += 1;
    releaseReceive();

    await expect(pending).rejects.toThrow(/stale/i);
    expect(lobby.snapshot()).toEqual(before);
    expect(lobby.getParticipantByPeer('stale-peer')).toBeNull();
    expect(sent).toHaveLength(0);
    controller.dispose();
  });
});

function deferredAdmission(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
