import { describe, expect, it } from 'vitest';
import { LocalMovementPrediction, type PredictionState } from '../../src/net/prediction';

function step(state: PredictionState, input: { moveX?: number; moveZ?: number }, dt: number): void {
  state.position.x += (input.moveX ?? 0) * dt;
  state.position.z += (input.moveZ ?? 0) * dt;
}

describe('local movement prediction', () => {
  it('assigns IDs, keeps bounded input history, and replays unacknowledged walking/sprint input', () => {
    const prediction = new LocalMovementPrediction({
      initialState: { position: { x: 0, y: 0, z: 0 } },
      movementStep: step,
      maxHistory: 4,
    });
    expect(prediction.submitInput({ moveX: 1 })).toBe(1);
    expect(prediction.submitInput({ moveX: 1 })).toBe(2);
    expect(prediction.submitInput({ moveZ: 1 })).toBe(3);
    expect(prediction.submitInput({ moveZ: 1 })).toBe(4);
    expect(prediction.pendingInputCount).toBe(4);
    expect(prediction.predictedState.position.x).toBeCloseTo(2 / 60);
    const result = prediction.reconcile({ position: { x: 1 / 60, y: 0, z: 0 } }, 1);
    expect(result.acknowledgedInputId).toBe(1);
    expect(result.replayedInputs).toBe(3);
    expect(prediction.pendingInputCount).toBe(3);
    expect(prediction.inputHistory.every((frame) => frame.id > 1)).toBe(true);
  });

  it.each([
    ['walking', { moveX: 1 }], ['sprint', { moveZ: 1 }], ['jump', { jumpPressed: true }],
    ['dash', { dashPressed: true }], ['slide', { crouchPressed: true }], ['wall', { moveX: -1 }],
    ['mantle', { jumpPressed: true, moveZ: 1 }], ['grapple', { grapplePressed: true }],
    ['transport', { jumpPressed: true }], ['stairs', { moveZ: 1 }], ['broken-window', { moveX: 1 }],
  ])('replays the named movement fixture: %s', (_name, input) => {
    const prediction = new LocalMovementPrediction({
      initialState: { position: { x: 0, y: 0, z: 0 } },
      movementStep: (current, command, dt) => {
        if (command.moveX || command.moveZ) step(current, command, dt);
      },
    });
    const id = prediction.submitInput(input);
    expect(id).toBe(1);
    expect(prediction.reconcile({ position: { x: 0, y: 0, z: 0 } }, 0).replayedInputs).toBe(1);
  });

  it('classifies error tiers, caps visual correction, and reports percentiles', () => {
    const prediction = new LocalMovementPrediction({
      initialState: { position: { x: 0, y: 0, z: 0 } },
      movementStep: step,
      maxVisualCorrectionDistance: 0.5,
    });
    expect(prediction.reconcile({ position: { x: 0.01, y: 0, z: 0 } }, 0).tier).toBe('negligible');
    const soft = prediction.reconcile({ position: { x: 0.2, y: 0, z: 0 } }, 0);
    expect(soft.tier).toBe('soft');
    expect(prediction.visualState().position.x).toBeCloseTo(0.01);
    prediction.advance(120);
    expect(prediction.visualState().position.x).toBeGreaterThan(0.01);
    expect(prediction.visualState().position.x).toBeLessThan(0.2);
    const hard = prediction.reconcile({ position: { x: 4, y: 0, z: 0 } }, 0);
    expect(hard.tier).toBe('hard');
    expect(hard.visualCorrection).toEqual({ x: 0, y: 0, z: 0 });
    expect(prediction.visualState().position.x).toBe(4);
    const telemetry = prediction.telemetry();
    expect(telemetry.samples).toBe(3);
    expect(telemetry.p95Error).toBeGreaterThan(0);
    expect(telemetry.hard).toBe(1);
  });

  it('merges and replays a complete movement baseline without adding gameplay state', () => {
    type MobilityState = PredictionState & {
      dashTimer: number;
      mantleFrom: { x: number; y: number; z: number };
      grappleActive: boolean;
    };
    const prediction = new LocalMovementPrediction<MobilityState>({
      initialState: {
        position: { x: 0, y: 0, z: 0 },
        dashTimer: 0,
        mantleFrom: { x: 0, y: 0, z: 0 },
        grappleActive: false,
      },
      movementStep: (current, _input, _dt) => current,
    });
    prediction.reconcile({
      position: { x: 2, y: 0, z: 0 },
      dashTimer: 0.4,
      mantleFrom: { x: 1, y: 2, z: 3 },
      grappleActive: true,
    }, 0);
    expect(prediction.predictedState.position.x).toBe(2);
    expect(prediction.predictedState.dashTimer).toBe(0.4);
    expect(prediction.predictedState.mantleFrom).toEqual({ x: 1, y: 2, z: 3 });
    expect(prediction.predictedState.grappleActive).toBe(true);
  });
});
