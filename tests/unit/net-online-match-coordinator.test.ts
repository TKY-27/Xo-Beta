import { describe, expect, it } from 'vitest';
import { emptyCommand } from '../../src/sim/input';
import type { InputCommand } from '../../src/sim/input';
import { loadMap } from '../../src/world';
import type { GameChannelLabel, GameConnectionState, GameMessage, GamePayload } from '../../src/net/gameConnection';
import type { HostAuthoritativeMatchSession, TacticalPing } from '../../src/net/hostMatchSession';
import { freezeGameStateView } from '../../src/net/clientReplica';
import {
  KEYFRAME_REQUEST_MIN_INTERVAL_TICKS,
  MAX_COORDINATOR_VIOLATIONS,
  MAX_PENDING_RELIABLE_EVENTS_PER_PEER,
  ONLINE_START_COUNTDOWN_TICKS,
  OnlineMatchCoordinator,
  type HostSessionFactoryInput,
  type OnlineMatchRoomPort,
} from '../../src/net/onlineMatchCoordinator';
import type { OnlineRoomMatchContext } from '../../src/net/privateRoom';
import { decodeReliablePacket, encodeReliablePacket } from '../../src/net/matchStateCodec';
import { decodeSnapshotChunk } from '../../src/net/matchProtocol';

interface Delivery {
  readonly target: 'host' | 'guest';
  readonly peerId: string;
  readonly message: GameMessage;
}

function contexts(): { host: OnlineRoomMatchContext; guest: OnlineRoomMatchContext } {
  const build = Object.freeze({ protocolVersion: 2, buildId: 'test-build-1234', features: Object.freeze(['lobby-v1', 'reconnect-v1'] as const) });
  const hostEntry = Object.freeze({
    slotId: 0, actorId: 1, displayName: 'HOST',
    ownership: Object.freeze({ kind: 'local-human' as const, peerId: 'host-peer' }),
    connectionState: 'connected' as const, teamId: null, skinId: 'vanguard' as const, accentColor: 0x55aaff,
  });
  const guestEntry = Object.freeze({
    slotId: 1, actorId: 2, displayName: 'GUEST',
    ownership: Object.freeze({ kind: 'remote-human' as const, peerId: 'guest-peer' }),
    connectionState: 'connected' as const, teamId: null, skinId: 'nova' as const, accentColor: 0xffaa55,
  });
  const participants = Object.freeze([
    Object.freeze({
      participantId: 'host-participant', peerId: 'host-peer', slotId: 0, displayName: 'HOST',
      skinId: 'vanguard' as const, teamId: null, ready: true, isHost: true, connected: true,
      channelsOpen: true, build, protocolSession: 'host-protocol-session',
    }),
    Object.freeze({
      participantId: 'guest-participant', peerId: 'guest-peer', slotId: 1, displayName: 'GUEST',
      skinId: 'nova' as const, teamId: null, ready: true, isHost: false, connected: true,
      channelsOpen: true, build, protocolSession: 'guest-protocol-session',
    }),
  ]);
  const snapshot = Object.freeze({
    revision: 4,
    roomId: 'room-1234',
    hostPeerId: 'host-peer',
    matchLocked: true,
    build,
    config: Object.freeze({ mapId: 'oldfront' as const, mode: 'ffa' as const, botFill: false, difficulty: 'normal' as const, seed: 77 }),
    effectiveMode: 'ffa' as const,
    participants,
    rosterPreview: Object.freeze({
      revision: 4, roomId: 'room-1234', mapId: 'oldfront' as const,
      mode: 'ffa' as const, configuredMode: 'ffa' as const, botFill: false,
      difficulty: 'normal' as const, seed: 77,
      humans: Object.freeze([hostEntry, guestEntry]),
      roster: Object.freeze([hostEntry, guestEntry]),
      valid: true, error: null,
    }),
  });
  const common = { matchSessionBinding: 'common-match-session-binding', hostPeerId: 'host-peer', snapshot } as const;
  return {
    host: Object.freeze({ ...common, role: 'host', localParticipantId: 'host-participant', localProtocolSession: 'host-protocol-session' }),
    guest: Object.freeze({ ...common, role: 'guest', localParticipantId: 'guest-participant', localProtocolSession: 'guest-protocol-session' }),
  };
}

