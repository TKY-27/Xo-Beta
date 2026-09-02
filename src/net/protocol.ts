import type { Difficulty } from '../core/balance';
import type { SkinId } from '../core/settings';
import {
  VALID_SKIN_IDS,
  type MatchMode,
  type TeamId,
} from '../sim/roster';
import type { MapId } from '../world/index';

/**
 * The lobby protocol deliberately has a small, closed vocabulary.  Match
 * simulation messages are a later phase; accepting them here would make it
 * too easy for an untrusted peer to smuggle a second authority into the
 * lobby.
 */
/**
 * Bumped to 2 by the v0.4 world-fidelity program: stair flights gained
 * movement-ramp/step collider semantics and rocks gained measured compound
 * colliders that now participate in the gameplay map hash. Peers on different
 * protocol versions must refuse to interop rather than silently disagreeing
 * about solid geometry.
 */
export const PROTOCOL_VERSION = 2 as const;
export const PROTOCOL_MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_PROTOCOL_PAYLOAD_BYTES = PROTOCOL_MAX_PAYLOAD_BYTES;
export const MAX_DISPLAY_NAME_LENGTH = 24;

export const PROTOCOL_FEATURES = Object.freeze([
  'lobby-v1',
  'reconnect-v1',
] as const);
export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[number];

export type HandshakeRole = 'host' | 'participant';

export interface BuildIdentity {
  readonly protocolVersion: number;
  readonly buildId: string;
  readonly features: readonly ProtocolFeature[];
}

/** Alias retained because callers commonly call this a build descriptor. */
export type BuildInfo = BuildIdentity;

export interface Handshake {
  readonly type: 'handshake';
  readonly protocolVersion: number;
  readonly buildId: string;
  readonly features: readonly ProtocolFeature[];
  readonly roomId: string;
  readonly peerId: string;
  readonly participantId: string;
  readonly role: HandshakeRole;
  readonly protocolSession: string;
  readonly nonce: string;
}

export interface HandshakeInput {
  readonly roomId: string;
  readonly peerId: string;
  readonly participantId: string;
  readonly role: HandshakeRole;
  readonly protocolSession?: string;
  readonly nonce?: string;
  readonly build?: Partial<BuildIdentity> & {
    readonly protocolVersion: number;
    readonly buildId: string;
    readonly features: readonly ProtocolFeature[];
  };
  /** Convenience form for callers that already hold the build fields. */
  readonly protocolVersion?: number;
  readonly buildId?: string;
  readonly features?: readonly ProtocolFeature[];
}

export interface HandshakeValidationOptions {
  readonly expectedRoomId?: string;
  readonly expectedPeerId?: string;
  readonly expectedHostPeerId?: string;
  readonly expectedProtocolVersion?: number;
  readonly expectedBuildId?: string;
  readonly expectedFeatures?: readonly ProtocolFeature[];
  readonly expectedProtocolSession?: string;
}

export type LobbyCommandType =
  | 'set-display-name'
  | 'set-skin'
  | 'set-ready'
  | 'set-map'
  | 'set-mode'
  | 'set-bot-fill'
  | 'set-difficulty'
  | 'set-team'
  | 'start-request';

export interface MessageBase {
  readonly protocolVersion: number;
  readonly protocolSession: string;
  readonly senderPeerId: string;
  readonly nonce: string;
}

export interface SetDisplayNameMessage extends MessageBase {
  readonly type: 'set-display-name';
  readonly displayName: string;
}

export interface SetSkinMessage extends MessageBase {
  readonly type: 'set-skin';
  readonly skinId: SkinId;
}

export interface SetReadyMessage extends MessageBase {
  readonly type: 'set-ready';
  readonly ready: boolean;
}

export interface SetMapMessage extends MessageBase {
  readonly type: 'set-map';
  readonly mapId: MapId;
}

export interface SetModeMessage extends MessageBase {
  readonly type: 'set-mode';
  readonly mode: MatchMode;
}

