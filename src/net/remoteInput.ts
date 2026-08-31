import type { Actor } from '../sim/actor';
import { emptyCommand, type InputCommand } from '../sim/input';
import type { ActorController } from '../sim/match';

export const DEFAULT_INPUT_TIMEOUT_TICKS = 6;
export const DEFAULT_INPUT_VIOLATION_LIMIT = 8;
export const DEFAULT_INPUT_RATE_PER_SECOND = 90;

export interface RemoteInputFrame {
  readonly sequence: number;
  readonly clientTick: number;
  readonly lastAcknowledgedHostTick: number;
  /** Host-domain shot tick reconstructed by the protocol adapter. */
  readonly shotTick: number;
  /** Host-derived provenance for a fire intent recovered from redundancy. */
  readonly fireInputSequence?: number;
  readonly command: Readonly<InputCommand>;
}

export interface RemoteInputEnvelope {
  /** Host receipt time. This is never used as a client-clock reference. */
  readonly receivedHostTick: number;
  readonly frames: readonly RemoteInputFrame[];
}

export type RemoteInputRejectReason =
  | 'actor-mismatch'
  | 'bot-control'
  | 'empty'
  | 'duplicate'
  | 'stale'
  | 'future'
  | 'rate-limit'
  | 'malformed';

export interface RemoteInputResult {
  readonly accepted: boolean;
  readonly reason?: RemoteInputRejectReason;
  readonly violations: number;
  readonly disconnected: boolean;
}

export interface RemoteInputTelemetry {
  readonly acceptedPackets: number;
  readonly rejectedPackets: number;
  readonly neutralTicks: number;
  readonly timeoutNeutralizations: number;
  readonly duplicateEdgesDropped: number;
  readonly violations: number;
}

interface RateState {
  tokens: number;
  lastHostTick: number;
}

/**
 * Host-side controller for exactly one admitted peer and one human Actor.
 * Every fixed tick consumes fresh packet data once. With no packet, it emits a
 * neutral command rather than extending stale movement/fire/ADS/healing state.
 */
export class RemoteInputController implements ActorController {
  readonly kind = 'human' as const;
  private latestFrame: RemoteInputFrame | null = null;
  private pendingShotFrame: RemoteInputFrame | null = null;
  private lastPacketHostTick = -1;
  /** Highest admitted client-domain tick. Client ticks are not host ticks. */
  private lastAcceptedClientTick = -1;
  private lastAcceptedSequence = -1;
  private lastConsumedSequence = -1;
  private readonly seenEdgeSequences = new Set<number>();
  private readonly rate: RateState = { tokens: DEFAULT_INPUT_RATE_PER_SECOND, lastHostTick: 0 };
  private disconnected = false;
  private acceptedPackets = 0;
  private rejectedPackets = 0;
  private neutralTicks = 0;
  private timeoutNeutralizations = 0;
  private timeoutActive = false;
  private duplicateEdgesDropped = 0;
  private violations = 0;
  private currentHostTick = 0;
  private consumedFreshInputThisTick = false;

  constructor(
    readonly peerId: string,
    readonly actorId: number,
    private readonly options: {
      readonly tickRate?: number;
      readonly timeoutTicks?: number;
      readonly violationLimit?: number;
      readonly ratePerSecond?: number;
      readonly maxFutureTicks?: number;
      readonly maxPastTicks?: number;
      readonly maxSequenceBacktrack?: number;
      readonly onDisconnect?: (peerId: string, reason: RemoteInputRejectReason) => void;
      /** Cancels any implicit action on the first fixed tick without fresh input. */
      readonly onInputMissing?: (actor: Actor) => void;
      readonly onInputTimeout?: (actor: Actor) => void;
      /** Return true when lag compensation fired authoritatively and consumed the fire intent. */
      readonly onAcceptedShot?: (actor: Actor, frame: RemoteInputFrame) => boolean;
    } = {},
  ) {
    if (!peerId || !Number.isSafeInteger(actorId) || actorId <= 0) throw new Error('Invalid remote input binding');
  }

