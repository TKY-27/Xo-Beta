/**
 * Deterministic in-memory match transport used by the Phase 4 tests.
 *
 * This module intentionally has no WebRTC, relay, browser, or other runtime
 * dependency.  It models the four dedicated match channels closely enough to
 * exercise match code against latency, loss, reordering, disconnects, and
 * bounded congestion while keeping time under test control.
 */

export const FAKE_MATCH_CHANNELS = Object.freeze([
  'control',
  'event',
  'input',
  'snapshot',
] as const);

export type FakeMatchChannel = (typeof FAKE_MATCH_CHANNELS)[number];
export type MatchTransportChannel = FakeMatchChannel;
export type FakeChannelLabel = FakeMatchChannel;

export interface FakeChannelSemantics {
  readonly ordered: boolean;
  readonly reliable: boolean;
  readonly maxRetransmits: number | null;
}

/** Keep this contract in sync with DATA_CHANNEL_OPTIONS in gameConnection.ts. */
export const FAKE_CHANNEL_CONFIGS: Readonly<Record<FakeMatchChannel, FakeChannelSemantics>> = Object.freeze({
  control: Object.freeze({ ordered: true, reliable: true, maxRetransmits: null }),
  event: Object.freeze({ ordered: true, reliable: true, maxRetransmits: null }),
  input: Object.freeze({ ordered: false, reliable: false, maxRetransmits: 0 }),
  snapshot: Object.freeze({ ordered: false, reliable: false, maxRetransmits: 0 }),
});

export const MATCH_CHANNEL_CONFIGS = FAKE_CHANNEL_CONFIGS;
export const CHANNEL_CONFIGS = FAKE_CHANNEL_CONFIGS;
export const CHANNEL_SEMANTICS = FAKE_CHANNEL_CONFIGS;
export const MATCH_CHANNEL_SEMANTICS = FAKE_CHANNEL_CONFIGS;

export type FakePacketKind = 'normal' | 'stale' | 'malformed';

export interface FakeTransportMessage<T = unknown> {
  /** Monotonic packet identity allocated by the transport. */
  readonly id: number;
  readonly packetId: number;
  readonly messageId: string;
  readonly from: string;
  readonly to: string;
  readonly channel: FakeMatchChannel;
  readonly data: T;
  /** Per-direction, per-channel sequence.  Unordered channels still expose it for diagnostics. */
  readonly sequence: number;
  readonly sentAt: number;
  readonly deliveredAt: number;
  readonly attempt: number;
  readonly duplicate: boolean;
  readonly isDuplicate: boolean;
  readonly kind: FakePacketKind;
}

export type FakeTransportMessageHandler = (message: FakeTransportMessage) => void;

export interface FakeInjectionOptions {
  readonly from?: string;
  readonly sequence?: number;
  readonly delayMs?: number;
  /** Deliver directly to the application, bypassing transport ordering checks. */
  readonly bypassOrdering?: boolean;
  /** Deliver even while the selected link is disconnected. */
  readonly bypassConnection?: boolean;
}

export type FakeLatency = number | readonly number[] | {
  readonly min: number;
  readonly max: number;
};

export interface FakeDisconnectWindow {
  /** Absolute transport clock time at which the outage starts. */
  readonly atMs?: number;
  readonly startMs?: number;
  /** Absolute transport clock time at which the outage ends. */
  readonly reconnectAtMs?: number;
  readonly endMs?: number;
  readonly untilMs?: number;
  /** Alternative to an absolute end time. */
  readonly durationMs?: number;
  readonly from?: string;
  readonly to?: string;
}

export interface FakeMatchTransportOptions {
  readonly seed?: number | string;
  readonly startTimeMs?: number;
  readonly nowMs?: number;
  readonly clockMs?: number;

  readonly latencyMs?: FakeLatency;
  readonly baseLatencyMs?: FakeLatency;
  readonly latency?: FakeLatency;
  readonly jitterMs?: number;
  readonly network?: {
    readonly latencyMs?: FakeLatency;
    readonly jitterMs?: number;
    readonly lossRate?: number;
    readonly duplicateRate?: number;
    readonly reorderRate?: number;
  };

  readonly lossRate?: number;
  readonly packetLossRate?: number;
  readonly packetLoss?: number;
  readonly dropRate?: number;
  readonly duplicateRate?: number;
  readonly duplicationRate?: number;
  readonly duplication?: number;
  readonly reorderRate?: number;
  readonly reorderingRate?: number;
  readonly reordering?: number;
  readonly reorderWindowMs?: number;

  /** Maximum number of physical and held packets in the transport. */
  readonly maxQueueMessages?: number;
  readonly maxQueueSize?: number;
  readonly maxQueue?: number;
  readonly queueLimit?: number;
  /** Maximum sum of queued payload bytes, including ordered holdback. */
  readonly maxQueueBytes?: number;
  readonly maxPayloadBytes?: number;
  readonly queue?: {
    readonly maxMessages?: number;
    readonly maxBytes?: number;
  };

  /** Number of retries after the initial attempt for reliable channels. */
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly reliableRetryDelayMs?: number;

  readonly faults?: {
    readonly lossRate?: number;
    readonly duplicateRate?: number;
    readonly reorderRate?: number;
  };

  readonly autoConnect?: boolean;
  readonly endpointIds?: readonly string[];
  readonly endpoints?: readonly string[];
  readonly peers?: readonly string[];
  readonly hostId?: string;
  readonly guestId?: string;
  readonly disconnectAtMs?: number;
  readonly reconnectAtMs?: number;
  readonly disconnectDurationMs?: number;
  readonly disconnect?: FakeDisconnectWindow;
  readonly disconnectWindows?: readonly FakeDisconnectWindow[];
  readonly disconnections?: readonly FakeDisconnectWindow[];
  readonly temporaryDisconnects?: readonly FakeDisconnectWindow[];
  readonly onMessage?: FakeTransportMessageHandler;
}

export interface FakeEndpointOptions {
  readonly remoteId?: string;
  readonly onMessage?: FakeTransportMessageHandler;
}

export interface FakeChannelMetrics {
  readonly attempted: number;
  readonly sent: number;
  readonly accepted: number;
  readonly delivered: number;
  readonly received: number;
  readonly dropped: number;
  readonly lost: number;
  readonly duplicates: number;
  readonly duplicated: number;
  readonly reordered: number;
  readonly retries: number;
  readonly staleInjected: number;
  readonly malformedInjected: number;
  readonly staleDropped: number;
  readonly malformedDelivered: number;
  readonly congestionDrops: number;
  readonly queueRejected: number;
  readonly disconnectedDrops: number;
  readonly handlerErrors: number;
  readonly bytesSent: number;
  readonly bytesDelivered: number;
}