export interface SetBotFillMessage extends MessageBase {
  readonly type: 'set-bot-fill';
  readonly botFill: boolean;
}

export interface SetDifficultyMessage extends MessageBase {
  readonly type: 'set-difficulty';
  readonly difficulty: Difficulty;
}

export interface SetTeamMessage extends MessageBase {
  readonly type: 'set-team';
  readonly participantId: string;
  readonly teamId: TeamId | null;
}

export interface StartRequestMessage extends MessageBase {
  readonly type: 'start-request';
}

export type LobbyCommandMessage =
  | SetDisplayNameMessage
  | SetSkinMessage
  | SetReadyMessage
  | SetMapMessage
  | SetModeMessage
  | SetBotFillMessage
  | SetDifficultyMessage
  | SetTeamMessage
  | StartRequestMessage;

export type ProtocolMessage = Handshake | LobbyCommandMessage;

export class ProtocolValidationError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolValidationError';
    this.code = code;
  }
}

export type ProtocolErrorCode =
  | 'invalid-payload'
  | 'payload-too-large'
  | 'unsupported-protocol'
  | 'build-mismatch'
  | 'feature-mismatch'
  | 'replay'
  | 'rate-limited'
  | 'unauthorized';

const MAP_IDS: readonly MapId[] = Object.freeze(['neocity', 'oldfront', 'eden', 'ashara']);
const MODES: readonly MatchMode[] = Object.freeze([
  'ffa-bot-fill',
  'ffa',
  'teams',
  'teams-bot-fill',
  'humans-vs-bots',
]);
const DIFFICULTIES: readonly Difficulty[] = Object.freeze(['normal', 'hard', 'elite', 'nightmare']);
const COMMAND_TYPES: readonly LobbyCommandType[] = Object.freeze([
  'set-display-name',
  'set-skin',
  'set-ready',
  'set-map',
  'set-mode',
  'set-bot-fill',
  'set-difficulty',
  'set-team',
  'start-request',
]);

/** Return a copy with canonical feature ordering and no mutable array leaks. */
export function normalizeBuildIdentity(build: BuildIdentity): BuildIdentity {
  assertBuildIdentity(build);
  const features = [...build.features].sort(
    (a, b) => PROTOCOL_FEATURES.indexOf(a) - PROTOCOL_FEATURES.indexOf(b),
  );
  return Object.freeze({
    protocolVersion: build.protocolVersion,
    buildId: build.buildId,
    features: Object.freeze(features),
  });
}

export function buildHandshake(input: HandshakeInput, random = defaultRandomId): Handshake {
  const build = input.build ?? {
    protocolVersion: input.protocolVersion,
    buildId: input.buildId,
    features: input.features,
  };
  if (!build || typeof build.protocolVersion !== 'number' || typeof build.buildId !== 'string'
    || !Array.isArray(build.features)) {
    throw invalid('Handshake requires a complete build identity');
  }
  const identity = normalizeBuildIdentity({
    protocolVersion: build.protocolVersion,
    buildId: build.buildId,
    features: build.features,
  });
  const handshake: Handshake = {
    type: 'handshake',
    protocolVersion: identity.protocolVersion,
    buildId: identity.buildId,
    features: identity.features,
    roomId: validateIdentifier(input.roomId, 'roomId'),
    peerId: validateIdentifier(input.peerId, 'peerId'),
    participantId: validateIdentifier(input.participantId, 'participantId'),
    role: validateEnum(input.role, ['host', 'participant'] as const, 'role'),
    protocolSession: input.protocolSession === undefined
      ? random()
      : validateIdentifier(input.protocolSession, 'protocolSession'),
    nonce: input.nonce === undefined ? random() : validateNonce(input.nonce),
  };
  return Object.freeze({ ...handshake, features: Object.freeze([...handshake.features]) });
}

