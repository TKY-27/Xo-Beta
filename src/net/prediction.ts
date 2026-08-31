/**
 * Local presentation prediction and reconciliation.
 *
 * This is intentionally a small state/step seam.  A guest does not construct
 * a Match or a second world; production wiring supplies a closure around the
 * shared movement step.  Tests can use the same seam with a deterministic
 * movement fixture.
 */

import { emptyCommand, type InputCommand } from '../sim/input';

export interface PredictionVector3 {
  x: number;
  y: number;
  z: number;
}

/** Minimum transform state needed by a movement-step adapter. */
export interface PredictionState {
  position: PredictionVector3;
  velocity?: PredictionVector3;
  yaw?: number;
  pitch?: number;
  grounded?: boolean;
  state?: string;
}

/**
 * A step may mutate the supplied draft and return it, or return a replacement
 * state.  Supporting both styles makes it straightforward to wrap
 * MovementSystem.update without imposing a guest-side Actor/Match object.
 */
export type MovementStep<S extends PredictionState = PredictionState> = (
  state: S,
  input: InputCommand,
  dt: number,
) => S | void;

/**
 * A movement-only authoritative baseline.  The required position and the
 * optional transform fields are enough for the replica's default path, while
 * `Partial<S>` lets a shared movement adapter provide its complete mobility
 * state (dash/mantle/grapple timers, cooldowns, captured vectors, and so on)
 * during reconciliation.  `S` must remain a movement state; gameplay fields
 * such as health, inventory, loot, or winner data do not belong here.
 */
export type AuthoritativePredictionState<S extends PredictionState = PredictionState> =
  Readonly<Pick<S, 'position'> & Partial<Omit<S, 'position'>>>;

export interface PredictionThresholds {
  /** Error at or below this value is left alone to avoid visual jitter. */
  readonly negligible?: number;
  /** Error above this value is classified as hard divergence. */
  readonly hard?: number;
}

export interface LocalPredictionOptions<S extends PredictionState = PredictionState> {
  /** A complete S is preferred; the minimal transform state is supported for
   * deterministic fixtures and adapters that only predict transforms. */
  readonly initialState: S | PredictionState;
  readonly movementStep: MovementStep<S>;
  /** First input ID; used to continue a transport-level sequence after boot. */
  readonly initialInputId?: number;
  readonly maxHistory?: number;
  readonly thresholds?: PredictionThresholds;
  /** Maximum correction offset rendered in one reconciliation. */
  readonly maxVisualCorrectionDistance?: number;
  /** Exponential correction half-life in milliseconds. */
  readonly correctionHalfLifeMs?: number;
}

export interface PredictionInputFrame<S extends PredictionState = PredictionState> {
  readonly id: number;
  /** Stable ID for presentation effects associated with this local input. */
  readonly presentationPredictionId: number;
  readonly input: Readonly<InputCommand>;
  readonly dt: number;
  readonly stateAfter: S;
}

export type PredictionErrorTier = 'negligible' | 'soft' | 'hard';

export interface PredictionReconciliation {
  readonly inputId: number;
  readonly acknowledgedInputId: number;
  readonly error: number;
  readonly tier: PredictionErrorTier;
  readonly replayedInputs: number;
  readonly visualCorrection: Readonly<PredictionVector3>;
}

export interface PredictionTelemetry {
  readonly samples: number;
  readonly negligible: number;
  readonly soft: number;
  readonly hard: number;
  readonly acknowledgedInputs: number;
  readonly replayedInputs: number;
  readonly p50Error: number;
  readonly p95Error: number;
  readonly p99Error: number;
  readonly maxError: number;
}

const DEFAULT_THRESHOLDS = Object.freeze({ negligible: 0.05, hard: 1.5 });
const DEFAULT_MAX_HISTORY = 128;
const DEFAULT_MAX_VISUAL_CORRECTION = 0.75;
const DEFAULT_CORRECTION_HALF_LIFE_MS = 120;
const MAX_TELEMETRY_SAMPLES = 4096;

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function cloneVector(value: Readonly<PredictionVector3> | undefined): PredictionVector3 | undefined {
  return value ? { x: value.x, y: value.y, z: value.z } : undefined;
}

function clonePredictionValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  const objectValue = value as object;
  const existing = seen.get(objectValue);
  if (existing !== undefined) return existing as T;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(objectValue, result);
    for (const item of value) result.push(clonePredictionValue(item, seen));
    return result as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result: Record<string, unknown> = {};
  seen.set(objectValue, result);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = clonePredictionValue(item, seen);
  }
  return result as T;
}

function cloneState<S extends PredictionState>(state: S | PredictionState): S {
  const copy = clonePredictionValue(state) as S;
  copy.position = cloneVector(state.position)!;
  if (state.velocity !== undefined) copy.velocity = cloneVector(state.velocity);
  return copy;
}