  accept(envelope: RemoteInputEnvelope): RemoteInputResult {
    if (this.disconnected) return this.result(false, 'rate-limit');
    if (!Number.isSafeInteger(envelope.receivedHostTick) || envelope.receivedHostTick < 0
      || !Array.isArray(envelope.frames) || envelope.frames.length < 1 || envelope.frames.length > 4) {
      return this.reject('malformed');
    }
    if (!this.consumeRate(envelope.receivedHostTick)) return this.reject('rate-limit');

    const ordered = [...envelope.frames].sort((a, b) => a.sequence - b.sequence);
    // The newest sequence carries the sender's current client-clock sample.
    // Use that sample only to validate redundant client frames and to keep
    // the client clock monotonic. The host receipt tick remains a separate
    // clock domain and is used below only for receipt/rate/shot handling.
    const packetClientTick = ordered[ordered.length - 1]!.clientTick;
    const maxFuture = this.options.maxFutureTicks ?? 15;
    const maxPast = this.options.maxPastTicks ?? 120;
    if (this.lastAcceptedClientTick >= 0
      && packetClientTick > this.lastAcceptedClientTick + maxFuture) {
      return this.reject('future');
    }
    if (this.lastAcceptedClientTick >= 0 && packetClientTick < this.lastAcceptedClientTick) {
      return this.reject('stale');
    }
    const fresh: RemoteInputFrame[] = [];
    let previousClientTick: number | null = null;
    for (const frame of ordered) {
      if (!validFrame(frame)) return this.reject('malformed');
      if (previousClientTick !== null && frame.clientTick < previousClientTick) {
        return this.reject('stale');
      }
      previousClientTick = frame.clientTick;
      if (frame.clientTick > packetClientTick + maxFuture
        || packetClientTick > frame.clientTick && packetClientTick - frame.clientTick > maxPast) {
        return this.reject(frame.clientTick > packetClientTick ? 'future' : 'stale');
      }
      // shotTick is already host-mapped by the protocol adapter. Keep its
      // future/stale checks in the host domain, independently of clientTick.
      if (frame.shotTick > envelope.receivedHostTick + maxFuture) return this.reject('future');
      if (envelope.receivedHostTick > frame.shotTick
        && envelope.receivedHostTick - frame.shotTick > maxPast) return this.reject('stale');
      const backtrack = this.options.maxSequenceBacktrack ?? 64;
      if (this.lastAcceptedSequence >= 0 && frame.sequence + backtrack < this.lastAcceptedSequence) {
        return this.reject('stale');
      }
      if (frame.sequence <= this.lastAcceptedSequence) {
        if (hasEdges(frame.command)) this.duplicateEdgesDropped++;
        continue;
      }
      fresh.push(frame);
    }
    if (fresh.length === 0) {
      const duplicate = ordered.some((frame) => frame.sequence === this.lastAcceptedSequence);
      return this.reject(duplicate ? 'duplicate' : 'stale', false);
    }
    // A slower host callback can receive more than one 60 Hz packet before it
    // consumes a command. Carry unconsumed edge actions into the newest held
    // state so a click is not overwritten by the following neutral packet.
    // The single merged frame is a hard bound; no input queue can grow here.
    const pending = this.latestFrame && this.latestFrame.sequence > this.lastConsumedSequence
      ? this.latestFrame : null;
    const newest = mergeFreshFrames(pending ? [pending, ...fresh] : fresh);

    this.latestFrame = newest;
    this.lastPacketHostTick = envelope.receivedHostTick;
    this.lastAcceptedClientTick = packetClientTick;
    this.lastAcceptedSequence = newest.sequence;
    this.timeoutActive = false;
    this.acceptedPackets++;
    this.trimSeenEdges(newest.sequence);
    return this.result(true);
  }

