import {
  bytesToHex,
  randomBytes,
  spkiFingerprint,
  type Binary,
} from './crypto';
import {
  createEphemeralHostIdentity,
  normalizeFingerprint,
  type HostIdentity,
} from './hostIdentity';

/** Crockford's unambiguous alphabet (I, L, O and U are intentionally absent). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const INVITE_TOKEN_VERSION = 1 as const;
export const INVITE_ROOT_SECRET_BYTES = 32;
export const INVITE_ROOT_SECRET_MIN_BYTES = 16;
export const INVITE_HOST_FINGERPRINT_BYTES = 32;
export const ROOT_SECRET_BYTES = INVITE_ROOT_SECRET_BYTES;
export const MIN_ROOT_SECRET_BYTES = INVITE_ROOT_SECRET_MIN_BYTES;
const INVITE_CHECKSUM_BYTES = 2;
const INVITE_DATA_BYTES = 1 + INVITE_ROOT_SECRET_BYTES + INVITE_HOST_FINGERPRINT_BYTES;
const INVITE_TOKEN_BYTES = INVITE_DATA_BYTES + INVITE_CHECKSUM_BYTES;
const TOKEN_GROUP_SIZE = 4;
export const INVITE_TOKEN_MAX_INPUT_CHARS = 256;

const crockfordValues: Record<string, number> = Object.create(null) as Record<string, number>;
for (let index = 0; index < CROCKFORD_ALPHABET.length; index += 1) {
  const character = CROCKFORD_ALPHABET[index];
  if (character !== undefined) crockfordValues[character] = index;
}

function asBytes(value: Binary): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0));
}

/**
 * Encode bytes manually as Crockford Base32.  No aliases are accepted by the
 * decoder: the visually-confusable I/L/O/U characters must be retyped.
 */
export function encodeCrockfordBase32(value: Binary): string {
  const bytes = asBytes(value);
  let buffer = 0;
  let bits = 0;
  let result = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += CROCKFORD_ALPHABET[(buffer >>> bits) & 31];
    }
    // Keep only bits that have not yet become a complete symbol.
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) result += CROCKFORD_ALPHABET[(buffer << (5 - bits)) & 31];
  return result;
}

function normalizedBase32(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Crockford Base32 token must be text');
  const normalized = value.replace(/[\s-]/gu, '').toUpperCase();
  if (normalized.length === 0) throw new TypeError('Crockford Base32 token is empty');
  return normalized;
}

