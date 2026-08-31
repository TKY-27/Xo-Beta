import { describe, expect, it } from 'vitest';
import { emptyCommand } from '../../src/sim/input';
import type { ActorView, GameStateView } from '../../src/sim/gameStateView';
import {
  MatchStateCodecError,
  MatchStateDecoder,
  MatchStateEncoder,
  ReliableEventDeduplicator,
  decodeAuthoritativeEventPacket,
  decodeReliablePacket,
  decodeRemoteInputEnvelope,
  encodeAuthoritativeEventPacket,
  encodeGameStateRecords,
  encodeInputCommandPacket,
  encodeReliablePacket,
  inputCommandToProtocolFrame,
  projectGameStateForViewer,
  protocolFrameToInputCommand,
} from '../../src/net/matchStateCodec';
import { decodeInputPacket } from '../../src/net/matchProtocol';
import type { AuthoritativeMatchEvent } from '../../src/net/hostMatchSession';

const SESSION = 0x1234_5678;

function snapshotOptions(full: boolean, sequence: number, acknowledgedInputSequence = 0) {
  return {
    full,
    sequence,
    viewerParticipantId: 'guest-participant',
    viewerPeerId: 'guest-peer-2',
    viewerActorId: 2,
    acknowledgedInputSequence,
    acknowledgedInputByActor: new Map([[2, acknowledgedInputSequence]]),
  } as const;
}

function actor(id: number): ActorView {
  return Object.freeze({
    id,
    displayName: `PLAYER ${id}`,
    ownership: Object.freeze(id === 1
      ? { kind: 'local-human' as const, peerId: 'host-peer' }
      : { kind: 'remote-human' as const, peerId: `guest-peer-${id}` }),
    connectionState: 'connected' as const,
    teamId: id <= 5 ? 0 : 1,
    skinId: 'vanguard' as const,
    accentColor: 0x112233 + id,
    alive: true,
    health: 100,
    shield: 50,
    position: Object.freeze({ x: id, y: 3, z: -id }),
    velocity: Object.freeze({ x: 0.25, y: 0, z: 1 }),
    yaw: 0.2,
    pitch: -0.1,
    grounded: true,
    moveState: 'ground' as const,
    crouched: false,
    deployed: true,
    equippedWeapon: 'ar' as const,
    inventory: Object.freeze({
      selected: 0,
      slots: Object.freeze([
        Object.freeze({ kind: 'weapon' as const, weaponId: 'ar' as const, rarity: 'rare' as const, ammoInMag: 27 }),
        Object.freeze({ kind: 'heal' as const, itemId: 'medkit' as const, count: 2 }),
        null, null, null,
      ]),
      ammo: Object.freeze({ light: 60, medium: 120, shells: 12, heavy: 5 }),
      healing: null,
    }),
    placement: 0,
    stats: Object.freeze({ kills: id - 1, damageDealt: id * 12.5, shotsFired: 30, shotsHit: 10, headshots: 2, survivalTime: 45 }),
  });
}

