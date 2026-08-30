import {
  assertStunOnlyConfiguration,
  createIceConfiguration,
  iceCandidateType,
  isRelayIceCandidate,
} from './ice';

/** The one host-to-one-guest data-channel contract used by Phase 3. */
export const REQUIRED_CHANNEL_LABELS = Object.freeze(['control', 'event', 'input', 'snapshot'] as const);
export type GameChannelLabel = (typeof REQUIRED_CHANNEL_LABELS)[number];

/**
 * These are RTCDataChannelInit values, rather than a second transport layer.
 * Reliable channels deliberately omit retransmission limits; input and
 * snapshot are explicitly lossy and unordered.
 */
export const DATA_CHANNEL_OPTIONS: Readonly<Record<GameChannelLabel, RTCDataChannelInit>> = Object.freeze({
  control: Object.freeze({ ordered: true }),
  event: Object.freeze({ ordered: true }),
  input: Object.freeze({ ordered: false, maxRetransmits: 0 }),
  snapshot: Object.freeze({ ordered: false, maxRetransmits: 0 }),
});

/** Alias for callers that use "config" for channel initialization options. */
export const CHANNEL_CONFIGS = DATA_CHANNEL_OPTIONS;

/** The low-water mark and hard cap applied to every data channel. */
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 64 * 1024;
export const MAX_BUFFERED_AMOUNT = 256 * 1024;
export const MAX_PENDING_SIGNAL_CANDIDATES = 64;

export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
export const MAX_CONTROL_HANDSHAKE_BYTES = 2 * 1024;
export const MAX_INBOUND_CHANNEL_MESSAGE_BYTES = 256 * 1024;
const CONTROL_HANDSHAKE_TYPE = 'xo-control-handshake-v1';

export type GameConnectionRole = 'host' | 'guest';

export interface GameProtocolBinding {
  readonly protocolVersion: number;
  readonly buildId: string;
  readonly roomId: string;
  readonly role: GameConnectionRole;
  readonly participantId: string;
  readonly peerId: string;
  readonly protocolSession: string;
}

export type SessionDescriptionSignal = RTCSessionDescriptionInit | string;
export type IceCandidateSignal = RTCIceCandidateInit | string;

export interface OfferSignal {
  readonly type: 'offer';
  readonly sdp: SessionDescriptionSignal;
}

export interface AnswerSignal {
  readonly type: 'answer';
  readonly sdp: SessionDescriptionSignal;
}

export interface CandidateSignal {
  readonly type: 'candidate';
  readonly candidate: IceCandidateSignal;
}

/** Reliable signaling messages exchanged out of band by the lobby. */
export type SignalMessage = OfferSignal | AnswerSignal | CandidateSignal;
export type SignalingMessage = SignalMessage;
export type GameConnectionSignalMessage = SignalMessage;
export type GameSignal = SignalMessage;

export interface GameMessage {
  readonly channel: GameChannelLabel;
  readonly data: unknown;
}

export interface CandidatePairDiagnostics {
  readonly id: string;
  readonly state: string | null;
  readonly nominated: boolean;
  readonly selected: boolean;
  readonly protocol: string | null;
  readonly localCandidateId: string | null;
  readonly remoteCandidateId: string | null;
  readonly localCandidateType: string | null;
  readonly remoteCandidateType: string | null;
}

/** Minimal channel surface, kept small so Node tests can inject a fake. */
export interface GameDataChannel {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime?: number | null;
  readonly readyState: string;
  binaryType: BinaryType;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
}