function cloneInput(input: Partial<InputCommand>): InputCommand {
  const result = emptyCommand();
  for (const key of Object.keys(result) as Array<keyof InputCommand>) {
    const value = input[key];
    if (value !== undefined) result[key] = value as never;
  }
  return result;
}

function distance(a: Readonly<PredictionVector3>, b: Readonly<PredictionVector3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function difference(
  a: Readonly<PredictionVector3>,
  b: Readonly<PredictionVector3>,
): PredictionVector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function capVector(value: PredictionVector3, maxDistance: number): PredictionVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (length <= maxDistance || length <= 1e-8) return value;
  const scale = maxDistance / length;
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const index = (values.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower]!;
  const weight = index - lower;
  return values[lower]! + (values[upper]! - values[lower]!) * weight;
}

/**
 * A bounded input history with transform-only reconciliation.
 *
 * Health, shield, inventory, loot, damage, winner and result fields are not
 * represented by this class.  They remain solely authoritative in the
 * ClientReplica's snapshot view.
 */
export class LocalMovementPrediction<S extends PredictionState = PredictionState> {
  readonly movementStep: MovementStep<S>;
  readonly maxHistory: number;
  readonly negligibleThreshold: number;
  readonly hardThreshold: number;
  readonly maxVisualCorrectionDistance: number;
  readonly correctionHalfLifeMs: number;

  private predicted: S;
  private correction: PredictionVector3 = { x: 0, y: 0, z: 0 };
  private readonly frames: PredictionInputFrame<S>[] = [];
  private nextId = 1;
  private acknowledgedId = 0;
  private readonly errors: number[] = [];
  private negligibleCount = 0;
  private softCount = 0;
  private hardCount = 0;
  private acknowledgedCount = 0;
  private replayedCount = 0;

  constructor(options: LocalPredictionOptions<S>) {
    if (typeof options.movementStep !== 'function' || !options.initialState?.position) {
      throw new Error('Local movement prediction requires an initial state and movement step');
    }
    this.movementStep = options.movementStep;
    this.predicted = cloneState<S>(options.initialState);
    this.nextId = Math.max(1, Math.floor(finiteOr(options.initialInputId, 1)));
    this.maxHistory = Math.max(1, Math.floor(finiteOr(options.maxHistory, DEFAULT_MAX_HISTORY)));
    const thresholds = options.thresholds ?? {};
    this.negligibleThreshold = Math.max(0, finiteOr(
      thresholds.negligible,
      DEFAULT_THRESHOLDS.negligible,
    ));
    this.hardThreshold = Math.max(
      this.negligibleThreshold,
      finiteOr(thresholds.hard, DEFAULT_THRESHOLDS.hard),
    );
    this.maxVisualCorrectionDistance = Math.max(0, finiteOr(
      options.maxVisualCorrectionDistance,
      DEFAULT_MAX_VISUAL_CORRECTION,
    ));
    this.correctionHalfLifeMs = Math.max(1, finiteOr(
      options.correctionHalfLifeMs,
      DEFAULT_CORRECTION_HALF_LIFE_MS,
    ));
  }

  get predictedState(): S {
    return cloneState(this.predicted);
  }

  get acknowledgedInputId(): number {
    return this.acknowledgedId;
  }

  get latestInputId(): number {
    return this.nextId - 1;
  }

  get pendingInputCount(): number {
    return this.frames.length;
  }

  get inputHistory(): readonly PredictionInputFrame<S>[] {
    return Object.freeze(this.frames.map((frame) => Object.freeze({
      ...frame,
      input: Object.freeze({ ...frame.input }),
      stateAfter: cloneState(frame.stateAfter),
    })));
  }

  get visualCorrection(): Readonly<PredictionVector3> {
    return Object.freeze({ ...this.correction });
  }

