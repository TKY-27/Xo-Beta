import { describe, expect, it } from 'vitest';
import {
  createEphemeralHostIdentity,
  normalizeFingerprint,
  signEnvelope,
  signLobby,
  verifyEnvelope,
  verifyLobby,
  verifySignedEnvelope,
  verifySignedLobby,
} from '../../src/net/hostIdentity';
import { base64UrlEncode, canonicalize } from '../../src/net/crypto';

describe('Phase 3 host identity and signed messages', () => {
  it('generates an ephemeral P-256 key and a stable SPKI fingerprint', async () => {
    const identity = await createEphemeralHostIdentity();
    expect(identity.privateKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(identity.publicKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(identity.publicKeySpki.byteLength).toBeGreaterThan(0);
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(normalizeFingerprint(identity.fingerprintBase64Url)).toBe(identity.fingerprint);
  });

  it('signs and verifies canonical lobby and envelope payloads', async () => {
    const identity = await createEphemeralHostIdentity();
    const lobby = { z: 3, a: 'ready', members: [{ id: 'host', slot: 0 }] };
    const signedLobby = await signLobby(identity, lobby);
    expect(await verifySignedLobby(signedLobby, identity.fingerprint)).toBe(true);
    expect(await verifyLobby(signedLobby, identity.fingerprint)).toBe(true);
    expect(await verifyLobby(identity.publicKey, { a: 'ready', members: [{ id: 'host', slot: 0 }], z: 3 }, signedLobby.signature)).toBe(true);
    expect(await verifyLobby(identity.publicKey, lobby, signedLobby.signature, identity.fingerprint)).toBe(true);
    expect(await verifyLobby(identity.publicKey, lobby, signedLobby.signature, '00'.repeat(32))).toBe(false);

    const signedEnvelope = await signEnvelope(identity, { payload: 'hello', sequence: 1 });
    expect(await verifySignedEnvelope(signedEnvelope, identity.fingerprint)).toBe(true);
    expect(await verifyEnvelope(signedEnvelope, identity.fingerprint)).toBe(true);
    expect(await verifyLobby(signedEnvelope as never, identity.fingerprint)).toBe(false);
  });

  it('rejects payload, key, fingerprint, and cross-domain tampering', async () => {
    const identity = await createEphemeralHostIdentity();
    const signed = await signLobby(identity, { map: 'neocity', ready: true });
    expect(await verifySignedLobby({ ...signed, payload: { map: 'oldfront', ready: true } })).toBe(false);
    expect(await verifySignedLobby({ ...signed, lobby: { map: 'oldfront', ready: true } })).toBe(false);
    expect(await verifySignedLobby({ ...signed, hostFingerprint: '00'.repeat(32), fingerprint: '00'.repeat(32) })).toBe(false);
    expect(await verifySignedLobby({ ...signed, publicKey: base64UrlEncode(new Uint8Array([1, 2, 3])) })).toBe(false);
    expect(await verifySignedLobby(signed, '00'.repeat(32))).toBe(false);
    expect(await verifyEnvelope(signed as never, identity.fingerprint)).toBe(false);
  });

  it('canonicalizes object key order while rejecting unsupported values', () => {
    expect(canonicalize({ b: 2, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":2}');
    expect(() => canonicalize({ value: Number.NaN })).toThrow(/Non-finite/u);
    expect(() => canonicalize({ value: undefined })).toThrow(/Undefined/u);
  });
});
