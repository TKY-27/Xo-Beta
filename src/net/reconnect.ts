/**
 * Reconnect credentials are intentionally scoped to the current browser
 * session. No match state is persisted here; a token only points back to an
 * authoritative lobby slot and protocol session.
 */

export const RECONNECT_STORAGE_PREFIX = 'xo-beta-reconnect-v1:';
export const DEFAULT_RECONNECT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_RECONNECT_TOKEN_BYTES = 32;

export interface ReconnectBinding {
  readonly roomId: string;
  readonly slotId: number;
  readonly participantId: string;
  readonly protocolSession: string;
}

export interface ReconnectRecord extends ReconnectBinding {
  readonly token: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly generation: number;
}

export type ReconnectErrorCode =
  | 'invalid-binding'
  | 'invalid-token'
  | 'unknown-reconnect'
  | 'stale-reconnect'
  | 'binding-mismatch'
  | 'storage-unavailable';

export class ReconnectError extends Error {
  readonly code: ReconnectErrorCode;

  constructor(code: ReconnectErrorCode, message: string) {
    super(message);
    this.name = 'ReconnectError';
    this.code = code;
  }
}

/** Minimal adapter so production can use sessionStorage while tests use Map. */
export interface ReconnectStorage {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export class MemoryReconnectStorage implements ReconnectStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

export const InMemoryReconnectStorage = MemoryReconnectStorage;

/** Wrap an explicitly supplied Storage object without exposing it elsewhere. */
export class SessionStorageReconnectStorage implements ReconnectStorage {
  constructor(private readonly storage: Storage) {}

  get(key: string): string | null {
    return this.storage.getItem(key);
  }

  set(key: string, value: string): void {
    this.storage.setItem(key, value);
  }

  delete(key: string): void {
    this.storage.removeItem(key);
  }
}

export function createSessionReconnectStorage(storage?: Storage): ReconnectStorage {
  const selected = storage ?? (typeof sessionStorage === 'undefined' ? null : sessionStorage);
  if (!selected) throw new ReconnectError('storage-unavailable', 'Session storage is unavailable');
  return new SessionStorageReconnectStorage(selected);
}

export const GUEST_RECONNECT_STORAGE_PREFIX = `${RECONNECT_STORAGE_PREFIX}guest:`;

export interface GuestReconnectSessionStoreOptions {
  /** Derived reconnect namespace; the invite/root secret must never be passed here. */
  readonly namespace: string;
  /** Native Storage is accepted for browser tests; adapters are accepted for Node tests. */
  readonly storage?: Storage | ReconnectStorage;
  readonly keyPrefix?: string;
}

/**
 * Browser-side storage for the guest's current token. The value is only the
 * token string; room, slot, participant and protocol binding remain host-side
 * in ReconnectTokenManager. A changed browser peer ID can therefore load the
 * same token and present it during a later admission attempt.
 */
export class GuestReconnectSessionStore {
  private readonly storage: ReconnectStorage;
  private readonly storageKey: string;

  constructor(options: GuestReconnectSessionStoreOptions);
  constructor(namespace: string, storage?: Storage | ReconnectStorage);
  constructor(
    optionsOrNamespace: GuestReconnectSessionStoreOptions | string,
    injectedStorage?: Storage | ReconnectStorage,
  ) {
    const options: GuestReconnectSessionStoreOptions = typeof optionsOrNamespace === 'string'
      ? { namespace: optionsOrNamespace, storage: injectedStorage }
      : optionsOrNamespace;
    const namespace = validateNamespace(options.namespace);
    const prefix = options.keyPrefix ?? GUEST_RECONNECT_STORAGE_PREFIX;
    if (typeof prefix !== 'string' || prefix.length < 1 || prefix.length > 128 || hasControlCharacter(prefix)) {
      throw new ReconnectError('invalid-binding', 'Invalid reconnect storage prefix');
    }
    this.storage = options.storage === undefined
      ? createSessionReconnectStorage()
      : toReconnectStorage(options.storage);
    this.storageKey = `${prefix}${namespace}`;
  }

  get key(): string {
    return this.storageKey;
  }

  save(token: string, _browserPeerId?: string): void {
    const checked = validateToken(token);
    try {
      this.storage.set(this.storageKey, checked);
    } catch {
      throw new ReconnectError('storage-unavailable', 'Reconnect session storage is unavailable');
    }
  }

  /** Alias used by admission/reclaim callers after receiving a rotated token. */
  replace(token: string, browserPeerId?: string): void {
    this.save(token, browserPeerId);
  }

  rotate(token: string, browserPeerId?: string): void {
    this.replace(token, browserPeerId);
  }