/** Decode Crockford Base32, accepting case and presentation separators. */
export function decodeCrockfordBase32(value: string): Uint8Array {
  const normalized = normalizedBase32(value);
  let buffer = 0;
  let bits = 0;
  const result: number[] = [];
  for (const character of normalized) {
    const digit = crockfordValues[character];
    if (digit === undefined) throw new TypeError(`Invalid or ambiguous Crockford character: ${character}`);
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  // Base32's unused tail bits are required to be zero, so a changed final
  // symbol cannot be silently accepted as the same byte sequence.
  if (bits > 0 && buffer !== 0) throw new TypeError('Non-zero Crockford Base32 padding bits');
  return new Uint8Array(result);
}

/** Insert visual groups without changing the token's canonical symbols. */
export function groupInviteToken(value: string, groupSize = TOKEN_GROUP_SIZE): string {
  if (!Number.isInteger(groupSize) || groupSize <= 0) throw new RangeError('Token group size must be positive');
  const normalized = normalizedBase32(value);
  for (const character of normalized) {
    if (crockfordValues[character] === undefined) {
      throw new TypeError(`Invalid or ambiguous Crockford character: ${character}`);
    }
  }
  const groups: string[] = [];
  for (let index = 0; index < normalized.length; index += groupSize) {
    groups.push(normalized.slice(index, index + groupSize));
  }
  return groups.join('-');
}

export const formatInviteToken = groupInviteToken;

// CRC-16/CCITT-FALSE is compact, deterministic, and catches common single
// character transcription errors before any invite-derived value is used.
function crc16(value: Binary): number {
  let crc = 0xffff;
  for (const byte of asBytes(value)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function inviteBytes(rootSecret: Binary, fingerprint: Binary): Uint8Array {
  const secret = asBytes(rootSecret);
  const hostFingerprint = asBytes(fingerprint);
  if (secret.length < INVITE_ROOT_SECRET_MIN_BYTES) {
    throw new RangeError('Invite root secret must contain at least 128 bits');
  }
  if (secret.length !== INVITE_ROOT_SECRET_BYTES) {
    throw new RangeError(`Invite root secret must contain exactly ${INVITE_ROOT_SECRET_BYTES} bytes`);
  }
  if (hostFingerprint.length !== INVITE_HOST_FINGERPRINT_BYTES) {
    throw new RangeError('Invite host fingerprint must contain 32 bytes');
  }
  const result = new Uint8Array(INVITE_TOKEN_BYTES);
  result[0] = INVITE_TOKEN_VERSION;
  result.set(secret, 1);
  result.set(hostFingerprint, 1 + INVITE_ROOT_SECRET_BYTES);
  const checksum = crc16(result.subarray(0, INVITE_DATA_BYTES));
  result[INVITE_DATA_BYTES] = checksum >>> 8;
  result[INVITE_DATA_BYTES + 1] = checksum & 0xff;
  return result;
}

export interface ParsedInvite {
  readonly version: typeof INVITE_TOKEN_VERSION;
  readonly token: string;
  readonly fragment: string;
  readonly joinFragment: string;
  readonly rootSecret: Uint8Array;
  readonly rootSecretBytes: Uint8Array;
  readonly secret: Uint8Array;
  readonly hostFingerprint: string;
  readonly hostIdentityFingerprint: string;
  readonly hostFingerprintBytes: Uint8Array;
  readonly fingerprint: string;
  readonly spkiFingerprint: string;
}

export interface Invite extends ParsedInvite {
  /** Local-only identity retained by createInvite; never put this in a URL. */
  readonly hostIdentity: HostIdentity;
  readonly url: string;
  readonly joinUrl: string;
}

export interface HostInvite {
  readonly invite: Invite;
  readonly hostIdentity: HostIdentity;
  readonly identity: HostIdentity;
}

export interface CreateInviteOptions {
  readonly hostIdentity?: HostIdentity;
  readonly baseUrl?: string | URL;
}

function parseInviteBytes(bytes: Uint8Array, canonicalToken: string): ParsedInvite {
  if (bytes.length !== INVITE_TOKEN_BYTES) throw new TypeError('Invalid invite token length');
  if (bytes[0] !== INVITE_TOKEN_VERSION) throw new TypeError('Unsupported invite token version');
  const data = bytes.subarray(0, INVITE_DATA_BYTES);
  const expected = crc16(data);
  const actual = (bytes[INVITE_DATA_BYTES]! << 8) | bytes[INVITE_DATA_BYTES + 1]!;
  if (expected !== actual) throw new TypeError('Invite checksum failed');
  const rootSecret = bytes.slice(1, 1 + INVITE_ROOT_SECRET_BYTES);
  const hostFingerprintBytes = bytes.slice(1 + INVITE_ROOT_SECRET_BYTES, INVITE_DATA_BYTES);
  const hostFingerprint = bytesToHex(hostFingerprintBytes);
  const fragment = `#join=${canonicalToken}`;
  return {
    version: INVITE_TOKEN_VERSION,
    token: canonicalToken,
    fragment,
    joinFragment: fragment,
    rootSecret,
    rootSecretBytes: rootSecret.slice(),
    secret: rootSecret.slice(),
    hostFingerprint,
    hostIdentityFingerprint: hostFingerprint,
    hostFingerprintBytes,
    fingerprint: hostFingerprint,
    spkiFingerprint: hostFingerprint,
  };
}

/** Parse and validate a token; separators, spaces and case are presentation-only. */
export function parseInviteToken(value: string): ParsedInvite {
  if (typeof value !== 'string' || value.length > INVITE_TOKEN_MAX_INPUT_CHARS) {
    throw new TypeError('Invite token is too long');
  }
  const normalized = normalizedBase32(value);
  const bytes = decodeCrockfordBase32(normalized);
  return parseInviteBytes(bytes, groupInviteToken(normalized));
}

export const decodeInviteToken = parseInviteToken;
export const parseInvite = parseInviteToken;
export const decodeToken = parseInviteToken;

async function identityFingerprintBytes(identity: HostIdentity): Promise<Uint8Array> {
  const claimed = normalizeFingerprint(identity.fingerprint);
  const bytes = asBytes(identity.fingerprintBytes);
  if (bytes.length !== INVITE_HOST_FINGERPRINT_BYTES) throw new TypeError('Invite host fingerprint must contain 32 bytes');
  if (bytesToHex(bytes) !== claimed) throw new TypeError('Host identity fingerprint fields disagree');
  const actual = bytesToHex(await spkiFingerprint(identity.publicKeySpki));
  if (actual !== claimed) throw new TypeError('Host identity SPKI fingerprint does not match its commitment');
  return bytes;
}

function inviteTokenValue(value: Invite | string): string {
  if (typeof value !== 'string') return value.token;
  if (value.startsWith('#join=')) return value.slice('#join='.length);
  if (value.includes('#') || value.includes('?')) throw new TypeError('Invite token must not contain a query or path');
  return value;
}

/** Create a URL fragment (or append one to an explicitly supplied app URL). */
export function createInviteUrl(invite: Invite | string, baseUrl?: string | URL): string {
  const parsed = parseInviteToken(inviteTokenValue(invite));
  const fragment = parsed.fragment;
  if (baseUrl === undefined || String(baseUrl).length === 0) return fragment;
  let url: URL;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw new TypeError('Invite base URL must be an absolute URL');
  }
  url.hash = fragment.slice(1);
  return url.toString();
}

export const inviteUrl = createInviteUrl;
export const createJoinUrl = createInviteUrl;

export function createInviteFragment(invite: Invite | string): string {
  return createInviteUrl(invite);
}

export const inviteFragment = createInviteFragment;
export const createJoinFragment = createInviteFragment;

/** Read only #join=...; tokens in query strings or paths are intentionally ignored. */
export function parseInviteFragment(value: string): ParsedInvite {
  if (typeof value !== 'string') throw new TypeError('Invite fragment must be text');
  const hash = value.startsWith('#') ? value : (() => {
    const hashIndex = value.indexOf('#');
    if (hashIndex >= 0) return value.slice(hashIndex);
    try {
      return new URL(value).hash;
    } catch {
      throw new TypeError('Expected an invite fragment or absolute URL');
    }
  })();
  const match = /^#join=([^#]*)$/u.exec(hash);
  if (!match || match[1] === undefined) throw new TypeError('Invite URL must use the #join=<token> fragment');
  let token = match[1];
  try {
    token = decodeURIComponent(token);
  } catch {
    throw new TypeError('Malformed invite fragment encoding');
  }
  return parseInviteToken(token);
}

export const parseJoinFragment = parseInviteFragment;

export function parseInviteUrl(value: string | URL): ParsedInvite {
  if (value instanceof URL) return parseInviteFragment(value.hash);
  return parseInviteFragment(value);
}

export const parseJoinUrl = parseInviteUrl;

function createInviteOptions(
  value: HostIdentity | CreateInviteOptions | undefined,
  baseUrl: string | URL | undefined,
): { identity?: HostIdentity; baseUrl?: string | URL } {
  if (value === undefined) return { baseUrl };
  if (typeof value === 'object' && value !== null && ('hostIdentity' in value || 'baseUrl' in value)) {
    return { identity: value.hostIdentity, baseUrl: value.baseUrl ?? baseUrl };
  }
  return { identity: value as HostIdentity, baseUrl };
}

/**
 * Create a fresh invite.  Omitting the identity creates an ephemeral one in
 * memory so the returned invite is immediately usable by a host; callers that
 * need to pass the pair around can use createHostInvite for an explicit tuple.
 */
export async function createInvite(
  value?: HostIdentity | CreateInviteOptions,
  baseUrl?: string | URL,
): Promise<Invite> {
  const options = createInviteOptions(value, baseUrl);
  const hostIdentity = options.identity ?? await createEphemeralHostIdentity();
  const rootSecret = randomBytes(INVITE_ROOT_SECRET_BYTES);
  const hostFingerprintBytes = await identityFingerprintBytes(hostIdentity);
  const token = groupInviteToken(encodeCrockfordBase32(inviteBytes(rootSecret, hostFingerprintBytes)));
  const parsed = parseInviteToken(token);
  const url = createInviteUrl(token, options.baseUrl);
  return {
    ...parsed,
    hostIdentity,
    url,
    joinUrl: url,
  };
}

export async function createHostInvite(baseUrl?: string | URL): Promise<HostInvite> {
  const hostIdentity = await createEphemeralHostIdentity();
  const invite = await createInvite(hostIdentity, baseUrl);
  return { invite, hostIdentity, identity: hostIdentity };
}
