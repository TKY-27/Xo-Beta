/**
 * Small, browser-compatible cryptographic helpers for the Phase 3 lobby.
 *
 * The module deliberately uses only the Web Crypto API.  Keeping the
 * boundary here free of Node imports lets the same invite be created in the
 * browser and checked by Node 22 Vitest tests.
 */

export type Binary = Uint8Array | ArrayBuffer;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function webCrypto(): Crypto {
  const value = globalThis.crypto;
  if (!value || typeof value.getRandomValues !== 'function' || !value.subtle) {
    throw new Error('Web Crypto API is unavailable');
  }
  return value;
}

function copyBytes(value: Binary | ArrayBufferView): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  const result = new Uint8Array(value.byteLength);
  result.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return result;
}

function asArrayBuffer(value: Binary | ArrayBufferView): ArrayBuffer {
  const bytes = copyBytes(value);
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

/** Return cryptographically random bytes from the platform RNG. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0 || length > 65_536) {
    throw new RangeError('Random byte length must be an integer from 1 through 65536');
  }
  const result = new Uint8Array(length);
  webCrypto().getRandomValues(result);
  return result;
}

/** Copy and concatenate binary values without retaining caller-owned views. */
export function concatBytes(...values: readonly Binary[]): Uint8Array {
  const parts = values.map((value) => copyBytes(value));
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function decodeUtf8(value: Binary): string {
  return textDecoder.decode(copyBytes(value));
}

export function bytesToHex(value: Binary): string {
  return Array.from(copyBytes(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new TypeError('Expected an even-length hexadecimal string');
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function binaryString(value: Uint8Array): string {
  let result = '';
  const chunkSize = 0x8_000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    result += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return result;
}

function bytesFromBinaryString(value: string): Uint8Array {
  const result = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) result[index] = value.charCodeAt(index);
  return result;
}

/** URL-safe base64 without padding, suitable for signed envelopes. */
export function base64UrlEncode(value: Binary): string {
  const encoded = btoa(binaryString(copyBytes(value)));
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new TypeError('Invalid base64url text');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return bytesFromBinaryString(atob(padded));
  } catch {
    throw new TypeError('Invalid base64url text');
  }
}

export const encodeBase64Url = base64UrlEncode;
export const decodeBase64Url = base64UrlDecode;

/** SHA-256 digest as a fresh byte array. */
export async function sha256(value: Binary): Promise<Uint8Array> {
  const digest = await webCrypto().subtle.digest('SHA-256', asArrayBuffer(value));
  return new Uint8Array(digest);
}

/**
 * Import an SPKI encoded P-256 public key for ECDSA verification.
 * Strings are URL-safe base64 (the representation used by signed messages).
 */
export async function importP256PublicKey(value: Binary | string): Promise<CryptoKey> {
  const spki = typeof value === 'string' ? base64UrlDecode(value) : copyBytes(value);
  return webCrypto().subtle.importKey(
    'spki',
    asArrayBuffer(spki),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

/** SHA-256 fingerprint of an SPKI-encoded public key, in lowercase hex. */
export async function spkiFingerprint(value: Binary): Promise<Uint8Array> {
  return sha256(value);
}

export const fingerprintSpki = spkiFingerprint;

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalJson(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => {
      if (!(index in value)) throw new TypeError(`Sparse array at ${path}[${index}]`);
      return canonicalJson(item, `${path}[${index}]`);
    }).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}`);
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => {
      const item = object[key];
      if (item === undefined) throw new TypeError(`Undefined value at ${path}.${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(item, `${path}.${key}`)}`;
    }).join(',')}}`;
  }
  throw new TypeError(`Unsupported value at ${path}`);
}

/** Deterministic JSON (sorted object keys, no insignificant whitespace). */
export function canonicalize(value: unknown): string {
  return canonicalJson(value, '$');
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonicalize(value));
}

/** Sign canonical JSON with an ECDSA P-256 private key. */
export async function signCanonical(privateKey: CryptoKey, value: unknown): Promise<string> {
  const signature = await webCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    asArrayBuffer(canonicalBytes(value)),
  );
  return base64UrlEncode(signature);
}

export const signCanonicalJson = signCanonical;

