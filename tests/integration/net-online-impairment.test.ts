import { beforeAll, describe, expect, it } from 'vitest';
import { CAPSULE_CENTER_OFFSET, CharBody, initPhysics, PhysicsWorld } from '../../src/physics/physics';
import { Actor } from '../../src/sim/actor';
import { CombatSystem } from '../../src/sim/combat';
import { emptyCommand, type InputCommand } from '../../src/sim/input';
import { Match } from '../../src/sim/match';
import type { ActorView, GameStateView } from '../../src/sim/gameStateView';
import {
  buildRoster,
  localHumanRosterEntry,
  type MatchMode,
} from '../../src/sim/roster';
import { loadMap } from '../../src/world';
import { ClientReplica } from '../../src/net/clientReplica';
import {
  MatchStateCodecError,
  MatchStateDecoder,
  MatchStateEncoder,
} from '../../src/net/matchStateCodec';
import {
  FakeMatchTransport,
  type FakeMatchTransportOptions,
  type FakeTransportMessage,
} from '../../src/net/fakeTransport';
import {
  HostAuthoritativeMatchSession,
  RECONNECT_WINDOW_MS,
  type HostMatchTransport,
} from '../../src/net/hostMatchSession';
import { qaRosterFixtures, rosterFixture } from '../fixtures/multiplayer';

const STEP = 1 / 60;
const MATCH_TEST_TIMEOUT = 60_000;
const SESSION_ID = 0x23_04_2026;

beforeAll(async () => initPhysics());

interface ImpairmentCase {
  readonly label: string;
  readonly latencyMs: number;
  readonly lossRate: number;
  readonly jitterMs: number;
}

interface MeasuredTransportCase {
  readonly label: string;
  readonly attempted: number;
  readonly delivered: number;
  readonly lost: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxQueueDepth: number;
}

const IMPAIRMENT_CASES: readonly ImpairmentCase[] = Object.freeze([
  { label: 'baseline', latencyMs: 0, lossRate: 0, jitterMs: 0 },
  { label: 'low', latencyMs: 30, lossRate: 0.01, jitterMs: 20 },
  { label: 'medium', latencyMs: 80, lossRate: 0.03, jitterMs: 50 },
  { label: 'high', latencyMs: 150, lossRate: 0.05, jitterMs: 20 },
  { label: 'severe', latencyMs: 250, lossRate: 0.10, jitterMs: 50 },
]);

function transportOptions(input: Partial<FakeMatchTransportOptions> = {}): FakeMatchTransportOptions {
  return {
    seed: 0x5048_3451,
    endpointIds: ['host', 'guest'],
    ...input,
  };
}

function measureUnreliable(options: FakeMatchTransportOptions, count = 512): MeasuredTransportCase {
  const transport = new FakeMatchTransport(options);
  const received: FakeTransportMessage[] = [];
  transport.guest.onMessage((message) => received.push(message));
  for (let index = 0; index < count; index += 1) {
    expect(transport.host.send('snapshot', { index, marker: 'representative' })).toBe(true);
  }
  transport.flushAll();
  const metrics = transport.getMetrics();
  return {
    label: String(options.latencyMs ?? options.baseLatencyMs ?? 'default'),
    attempted: metrics.attempted,
    delivered: received.length,
    lost: metrics.lost,
    p50Ms: metrics.latency.p50Ms,
    p95Ms: metrics.latency.p95Ms,
    maxQueueDepth: metrics.maxQueueDepth,
  };
}

function actorView(
  id: number,
  ownership: ActorView['ownership'],
): ActorView {
  return Object.freeze({
    id,
    displayName: `PLAYER ${id}`,
    ownership: Object.freeze(ownership),
    connectionState: 'connected',
    teamId: null,
    skinId: 'vanguard',
    accentColor: 0x112233 + id,
    alive: true,
    health: 100,
    shield: 100,
    position: Object.freeze({ x: id, y: 2, z: -id }),
    velocity: Object.freeze({ x: 0, y: 0, z: 0 }),
    yaw: 0,
    pitch: 0,
    grounded: true,
    moveState: 'ground',
    crouched: false,
    deployed: true,
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
  });
}

