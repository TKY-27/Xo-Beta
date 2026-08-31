/**
 * Client-side presentation of host snapshots.
 *
 * Snapshots are deliberately treated as observations, not as a second
 * simulation authority.  The buffer renders a point in the past, using the
 * host clock estimate, and only performs a small amount of extrapolation when
 * the newest packet is briefly late.  The generic state shape keeps this
 * module independent from the wire protocol that carries a snapshot.
 */

export interface InterpolationVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Transport position plus host-owned discrete deployment permission. */
export interface InterpolationTransport extends InterpolationVector3 {
  readonly jumpAllowed?: boolean;
}

export interface InterpolationActor {
  readonly id: number;
  readonly alive?: boolean;
  readonly position: InterpolationVector3;
  readonly velocity?: InterpolationVector3;
  readonly yaw?: number;
  readonly pitch?: number;
}

export interface InterpolationState {
  readonly actors: readonly InterpolationActor[];
  readonly phase?: string;
}

export interface RemoteSnapshot<T extends InterpolationState = InterpolationState> {
  /** Host-authoritative monotonic snapshot revision/sequence. */
  readonly revision: number;
  /** Host clock timestamp in milliseconds. */
  readonly hostTime?: number;
  readonly hostTick?: number;
  readonly state: T;
  /** Local receipt time. Defaults to the caller's current time. */
  readonly receivedAt?: number;
}

export interface HostClockSample {
  /** Local time immediately before the ping was sent. */
  readonly clientSentAt: number;
  /** Local time when the pong/sample was received. */
  readonly clientReceivedAt: number;
  /** Host time included in the pong, using the same millisecond unit. */
  readonly hostTime: number;
}

export interface HostClockEstimate {
  readonly offsetMs: number;
  readonly rttMs: number;
  readonly jitterMs: number;
  readonly sampleCount: number;
  readonly bufferMs: number;
}

export interface HostClockEstimatorOptions {
  readonly minBufferMs?: number;
  readonly maxBufferMs?: number;
  readonly baseBufferMs?: number;
  readonly smoothing?: number;
}

const finiteOr = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Estimates host time from a four-timestamp style ping sample.
 *
 * Offset is host minus the local midpoint.  RTT and its variation influence
 * the presentation buffer, but never alter simulation state.
 */
export class HostClockEstimator {
  readonly minBufferMs: number;
  readonly maxBufferMs: number;
  readonly baseBufferMs: number;
  readonly smoothing: number;

  private offsetValue = 0;
  private rttValue = 0;
  private jitterValue = 0;
  private previousRtt: number | null = null;
  private samples = 0;

  constructor(options: HostClockEstimatorOptions = {}) {
    this.minBufferMs = clamp(finiteOr(options.minBufferMs ?? 80, 80), 20, 500);
    this.maxBufferMs = Math.max(
      this.minBufferMs,
      clamp(finiteOr(options.maxBufferMs ?? 120, 120), this.minBufferMs, 500),
    );
    this.baseBufferMs = clamp(
      finiteOr(options.baseBufferMs ?? 100, 100),
      this.minBufferMs,
      this.maxBufferMs,
    );
    this.smoothing = clamp(finiteOr(options.smoothing ?? 0.15, 0.15), 0.01, 1);
  }

  get offsetMs(): number {
    return this.offsetValue;
  }

  get rttMs(): number {
    return this.rttValue;
  }

  get jitterMs(): number {
    return this.jitterValue;
  }

  get sampleCount(): number {
    return this.samples;
  }

  /** Adaptive delay kept within the intentional 80–120 ms presentation band. */
  get bufferMs(): number {
    if (this.samples === 0) return this.baseBufferMs;
    // Half an RTT approximates the age of a snapshot when it reaches the
    // guest.  Variation is weighted more heavily so a bursty route gets a
    // little more room without allowing an unbounded delay.
    const routeAge = this.rttValue * 0.5;
    const adaptive = this.baseBufferMs + (routeAge - 25) * 0.2 + this.jitterValue * 1.5;
    return clamp(adaptive, this.minBufferMs, this.maxBufferMs);
  }