  saveAfterReclaim(token: string, browserPeerId?: string): void {
    this.replace(token, browserPeerId);
  }

  load(_browserPeerId?: string): string | null {
    let value: string | null | undefined;
    try {
      value = this.storage.get(this.storageKey);
    } catch {
      throw new ReconnectError('storage-unavailable', 'Reconnect session storage is unavailable');
    }
    if (value === null || value === undefined) return null;
    if (!validToken(value)) {
      try {
        this.storage.delete(this.storageKey);
      } catch {
        // Invalid data remains rejected even if cleanup is unavailable.
      }
      return null;
    }
    return value;
  }

  loadToken(browserPeerId?: string): string | null {
    return this.load(browserPeerId);
  }

  clear(): void {
    try {
      this.storage.delete(this.storageKey);
    } catch {
      throw new ReconnectError('storage-unavailable', 'Reconnect session storage is unavailable');
    }
  }
}

export const GuestReconnectStore = GuestReconnectSessionStore;
export const ReconnectSessionStore = GuestReconnectSessionStore;

export function createGuestReconnectSession(
  namespace: string,
  storage?: Storage | ReconnectStorage,
): GuestReconnectSessionStore {
  return new GuestReconnectSessionStore(namespace, storage);
}

export interface ReconnectTokenManagerOptions {
  readonly storage?: ReconnectStorage;
  readonly ttlMs?: number;
  readonly tokenBytes?: number;
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly storagePrefix?: string;
}

export interface ReclaimOptions {
  /** New session identity after the transport has been re-established. */
  readonly nextProtocolSession?: string;
}

export interface ReclaimGrant {
  readonly token: string;
  readonly binding: ReconnectBinding;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly generation: number;
}

/**
 * A host admission can disclose the replacement token only after every other
 * authoritative state transition is ready. The transaction keeps the old
 * credential restorable until the signed acceptance has been delivered.
 */
export interface ReclaimTransaction {
  readonly grant: ReclaimGrant;
  commit(): void;
  rollback(): void;
}

/**
 * Issues random, short-lived, single-use reconnect tokens. Reclaim always
 * rotates the credential and (by default) the protocol session, making an old
 * token and an old session stale even if a peer replays them later.
 */
export class ReconnectTokenManager {
  private readonly storage: ReconnectStorage;
  private readonly ttlMs: number;
  private readonly tokenBytes: number;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly storagePrefix: string;
  private readonly issuedTokens = new Set<string>();

  constructor(optionsOrStorage: ReconnectTokenManagerOptions | ReconnectStorage = {}) {
    const options = isStorage(optionsOrStorage) ? { storage: optionsOrStorage } : optionsOrStorage;
    this.storage = options.storage ?? defaultStorage();
    this.ttlMs = options.ttlMs ?? DEFAULT_RECONNECT_TTL_MS;
    this.tokenBytes = options.tokenBytes ?? DEFAULT_RECONNECT_TOKEN_BYTES;
    this.now = options.now ?? (() => Date.now());
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.storagePrefix = options.storagePrefix ?? RECONNECT_STORAGE_PREFIX;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 24 * 60 * 60 * 1000) {
      throw new RangeError('Reconnect TTL must be between one millisecond and 24 hours');
    }
    if (!Number.isInteger(this.tokenBytes) || this.tokenBytes < 16 || this.tokenBytes > 128) {
      throw new RangeError('Reconnect token bytes must be between 16 and 128');
    }
    if (this.storagePrefix.length < 1 || this.storagePrefix.length > 128) {
      throw new RangeError('Reconnect storage prefix is invalid');
    }
  }

  issue(binding: ReconnectBinding): string {
    return this.issueGrant(binding).token;
  }

  issueToken(binding: ReconnectBinding): string {
    return this.issue(binding);
  }