/** Strictly validate a decoded handshake and optionally bind it to a room/build. */
export function validateHandshake(
  value: unknown,
  options: HandshakeValidationOptions = {},
): Handshake {
  assertPayloadSize(value);
  const object = requireRecord(value, 'handshake');
  assertExactKeys(object, [
    'type',
    'protocolVersion',
    'buildId',
    'features',
    'roomId',
    'peerId',
    'participantId',
    'role',
    'protocolSession',
    'nonce',
  ]);
  if (object.type !== 'handshake') throw invalid('Invalid handshake type');
  if (object.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      'unsupported-protocol',
      `Unsupported protocol version: ${String(object.protocolVersion)}`,
    );
  }
  const features = validateFeatures(object.features);
  const handshake: Handshake = Object.freeze({
    type: 'handshake',
    protocolVersion: validateInteger(object.protocolVersion, 'protocolVersion'),
    buildId: validateIdentifier(object.buildId, 'buildId'),
    features,
    roomId: validateIdentifier(object.roomId, 'roomId'),
    peerId: validateIdentifier(object.peerId, 'peerId'),
    participantId: validateIdentifier(object.participantId, 'participantId'),
    role: validateEnum(object.role, ['host', 'participant'] as const, 'role'),
    protocolSession: validateIdentifier(object.protocolSession, 'protocolSession'),
    nonce: validateNonce(object.nonce),
  });

  if (options.expectedRoomId !== undefined && handshake.roomId !== options.expectedRoomId) {
    throw invalid('Handshake room does not match the requested room');
  }
  if (options.expectedPeerId !== undefined && handshake.peerId !== options.expectedPeerId) {
    throw invalid('Handshake peer does not match the connected peer');
  }
  if (options.expectedHostPeerId !== undefined
    && handshake.role === 'host'
    && handshake.peerId !== options.expectedHostPeerId) {
    throw new ProtocolValidationError('unauthorized', 'Only the established host may claim host role');
  }
  if (options.expectedProtocolVersion !== undefined
    && handshake.protocolVersion !== options.expectedProtocolVersion) {
    throw new ProtocolValidationError('unsupported-protocol', 'Protocol version mismatch');
  }
  if (options.expectedBuildId !== undefined && handshake.buildId !== options.expectedBuildId) {
    throw new ProtocolValidationError('build-mismatch', 'Build identity mismatch');
  }
  if (options.expectedFeatures !== undefined && !sameFeatures(handshake.features, options.expectedFeatures)) {
    throw new ProtocolValidationError('feature-mismatch', 'Feature flag mismatch');
  }
  if (options.expectedProtocolSession !== undefined
    && handshake.protocolSession !== options.expectedProtocolSession) {
    throw invalid('Protocol session is stale');
  }
  return handshake;
}

/** Compare all build fields that affect wire compatibility. */
export function buildsMatch(a: BuildIdentity, b: BuildIdentity): boolean {
  try {
    const left = normalizeBuildIdentity(a);
    const right = normalizeBuildIdentity(b);
    return left.protocolVersion === right.protocolVersion
      && left.buildId === right.buildId
      && sameFeatures(left.features, right.features);
  } catch {
    return false;
  }
}

export function assertBuildMatch(expected: BuildIdentity, actual: BuildIdentity): void {
  if (expected.protocolVersion !== actual.protocolVersion) {
    throw new ProtocolValidationError('unsupported-protocol', 'Protocol version mismatch');
  }
  if (expected.buildId !== actual.buildId) {
    throw new ProtocolValidationError('build-mismatch', 'Build identity mismatch');
  }
  if (!sameFeatures(expected.features, actual.features)) {
    throw new ProtocolValidationError('feature-mismatch', 'Feature flag mismatch');
  }
}

