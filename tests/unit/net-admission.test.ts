import { describe, expect, it } from 'vitest';
import {
  createAdmissionRequest,
  signAdmissionResponse,
  validateAdmissionRequest,
  validateAdmissionResponse,
} from '../../src/net/admission';
import { deriveInviteSecrets, randomBytes } from '../../src/net/crypto';
import { createHostIdentity } from '../../src/net/hostIdentity';
import { createInvite } from '../../src/net/invite';
import { PROTOCOL_FEATURES, PROTOCOL_VERSION, type BuildIdentity } from '../../src/net/protocol';

const build: BuildIdentity = {
  protocolVersion: PROTOCOL_VERSION,
  buildId: 'test-build',
  features: PROTOCOL_FEATURES,
};

describe('private-room admission', () => {
  it('authenticates a normalized bounded request with the derived room key', async () => {
    const identity = await createHostIdentity();
    const invite = await createInvite(identity, 'https://example.test/game');
    const keys = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const request = await createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: 'participant-1',
      protocolSession: 'session-1',
      displayName: 'Cafe\u0301',
      skinId: 'specter',
      requestedSlot: 2,
      lobbyAuthenticationKey: keys.lobbyAuthenticationKey,
      nonce: 'fresh-nonce',
      now: 1_000,
    });

    const accepted = await validateAdmissionRequest(request, keys.lobbyAuthenticationKey, {
      build,
      hostFingerprint: invite.hostFingerprint,
      now: 1_001,
    });
    expect(accepted.displayName).toBe('Café');
    expect(accepted.requestedSlot).toBe(2);
    expect(JSON.stringify(accepted)).not.toContain(Buffer.from(invite.rootSecret).toString('hex'));
  });

  it('rejects a wrong room proof, host identity, stale request, and oversized payload', async () => {
    const identity = await createHostIdentity();
    const invite = await createInvite(identity, 'https://example.test/');
    const keys = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const request = await createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: 'participant-1',
      protocolSession: 'session-1',
      displayName: 'Guest',
      skinId: 'vanguard',
      lobbyAuthenticationKey: keys.lobbyAuthenticationKey,
      nonce: 'fresh-nonce',
      now: 1_000,
    });

    await expect(validateAdmissionRequest(request, randomBytes(32), {
      build,
      hostFingerprint: invite.hostFingerprint,
      now: 1_001,
    })).rejects.toThrow('wrong-secret');
    await expect(validateAdmissionRequest(request, keys.lobbyAuthenticationKey, {
      build,
      hostFingerprint: 'ab'.repeat(32),
      now: 1_001,
    })).rejects.toThrow('wrong-secret');
    await expect(validateAdmissionRequest(request, keys.lobbyAuthenticationKey, {
      build,
      hostFingerprint: invite.hostFingerprint,
      now: 50_000,
    })).rejects.toThrow('stale-admission');
    await expect(validateAdmissionRequest({ ...request, padding: 'x'.repeat(20_000) }, keys.lobbyAuthenticationKey, {
      build,
      hostFingerprint: invite.hostFingerprint,
      now: 1_001,
    })).rejects.toThrow('payload-too-large');

    await expect(createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: 'false-reconnect-identity',
      protocolSession: 'session-2',
      displayName: 'Guest',
      skinId: 'vanguard',
      reconnectToken: 'A'.repeat(32),
      lobbyAuthenticationKey: keys.lobbyAuthenticationKey,
    })).rejects.toThrow(/participantId/u);

    await expect(createAdmissionRequest({
      build,
      expectedHostFingerprint: invite.hostFingerprint,
      participantId: null,
      protocolSession: 'session-2',
      displayName: 'Guest',
      skinId: 'vanguard',
      reconnectToken: 'A'.repeat(32),
      lobbyAuthenticationKey: keys.lobbyAuthenticationKey,
    })).resolves.toMatchObject({ participantId: null, reconnectToken: 'A'.repeat(32) });
  });

  it('accepts only the invite-committed host signature and matching build', async () => {
    const identity = await createHostIdentity();
    const other = await createHostIdentity();
    const payload = {
      type: 'admission-response' as const,
      version: 1 as const,
      accepted: true as const,
      role: 'host' as const,
      requestNonce: 'request-nonce',
      hostPeerId: 'host-peer',
      participantId: 'participant-1',
      slotId: 1,
      protocolSession: 'session-1',
      reconnectToken: 'A'.repeat(32),
      build,
      lobby: { revision: 1 },
    };
    const signed = await signAdmissionResponse(identity, payload);

    await expect(validateAdmissionResponse(
      signed,
      identity.fingerprint,
      payload.requestNonce,
      build,
    )).resolves.toEqual(payload);
    await expect(validateAdmissionResponse(
      signed,
      other.fingerprint,
      payload.requestNonce,
      build,
    )).rejects.toThrow('wrong-secret');
    await expect(validateAdmissionResponse(
      { ...signed, payload: { ...payload, slotId: 2 }, envelope: { ...payload, slotId: 2 } },
      identity.fingerprint,
      payload.requestNonce,
      build,
    )).rejects.toThrow('wrong-secret');
    await expect(validateAdmissionResponse(
      signed,
      identity.fingerprint,
      payload.requestNonce,
      { ...build, buildId: 'other-build' },
    )).rejects.toThrow('incompatible');
  });
});