function harness(options: {
  readonly now?: { value: number };
  readonly mismatchedGuestMap?: boolean;
  readonly reconnectAccepted?: boolean;
  readonly reconnectAlive?: boolean;
  readonly sampleLocalInput?: () => Readonly<InputCommand>;
  readonly onLocalInputSubmitted?: (inputSeq: number, command: Readonly<InputCommand>) => boolean;
  readonly hostEventSendFailures?: { value: number };
  readonly throwOnDisconnectPeerId?: string;
  readonly throwGuestEventObserver?: boolean;
  readonly hostInactivityGraceMs?: number;
} = {}) {
  const queue: Delivery[] = [];
  const disconnected: string[] = [];
  const hostEventSendFailures = options.hostEventSendFailures ?? { value: 0 };
  const ctx = contexts();
  const port = (side: 'host' | 'guest'): OnlineMatchRoomPort => ({
    sendGameMessage(peerId: string, channel: GameChannelLabel, data: GamePayload): boolean {
      if (side === 'host' && channel === 'event' && hostEventSendFailures.value > 0) {
        hostEventSendFailures.value -= 1;
        return false;
      }
      queue.push({
        target: side === 'host' ? 'guest' : 'host',
        peerId: side === 'host' ? 'host-peer' : 'guest-peer',
        message: { channel, data },
      });
      void peerId;
      return true;
    },
    sendGameInput(data: GamePayload): boolean {
      queue.push({ target: 'host', peerId: 'guest-peer', message: { channel: 'input', data } });
      return true;
    },
    disconnectGamePeer(peerId: string): boolean {
      if (peerId === options.throwOnDisconnectPeerId) throw new Error('transport close failed');
      disconnected.push(peerId);
      return true;
    },
  });
  const receivedInputs: unknown[] = [];
  const tacticalPings: Array<{ peerId: string; x: number; z: number }> = [];
  let fixedTicks = 0;
  let fakeHostTick = 0;
  let disposed = 0;
  let keyframeRequests = 0;
  let factoryInput: HostSessionFactoryInput | null = null;
  const fakeSession = {
    match: { get hostTick() { return fakeHostTick; } },
    fixedUpdate() { fakeHostTick++; fixedTicks++; },
    receiveInput(_peerId: string, envelope: unknown) { receivedInputs.push(envelope); return { accepted: true, violations: 0, disconnected: false }; },
    requestRecoveryKeyframe() { keyframeRequests++; },
    markDisconnected() { return true; },
    canReconnectParticipant() { return options.reconnectAccepted ?? true; },
    reconnectParticipant(_participantId: string, _newPeerId: string) {
      const accepted = options.reconnectAccepted ?? true;
      return Object.freeze({ accepted, alive: accepted && (options.reconnectAlive ?? true) });
    },
    requestTacticalPing(peerId: string, x: number, z: number): TacticalPing {
      tacticalPings.push({ peerId, x, z });
      return Object.freeze({
        eventId: 1, senderActorId: 2, teamId: null, kind: 'location', x, z,
        createdHostTick: fakeHostTick, expiresHostTick: fakeHostTick + 360,
        recipients: Object.freeze([peerId]),
      });
    },
    dispose() { disposed++; },
  } as unknown as HostAuthoritativeMatchSession;
  const events: Array<{ role: 'host' | 'guest'; type: string; predicted: boolean }> = [];
  const ends: string[] = [];
  const notices: Array<{ kind: 'left' | 'rejoined'; displayName: string }> = [];
  const visibility: boolean[] = [];
  const protocolErrors: Array<{ role: 'host' | 'guest'; message: string }> = [];
  const resolveHostMap = () => loadMap('oldfront').def;
  const resolveGuestMap = () => loadMap(options.mismatchedGuestMap ? 'eden' : 'oldfront').def;
  const hostCoordinator = new OnlineMatchCoordinator({
    context: ctx.host,
    room: port('host'),
    resolveMap: resolveHostMap,
    nowMs: () => options.now?.value ?? 0,
    createHostSession(input) { factoryInput = input; return fakeSession; },
    onAuthoritativeEvent(event, predicted) { events.push({ role: 'host', type: event.type, predicted }); },
    onPresenceNotice(kind, displayName) { notices.push({ kind, displayName }); },
    hostInactivityGraceMs: options.hostInactivityGraceMs,
    onProtocolError(_peerId, error) { protocolErrors.push({ role: 'host', message: error.message }); },
  });
  const guestCoordinator = new OnlineMatchCoordinator({
    context: ctx.guest,
    room: port('guest'),
    resolveMap: resolveGuestMap,
    nowMs: () => options.now?.value ?? 0,
    hostDisconnectGraceMs: 100,
    sampleLocalInput: options.sampleLocalInput,
    onLocalInputSubmitted: options.onLocalInputSubmitted,
    onAuthoritativeEvent(event, predicted) {
      if (options.throwGuestEventObserver) throw new Error('guest presentation failed');
      events.push({ role: 'guest', type: event.type, predicted });
    },
    onProtocolError(_peerId, error) { protocolErrors.push({ role: 'guest', message: error.message }); },
    onHostVisibilityChange(hidden) { visibility.push(hidden); },
    onEnd(reason) { ends.push(reason); },
  });
  const flush = async () => {
    while (queue.length > 0) {
      const delivery = queue.shift()!;
      if (delivery.target === 'host') await hostCoordinator.handleGameMessage(delivery.peerId, delivery.message);
      else await guestCoordinator.handleGameMessage(delivery.peerId, delivery.message);
    }
  };
  return {
    hostCoordinator, guestCoordinator, flush, queue, disconnected,
    receivedInputs, tacticalPings, events, ends, notices,
    protocolErrors, visibility,
    get fixedTicks() { return fixedTicks; },
    get disposed() { return disposed; },
    get keyframeRequests() { return keyframeRequests; },
    get factoryInput() { return factoryInput; },
    contexts: ctx,
  };
}

