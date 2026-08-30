import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  canonicalize,
  type Binary,
  importP256PublicKey,
  signCanonical,
  spkiFingerprint,
  verifyCanonical,
} from './crypto';

const LOBBY_DOMAIN = 'xo-beta/lobby/v1';
const ENVELOPE_DOMAIN = 'xo-beta/envelope/v1';

function cryptoSubtle(): SubtleCrypto {
  const value = globalThis.crypto;
  if (!value?.subtle) throw new Error('Web Crypto API is unavailable');
  return value.subtle;
}

function copy(value: Binary): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0));
}

export interface HostIdentity {
  readonly keyPair: CryptoKeyPair;
  readonly privateKey: CryptoKey;
  readonly signingKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly hostPublicKey: CryptoKey;
  readonly publicKeySpki: Uint8Array;
  readonly publicKeySpkiBase64Url: string;
  readonly spki: Uint8Array;
  /** Lowercase hexadecimal SHA-256 digest of the DER SPKI bytes. */
  readonly fingerprint: string;
  readonly spkiFingerprint: string;
  readonly publicKeyFingerprint: string;
  readonly fingerprintBytes: Uint8Array;
  readonly fingerprintBase64Url: string;
}

/** Generate a fresh, in-memory P-256 ECDSA identity for one host session. */
export async function generateHostIdentity(): Promise<HostIdentity> {
  const keyPair = await cryptoSubtle().generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const publicKeySpki = new Uint8Array(await cryptoSubtle().exportKey('spki', keyPair.publicKey));
  const fingerprintBytes = await spkiFingerprint(publicKeySpki);
  const fingerprint = bytesToHex(fingerprintBytes);
  return {
    keyPair,
    privateKey: keyPair.privateKey,
    signingKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    hostPublicKey: keyPair.publicKey,
    publicKeySpki: copy(publicKeySpki),
    publicKeySpkiBase64Url: base64UrlEncode(publicKeySpki),
    spki: copy(publicKeySpki),
    fingerprint,
    spkiFingerprint: fingerprint,
    publicKeyFingerprint: fingerprint,
    fingerprintBytes: copy(fingerprintBytes),
    fingerprintBase64Url: base64UrlEncode(fingerprintBytes),
  };
}

/** Explicit aliases used by host/lobby call sites. */
export const createHostIdentity = generateHostIdentity;
export const createEphemeralHostIdentity = generateHostIdentity;
export const generateEphemeralHostIdentity = generateHostIdentity;
export const createHostSigningIdentity = generateHostIdentity;

export interface HostIdentityCommitment {
  readonly publicKeySpki: string;
  readonly hostFingerprint: string;
  readonly fingerprint: string;
}

/** The only host material that belongs in a signed message or invite. */
export function hostIdentityCommitment(identity: HostIdentity): HostIdentityCommitment {
  const fingerprint = normalizeFingerprint(identity.fingerprint);
  const bytesFingerprint = normalizeFingerprint(identity.fingerprintBytes);
  if (!equalText(fingerprint, bytesFingerprint)) throw new TypeError('Host identity fingerprint fields disagree');
  return {
    publicKeySpki: base64UrlEncode(identity.publicKeySpki),
    hostFingerprint: fingerprint,
    fingerprint,
  };
}