  observe(sample: HostClockSample): HostClockEstimate {
    const sent = sample.clientSentAt;
    const received = sample.clientReceivedAt;
    const host = sample.hostTime;
    if (![sent, received, host].every(Number.isFinite) || received < sent) {
      throw new Error('Invalid host clock sample');
    }
    const rtt = received - sent;
    const midpoint = sent + rtt / 2;
    const offset = host - midpoint;
    if (this.samples === 0) {
      this.offsetValue = offset;
      this.rttValue = rtt;
      this.jitterValue = 0;
    } else {
      const alpha = this.smoothing;
      this.offsetValue += (offset - this.offsetValue) * alpha;
      this.rttValue += (rtt - this.rttValue) * alpha;
      const delta = Math.abs(rtt - (this.previousRtt ?? this.rttValue));
      this.jitterValue += (delta - this.jitterValue) * alpha;
    }
    this.previousRtt = rtt;
    this.samples += 1;
    return this.estimate();
  }

  /** Convert a local monotonic timestamp to the estimated host clock. */
  hostTimeAt(clientTimeMs: number): number {
    return finiteOr(clientTimeMs, 0) + this.offsetValue;
  }

  /** Convert a host timestamp to the estimated local clock. */
  clientTimeAt(hostTimeMs: number): number {
    return finiteOr(hostTimeMs, 0) - this.offsetValue;
  }

  estimate(): HostClockEstimate {
    return Object.freeze({
      offsetMs: this.offsetValue,
      rttMs: this.rttValue,
      jitterMs: this.jitterValue,
      sampleCount: this.samples,
      bufferMs: this.bufferMs,
    });
  }
}

export interface RemoteInterpolationOptions extends HostClockEstimatorOptions {
  readonly maxSnapshots?: number;
  readonly maxExtrapolationMs?: number;
  readonly maxExtrapolationDistance?: number;
  /** Optional read-only world sweep used to stop short-gap extrapolation at scenery. */
  readonly constrainExtrapolatedPosition?: (
    from: Readonly<InterpolationVector3>,
    candidate: Readonly<InterpolationVector3>,
  ) => InterpolationVector3;
}

export const DEFAULT_REMOTE_INTERPOLATION_OPTIONS: Readonly<Required<
  Omit<RemoteInterpolationOptions, 'constrainExtrapolatedPosition'>
>> = Object.freeze({
  minBufferMs: 80,
  maxBufferMs: 120,
  baseBufferMs: 100,
  smoothing: 0.15,
  maxSnapshots: 48,
  maxExtrapolationMs: 90,
  maxExtrapolationDistance: 1.5,
});

interface StoredSnapshot<T extends InterpolationState> {
  readonly revision: number;
  readonly hostTime: number;
  readonly state: T;
  readonly receivedAt: number;
}

function copyPosition(position: InterpolationVector3): InterpolationVector3 {
  return { x: position.x, y: position.y, z: position.z };
}

function copyActor(actor: InterpolationActor): InterpolationActor {
  return {
    ...actor,
    position: copyPosition(actor.position),
    ...(actor.velocity ? { velocity: copyPosition(actor.velocity) } : {}),
  };
}

