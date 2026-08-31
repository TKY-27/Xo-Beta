import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../../src/physics/physics';
import { Match } from '../../src/sim/match';
import { buildRoster, localHumanRosterEntry, remoteHumanRosterEntry } from '../../src/sim/roster';
import { emptyCommand } from '../../src/sim/input';
import { loadMap } from '../../src/world';
import {
  HostAuthoritativeMatchSession,
  type AuthoritativeMatchEvent,
  type HostLagCompensationLike,
  type HostMatchTransport,
} from '../../src/net/hostMatchSession';
import { HostLagCompensation } from '../../src/net/lagCompensation';

beforeAll(async () => initPhysics());

function setup(
  now = { value: 0 },
  options: {
    readonly lagCompensation?: HostLagCompensationLike;
    readonly onEvent?: (event: AuthoritativeMatchEvent) => void;
    readonly onPresenceNotice?: (kind: 'left' | 'rejoined', displayName: string) => void;
  } = {},
) {
  const host = localHumanRosterEntry({ peerId: 'host-peer', displayName: 'HOST' });
  const guest = remoteHumanRosterEntry({ slotId: 1, actorId: 2, peerId: 'guest-peer', displayName: 'GUEST' });
  const match = new Match({
    mapDef: loadMap('oldfront').def,
    seed: 44,
    difficulty: 'normal',
    mode: 'ffa',
    roster: buildRoster({ mode: 'ffa', humans: [host, guest], seed: 44 }),
  });
  let sends = 0;
  const sentChannels: string[] = [];
  const snapshotFullFlags: boolean[] = [];
  const transport: HostMatchTransport = {
    send: (_peer, channel) => { sends++; sentChannels.push(channel); return true; },
    disconnect: () => undefined,
  };
  const events: string[] = [];
  const authoritativeEvents: AuthoritativeMatchEvent[] = [];
  const notices: string[] = [];
  const session = new HostAuthoritativeMatchSession(match, [{
    participantId: 'guest-participant', peerId: 'guest-peer', actorId: 2, teamId: null,
  }], transport, (_view, options) => {
    snapshotFullFlags.push(options.full);
    return {
      packets: [new ArrayBuffer(options.full ? 96 : 48)],
      totalBytes: options.full ? 96 : 48,
    };
  }, {
    lagCompensation: options.lagCompensation,
    nowMs: () => now.value,
    onEvent: (event) => {
      events.push(event.type);
      authoritativeEvents.push(event);
      options.onEvent?.(event);
    },
    onPresenceNotice: (kind, displayName) => {
      notices.push(kind);
      options.onPresenceNotice?.(kind, displayName);
    },
    disconnectGraceMs: 100,
  });
  return {
    match,
    session,
    get sends() { return sends; },
    sentChannels,
    snapshotFullFlags,
    events,
    authoritativeEvents,
    notices,
  };
}

function equipGuestPistol(match: Match): void {
  const guest = match.actors.find((actor) => actor.id === 2)!;
  expect(guest.inv.add({
    kind: 'weapon',
    weaponId: 'pistol',
    rarity: 'common',
    ammoInMag: 12,
  }).ok).toBe(true);
  guest.inv.select(0);
  guest.deployed = true;
  match.phase = 'live';
}