function state(revision = 1): GameStateView {
  const actors = Array.from({ length: 10 }, (_, index) => actor(index + 1));
  const loot: GameStateView['loot'][number][] = Array.from({ length: 103 }, (_, index) => {
    const base = { id: index + 1, x: index, y: 0.5, z: -index, yaw: index * 0.01, rarity: index % 5 === 0 ? 'rare' as const : 'common' as const };
    if (index % 3 === 0) return Object.freeze({ ...base, kind: 'weapon' as const, weaponId: 'ar' as const, ammoInMag: 22 });
    if (index % 3 === 1) return Object.freeze({ ...base, kind: 'ammo' as const, ammoType: 'medium' as const, amount: 30 });
    return Object.freeze({ ...base, kind: 'heal' as const, itemId: 'medkit' as const, count: 1 });
  });
  return Object.freeze({
    hostTick: 60 + revision,
    stateRevision: revision,
    time: 1 + revision / 60,
    phaseTime: 0.5,
    phase: 'live' as const,
    actors: Object.freeze(actors),
    localActorId: 2,
    teams: Object.freeze([0, 1].map((teamId) => Object.freeze({
      teamId,
      members: Object.freeze(actors.filter((value) => value.teamId === teamId).map((value, index) => Object.freeze({
        actorId: value.id,
        slotId: teamId * 5 + index,
        displayName: value.displayName,
        accentColor: value.accentColor,
        alive: value.alive,
        connectionState: value.connectionState,
      }))),
      aliveCount: 5,
    }))),
    mode: 'teams-bot-fill' as const,
    chests: Object.freeze(Array.from({ length: 38 }, (_, index) => Object.freeze({
      id: index + 1,
      kind: index % 3 === 0 ? 'elite' as const : 'standard' as const,
      x: index * 1.5, y: 1, z: -index,
      opened: index % 7 === 0,
    }))),
    loot: Object.freeze(loot),
    storm: Object.freeze({ state: 'shrinking' as const, phaseIndex: 2, timer: 12, centerX: 3, centerZ: -4, radius: 80 }),
    transport: Object.freeze({ x: 10, y: 80, z: -20, jumpAllowed: true }),
    localMovement: Object.freeze({
      actorId: 2,
      groundNormalY: 0.985,
      hitCeiling: true,
      slidAlongWall: false,
      slideTimer: 0.375,
      slideDirX: 0.6,
      slideDirZ: -0.8,
      slideCooldown: 0.45,
      wallrunTimer: 0.75,
      wallSide: -1,
      wallNormalX: -0.9,
      wallNormalZ: 0.1,
      mantleTimer: 0.2,
      mantleCooldown: 0.4,
      mantleFrom: Object.freeze({ x: 11.25, y: 4.5, z: -7.75 }),
      mantleTo: Object.freeze({ x: 12, y: 6.25, z: -8 }),
      grappleActive: true,
      grapplePoint: Object.freeze({ x: 22.5, y: 18, z: -31.25 }),
      grappleCooldown: 2.25,
      dashCharges: 1,
      dashRegen: 1.75,
      dashTimer: 0.125,
      dashDirX: 0.707,
      dashDirZ: -0.707,
      jumpsUsed: 1,
      coyote: 0.08,
      jumpBuffered: 0.05,
      bhopWindow: 0.09,
      wallrunCooldown: 0.3,
      wallrunLanded: false,
      wallrunChains: 2,
      lastWallNx: -0.7,
      lastWallNz: 0.7,
      peakFallSpeed: 24.5,
      airborneGroundTime: 0.5,
      poundTimer: 0.1,
      footstepAccum: 2.75,
      inWater: true,
      submerged: false,
      waterSurfaceY: 3.25,
      adsAmount: 0.625,
      healingMovementPenalty: true,
    }),
    destructibles: Object.freeze(Array.from({ length: 491 }, (_, index) => Object.freeze({
      id: `neocity:glass:${index.toString(36).padStart(4, '0')}`,
      revision: 0,
      destroyed: false,
    }))),
    winner: null,
    teamResults: Object.freeze([]),
  });
}