function copyState<T extends InterpolationState>(state: T): T {
  return {
    ...state,
    actors: state.actors.map(copyActor),
  } as T;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function interpolateAngle(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return b ?? a;
  let delta = (b - a + Math.PI) % (Math.PI * 2);
  if (delta < 0) delta += Math.PI * 2;
  delta -= Math.PI;
  return a + delta * t;
}

function distance(a: InterpolationVector3, b: InterpolationVector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function cappedExtrapolatedPosition(
  previous: InterpolationVector3,
  latest: InterpolationVector3,
  elapsedMs: number,
  sampleIntervalMs: number,
  maxDistance: number,
): InterpolationVector3 {
  const sampleDelta = Math.max(1, sampleIntervalMs);
  const factor = Math.max(0, elapsedMs) / sampleDelta;
  const candidate = {
    x: latest.x + (latest.x - previous.x) * factor,
    y: latest.y + (latest.y - previous.y) * factor,
    z: latest.z + (latest.z - previous.z) * factor,
  };
  const moved = distance(candidate, latest);
  if (moved <= maxDistance || moved <= 1e-8) return candidate;
  const scale = maxDistance / moved;
  return {
    x: latest.x + (candidate.x - latest.x) * scale,
    y: latest.y + (candidate.y - latest.y) * scale,
    z: latest.z + (candidate.z - latest.z) * scale,
  };
}

function interpolateActor(
  older: InterpolationActor,
  newer: InterpolationActor,
  t: number,
): InterpolationActor {
  // Death/revival is gameplay-discrete.  It must not be visually delayed by
  // the position buffer, otherwise a dead actor can be rendered as a living
  // target for another 100 ms.
  if (older.alive !== newer.alive) return copyActor(newer);
  const discrete = t >= 0.5 ? newer : older;
  return {
    ...discrete,
    position: {
      x: lerp(older.position.x, newer.position.x, t),
      y: lerp(older.position.y, newer.position.y, t),
      z: lerp(older.position.z, newer.position.z, t),
    },
    ...(older.velocity && newer.velocity ? {
      velocity: {
        x: lerp(older.velocity.x, newer.velocity.x, t),
        y: lerp(older.velocity.y, newer.velocity.y, t),
        z: lerp(older.velocity.z, newer.velocity.z, t),
      },
    } : newer.velocity ? { velocity: copyPosition(newer.velocity) }
      : older.velocity ? { velocity: copyPosition(older.velocity) } : {}),
    yaw: interpolateAngle(older.yaw, newer.yaw, t),
    pitch: lerp(older.pitch ?? 0, newer.pitch ?? 0, t),
  };
}

function interpolateState<T extends InterpolationState>(older: T, newer: T, t: number): T {
  // Transport/drop/live/results are mode transitions, not continuous motion.
  // Return the newer complete state at the transition boundary so all of the
  // associated immutable arrays change together.
  if (older.phase !== newer.phase) return copyState(newer);
  const byId = new Map(newer.actors.map((actor) => [actor.id, actor]));
  const actors = older.actors.map((actor) => {
    const next = byId.get(actor.id);
    return next ? interpolateActor(actor, next, t) : copyActor(actor);
  });
  for (const actor of newer.actors) {
    if (!older.actors.some((candidate) => candidate.id === actor.id)) actors.push(copyActor(actor));
  }
  const oldFields = older as T & {
    readonly chests?: unknown;
    readonly loot?: unknown;
    readonly teams?: unknown;
    readonly storm?: unknown;
    readonly transport?: InterpolationTransport;
    readonly time?: number;
    readonly phaseTime?: number;
    readonly winner?: unknown;
    readonly teamResults?: unknown;
  };
  const newFields = newer as T & {
    readonly chests?: unknown;
    readonly loot?: unknown;
    readonly teams?: unknown;
    readonly storm?: unknown;
    readonly transport?: InterpolationTransport;
    readonly time?: number;
    readonly phaseTime?: number;
    readonly winner?: unknown;
    readonly teamResults?: unknown;
  };
  return {
    ...older,
    ...newer,
    actors,
    ...(oldFields.transport && newFields.transport ? {
      transport: {
        x: lerp(oldFields.transport.x, newFields.transport.x, t),
        y: lerp(oldFields.transport.y, newFields.transport.y, t),
        z: lerp(oldFields.transport.z, newFields.transport.z, t),
        // Deployment permission is authoritative/discrete; only position is
        // interpolated and the newest defined gate wins immediately.
        jumpAllowed: newFields.transport.jumpAllowed ?? oldFields.transport.jumpAllowed,
      },
    } : {}),
    ...(oldFields.time !== undefined && newFields.time !== undefined
      ? { time: lerp(oldFields.time, newFields.time, t) } : {}),
    ...(oldFields.phaseTime !== undefined && newFields.phaseTime !== undefined
      ? { phaseTime: lerp(oldFields.phaseTime, newFields.phaseTime, t) } : {}),
    // Arrays and other discrete view values follow the same presentation
    // sample as the actor metadata.  They are never predicted.
    ...(oldFields.chests !== undefined || newFields.chests !== undefined
      ? { chests: t >= 0.5 ? newFields.chests : oldFields.chests } : {}),
    ...(oldFields.loot !== undefined || newFields.loot !== undefined
      ? { loot: t >= 0.5 ? newFields.loot : oldFields.loot } : {}),
    ...(oldFields.teams !== undefined || newFields.teams !== undefined
      ? { teams: t >= 0.5 ? newFields.teams : oldFields.teams } : {}),
    ...(oldFields.storm !== undefined || newFields.storm !== undefined
      ? { storm: t >= 0.5 ? newFields.storm : oldFields.storm } : {}),
    ...(oldFields.winner !== undefined || newFields.winner !== undefined
      ? { winner: newFields.winner ?? (t >= 0.5 ? newFields.winner : oldFields.winner) } : {}),
    ...(oldFields.teamResults !== undefined || newFields.teamResults !== undefined
      ? { teamResults: t >= 0.5 ? newFields.teamResults : oldFields.teamResults } : {}),
  } as T;
}

function extrapolateState<T extends InterpolationState>(
  previous: T,
  latest: T,
  elapsedMs: number,
  sampleIntervalMs: number,
  maxDistance: number,
  constrainPosition?: RemoteInterpolationOptions['constrainExtrapolatedPosition'],
): T {
  if (previous.phase !== latest.phase) return copyState(latest);
  const previousById = new Map(previous.actors.map((actor) => [actor.id, actor]));
  const actors = latest.actors.map((actor) => {
    const old = previousById.get(actor.id);
    if (!old || old.alive !== actor.alive) return copyActor(actor);
    const candidate = cappedExtrapolatedPosition(
      old.position,
      actor.position,
      elapsedMs,
      sampleIntervalMs,
      maxDistance,
    );
    const constrained = constrainPosition?.(actor.position, candidate) ?? candidate;
    const position = [constrained.x, constrained.y, constrained.z].every(Number.isFinite)
      ? constrained
      : actor.position;
    const result = {
      ...actor,
      position,
      yaw: interpolateAngle(old.yaw, actor.yaw, Math.min(1, elapsedMs / 16.67)),
      pitch: actor.pitch,
    };
    return result;
  });
  return { ...copyState(latest), actors } as T;
}

/**
 * Ordered, lossy snapshot buffer used by a guest renderer.
 *
 * A lower revision is discarded even if it arrives later.  Host timestamps
 * are sorted separately from arrival order so a short reorder does not cause
 * a backwards visual step.  The latest packet is only extrapolated for a
 * bounded interval and distance.
 */
export class RemoteInterpolationBuffer<T extends InterpolationState = InterpolationState> {
  readonly clock: HostClockEstimator;
  readonly maxSnapshots: number;
  readonly maxExtrapolationMs: number;
  readonly maxExtrapolationDistance: number;
  private readonly constrainExtrapolatedPosition?: RemoteInterpolationOptions['constrainExtrapolatedPosition'];

  private readonly snapshots: StoredSnapshot<T>[] = [];
  private latestRevision = -1;
  private dropped = 0;

  constructor(
    options: RemoteInterpolationOptions = {},
    clock = new HostClockEstimator(options),
  ) {
    this.clock = clock;
    this.maxSnapshots = Math.max(2, Math.floor(finiteOr(
      options.maxSnapshots ?? DEFAULT_REMOTE_INTERPOLATION_OPTIONS.maxSnapshots,
      DEFAULT_REMOTE_INTERPOLATION_OPTIONS.maxSnapshots,
    )));
    this.maxExtrapolationMs = Math.max(0, finiteOr(
      options.maxExtrapolationMs ?? DEFAULT_REMOTE_INTERPOLATION_OPTIONS.maxExtrapolationMs,
      DEFAULT_REMOTE_INTERPOLATION_OPTIONS.maxExtrapolationMs,
    ));
    this.maxExtrapolationDistance = Math.max(0, finiteOr(
      options.maxExtrapolationDistance ?? DEFAULT_REMOTE_INTERPOLATION_OPTIONS.maxExtrapolationDistance,
      DEFAULT_REMOTE_INTERPOLATION_OPTIONS.maxExtrapolationDistance,
    ));
    this.constrainExtrapolatedPosition = options.constrainExtrapolatedPosition;
  }

  get bufferMs(): number {
    return this.clock.bufferMs;
  }

  get size(): number {
    return this.snapshots.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  get latestAcceptedRevision(): number {
    return this.latestRevision;
  }

  observeClock(sample: HostClockSample): HostClockEstimate {
    return this.clock.observe(sample);
  }

  push(snapshot: RemoteSnapshot<T>, receivedAt = snapshot.receivedAt ?? Date.now()): boolean {
    const hostTime = snapshot.hostTime
      ?? (snapshot.hostTick !== undefined ? snapshot.hostTick * (1000 / 60) : undefined);
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
      || !Number.isFinite(hostTime) || !snapshot.state
      || !Number.isFinite(receivedAt)) {
      this.dropped += 1;
      return false;
    }
    if (snapshot.revision <= this.latestRevision) {
      this.dropped += 1;
      return false;
    }
    this.latestRevision = snapshot.revision;
    const stored: StoredSnapshot<T> = {
      revision: snapshot.revision,
      hostTime: hostTime!,
      state: snapshot.state,
      receivedAt,
    };
    // Unordered snapshot delivery can reorder host timestamps.  Keep the
    // buffer in host-time order and evict its oldest presentation sample.
    let index = this.snapshots.findIndex((candidate) => candidate.hostTime > stored.hostTime);
    if (index < 0) index = this.snapshots.length;
    this.snapshots.splice(index, 0, stored);
    while (this.snapshots.length > this.maxSnapshots) this.snapshots.shift();
    return true;
  }

  clear(): void {
    this.snapshots.length = 0;
    this.latestRevision = -1;
    this.dropped = 0;
  }

  /** Return the interpolated presentation state at local time in ms. */
  sample(clientNowMs = Date.now()): T | null {
    if (this.snapshots.length === 0) return null;
    const hostNow = this.clock.hostTimeAt(clientNowMs);
    const target = hostNow - this.clock.bufferMs;
    const first = this.snapshots[0]!;
    const last = this.snapshots[this.snapshots.length - 1]!;
    if (target <= first.hostTime) return copyState(first.state);

    for (let index = 1; index < this.snapshots.length; index++) {
      const newer = this.snapshots[index]!;
      const older = this.snapshots[index - 1]!;
      if (target > newer.hostTime) continue;
      const span = Math.max(1, newer.hostTime - older.hostTime);
      const t = clamp((target - older.hostTime) / span, 0, 1);
      return interpolateState(older.state, newer.state, t);
    }

    const elapsed = Math.min(this.maxExtrapolationMs, Math.max(0, target - last.hostTime));
    if (elapsed <= 0 || this.snapshots.length < 2) return copyState(last.state);
    return extrapolateState(
      this.snapshots[this.snapshots.length - 2]!.state,
      last.state,
      elapsed,
      Math.max(1, last.hostTime - this.snapshots[this.snapshots.length - 2]!.hostTime),
      this.maxExtrapolationDistance,
      this.constrainExtrapolatedPosition,
    );
  }

}