function replicaState(
  revision = 1,
  includeDestructibles = true,
  denseDestructibles = false,
): GameStateView {
  const destructibleIds = denseDestructibles
    ? Array.from({ length: 1024 }, (_, index) => `glass:${index.toString(36).padStart(4, '0')}`)
    : [];
  const actors = denseDestructibles
    ? Array.from({ length: 10 }, (_, index) => actorView(index + 1, index === 0
      ? { kind: 'local-human', peerId: 'host' }
      : { kind: 'remote-human', peerId: `guest-${index + 1}` }))
    : [
        actorView(1, { kind: 'local-human', peerId: 'host' }),
        actorView(2, { kind: 'remote-human', peerId: 'guest' }),
      ];
  const chests = denseDestructibles
    ? Array.from({ length: 38 }, (_, index) => ({
        id: index + 1, kind: 'standard' as const, x: index, y: 1, z: -index, opened: false,
      }))
    : [];
  const loot = denseDestructibles
    ? Array.from({ length: 103 }, (_, index) => ({
        id: index + 1, kind: 'ammo' as const, x: index, y: 0, z: -index, yaw: 0,
        rarity: 'common' as const, ammoType: 'light' as const, amount: 10,
      }))
    : [{ id: 1, kind: 'ammo' as const, x: 0, y: 0, z: 0, yaw: 0,
        rarity: 'common' as const, ammoType: 'light' as const, amount: 10 }];
  return Object.freeze({
    hostTick: revision,
    stateRevision: revision,
    time: revision / 60,
    phaseTime: revision / 60,
    phase: 'live',
    actors: Object.freeze(actors),
    localActorId: 1,
    teams: Object.freeze([]),
    mode: 'ffa',
    chests: Object.freeze(chests),
    loot: Object.freeze(loot),
    storm: Object.freeze({ state: 'idle', phaseIndex: -1, timer: 0, centerX: 0, centerZ: 0, radius: 0 }),
    transport: Object.freeze({ x: 0, y: 80, z: 0, jumpAllowed: true }),
    localMovement: null,
    destructibles: denseDestructibles
      ? Object.freeze(destructibleIds.map((id) => ({ id, revision: 1, destroyed: false })))
      : includeDestructibles
        ? Object.freeze([{ id: 'upper-glass-1', revision: 1, destroyed: false }])
        : Object.freeze([]),
    winner: null,
    teamResults: Object.freeze([]),
  });
}

function snapshotOptions(full: boolean, sequence: number) {
  return {
    full,
    sequence,
    viewerParticipantId: 'guest-participant',
    viewerPeerId: 'guest',
    viewerActorId: 1,
    acknowledgedInputSequence: 0,
    acknowledgedInputByActor: new Map([[1, 0]]),
  } as const;
}

interface HostScenario {
  readonly match: Match;
  readonly session: HostAuthoritativeMatchSession;
  readonly fake: FakeMatchTransport;
  readonly now: { value: number };
}