  /** Apply one local command and return its monotonic presentation ID. */
  submitInput(input: Partial<InputCommand>, dt = 1 / 60): number {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.25) throw new Error('Invalid prediction step duration');
    const id = this.nextId++;
    const command = cloneInput(input);
    const next = cloneState(this.predicted);
    const stepped = this.movementStep(next, command, dt);
    this.predicted = cloneState(stepped ?? next);
    const frame: PredictionInputFrame<S> = {
      id,
      presentationPredictionId: id,
      input: Object.freeze(command),
      dt,
      stateAfter: cloneState(this.predicted),
    };
    this.frames.push(frame);
    while (this.frames.length > this.maxHistory) this.frames.shift();
    return id;
  }

  /** Advance the visual correction toward zero without touching simulation state. */
  advance(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return;
    const factor = Math.exp(-dtMs / this.correctionHalfLifeMs);
    this.correction.x *= factor;
    this.correction.y *= factor;
    this.correction.z *= factor;
    if (Math.hypot(this.correction.x, this.correction.y, this.correction.z) < 1e-4) {
      this.correction = { x: 0, y: 0, z: 0 };
    }
  }

  /**
   * Reconcile the authoritative movement baseline and replay unacknowledged
   * commands through the injected shared step. The caller may provide only
   * transform fields or a complete movement state; neither path includes
   * combat/gameplay authority.
   */
  reconcile(
    authoritative: PredictionState | AuthoritativePredictionState<S> | Readonly<S>,
    acknowledgedInputId = this.latestInputId,
  ): PredictionReconciliation {
    if (!authoritative?.position
      || ![authoritative.position.x, authoritative.position.y, authoritative.position.z].every(Number.isFinite)) {
      throw new Error('Invalid authoritative prediction state');
    }
    const requestedAck = Number.isSafeInteger(acknowledgedInputId)
      ? Math.max(0, acknowledgedInputId)
      : this.acknowledgedId;
    const ack = Math.max(this.acknowledgedId, Math.min(requestedAck, this.latestInputId));
    const beforeVisualPosition = {
      x: this.predicted.position.x + this.correction.x,
      y: this.predicted.position.y + this.correction.y,
      z: this.predicted.position.z + this.correction.z,
    };
    const beforeError = distance(this.predicted.position, authoritative.position);
    const tier: PredictionErrorTier = beforeError <= this.negligibleThreshold
      ? 'negligible'
      : beforeError >= this.hardThreshold ? 'hard' : 'soft';
    this.errors.push(beforeError);
    if (this.errors.length > MAX_TELEMETRY_SAMPLES) this.errors.shift();
    if (tier === 'negligible') this.negligibleCount += 1;
    else if (tier === 'soft') this.softCount += 1;
    else this.hardCount += 1;

    if (ack > this.acknowledgedId) {
      const previousAck = this.acknowledgedId;
      const newlyAcknowledged = this.frames.filter((frame) => frame.id > previousAck && frame.id <= ack).length;
      this.acknowledgedId = ack;
      this.acknowledgedCount += newlyAcknowledged;
      while (this.frames.length > 0 && this.frames[0]!.id <= ack) this.frames.shift();
    }

    const baseline = this.mergeAuthoritative(authoritative);
    let replayed = 0;
    let next = baseline;
    for (const frame of this.frames) {
      const draft = cloneState(next);
      const stepped = this.movementStep(draft, cloneInput(frame.input), frame.dt);
      next = cloneState(stepped ?? draft);
      replayed += 1;
    }
    this.predicted = next;
    this.replayedCount += replayed;

    if (tier === 'soft') {
      // Preserve the pre-reconciliation visual position, then decay the
      // bounded offset. This prevents a small authoritative correction from
      // snapping the local camera while the simulation baseline is restored.
      this.correction = capVector(
        difference(beforeVisualPosition, this.predicted.position),
        this.maxVisualCorrectionDistance,
      );
    } else {
      // Keep the already smooth local result.  A sub-threshold correction is
      // intentionally ignored to prevent a correction/jitter loop. A hard
      // divergence snaps to the replayed authoritative baseline.
      this.correction = { x: 0, y: 0, z: 0 };
    }

    return Object.freeze({
      inputId: this.latestInputId,
      acknowledgedInputId: this.acknowledgedId,
      error: beforeError,
      tier,
      replayedInputs: replayed,
      visualCorrection: Object.freeze({ ...this.correction }),
    });
  }

  /** State consumed by rendering; never changes health/combat/inventory data. */
  visualState(): S {
    const state = cloneState(this.predicted);
    state.position.x += this.correction.x;
    state.position.y += this.correction.y;
    state.position.z += this.correction.z;
    return state;
  }

  telemetry(): PredictionTelemetry {
    const sorted = [...this.errors].sort((a, b) => a - b);
    return Object.freeze({
      samples: sorted.length,
      negligible: this.negligibleCount,
      soft: this.softCount,
      hard: this.hardCount,
      acknowledgedInputs: this.acknowledgedCount,
      replayedInputs: this.replayedCount,
      p50Error: percentile(sorted, 0.5),
      p95Error: percentile(sorted, 0.95),
      p99Error: percentile(sorted, 0.99),
      maxError: sorted[sorted.length - 1] ?? 0,
    });
  }

  resetTelemetry(): void {
    this.errors.length = 0;
    this.negligibleCount = 0;
    this.softCount = 0;
    this.hardCount = 0;
    this.acknowledgedCount = 0;
    this.replayedCount = 0;
  }

  private mergeAuthoritative(
    authoritative: PredictionState | AuthoritativePredictionState<S> | Readonly<S>,
  ): S {
    const next = cloneState(this.predicted);
    next.position = cloneVector(authoritative.position)!;
    const fields = authoritative as unknown as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (key === 'position') continue;
      const value = fields[key];
      if (value !== undefined) {
        (next as unknown as Record<string, unknown>)[key] = clonePredictionValue(value);
      }
    }
    return next;
  }
}
