import { describe, expect, it } from 'vitest';
import { ClientReplica, freezeGameStateView } from '../../src/net/clientReplica';
import type { GameStateView, LocalMovementView } from '../../src/sim/gameStateView';
import type { PredictionState } from '../../src/net/prediction';

function view(revision = 1, x = 0, phase: GameStateView['phase'] = 'live'): GameStateView {
  return {
    hostTick: revision,
    stateRevision: revision,
    time: revision / 60,
    phaseTime: revision / 60,
    phase,
    actors: [{
      id: 1, displayName: 'LOCAL', ownership: { kind: 'local-human', peerId: 'local' },
      connectionState: 'connected', teamId: null, skinId: 'vanguard', accentColor: 1,
      alive: true, health: 100, shield: 100, position: { x, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, grounded: true, moveState: 'ground', crouched: false, deployed: true,
      equippedWeapon: null, inventory: null, placement: 0,
      stats: { kills: 0, damageDealt: 0, shotsFired: 0, shotsHit: 0, headshots: 0, survivalTime: 0 },
    }],
    localActorId: 1,
    teams: [], mode: 'ffa', chests: [], loot: [],
    storm: { state: 'idle', phaseIndex: -1, timer: 0, centerX: 0, centerZ: 0, radius: 0 },
    transport: { x: 0, y: 10, z: 0, jumpAllowed: false }, localMovement: null,
    destructibles: [], winner: null, teamResults: [],
  };
}

function localMovement(
  overrides: Partial<LocalMovementView> = {},
): LocalMovementView {
  return {
    actorId: 1,
    groundNormalY: 1,
    hitCeiling: false,
    slidAlongWall: false,
    slideTimer: 0,
    slideDirX: 0,
    slideDirZ: 0,
    slideCooldown: 0,
    wallrunTimer: 0,
    wallSide: 0,
    wallNormalX: 0,
    wallNormalZ: 0,
    mantleTimer: 0,
    mantleCooldown: 0,
    mantleFrom: { x: 0, y: 0, z: 0 },
    mantleTo: { x: 0, y: 0, z: 0 },
    grappleActive: false,
    grapplePoint: { x: 0, y: 0, z: 0 },
    grappleCooldown: 0,
    dashCharges: 2,
    dashRegen: 0,
    dashTimer: 0,
    dashDirX: 0,
    dashDirZ: 0,
    jumpsUsed: 0,
    coyote: 0,
    jumpBuffered: 0,
    bhopWindow: 0,
    wallrunCooldown: 0,
    wallrunLanded: true,
    wallrunChains: 0,
    lastWallNx: 0,
    lastWallNz: 0,
    peakFallSpeed: 0,
    airborneGroundTime: 0,
    poundTimer: 0,
    footstepAccum: 0,
    inWater: false,
    submerged: false,
    waterSurfaceY: null,
    adsAmount: 0,
    healingMovementPenalty: false,
    ...overrides,
  };
}

describe('guest ClientReplica', () => {
  it('aligns host ticks to the browser clock and renders from the interpolation buffer', () => {
    const replica = new ClientReplica({ now: () => 10_100 });
    replica.applySnapshot({
      state: view(1, 0), hostTime: 0, receivedAt: 10_000, roundTripTimeMs: 40,
    });
    replica.applySnapshot({
      state: view(2, 5), hostTime: 50, receivedAt: 10_050, roundTripTimeMs: 40,
    });
    replica.applySnapshot({
      state: view(3, 10), hostTime: 100, receivedAt: 10_100, roundTripTimeMs: 40,
    });

    expect(replica.clockEstimate.offsetMs).toBeCloseTo(-9_980);
    expect(replica.clockEstimate.rttMs).toBeCloseTo(40);
    expect(replica.viewAt(10_100)?.actors[0]?.position.x).toBeGreaterThan(0);
    expect(replica.viewAt(10_100)?.actors[0]?.position.x).toBeLessThan(5);
  });

  it('keeps an immutable full GameStateView and deduplicates monotonic snapshots/events', () => {
    const replica = new ClientReplica({ now: () => 0 });
    expect(replica.applySnapshot({ state: view(1), hostTime: 0 })).toMatchObject({ accepted: true, revision: 1 });
    expect(replica.applySnapshot({ state: view(1), hostTime: 0 }).accepted).toBe(false);
    expect(replica.applyEvent({ eventId: 1, revision: 2, type: 'phaseChanged', payload: { phase: 'results' } }).accepted).toBe(true);
    expect(replica.applyEvent({ eventId: 1, revision: 2, type: 'phaseChanged', payload: { phase: 'results' } }).accepted).toBe(false);
    const current = replica.viewAt(0)!;
    expect(current.phase).toBe('results');
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.actors)).toBe(true);
    expect(Object.isFrozen(current.actors[0]!.position)).toBe(true);
    expect(() => (current.actors as unknown as Array<unknown>).push({})).toThrow();
  });

  it('presents a reliable event overtaken by a snapshot without regressing replica state', () => {
    const replica = new ClientReplica({ now: () => 0 });
    replica.applySnapshot({ state: view(5), hostTime: 50 });
    expect(replica.applyEvent({
      eventId: 9,
      revision: 4,
      type: 'phaseChanged',
      payload: { phase: 'transport' },
    }).accepted).toBe(true);
    expect(replica.viewAt(0)?.phase).toBe('live');
    expect(replica.applyEvent({
      eventId: 9,
      revision: 4,
      type: 'phaseChanged',
      payload: { phase: 'transport' },
    }).accepted).toBe(false);
  });

  it('uses the injected movement fixture for local prediction while preserving authoritative vitals/inventory', () => {
    const replica = new ClientReplica({
      now: () => 0,
      movementStep: (state, input, dt) => {
        state.position.x += input.moveX * dt;
      },
    });
    replica.applySnapshot({ state: view(1, 0), hostTime: 0, ackInputSeq: 0 });
    expect(replica.submitInput({ moveX: 1 })).toBe(1);
    expect(replica.presentationPredictionIds).toEqual([1]);
    const predicted = replica.viewAt(0)!;
    expect(predicted.actors[0]!.position.x).toBeGreaterThan(0);
    expect(predicted.actors[0]!.health).toBe(100);
    expect(predicted.actors[0]!.inventory).toBeNull();
    replica.applySnapshot({ state: view(2, 0), hostTime: 16.67, ackInputSeq: 1 });
    expect(replica.presentationPredictionIds).toEqual([]);
    expect(replica.acknowledgedPresentationPredictionIds).toEqual([1]);
    expect(replica.telemetry().samples).toBe(1);
    replica.resetTelemetry();
    expect(replica.telemetry()).toMatchObject({
      samples: 0, negligible: 0, soft: 0, hard: 0,
      acknowledgedInputs: 0, replayedInputs: 0,
    });
    replica.applyEvent({ eventId: 9, revision: 3, type: 'shotFired', payload: { predictionInputSequence: 1 } });
    expect(replica.presentationPredictionIds).toEqual([]);
    expect(replica.acknowledgedPresentationPredictionIds).toEqual([1]);
  });

  it('uses an explicit full movement-state adapter for rich reconciliation', () => {
    type MobilityState = PredictionState & {
      dashTimer: number;
      mantleFrom: { x: number; y: number; z: number };
      grappleActive: boolean;
    };
    const initialState: MobilityState = {
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      grounded: true,
      state: 'ground',
      dashTimer: 0,
      mantleFrom: { x: 0, y: 0, z: 0 },
      grappleActive: false,
    };
    const replica = new ClientReplica<MobilityState>({
      localActorId: 1,
      movementStep: (state) => state,
      initialPredictionState: initialState,
      authoritativeStateFromActor: (actor, previous) => ({
        ...previous,
        position: { ...actor.position },
        velocity: { ...actor.velocity },
        yaw: actor.yaw,
        pitch: actor.pitch,
        grounded: actor.grounded,
        state: actor.moveState,
        dashTimer: 0.4,
        mantleFrom: { x: 3, y: 4, z: 5 },
        grappleActive: true,
      }),
    });

    replica.applySnapshot({ state: view(1), hostTime: 0 });
    replica.submitInput({ moveX: 1 });
    replica.applySnapshot({ state: view(2), hostTime: 16.67, ackInputSeq: 1 });

    expect(replica.predictionController?.predictedState).toMatchObject({
      dashTimer: 0.4,
      mantleFrom: { x: 3, y: 4, z: 5 },
      grappleActive: true,
    });
  });

  it('restores the owner-only localMovement projection before replay', () => {
    type MobilityState = PredictionState & {
      dashTimer: number;
      mantleFrom: { x: number; y: number; z: number };
      grappleActive: boolean;
    };
    const replica = new ClientReplica<MobilityState>({
      localActorId: 1,
      movementStep: (state) => state,
    });
    replica.applySnapshot({
      state: { ...view(1), localMovement: localMovement() },
      hostTime: 0,
    });
    replica.submitInput({ moveX: 1 });
    replica.applySnapshot({
      state: {
        ...view(2),
        localMovement: localMovement({
          dashTimer: 0.4,
          mantleFrom: { x: 3, y: 4, z: 5 },
          grappleActive: true,
        }),
      },
      hostTime: 16.67,
      ackInputSeq: 1,
    });

    expect(replica.predictionController?.predictedState).toMatchObject({
      dashTimer: 0.4,
      mantleFrom: { x: 3, y: 4, z: 5 },
      grappleActive: true,
    });
    expect(replica.viewAt(0)?.localMovement).toMatchObject({ dashTimer: 0.4, grappleActive: true });
  });

  it('keeps input IDs monotonic when the first snapshot arrives after local ticks', () => {
    const replica = new ClientReplica({
      localActorId: 1,
      movementStep: (state, input, dt) => {
        state.position.x += input.moveX * dt;
      },
    });
    expect(replica.submitInput({ moveX: 1 })).toBe(1);
    expect(replica.submitInput({ moveX: 1 })).toBe(2);
    replica.applySnapshot({ state: view(1, 0), hostTime: 0, ackInputSeq: 2 });
    expect(replica.submitInput({ moveX: 1 })).toBe(3);
  });

  it('applies reliable death and transport transitions immediately', () => {
    const replica = new ClientReplica({ now: () => 0 });
    replica.applySnapshot({ state: view(1, 0, 'transport'), hostTime: 0 });
    replica.applySnapshot({
      state: { ...view(2, 0, 'transport'), transport: { x: 1, y: 10, z: 2, jumpAllowed: true } },
      hostTime: 16.67,
    });
    expect(replica.viewAt(0)!.transport.jumpAllowed).toBe(true);
    replica.applyEvent({ eventId: 1, revision: 2, type: 'transportJumped', payload: { actorId: 1 } });
    expect(replica.viewAt(0)!.actors[0]!.deployed).toBe(true);
    replica.applyEvent({ eventId: 2, revision: 3, type: 'eliminated', payload: { victimId: 1, placement: 2 } });
    const result = replica.viewAt(0)!;
    expect(result.actors[0]!.alive).toBe(false);
    expect(result.actors[0]!.placement).toBe(2);
  });

  it('applies glass and presence events immediately and idempotently', () => {
    const replica = new ClientReplica({ now: () => 0 });
    const base = view(1);
    replica.applySnapshot({
      state: freezeGameStateView({
        ...base,
        actors: [
          ...base.actors,
          {
            ...base.actors[0],
            id: 2,
            displayName: 'REMOTE',
            ownership: { kind: 'remote-human', peerId: 'old-peer' },
          },
        ],
        destructibles: [{ id: 'upper-glass-1', revision: 1, destroyed: false }],
      }),
      hostTime: 0,
    });

    expect(replica.applyEvent({
      eventId: 1,
      revision: 2,
      type: 'glassBreak',
      payload: { destructibleId: 'upper-glass-1', revision: 7, destroyed: true },
    }).accepted).toBe(true);
    expect(replica.viewAt(0)?.destructibles[0]).toMatchObject({ destroyed: true, revision: 7 });

    expect(replica.applyEvent({
      eventId: 2,
      revision: 3,
      type: 'glassBreak',
      payload: { destructibleId: 'upper-glass-1', revision: 2, destroyed: true },
    }).accepted).toBe(true);
    expect(replica.viewAt(0)?.destructibles[0]).toMatchObject({ destroyed: true, revision: 7 });

    replica.applyEvent({ eventId: 3, revision: 4, type: 'playerLeave', payload: { actorId: 2 } });
    expect(replica.viewAt(0)?.actors.find((actor) => actor.id === 2)?.connectionState).toBe('disconnected');
    replica.applyEvent({
      eventId: 4,
      revision: 5,
      type: 'playerRejoin',
      payload: { actorId: 2, newPeerId: 'new-peer' },
    });
    expect(replica.viewAt(0)?.actors.find((actor) => actor.id === 2)).toMatchObject({
      connectionState: 'connected',
      ownership: { kind: 'remote-human', peerId: 'new-peer' },
    });
  });

  it('keeps authoritative winner and result projections immutable', () => {
    const replica = new ClientReplica({ now: () => 0 });
    replica.applySnapshot({ state: view(1), hostTime: 0 });
    replica.applyEvent({
      eventId: 3,
      revision: 2,
      type: 'matchWon',
      payload: { winnerId: 1, winnerName: 'LOCAL', teamId: null },
    });
    const result = replica.viewAt(0)!;
    expect(result.winner).toEqual({ kind: 'actor', actorId: 1, displayName: 'LOCAL' });
    expect(result.phase).toBe('results');
    expect(Object.isFrozen(result.winner)).toBe(true);
    expect(Object.isFrozen(result.teamResults)).toBe(true);
  });

  it('applies reliable storm phase events without predicting the storm', () => {
    const replica = new ClientReplica({ now: () => 0 });
    replica.applySnapshot({ state: view(1), hostTime: 0 });
    replica.applyEvent({
      eventId: 4,
      revision: 2,
      type: 'stormShrinking',
      payload: { index: 2, shrinkTime: 8, targetRadius: 42 },
    });
    expect(replica.viewAt(0)!.storm).toMatchObject({ state: 'shrinking', phaseIndex: 2, timer: 8, radius: 42 });
  });

  it('normalizes older adapter views to the current immutable contract', () => {
    const normalized = freezeGameStateView({ actors: [], phase: 'transport' });
    expect(normalized.hostTick).toBe(0);
    expect(normalized.transport).toEqual({ x: 0, y: 0, z: 0, jumpAllowed: false });
    expect(Object.isFrozen(normalized.storm)).toBe(true);
    expect(Object.isFrozen(normalized.destructibles)).toBe(true);
  });
});