function makeHostScenario(mode: MatchMode = 'ffa', teams: readonly (number | null)[] = []): HostScenario {
  const humans = mode === 'ffa'
    ? [
        localHumanRosterEntry({ slotId: 0, actorId: 1, peerId: 'peer-1', displayName: 'HOST' }),
        { ...localHumanRosterEntry({ slotId: 1, actorId: 2, peerId: 'peer-2', displayName: 'GUEST' }),
          ownership: { kind: 'remote-human' as const, peerId: 'peer-2' } },
      ]
    : teams.map((teamId, index) => index === 0
      ? localHumanRosterEntry({ slotId: index, actorId: index + 1, peerId: 'peer-1', displayName: 'HOST', teamId })
      : { ...localHumanRosterEntry({ slotId: index, actorId: index + 1, peerId: `peer-${index + 1}`, displayName: `GUEST ${index}`, teamId }),
          ownership: { kind: 'remote-human' as const, peerId: `peer-${index + 1}` } });
  const roster = buildRoster({ mode, humans, seed: 414 });
  const match = new Match({
    mapDef: loadMap('eden').def,
    seed: 414,
    difficulty: 'normal',
    mode,
    roster,
  });
  const remoteEntries = roster.filter((entry) => entry.ownership.kind === 'remote-human');
  const endpointIds = ['peer-1', ...remoteEntries.map((entry) => (
    entry.ownership.kind === 'bot' ? '' : entry.ownership.peerId
  ))].filter((value): value is string => value.length > 0);
  const fake = new FakeMatchTransport({ endpointIds, latencyMs: 10 });
  const now = { value: 0 };
  const transport: HostMatchTransport = {
    send: (peerId, channel, data) => fake.send('peer-1', peerId, channel, data),
    disconnect: (peerId) => fake.disconnect('peer-1', peerId),
  };
  const bindings = remoteEntries.map((entry) => ({
    participantId: `participant-${entry.actorId}`,
    peerId: entry.ownership.kind === 'bot' ? '' : entry.ownership.peerId,
    actorId: entry.actorId,
    teamId: entry.teamId,
  })).filter((binding) => binding.peerId.length > 0);
  const session = new HostAuthoritativeMatchSession(match, bindings, transport,
    (_view, options) => ({
      packets: [new ArrayBuffer(options.full ? 320 : 160)],
      totalBytes: options.full ? 320 : 160,
    }),
    { nowMs: () => now.value });
  return { match, session, fake, now };
}

function validRemoteEnvelope(sequence = 1) {
  const command: InputCommand = { ...emptyCommand(), moveZ: 1, yaw: 0, pitch: 0 };
  return {
    receivedHostTick: sequence,
    frames: [{
      sequence,
      clientTick: sequence,
      lastAcknowledgedHostTick: 0,
      shotTick: sequence,
      command,
    }],
  } as const;
}