export function normalizeFingerprint(value: Binary | string): string {
  if (typeof value !== 'string') {
    const bytes = copy(value);
    if (bytes.length !== 32) throw new TypeError('SPKI fingerprint must be 32 bytes');
    return bytesToHex(bytes);
  }
  const text = value.trim().replace(/^sha256\//iu, '');
  if (/^(?:[0-9a-fA-F]{2}){32}$/.test(text)) return text.toLowerCase();
  const bytes = base64UrlDecode(text);
  if (bytes.length !== 32) throw new TypeError('SPKI fingerprint must be 32 bytes');
  return bytesToHex(bytes);
}

function equalText(left: string, right: string): boolean {
  return left.length === right.length && [...left].every((char, index) => char === right[index]);
}

type PublicKeySource = HostIdentity | CryptoKey | Binary | string;

function isHostIdentity(value: PublicKeySource): value is HostIdentity {
  return typeof value === 'object' && value !== null && 'privateKey' in value && 'publicKeySpki' in value;
}

async function publicKeyFor(source: PublicKeySource): Promise<CryptoKey> {
  if (isHostIdentity(source)) return source.publicKey;
  if (source instanceof CryptoKey) return source;
  return importP256PublicKey(source);
}

async function fingerprintForSource(source: PublicKeySource): Promise<string> {
  let spki: Uint8Array;
  if (isHostIdentity(source)) {
    spki = copy(source.publicKeySpki);
  } else if (source instanceof CryptoKey) {
    spki = new Uint8Array(await cryptoSubtle().exportKey('spki', source));
  } else {
    spki = typeof source === 'string' ? base64UrlDecode(source) : copy(source);
  }
  const fingerprint = normalizeFingerprint(await spkiFingerprint(spki));
  if (isHostIdentity(source) && !equalText(fingerprint, normalizeFingerprint(source.fingerprint))) {
    throw new TypeError('Host identity fingerprint does not match its public key');
  }
  return fingerprint;
}

interface SignedBase<T> {
  readonly version: 1;
  readonly kind: 'lobby' | 'envelope';
  readonly type: 'lobby' | 'envelope';
  readonly payload: T;
  readonly signature: string;
  readonly sig: string;
  readonly publicKey: string;
  readonly hostPublicKey: string;
  readonly publicKeySpki: string;
  readonly spki: string;
  readonly hostFingerprint: string;
  readonly fingerprint: string;
}

export interface SignedLobby<T = unknown> extends SignedBase<T> {
  readonly kind: 'lobby';
  readonly type: 'lobby';
  readonly lobby: T;
}

export interface SignedEnvelope<T = unknown> extends SignedBase<T> {
  readonly kind: 'envelope';
  readonly type: 'envelope';
  readonly envelope: T;
}

type SignedMessage<T> = SignedLobby<T> | SignedEnvelope<T>;

async function signDomain<T>(identity: HostIdentity, payload: T, domain: string): Promise<string> {
  return signCanonical(identity.privateKey, { domain, payload });
}

function signedMetadata(identity: HostIdentity): Omit<SignedBase<unknown>, 'version' | 'kind' | 'type' | 'payload' | 'signature' | 'sig'> {
  const commitment = hostIdentityCommitment(identity);
  return {
    publicKey: commitment.publicKeySpki,
    hostPublicKey: commitment.publicKeySpki,
    publicKeySpki: commitment.publicKeySpki,
    spki: commitment.publicKeySpki,
    hostFingerprint: commitment.hostFingerprint,
    fingerprint: commitment.fingerprint,
  };
}

export async function signLobby<T>(identity: HostIdentity, lobby: T): Promise<SignedLobby<T>> {
  const signature = await signDomain(identity, lobby, LOBBY_DOMAIN);
  return {
    version: 1,
    kind: 'lobby',
    type: 'lobby',
    payload: lobby,
    lobby,
    signature,
    sig: signature,
    ...signedMetadata(identity),
  };
}

export async function signEnvelope<T>(identity: HostIdentity, envelope: T): Promise<SignedEnvelope<T>> {
  const signature = await signDomain(identity, envelope, ENVELOPE_DOMAIN);
  return {
    version: 1,
    kind: 'envelope',
    type: 'envelope',
    payload: envelope,
    envelope,
    signature,
    sig: signature,
    ...signedMetadata(identity),
  };
}

export const signLobbySnapshot = signLobby;
export const signSignedEnvelope = signEnvelope;

function field(message: Record<string, unknown>, names: readonly string[]): unknown | undefined {
  let result: unknown | undefined;
  let found = false;
  for (const name of names) {
    if (!(name in message)) continue;
    const value = message[name];
    if (!found) {
      result = value;
      found = true;
    } else {
      try {
        if (canonicalize(result) !== canonicalize(value)) return null;
      } catch {
        return null;
      }
    }
  }
  return found ? result : undefined;
}

function payloadField(message: Record<string, unknown>, alias: 'lobby' | 'envelope'): unknown | undefined {
  return field(message, ['payload', alias]);
}

async function verifySigned(
  message: SignedMessage<unknown>,
  expectedFingerprint: Binary | string | undefined,
  domain: string,
  alias: 'lobby' | 'envelope',
): Promise<boolean> {
  try {
    const record = message as unknown as Record<string, unknown>;
    if (record.version !== 1 || record.kind !== alias || record.type !== alias) return false;
    const payload = payloadField(record, alias);
    const signature = field(record, ['signature', 'sig']);
    const publicKeyText = field(record, ['publicKey', 'hostPublicKey', 'publicKeySpki', 'spki']);
    const fingerprintText = field(record, ['hostFingerprint', 'fingerprint']);
    if (payload === undefined || typeof signature !== 'string' || typeof publicKeyText !== 'string' || typeof fingerprintText !== 'string') return false;
    const publicKeySpki = base64UrlDecode(publicKeyText);
    const actualFingerprint = normalizeFingerprint(await spkiFingerprint(publicKeySpki));
    const claimedFingerprint = normalizeFingerprint(fingerprintText);
    if (!equalText(actualFingerprint, claimedFingerprint)) return false;
    if (expectedFingerprint !== undefined && !equalText(actualFingerprint, normalizeFingerprint(expectedFingerprint))) return false;
    const publicKey = await publicKeyFor(publicKeySpki);
    return verifyCanonical(publicKey, { domain, payload }, signature);
  } catch {
    return false;
  }
}

export async function verifySignedLobby(
  message: SignedLobby<unknown>,
  expectedFingerprint?: Binary | string,
): Promise<boolean> {
  return verifySigned(message, expectedFingerprint, LOBBY_DOMAIN, 'lobby');
}

export async function verifySignedEnvelope(
  message: SignedEnvelope<unknown>,
  expectedFingerprint?: Binary | string,
): Promise<boolean> {
  return verifySigned(message, expectedFingerprint, ENVELOPE_DOMAIN, 'envelope');
}

/** Verify a complete signed lobby, or a raw key/payload/signature tuple. */
export async function verifyLobby<T>(
  messageOrKey: SignedLobby<T> | PublicKeySource,
  payloadOrFingerprint?: T | Binary | string,
  signature?: Binary | string,
  expectedFingerprint?: Binary | string,
): Promise<boolean> {
  if (typeof messageOrKey === 'object' && messageOrKey !== null && 'signature' in messageOrKey) {
    return verifySignedLobby(messageOrKey as SignedLobby<unknown>, payloadOrFingerprint as Binary | string | undefined);
  }
  if (payloadOrFingerprint === undefined || signature === undefined) return false;
  try {
    const key = await publicKeyFor(messageOrKey);
    if (expectedFingerprint !== undefined) {
      const actualFingerprint = await fingerprintForSource(messageOrKey);
      if (!equalText(actualFingerprint, normalizeFingerprint(expectedFingerprint))) return false;
    }
    return verifyCanonical(key, { domain: LOBBY_DOMAIN, payload: payloadOrFingerprint }, signature);
  } catch {
    return false;
  }
}

/** Verify a complete signed envelope, or a raw key/payload/signature tuple. */
export async function verifyEnvelope<T>(
  messageOrKey: SignedEnvelope<T> | PublicKeySource,
  payloadOrFingerprint?: T | Binary | string,
  signature?: Binary | string,
  expectedFingerprint?: Binary | string,
): Promise<boolean> {
  if (typeof messageOrKey === 'object' && messageOrKey !== null && 'signature' in messageOrKey) {
    return verifySignedEnvelope(messageOrKey as SignedEnvelope<unknown>, payloadOrFingerprint as Binary | string | undefined);
  }
  if (payloadOrFingerprint === undefined || signature === undefined) return false;
  try {
    const key = await publicKeyFor(messageOrKey);
    if (expectedFingerprint !== undefined) {
      const actualFingerprint = await fingerprintForSource(messageOrKey);
      if (!equalText(actualFingerprint, normalizeFingerprint(expectedFingerprint))) return false;
    }
    return verifyCanonical(key, { domain: ENVELOPE_DOMAIN, payload: payloadOrFingerprint }, signature);
  } catch {
    return false;
  }
}

export const verifyLobbySignature = verifyLobby;
export const verifyEnvelopeSignature = verifyEnvelope;
export const verifyLobbySnapshot = verifySignedLobby;
export const verifySignedMessage = verifyEnvelope;