describe('HostAuthoritativeMatchSession', () => {
  it('runs one Match tick and one snapshot production schedule for every peer count', () => {
    const one = setup();
    for (let i = 0; i < 60; i++) one.session.fixedUpdate(1 / 60);
    expect(one.match.hostTick).toBe(60);
    expect(one.session.metrics.snapshotsProduced).toBe(20);
    expect(one.session.metrics.snapshotSizes).toEqual({ p50: 48, p95: 96, p99: 96 });
    expect(one.sentChannels.filter((channel) => channel === 'control')).toHaveLength(2);
  });

  it('keeps the host network clock and final snapshots alive after results freeze gameplay', () => {
    const { match, session } = setup();
    match.phase = 'results';
    match.finished = true;
    const startingTick = match.hostTick;
    for (let i = 0; i < 60; i++) session.fixedUpdate(1 / 60);
    expect(match.hostTick).toBe(startingTick + 60);
    expect(session.metrics.snapshotsProduced).toBe(20);
  });

  it('feeds only the owning remote actor and makes a missing packet neutral', () => {
    const { match, session } = setup();
    const result = session.receiveInput('guest-peer', {
      receivedHostTick: 1,
      frames: [{
        sequence: 1, clientTick: 1, lastAcknowledgedHostTick: 0, shotTick: 1,
        command: { ...emptyCommand(), yaw: 0.2, pitch: 0, moveZ: 1 },
      }],
    });
    expect(result.accepted).toBe(true);
    session.fixedUpdate(1 / 60);
    const first = match.actors.find((actor) => actor.id === 2)!;
    const before = { ...first.body.velocity };
    session.fixedUpdate(1 / 60);
    expect(session.peerInputTelemetry('guest-participant')?.neutralTicks).toBeGreaterThan(0);
    expect(first.body.velocity.z).not.toBeLessThan(before.z - 100);
  });

  it('confirms a redundancy-recovered shot with its original prediction sequence', () => {
    let authoritativeMatch: Match | null = null;
    const lagCompensation: HostLagCompensationLike = {
      recordTick: (match) => { authoritativeMatch = match; },
      resolveAcceptedShot: ({ actor }) => {
        authoritativeMatch!.events.emit('shotFired', {
          actorId: actor.id,
          weaponId: 'pistol',
          x: actor.body.position.x,
          y: actor.body.position.y,
          z: actor.body.position.z,
          dry: false,
        });
        return { accepted: true };
      },
    };
    const { match, session, authoritativeEvents } = setup({ value: 0 }, { lagCompensation });
    equipGuestPistol(match);
    expect(session.receiveInput('guest-peer', {
      receivedHostTick: 2,
      frames: [
        {
          sequence: 1, clientTick: 1, lastAcknowledgedHostTick: 0, shotTick: 1,
          command: { ...emptyCommand(), yaw: 0.2, pitch: 0, firePressed: true },
        },
        {
          sequence: 2, clientTick: 2, lastAcknowledgedHostTick: 0, shotTick: 2,
          command: { ...emptyCommand(), yaw: 0.2, pitch: 0 },
        },
      ],
    }).accepted).toBe(true);

    session.fixedUpdate(1 / 60);

    const shot = authoritativeEvents.find((event) => event.type === 'shotFired');
    expect(shot?.payload.predictionInputSequence).toBe(1);
  });

  it('captures the in-progress host tick before resolving a zero-rewind shot', () => {
    const { match, session, authoritativeEvents } = setup(undefined, {
      lagCompensation: new HostLagCompensation(),
    });
    equipGuestPistol(match);
    const guest = match.actors.find((actor) => actor.id === 2)!;

    expect(session.receiveInput('guest-peer', {
      receivedHostTick: 1,
      frames: [{
        sequence: 1,
        clientTick: 1,
        lastAcknowledgedHostTick: 0,
        shotTick: 1,
        command: { ...emptyCommand(), yaw: 0.2, pitch: 0, firePressed: true },
      }],
    }).accepted).toBe(true);

    // Match increments hostTick before processing the command. The shot is
    // therefore accepted at tick 1, while the ordinary history capture runs
    // only after Match.fixedUpdate returns.
    session.fixedUpdate(1 / 60);

    expect(guest.inv.selectedWeapon?.ammoInMag).toBe(11);
    expect(guest.stats.shotsFired).toBe(1);
    expect(authoritativeEvents.some((event) => event.type === 'shotFired')).toBe(true);
  });

  it('keeps semi-auto, fists and transport gating on the canonical Match path', () => {
    let acceptedShots = 0;
    const observedCooldowns: number[] = [];
    const lagCompensation: HostLagCompensationLike = {
      recordTick: () => undefined,
      resolveAcceptedShot: ({ actor }) => {
        acceptedShots++;
        observedCooldowns.push(actor.wpn.fireCooldown);
        return { accepted: true };
      },
    };
    const { match, session } = setup({ value: 0 }, { lagCompensation });
    const guest = match.actors.find((actor) => actor.id === 2)!;

    // An unarmed fire input belongs to melee/healing handling, never the
    // firearm rewind path.
    session.receiveInput('guest-peer', {
      receivedHostTick: 1,
      frames: [{
        sequence: 1, clientTick: 1, lastAcknowledgedHostTick: 0, shotTick: 1,
        command: { ...emptyCommand(), yaw: 0, pitch: 0, firePressed: true },
      }],
    });
    session.fixedUpdate(1 / 60);
    expect(acceptedShots).toBe(0);

    expect(guest.inv.add({
      kind: 'weapon', weaponId: 'pistol', rarity: 'common', ammoInMag: 12,
    }).ok).toBe(true);
    guest.inv.select(0);
    // Still aboard: even a pressed firearm edge cannot bypass transport.
    session.receiveInput('guest-peer', {
      receivedHostTick: 2,
      frames: [{
        sequence: 2, clientTick: 2, lastAcknowledgedHostTick: 0, shotTick: 2,
        command: { ...emptyCommand(), yaw: 0, pitch: 0, firePressed: true },
      }],
    });
    session.fixedUpdate(1 / 60);
    expect(acceptedShots).toBe(0);

    guest.deployed = true;
    match.phase = 'live';
    // Held-only input does not turn a semi-auto pistol into an automatic.
    session.receiveInput('guest-peer', {
      receivedHostTick: 3,
      frames: [{
        sequence: 3, clientTick: 3, lastAcknowledgedHostTick: 0, shotTick: 3,
        command: { ...emptyCommand(), yaw: 0, pitch: 0, fireHeld: true },
      }],
    });
    session.fixedUpdate(1 / 60);
    expect(acceptedShots).toBe(0);

    guest.wpn.fireCooldown = 1 / 120;
    session.receiveInput('guest-peer', {
      receivedHostTick: 4,
      frames: [{
        sequence: 4, clientTick: 4, lastAcknowledgedHostTick: 0, shotTick: 4,
        command: { ...emptyCommand(), yaw: 0, pitch: 0, firePressed: true },
      }],
    });
    session.fixedUpdate(1 / 60);
    expect(acceptedShots).toBe(1);
    expect(observedCooldowns).toEqual([0]);
  });

  it('cancels a guest heal after the bounded input timeout without pausing authority', () => {
    const { match, session } = setup();
    const guest = match.actors.find((actor) => actor.id === 2)!;
    guest.healing = { itemId: 'medkit', remaining: 4, total: 5 };
    session.receiveInput('guest-peer', {
      receivedHostTick: 1,
      frames: [{
        sequence: 1, clientTick: 1, lastAcknowledgedHostTick: 0, shotTick: 1,
        command: { ...emptyCommand(), yaw: 0.2, pitch: 0 },
      }],
    });
    for (let i = 0; i < 7; i++) session.fixedUpdate(1 / 60);
    expect(guest.healing).toBeNull();
    expect(guest.alive).toBe(true);
    expect(match.hostTick).toBe(7);
  });

  it('keeps disconnected actors vulnerable/neutral and reclaims the same actor inside 60 seconds', () => {
    const now = { value: 0 };
    const { match, session, notices } = setup(now);
    expect(session.markDisconnected('guest-peer')).toBe(true);
    now.value = 150;
    session.fixedUpdate(1 / 60);
    expect(match.rosterEntryForActor(2)?.connectionState).toBe('disconnected');
    expect(notices).toEqual(['left']);
    now.value = 59_000;
    expect(session.reconnectParticipant('guest-participant', 'guest-peer-2')).toEqual({ accepted: true, alive: true });
    expect(match.rosterEntryForActor(2)?.connectionState).toBe('connected');
    expect(notices).toEqual(['left', 'rejoined']);
  });

  it('does not emit an unpaired rejoin notice inside the leave grace period', () => {
    const now = { value: 0 };
    const { session, notices, authoritativeEvents } = setup(now);
    expect(session.markDisconnected('guest-peer')).toBe(true);
    now.value = 50;
    expect(session.reconnectParticipant('guest-participant', 'guest-peer-2')).toEqual({ accepted: true, alive: true });
    expect(notices).toEqual([]);
    expect(authoritativeEvents.filter((event) => event.type === 'playerRejoin')).toEqual([]);
  });

  it('does not fan a reconnect keyframe out through the global snapshot flag', () => {
    const { session, snapshotFullFlags } = setup();
    for (let tick = 0; tick < 3; tick++) session.fixedUpdate(1 / 60);
    expect(snapshotFullFlags).toEqual([true]);
    expect(session.markDisconnected('guest-peer')).toBe(true);
    expect(session.reconnectParticipant('guest-participant', 'guest-peer-2')).toEqual({ accepted: true, alive: true });
    for (let tick = 0; tick < 3; tick++) session.fixedUpdate(1 / 60);
    expect(snapshotFullFlags).toEqual([true, false]);
  });

  it('isolates throwing authoritative-event observers without losing the event ID', () => {
    const onEvent = vi.fn<(event: AuthoritativeMatchEvent) => void>(() => {
      throw new Error('event observer failed');
    });
    const { match, session } = setup(undefined, { onEvent });
    const host = match.actors.find((actor) => actor.id === 1)!;
    host.body.teleport(0, host.body.position.y, 0);

    expect(() => session.requestLocalTacticalPing(1, 0, 0)).not.toThrow();
    expect(() => session.requestLocalTacticalPing(1, 1, 1)).not.toThrow();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect((onEvent.mock.calls[0]![0] as AuthoritativeMatchEvent).eventId).toBe(1);
    expect((onEvent.mock.calls[1]![0] as AuthoritativeMatchEvent).eventId).toBe(2);
  });

  it('isolates a throwing leave observer after committing disconnected presence', () => {
    const now = { value: 0 };
    const onPresenceNotice = vi.fn<(
      kind: 'left' | 'rejoined',
      displayName: string,
    ) => void>(() => {
      throw new Error('presence observer failed');
    });
    const { match, session } = setup(now, { onPresenceNotice });
    expect(session.markDisconnected('guest-peer')).toBe(true);
    now.value = 150;

    expect(() => session.fixedUpdate(1 / 60)).not.toThrow();
    expect(match.rosterEntryForActor(2)?.connectionState).toBe('disconnected');
    expect(onPresenceNotice).toHaveBeenCalledOnce();

    now.value = 300;
    expect(() => session.fixedUpdate(1 / 60)).not.toThrow();
    expect(onPresenceNotice).toHaveBeenCalledOnce();
  });

  it('returns committed reconnect success when event and presence observers throw', () => {
    const now = { value: 0 };
    const onEvent = vi.fn<(event: AuthoritativeMatchEvent) => void>(() => {
      throw new Error('event observer failed');
    });
    const onPresenceNotice = vi.fn<(
      kind: 'left' | 'rejoined',
      displayName: string,
    ) => void>(() => {
      throw new Error('presence observer failed');
    });
    const { match, session } = setup(now, { onEvent, onPresenceNotice });
    expect(session.markDisconnected('guest-peer')).toBe(true);
    now.value = 150;
    expect(() => session.fixedUpdate(1 / 60)).not.toThrow();
    expect(onPresenceNotice).toHaveBeenCalledOnce();

    now.value = 59_000;
    let result: { accepted: boolean; alive: boolean } | undefined;
    expect(() => { result = session.reconnectParticipant('guest-participant', 'guest-peer-2'); }).not.toThrow();
    expect(result).toEqual({ accepted: true, alive: true });
    expect(match.rosterEntryForActor(2)?.connectionState).toBe('connected');
    expect(session.receiveInput('guest-peer-2', {
      receivedHostTick: 1,
      frames: [{
        sequence: 1, clientTick: 1, lastAcknowledgedHostTick: 0, shotTick: 1,
        command: { ...emptyCommand(), yaw: 0.2, pitch: 0, moveZ: 1 },
      }],
    }).accepted).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onPresenceNotice).toHaveBeenCalledTimes(2);
  });

  it('retires per-peer upload accounting across repeated reconnect generations', () => {
    const now = { value: 0 };
    const { session } = setup(now);
    for (let tick = 0; tick < 3; tick++) session.fixedUpdate(1 / 60);
    const firstGenerationBytes = session.metrics.totalUploadBytes;
    expect(firstGenerationBytes).toBeGreaterThan(0);

    expect(session.markDisconnected('guest-peer')).toBe(true);
    expect(session.reconnectParticipant('guest-participant', 'guest-peer-2').accepted).toBe(true);
    for (let tick = 0; tick < 3; tick++) session.fixedUpdate(1 / 60);
    expect(session.markDisconnected('guest-peer-2')).toBe(true);
    expect(session.reconnectParticipant('guest-participant', 'guest-peer-3').accepted).toBe(true);
    for (let tick = 0; tick < 3; tick++) session.fixedUpdate(1 / 60);

    expect(Object.keys(session.metrics.bytesSentByPeer)).toEqual(['guest-peer-3']);
    expect(session.metrics.totalUploadBytes).toBeGreaterThan(firstGenerationBytes);
  });

  it('rejects reconnect at the exact expiry boundary and leaves the actor assigned', () => {
    const now = { value: 0 };
    const { match, session } = setup(now);
    session.markDisconnected('guest-peer');
    now.value = 60_000;
    expect(session.canReconnectParticipant('guest-participant', 'late-peer')).toBe(false);
    expect(session.reconnectParticipant('guest-participant', 'late-peer').accepted).toBe(false);
    expect(match.rosterEntryForActor(2)?.actorId).toBe(2);
    expect(match.rosterEntryForActor(2)?.connectionState).toBe('disconnected');
  });

  it('limits tactical pings and keeps FFA pings sender-only', () => {
    const { match, session } = setup();
    const guest = match.actors.find((actor) => actor.id === 2)!;
    guest.body.teleport(0, guest.body.position.y, 0);
    const { x, z } = guest.body.position;
    expect(session.requestTacticalPing('guest-peer', x, z)?.recipients).toEqual(['guest-peer']);
    expect(session.requestTacticalPing('guest-peer', x + 1, z + 1)).not.toBeNull();
    expect(session.requestTacticalPing('guest-peer', x + 2, z + 2)).toBeNull();
    expect(session.requestTacticalPing('guest-peer', x + 300, z)).toBeNull();
    expect(session.requestTacticalPing('guest-peer', 9999, 0)).toBeNull();
  });

  it('keeps a host-local FFA ping local while retaining one event id', () => {
    const { match, session } = setup();
    const host = match.actors.find((actor) => actor.id === 1)!;
    host.body.teleport(0, host.body.position.y, 0);
    const ping = session.requestLocalTacticalPing(1, host.body.position.x, host.body.position.z);
    expect(ping?.recipients).toEqual([]);
    expect(ping?.eventId).toBeGreaterThan(0);
  });

  it('fails closed instead of wrapping authoritative event IDs', () => {
    const { match, session } = setup();
    const host = match.actors.find((actor) => actor.id === 1)!;
    host.body.teleport(0, host.body.position.y, 0);
    (session as unknown as { eventId: number }).eventId = 0xffff_ffff;
    expect(() => session.requestLocalTacticalPing(1, 0, 0)).toThrow(/event ID exhausted/i);
  });
});