describe('Phase 4 deterministic online impairment matrix', () => {
  it('measures every representative latency/loss/jitter row with reproducible bounded outcomes', () => {
    const latencyMeasurements = [0, 30, 80, 150, 250].map((latencyMs) => {
      const first = new FakeMatchTransport(transportOptions({ latencyMs }));
      const second = new FakeMatchTransport(transportOptions({ latencyMs }));
      const firstReceived: FakeTransportMessage[] = [];
      const secondReceived: FakeTransportMessage[] = [];
      first.guest.onMessage((message) => firstReceived.push(message));
      second.guest.onMessage((message) => secondReceived.push(message));
      for (let index = 0; index < 12; index += 1) {
        expect(first.host.send('event', { index })).toBe(true);
        expect(second.host.send('event', { index })).toBe(true);
      }
      first.flushAll();
      second.flushAll();
      const firstMetrics = first.getMetrics();
      expect(firstReceived).toEqual(secondReceived);
      expect(firstMetrics).toEqual(second.getMetrics());
      expect(firstReceived).toHaveLength(12);
      expect(firstMetrics.latency.p50Ms).toBe(latencyMs);
      expect(firstMetrics.latency.p95Ms).toBe(latencyMs);
      return { latencyMs, p50Ms: firstMetrics.latency.p50Ms, p95Ms: firstMetrics.latency.p95Ms };
    });

    const impairmentMeasurements = IMPAIRMENT_CASES.map((scenario) => {
      const first = measureUnreliable(transportOptions({
        seed: 0x1a2b_3c4d,
        latencyMs: scenario.latencyMs,
        lossRate: scenario.lossRate,
        jitterMs: scenario.jitterMs,
        maxQueueMessages: 1024,
      }));
      const second = measureUnreliable(transportOptions({
        seed: 0x1a2b_3c4d,
        latencyMs: scenario.latencyMs,
        lossRate: scenario.lossRate,
        jitterMs: scenario.jitterMs,
        maxQueueMessages: 1024,
      }));
      expect(first).toEqual(second);
      expect(first.attempted).toBe(512);
      expect(first.delivered + first.lost).toBe(512);
      expect(first.maxQueueDepth).toBeLessThanOrEqual(1024);
      if (scenario.lossRate === 0) expect(first.lost).toBe(0);
      else expect(first.lost).toBeGreaterThan(0);
      expect(first.p50Ms).toBeGreaterThanOrEqual(Math.max(0, scenario.latencyMs - scenario.jitterMs));
      expect(first.p95Ms).toBeLessThanOrEqual(scenario.latencyMs + scenario.jitterMs);
      return { ...scenario, delivered: first.delivered, lost: first.lost, p50Ms: first.p50Ms, p95Ms: first.p95Ms };
    });

    // Keep measured values visible in CI output without turning them into a
    // fragile golden snapshot. Re-running the same seed above is the exactness
    // check; this line is the inspectable report for a future impairment audit.
    console.info('[net-impairment]', JSON.stringify({ latencyMeasurements, impairmentMeasurements }));
    expect(latencyMeasurements.map((row) => row.latencyMs)).toEqual([0, 30, 80, 150, 250]);
    expect(impairmentMeasurements.map((row) => row.lossRate)).toEqual([0, 0.01, 0.03, 0.05, 0.1]);
    expect(impairmentMeasurements.map((row) => row.jitterMs)).toEqual([0, 20, 50, 20, 50]);
  });

  it('keeps ordered authoritative events unique while exposing duplicate/reorder metrics', () => {
    const transport = new FakeMatchTransport(transportOptions({
      seed: 42,
      latencyMs: 10,
      duplicateRate: 1,
      reorderRate: 1,
      reorderWindowMs: 3,
    }));
    const received: FakeTransportMessage[] = [];
    transport.guest.onMessage((message) => received.push(message));
    for (let index = 0; index < 48; index += 1) {
      expect(transport.host.send('event', { index })).toBe(true);
    }
    transport.flushAll();
    const metrics = transport.getMetrics();
    expect(received.map((message) => (message.data as { index: number }).index))
      .toEqual(Array.from({ length: 48 }, (_, index) => index));
    expect(new Set(received.map((message) => message.sequence)).size).toBe(48);
    expect(metrics.duplicates).toBeGreaterThan(0);
    expect(metrics.reordered).toBeGreaterThan(0);
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.maxQueueDepth).toBeLessThanOrEqual(metrics.maxQueueMessages);
  });

  it('drops stale ordered packets and surfaces malformed packets without hiding metrics', () => {
    const transport = new FakeMatchTransport(transportOptions({ latencyMs: 0 }));
    const received: FakeTransportMessage[] = [];
    transport.guest.onMessage((message) => received.push(message));
    expect(transport.host.send('event', { eventId: 1, revision: 1, type: 'phaseChanged' })).toBe(true);
    transport.flushAll();
    expect(transport.injectStale('guest', 'event', { eventId: 1 }, {
      from: 'host', sequence: 0, bypassOrdering: false,
    })).toBeGreaterThan(0);
    expect(transport.injectMalformed('guest', 'control', new Uint8Array([0xff]))).toBeGreaterThan(0);
    transport.flushAll();
    expect(received.map((message) => message.kind)).toEqual(['normal', 'malformed']);
    expect(transport.getMetrics()).toMatchObject({
      staleInjected: 1,
      staleDropped: 1,
      malformedInjected: 1,
      malformedDelivered: 1,
    });
  });

  it('rejects snapshot congestion at a fixed queue bound and drains cleanly', () => {
    const transport = new FakeMatchTransport(transportOptions({
      latencyMs: 1_000,
      maxQueueMessages: 8,
      maxQueueBytes: 512,
    }));
    const accepted = Array.from({ length: 100 }, (_, index) => (
      transport.host.send('snapshot', new Uint8Array(48).fill(index & 0xff))
    ));
    const beforeDrain = transport.getMetrics();
    expect(accepted.filter(Boolean)).toHaveLength(8);
    expect(beforeDrain.queueDepth).toBe(8);
    expect(beforeDrain.queueBytes).toBeLessThanOrEqual(512);
    expect(beforeDrain.queueRejected).toBeGreaterThan(0);
    expect(beforeDrain.maxQueueDepth).toBe(8);
    expect(beforeDrain.maxQueueDepth).toBeLessThanOrEqual(beforeDrain.maxQueueMessages);
    expect(beforeDrain.maxQueueBytes).toBeLessThanOrEqual(beforeDrain.maxQueueCapacityBytes);
    transport.flushAll();
    expect(transport.queueDepth).toBe(0);
    expect(transport.queueBytes).toBe(0);
  });

  it('requires a complete keyframe after congestion drops one of its chunks', () => {
    const destructibleOrder = Array.from({ length: 1024 }, (_, index) => `glass:${index.toString(36).padStart(4, '0')}`);
    const encoder = new MatchStateEncoder(SESSION_ID, 1, destructibleOrder);
    const decoder = new MatchStateDecoder(SESSION_ID, destructibleOrder);
    const full = encoder.encode(replicaState(1, false, true), snapshotOptions(true, 1));
    expect(full.packets.length).toBeGreaterThan(1);

    const transport = new FakeMatchTransport(transportOptions({ maxQueueMessages: 1, latencyMs: 0 }));
    const received: ArrayBuffer[] = [];
    transport.guest.onMessage((message) => {
      if (message.channel === 'snapshot' && message.data instanceof ArrayBuffer) received.push(message.data);
    });
    expect(transport.host.send('snapshot', full.packets[0]!)).toBe(true);
    for (const packet of full.packets.slice(1)) expect(transport.host.send('snapshot', packet)).toBe(false);
    transport.flushAll();
    for (const packet of received) expect(decoder.add(packet)).toBeNull();
    expect(decoder.hasKeyframe).toBe(false);

    const delta = encoder.encode(replicaState(2, false, true), snapshotOptions(false, 2));
    expect(delta.packets.length).toBeGreaterThan(0);
    transport.host.send('snapshot', delta.packets[0]!);
    transport.flushAll();
    expect(() => decoder.add(delta.packets[0]!)).toThrowError(MatchStateCodecError);
    expect(() => decoder.add(delta.packets[0]!)).toThrow(/keyframe/i);
    expect(transport.getMetrics().queueRejected).toBeGreaterThan(0);
  });

  it('applies duplicated authoritative elimination, pickup, and glass events once', () => {
    const replica = new ClientReplica({ now: () => 0 });
    expect(replica.applySnapshot({ state: replicaState(1), hostTime: 0 }).accepted).toBe(true);
    const transport = new FakeMatchTransport(transportOptions({ latencyMs: 0 }));
    const results: boolean[] = [];
    transport.guest.onMessage((message) => {
      const event = message.data as { eventId: number; revision: number; type: string; payload: unknown };
      const result = replica.applyEvent(event);
      results.push(result.accepted);
    });
    const events = [
      { eventId: 10, revision: 2, hostTick: 2, type: 'itemPickedUp', payload: { itemId: 1 } },
      { eventId: 11, revision: 3, hostTick: 3, type: 'glassBreak', payload: { destructibleId: 'upper-glass-1', revision: 7 } },
      { eventId: 12, revision: 4, hostTick: 4, type: 'glassBreak', payload: { destructibleId: 'upper-glass-1', revision: 2 } },
      { eventId: 13, revision: 5, hostTick: 5, type: 'eliminated', payload: { victimId: 2, placement: 2 } },
    ];
    for (const event of events) {
      expect(transport.host.send('event', event)).toBe(true);
      expect(transport.host.send('event', event)).toBe(true);
    }
    transport.flushAll();
    expect(results).toEqual([true, false, true, false, true, false, true, false]);
    const view = replica.viewAt(0)!;
    expect(view.loot).toHaveLength(0);
    expect(view.destructibles.find((item) => item.id === 'upper-glass-1')).toMatchObject({
      destroyed: true,
      revision: 7,
    });
    expect(view.actors.find((actor) => actor.id === 2)).toMatchObject({ alive: false, placement: 2 });
  });
});