/** Validate a message object or a JSON string received from a transport. */
export function validateProtocolMessage(value: unknown): ProtocolMessage {
  const object = typeof value === 'string' ? parsePayload(value) : (() => {
    assertPayloadSize(value);
    return requireRecord(value, 'protocol message');
  })();
  if (object.type === 'handshake') return validateHandshake(object);

  assertRecordHasType(object);
  assertExactKeysForCommand(object);
  validateMessageBase(object);
  switch (object.type) {
    case 'set-display-name':
      return Object.freeze({
        ...messageBase(object),
        type: 'set-display-name',
        displayName: validateDisplayName(object.displayName),
      });
    case 'set-skin':
      return Object.freeze({
        ...messageBase(object),
        type: 'set-skin',
        skinId: validateSkin(object.skinId),
      });
    case 'set-ready':
      return Object.freeze({
        ...messageBase(object),
        type: 'set-ready',
        ready: validateBoolean(object.ready, 'ready'),
      });
    case 'set-map':
      return Object.freeze({
        ...messageBase(object),
        type: 'set-map',
        mapId: validateEnum(object.mapId, MAP_IDS, 'mapId'),
      });
    case 'set-mode':
      return Object.freeze({
        ...messageBase(object),
        type: 'set-mode',
        mode: validateEnum(object.mode, MODES, 'mode'),
      });
    case 'set-bot-fill':
      return Object.freeze({
        ...messageBase(object),
        type: 'set-bot-fill',
        botFill: validateBoolean(object.botFill, 'botFill'),
      });
    case 'set-difficulty':
      return Object.freeze({
        ...messageBase(object),
        type: 'set-difficulty',
        difficulty: validateEnum(object.difficulty, DIFFICULTIES, 'difficulty'),
      });
    case 'set-team':
      return Object.freeze({
        ...messageBase(object),
        type: 'set-team',
        participantId: validateIdentifier(object.participantId, 'participantId'),
        teamId: validateTeamId(object.teamId),
      });
    case 'start-request':
      return Object.freeze({ ...messageBase(object), type: 'start-request' });
  }
  throw invalid('Unknown protocol message type');
}

/** JSON serialization is kept in one place so every send path gets the size gate. */
export function encodeProtocolMessage(value: unknown): string {
  const message = validateProtocolMessage(value);
  let encoded: string;
  try {
    encoded = JSON.stringify(message);
  } catch {
    throw invalid('Protocol payload is not serializable');
  }
  assertPayloadSize(encoded);
  return encoded;
}

export const encodeMessage = encodeProtocolMessage;

export function decodeProtocolMessage(value: string): ProtocolMessage {
  return validateProtocolMessage(value);
}

export const decodeMessage = decodeProtocolMessage;

export interface PeerRateLimiterOptions {
  /** Maximum burst size. Defaults to 30 messages. */
  readonly capacity?: number;
  /** Tokens refilled per second. Defaults to 10. */
  readonly refillPerSecond?: number;
  /** Alternative fixed-window vocabulary for callers/tests. */
  readonly maxMessages?: number;
  readonly windowMs?: number;
  /** Maximum number of peer identities retained at once. */
  readonly maxPeers?: number;
  /** Idle peer state is discarded after this interval. */
  readonly peerTtlMs?: number;
  readonly now?: () => number;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** A small per-peer token bucket. It never relies on transport ordering. */
export class PeerRateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly maxPeers: number;
  private readonly peerTtlMs: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: PeerRateLimiterOptions = {}) {
    const capacity = options.capacity ?? options.maxMessages ?? 30;
    const refillPerSecond = options.refillPerSecond
      ?? (options.maxMessages !== undefined && options.windowMs !== undefined
        ? options.maxMessages / (options.windowMs / 1000)
        : 10);
    if (!Number.isFinite(capacity) || capacity <= 0
      || !Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new RangeError('Rate limiter capacity and refill must be positive finite numbers');
    }
    this.maxPeers = options.maxPeers ?? 64;
    this.peerTtlMs = options.peerTtlMs ?? 5 * 60 * 1000;
    if (!Number.isSafeInteger(this.maxPeers) || this.maxPeers < 1
      || !Number.isFinite(this.peerTtlMs) || this.peerTtlMs <= 0) {
      throw new RangeError('Rate limiter peer bounds must be positive finite values');
    }
    this.capacity = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.now = options.now ?? (() => Date.now());
  }

  allow(peerId: string, cost = 1): boolean {
    if (typeof peerId !== 'string' || peerId.length === 0
      || peerId.length > 128
      || !Number.isFinite(cost) || cost <= 0 || cost > this.capacity) return false;
    const now = this.now();
    if (!Number.isFinite(now)) return false;
    this.prune(now);
    let previous = this.buckets.get(peerId);
    if (!previous) {
      if (this.buckets.size >= this.maxPeers) return false;
      previous = { tokens: this.capacity, at: now };
    }
    const elapsed = Math.max(0, now - previous.at);
    const tokens = Math.min(this.capacity, previous.tokens + elapsed * this.refillPerMs);
    if (tokens < cost) {
      this.buckets.set(peerId, { tokens, at: now });
      return false;
    }
    this.buckets.set(peerId, { tokens: tokens - cost, at: now });
    return true;
  }

  consume(peerId: string, cost = 1): boolean {
    return this.allow(peerId, cost);
  }

  assertAllowed(peerId: string, cost = 1): void {
    if (!this.allow(peerId, cost)) {
      throw new ProtocolValidationError('rate-limited', `Peer is rate limited: ${peerId}`);
    }
  }

  reset(peerId?: string): void {
    if (peerId === undefined) this.buckets.clear();
    else this.buckets.delete(peerId);
  }

  get trackedPeers(): number { return this.buckets.size; }

  private prune(now: number): void {
    for (const [peerId, bucket] of this.buckets) {
      if (now - bucket.at >= this.peerTtlMs) this.buckets.delete(peerId);
    }
  }
}