/** Minimal peer surface used by GameConnection and its injected test factory. */
export interface PeerConnectionLike {
  createDataChannel(label: string, options?: RTCDataChannelInit): GameDataChannel;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
  restartIce?(): void;
  getStats?(): Promise<RTCStatsReport | Map<string, unknown>>;
  close(): void;
  readonly connectionState?: RTCPeerConnectionState;
  readonly iceConnectionState?: RTCIceConnectionState;
  readonly localDescription?: RTCSessionDescription | null;
  readonly remoteDescription?: RTCSessionDescription | null;
  onicecandidate: ((event: { readonly candidate: RTCIceCandidate | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  ondatachannel: ((event: { readonly channel: GameDataChannel }) => void) | null;
}

export type PeerConnectionFactory = (configuration: RTCConfiguration) => PeerConnectionLike;

export interface GameConnectionTimer {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GameConnectionOptions {
  readonly role: GameConnectionRole;
  readonly peerConnectionFactory?: PeerConnectionFactory;
  /** Alias accepted for callers that name the constructor hook explicitly. */
  readonly createPeerConnection?: PeerConnectionFactory;
  /** A fully constructed peer is useful for deterministic Node tests. */
  readonly peerConnection?: PeerConnectionLike;
  readonly onSignal?: (message: SignalMessage) => void | Promise<void>;
  readonly sendSignal?: (message: SignalMessage) => void | Promise<void>;
  readonly onMessage?: (message: GameMessage) => void;
  readonly onData?: (message: GameMessage) => void;
  readonly onStateChange?: (state: GameConnectionState) => void;
  readonly onError?: (error: Error) => void;
  readonly onCandidatePair?: (diagnostics: CandidatePairDiagnostics) => void;
  readonly connectionTimeoutMs?: number;
  readonly timer?: GameConnectionTimer;
  /** Explicit admitted identity sent as the first reliable control message. */
  readonly protocolBinding?: GameProtocolBinding;
  /** Exact remote identity expected before the connection becomes usable. */
  readonly expectedRemoteProtocolBinding?: GameProtocolBinding;
}

export type GameConnectionState =
  | 'new'
  | 'signaling'
  | 'connecting'
  | 'restarting'
  | 'connected'
  | 'failed'
  | 'closed'
  | 'disposed';

type ConnectionOptionsWithoutRole = Omit<GameConnectionOptions, 'role'>;
export type GamePayload = string | ArrayBuffer | ArrayBufferView;
export type DataPayload = GamePayload;

const DEFAULT_TIMER: GameConnectionTimer = {
  setTimeout(handler, timeoutMs) {
    return globalThis.setTimeout(handler, timeoutMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

const RELIABLE_CHANNELS = new Set<GameChannelLabel>(['control', 'event']);

function isGameChannelLabel(label: string): label is GameChannelLabel {
  return (REQUIRED_CHANNEL_LABELS as readonly string[]).includes(label);
}

function optionsFor(label: GameChannelLabel): RTCDataChannelInit {
  const options = DATA_CHANNEL_OPTIONS[label];
  return options.maxRetransmits === undefined
    ? { ordered: options.ordered }
    : { ordered: options.ordered, maxRetransmits: options.maxRetransmits };
}

function normalizeDescription(
  type: 'offer' | 'answer',
  value: SessionDescriptionSignal,
): RTCSessionDescriptionInit {
  if (typeof value === 'string') return { type, sdp: value };
  if (!value || value.type !== undefined && value.type !== type) {
    throw new Error(`Invalid ${type} session description`);
  }
  return { type, sdp: value.sdp };
}

function assertNoRelayDescription(description: RTCSessionDescriptionInit): void {
  if (typeof description.sdp === 'string' && isRelayIceCandidate(description.sdp)) {
    throw new Error('Relay ICE candidate is not allowed');
  }
}

function normalizeCandidate(value: IceCandidateSignal): RTCIceCandidateInit {
  if (typeof value === 'string') return { candidate: value };
  if (!value || typeof value.candidate !== 'string') {
    throw new Error('Invalid ICE candidate');
  }
  return {
    candidate: value.candidate,
    sdpMid: value.sdpMid,
    sdpMLineIndex: value.sdpMLineIndex,
    usernameFragment: value.usernameFragment,
  };
}

function dataSize(data: DataPayload): number {
  if (typeof data === 'string') {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(data).byteLength;
    return data.length * 2;
  }
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

function inboundDataSize(data: unknown): number | null {
  if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
  return null;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function validateProtocolBinding(value: unknown, label: string): GameProtocolBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    'protocolVersion',
    'buildId',
    'roomId',
    'role',
    'participantId',
    'peerId',
    'protocolSession',
  ];
  if (Object.keys(record).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new Error(`Invalid ${label}`);
  }
  const binding = record as unknown as GameProtocolBinding;
  const identifiers = [binding.buildId, binding.roomId, binding.participantId, binding.peerId, binding.protocolSession];
  if (binding.protocolVersion < 1 || !Number.isSafeInteger(binding.protocolVersion)
    || (binding.role !== 'host' && binding.role !== 'guest')
    || identifiers.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 128
      || item !== item.trim() || hasControlCharacters(item))) {
    throw new Error(`Invalid ${label}`);
  }
  return Object.freeze({ ...binding });
}

function protocolBindingsMatch(actual: GameProtocolBinding, expected: GameProtocolBinding): boolean {
  return actual.protocolVersion === expected.protocolVersion
    && actual.buildId === expected.buildId
    && actual.roomId === expected.roomId
    && actual.role === expected.role
    && actual.participantId === expected.participantId
    && actual.peerId === expected.peerId
    && actual.protocolSession === expected.protocolSession;
}

function decodeControlHandshake(data: unknown): GameProtocolBinding {
  const size = inboundDataSize(data);
  if (size === null || size > MAX_CONTROL_HANDSHAKE_BYTES) {
    throw new Error('Invalid control handshake size');
  }
  let encoded: Uint8Array;
  if (typeof data === 'string') {
    encoded = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
    encoded = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    encoded = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw new Error('Invalid control handshake payload');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded));
  } catch {
    throw new Error('Invalid control handshake encoding');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid control handshake');
  }
  const envelope = parsed as Record<string, unknown>;
  if (Object.keys(envelope).length !== 2
    || envelope.type !== CONTROL_HANDSHAKE_TYPE
    || !Object.prototype.hasOwnProperty.call(envelope, 'binding')) {
    throw new Error('Invalid control handshake');
  }
  return validateProtocolBinding(envelope.binding, 'remote protocol binding');
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(value == null ? fallback : String(value));
}

function statsValues(report: RTCStatsReport | Map<string, unknown>): unknown[] {
  const values: unknown[] = [];
  if (!report) return values;
  if (typeof report.forEach === 'function') {
    report.forEach((value) => values.push(value));
    return values;
  }
  if (report && typeof (report as unknown as Iterable<unknown>)[Symbol.iterator] === 'function') {
    for (const value of report as unknown as Iterable<unknown>) values.push(value);
    return values;
  }
  if (report && typeof report === 'object') {
    values.push(...Object.values(report as unknown as Record<string, unknown>));
  }
  return values;
}

function statString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function statBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function statRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function candidateTypeFromStat(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  const candidateType = record.candidateType;
  if (typeof candidateType === 'string') return candidateType.toLowerCase();
  const candidate = record.candidate;
  if (typeof candidate === 'string') return iceCandidateType(candidate);
  return null;
}

function candidateTypeFromPair(
  pair: Record<string, unknown>,
  candidate: Record<string, unknown> | null,
  key: 'localCandidateType' | 'remoteCandidateType',
): string | null {
  return candidateTypeFromStat(candidate)
    ?? (typeof pair[key] === 'string' ? String(pair[key]).toLowerCase() : null);
}

function defaultPeerConnectionFactory(configuration: RTCConfiguration): PeerConnectionLike {
  const browserGlobals = globalThis as typeof globalThis & {
    RTCPeerConnection?: new (configuration: RTCConfiguration) => PeerConnectionLike;
  };
  if (!browserGlobals.RTCPeerConnection) {
    throw new Error('RTCPeerConnection is unavailable in this environment');
  }
  return new browserGlobals.RTCPeerConnection(configuration) as PeerConnectionLike;
}

/** Native WebRTC connection for exactly one host and one guest. */
export class GameConnection {
  private readonly role: GameConnectionRole;
  private readonly peer: PeerConnectionLike;
  private readonly timer: GameConnectionTimer;
  private readonly signalHandler?: (message: SignalMessage) => void | Promise<void>;
  private readonly messageHandler?: (message: GameMessage) => void;
  private readonly dataHandler?: (message: GameMessage) => void;
  private readonly stateHandler?: (state: GameConnectionState) => void;
  private readonly errorHandler?: (error: Error) => void;
  private readonly candidatePairHandler?: (diagnostics: CandidatePairDiagnostics) => void;
  private readonly connectionTimeoutMs: number;
  private readonly protocolBinding?: GameProtocolBinding;
  private readonly expectedRemoteProtocolBinding?: GameProtocolBinding;
  private readonly channels = new Map<GameChannelLabel, GameDataChannel>();
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private readonly configuration: RTCConfiguration;
  private candidatePair: CandidatePairDiagnostics | null = null;
  private candidatePairInspectionPending = false;
  private timeoutHandle: unknown = null;
  private signalingChain: Promise<void> = Promise.resolve();
  private negotiationChain: Promise<void> = Promise.resolve();
  private started = false;
  private remoteDescriptionSet = false;
  private awaitingAnswer = false;
  private restartAttempted = false;
  private latestSnapshotSequence: number | null = null;
  private _state: GameConnectionState = 'new';
  private _error: Error | null = null;
  private peerClosed = false;
  private protocolHandshakeSent = false;
  private protocolHandshakeReceived = false;

  readonly iceConfiguration: RTCConfiguration;

  constructor(options: GameConnectionOptions);
  constructor(role: GameConnectionRole, factory?: PeerConnectionFactory);
  constructor(role: GameConnectionRole, options?: ConnectionOptionsWithoutRole);
  constructor(
    roleOrOptions: GameConnectionRole | GameConnectionOptions,
    factoryOrOptions?: PeerConnectionFactory | ConnectionOptionsWithoutRole,
  ) {
    const options = typeof roleOrOptions === 'string'
      ? {
          ...(typeof factoryOrOptions === 'function' ? {} : factoryOrOptions),
          role: roleOrOptions,
          ...(typeof factoryOrOptions === 'function'
            ? { peerConnectionFactory: factoryOrOptions }
            : {}),
        }
      : roleOrOptions;

    this.role = options.role;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    if (!Number.isFinite(this.connectionTimeoutMs) || this.connectionTimeoutMs <= 0) {
      throw new Error('connectionTimeoutMs must be a positive finite number');
    }
    this.timer = options.timer ?? DEFAULT_TIMER;
    this.signalHandler = options.onSignal ?? options.sendSignal;
    this.messageHandler = options.onMessage;
    this.dataHandler = options.onData;
    this.stateHandler = options.onStateChange;
    this.errorHandler = options.onError;
    this.candidatePairHandler = options.onCandidatePair;

    if ((options.protocolBinding === undefined) !== (options.expectedRemoteProtocolBinding === undefined)) {
      throw new Error('Both local and remote protocol bindings are required');
    }
    if (options.protocolBinding && options.expectedRemoteProtocolBinding) {
      const local = validateProtocolBinding(options.protocolBinding, 'local protocol binding');
      const remote = validateProtocolBinding(options.expectedRemoteProtocolBinding, 'remote protocol binding');
      if (local.role !== this.role || remote.role === this.role
        || local.protocolVersion !== remote.protocolVersion
        || local.buildId !== remote.buildId
        || local.roomId !== remote.roomId
        || local.participantId === remote.participantId
        || local.peerId === remote.peerId) {
        throw new Error('Incompatible protocol bindings');
      }
      this.protocolBinding = local;
      this.expectedRemoteProtocolBinding = remote;
    }

    this.configuration = createIceConfiguration();
    assertStunOnlyConfiguration(this.configuration);
    this.iceConfiguration = this.configuration;

    const factory = options.peerConnectionFactory ?? options.createPeerConnection
      ?? defaultPeerConnectionFactory;
    const peer = options.peerConnection ?? factory(this.configuration);
    if (!peer) throw new Error('Peer connection factory returned no connection');
    try {
      assertStunOnlyConfiguration(this.configuration);
    } catch (error) {
      try {
        peer.close();
      } catch {
        // A factory that mutated the config may also return a partial peer.
      }
      throw error;
    }
    this.peer = peer;
    this.bindPeerEvents();
  }

  get state(): GameConnectionState {
    return this._state;
  }

  get status(): GameConnectionState {
    return this._state;
  }

  get error(): Error | null {
    return this._error;
  }

  get isConnected(): boolean {
    return this._state === 'connected';
  }

  get allChannelsOpen(): boolean {
    return REQUIRED_CHANNEL_LABELS.every((label) => this.channels.get(label)?.readyState === 'open');
  }

  get requiredChannelsOpen(): boolean {
    return this.allChannelsOpen;
  }

  channel(label: GameChannelLabel): GameDataChannel | null {
    return this.channels.get(label) ?? null;
  }

  get peerConnection(): PeerConnectionLike {
    return this.peer;
  }

  get selectedCandidatePair(): CandidatePairDiagnostics | null {
    return this.candidatePair;
  }

  /** Begin signaling; the host emits the initial offer. */
  async start(): Promise<void> {
    if (this.started) return;
    this.ensureActive();
    this.started = true;
    this.setState('signaling');
    this.armConnectionTimeout();

    if (this.role === 'host') {
      try {
        for (const label of REQUIRED_CHANNEL_LABELS) {
          const channel = this.peer.createDataChannel(label, optionsFor(label));
          this.attachChannel(label, channel);
        }
        await this.enqueueNegotiation(() => this.createAndPublishOffer(false));
      } catch (error) {
        const failure = asError(error, 'Unable to create the host offer');
        this.fail(failure);
        throw failure;
      }
    }
  }

  /** Alias used by lobby code that calls the operation connect(). */
  async connect(): Promise<void> {
    await this.start();
  }

  /** Apply one reliable offer/answer/candidate signaling message. */
  async handleSignal(message: SignalMessage): Promise<void> {
    this.ensureActive();
    if (!this.started) {
      if (this.role !== 'guest' || message.type !== 'offer') {
        throw new Error('The connection must be started before this signal');
      }
      await this.start();
    }
    return this.enqueueSignaling(async () => {
      try {
        await this.applySignal(message);
      } catch (error) {
        const failure = asError(error, 'WebRTC signaling failed');
        this.fail(failure);
        throw failure;
      }
    });
  }

  async acceptSignal(message: SignalMessage): Promise<void> {
    await this.handleSignal(message);
  }

  async receiveSignal(message: SignalMessage): Promise<void> {
    await this.handleSignal(message);
  }

  /** Return diagnostics for the browser's currently selected ICE pair. */
  async getSelectedCandidatePairDiagnostics(): Promise<CandidatePairDiagnostics | null> {
    if (!this.peer.getStats) return null;
    const report = await this.peer.getStats();
    const values = statsValues(report);
    const records = values.map(statRecord).filter((value): value is Record<string, unknown> => value !== null);
    const byId = new Map<string, Record<string, unknown>>();
    for (const record of records) {
      const id = statString(record, 'id');
      if (id) byId.set(id, record);
    }

    const pairs = records.filter((record) => record.type === 'candidate-pair');
    const pair = pairs.find((record) => statBoolean(record, 'selected'))
      ?? pairs.find((record) => statBoolean(record, 'nominated'))
      ?? pairs.find((record) => record.state === 'succeeded');
    if (!pair) return null;

    const localId = statString(pair, 'localCandidateId');
    const remoteId = statString(pair, 'remoteCandidateId');
    const local = localId ? byId.get(localId) ?? null : null;
    const remote = remoteId ? byId.get(remoteId) ?? null : null;
    const diagnostics: CandidatePairDiagnostics = {
      id: statString(pair, 'id') ?? 'selected-candidate-pair',
      state: statString(pair, 'state'),
      nominated: statBoolean(pair, 'nominated'),
      selected: statBoolean(pair, 'selected'),
      protocol: statString(pair, 'protocol'),
      localCandidateId: localId,
      remoteCandidateId: remoteId,
      localCandidateType: candidateTypeFromPair(pair, local, 'localCandidateType'),
      remoteCandidateType: candidateTypeFromPair(pair, remote, 'remoteCandidateType'),
    };

    this.candidatePair = diagnostics;
    if (diagnostics.localCandidateType === 'relay' || diagnostics.remoteCandidateType === 'relay') {
      const failure = new Error('Relay ICE candidate pair is not allowed');
      this.fail(failure);
      throw failure;
    }
    this.candidatePairHandler?.(diagnostics);
    return diagnostics;
  }

  async inspectCandidatePair(): Promise<CandidatePairDiagnostics | null> {
    return this.getSelectedCandidatePairDiagnostics();
  }

  async getCandidatePairDiagnostics(): Promise<CandidatePairDiagnostics | null> {
    return this.getSelectedCandidatePairDiagnostics();
  }

  /** Send on a channel without creating an application-level queue. */
  send(channel: GameChannelLabel, data: GamePayload): boolean {
    if (this._state === 'failed' || this._state === 'closed' || this._state === 'disposed') return false;
    if (this.protocolBinding && this._state !== 'connected') return false;
    const dataChannel = this.channels.get(channel);
    if (!dataChannel || dataChannel.readyState !== 'open') return false;

    const buffered = Number.isFinite(dataChannel.bufferedAmount) ? dataChannel.bufferedAmount : 0;
    const size = dataSize(data);
    const lossy = !RELIABLE_CHANNELS.has(channel);
    const limit = lossy ? BUFFERED_AMOUNT_LOW_THRESHOLD : MAX_BUFFERED_AMOUNT;
    if (buffered >= limit || buffered + size > limit) return false;

    try {
      dataChannel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  sendControl(data: GamePayload): boolean {
    return this.send('control', data);
  }

  sendEvent(data: GamePayload): boolean {
    return this.send('event', data);
  }

  sendInput(data: GamePayload): boolean {
    return this.send('input', data);
  }

  /**
   * Snapshots are lossy.  An optional monotonic sequence lets callers avoid
   * sending an older state after a newer state has already been attempted.
   */
  sendSnapshot(data: GamePayload, sequence?: number): boolean {
    if (sequence !== undefined) {
      if (!Number.isFinite(sequence)) return false;
      if (this.latestSnapshotSequence !== null && sequence <= this.latestSnapshotSequence) return false;
      this.latestSnapshotSequence = sequence;
    }
    return this.send('snapshot', data);
  }

  /** Close channels, peer, timers, and event handlers exactly once. */
  dispose(): void {
    if (this._state === 'disposed') return;
    this.clearConnectionTimeout();
    this.pendingCandidates.length = 0;
    this.detachPeerEvents();
    this.closeChannels();
    this.closePeer();
    this.setState('disposed');
  }

  close(): void {
    this.dispose();
  }

  private bindPeerEvents(): void {
    this.peer.onicecandidate = (event) => this.handleLocalCandidate(event.candidate);
    this.peer.onconnectionstatechange = () => this.handlePeerState();
    this.peer.oniceconnectionstatechange = () => this.handlePeerState();
    this.peer.ondatachannel = (event) => this.handleIncomingChannel(event.channel);
  }

  private detachPeerEvents(): void {
    this.peer.onicecandidate = null;
    this.peer.onconnectionstatechange = null;
    this.peer.oniceconnectionstatechange = null;
    this.peer.ondatachannel = null;
  }

  private handleLocalCandidate(candidate: RTCIceCandidate | null): void {
    if (this._state === 'failed' || this._state === 'closed' || this._state === 'disposed') return;
    if (!candidate) return;
    if (isRelayIceCandidate(candidate)) {
      this.fail(new Error('Relay ICE candidate is not allowed'));
      return;
    }
    const message: CandidateSignal = {
      type: 'candidate',
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      },
    };
    this.emitSignal(message);
  }

  private handlePeerState(): void {
    if (this._state === 'failed' || this._state === 'disposed' || this._state === 'closed') return;
    const peerState = this.peer.connectionState;
    const iceState = this.peer.iceConnectionState;
    if (peerState === 'failed' || iceState === 'failed') {
      this.attemptIceRestart('WebRTC connection failed');
      return;
    }
    if (peerState === 'closed' || iceState === 'closed') {
      this.closeConnection();
      return;
    }
    if (peerState === 'connected' || iceState === 'connected' || iceState === 'completed') {
      this.inspectCandidatePairInBackground();
      this.maybeConnected();
    }
  }

  private handleIncomingChannel(channel: GameDataChannel): void {
    if (this.role !== 'guest') {
      this.rejectIncomingChannel(channel, 'Host must create the required channels');
      return;
    }
    const label = channel.label;
    if (!isGameChannelLabel(label)) {
      this.rejectIncomingChannel(channel, `Unknown data channel: ${label}`);
      return;
    }
    if (this.channels.has(label) || !this.matchesChannelContract(label, channel)) {
      this.rejectIncomingChannel(channel, `Invalid data channel contract: ${label}`);
      return;
    }
    this.attachChannel(label, channel);
  }

  private rejectIncomingChannel(channel: GameDataChannel, reason: string): void {
    try {
      channel.close();
    } catch {
      // A malformed channel can still be rejected when close itself fails.
    }
    this.fail(new Error(reason));
  }

  private matchesChannelContract(label: GameChannelLabel, channel: GameDataChannel): boolean {
    const expected = DATA_CHANNEL_OPTIONS[label];
    if (channel.ordered !== expected.ordered) return false;
    const expectedRetransmits = expected.maxRetransmits;
    const actualRetransmits = channel.maxRetransmits;
    if (expectedRetransmits === undefined) {
      if (actualRetransmits !== null && actualRetransmits !== undefined) return false;
    } else if (actualRetransmits !== expectedRetransmits) {
      return false;
    }
    if (channel.maxPacketLifeTime !== null && channel.maxPacketLifeTime !== undefined) return false;
    return true;
  }

  private attachChannel(label: GameChannelLabel, channel: GameDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
    channel.onopen = () => this.handleChannelOpen(label);
    channel.onclose = () => this.handleChannelClosed();
    channel.onerror = () => this.handleChannelError(label);
    channel.onmessage = (event) => this.handleMessage(label, event.data);
    this.channels.set(label, channel);
    if (channel.readyState === 'open') this.handleChannelOpen(label);
  }

  private handleMessage(label: GameChannelLabel, data: unknown): void {
    if (this._state === 'failed' || this._state === 'closed' || this._state === 'disposed') return;
    const size = inboundDataSize(data);
    if (size === null || size > MAX_INBOUND_CHANNEL_MESSAGE_BYTES) {
      this.fail(new Error(`Invalid or oversized data-channel message: ${label}`));
      return;
    }
    if (this.expectedRemoteProtocolBinding && !this.protocolHandshakeReceived) {
      if (label !== 'control') {
        this.fail(new Error('Application data arrived before the control handshake'));
        return;
      }
      try {
        const binding = decodeControlHandshake(data);
        if (!protocolBindingsMatch(binding, this.expectedRemoteProtocolBinding)) {
          throw new Error('Control handshake identity does not match admission');
        }
        this.protocolHandshakeReceived = true;
        this.maybeConnected();
      } catch (error) {
        this.fail(asError(error, 'Invalid control handshake'));
      }
      return;
    }
    const message: GameMessage = { channel: label, data };
    this.messageHandler?.(message);
    this.dataHandler?.(message);
  }

  private handleChannelOpen(label: GameChannelLabel): void {
    if (label === 'control') this.sendControlHandshake();
    this.maybeConnected();
  }

  private sendControlHandshake(): void {
    if (!this.protocolBinding || this.protocolHandshakeSent) return;
    const channel = this.channels.get('control');
    if (!channel || channel.readyState !== 'open') return;
    try {
      const encoded = JSON.stringify({ type: CONTROL_HANDSHAKE_TYPE, binding: this.protocolBinding });
      if (dataSize(encoded) > MAX_CONTROL_HANDSHAKE_BYTES) {
        throw new Error('Local control handshake is too large');
      }
      channel.send(encoded);
      this.protocolHandshakeSent = true;
    } catch (error) {
      this.fail(asError(error, 'Unable to send the control handshake'));
    }
  }

  private handleChannelClosed(): void {
    if (this._state === 'failed' || this._state === 'disposed') return;
    this.closeConnection();
  }

  private handleChannelError(label: GameChannelLabel): void {
    if (this._state === 'failed' || this._state === 'disposed') return;
    this.fail(new Error(`Data channel failed: ${label}`));
  }

  private maybeConnected(): void {
    if (this._state === 'failed' || this._state === 'disposed' || this._state === 'closed') return;
    if (!this.allChannelsOpen) return;
    if (this.protocolBinding && (!this.protocolHandshakeSent || !this.protocolHandshakeReceived)) return;
    this.clearConnectionTimeout();
    this.setState('connected');
    this.inspectCandidatePairInBackground();
  }

  private inspectCandidatePairInBackground(): void {
    if (!this.peer.getStats || this.candidatePairInspectionPending
      || this._state === 'failed' || this._state === 'disposed' || this._state === 'closed') return;
    this.candidatePairInspectionPending = true;
    void this.getSelectedCandidatePairDiagnostics()
      .catch((error) => {
        this.fail(asError(error, 'Unable to inspect the selected ICE pair'));
      })
      .finally(() => {
        this.candidatePairInspectionPending = false;
      });
  }

  private async applySignal(message: SignalMessage): Promise<void> {
    switch (message.type) {
      case 'offer':
        await this.applyOffer(message);
        return;
      case 'answer': {
        if (!this.awaitingAnswer) throw new Error('Unexpected or duplicate answer');
        const description = normalizeDescription('answer', message.sdp);
        assertNoRelayDescription(description);
        await this.peer.setRemoteDescription(description);
        this.remoteDescriptionSet = true;
        this.awaitingAnswer = false;
        await this.flushPendingCandidates();
        if (this._state !== 'connected') this.setState('connecting');
        return;
      }
      case 'candidate':
        await this.applyCandidate(message);
        return;
      default:
        throw new Error('Unknown WebRTC signaling message');
    }
  }

  private async applyOffer(message: OfferSignal): Promise<void> {
    const isRestart = this.remoteDescriptionSet;
    if (this.role === 'host' && !isRestart) {
      throw new Error('Host cannot accept an initial offer');
    }
    const description = normalizeDescription('offer', message.sdp);
    assertNoRelayDescription(description);
    await this.peer.setRemoteDescription(description);
    this.remoteDescriptionSet = true;
    await this.flushPendingCandidates();
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    this.emitSessionDescription('answer', this.peer.localDescription ?? answer);
    if (this._state !== 'connected') this.setState(isRestart ? 'restarting' : 'connecting');
  }

  private async applyCandidate(message: CandidateSignal): Promise<void> {
    if (isRelayIceCandidate(message.candidate)) {
      throw new Error('Relay ICE candidate is not allowed');
    }
    const candidate = normalizeCandidate(message.candidate);
    if (isRelayIceCandidate(candidate)) {
      throw new Error('Relay ICE candidate is not allowed');
    }
    if (!this.remoteDescriptionSet) {
      if (this.pendingCandidates.length >= MAX_PENDING_SIGNAL_CANDIDATES) {
        throw new Error('Too many ICE candidates before the remote description');
      }
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.peer.addIceCandidate(candidate);
  }

  private async flushPendingCandidates(): Promise<void> {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (!candidate) continue;
      await this.peer.addIceCandidate(candidate);
    }
  }

  private async createAndPublishOffer(iceRestart: boolean): Promise<void> {
    if (iceRestart) {
      this.setState('restarting');
      this.peer.restartIce?.();
    } else if (this._state !== 'connected') {
      this.setState('connecting');
    }
    const offer = await this.peer.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await this.peer.setLocalDescription(offer);
    this.awaitingAnswer = true;
    this.emitSessionDescription('offer', this.peer.localDescription ?? offer);
    this.armConnectionTimeout();
  }

  private emitSessionDescription(
    type: 'offer' | 'answer',
    description: RTCSessionDescriptionInit | RTCSessionDescription,
  ): void {
    if (typeof description.sdp === 'string' && isRelayIceCandidate(description.sdp)) {
      this.fail(new Error('Relay ICE candidate is not allowed'));
      return;
    }
    const message: OfferSignal | AnswerSignal = {
      type,
      sdp: description.sdp ?? '',
    };
    this.emitSignal(message);
  }

  private emitSignal(message: SignalMessage): void {
    if (!this.signalHandler || this._state === 'failed' || this._state === 'closed' || this._state === 'disposed') return;
    try {
      const result = this.signalHandler(message);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch((error) => this.fail(asError(error, 'Signaling callback failed')));
      }
    } catch (error) {
      this.fail(asError(error, 'Signaling callback failed'));
    }
  }

  private enqueueSignaling(operation: () => Promise<void>): Promise<void> {
    const next = this.signalingChain.then(operation, operation);
    this.signalingChain = next.catch(() => undefined);
    return next;
  }

  private enqueueNegotiation(operation: () => Promise<void>): Promise<void> {
    const next = this.negotiationChain.then(operation, operation);
    this.negotiationChain = next.catch(() => undefined);
    return next;
  }

  private armConnectionTimeout(): void {
    this.clearConnectionTimeout();
    if (this._state === 'connected' || this._state === 'failed' || this._state === 'disposed') return;
    this.timeoutHandle = this.timer.setTimeout(() => this.handleConnectionTimeout(), this.connectionTimeoutMs);
  }

  private clearConnectionTimeout(): void {
    if (this.timeoutHandle === null) return;
    this.timer.clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
  }

  private handleConnectionTimeout(): void {
    this.timeoutHandle = null;
    if (this._state === 'connected' || this._state === 'failed' || this._state === 'disposed') return;
    if (this.restartAttempted) {
      this.fail(new Error('WebRTC connection timed out after one ICE restart'));
      return;
    }
    this.attemptIceRestart('WebRTC connection timed out');
  }

  private attemptIceRestart(reason: string): void {
    if (this._state === 'failed' || this._state === 'disposed' || this._state === 'closed') return;
    if (this.restartAttempted) {
      this.fail(new Error(`${reason} after one ICE restart`));
      return;
    }
    this.restartAttempted = true;
    void this.enqueueNegotiation(() => this.createAndPublishOffer(true)).catch((error) => {
      this.fail(asError(error, 'ICE restart failed'));
    });
    this.armConnectionTimeout();
  }

  private ensureActive(): void {
    if (this._state === 'failed') throw this._error ?? new Error('WebRTC connection failed');
    if (this._state === 'closed' || this._state === 'disposed') throw new Error('WebRTC connection is closed');
  }

  private setState(state: GameConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    try {
      this.stateHandler?.(state);
    } catch {
      // Observers must not break the transport lifecycle.
    }
  }

  private fail(error: Error): void {
    if (this._state === 'failed' || this._state === 'disposed') return;
    this._error = error;
    this.clearConnectionTimeout();
    this.pendingCandidates.length = 0;
    this.detachPeerEvents();
    this.closeChannels();
    this.closePeer();
    this.setState('failed');
    try {
      this.errorHandler?.(error);
    } catch {
      // Error observers cannot change the already-failed lifecycle.
    }
  }

  private closeConnection(): void {
    if (this._state === 'closed' || this._state === 'failed' || this._state === 'disposed') return;
    this.clearConnectionTimeout();
    this.pendingCandidates.length = 0;
    this.detachPeerEvents();
    this.closeChannels();
    this.closePeer();
    this.setState('closed');
  }

  private closePeer(): void {
    if (this.peerClosed) return;
    this.peerClosed = true;
    try {
      this.peer.close();
    } catch {
      // Closing is best effort; the lifecycle state remains authoritative.
    }
  }

  private closeChannels(): void {
    for (const channel of this.channels.values()) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // A closed or malformed channel should not prevent other channels.
      }
    }
    this.channels.clear();
  }
}

export function createHostGameConnection(options: ConnectionOptionsWithoutRole = {}): GameConnection {
  return new GameConnection({ ...options, role: 'host' });
}

export function createGuestGameConnection(options: ConnectionOptionsWithoutRole = {}): GameConnection {
  return new GameConnection({ ...options, role: 'guest' });
}

export function createGameConnection(
  role: GameConnectionRole,
  options: ConnectionOptionsWithoutRole = {},
): GameConnection {
  return new GameConnection({ ...options, role });
}

export type GameConnectionSignal = SignalMessage;