describe('Phase 4 binary match state adapter', () => {
  it('maps every held and edge InputCommand bit and limited redundancy', () => {
    const command = {
      ...emptyCommand(), moveX: 0.4, moveZ: -0.3, yaw: Math.PI * 3, pitch: 0.2,
      jumpHeld: true, sprint: true, crouchHeld: true, fireHeld: true, adsHeld: true,
      jumpPressed: true, crouchPressed: true, firePressed: true, reloadPressed: true,
      interactPressed: true, meleePressed: true, dropWeaponPressed: true, dashPressed: true,
      grapplePressed: true, grappleRelease: true, poundPressed: true, shieldPressed: true,
      medkitPressed: true, slotRequest: 3,
    };
    const frame = inputCommandToProtocolFrame(command, {
      sessionId: SESSION, inputSeq: 3, clientTick: 30, lastAckHostTick: 28,
      recentFrames: [{ inputSeq: 2, clientTick: 29, command: emptyCommand() }],
    });
    const packet = encodeInputCommandPacket(command, {
      sessionId: SESSION, inputSeq: 3, clientTick: 30, lastAckHostTick: 28,
      recentFrames: [{ inputSeq: 2, clientTick: 29, command: emptyCommand() }],
    });
    const decoded = decodeInputPacket(packet);
    expect(decoded.sessionId).toBe(SESSION);
    expect(decoded.recentFrames).toHaveLength(1);
    expect(frame.yaw).toBeCloseTo(Math.PI, 8);
    expect(protocolFrameToInputCommand(decoded)).toMatchObject({
      jumpHeld: true, sprint: true, crouchHeld: true, fireHeld: true, adsHeld: true,
      reloadPressed: true, interactPressed: true, grapplePressed: true, medkitPressed: true,
      slotRequest: 3,
    });
    const envelope = decodeRemoteInputEnvelope(packet, 31);
    expect(envelope.frames.map((value) => value.sequence)).toEqual([3, 2]);
    expect(envelope.frames.map((value) => value.shotTick)).toEqual([29, 31]);
  });

  it('round-trips the complete NeoCity-sized state below the 64-record protocol bound', () => {
    const view = state();
    const destructibleOrder = view.destructibles.map((value) => value.id);
    const projected = projectGameStateForViewer(view, 2);
    expect(projected.actors[0]?.inventory).toBeNull();
    expect(projected.actors[1]?.inventory).not.toBeNull();
    expect(projected.localMovement?.actorId).toBe(2);
    expect(projectGameStateForViewer(view, 1).localMovement).toBeNull();
    expect(projectGameStateForViewer(view, null).localMovement).toBeNull();
    const records = encodeGameStateRecords(view, 2, destructibleOrder);
    expect(records).toHaveLength(64);
    expect(records.every((record) => record.payload.byteLength <= 248)).toBe(true);
    expect(records.find((record) => record.id === 1)?.payload.byteLength).toBe(142);

    const encoder = new MatchStateEncoder(SESSION, 2, destructibleOrder);
    const encoded = encoder.encode(view, snapshotOptions(true, 1, 41));
    expect(encoded.packets.length).toBeGreaterThanOrEqual(1);
    expect(encoded.totalBytes).toBe(4458);
    expect(encoded.totalBytes).toBeLessThan(8 * 1024);
    const decoder = new MatchStateDecoder(SESSION, destructibleOrder);
    let decoded = null;
    for (const packet of [...encoded.packets].reverse()) decoded = decoder.add(packet) ?? decoded;
    expect(decoded?.state.actors).toHaveLength(10);
    expect(decoded?.state.chests).toHaveLength(38);
    expect(decoded?.state.loot).toHaveLength(103);
    expect(decoded?.state.destructibles).toHaveLength(491);
    expect(decoded?.state.localActorId).toBe(2);
    expect(decoded?.state.transport.jumpAllowed).toBe(true);
    expect(decoded?.state.actors.find((value) => value.id === 1)?.inventory).toBeNull();
    expect(decoded?.state.actors.find((value) => value.id === 2)?.inventory?.ammo.medium).toBe(120);
    expect(decoded?.state.localMovement).toMatchObject({
      actorId: 2,
      hitCeiling: true,
      grappleActive: true,
      wallSide: -1,
      dashCharges: 1,
      jumpsUsed: 1,
      wallrunChains: 2,
      inWater: true,
      waterSurfaceY: 3.25,
      healingMovementPenalty: true,
    });
    expect(decoded?.state.localMovement?.slideTimer).toBeCloseTo(0.375, 3);
    expect(decoded?.state.localMovement?.slideDirX).toBeCloseTo(0.6, 3);
    expect(decoded?.acknowledgedInputSequence).toBe(41);

    const invalidMovement = Object.freeze({
      ...view,
      localMovement: Object.freeze({ ...view.localMovement!, slideTimer: Number.POSITIVE_INFINITY }),
    });
    expect(() => encodeGameStateRecords(invalidMovement, 2, destructibleOrder)).toThrow(/slideTimer/i);
  });

  it('makes each delta self-contained against its reliable keyframe', () => {
    const destructibleOrder = state(1).destructibles.map((value) => value.id);
    const encoder = new MatchStateEncoder(SESSION, 2, destructibleOrder);
    const decoder = new MatchStateDecoder(SESSION, destructibleOrder);
    const full = encoder.encode(state(1), snapshotOptions(true, 1));
    for (const packet of full.packets) decoder.add(packet);

    const second = state(2);
    const actors2 = second.actors.map((value) => value.id === 2
      ? Object.freeze({ ...value, position: Object.freeze({ ...value.position, x: 99 }) }) : value);
    const changed2 = Object.freeze({ ...second, actors: Object.freeze(actors2) });
    const dropped = encoder.encode(changed2, snapshotOptions(false, 2));
    expect(dropped.totalBytes).toBeLessThan(full.totalBytes);

    const third = state(3);
    const changed3 = Object.freeze({
      ...third,
      actors: Object.freeze(third.actors.map((value) => value.id === 2
        ? Object.freeze({ ...value, position: Object.freeze({ ...value.position, x: 99 }) }) : value)),
      destructibles: Object.freeze(third.destructibles.map((value, index) => index === 23
        ? Object.freeze({ ...value, revision: 1, destroyed: true }) : value)),
    });
    const thirdPackets = encoder.encode(changed3, snapshotOptions(false, 3, 9));
    let decoded = null;
    for (const packet of thirdPackets.packets) decoded = decoder.add(packet) ?? decoded;
    expect(decoded?.state.actors.find((value) => value.id === 2)?.position.x).toBeCloseTo(99, 5);
    expect(decoded?.state.destructibles[23]?.destroyed).toBe(true);
    expect(decoded?.acknowledgedInputSequence).toBe(9);
  });

  it('keeps an older full keyframe when a newer delta arrives first', () => {
    const destructibleOrder = state(1).destructibles.map((value) => value.id);
    const encoder = new MatchStateEncoder(SESSION, 2, destructibleOrder);
    const full = encoder.encode(state(1), snapshotOptions(true, 1));
    const delta = encoder.encode(state(2), snapshotOptions(false, 2));
    const decoder = new MatchStateDecoder(SESSION, destructibleOrder);

    expect(() => {
      for (const packet of delta.packets) decoder.add(packet);
    }).toThrow(/keyframe/i);

    let decoded = null;
    for (const packet of full.packets) decoded = decoder.add(packet) ?? decoded;
    expect(decoded).toMatchObject({ revision: 1, full: true, state: { stateRevision: 1 } });
    expect(decoder.hasKeyframe).toBe(true);
  });

  it('requires a keyframe and rejects exact-length/session corruption', () => {
    const destructibleOrder = state(1).destructibles.map((value) => value.id);
    const encoder = new MatchStateEncoder(SESSION, 2, destructibleOrder);
    encoder.encode(state(1), snapshotOptions(true, 1));
    const delta = encoder.encode(state(2), snapshotOptions(false, 2));
    expect(() => new MatchStateDecoder(SESSION, destructibleOrder).add(delta.packets[0]!)).toThrowError(MatchStateCodecError);

    const reliable = new Uint8Array(encodeReliablePacket({
      kind: 'keyframe-request', sessionId: SESSION, sequence: 1, tick: 2, payload: {},
    }));
    expect(() => decodeReliablePacket(reliable.slice(0, -1), SESSION)).toThrow(/length/i);
    expect(() => decodeReliablePacket(reliable, 12)).toThrow(/session/i);
  });

  it('uses deterministic reliable binary events and rejects replayed IDs', () => {
    const first = encodeReliablePacket({
      kind: 'reconnect-result', sessionId: SESSION, sequence: 4, tick: 8,
      payload: { z: 1, a: [true, 'same'] },
    });
    const second = encodeReliablePacket({
      kind: 'reconnect-result', sessionId: SESSION, sequence: 4, tick: 8,
      payload: { a: [true, 'same'], z: 1 },
    });
    expect([...new Uint8Array(first)]).toEqual([...new Uint8Array(second)]);
    expect(new TextDecoder().decode(first)).not.toContain('{"');

    const event: AuthoritativeMatchEvent = Object.freeze({
      eventId: 7, revision: 22, hostTick: 40, type: 'glassBreak',
      payload: Object.freeze({ destructibleId: 'neocity:glass:0001', x: 1, y: 2, z: 3 }),
    });
    expect(decodeAuthoritativeEventPacket(encodeAuthoritativeEventPacket(event, SESSION), SESSION)).toEqual(event);
    const dedup = new ReliableEventDeduplicator();
    expect(dedup.accept(event)).toBe(true);
    expect(dedup.accept(event)).toBe(false);
    expect(dedup.accept({ eventId: 8, revision: 21 })).toBe(false);
    expect(dedup.accept({ eventId: 8, revision: 23 })).toBe(true);

    const unknown = Object.freeze({ ...event, eventId: 9, type: 'not-an-event' as AuthoritativeMatchEvent['type'] });
    expect(() => decodeAuthoritativeEventPacket(
      encodeAuthoritativeEventPacket(unknown, SESSION),
      SESSION,
    )).toThrow(/unknown authoritative event/i);
  });
});