export const RateLimiter = PeerRateLimiter;

interface NonceSession {
  readonly protocolSession: string;
  readonly nonces: Set<string>;
  lastSeenAt: number;
}

export interface ReplayNonceGuardOptions {
  readonly maxPeers?: number;
  readonly peerTtlMs?: number;
  readonly now?: () => number;
}

/** Reject duplicate nonces and messages from a superseded protocol session. */
export class ReplayNonceGuard {
  private readonly sessions = new Map<string, NonceSession>();
  private readonly maxNonces: number;
  private readonly maxPeers: number;
  private readonly peerTtlMs: number;
  private readonly now: () => number;

  constructor(maxNonces = 2048, options: ReplayNonceGuardOptions = {}) {
    if (!Number.isSafeInteger(maxNonces) || maxNonces < 1) {
      throw new RangeError('maxNonces must be a positive safe integer');
    }
    this.maxNonces = maxNonces;
    this.maxPeers = options.maxPeers ?? 64;
    this.peerTtlMs = options.peerTtlMs ?? 5 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    if (!Number.isSafeInteger(this.maxPeers) || this.maxPeers < 1
      || !Number.isFinite(this.peerTtlMs) || this.peerTtlMs <= 0) {
      throw new RangeError('Replay peer bounds must be positive finite values');
    }
  }

  accept(peerId: string, protocolSession: string, nonce: string): boolean {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 128
      || typeof protocolSession !== 'string' || protocolSession.length === 0 || protocolSession.length > 128
      || typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 256) return false;
    const now = this.now();
    if (!Number.isFinite(now)) return false;
    this.prune(now);
    const current = this.sessions.get(peerId);
    if (current && current.protocolSession !== protocolSession) return false;
    if (!current && this.sessions.size >= this.maxPeers) return false;
    const session = current ?? { protocolSession, nonces: new Set<string>(), lastSeenAt: now };
    if (session.nonces.has(nonce)) return false;
    if (session.nonces.size >= this.maxNonces) return false;
    session.nonces.add(nonce);
    session.lastSeenAt = now;
    this.sessions.set(peerId, session);
    return true;
  }

  check(peerId: string, protocolSession: string, nonce: string): boolean {
    return this.accept(peerId, protocolSession, nonce);
  }

  consume(peerId: string, protocolSession: string, nonce: string): boolean {
    return this.accept(peerId, protocolSession, nonce);
  }

  assertFresh(peerId: string, protocolSession: string, nonce: string): void {
    if (!this.accept(peerId, protocolSession, nonce)) {
      throw new ProtocolValidationError('replay', 'Duplicate or stale protocol nonce');
    }
  }

  reset(peerId?: string): void {
    if (peerId === undefined) this.sessions.clear();
    else this.sessions.delete(peerId);
  }

  get trackedPeers(): number { return this.sessions.size; }

  private prune(now: number): void {
    for (const [peerId, session] of this.sessions) {
      if (now - session.lastSeenAt >= this.peerTtlMs) this.sessions.delete(peerId);
    }
  }
}