  issueGrant(binding: ReconnectBinding, generation = 0): ReclaimGrant {
    const checked = validateBinding(binding);
    const issuedAt = this.currentTime();
    const expiresAt = issuedAt + this.ttlMs;
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = encodeToken(this.randomBytes(this.tokenBytes));
      if (!validToken(token)) throw new ReconnectError('invalid-token', 'Random source produced an invalid token');
      const record: ReconnectRecord = Object.freeze({
        ...checked,
        token,
        issuedAt,
        expiresAt,
        generation,
      });
      const key = this.keyFor(token);
      if (this.storage.get(key) !== undefined && this.storage.get(key) !== null) continue;
      this.writeRecord(record);
      this.issuedTokens.add(token);
      return Object.freeze({
        token,
        binding: Object.freeze({ ...checked }),
        issuedAt,
        expiresAt,
        generation,
      });
    }
    throw new ReconnectError('storage-unavailable', 'Could not allocate a unique reconnect token');
  }

  /** Validate a credential and rotate it, returning only the new token. */
  reclaim(token: string, expected: ReconnectBinding, options: ReclaimOptions = {}): string {
    return this.reclaimGrant(token, expected, options).token;
  }

  reclaimToken(token: string, expected: ReconnectBinding, options: ReclaimOptions = {}): string {
    return this.reclaim(token, expected, options);
  }

  /** Rotate a credential with an explicit rollback point for admission. */
  prepareReclaim(
    token: string,
    expected: ReconnectBinding,
    options: ReclaimOptions = {},
  ): ReclaimTransaction {
    const checkedToken = validateToken(token);
    const old = this.getRecord(checkedToken);
    if (!old) throw new ReconnectError('unknown-reconnect', 'Reconnect token is unknown');
    const grant = this.reclaimGrant(checkedToken, expected, options);
    let settled = false;
    return Object.freeze({
      grant,
      commit: () => { settled = true; },
      rollback: () => {
        if (settled) return;
        settled = true;
        this.restoreReclaim(old, grant);
      },
    });
  }

  reclaimGrant(token: string, expected: ReconnectBinding, options: ReclaimOptions = {}): ReclaimGrant {
    const checkedToken = validateToken(token);
    const checkedExpected = validateBinding(expected);
    const old = this.readRecord(checkedToken);
    if (!old) throw new ReconnectError('unknown-reconnect', 'Reconnect token is unknown');
    if (this.currentTime() >= old.expiresAt) {
      this.storage.delete(this.keyFor(checkedToken));
      throw new ReconnectError('stale-reconnect', 'Reconnect token has expired');
    }
    if (!sameBinding(old, checkedExpected)) {
      throw new ReconnectError('binding-mismatch', 'Reconnect token binding does not match');
    }
    const nextProtocolSession = options.nextProtocolSession === undefined
      ? randomIdentifier()
      : validateIdentifier(options.nextProtocolSession, 'nextProtocolSession');
    this.storage.delete(this.keyFor(checkedToken));
    this.issuedTokens.delete(checkedToken);
    try {
      return this.issueGrant({ ...checkedExpected, protocolSession: nextProtocolSession }, old.generation + 1);
    } catch (error) {
      // The old credential is deliberately not restored: a failed reclaim is
      // fail-closed rather than leaving a replayable token alive.
      if (error instanceof ReconnectError) throw error;
      throw new ReconnectError('storage-unavailable', 'Could not rotate reconnect token');
    }
  }

  /** Read a record for diagnostics/host binding, without accepting it. */
  getRecord(token: string): ReconnectRecord | null {
    const checkedToken = validateToken(token);
    const record = this.readRecord(checkedToken);
    if (!record) return null;
    if (this.currentTime() >= record.expiresAt) {
      this.storage.delete(this.keyFor(checkedToken));
      return null;
    }
    return record;
  }

  bindingFor(token: string): ReconnectBinding | null {
    const record = this.getRecord(token);
    return record ? Object.freeze({
      roomId: record.roomId,
      slotId: record.slotId,
      participantId: record.participantId,
      protocolSession: record.protocolSession,
    }) : null;
  }

  revoke(token: string): void {
    const checkedToken = validateToken(token);
    this.storage.delete(this.keyFor(checkedToken));
    this.issuedTokens.delete(checkedToken);
  }

  clear(): void {
    for (const token of this.issuedTokens) this.storage.delete(this.keyFor(token));
    this.issuedTokens.clear();
  }

  private restoreReclaim(old: ReconnectRecord, replacement: ReclaimGrant): void {
    try {
      const currentReplacement = this.storage.get(this.keyFor(replacement.token));
      if (currentReplacement !== undefined && currentReplacement !== null) {
        this.storage.delete(this.keyFor(replacement.token));
      }
      this.issuedTokens.delete(replacement.token);
      const currentOld = this.storage.get(this.keyFor(old.token));
      if (currentOld !== undefined && currentOld !== null) {
        throw new ReconnectError('storage-unavailable', 'Original reconnect credential was replaced concurrently');
      }
      this.writeRecord(old);
      this.issuedTokens.add(old.token);
    } catch (error) {
      if (error instanceof ReconnectError) throw error;
      throw new ReconnectError('storage-unavailable', 'Could not restore reconnect credential');
    }
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new ReconnectError('storage-unavailable', 'Clock returned a non-finite value');
    return value;
  }

  private keyFor(token: string): string {
    return `${this.storagePrefix}${token}`;
  }

  private writeRecord(record: ReconnectRecord): void {
    try {
      this.storage.set(this.keyFor(record.token), JSON.stringify(record));
    } catch {
      throw new ReconnectError('storage-unavailable', 'Reconnect storage is unavailable');
    }
  }

  private readRecord(token: string): ReconnectRecord | null {
    let raw: string | null | undefined;
    try {
      raw = this.storage.get(this.keyFor(token));
    } catch {
      throw new ReconnectError('storage-unavailable', 'Reconnect storage is unavailable');
    }
    if (raw === null || raw === undefined) return null;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!isRecord(value)
        || Object.keys(value).sort().join('|') !== [
          'expiresAt',
          'generation',
          'issuedAt',
          'participantId',
          'protocolSession',
          'roomId',
          'slotId',
          'token',
        ].join('|')) {
        this.storage.delete(this.keyFor(token));
        return null;
      }
      const record: ReconnectRecord = {
        token: validateToken(value.token),
        roomId: validateIdentifier(value.roomId, 'roomId'),
        slotId: validateSlot(value.slotId),
        participantId: validateIdentifier(value.participantId, 'participantId'),
        protocolSession: validateIdentifier(value.protocolSession, 'protocolSession'),
        issuedAt: validateTime(value.issuedAt, 'issuedAt'),
        expiresAt: validateTime(value.expiresAt, 'expiresAt'),
        generation: validateGeneration(value.generation),
      };
      if (record.token !== token || record.expiresAt <= record.issuedAt) {
        this.storage.delete(this.keyFor(token));
        return null;
      }
      return Object.freeze(record);
    } catch {
      try {
        this.storage.delete(this.keyFor(token));
      } catch {
        // Ignore cleanup failure; the token remains rejected.
      }
      return null;
    }
  }
}

