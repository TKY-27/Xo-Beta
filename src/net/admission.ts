import type { SkinId } from '../core/settings';
import { VALID_SKIN_IDS } from '../sim/roster';
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalize,
  randomBytes,
  utf8,
} from './crypto';
import {
  signEnvelope,
  verifySignedEnvelope,
  type HostIdentity,
  type SignedEnvelope,
} from './hostIdentity';
import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PROTOCOL_PAYLOAD_BYTES,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  validateBuildIdentity,
  type BuildIdentity,
  type ProtocolFeature,
} from './protocol';

export const ADMISSION_VERSION = 1 as const;
export const ADMISSION_MAX_AGE_MS = 30_000;

export type AdmissionRejectCode =
  | 'incompatible'
  | 'room-full'
  | 'wrong-secret'
  | 'invalid-request'
  | 'duplicate-peer'
  | 'invalid-reconnect'
  | 'match-locked';

export interface AdmissionRequest {
  readonly type: 'admission-request';
  readonly version: typeof ADMISSION_VERSION;
  readonly role: 'participant';
  readonly protocolVersion: number;
  readonly buildId: string;
  readonly features: readonly ProtocolFeature[];
  readonly expectedHostFingerprint: string;
  /** Fresh admission proposes an ID; reconnect admission uses null and the host-side token binding. */
  readonly participantId: string | null;
  readonly protocolSession: string;
  readonly displayName: string;
  readonly skinId: SkinId;
  readonly requestedSlot: number | null;
  readonly reconnectToken: string | null;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly proof: string;
}

export interface AdmissionAcceptedPayload {
  readonly type: 'admission-response';
  readonly version: typeof ADMISSION_VERSION;
  readonly accepted: true;
  readonly role: 'host';
  readonly requestNonce: string;
  readonly hostPeerId: string;
  readonly participantId: string;
  readonly slotId: number;
  readonly protocolSession: string;
  readonly reconnectToken: string;
  readonly build: BuildIdentity;
  readonly lobby: unknown;
}

export interface AdmissionRejectedPayload {
  readonly type: 'admission-response';
  readonly version: typeof ADMISSION_VERSION;
  readonly accepted: false;
  readonly role: 'host';
  readonly requestNonce: string;
  readonly code: AdmissionRejectCode;
}

export type AdmissionResponsePayload = AdmissionAcceptedPayload | AdmissionRejectedPayload;
export type SignedAdmissionResponse = SignedEnvelope<AdmissionResponsePayload>;

interface CreateAdmissionRequestOptions {
  readonly build: BuildIdentity;
  readonly expectedHostFingerprint: string;
  readonly participantId: string | null;
  readonly protocolSession: string;
  readonly displayName: string;
  readonly skinId: SkinId;
  readonly lobbyAuthenticationKey: Uint8Array;
  readonly requestedSlot?: number | null;
  readonly reconnectToken?: string | null;
  readonly now?: number;
  readonly nonce?: string;
}

const REQUEST_KEYS = Object.freeze([
  'type', 'version', 'role', 'protocolVersion', 'buildId', 'features',
  'expectedHostFingerprint', 'participantId', 'protocolSession', 'displayName',
  'skinId', 'requestedSlot', 'reconnectToken', 'nonce', 'issuedAt', 'proof',
]);
const ACCEPTED_RESPONSE_KEYS = Object.freeze([
  'type', 'version', 'accepted', 'role', 'requestNonce', 'hostPeerId',
  'participantId', 'slotId', 'protocolSession', 'reconnectToken', 'build', 'lobby',
]);
const REJECTED_RESPONSE_KEYS = Object.freeze([
  'type', 'version', 'accepted', 'role', 'requestNonce', 'code',
]);

export async function createAdmissionRequest(options: CreateAdmissionRequestOptions): Promise<AdmissionRequest> {
  const requestWithoutProof = {
    type: 'admission-request' as const,
    version: ADMISSION_VERSION,
    role: 'participant' as const,
    protocolVersion: options.build.protocolVersion,
    buildId: options.build.buildId,
    features: [...options.build.features],
    expectedHostFingerprint: options.expectedHostFingerprint,
    participantId: options.participantId,
    protocolSession: options.protocolSession,
    displayName: normalizeDisplayName(options.displayName),
    skinId: validateSkin(options.skinId),
    requestedSlot: validateRequestedSlot(options.requestedSlot ?? null),
    reconnectToken: validateOptionalToken(options.reconnectToken ?? null),
    nonce: options.nonce ?? randomId(18),
    issuedAt: Math.floor(options.now ?? Date.now()),
  };
  validateRequestFields(requestWithoutProof);
  const proof = await hmac(options.lobbyAuthenticationKey, requestWithoutProof);
  return Object.freeze({ ...requestWithoutProof, features: Object.freeze([...requestWithoutProof.features]), proof });
}