export interface FakeLatencyMetrics {
  readonly count: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly averageMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface FakeTransportMetrics {
  readonly nowMs: number;
  readonly clockMs: number;
  readonly attempted: number;
  readonly sent: number;
  readonly accepted: number;
  readonly delivered: number;
  readonly received: number;
  readonly dropped: number;
  readonly lost: number;
  readonly duplicates: number;
  readonly duplicated: number;
  readonly reordered: number;
  readonly retries: number;
  readonly staleInjected: number;
  readonly malformedInjected: number;
  readonly staleDropped: number;
  readonly malformedDelivered: number;
  readonly congestionDrops: number;
  readonly queueRejected: number;
  readonly disconnectedDrops: number;
  readonly blockedSends: number;
  readonly handlerErrors: number;
  readonly bytesSent: number;
  readonly bytesDelivered: number;
  readonly disconnects: number;
  readonly reconnects: number;
  readonly queueDepth: number;
  readonly queuedMessages: number;
  readonly queueBytes: number;
  readonly maxQueueDepth: number;
  readonly maxQueueBytes: number;
  readonly maxQueueMessages: number;
  readonly maxQueueCapacityBytes: number;
  readonly latency: FakeLatencyMetrics;
  readonly latencyMs: FakeLatencyMetrics;
  readonly perChannel: Readonly<Record<FakeMatchChannel, FakeChannelMetrics>>;
  readonly channels: Readonly<Record<FakeMatchChannel, FakeChannelMetrics>>;
}

interface MutableChannelMetrics {
  attempted: number;
  sent: number;
  accepted: number;
  delivered: number;
  received: number;
  dropped: number;
  lost: number;
  duplicates: number;
  duplicated: number;
  reordered: number;
  retries: number;
  staleInjected: number;
  malformedInjected: number;
  staleDropped: number;
  malformedDelivered: number;
  congestionDrops: number;
  queueRejected: number;
  disconnectedDrops: number;
  handlerErrors: number;
  bytesSent: number;
  bytesDelivered: number;
}

interface MutableMetrics extends MutableChannelMetrics {
  blockedSends: number;
  handlerErrors: number;
  disconnects: number;
  reconnects: number;
  maxQueueDepth: number;
  maxQueueBytes: number;
  latencySamples: number[];
  latencySampleCount: number;
}

interface NormalizedOptions {
  readonly latencyMinMs: number;
  readonly latencyMaxMs: number;
  readonly jitterMs: number;
  readonly lossRate: number;
  readonly duplicateRate: number;
  readonly reorderRate: number;
  readonly reorderWindowMs: number;
  readonly maxQueueMessages: number;
  readonly maxQueueBytes: number;
  readonly maxPayloadBytes: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly autoConnect: boolean;
}

interface PendingPacket {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly channel: FakeMatchChannel;
  readonly data: unknown;
  readonly sequence: number;
  readonly sentAt: number;
  readonly bytes: number;
  readonly duplicate: boolean;
  readonly kind: FakePacketKind;
  readonly injected: boolean;
  readonly bypassOrdering: boolean;
  readonly bypassConnection: boolean;
  dueAt: number;
  attempt: number;
  outageDeferrals: number;
  cancelled: boolean;
}

interface OrderedReceiveState {
  nextSequence: number;
  held: Map<number, PendingPacket>;
}

interface ScheduledWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly from: string | null;
  readonly to: string | null;
}

interface ChannelHandleState {
  readonly endpointId: string;
  readonly remoteId: string;
  readonly channel: FakeMatchChannel;
  readonly transport: FakeMatchTransport;
  closed: boolean;
}

const DEFAULT_LATENCY_MS = 30;
const DEFAULT_MAX_QUEUE_MESSAGES = 256;
const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_RETRIES = 4;
const MAX_LATENCY_SAMPLES = 4096;