/** Verify a base64url (or raw) ECDSA P-256 signature over canonical JSON. */
export async function verifyCanonical(
  publicKey: CryptoKey,
  value: unknown,
  signature: Binary | string,
): Promise<boolean> {
  try {
    const signatureBytes = typeof signature === 'string' ? base64UrlDecode(signature) : copyBytes(signature);
    return await webCrypto().subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      asArrayBuffer(signatureBytes),
      asArrayBuffer(canonicalBytes(value)),
    );
  } catch {
    return false;
  }
}

export const verifyCanonicalJson = verifyCanonical;

/** HKDF-SHA-256 with explicit byte-length and domain-separated info. */
export async function hkdfSha256(
  inputKeyMaterial: Binary,
  salt: Binary,
  info: Binary,
  length = 32,
): Promise<Uint8Array> {
  if (!Number.isInteger(length) || length <= 0 || length > 255 * 32) {
    throw new RangeError('HKDF output length must be from 1 through 8160 bytes');
  }
  const key = await webCrypto().subtle.importKey(
    'raw',
    asArrayBuffer(inputKeyMaterial),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await webCrypto().subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asArrayBuffer(salt),
      info: asArrayBuffer(info),
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

const INVITE_SECRET_MIN_BYTES = 16;
const INVITE_DERIVATION_LABELS = {
  discoveryRoomId: 'discovery-room-id',
  signalingPassword: 'signaling-password',
  lobbyAuthenticationKey: 'lobby-authentication-key',
  reconnectNamespace: 'reconnect-namespace',
  protocolSessionBinding: 'protocol-session-binding',
} as const;

export interface InviteKeyMaterial {
  readonly discoveryRoomId: string;
  readonly signalingPassword: string;
  readonly lobbyAuthenticationKey: Uint8Array;
  readonly reconnectNamespace: string;
  readonly protocolSessionBinding: Uint8Array;
}

function textBytes(value: string): Uint8Array {
  if (/^(?:[0-9a-fA-F]{2})+$/.test(value)) return hexToBytes(value);
  return base64UrlDecode(value);
}

function fingerprintContext(value: Binary | string | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array();
  const context = typeof value !== 'string' ? copyBytes(value) : textBytes(value);
  if (context.byteLength !== 32) {
    throw new TypeError('Host fingerprint must contain 32 bytes');
  }
  return context;
}

/**
 * Derive independent invite-scoped values.  Every value has a distinct HKDF
 * info label, and the public host fingerprint is included as context so a
 * copied root secret cannot silently attach to another host identity.
 */
export async function deriveInviteSecrets(
  rootSecret: Binary | string,
  hostFingerprint?: Binary | string,
): Promise<InviteKeyMaterial> {
  const secret = typeof rootSecret === 'string' ? textBytes(rootSecret) : copyBytes(rootSecret);
  if (secret.byteLength < INVITE_SECRET_MIN_BYTES) {
    throw new RangeError('Invite root secret must contain at least 128 bits');
  }
  const context = fingerprintContext(hostFingerprint);
  const salt = await sha256(concatBytes(utf8('xo-beta/hkdf-salt/v1\0'), context));
  const derive = (label: string) => hkdfSha256(
    secret,
    salt,
    concatBytes(utf8(`xo-beta/hkdf/v1/${label}\0`), context),
    32,
  );
  const [roomId, signalingPassword, lobbyAuthenticationKey, reconnectNamespace, protocolSessionBinding] = await Promise.all([
    derive(INVITE_DERIVATION_LABELS.discoveryRoomId),
    derive(INVITE_DERIVATION_LABELS.signalingPassword),
    derive(INVITE_DERIVATION_LABELS.lobbyAuthenticationKey),
    derive(INVITE_DERIVATION_LABELS.reconnectNamespace),
    derive(INVITE_DERIVATION_LABELS.protocolSessionBinding),
  ]);
  return {
    discoveryRoomId: base64UrlEncode(roomId),
    signalingPassword: base64UrlEncode(signalingPassword),
    lobbyAuthenticationKey,
    reconnectNamespace: base64UrlEncode(reconnectNamespace),
    protocolSessionBinding,
  };
}

/** Alias that reads naturally at call sites deriving the five namespaces. */
export const deriveInviteKeyMaterial = deriveInviteSecrets;
export const deriveInviteKeys = deriveInviteSecrets;
export const deriveSeparatedInviteValues = deriveInviteSecrets;