export async function validateAdmissionRequest(
  value: unknown,
  key: Uint8Array,
  expected: {
    readonly build: BuildIdentity;
    readonly hostFingerprint: string;
    readonly now?: number;
  },
): Promise<AdmissionRequest> {
  assertPayloadSize(value);
  const record = requireRecord(value);
  assertExactKeys(record, REQUEST_KEYS);
  const request: AdmissionRequest = {
    type: expect(record.type, 'admission-request', 'type'),
    version: expect(record.version, ADMISSION_VERSION, 'version'),
    role: expect(record.role, 'participant', 'role'),
    protocolVersion: integer(record.protocolVersion, 'protocolVersion'),
    buildId: identifier(record.buildId, 'buildId'),
    features: validateFeatures(record.features),
    expectedHostFingerprint: fingerprint(record.expectedHostFingerprint),
    participantId: optionalIdentifier(record.participantId, 'participantId'),
    protocolSession: identifier(record.protocolSession, 'protocolSession'),
    displayName: normalizeDisplayName(record.displayName),
    skinId: validateSkin(record.skinId),
    requestedSlot: validateRequestedSlot(record.requestedSlot),
    reconnectToken: validateOptionalToken(record.reconnectToken),
    nonce: identifier(record.nonce, 'nonce'),
    issuedAt: integer(record.issuedAt, 'issuedAt'),
    proof: base64url(record.proof, 'proof'),
  };
  const { proof, ...proofPayload } = request;
  validateRequestFields(proofPayload);
  if (request.protocolVersion !== PROTOCOL_VERSION
    || request.protocolVersion !== expected.build.protocolVersion
    || request.buildId !== expected.build.buildId
    || !sameFeatures(request.features, expected.build.features)) {
    throw new Error('incompatible');
  }
  if (request.expectedHostFingerprint !== fingerprint(expected.hostFingerprint)) {
    throw new Error('wrong-secret');
  }
  const now = Math.floor(expected.now ?? Date.now());
  if (Math.abs(now - request.issuedAt) > ADMISSION_MAX_AGE_MS) throw new Error('stale-admission');
  if (!await verifyHmac(key, proofPayload, proof)) throw new Error('wrong-secret');
  return Object.freeze({ ...request, features: Object.freeze([...request.features]) });
}

export async function signAdmissionResponse(
  identity: HostIdentity,
  payload: AdmissionResponsePayload,
): Promise<SignedAdmissionResponse> {
  validateResponsePayload(payload);
  return signEnvelope(identity, payload);
}

export async function validateAdmissionResponse(
  value: unknown,
  expectedHostFingerprint: string,
  requestNonce: string,
  expectedBuild: BuildIdentity,
): Promise<AdmissionResponsePayload> {
  assertPayloadSize(value);
  if (!await verifySignedEnvelope(value as SignedAdmissionResponse, expectedHostFingerprint)) {
    throw new Error('wrong-secret');
  }
  const payload = (value as SignedAdmissionResponse).payload;
  validateResponsePayload(payload);
  if (payload.requestNonce !== requestNonce || payload.role !== 'host') throw new Error('invalid-response');
  if (payload.accepted && (
    payload.build.protocolVersion !== expectedBuild.protocolVersion
    || payload.build.buildId !== expectedBuild.buildId
    || !sameFeatures(payload.build.features, expectedBuild.features)
  )) throw new Error('incompatible');
  return payload;
}

function validateRequestFields(request: Omit<AdmissionRequest, 'proof'>): void {
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new Error('incompatible');
  identifier(request.buildId, 'buildId');
  validateFeatures(request.features);
  fingerprint(request.expectedHostFingerprint);
  if (request.reconnectToken === null) {
    if (request.participantId === null) throw new Error('invalid-participantId');
    identifier(request.participantId, 'participantId');
  } else if (request.participantId !== null) {
    throw new Error('invalid-participantId');
  }
  identifier(request.protocolSession, 'protocolSession');
  identifier(request.nonce, 'nonce');
  integer(request.issuedAt, 'issuedAt');
}