export interface ProtocolSessionGuardOptions {
  readonly rateLimiter?: PeerRateLimiter;
  readonly nonceGuard?: ReplayNonceGuard;
}

/** Combined inbound gate used by a host before applying a command. */
export class ProtocolSessionGuard {
  readonly rateLimiter: PeerRateLimiter;
  readonly nonceGuard: ReplayNonceGuard;

  constructor(options: ProtocolSessionGuardOptions = {}) {
    this.rateLimiter = options.rateLimiter ?? new PeerRateLimiter();
    this.nonceGuard = options.nonceGuard ?? new ReplayNonceGuard();
  }

  accept(transportPeerId: string, value: unknown): ProtocolMessage {
    const message = validateProtocolMessage(value);
    if (message.type !== 'handshake' && message.senderPeerId !== transportPeerId) {
      throw new ProtocolValidationError('unauthorized', 'Message sender does not match transport peer');
    }
    this.rateLimiter.assertAllowed(transportPeerId);
    this.nonceGuard.assertFresh(transportPeerId, message.protocolSession, message.nonce);
    return message;
  }

  validate(transportPeerId: string, value: unknown): ProtocolMessage {
    return this.accept(transportPeerId, value);
  }
}

function validateMessageBase(value: Record<string, unknown>): void {
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError('unsupported-protocol', 'Protocol version mismatch');
  }
  validateInteger(value.protocolVersion, 'protocolVersion');
  validateIdentifier(value.protocolSession, 'protocolSession');
  validateIdentifier(value.senderPeerId, 'senderPeerId');
  validateNonce(value.nonce);
}

function messageBase(value: Record<string, unknown>): MessageBase {
  return {
    protocolVersion: validateInteger(value.protocolVersion, 'protocolVersion'),
    protocolSession: validateIdentifier(value.protocolSession, 'protocolSession'),
    senderPeerId: validateIdentifier(value.senderPeerId, 'senderPeerId'),
    nonce: validateNonce(value.nonce),
  };
}

function parsePayload(value: string): Record<string, unknown> {
  assertPayloadSize(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalid('Protocol payload is not valid JSON');
  }
  return requireRecord(parsed, 'protocol message');
}

function assertPayloadSize(value: unknown): void {
  let encoded: string;
  if (typeof value === 'string') encoded = value;
  else {
    try {
      encoded = JSON.stringify(value);
    } catch {
      throw invalid('Protocol payload is not serializable');
    }
    if (encoded === undefined) throw invalid('Protocol payload is not serializable');
  }
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > PROTOCOL_MAX_PAYLOAD_BYTES) {
    throw new ProtocolValidationError('payload-too-large', `Protocol payload exceeds ${PROTOCOL_MAX_PAYLOAD_BYTES} bytes`);
  }
}

export function validateBuildIdentity(value: unknown): BuildIdentity {
  const object = requireRecord(value, 'build identity');
  assertExactKeys(object, ['protocolVersion', 'buildId', 'features']);
  return normalizeBuildIdentity({
    protocolVersion: validateInteger(object.protocolVersion, 'protocolVersion'),
    buildId: validateIdentifier(object.buildId, 'buildId'),
    features: validateFeatures(object.features),
  });
}

function assertBuildIdentity(value: BuildIdentity): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Invalid build identity');
  }
  validateInteger(value.protocolVersion, 'protocolVersion');
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError('unsupported-protocol', 'Protocol version mismatch');
  }
  validateIdentifier(value.buildId, 'buildId');
  validateFeatures(value.features);
}