  updateCommand(actor: Actor, _dt: number): InputCommand {
    this.pendingShotFrame = null;
    this.consumedFreshInputThisTick = false;
    if (this.disconnected || actor.id !== this.actorId || actor.personality !== null) {
      if (actor.id !== this.actorId) this.recordViolation('actor-mismatch');
      else if (actor.personality !== null) this.recordViolation('bot-control');
      return neutralFor(actor);
    }
    const frame = this.latestFrame;
    this.latestFrame = null;
    if (!frame || frame.sequence <= this.lastConsumedSequence) {
      this.neutralTicks++;
      this.options.onInputMissing?.(actor);
      const timeout = this.options.timeoutTicks ?? DEFAULT_INPUT_TIMEOUT_TICKS;
      const timedOut = this.lastPacketHostTick < 0
        || this.currentHostTick - this.lastPacketHostTick >= timeout;
      if (timedOut && !this.timeoutActive) {
        this.timeoutActive = true;
        this.timeoutNeutralizations++;
        this.options.onInputTimeout?.(actor);
      }
      return neutralFor(actor);
    }
    this.lastConsumedSequence = frame.sequence;
    this.consumedFreshInputThisTick = true;
    const command = cloneCommand(frame.command);
    if (hasEdges(command)) {
      if (this.seenEdgeSequences.has(frame.sequence)) clearEdges(command);
      else this.seenEdgeSequences.add(frame.sequence);
    }
    if (command.fireHeld || command.firePressed) {
      this.pendingShotFrame = cloneFrame({
        ...frame,
        command: Object.freeze(cloneCommand(command)),
      });
    }
    return command;
  }

  /** Resolve a validated remote firearm intent at Match's canonical fire point. */
  tryAuthoritativeShot(actor: Actor, command: Readonly<InputCommand>, _dt: number): boolean {
    const frame = this.pendingShotFrame;
    this.pendingShotFrame = null;
    if (!frame || actor.id !== this.actorId || actor.personality !== null
      || !command.fireHeld && !command.firePressed) return false;
    return this.options.onAcceptedShot?.(actor, frame) === true;
  }

  neutralize(): void {
    this.latestFrame = null;
    this.pendingShotFrame = null;
    this.consumedFreshInputThisTick = false;
    if (!this.timeoutActive) this.timeoutNeutralizations++;
    this.timeoutActive = true;
  }

  setHostTick(hostTick: number): void {
    if (!Number.isSafeInteger(hostTick) || hostTick < 0) throw new Error('Invalid remote input host tick');
    this.currentHostTick = hostTick;
  }

  get isDisconnected(): boolean {
    return this.disconnected;
  }

  get allowsAutomaticActions(): boolean {
    return !this.disconnected && this.consumedFreshInputThisTick;
  }

  get telemetry(): RemoteInputTelemetry {
    return Object.freeze({
      acceptedPackets: this.acceptedPackets,
      rejectedPackets: this.rejectedPackets,
      neutralTicks: this.neutralTicks,
      timeoutNeutralizations: this.timeoutNeutralizations,
      duplicateEdgesDropped: this.duplicateEdgesDropped,
      violations: this.violations,
    });
  }

  private consumeRate(hostTick: number): boolean {
    const tickRate = this.options.tickRate ?? 60;
    const capacity = this.options.ratePerSecond ?? DEFAULT_INPUT_RATE_PER_SECOND;
    const elapsed = Math.max(0, hostTick - this.rate.lastHostTick);
    this.rate.tokens = Math.min(capacity, this.rate.tokens + elapsed * capacity / tickRate);
    this.rate.lastHostTick = hostTick;
    if (this.rate.tokens < 1) return false;
    this.rate.tokens -= 1;
    return true;
  }

  private reject(reason: RemoteInputRejectReason, violation = true): RemoteInputResult {
    this.rejectedPackets++;
    if (violation) this.recordViolation(reason);
    return this.result(false, reason);
  }

  private recordViolation(reason: RemoteInputRejectReason): void {
    if (this.disconnected) return;
    this.violations++;
    if (this.violations >= (this.options.violationLimit ?? DEFAULT_INPUT_VIOLATION_LIMIT)) {
      this.disconnected = true;
      this.latestFrame = null;
      this.options.onDisconnect?.(this.peerId, reason);
    }
  }

  private result(accepted: boolean, reason?: RemoteInputRejectReason): RemoteInputResult {
    return Object.freeze({ accepted, ...(reason ? { reason } : {}), violations: this.violations, disconnected: this.disconnected });
  }

  private trimSeenEdges(sequence: number): void {
    for (const seen of this.seenEdgeSequences) if (seen + 128 < sequence) this.seenEdgeSequences.delete(seen);
  }
}