function isChannel(value: unknown): value is FakeMatchChannel {
  return typeof value === 'string'
    && (FAKE_MATCH_CHANNELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number, label: string, minimum = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${label} must be a finite number >= ${minimum}`);
  }
  return value;
}

function probability(value: unknown, fallback: number, label: string): number {
  const result = finiteNumber(value, fallback, label, 0);
  if (result > 1) throw new RangeError(`${label} must be between 0 and 1`);
  return result;
}

function integer(value: unknown, fallback: number, label: string, minimum: number): number {
  const result = finiteNumber(value, fallback, label, minimum);
  if (!Number.isInteger(result)) throw new RangeError(`${label} must be an integer`);
  return result;
}

function latencyRange(value: FakeLatency | undefined): readonly [number, number] {
  if (value === undefined) return [DEFAULT_LATENCY_MS, DEFAULT_LATENCY_MS];
  if (typeof value === 'number') {
    const result = finiteNumber(value, DEFAULT_LATENCY_MS, 'latencyMs');
    return [result, result];
  }
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new RangeError('latency range must have exactly two values');
    const min = finiteNumber(value[0], 0, 'latency minimum');
    const max = finiteNumber(value[1], 0, 'latency maximum');
    if (max < min) throw new RangeError('latency maximum must be >= minimum');
    return [min, max];
  }
  const range = value as { readonly min: number; readonly max: number };
  const min = finiteNumber(range.min, 0, 'latency minimum');
  const max = finiteNumber(range.max, 0, 'latency maximum');
  if (max < min) throw new RangeError('latency maximum must be >= minimum');
  return [min, max];
}

function normalizeOptions(options: FakeMatchTransportOptions): NormalizedOptions {
  const configuredLatency = options.latencyMs
    ?? options.baseLatencyMs
    ?? options.latency
    ?? options.network?.latencyMs;
  const faults = options.faults;
  const network = options.network;
  const [latencyMinMs, latencyMaxMs] = latencyRange(configuredLatency);
  const maxQueueMessages = integer(
    options.maxQueueMessages
      ?? options.maxQueueSize
      ?? options.maxQueue
      ?? options.queueLimit
      ?? options.queue?.maxMessages,
    DEFAULT_MAX_QUEUE_MESSAGES,
    'maxQueueMessages',
    1,
  );
  const maxQueueBytes = integer(options.maxQueueBytes ?? options.queue?.maxBytes, DEFAULT_MAX_QUEUE_BYTES, 'maxQueueBytes', 1);
  const maxPayloadBytes = integer(options.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES, 'maxPayloadBytes', 1);
  return {
    latencyMinMs,
    latencyMaxMs,
    jitterMs: finiteNumber(options.jitterMs ?? network?.jitterMs, 0, 'jitterMs'),
    lossRate: probability(
      options.lossRate
        ?? options.packetLossRate
        ?? options.packetLoss
        ?? options.dropRate
        ?? faults?.lossRate
        ?? network?.lossRate,
      0,
      'lossRate',
    ),
    duplicateRate: probability(
      options.duplicateRate
        ?? options.duplicationRate
        ?? options.duplication
        ?? faults?.duplicateRate
        ?? network?.duplicateRate,
      0,
      'duplicateRate',
    ),
    reorderRate: probability(
      options.reorderRate
        ?? options.reorderingRate
        ?? options.reordering
        ?? faults?.reorderRate
        ?? network?.reorderRate,
      0,
      'reorderRate',
    ),
    reorderWindowMs: finiteNumber(options.reorderWindowMs, 1, 'reorderWindowMs'),
    maxQueueMessages,
    maxQueueBytes,
    maxPayloadBytes,
    maxRetries: integer(options.maxRetries, DEFAULT_MAX_RETRIES, 'maxRetries', 0),
    retryDelayMs: Math.max(1, finiteNumber(
      options.retryDelayMs ?? options.reliableRetryDelayMs,
      Math.max(1, latencyMaxMs),
      'retryDelayMs',
    )),
    autoConnect: options.autoConnect ?? true,
  };
}

function hashSeed(value: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

class SeededRandom {
  private state: number;

  constructor(seed: number | string | undefined) {
    const normalized = typeof seed === 'string'
      ? hashSeed(seed)
      : (seed ?? 0x584f4245) >>> 0;
    this.state = normalized === 0 ? 0x9e3779b9 : normalized;
  }

  next(): number {
    let state = this.state;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.state = state >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

function payloadBytes(value: unknown): number {
  if (typeof value === 'string') {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
    return value.length * 2;
  }
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return 0;
    return typeof TextEncoder === 'undefined' ? encoded.length * 2 : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return 0;
  }
}

function cloneData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Malformed injection deliberately permits values that are not cloneable.
    }
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    || value === null || value === undefined) return value;
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (ArrayBuffer.isView(value)) return value;
  return value;
}

function channelMetrics(): MutableChannelMetrics {
  return {
    attempted: 0,
    sent: 0,
    accepted: 0,
    delivered: 0,
    received: 0,
    dropped: 0,
    lost: 0,
    duplicates: 0,
    duplicated: 0,
    reordered: 0,
    retries: 0,
    staleInjected: 0,
    malformedInjected: 0,
    staleDropped: 0,
    malformedDelivered: 0,
    congestionDrops: 0,
    queueRejected: 0,
    disconnectedDrops: 0,
    handlerErrors: 0,
    bytesSent: 0,
    bytesDelivered: 0,
  };
}

function mutableMetrics(): MutableMetrics {
  return {
    ...channelMetrics(),
    blockedSends: 0,
    handlerErrors: 0,
    disconnects: 0,
    reconnects: 0,
    maxQueueDepth: 0,
    maxQueueBytes: 0,
    latencySamples: [],
    latencySampleCount: 0,
  };
}

function snapshotChannelMetrics(value: MutableChannelMetrics): FakeChannelMetrics {
  return Object.freeze({ ...value });
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function snapshotLatency(metrics: MutableMetrics): FakeLatencyMetrics {
  if (metrics.latencySampleCount === 0) {
    return Object.freeze({ count: 0, minMs: 0, maxMs: 0, averageMs: 0, p50Ms: 0, p95Ms: 0 });
  }
  const samples = metrics.latencySamples;
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return Object.freeze({
    count: metrics.latencySampleCount,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    averageMs: total / samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  });
}

function pairKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function receiveKey(from: string, to: string, channel: FakeMatchChannel): string {
  return `${from}\u0000${to}\u0000${channel}`;
}

function validatePeerId(id: string, label = 'peer id'): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new TypeError(`${label} must be a non-empty string of at most 128 characters`);
  }
  return id;
}

function normalizeWindow(window: FakeDisconnectWindow): ScheduledWindow {
  const startMs = finiteNumber(window.atMs ?? window.startMs, 0, 'disconnect start time');
  const explicitEnd = window.reconnectAtMs ?? window.endMs ?? window.untilMs;
  const endMs = explicitEnd === undefined
    ? startMs + finiteNumber(window.durationMs, 0, 'disconnect duration', Number.MIN_VALUE)
    : finiteNumber(explicitEnd, 0, 'disconnect end time');
  if (endMs <= startMs) throw new RangeError('disconnect end time must be after start time');
  return {
    startMs,
    endMs,
    from: window.from === undefined ? null : validatePeerId(window.from, 'disconnect from'),
    to: window.to === undefined ? null : validatePeerId(window.to, 'disconnect to'),
  };
}

function matchesWindow(window: ScheduledWindow, from: string, to: string, nowMs: number): boolean {
  if (nowMs < window.startMs || nowMs >= window.endMs) return false;
  if (window.from === null && window.to === null) return true;
  if (window.from !== null && window.to === null) return from === window.from || to === window.from;
  if (window.from === null && window.to !== null) return from === window.to || to === window.to;
  return (from === window.from && to === window.to)
    || (from === window.to && to === window.from);
}

/** A channel-like endpoint for a single side of a FakeMatchTransport. */
export class FakeMatchChannelHandle {
  readonly label: FakeMatchChannel;
  readonly ordered: boolean;
  readonly reliable: boolean;
  readonly maxRetransmits: number | null;
  private readonly state: ChannelHandleState;

  constructor(state: ChannelHandleState) {
    this.state = state;
    this.label = state.channel;
    const semantics = FAKE_CHANNEL_CONFIGS[state.channel];
    this.ordered = semantics.ordered;
    this.reliable = semantics.reliable;
    this.maxRetransmits = semantics.maxRetransmits;
  }

  get readyState(): 'open' | 'connecting' | 'closed' {
    if (this.state.closed) return 'closed';
    return this.state.transport.isConnected(this.state.endpointId, this.state.remoteId)
      ? 'open'
      : 'connecting';
  }

  get bufferedAmount(): number {
    return this.state.closed ? 0 : this.stateTransport().queuedBytesFor(
      this.state.endpointId,
      this.state.remoteId,
      this.label,
    );
  }

  close(): void {
    this.state.closed = true;
  }

  send(data: unknown): boolean {
    if (this.state.closed) return false;
    return this.stateTransport().send(this.state.endpointId, this.state.remoteId, this.label, data);
  }

  private stateTransport(): FakeMatchTransport {
    return this.state.transport;
  }
}

/** Endpoint API used by match tests and by small adapter shims. */
export class FakeMatchEndpoint {
  readonly id: string;
  readonly peerId: string;
  private readonly transport: FakeMatchTransport;
  private remoteIdValue: string | null;
  private readonly listeners = new Set<FakeTransportMessageHandler>();
  private readonly handles = new Map<FakeMatchChannel, FakeMatchChannelHandle>();
  private onMessageHandler: FakeTransportMessageHandler | null = null;

  constructor(transport: FakeMatchTransport, id: string, options: FakeEndpointOptions = {}) {
    this.transport = transport;
    this.id = validatePeerId(id);
    this.peerId = this.id;
    this.remoteIdValue = options.remoteId === undefined ? null : validatePeerId(options.remoteId, 'remote id');
    if (options.onMessage) this.listeners.add(options.onMessage);
  }

  get remoteId(): string | null {
    return this.remoteIdValue;
  }

  set remoteId(value: string | null) {
    this.remoteIdValue = value === null ? null : validatePeerId(value, 'remote id');
  }

  get connected(): boolean {
    return this.remoteIdValue !== null && this.transport.isConnected(this.id, this.remoteIdValue);
  }

  get connectionState(): 'connected' | 'disconnected' {
    return this.connected ? 'connected' : 'disconnected';
  }

  get queueDepth(): number {
    return this.transport.queueDepthFor(this.id);
  }

  get pendingQueueDepth(): number {
    return this.queueDepth;
  }

  get channels(): Readonly<Record<FakeMatchChannel, FakeMatchChannelHandle>> {
    return Object.freeze({
      control: this.channel('control'),
      event: this.channel('event'),
      input: this.channel('input'),
      snapshot: this.channel('snapshot'),
    });
  }

  channel(label: FakeMatchChannel): FakeMatchChannelHandle {
    if (!isChannel(label)) throw new TypeError(`Unknown match channel: ${String(label)}`);
    const existing = this.handles.get(label);
    if (existing) return existing;
    const remoteId = this.requireRemote();
    const state: ChannelHandleState = {
      endpointId: this.id,
      remoteId,
      channel: label,
      closed: false,
      transport: this.transport,
    };
    const handle = new FakeMatchChannelHandle(state);
    this.handles.set(label, handle);
    return handle;
  }

  setRemote(remoteId: string): void {
    this.remoteIdValue = validatePeerId(remoteId, 'remote id');
  }

  onMessage(listener: FakeTransportMessageHandler): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addEventListener(listener: FakeTransportMessageHandler): () => void {
    return this.onMessage(listener);
  }

  removeEventListener(listener: FakeTransportMessageHandler): void {
    this.listeners.delete(listener);
  }

  setMessageHandler(listener: FakeTransportMessageHandler | null): void {
    if (this.onMessageHandler) this.listeners.delete(this.onMessageHandler);
    this.onMessageHandler = listener;
    if (listener) this.listeners.add(listener);
  }

  get onmessage(): FakeTransportMessageHandler | null {
    return this.onMessageHandler;
  }

  set onmessage(listener: FakeTransportMessageHandler | null) {
    this.setMessageHandler(listener);
  }

  send(channel: FakeMatchChannel, data: unknown): boolean;
  send(to: string, channel: FakeMatchChannel, data: unknown): boolean;
  send(first: string, second: unknown, third?: unknown): boolean {
    if (third !== undefined || (typeof second === 'string' && isChannel(second) && arguments.length >= 3)) {
      return this.transport.send(this.id, validatePeerId(first, 'remote id'), second as FakeMatchChannel, third);
    }
    if (!isChannel(first)) return false;
    const remote = this.requireRemote();
    return this.transport.send(this.id, remote, first, second);
  }

  postMessage(channel: FakeMatchChannel, data: unknown): boolean {
    return this.send(channel, data);
  }

  sendControl(data: unknown): boolean {
    return this.send('control', data);
  }

  sendEvent(data: unknown): boolean {
    return this.send('event', data);
  }

  sendInput(data: unknown): boolean {
    return this.send('input', data);
  }

  sendSnapshot(data: unknown): boolean {
    return this.send('snapshot', data);
  }

  disconnect(): void {
    this.transport.disconnect(this.id);
  }

  reconnect(): void {
    this.transport.reconnect(this.id);
  }

  close(): void {
    this.disconnect();
  }

  metrics(): FakeTransportMetrics {
    return this.transport.getMetrics();
  }

  private requireRemote(): string {
    if (this.remoteIdValue === null) throw new Error(`Endpoint ${this.id} has no remote peer`);
    return this.remoteIdValue;
  }

  /** @internal */
  dispatch(message: FakeTransportMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

/**
 * Deterministic, bounded, in-memory match transport.
 *
 * The default endpoints are `host` and `guest`; callers can create additional
 * peers for roster tests.  A transport starts connected unless `autoConnect`
 * is false.  `advance()` runs the manual clock and `flushAll()` drains all
 * currently scheduled work, including retry attempts.
 */
export class FakeMatchTransport {
  private readonly options: NormalizedOptions;
  private readonly random: SeededRandom;
  private readonly endpointsValue = new Map<string, FakeMatchEndpoint>();
  private readonly endpointOnline = new Map<string, boolean>();
  private readonly disabledLinks = new Set<string>();
  private readonly listeners = new Set<FakeTransportMessageHandler>();
  private readonly events: PendingPacket[] = [];
  private readonly orderedReceive = new Map<string, OrderedReceiveState>();
  private readonly manualDisconnected = new Set<string>();
  private readonly manualDisconnectedLinks = new Set<string>();
  private readonly windows: ScheduledWindow[];
  private readonly metricsValue = mutableMetrics();
  private readonly channelMetricsValue = new Map<FakeMatchChannel, MutableChannelMetrics>();
  private readonly nextSequence = new Map<string, number>();
  private nowMsValue: number;
  private lastObservedMs: number;
  private nextPacketId = 1;

  constructor(options?: FakeMatchTransportOptions);
  constructor(leftId: string, rightId: string, options?: FakeMatchTransportOptions);
  constructor(
    optionsOrLeft: FakeMatchTransportOptions | string = {},
    maybeRight?: string,
    maybeOptions: FakeMatchTransportOptions = {},
  ) {
    const options = typeof optionsOrLeft === 'string'
      ? { ...maybeOptions, endpointIds: [optionsOrLeft, maybeRight ?? 'guest'] }
      : optionsOrLeft;
    this.options = normalizeOptions(options);
    this.random = new SeededRandom(options.seed);
    this.nowMsValue = finiteNumber(
      options.startTimeMs ?? options.nowMs ?? options.clockMs,
      0,
      'startTimeMs',
    );
    this.lastObservedMs = this.nowMsValue;
    for (const channel of FAKE_MATCH_CHANNELS) this.channelMetricsValue.set(channel, channelMetrics());
    const endpointIds = options.endpointIds
      ?? options.endpoints
      ?? options.peers
      ?? [options.hostId ?? 'host', options.guestId ?? 'guest'];
    const uniqueEndpointIds = [...new Set(endpointIds)];
    if (uniqueEndpointIds.length < 2) throw new RangeError('A transport needs at least two endpoints');
    for (const id of uniqueEndpointIds) this.createEndpoint(id);
    const [first, second] = uniqueEndpointIds;
    if (first && second) {
      this.endpoint(first).setRemote(second);
      this.endpoint(second).setRemote(first);
    }
    const configuredWindows = options.disconnectWindows
      ?? options.disconnections
      ?? options.temporaryDisconnects
      ?? (options.disconnect ? [options.disconnect] : []);
    this.windows = configuredWindows.map(normalizeWindow);
    if (options.disconnectAtMs !== undefined) {
      this.windows.push(normalizeWindow({
        atMs: options.disconnectAtMs,
        reconnectAtMs: options.reconnectAtMs,
        durationMs: options.disconnectDurationMs,
      }));
    }
    for (const endpoint of this.endpointsValue.values()) {
      this.endpointOnline.set(endpoint.id, this.options.autoConnect);
    }
    if (options.onMessage) this.listeners.add(options.onMessage);
  }

  get now(): number {
    return this.nowMsValue;
  }

  get time(): number {
    return this.nowMsValue;
  }

  get clockMs(): number {
    return this.nowMsValue;
  }

  get host(): FakeMatchEndpoint {
    return this.endpoint('host');
  }

  get guest(): FakeMatchEndpoint {
    return this.endpoint('guest');
  }

  get pendingCount(): number {
    return this.queueDepth;
  }

  get queueDepth(): number {
    let held = 0;
    for (const state of this.orderedReceive.values()) held += state.held.size;
    return this.events.length + held;
  }

  get queuedMessages(): number {
    return this.queueDepth;
  }

  get queueBytes(): number {
    let bytes = this.events.reduce((sum, packet) => sum + packet.bytes, 0);
    for (const state of this.orderedReceive.values()) {
      for (const packet of state.held.values()) bytes += packet.bytes;
    }
    return bytes;
  }

  get pendingQueueSize(): number {
    return this.queueDepth;
  }

  getStats(): FakeTransportMetrics {
    return this.getMetrics();
  }

  get metrics(): FakeTransportMetrics {
    return this.getMetrics();
  }

  get stats(): FakeTransportMetrics {
    return this.getMetrics();
  }

  createEndpoint(id: string, options: FakeEndpointOptions = {}): FakeMatchEndpoint {
    const peerId = validatePeerId(id);
    const existing = this.endpointsValue.get(peerId);
    if (existing) {
      if (options.remoteId !== undefined) existing.setRemote(options.remoteId);
      return existing;
    }
    const endpoint = new FakeMatchEndpoint(this, peerId, options);
    this.endpointsValue.set(peerId, endpoint);
    this.endpointOnline.set(peerId, this.options.autoConnect);
    if (options.onMessage) this.listeners.add(options.onMessage);
    return endpoint;
  }

  addEndpoint(id: string, options: FakeEndpointOptions = {}): FakeMatchEndpoint {
    return this.createEndpoint(id, options);
  }

  endpoint(id: string): FakeMatchEndpoint {
    const peerId = validatePeerId(id);
    const existing = this.endpointsValue.get(peerId);
    return existing ?? this.createEndpoint(peerId);
  }

  getEndpoint(id: string): FakeMatchEndpoint {
    return this.endpoint(id);
  }

  peers(): readonly FakeMatchEndpoint[] {
    return [...this.endpointsValue.values()];
  }

  connect(from: string, to?: string): void {
    const first = this.endpoint(from).id;
    if (to === undefined) {
      const wasDisconnected = !this.endpointOnline.get(first) || this.manualDisconnected.has(first);
      this.endpointOnline.set(first, true);
      this.manualDisconnected.delete(first);
      for (const peer of this.endpointsValue.keys()) {
        if (peer !== first) {
          this.manualDisconnectedLinks.delete(pairKey(first, peer));
          this.manualDisconnectedLinks.delete(pairKey(peer, first));
          this.disabledLinks.delete(pairKey(first, peer));
          this.disabledLinks.delete(pairKey(peer, first));
        }
      }
      if (wasDisconnected) this.metricsValue.reconnects += 1;
      return;
    }
    const second = this.endpoint(to).id;
    const wasDisconnected = !this.isConnected(first, second);
    this.endpointOnline.set(first, true);
    this.endpointOnline.set(second, true);
    this.manualDisconnectedLinks.delete(pairKey(first, second));
    this.manualDisconnectedLinks.delete(pairKey(second, first));
    this.disabledLinks.delete(pairKey(first, second));
    this.disabledLinks.delete(pairKey(second, first));
    if (wasDisconnected) this.metricsValue.reconnects += 1;
  }

  connectPeers(from: string, to: string): void {
    this.connect(from, to);
  }

  disconnect(from?: string, to?: string): void {
    if (from === undefined) {
      const wasConnected = [...this.endpointOnline.values()].some((online) => online);
      for (const peer of this.endpointsValue.keys()) this.manualDisconnected.add(peer);
      for (const peer of this.endpointsValue.keys()) this.endpointOnline.set(peer, false);
      if (wasConnected) this.metricsValue.disconnects += 1;
      return;
    }
    const first = this.endpoint(from).id;
    if (to === undefined) {
      const wasConnected = this.endpointOnline.get(first) !== false && !this.manualDisconnected.has(first);
      this.manualDisconnected.add(first);
      this.endpointOnline.set(first, false);
      if (wasConnected) this.metricsValue.disconnects += 1;
      return;
    }
    const second = this.endpoint(to).id;
    const wasConnected = this.isConnected(first, second);
    this.manualDisconnectedLinks.add(pairKey(first, second));
    this.manualDisconnectedLinks.add(pairKey(second, first));
    this.disabledLinks.add(pairKey(first, second));
    this.disabledLinks.add(pairKey(second, first));
    if (wasConnected) this.metricsValue.disconnects += 1;
  }

  disconnectPeer(id: string): void {
    this.disconnect(id);
  }

  reconnect(from?: string, to?: string): void {
    if (from === undefined) {
      const wasDisconnected = [...this.endpointOnline.values()].some((online) => !online);
      for (const peer of this.endpointsValue.keys()) {
        this.manualDisconnected.delete(peer);
        this.endpointOnline.set(peer, true);
      }
      this.manualDisconnectedLinks.clear();
      this.disabledLinks.clear();
      if (wasDisconnected) this.metricsValue.reconnects += 1;
      return;
    }
    const first = this.endpoint(from).id;
    if (to === undefined) {
      const wasDisconnected = this.endpointOnline.get(first) === false || this.manualDisconnected.has(first);
      this.manualDisconnected.delete(first);
      this.endpointOnline.set(first, true);
      if (wasDisconnected) this.metricsValue.reconnects += 1;
      return;
    }
    const second = this.endpoint(to).id;
    const wasDisconnected = !this.isConnected(first, second);
    this.manualDisconnectedLinks.delete(pairKey(first, second));
    this.manualDisconnectedLinks.delete(pairKey(second, first));
    this.disabledLinks.delete(pairKey(first, second));
    this.disabledLinks.delete(pairKey(second, first));
    this.endpointOnline.set(first, true);
    this.endpointOnline.set(second, true);
    if (wasDisconnected) this.metricsValue.reconnects += 1;
  }

  reconnectPeer(id: string): void {
    this.reconnect(id);
  }

  temporaryDisconnect(from: string, to: string, durationMs: number): void;
  temporaryDisconnect(peer: string, durationMs: number): void;
  temporaryDisconnect(durationMs: number): void;
  temporaryDisconnect(first: string | number, second?: string | number, maybeDuration?: number): void {
    if (typeof first === 'number') {
      const durationMs = first;
      const startMs = this.nowMsValue;
      this.windows.push(normalizeWindow({ atMs: startMs, durationMs }));
      this.metricsValue.disconnects += 1;
      return;
    }
    const durationMs = typeof second === 'number' ? second : maybeDuration;
    if (durationMs === undefined) throw new TypeError('temporary disconnect duration is required');
    const startMs = this.nowMsValue;
    const window: FakeDisconnectWindow = typeof second === 'number'
      ? { atMs: startMs, durationMs, from: first }
      : { atMs: startMs, durationMs, from: first, to: second as string };
    this.windows.push(normalizeWindow(window));
    this.metricsValue.disconnects += 1;
  }

  scheduleDisconnect(window: FakeDisconnectWindow): void;
  scheduleDisconnect(atMs: number, durationMs: number, from?: string, to?: string): void;
  scheduleDisconnect(
    windowOrAtMs: FakeDisconnectWindow | number,
    durationMs?: number,
    from?: string,
    to?: string,
  ): void {
    const window = typeof windowOrAtMs === 'number'
      ? { atMs: windowOrAtMs, durationMs, from, to }
      : windowOrAtMs;
    const normalized = normalizeWindow(window);
    this.windows.push(normalized);
    if (normalized.startMs <= this.nowMsValue && this.nowMsValue < normalized.endMs) {
      this.metricsValue.disconnects += 1;
    }
  }

  isConnected(from: string, to: string): boolean {
    const first = validatePeerId(from, 'from peer');
    const second = validatePeerId(to, 'to peer');
    if (first === second) return false;
    if (this.manualDisconnected.has(first) || this.manualDisconnected.has(second)) return false;
    if (this.manualDisconnectedLinks.has(pairKey(first, second))
      || this.manualDisconnectedLinks.has(pairKey(second, first))) return false;
    if (this.disabledLinks.has(pairKey(first, second)) || this.disabledLinks.has(pairKey(second, first))) return false;
    if (this.endpointOnline.get(first) === false || this.endpointOnline.get(second) === false) return false;
    return !this.windows.some((window) => matchesWindow(window, first, second, this.nowMsValue));
  }

  isPeerConnected(from: string, to: string): boolean {
    return this.isConnected(from, to);
  }

  send(from: string, to: string, channel: FakeMatchChannel, data: unknown): boolean;
  send(from: string, to: string, packet: { readonly channel: FakeMatchChannel; readonly data: unknown }): boolean;
  send(from: string, to: string, channelOrPacket: FakeMatchChannel | { readonly channel: FakeMatchChannel; readonly data: unknown }, data?: unknown): boolean {
    const sender = validatePeerId(from, 'from peer');
    const receiver = validatePeerId(to, 'to peer');
    const channel = typeof channelOrPacket === 'string' ? channelOrPacket : channelOrPacket.channel;
    const payload = typeof channelOrPacket === 'string' ? data : channelOrPacket.data;
    const channelMetrics = this.requireChannelMetrics(channel);
    channelMetrics.attempted += 1;
    this.metricsValue.attempted += 1;
    if (!this.endpointsValue.has(sender) || !this.endpointsValue.has(receiver) || sender === receiver) {
      this.rejectSend(channelMetrics, 'blocked');
      return false;
    }
    const bytes = payloadBytes(payload);
    if (bytes > this.options.maxPayloadBytes) {
      this.rejectSend(channelMetrics, 'queue');
      return false;
    }
    if (!this.isConnected(sender, receiver)) {
      this.metricsValue.blockedSends += 1;
      channelMetrics.disconnectedDrops += 1;
      channelMetrics.dropped += 1;
      this.metricsValue.disconnectedDrops += 1;
      this.metricsValue.dropped += 1;
      return false;
    }
    const sequenceKey = receiveKey(sender, receiver, channel);
    const sequence = this.nextSequence.get(sequenceKey) ?? 0;
    const packet = this.makePacket({
      from: sender,
      to: receiver,
      channel,
      data: cloneData(payload),
      sequence,
      sentAt: this.nowMsValue,
      bytes,
      duplicate: false,
      kind: 'normal',
      injected: false,
      bypassOrdering: false,
      bypassConnection: false,
      dueAt: this.deliveryTime(),
    });
    if (!this.enqueue(packet, channelMetrics, true)) return false;
    channelMetrics.accepted += 1;
    channelMetrics.sent += 1;
    channelMetrics.bytesSent += bytes;
    this.metricsValue.accepted += 1;
    this.metricsValue.sent += 1;
    this.metricsValue.bytesSent += bytes;
    this.nextSequence.set(sequenceKey, sequence + 1);

    if (this.random.next() < this.options.duplicateRate) {
      const duplicate = this.makePacket({ ...packet, id: undefined, duplicate: true, dueAt: this.deliveryTime() });
      if (this.enqueue(duplicate, channelMetrics, false)) {
        channelMetrics.duplicates += 1;
        channelMetrics.duplicated += 1;
        this.metricsValue.duplicates += 1;
        this.metricsValue.duplicated += 1;
      }
    }
    this.maybeReorder(packet, channelMetrics);
    this.sortEvents();
    return true;
  }

  sendMessage(from: string, to: string, channel: FakeMatchChannel, data: unknown): boolean;
  sendMessage(from: string, to: string, packet: { readonly channel: FakeMatchChannel; readonly data: unknown }): boolean;
  sendMessage(
    from: string,
    to: string,
    channelOrPacket: FakeMatchChannel | { readonly channel: FakeMatchChannel; readonly data: unknown },
    data?: unknown,
  ): boolean {
    return typeof channelOrPacket === 'string'
      ? this.send(from, to, channelOrPacket, data)
      : this.send(from, to, channelOrPacket);
  }

  /** Inject an application-visible stale or malformed message. */
  injectStale(to: string, channel: FakeMatchChannel, data: unknown, options?: FakeInjectionOptions): number;
  injectStale(from: string, to: string, channel: FakeMatchChannel, data: unknown, options?: FakeInjectionOptions): number;
  injectStale(first: string, second: string, third: FakeMatchChannel | unknown, fourth?: unknown, fifth?: FakeInjectionOptions): number {
    const parsed = this.parseInjectionArguments(first, second, third, fourth, fifth);
    const options = parsed.options ?? {};
    return this.injectPacket(parsed.from, parsed.to, parsed.channel, parsed.data, {
      ...options,
      kind: 'stale',
      bypassOrdering: options.bypassOrdering ?? true,
    });
  }

  /** Inject an application-visible malformed message. */
  injectMalformed(to: string, channel: FakeMatchChannel, data: unknown, options?: FakeInjectionOptions): number;
  injectMalformed(from: string, to: string, channel: FakeMatchChannel, data: unknown, options?: FakeInjectionOptions): number;
  injectMalformed(first: string, second: string, third: FakeMatchChannel | unknown, fourth?: unknown, fifth?: FakeInjectionOptions): number {
    const parsed = this.parseInjectionArguments(first, second, third, fourth, fifth);
    const options = parsed.options ?? {};
    return this.injectPacket(parsed.from, parsed.to, parsed.channel, parsed.data, {
      ...options,
      kind: 'malformed',
      bypassOrdering: options.bypassOrdering ?? true,
    });
  }

  inject(to: string, channel: FakeMatchChannel, data: unknown, options?: FakeInjectionOptions & { kind?: FakePacketKind }): number;
  inject(from: string, to: string, channel: FakeMatchChannel, data: unknown, options?: FakeInjectionOptions & { kind?: FakePacketKind }): number;
  inject(first: string, second: string, third: FakeMatchChannel | unknown, fourth?: unknown, fifth?: FakeInjectionOptions & { kind?: FakePacketKind }): number {
    const parsed = this.parseInjectionArguments(first, second, third, fourth, fifth);
    const options = parsed.options ?? {};
    return this.injectPacket(parsed.from, parsed.to, parsed.channel, parsed.data, options);
  }

  injectPacket(
    from: string,
    to: string,
    channel: FakeMatchChannel,
    data: unknown,
    options: FakeInjectionOptions & { readonly kind?: FakePacketKind } = {},
  ): number {
    const sender = validatePeerId(from, 'from peer');
    const receiver = validatePeerId(to, 'to peer');
    const channelMetrics = this.requireChannelMetrics(channel);
    const kind = options.kind ?? 'normal';
    if (kind === 'stale') {
      channelMetrics.staleInjected += 1;
      this.metricsValue.staleInjected += 1;
    } else if (kind === 'malformed') {
      channelMetrics.malformedInjected += 1;
      this.metricsValue.malformedInjected += 1;
    }
    const bytes = payloadBytes(data);
    if (bytes > this.options.maxPayloadBytes) {
      this.rejectSend(channelMetrics, 'queue');
      return -1;
    }
    const sequenceKey = receiveKey(sender, receiver, channel);
    const sequence = options.sequence ?? (kind === 'stale'
      ? Math.max(0, (this.nextSequence.get(sequenceKey) ?? 0) - 1)
      : (this.nextSequence.get(sequenceKey) ?? 0));
    const packet = this.makePacket({
      from: sender,
      to: receiver,
      channel,
      data: cloneData(data),
      sequence,
      sentAt: this.nowMsValue,
      bytes,
      duplicate: false,
      kind,
      injected: true,
      bypassOrdering: options.bypassOrdering ?? false,
      bypassConnection: options.bypassConnection ?? true,
      dueAt: this.nowMsValue + finiteNumber(options.delayMs, 0, 'injection delay'),
    });
    if (!this.enqueue(packet, channelMetrics, true)) return -1;
    this.sortEvents();
    return packet.id;
  }

  /** Run the manual clock, delivering every packet whose due time is reached. */
  advance(milliseconds: number): number {
    const duration = finiteNumber(milliseconds, 0, 'advance duration');
    const target = this.nowMsValue + duration;
    let delivered = 0;
    while (true) {
      const next = this.nextDueAt();
      if (next === null || next > target) break;
      this.observeWindowTransitions(next);
      this.nowMsValue = Math.max(this.nowMsValue, next);
      delivered += this.flushDue();
    }
    this.observeWindowTransitions(target);
    this.nowMsValue = target;
    delivered += this.flushDue();
    return delivered;
  }

  advanceClock(milliseconds: number): number {
    return this.advance(milliseconds);
  }

  advanceTime(milliseconds: number): number {
    return this.advance(milliseconds);
  }

  tick(milliseconds: number): number {
    return this.advance(milliseconds);
  }

  /** Deliver packets due at the current clock without moving time. */
  flushDue(): number {
    let delivered = 0;
    this.sortEvents();
    while (this.events[0] && this.events[0].dueAt <= this.nowMsValue) {
      const packet = this.events.shift();
      if (!packet || packet.cancelled) continue;
      delivered += this.processPacket(packet);
      this.sortEvents();
    }
    this.updateQueueHighWaterMark();
    return delivered;
  }

  flushPending(): number {
    return this.flushDue();
  }

  /** Drain all scheduled work by advancing to each next due packet. */
  flushAll(maxSteps = this.options.maxQueueMessages * (this.options.maxRetries + 8) + 1): number {
    const limit = integer(maxSteps, 1, 'flush max steps', 1);
    let delivered = 0;
    let steps = 0;
    while (this.events.length > 0 && steps < limit) {
      const next = this.nextDueAt();
      if (next === null) break;
      this.observeWindowTransitions(next);
      this.nowMsValue = Math.max(this.nowMsValue, next);
      delivered += this.flushDue();
      steps += 1;
    }
    return delivered;
  }

  /** `flush` is an all-work convenience; use flushDue to preserve latency. */
  flush(maxSteps?: number): number {
    return this.flushAll(maxSteps);
  }

  drain(maxSteps?: number): number {
    return this.flushAll(maxSteps);
  }

  close(): void {
    this.disconnect();
    this.events.length = 0;
    for (const state of this.orderedReceive.values()) state.held.clear();
  }

  dispose(): void {
    this.close();
  }

  onMessage(listener: FakeTransportMessageHandler): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addEventListener(listener: FakeTransportMessageHandler): () => void {
    return this.onMessage(listener);
  }

  removeEventListener(listener: FakeTransportMessageHandler): void {
    this.listeners.delete(listener);
  }

  queuedBytesFor(from: string, to: string, channel?: FakeMatchChannel): number {
    const sender = validatePeerId(from, 'from peer');
    const receiver = validatePeerId(to, 'to peer');
    let bytes = 0;
    for (const packet of this.events) {
      if (packet.from === sender && packet.to === receiver && (channel === undefined || packet.channel === channel)) bytes += packet.bytes;
    }
    for (const state of this.orderedReceive.values()) {
      for (const packet of state.held.values()) {
        if (packet.from === sender && packet.to === receiver && (channel === undefined || packet.channel === channel)) bytes += packet.bytes;
      }
    }
    return bytes;
  }

  queueDepthFor(endpoint: string): number {
    const peerId = validatePeerId(endpoint);
    let count = 0;
    for (const packet of this.events) if (packet.from === peerId || packet.to === peerId) count += 1;
    for (const state of this.orderedReceive.values()) {
      for (const packet of state.held.values()) if (packet.from === peerId || packet.to === peerId) count += 1;
    }
    return count;
  }

  getChannelMetrics(channel: FakeMatchChannel): FakeChannelMetrics {
    return snapshotChannelMetrics(this.requireChannelMetrics(channel));
  }

  metricsFor(channel: FakeMatchChannel): FakeChannelMetrics {
    return this.getChannelMetrics(channel);
  }

  getMetrics(): FakeTransportMetrics {
    const perChannel = {} as Record<FakeMatchChannel, FakeChannelMetrics>;
    for (const channel of FAKE_MATCH_CHANNELS) {
      perChannel[channel] = snapshotChannelMetrics(this.requireChannelMetrics(channel));
    }
    const latency = snapshotLatency(this.metricsValue);
    return Object.freeze({
      nowMs: this.nowMsValue,
      clockMs: this.nowMsValue,
      attempted: this.metricsValue.attempted,
      sent: this.metricsValue.sent,
      accepted: this.metricsValue.accepted,
      delivered: this.metricsValue.delivered,
      received: this.metricsValue.received,
      dropped: this.metricsValue.dropped,
      lost: this.metricsValue.lost,
      duplicates: this.metricsValue.duplicates,
      duplicated: this.metricsValue.duplicated,
      reordered: this.metricsValue.reordered,
      retries: this.metricsValue.retries,
      staleInjected: this.metricsValue.staleInjected,
      malformedInjected: this.metricsValue.malformedInjected,
      staleDropped: this.metricsValue.staleDropped,
      malformedDelivered: this.metricsValue.malformedDelivered,
      congestionDrops: this.metricsValue.congestionDrops,
      queueRejected: this.metricsValue.queueRejected,
      disconnectedDrops: this.metricsValue.disconnectedDrops,
      blockedSends: this.metricsValue.blockedSends,
      handlerErrors: this.metricsValue.handlerErrors,
      bytesSent: this.metricsValue.bytesSent,
      bytesDelivered: this.metricsValue.bytesDelivered,
      disconnects: this.metricsValue.disconnects,
      reconnects: this.metricsValue.reconnects,
      queueDepth: this.queueDepth,
      queuedMessages: this.queueDepth,
      queueBytes: this.queueBytes,
      maxQueueDepth: this.metricsValue.maxQueueDepth,
      maxQueueBytes: this.metricsValue.maxQueueBytes,
      maxQueueMessages: this.options.maxQueueMessages,
      maxQueueCapacityBytes: this.options.maxQueueBytes,
      latency,
      latencyMs: latency,
      perChannel: Object.freeze(perChannel),
      channels: Object.freeze(perChannel),
    });
  }

  snapshotMetrics(): FakeTransportMetrics {
    return this.getMetrics();
  }

  private makePacket(input: Omit<PendingPacket, 'id' | 'attempt' | 'outageDeferrals' | 'cancelled'> & { id?: undefined }): PendingPacket {
    const id = this.nextPacketId;
    this.nextPacketId += 1;
    return {
      ...input,
      id,
      attempt: 0,
      outageDeferrals: 0,
      cancelled: false,
    };
  }

  private deliveryTime(): number {
    const base = this.options.latencyMinMs === this.options.latencyMaxMs
      ? this.options.latencyMinMs
      : this.options.latencyMinMs + this.random.next() * (this.options.latencyMaxMs - this.options.latencyMinMs);
    const jitter = this.options.jitterMs === 0 ? 0 : (this.random.next() * 2 - 1) * this.options.jitterMs;
    return this.nowMsValue + Math.max(0, base + jitter);
  }

  private enqueue(packet: PendingPacket, channelMetrics: MutableChannelMetrics, primary: boolean): boolean {
    if (!this.hasQueueCapacity(packet.bytes)) {
      channelMetrics.queueRejected += 1;
      channelMetrics.congestionDrops += 1;
      channelMetrics.dropped += 1;
      this.metricsValue.queueRejected += 1;
      this.metricsValue.congestionDrops += 1;
      this.metricsValue.dropped += 1;
      if (primary) this.metricsValue.blockedSends += 1;
      return false;
    }
    this.events.push(packet);
    this.updateQueueHighWaterMark();
    return true;
  }

  private hasQueueCapacity(bytes: number): boolean {
    return this.queueDepth + 1 <= this.options.maxQueueMessages
      && this.queueBytes + bytes <= this.options.maxQueueBytes;
  }

  private maybeReorder(packet: PendingPacket, channelMetrics: MutableChannelMetrics): void {
    if (this.options.reorderRate === 0 || this.random.next() >= this.options.reorderRate) return;
    const previous = [...this.events]
      .filter((candidate) => candidate !== packet && !candidate.cancelled
        && candidate.from === packet.from && candidate.to === packet.to && candidate.channel === packet.channel)
      .sort((a, b) => a.id - b.id)
      .at(-1);
    if (!previous) return;
    const previousDue = previous.dueAt;
    previous.dueAt = packet.dueAt;
    packet.dueAt = previousDue;
    if (previous.dueAt === packet.dueAt) {
      previous.dueAt += this.options.reorderWindowMs;
      packet.dueAt = Math.max(this.nowMsValue, packet.dueAt - this.options.reorderWindowMs);
    }
    channelMetrics.reordered += 1;
    this.metricsValue.reordered += 1;
  }

  private processPacket(packet: PendingPacket): number {
    const channelMetrics = this.requireChannelMetrics(packet.channel);
    if (!packet.bypassConnection && !this.isConnected(packet.from, packet.to)) {
      const semantics = FAKE_CHANNEL_CONFIGS[packet.channel];
      if (!semantics.reliable || packet.outageDeferrals >= this.options.maxRetries + 1) {
        channelMetrics.disconnectedDrops += 1;
        channelMetrics.dropped += 1;
        this.metricsValue.disconnectedDrops += 1;
        this.metricsValue.dropped += 1;
        if (semantics.reliable) this.skipReliableSequence(packet);
        return 0;
      }
      packet.outageDeferrals += 1;
      packet.dueAt = this.nowMsValue + this.options.retryDelayMs;
      this.events.push(packet);
      this.sortEvents();
      return 0;
    }

    const semantics = FAKE_CHANNEL_CONFIGS[packet.channel];
    if (!packet.injected && this.random.next() < this.options.lossRate) {
      if (semantics.reliable && packet.attempt < this.options.maxRetries) {
        packet.attempt += 1;
        packet.dueAt = this.nowMsValue + this.options.retryDelayMs;
        this.events.push(packet);
        channelMetrics.retries += 1;
        this.metricsValue.retries += 1;
        this.sortEvents();
        return 0;
      }
      channelMetrics.lost += 1;
      channelMetrics.dropped += 1;
      this.metricsValue.lost += 1;
      this.metricsValue.dropped += 1;
      if (semantics.reliable) this.skipReliableSequence(packet);
      return 0;
    }

    if (packet.kind === 'stale' && !packet.bypassOrdering && semantics.ordered) {
      const state = this.receiveState(packet);
      if (packet.sequence < state.nextSequence) {
        this.recordStaleDrop(channelMetrics, packet.bytes);
        return 0;
      }
    }
    if (packet.kind === 'malformed' && packet.bypassOrdering) {
      this.deliverPacket(packet, channelMetrics);
      return 1;
    }
    if (packet.bypassOrdering || !semantics.ordered) {
      this.deliverPacket(packet, channelMetrics);
      return 1;
    }
    const state = this.receiveState(packet);
    if (packet.sequence < state.nextSequence) {
      this.recordStaleDrop(channelMetrics, packet.bytes);
      return 0;
    }
    if (packet.sequence > state.nextSequence) {
      if (state.held.has(packet.sequence)) {
        channelMetrics.dropped += 1;
        this.metricsValue.dropped += 1;
        return 0;
      }
      if (!this.hasQueueCapacity(packet.bytes)) {
        channelMetrics.congestionDrops += 1;
        channelMetrics.dropped += 1;
        this.metricsValue.congestionDrops += 1;
        this.metricsValue.dropped += 1;
        return 0;
      }
      state.held.set(packet.sequence, packet);
      this.updateQueueHighWaterMark();
      return 0;
    }
    let delivered = 0;
    // A duplicate can arrive ahead of the original on an ordered channel.
    // Whichever copy fills the sequence is delivered once; remove any held
    // copy of that same sequence before draining later packets.
    state.held.delete(packet.sequence);
    delivered += this.deliverPacket(packet, channelMetrics);
    state.nextSequence += 1;
    this.purgeHeldBefore(state, channelMetrics);
    while (state.held.has(state.nextSequence)) {
      const next = state.held.get(state.nextSequence);
      state.held.delete(state.nextSequence);
      if (!next) break;
      delivered += this.deliverPacket(next, channelMetrics);
      state.nextSequence += 1;
    }
    return delivered;
  }

  private deliverPacket(packet: PendingPacket, channelMetrics: MutableChannelMetrics): number {
    const message: FakeTransportMessage = Object.freeze({
      id: packet.id,
      packetId: packet.id,
      messageId: `fake-${packet.id}`,
      from: packet.from,
      to: packet.to,
      channel: packet.channel,
      data: packet.data,
      sequence: packet.sequence,
      sentAt: packet.sentAt,
      deliveredAt: this.nowMsValue,
      attempt: packet.attempt,
      duplicate: packet.duplicate,
      isDuplicate: packet.duplicate,
      kind: packet.kind,
    });
    const latency = Math.max(0, this.nowMsValue - packet.sentAt);
    this.recordLatency(latency);
    channelMetrics.delivered += 1;
    channelMetrics.received += 1;
    channelMetrics.bytesDelivered += packet.bytes;
    if (packet.kind === 'malformed') channelMetrics.malformedDelivered += 1;
    if (packet.kind === 'malformed') this.metricsValue.malformedDelivered += 1;
    this.metricsValue.delivered += 1;
    this.metricsValue.received += 1;
    this.metricsValue.bytesDelivered += packet.bytes;
    const endpoint = this.endpointsValue.get(packet.to);
    try {
      endpoint?.dispatch(message);
      for (const listener of this.listeners) listener(message);
    } catch {
      channelMetrics.handlerErrors += 1;
      this.metricsValue.handlerErrors += 1;
    }
    return 1;
  }

  private skipReliableSequence(packet: PendingPacket): void {
    const state = this.receiveState(packet);
    if (packet.sequence !== state.nextSequence) return;
    state.nextSequence += 1;
    const channelMetrics = this.requireChannelMetrics(packet.channel);
    this.purgeHeldBefore(state, channelMetrics);
    while (state.held.has(state.nextSequence)) {
      const next = state.held.get(state.nextSequence);
      state.held.delete(state.nextSequence);
      if (!next) break;
      this.deliverPacket(next, channelMetrics);
      state.nextSequence += 1;
      this.purgeHeldBefore(state, channelMetrics);
      this.purgeHeldBefore(state, channelMetrics);
    }
  }

  private receiveState(packet: PendingPacket): OrderedReceiveState {
    const key = receiveKey(packet.from, packet.to, packet.channel);
    const existing = this.orderedReceive.get(key);
    if (existing) return existing;
    const state: OrderedReceiveState = { nextSequence: 0, held: new Map() };
    this.orderedReceive.set(key, state);
    return state;
  }

  private recordStaleDrop(channelMetrics: MutableChannelMetrics, bytes: number): void {
    channelMetrics.staleDropped += 1;
    channelMetrics.dropped += 1;
    this.metricsValue.staleDropped += 1;
    this.metricsValue.dropped += 1;
    // Stale packets never enter the application delivery counters.
    void bytes;
  }

  private purgeHeldBefore(state: OrderedReceiveState, channelMetrics: MutableChannelMetrics): void {
    for (const sequence of state.held.keys()) {
      if (sequence >= state.nextSequence) continue;
      state.held.delete(sequence);
      channelMetrics.dropped += 1;
      this.metricsValue.dropped += 1;
    }
  }

  private rejectSend(channelMetrics: MutableChannelMetrics, reason: 'blocked' | 'queue'): void {
    if (reason === 'queue') {
      channelMetrics.queueRejected += 1;
      channelMetrics.congestionDrops += 1;
      this.metricsValue.queueRejected += 1;
      this.metricsValue.congestionDrops += 1;
    }
    channelMetrics.dropped += 1;
    this.metricsValue.dropped += 1;
  }

  private requireChannelMetrics(channel: FakeMatchChannel): MutableChannelMetrics {
    if (!isChannel(channel)) throw new TypeError(`Unknown match channel: ${String(channel)}`);
    const metrics = this.channelMetricsValue.get(channel);
    if (!metrics) throw new Error(`Missing metrics for channel: ${channel}`);
    return metrics;
  }

  private recordLatency(value: number): void {
    this.metricsValue.latencySampleCount += 1;
    if (this.metricsValue.latencySamples.length >= MAX_LATENCY_SAMPLES) {
      this.metricsValue.latencySamples.shift();
    }
    this.metricsValue.latencySamples.push(value);
  }

  private updateQueueHighWaterMark(): void {
    this.metricsValue.maxQueueDepth = Math.max(this.metricsValue.maxQueueDepth, this.queueDepth);
    this.metricsValue.maxQueueBytes = Math.max(this.metricsValue.maxQueueBytes, this.queueBytes);
  }

  private nextDueAt(): number | null {
    this.sortEvents();
    return this.events[0]?.dueAt ?? null;
  }

  private observeWindowTransitions(nextMs: number): void {
    if (nextMs < this.lastObservedMs) {
      this.lastObservedMs = nextMs;
      return;
    }
    for (const window of this.windows) {
      if (this.lastObservedMs < window.startMs && nextMs >= window.startMs) {
        this.metricsValue.disconnects += 1;
      }
      if (this.lastObservedMs < window.endMs && nextMs >= window.endMs) {
        this.metricsValue.reconnects += 1;
      }
    }
    this.lastObservedMs = nextMs;
  }

  private sortEvents(): void {
    this.events.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
  }

  private parseInjectionArguments(
    first: string,
    second: string,
    third: FakeMatchChannel | unknown,
    fourth?: unknown,
    fifth?: FakeInjectionOptions,
  ): { from: string; to: string; channel: FakeMatchChannel; data: unknown; options?: FakeInjectionOptions } {
    if (isChannel(second)) {
      const to = this.endpoint(first).id;
      const endpoint = this.endpoint(to);
      const from = (fourth && isRecord(fourth) && typeof fourth.from === 'string')
        ? fourth.from
        : endpoint.remoteId ?? 'injector';
      return {
        from: validatePeerId(from, 'from peer'),
        to,
        channel: second,
        data: third,
        options: (fourth && isRecord(fourth) ? fourth : undefined) as FakeInjectionOptions | undefined,
      };
    }
    if (!isChannel(third)) throw new TypeError(`Unknown match channel: ${String(third)}`);
    return {
      from: validatePeerId(first, 'from peer'),
      to: validatePeerId(second, 'to peer'),
      channel: third,
      data: fourth,
      options: fifth,
    };
  }
}

export type FakeTransport = FakeMatchTransport;
export type InMemoryMatchTransport = FakeMatchTransport;
export const DeterministicFakeTransport = FakeMatchTransport;

export interface FakeMatchHarness {
  readonly transport: FakeMatchTransport;
  readonly host: FakeMatchEndpoint;
  readonly guest: FakeMatchEndpoint;
  readonly endpoints: Readonly<Record<string, FakeMatchEndpoint>>;
  advance(milliseconds: number): number;
  flush(maxSteps?: number): number;
  flushAll(maxSteps?: number): number;
  getMetrics(): FakeTransportMetrics;
}

export function createFakeMatchHarness(options: FakeMatchTransportOptions = {}): FakeMatchHarness {
  const transport = new FakeMatchTransport(options);
  const endpoints = Object.fromEntries(transport.peers().map((endpoint) => [endpoint.id, endpoint]));
  return Object.freeze({
    transport,
    host: transport.host,
    guest: transport.guest,
    endpoints: Object.freeze(endpoints),
    advance: (milliseconds: number) => transport.advance(milliseconds),
    flush: (maxSteps?: number) => transport.flush(maxSteps),
    flushAll: (maxSteps?: number) => transport.flushAll(maxSteps),
    getMetrics: () => transport.getMetrics(),
  });
}

export function createFakeMatchTransport(options: FakeMatchTransportOptions = {}): FakeMatchTransport {
  return new FakeMatchTransport(options);
}

export const createFakeTransport = createFakeMatchTransport;