describe('Phase 4 roster and host session scenarios', () => {
  it('builds each representative FFA/team roster without an impossible winner shape', () => {
    const cases = [
      { label: '2-player FFA', mode: 'ffa' as const, humans: 2, teams: [] as readonly (number | null)[], actors: 2 },
      { label: '3-player FFA', mode: 'ffa' as const, humans: 3, teams: [] as readonly (number | null)[], actors: 3 },
      { label: '4-player FFA', mode: 'ffa' as const, humans: 4, teams: [] as readonly (number | null)[], actors: 4 },
      { label: '1v1', mode: 'teams' as const, humans: 2, teams: [0, 1], actors: 2 },
      { label: '2v1', mode: 'teams' as const, humans: 3, teams: [0, 0, 1], actors: 3 },
      { label: '2v2', mode: 'teams' as const, humans: 4, teams: [0, 0, 1, 1], actors: 4 },
    ];
    const measured = cases.map((scenario) => {
      const roster = rosterFixture(scenario.mode, scenario.humans, scenario.teams, 90210);
      expect(roster).toHaveLength(scenario.actors);
      expect(roster.filter((entry) => entry.ownership.kind !== 'bot')).toHaveLength(scenario.humans);
      expect(new Set(roster.map((entry) => entry.actorId)).size).toBe(roster.length);
      if (scenario.mode === 'ffa') {
        expect(roster.every((entry) => entry.teamId === null)).toBe(true);
        expect(roster.every((a) => roster.every((b) => a.actorId === b.actorId || a.teamId === b.teamId))).toBe(true);
      } else {
        expect(new Set(roster.map((entry) => entry.teamId))).toEqual(new Set([0, 1]));
      }
      return { label: scenario.label, actors: roster.length, humans: scenario.humans };
    });

    const fiveVsFive = qaRosterFixtures.fiveVsFiveWithBots();
    expect(fiveVsFive).toHaveLength(10);
    expect(fiveVsFive.filter((entry) => entry.teamId === 0)).toHaveLength(5);
    expect(fiveVsFive.filter((entry) => entry.teamId === 1)).toHaveLength(5);
    expect(fiveVsFive.filter((entry) => entry.ownership.kind === 'bot')).toHaveLength(6);

    const humansVsBots = qaRosterFixtures.fourHumansVsSixBots();
    expect(humansVsBots).toHaveLength(10);
    expect(humansVsBots.filter((entry) => entry.ownership.kind !== 'bot')).toHaveLength(4);
    expect(humansVsBots.filter((entry) => entry.ownership.kind === 'bot')).toHaveLength(6);
    expect(humansVsBots.filter((entry) => entry.teamId === 0)).toHaveLength(4);
    expect(humansVsBots.filter((entry) => entry.teamId === 1)).toHaveLength(6);
    console.info('[net-roster-matrix]', JSON.stringify({ measured, fiveVsFive: 10, humansVsBots: 10 }));
  });

  it('keeps guest input bound to its admitted actor and rejects unknown or malformed control', () => {
    const scenario = makeHostScenario();
    const { match, session } = scenario;
    const guest = match.actors.find((actor) => actor.id === 2)!;
    const host = match.actors.find((actor) => actor.id === 1)!;
    const rejectedUnknown = session.receiveInput('intruder', validRemoteEnvelope());
    const rejectedMalformed = session.receiveInput('peer-2', { receivedHostTick: 1, frames: [] });
    expect(rejectedUnknown).toMatchObject({ accepted: false, reason: 'actor-mismatch' });
    expect(rejectedMalformed).toMatchObject({ accepted: false, reason: 'malformed' });
    expect(session.receiveInput('peer-2', validRemoteEnvelope())).toMatchObject({ accepted: true });
    session.fixedUpdate(STEP);
    expect(session.peerInputTelemetry('participant-2')).toMatchObject({ acceptedPackets: 1 });
    expect(match.controllers.get(guest.id)).toBeDefined();
    expect(match.controllers.get(host.id)).toBeUndefined();
    scenario.match.dispose();
    scenario.fake.dispose();
  }, MATCH_TEST_TIMEOUT);

  it.each([
    ['alive', true, 0],
    ['dead', false, 0],
    ['expired', true, RECONNECT_WINDOW_MS + 1],
  ] as const)('models guest %s disconnect/reconnect semantics', (_label, alive, elapsed) => {
    const scenario = makeHostScenario();
    const { match, session, fake, now } = scenario;
    const guest = match.actors.find((actor) => actor.id === 2)!;
    expect(session.markDisconnected('peer-2')).toBe(true);
    expect(match.connectionStateForActor(guest)).toBe('disconnected');
    if (!alive) {
      match.phase = 'live';
      expect(match.eliminateActor(guest)).toBe(true);
      match.fixedUpdate(STEP);
      expect(guest.alive).toBe(false);
    }
    now.value = elapsed;
    fake.createEndpoint('peer-2-reconnected').setRemote('peer-1');
    fake.reconnect('peer-1', 'peer-2');
    const result = session.reconnectParticipant('participant-2', 'peer-2-reconnected');
    if (elapsed > RECONNECT_WINDOW_MS) {
      expect(result).toEqual({ accepted: false, alive: false });
      expect(match.connectionStateForActor(guest)).toBe('disconnected');
    } else {
      expect(result).toEqual({ accepted: true, alive });
      expect(match.connectionStateForActor(guest)).toBe('connected');
    }
    scenario.match.dispose();
    scenario.fake.dispose();
  }, MATCH_TEST_TIMEOUT);

  it('does not let host disconnect turn into a transport fallback', () => {
    const transport = new FakeMatchTransport(transportOptions({ latencyMs: 5 }));
    const received: FakeTransportMessage[] = [];
    transport.guest.onMessage((message) => received.push(message));
    transport.disconnect('host');
    expect(transport.guest.connected).toBe(false);
    expect(transport.guest.channel('event').readyState).toBe('connecting');
    expect(transport.guest.send('event', { shouldNotSend: true })).toBe(false);
    expect(transport.host.send('event', { shouldNotSend: true })).toBe(false);
    expect(transport.getMetrics().blockedSends).toBe(2);
    transport.reconnect('host');
    expect(transport.host.send('event', { afterReconnect: true })).toBe(true);
    transport.flushAll();
    expect(received.map((message) => message.data)).toEqual([{ afterReconnect: true }]);
  });

  it('enforces the tactical ping rate limit while keeping pings sender-scoped in FFA', () => {
    const scenario = makeHostScenario();
    const { session, match, fake } = scenario;
    const guest = match.actors.find((actor) => actor.id === 2)!;
    guest.body.teleport(0, guest.body.position.y, 0);
    expect(session.requestTacticalPing('peer-2', guest.body.position.x, guest.body.position.z)?.recipients)
      .toEqual(['peer-2']);
    expect(session.requestTacticalPing('peer-2', guest.body.position.x + 1, guest.body.position.z + 1)?.recipients)
      .toEqual(['peer-2']);
    expect(session.requestTacticalPing('peer-2', guest.body.position.x + 2, guest.body.position.z + 2)).toBeNull();
    for (let tick = 0; tick < 60; tick += 1) session.fixedUpdate(STEP);
    expect(session.requestTacticalPing('peer-2', guest.body.position.x, guest.body.position.z)?.expiresHostTick)
      .toBe(match.hostTick + 360);
    expect(session.requestTacticalPing('peer-2', match.mapDef.size, 0)).toBeNull();
    match.dispose();
    fake.dispose();
  }, MATCH_TEST_TIMEOUT);
});