export const ReconnectStore = ReconnectTokenManager;

function toReconnectStorage(value: Storage | ReconnectStorage): ReconnectStorage {
  if (isStorage(value)) return value;
  if (typeof value.getItem === 'function' && typeof value.setItem === 'function'
    && typeof value.removeItem === 'function') {
    return new SessionStorageReconnectStorage(value);
  }
  throw new ReconnectError('storage-unavailable', 'Invalid reconnect storage adapter');
}

function isStorage(value: unknown): value is ReconnectStorage {
  return typeof value === 'object' && value !== null
    && typeof (value as ReconnectStorage).get === 'function'
    && typeof (value as ReconnectStorage).set === 'function'
    && typeof (value as ReconnectStorage).delete === 'function';
}

function defaultStorage(): ReconnectStorage {
  try {
    return createSessionReconnectStorage();
  } catch {
    return new MemoryReconnectStorage();
  }
}

function validateBinding(value: ReconnectBinding): ReconnectBinding {
  if (!isRecord(value)) throw new ReconnectError('invalid-binding', 'Reconnect binding must be an object');
  return Object.freeze({
    roomId: validateIdentifier(value.roomId, 'roomId'),
    slotId: validateSlot(value.slotId),
    participantId: validateIdentifier(value.participantId, 'participantId'),
    protocolSession: validateIdentifier(value.protocolSession, 'protocolSession'),
  });
}

function validateIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || value !== value.trim() || hasControlCharacter(value)) {
    throw new ReconnectError('invalid-binding', `Invalid ${label}`);
  }
  return value;
}

function validateNamespace(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 256
    || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ReconnectError('invalid-binding', 'Invalid derived reconnect namespace');
  }
  return value;
}

function validateSlot(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= 4) {
    throw new ReconnectError('invalid-binding', 'Invalid reconnect slot');
  }
  return value;
}

function validateTime(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReconnectError('invalid-binding', `Invalid ${label}`);
  }
  return value;
}

function validateGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ReconnectError('invalid-binding', 'Invalid reconnect generation');
  }
  return value;
}

function validateToken(value: unknown): string {
  if (typeof value !== 'string' || !validToken(value)) {
    throw new ReconnectError('invalid-token', 'Invalid reconnect token');
  }
  return value;
}

function validToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{22,256}$/u.test(value);
}

function sameBinding(a: ReconnectBinding, b: ReconnectBinding): boolean {
  return a.roomId === b.roomId
    && a.slotId === b.slotId
    && a.participantId === b.participantId
    && a.protocolSession === b.protocolSession;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function encodeToken(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) {
    throw new ReconnectError('invalid-token', 'Random source produced too few bytes');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === 'function') {
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function secureRandomBytes(length: number): Uint8Array {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.getRandomValues) throw new ReconnectError('storage-unavailable', 'Secure randomness is unavailable');
  const bytes = new Uint8Array(length);
  cryptoObject.getRandomValues(bytes);
  return bytes;
}

function randomIdentifier(): string {
  return encodeToken(secureRandomBytes(18));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