function validFrame(frame: RemoteInputFrame): boolean {
  return Number.isSafeInteger(frame.sequence) && frame.sequence >= 0 && frame.sequence <= 0xffffffff
    && Number.isSafeInteger(frame.clientTick) && frame.clientTick >= 0 && frame.clientTick <= 0xffffffff
    && Number.isSafeInteger(frame.lastAcknowledgedHostTick) && frame.lastAcknowledgedHostTick >= 0
    && frame.lastAcknowledgedHostTick <= 0xffffffff
    && Number.isSafeInteger(frame.shotTick) && frame.shotTick >= 0 && frame.shotTick <= 0xffffffff
    // This field is produced only after validation/merge on the host. It must
    // never be accepted as a client-controlled claim.
    && frame.fireInputSequence === undefined
    && validCommand(frame.command);
}

function validCommand(command: Readonly<InputCommand>): boolean {
  return Number.isFinite(command.moveX) && command.moveX >= -1 && command.moveX <= 1
    && Number.isFinite(command.moveZ) && command.moveZ >= -1 && command.moveZ <= 1
    && Math.hypot(command.moveX, command.moveZ) <= 1.001
    && Number.isFinite(command.yaw) && Math.abs(command.yaw) <= Math.PI * 4096
    && Number.isFinite(command.pitch) && command.pitch >= -Math.PI / 2 && command.pitch <= Math.PI / 2
    && (command.slotRequest === null
      || Number.isInteger(command.slotRequest) && command.slotRequest >= -1 && command.slotRequest <= 4)
    && booleanFields.every((field) => typeof command[field] === 'boolean');
}

const booleanFields = [
  'jumpPressed', 'jumpHeld', 'sprint', 'crouchHeld', 'crouchPressed', 'fireHeld',
  'firePressed', 'adsHeld', 'reloadPressed', 'interactPressed', 'meleePressed',
  'dropWeaponPressed', 'dashPressed', 'grapplePressed', 'grappleRelease',
  'poundPressed', 'shieldPressed', 'medkitPressed',
] as const satisfies readonly (keyof InputCommand)[];

const edgeFields = [
  'jumpPressed', 'crouchPressed', 'firePressed', 'reloadPressed', 'interactPressed',
  'meleePressed', 'dropWeaponPressed', 'dashPressed', 'grapplePressed',
  'grappleRelease', 'poundPressed', 'shieldPressed', 'medkitPressed',
] as const satisfies readonly (keyof InputCommand)[];

function hasEdges(command: Readonly<InputCommand>): boolean {
  return edgeFields.some((field) => command[field] === true) || command.slotRequest !== null;
}

function clearEdges(command: InputCommand): void {
  for (const field of edgeFields) command[field] = false;
  command.slotRequest = null;
}

function cloneCommand(command: Readonly<InputCommand>): InputCommand {
  return { ...command };
}

function cloneFrame(frame: RemoteInputFrame): RemoteInputFrame {
  return Object.freeze({ ...frame, command: Object.freeze(cloneCommand(frame.command)) });
}

/**
 * Use the newest held state while recovering edge actions carried by the
 * bounded redundant history in the same packet. An edge that already crossed
 * the accepted sequence frontier is never considered again.
 */
function mergeFreshFrames(frames: readonly RemoteInputFrame[]): RemoteInputFrame {
  const newest = frames[frames.length - 1]!;
  const command = cloneCommand(newest.command);
  let selectedSlot = command.slotRequest;
  let shotTick = newest.shotTick;
  let fireInputSequence: number | undefined;
  for (const frame of frames) {
    for (const field of edgeFields) {
      if (frame.command[field] === true) command[field] = true;
    }
    if (frame.command.slotRequest !== null) selectedSlot = frame.command.slotRequest;
    if ((frame.command.firePressed || frame.command.fireHeld) && Number.isSafeInteger(frame.shotTick)) {
      shotTick = frame.shotTick;
      fireInputSequence = frame.fireInputSequence ?? frame.sequence;
    }
  }
  command.slotRequest = selectedSlot;
  return cloneFrame({
    ...newest,
    shotTick,
    ...(fireInputSequence === undefined ? {} : { fireInputSequence }),
    command,
  });
}

function neutralFor(actor: Actor): InputCommand {
  const neutral = emptyCommand();
  neutral.yaw = actor.yaw;
  neutral.pitch = actor.pitch;
  return neutral;
}