function validateResponsePayload(payload: AdmissionResponsePayload): void {
  const record = requireRecord(payload);
  if (record.type !== 'admission-response' || record.version !== ADMISSION_VERSION || record.role !== 'host'
    || (record.accepted !== true && record.accepted !== false)) {
    throw new Error('invalid-response');
  }
  identifier(payload.requestNonce, 'requestNonce');
  if (payload.accepted) {
    assertExactKeys(record, ACCEPTED_RESPONSE_KEYS);
    identifier(payload.hostPeerId, 'hostPeerId');
    identifier(payload.participantId, 'participantId');
    integer(payload.slotId, 'slotId');
    if (payload.slotId < 1 || payload.slotId > 3) throw new Error('invalid-response');
    identifier(payload.protocolSession, 'protocolSession');
    identifier(payload.reconnectToken, 'reconnect-token');
    validateBuildIdentity(payload.build);
    requireRecord(payload.lobby);
  } else {
    assertExactKeys(record, REJECTED_RESPONSE_KEYS);
    if (![
      'incompatible', 'room-full', 'wrong-secret', 'invalid-request',
      'duplicate-peer', 'invalid-reconnect', 'match-locked',
    ].includes(payload.code)) throw new Error('invalid-response');
  }
}

async function hmac(keyBytes: Uint8Array, value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey('raw', copyBuffer(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, copyBuffer(utf8(canonicalize(value))));
  return base64UrlEncode(signature);
}

async function verifyHmac(keyBytes: Uint8Array, value: unknown, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', copyBuffer(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('HMAC', key, copyBuffer(base64UrlDecode(signature)), copyBuffer(utf8(canonicalize(value))));
  } catch {
    return false;
  }
}

function copyBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function randomId(bytes: number): string {
  return base64UrlEncode(randomBytes(bytes));
}

function assertPayloadSize(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('invalid-request');
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_PROTOCOL_PAYLOAD_BYTES) throw new Error('payload-too-large');
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid-request');
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error('invalid-request');
}

function expect<T extends string | number>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`invalid-${label}`);
  return expected;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || value !== value.trim() || hasControlCharacter(value)) throw new Error(`invalid-${label}`);
  return value;
}

function optionalIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`invalid-${label}`);
  return value;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid-display-name');
  const normalized = value.normalize('NFC');
  if (normalized.length < 1 || normalized.length > MAX_DISPLAY_NAME_LENGTH
    || normalized !== normalized.trim() || hasControlCharacter(normalized)) throw new Error('invalid-display-name');
  if (new TextEncoder().encode(normalized).byteLength > MAX_DISPLAY_NAME_LENGTH * 4) throw new Error('invalid-display-name');
  return normalized;
}

function validateSkin(value: unknown): SkinId {
  if (typeof value !== 'string' || !VALID_SKIN_IDS.includes(value as SkinId)) throw new Error('invalid-skin');
  return value as SkinId;
}

function validateRequestedSlot(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 3) throw new Error('invalid-requested-slot');
  return value;
}

function validateOptionalToken(value: unknown): string | null {
  if (value === null) return null;
  return identifier(value, 'reconnect-token');
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error('invalid-host-fingerprint');
  return value;
}

function base64url(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/u.test(value)) throw new Error(`invalid-${label}`);
  base64UrlDecode(value);
  return value;
}

function validateFeatures(value: unknown): readonly ProtocolFeature[] {
  if (!Array.isArray(value) || value.length !== PROTOCOL_FEATURES.length) throw new Error('incompatible');
  const features = value.map((item) => {
    if (typeof item !== 'string' || !PROTOCOL_FEATURES.includes(item as ProtocolFeature)) throw new Error('incompatible');
    return item as ProtocolFeature;
  });
  if (new Set(features).size !== features.length) throw new Error('incompatible');
  return Object.freeze(features);
}

function sameFeatures(left: readonly ProtocolFeature[], right: readonly ProtocolFeature[]): boolean {
  return left.length === right.length && [...left].sort().every((feature, index) => feature === [...right].sort()[index]);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}