function withReconnectedGuestPeer(context: OnlineRoomMatchContext, peerId: string): OnlineRoomMatchContext {
  const participants = context.snapshot.participants.map((participant) => participant.participantId === context.localParticipantId
    ? Object.freeze({ ...participant, peerId, protocolSession: `${participant.protocolSession}-rotated` })
    : participant);
  return Object.freeze({
    ...context,
    localProtocolSession: `${context.localProtocolSession}-rotated`,
    snapshot: Object.freeze({ ...context.snapshot, participants: Object.freeze(participants) }),
  });
}

function guestSnapshotView() {
  const map = loadMap('oldfront').def;
  return freezeGameStateView({
    hostTick: 2,
    stateRevision: 2,
    phase: 'live',
    mode: 'ffa',
    localActorId: 2,
    actors: [{
      id: 2,
      displayName: 'GUEST',
      ownership: { kind: 'remote-human', peerId: 'guest-peer' },
      connectionState: 'connected',
      teamId: null,
      skinId: 'nova',
      alive: true,
      position: { x: 0, y: 1, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      deployed: true,
    }],
    destructibles: map.destructibles.map((item) => ({
      id: item.stableId,
      revision: 0,
      destroyed: false,
    })),
  });
}

async function startBoth(value: ReturnType<typeof harness>) {
  await value.hostCoordinator.beginHost();
  await value.flush();
  expect(value.hostCoordinator.state).toBe('countdown');
  expect(value.guestCoordinator.state).toBe('countdown');
  for (let tick = 0; tick < ONLINE_START_COUNTDOWN_TICKS; tick++) {
    value.hostCoordinator.fixedUpdate();
    value.guestCoordinator.fixedUpdate();
  }
  await value.flush();
  expect(value.hostCoordinator.state).toBe('active');
  expect(value.guestCoordinator.state).toBe('active');
}

describe('OnlineMatchCoordinator', () => {
  it('validates but drops a guest input that races one callback ahead of host activation', async () => {
    const value = harness();
    await value.hostCoordinator.beginHost();
    await value.flush();
    expect(value.hostCoordinator.state).toBe('countdown');
    expect(value.guestCoordinator.state).toBe('countdown');

    for (let tick = 0; tick < ONLINE_START_COUNTDOWN_TICKS; tick++) {
      value.guestCoordinator.fixedUpdate();
    }
    expect(value.guestCoordinator.state).toBe('active');
    expect(value.queue.some((delivery) => delivery.message.channel === 'input')).toBe(true);
    await value.flush();

    expect(value.hostCoordinator.state).toBe('countdown');
    expect(value.receivedInputs).toHaveLength(0);
    expect(value.protocolErrors).toEqual([]);
  });

  it('cancels the start attempt if a locked-roster peer disconnects during countdown', async () => {
    const value = harness();
    await value.hostCoordinator.beginHost();
    await value.flush();
    expect(value.hostCoordinator.state).toBe('countdown');

    value.hostCoordinator.handleConnectionState('guest-peer', 'failed');

    expect(value.hostCoordinator.state).toBe('ended');
    expect(value.fixedTicks).toBe(0);
    expect(value.disconnected).toContain('guest-peer');
  });

  it('runs the canonical READY barrier and starts exactly one host session plus one guest replica', async () => {
    const value = harness();
    await startBoth(value);
    expect(value.factoryInput?.bindings).toEqual([{
      participantId: 'guest-participant', peerId: 'guest-peer', actorId: 2, teamId: null,
    }]);
    expect(value.hostCoordinator.hostSession).not.toBeNull();
    expect(value.guestCoordinator.hostSession).toBeNull();
    expect(value.guestCoordinator.replica).not.toBeNull();
    expect(value.fixedTicks).toBe(1);
  });

  it('sends one compact input each fixed tick and routes tactical ping requests to the host', async () => {
    const value = harness();
    await startBoth(value);
    const before = value.receivedInputs.length;
    value.guestCoordinator.setLocalInput({ ...emptyCommand(), moveZ: 1, firePressed: true });
    value.hostCoordinator.fixedUpdate();
    value.guestCoordinator.fixedUpdate();
    await value.flush();
    expect(value.receivedInputs).toHaveLength(before + 1);
    expect(value.receivedInputs.at(-1)).toMatchObject({ receivedHostTick: 2 });
    expect((value.receivedInputs.at(-1) as { frames: Array<{ sequence: number; clientTick: number }> }).frames[0])
      .toMatchObject({ sequence: 2, clientTick: 2 });
    expect(value.guestCoordinator.requestTacticalPing(4, -5)).toBe(true);
    await value.flush();
    expect(value.tacticalPings).toEqual([{ peerId: 'guest-peer', x: 4, z: -5 }]);
  });

  it('keeps guest input ticks monotonic when the host clock runs far ahead', async () => {
    const value = harness();
    await startBoth(value);
    for (let tick = 0; tick < 99; tick++) value.hostCoordinator.fixedUpdate();

    const map = loadMap('oldfront').def;
    const view = freezeGameStateView({
      hostTick: 100,
      stateRevision: 1,
      phase: 'live',
      mode: 'ffa',
      localActorId: 2,
      actors: [{
        id: 2,
        displayName: 'GUEST',
        ownership: { kind: 'remote-human', peerId: 'guest-peer' },
        connectionState: 'connected',
        teamId: null,
        skinId: 'nova',
        alive: true,
        position: { x: 0, y: 1, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        deployed: true,
      }],
      destructibles: map.destructibles.map((item) => ({
        id: item.stableId,
        revision: 0,
        destroyed: false,
      })),
    });
    const encoded = value.factoryInput!.encodeSnapshot(view, {
      full: true,
      sequence: 1,
      viewerParticipantId: 'guest-participant',
      viewerPeerId: 'guest-peer',
      viewerActorId: 2,
      acknowledgedInputSequence: 1,
      acknowledgedInputByActor: new Map([[2, 1]]),
    });
    for (const packet of encoded.packets) {
      await value.guestCoordinator.handleGameMessage('host-peer', { channel: 'control', data: packet });
    }

    value.guestCoordinator.setLocalInput({ ...emptyCommand(), firePressed: true });
    value.hostCoordinator.fixedUpdate();
    value.guestCoordinator.fixedUpdate();
    await value.flush();

    expect(value.protocolErrors).toEqual([]);
    const frame = (value.receivedInputs.at(-1) as {
      frames: Array<{ sequence: number; clientTick: number; shotTick: number }>;
    }).frames[0];
    expect(frame).toMatchObject({ sequence: 2, clientTick: 2, shotTick: 100 });
  });

  it('samples edge-triggered guest input exactly once inside each 60 Hz send tick', async () => {
    let samples = 0;
    const value = harness({
      sampleLocalInput: () => ({ ...emptyCommand(), firePressed: ++samples === 2 }),
    });
    await startBoth(value);
    expect(samples).toBe(1);
    const before = value.receivedInputs.length;
    value.hostCoordinator.fixedUpdate();
    value.guestCoordinator.fixedUpdate();
    await value.flush();
    value.hostCoordinator.fixedUpdate();
    value.guestCoordinator.fixedUpdate();
    await value.flush();
    expect(samples).toBe(3);
    expect(value.protocolErrors).toEqual([]);
    expect(value.receivedInputs).toHaveLength(before + 2);
    expect(value.receivedInputs.slice(-2).map((input) => (
      input as { frames: Array<{ command: InputCommand }> }
    ).frames[0]?.command.firePressed)).toEqual([true, false]);
  });

  it('binary-deduplicates authoritative events including predicted local fire confirmation', async () => {
    const value = harness();
    await startBoth(value);
    value.guestCoordinator.setLocalInput({ ...emptyCommand(), firePressed: true });
    value.hostCoordinator.fixedUpdate();
    value.guestCoordinator.fixedUpdate();
    await value.flush();
    value.factoryInput?.onEvent(Object.freeze({
      eventId: 1, revision: 2, hostTick: 2, type: 'shotFired',
      payload: Object.freeze({ actorId: 2, predictionInputSequence: 2 }),
    }));
    await value.flush();
    value.factoryInput?.onEvent(Object.freeze({
      eventId: 1, revision: 2, hostTick: 2, type: 'shotFired',
      payload: Object.freeze({ actorId: 2, predictionInputSequence: 2 }),
    }));
    await value.flush();
    expect(value.events.filter((event) => event.role === 'guest' && event.type === 'shotFired')).toEqual([
      { role: 'guest', type: 'shotFired', predicted: true },
    ]);
  });

  it('retries congested authoritative events in event-id order without regenerating packets', async () => {
    const sendFailures = { value: 2 };
    const value = harness({ hostEventSendFailures: sendFailures });
    await startBoth(value);
    value.queue.length = 0;

    const first = Object.freeze({
      eventId: 31, revision: 2, hostTick: 2, type: 'shotFired' as const,
      payload: Object.freeze({ actorId: 2 }),
    });
    const second = Object.freeze({
      eventId: 32, revision: 3, hostTick: 3, type: 'impact' as const,
      payload: Object.freeze({ actorId: 2 }),
    });
    value.factoryInput?.onEvent(first);
    value.factoryInput?.onEvent(second);

    const pending = value.hostCoordinator as unknown as {
      pendingReliableEventQueues: Map<string, Array<{ eventId: number; packet: ArrayBuffer }>>;
    };
    expect(pending.pendingReliableEventQueues.get('guest-peer')?.map((event) => event.eventId)).toEqual([31, 32]);
    expect(value.queue).toHaveLength(0);

    value.hostCoordinator.fixedUpdate();
    expect(value.queue.map((delivery) => decodeReliablePacket(
      delivery.message.data as ArrayBuffer,
      value.guestCoordinator.sessionId,
    ).sequence)).toEqual([31, 32]);
    await value.flush();

    expect(value.events.filter((event) => event.role === 'guest').map((event) => event.type)).toEqual([
      'shotFired', 'impact',
    ]);
    expect(pending.pendingReliableEventQueues).toEqual(new Map());
  });

  it('does not classify a throwing guest presentation observer as protocol abuse', async () => {
    const value = harness({ throwGuestEventObserver: true });
    await startBoth(value);
    value.factoryInput?.onEvent(Object.freeze({
      eventId: 30,
      revision: 2,
      hostTick: 2,
      type: 'impact',
      payload: Object.freeze({ x: 0, y: 0, z: 0 }),
    }));
    await value.flush();

    expect(value.guestCoordinator.state).toBe('active');
    expect(value.protocolErrors).toEqual([]);
    expect(value.disconnected).toEqual([]);
  });

  it('fails closed on event backlog and lets a keyframe-backed reconnect proceed', async () => {
    const sendFailures = { value: MAX_PENDING_RELIABLE_EVENTS_PER_PEER + 1 };
    const value = harness({ hostEventSendFailures: sendFailures });
    await startBoth(value);
    value.queue.length = 0;

    for (let eventId = 1; eventId <= MAX_PENDING_RELIABLE_EVENTS_PER_PEER + 1; eventId++) {
      value.factoryInput?.onEvent(Object.freeze({
        eventId, revision: eventId, hostTick: eventId, type: 'shotFired' as const,
        payload: Object.freeze({ actorId: 2 }),
      }));
    }

    const pending = value.hostCoordinator as unknown as {
      pendingReliableEventQueues: Map<string, Array<{ eventId: number }>>;
    };
    expect(pending.pendingReliableEventQueues.has('guest-peer')).toBe(false);
    expect(value.disconnected).toContain('guest-peer');
    expect(value.protocolErrors.at(-1)?.message).toBe('Reliable authoritative event queue exceeded its bound');
    sendFailures.value = 0;

    expect(value.hostCoordinator.acceptReconnectedParticipant('guest-participant', 'guest-peer-2'))
      .toEqual({ accepted: true, alive: true });
    value.factoryInput?.onEvent(Object.freeze({
      eventId: MAX_PENDING_RELIABLE_EVENTS_PER_PEER + 2,
      revision: 90,
      hostTick: 90,
      type: 'playerRejoin',
      payload: Object.freeze({ actorId: 2, peerId: 'guest-peer', newPeerId: 'guest-peer-2' }),
    }));
    value.hostCoordinator.handleConnectionState('guest-peer-2', 'connected');
    expect(value.disconnected).not.toContain('guest-peer-2');
    expect(value.queue.map((delivery) => delivery.message.channel)).toEqual(['event', 'control']);
    expect(pending.pendingReliableEventQueues.has('guest-peer-2')).toBe(false);
  });

  it('bounds active guest keyframe recovery to one pending request without global fanout', async () => {
    const value = harness();
    await startBoth(value);
    value.queue.length = 0;

    expect(value.guestCoordinator.requestRecoveryKeyframe()).toBe(true);
    await value.flush();
    expect(value.keyframeRequests).toBe(0);

    const pending = value.hostCoordinator as unknown as {
      pendingRecoveryKeyframes: Map<string, { pending: boolean; lastAcceptedHostTick: number }>;
    };
    expect(pending.pendingRecoveryKeyframes.get('guest-peer')).toMatchObject({ pending: true });

    const duplicate = encodeReliablePacket({
      kind: 'keyframe-request',
      sessionId: value.hostCoordinator.sessionId,
      sequence: 100,
      tick: 1,
      payload: {},
    });
    expect(await value.hostCoordinator.handleGameMessage('guest-peer', {
      channel: 'control',
      data: duplicate,
    })).toBe(false);
    expect(value.keyframeRequests).toBe(0);
    expect(value.protocolErrors.at(-1)?.message).toBe('Duplicate keyframe request while recovery is pending');

    const encoded = value.factoryInput!.encodeSnapshot(guestSnapshotView(), {
      full: false,
      sequence: 7,
      viewerParticipantId: 'guest-participant',
      viewerPeerId: 'guest-peer',
      viewerActorId: 2,
      acknowledgedInputSequence: 0,
      acknowledgedInputByActor: new Map(),
    });
    expect(encoded.packets.length).toBeGreaterThan(0);
    expect(encoded.packets.every((packet) => decodeSnapshotChunk(packet).full)).toBe(true);
    const unaffectedOptions = {
      viewerParticipantId: 'other-participant',
      viewerPeerId: 'other-peer',
      viewerActorId: 2,
      acknowledgedInputSequence: 0,
      acknowledgedInputByActor: new Map<number, number>(),
    } as const;
    value.factoryInput!.encodeSnapshot(guestSnapshotView(), {
      ...unaffectedOptions,
      full: true,
      sequence: 7,
    });
    const unaffectedPeer = value.factoryInput!.encodeSnapshot(guestSnapshotView(), {
      ...unaffectedOptions,
      full: false,
      sequence: 8,
    });
    expect(unaffectedPeer.packets.every((packet) => !decodeSnapshotChunk(packet).full)).toBe(true);
    for (const packet of encoded.packets) {
      expect(value.factoryInput!.transport.send('guest-peer', 'snapshot', packet, 7)).toBe(true);
    }
    expect(value.queue.every((delivery) => delivery.message.channel === 'control')).toBe(true);
    expect(pending.pendingRecoveryKeyframes.get('guest-peer')).toMatchObject({ pending: false });
    await value.flush();

    const acceptedAt = pending.pendingRecoveryKeyframes.get('guest-peer')!.lastAcceptedHostTick;
    const rateLimited = encodeReliablePacket({
      kind: 'keyframe-request',
      sessionId: value.hostCoordinator.sessionId,
      sequence: 101,
      tick: acceptedAt,
      payload: {},
    });
    expect(await value.hostCoordinator.handleGameMessage('guest-peer', {
      channel: 'control',
      data: rateLimited,
    })).toBe(false);
    expect(value.protocolErrors.at(-1)?.message).toBe('Keyframe request rate exceeded');

    for (let tick = 0; tick < KEYFRAME_REQUEST_MIN_INTERVAL_TICKS; tick++) value.hostCoordinator.fixedUpdate();
    const afterRateWindow = encodeReliablePacket({
      kind: 'keyframe-request',
      sessionId: value.hostCoordinator.sessionId,
      sequence: 102,
      tick: KEYFRAME_REQUEST_MIN_INTERVAL_TICKS,
      payload: {},
    });
    expect(await value.hostCoordinator.handleGameMessage('guest-peer', {
      channel: 'control',
      data: afterRateWindow,
    })).toBe(true);
  });

  it('disconnects an active guest after repeated unique pending keyframe requests', async () => {
    const value = harness();
    await startBoth(value);
    value.queue.length = 0;
    expect(value.guestCoordinator.requestRecoveryKeyframe()).toBe(true);
    await value.flush();

    for (let index = 0; index < MAX_COORDINATOR_VIOLATIONS; index++) {
      const packet = encodeReliablePacket({
        kind: 'keyframe-request',
        sessionId: value.hostCoordinator.sessionId,
        sequence: 200 + index,
        tick: 1,
        payload: {},
      });
      expect(await value.hostCoordinator.handleGameMessage('guest-peer', {
        channel: 'control',
        data: packet,
      })).toBe(false);
    }

    const privateState = value.hostCoordinator as unknown as { violations: Map<string, number> };
    expect(privateState.violations.get('guest-peer')).toBe(MAX_COORDINATOR_VIOLATIONS);
    expect(value.disconnected).toContain('guest-peer');
  });

  it('presents each host presence notice once while replicating it to the guest', async () => {
    const value = harness();
    await startBoth(value);
    value.factoryInput?.onPresenceNotice('left', 'GUEST');
    value.factoryInput?.onEvent(Object.freeze({
      eventId: 7,
      revision: 3,
      hostTick: 2,
      type: 'playerLeave',
      payload: Object.freeze({ actorId: 2, peerId: 'guest-peer' }),
    }));
    await value.flush();

    expect(value.notices).toEqual([{ kind: 'left', displayName: 'GUEST' }]);
    expect(value.events.filter((event) => event.type === 'playerLeave')).toEqual([
      { role: 'guest', type: 'playerLeave', predicted: false },
    ]);
  });

  it('deduplicates a shot confirmation only when local presentation actually ran', async () => {
    const submitted: Array<{ inputSeq: number; fire: boolean }> = [];
    const value = harness({
      onLocalInputSubmitted(inputSeq, command) {
        submitted.push({ inputSeq, fire: command.firePressed || command.fireHeld });
        return false;
      },
    });
    await startBoth(value);
    value.guestCoordinator.setLocalInput({ ...emptyCommand(), firePressed: true });
    value.hostCoordinator.fixedUpdate();
    value.guestCoordinator.fixedUpdate();
    await value.flush();
    value.factoryInput?.onEvent(Object.freeze({
      eventId: 1, revision: 2, hostTick: 2, type: 'shotFired',
      payload: Object.freeze({ actorId: 2, predictionInputSequence: 2 }),
    }));
    await value.flush();
    expect(submitted).toEqual([
      { inputSeq: 1, fire: false },
      { inputSeq: 2, fire: true },
    ]);
    expect(value.events.filter((event) => event.role === 'guest' && event.type === 'shotFired')).toEqual([
      { role: 'guest', type: 'shotFired', predicted: false },
    ]);
  });

  it('fails closed on a map-hash mismatch and tears down after host disconnect grace', async () => {
    const mismatch = harness({ mismatchedGuestMap: true });
    await mismatch.hostCoordinator.beginHost();
    await mismatch.flush();
    expect(mismatch.hostCoordinator.state).toBe('waiting-ready');
    expect(mismatch.hostCoordinator.barrierStatus?.failedParticipantIds).toEqual(['guest-participant']);
    expect(mismatch.guestCoordinator.replica).toBeNull();

    const now = { value: 0 };
    const value = harness({ now });
    await startBoth(value);
    value.guestCoordinator.handleConnectionState('host-peer', 'restarting' satisfies GameConnectionState);
    expect(value.guestCoordinator.state).toBe('reconnecting');
    now.value = 101;
    value.guestCoordinator.update(0);
    expect(value.guestCoordinator.state).toBe('ended');
    expect(value.ends).toEqual(['host-disconnected']);
    expect(value.disconnected).toContain('host-peer');
  });

  it('delivers host cancellation to a guest that already reported a load failure', async () => {
    const value = harness({ mismatchedGuestMap: true });
    await value.hostCoordinator.beginHost();
    await value.flush();
    expect(value.guestCoordinator.state).toBe('failed');
    expect(value.hostCoordinator.barrierStatus?.failedParticipantIds).toEqual(['guest-participant']);

    value.hostCoordinator.cancelStart();
    await value.flush();

    expect(value.guestCoordinator.state).toBe('ended');
    expect(value.ends).toEqual(['cancelled']);
  });

  it('preserves an authoritative host-ended reason after an active match', async () => {
    const value = harness();
    await startBoth(value);
    value.hostCoordinator.endHostMatch();
    await value.flush();
    expect(value.guestCoordinator.state).toBe('ended');
    expect(value.ends).toEqual(['host-ended']);
  });

  it('warns guests when the host is hidden and terminates after the bounded grace period', async () => {
    const now = { value: 0 };
    const value = harness({ now, hostInactivityGraceMs: 1_000 });
    await startBoth(value);
    value.queue.length = 0;

    value.hostCoordinator.setHostVisibility(true);
    await value.flush();
    expect(value.visibility).toEqual([true]);
    expect(value.guestCoordinator.state).toBe('active');

    now.value = 999;
    expect(value.hostCoordinator.enforceHostVisibilityDeadline()).toBe(false);
    expect(value.hostCoordinator.state).toBe('active');
    value.hostCoordinator.setHostVisibility(false);
    await value.flush();
    expect(value.visibility).toEqual([true, false]);

    value.hostCoordinator.setHostVisibility(true);
    now.value = 1_998;
    expect(value.hostCoordinator.enforceHostVisibilityDeadline()).toBe(false);
    now.value = 1_999;
    expect(value.hostCoordinator.enforceHostVisibilityDeadline()).toBe(true);
    await value.flush();
    expect(value.hostCoordinator.state).toBe('ended');
    expect(value.guestCoordinator.state).toBe('ended');
    expect(value.ends).toEqual(['host-inactive']);
  });

  it('defers the authenticated reconnect result until the replacement DataChannel is connected', async () => {
    const value = harness();
    await startBoth(value);
    value.queue.length = 0;
    value.hostCoordinator.handleConnectionState('guest-peer', 'failed');
    expect(value.hostCoordinator.acceptReconnectedParticipant('guest-participant', 'guest-peer-2'))
      .toEqual({ accepted: true, alive: true });
    expect(value.queue).toHaveLength(0);
    expect(value.keyframeRequests).toBe(0);

    value.hostCoordinator.handleConnectionState('guest-peer-2', 'connected');
    expect(value.queue).toHaveLength(1);
    const packet = decodeReliablePacket(value.queue[0]!.message.data as ArrayBuffer, value.hostCoordinator.sessionId);
    expect(packet.kind).toBe('reconnect-result');
    expect(packet.payload).toMatchObject({
      accepted: true,
      alive: true,
      participantId: 'guest-participant',
      actorId: 2,
      startPayload: { type: 'match-prepare', mapId: 'oldfront' },
    });
    expect(value.keyframeRequests).toBe(0);
    const recovery = value.hostCoordinator as unknown as {
      pendingRecoveryKeyframes: Map<string, { pending: boolean }>;
    };
    expect(recovery.pendingRecoveryKeyframes.get('guest-peer-2')).toMatchObject({ pending: true });
    await value.flush();
    const guestRecovery = value.guestCoordinator as unknown as {
      awaitingRecoveryKeyframe: boolean;
      keyframeRequested: boolean;
    };
    expect(guestRecovery).toMatchObject({ awaitingRecoveryKeyframe: true, keyframeRequested: true });
    expect(value.protocolErrors).toEqual([]);
    expect(value.queue).toHaveLength(0);
    value.hostCoordinator.handleConnectionState('guest-peer-2', 'connected');
    expect(value.queue).toHaveLength(0);
  });

  it('keeps coordinator peer ownership on the disconnected generation until commit', async () => {
    const value = harness();
    await startBoth(value);
    value.hostCoordinator.handleConnectionState('guest-peer', 'failed');

    const transaction = value.hostCoordinator.prepareAcceptedReconnectedParticipant(
      'guest-participant',
      'guest-peer-2',
    );
    expect(transaction.accepted).toBe(true);
    const privateState = value.hostCoordinator as unknown as {
      knownPeerIds: Set<string>;
      activeGuestPeerIds: Set<string>;
      connectedGuestPeerIds: Set<string>;
      guestPeerByParticipant: Map<string, string>;
      pendingReconnectResults: Map<string, unknown>;
    };
    expect([...privateState.knownPeerIds]).toEqual(['guest-peer']);
    expect(privateState.activeGuestPeerIds).toEqual(new Set());
    expect(privateState.connectedGuestPeerIds).toEqual(new Set());
    expect(privateState.guestPeerByParticipant.get('guest-participant')).toBe('guest-peer');
    expect(privateState.pendingReconnectResults.has('guest-peer-2')).toBe(false);

    transaction.rollback();
    expect([...privateState.knownPeerIds]).toEqual(['guest-peer']);
    expect(privateState.guestPeerByParticipant.get('guest-participant')).toBe('guest-peer');
  });

  it('keeps a committed reconnect authoritative when stale transport close throws', async () => {
    const value = harness({ throwOnDisconnectPeerId: 'guest-peer' });
    await startBoth(value);
    value.hostCoordinator.handleConnectionState('guest-peer', 'failed');

    let result: { accepted: boolean; alive: boolean } | undefined;
    expect(() => {
      result = value.hostCoordinator.acceptReconnectedParticipant('guest-participant', 'guest-peer-2');
    }).not.toThrow();
    expect(result).toEqual({ accepted: true, alive: true });
    const privateState = value.hostCoordinator as unknown as {
      knownPeerIds: Set<string>;
      guestPeerByParticipant: Map<string, string>;
      pendingReconnectResults: Map<string, unknown>;
    };
    expect([...privateState.knownPeerIds]).toEqual(['guest-peer-2']);
    expect(privateState.guestPeerByParticipant.get('guest-participant')).toBe('guest-peer-2');
    expect(privateState.pendingReconnectResults.has('guest-peer-2')).toBe(true);
  });

  it('keeps only the current peer generation across repeated reconnects', async () => {
    const value = harness();
    await startBoth(value);
    value.hostCoordinator.handleConnectionState('guest-peer', 'failed');
    expect(value.hostCoordinator.acceptReconnectedParticipant('guest-participant', 'guest-peer-2').accepted).toBe(true);
    value.hostCoordinator.handleConnectionState('guest-peer-2', 'connected');
    value.hostCoordinator.handleConnectionState('guest-peer-2', 'failed');
    expect(value.hostCoordinator.acceptReconnectedParticipant('guest-participant', 'guest-peer-3').accepted).toBe(true);

    const privateState = value.hostCoordinator as unknown as { knownPeerIds: Set<string> };
    expect([...privateState.knownPeerIds]).toEqual(['guest-peer-3']);
    expect(value.disconnected).toEqual(expect.arrayContaining(['guest-peer', 'guest-peer-2']));
  });

  it('rejects reconnect expiry without retaining an unauthenticated peer generation', async () => {
    const value = harness({ reconnectAccepted: false });
    await startBoth(value);
    value.queue.length = 0;
    value.hostCoordinator.handleConnectionState('guest-peer', 'failed');
    expect(value.hostCoordinator.acceptReconnectedParticipant('guest-participant', 'guest-peer-2'))
      .toEqual({ accepted: false, alive: false });
    expect(value.queue).toHaveLength(0);
    value.hostCoordinator.handleConnectionState('guest-peer-2', 'connected');
    expect(value.queue).toHaveLength(0);
    expect(value.keyframeRequests).toBe(0);
    expect(value.disconnected).not.toContain('guest-peer-2');
  });

  it.each([true, false])('bootstraps a fresh reconnected guest without rerunning the start barrier (alive=%s)', async (alive) => {
    const value = harness({ reconnectAlive: alive });
    await startBoth(value);
    value.queue.length = 0;
    value.hostCoordinator.handleConnectionState('guest-peer', 'failed');
    value.hostCoordinator.acceptReconnectedParticipant('guest-participant', 'guest-peer-2');
    value.hostCoordinator.handleConnectionState('guest-peer-2', 'connected');
    const delivery = value.queue.shift();
    expect(delivery?.message.channel).toBe('control');

    const outgoing: Array<{ peerId: string; channel: GameChannelLabel; data: GamePayload }> = [];
    let inputSends = 0;
    const loadedActorIds: number[] = [];
    const lifecycle: string[] = [];
    const reconnectResults: Array<{ accepted: boolean; alive: boolean }> = [];
    const fresh = new OnlineMatchCoordinator({
      context: withReconnectedGuestPeer(value.contexts.guest, 'guest-peer-2'),
      room: {
        sendGameMessage(peerId, channel, data) { outgoing.push({ peerId, channel, data }); return true; },
        sendGameInput() { inputSends++; return true; },
        disconnectGamePeer() { return true; },
      },
      resolveMap: () => loadMap('oldfront').def,
      loadGuest(input) { loadedActorIds.push(input.localActorId); },
      onRuntimeReady(role) { lifecycle.push(`ready:${role}`); },
      onActivated(role) { lifecycle.push(`active:${role}`); },
      onReconnectResult(accepted, actorAlive) { reconnectResults.push({ accepted, alive: actorAlive }); },
    });
    expect(delivery).toBeDefined();
    expect(await fresh.handleGameMessage('host-peer', delivery!.message)).toBe(true);
    expect(fresh.state).toBe('active');
    expect(fresh.replica?.localActorId).toBe(2);
    expect(fresh.payload?.mapId).toBe('oldfront');
    expect(loadedActorIds).toEqual([2]);
    expect(lifecycle).toEqual(['ready:guest', 'active:guest']);
    expect(reconnectResults).toEqual([{ accepted: true, alive }]);
    expect(outgoing).toHaveLength(0);
    fresh.fixedUpdate();
    expect(inputSends).toBe(0);
    expect(outgoing).toHaveLength(0);
  });
});