describe('Phase 4 authoritative combat invariants', () => {
  it('breaks an upper-floor pane once and lets a sniper hit the actor behind it', () => {
    const phys = new PhysicsWorld();
    const shooterBody = new CharBody(phys, 1, 0, CAPSULE_CENTER_OFFSET, 0);
    const targetBody = new CharBody(phys, 2, 0, CAPSULE_CENTER_OFFSET, -7);
    const shooter = new Actor('SHOOTER', shooterBody, 0xffffff);
    const target = new Actor('TARGET', targetBody, 0xffaa44);
    shooter.inv.add({ kind: 'weapon', weaponId: 'sniper', rarity: 'common', ammoInMag: 1 });
    shooter.inv.select(0);
    const glassCollider = phys.addDestructibleBox(1, 0, 1.6, -2, 1.5, 1, 0.04, 'glass');
    phys.flush();
    const breaks: string[] = [];
    const hits: Actor[] = [];
    const movement = { lookDir: () => ({ x: 0, y: 0, z: -1 }) } as unknown as import('../../src/sim/movement').MovementSystem;
    const combat = new CombatSystem(phys, movement, {
      onMuzzleFlash: () => undefined,
      onShotFired: () => undefined,
      onImpact: () => undefined,
      onActorHit: (hit: Actor) => hits.push(hit),
      onTracer: () => undefined,
      onRicochet: () => undefined,
      onGlassBreak: (stableId: string) => breaks.push(stableId),
      onDestructibleDamaged: () => undefined,
      onMeleeSwing: () => undefined,
      onMeleeHit: () => undefined,
    });
    combat.registerDestructibles([{
      id: 1,
      stableId: 'fixture:building:glass:upper:0001',
      hp: 5,
      collider: glassCollider,
      geo: { kind: 'box', x: 0, y: 1.6, z: -2, sx: 3, sy: 2, sz: 0.08, yaw: 0, mat: 'glass', materialHint: 'glass' },
      type: 'glass',
      alive: true,
    }] as never);
    expect(combat.tryFire(shooter, 0, { x: 0, y: 0, z: -1 })).toBe(true);
    combat.update(STEP, [shooter, target]);
    expect(breaks).toEqual(['fixture:building:glass:upper:0001']);
    expect(hits).toEqual([target]);
    expect(target.effectiveHealth()).toBeLessThan(target.maxEffectiveHealth());
    expect(combat.damageDestructible(1, 100)).toBe(false);
    expect(breaks).toHaveLength(1);
    shooterBody.dispose();
    targetBody.dispose();
    phys.dispose();
  });

  it('suppresses friendly-fire damage and does not manufacture a winner', () => {
    const scenario = makeHostScenario('teams', [0, 0, 1, 1]);
    const { match, fake } = scenario;
    const source = match.actors.find((actor) => actor.id === 1)!;
    const ally = match.actors.find((actor) => actor.id === 2)!;
    const enemy = match.actors.find((actor) => actor.id === 3)!;
    ally.body.teleport(0, CAPSULE_CENTER_OFFSET, -1.2);
    source.body.teleport(0, CAPSULE_CENTER_OFFSET, 0);
    source.yaw = 0;
    const allyHealth = ally.effectiveHealth();
    expect(match.combat.tryMelee(source, STEP, [source, ally, enemy])).toBe(true);
    expect(ally.effectiveHealth()).toBe(allyHealth);
    expect(match.damagePolicy.allows(source.id, ally.id)).toBe(false);
    expect(match.damagePolicy.allows(source.id, enemy.id)).toBe(true);
    match.phase = 'live';
    match.fixedUpdate(STEP);
    expect(match.finished).toBe(false);
    expect(match.winnerView).toBeNull();
    match.dispose();
    fake.dispose();
  }, MATCH_TEST_TIMEOUT);
});