function validateFeatures(value: unknown): readonly ProtocolFeature[] {
  if (!Array.isArray(value) || value.length !== PROTOCOL_FEATURES.length) {
    throw invalid('Feature flags must be a bounded array');
  }
  const features = value.map((feature) => validateEnum(feature, PROTOCOL_FEATURES, 'feature'));
  if (new Set(features).size !== features.length) throw invalid('Duplicate feature flag');
  return Object.freeze([...features].sort(
    (a, b) => PROTOCOL_FEATURES.indexOf(a) - PROTOCOL_FEATURES.indexOf(b),
  ));
}

function sameFeatures(a: readonly ProtocolFeature[], b: readonly ProtocolFeature[]): boolean {
  try {
    const left = validateFeatures(a);
    const right = validateFeatures(b);
    return left.length === right.length && left.every((feature, index) => feature === right[index]);
  } catch {
    return false;
  }
}

function validateDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('displayName must be a string');
  const normalized = value.normalize('NFC');
  if (normalized !== normalized.trim() || normalized.length < 1
    || normalized.length > MAX_DISPLAY_NAME_LENGTH || hasControlCharacter(normalized)) {
    throw invalid('Invalid display name');
  }
  if (new TextEncoder().encode(normalized).byteLength > 4 * MAX_DISPLAY_NAME_LENGTH) {
    throw invalid('Display name is too large');
  }
  return normalized;
}

function validateSkin(value: unknown): SkinId {
  return validateEnum(value, VALID_SKIN_IDS, 'skinId');
}

function validateTeamId(value: unknown): TeamId | null {
  if (value === null) return null;
  if (value === 0 || value === 1) return value;
  throw invalid('teamId must be null, 0, or 1');
}

function validateNonce(value: unknown): string {
  return validateIdentifier(value, 'nonce', 128);
}

function validateIdentifier(value: unknown, label: string, maxLength = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
    || value !== value.trim() || hasControlCharacter(value)) {
    throw invalid(`Invalid ${label}`);
  }
  return value;
}

function validateInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid(`Invalid ${label}`);
  return value;
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${label} must be boolean`);
  return value;
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid(`Invalid ${label}`);
  return value as T;
}

function validateDisplayType(type: unknown): LobbyCommandType {
  return validateEnum(type, COMMAND_TYPES, 'message type');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function assertRecordHasType(value: Record<string, unknown>): void {
  validateDisplayType(value.type);
}

function assertExactKeysForCommand(value: Record<string, unknown>): void {
  const base = ['type', 'protocolVersion', 'protocolSession', 'senderPeerId', 'nonce'];
  switch (value.type) {
    case 'set-display-name': assertExactKeys(value, [...base, 'displayName']); return;
    case 'set-skin': assertExactKeys(value, [...base, 'skinId']); return;
    case 'set-ready': assertExactKeys(value, [...base, 'ready']); return;
    case 'set-map': assertExactKeys(value, [...base, 'mapId']); return;
    case 'set-mode': assertExactKeys(value, [...base, 'mode']); return;
    case 'set-bot-fill': assertExactKeys(value, [...base, 'botFill']); return;
    case 'set-difficulty': assertExactKeys(value, [...base, 'difficulty']); return;
    case 'set-team': assertExactKeys(value, [...base, 'participantId', 'teamId']); return;
    case 'start-request': assertExactKeys(value, base); return;
    default: throw invalid('Unknown protocol message type');
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid('Unexpected or missing protocol fields');
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function invalid(message: string): ProtocolValidationError {
  return new ProtocolValidationError('invalid-payload', message);
}

function defaultRandomId(): string {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.getRandomValues) throw new Error('Secure randomness is unavailable');
  const bytes = new Uint8Array(18);
  cryptoObject.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === 'function') {
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  }
  // Node 22 exposes WebCrypto but not btoa in every test runner configuration.
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
