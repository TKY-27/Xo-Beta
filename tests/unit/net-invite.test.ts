import { describe, expect, it } from 'vitest';
import {
  createHostInvite,
  createInvite,
  createInviteUrl,
  decodeCrockfordBase32,
  parseInviteFragment,
  parseInviteToken,
} from '../../src/net/invite';
import { deriveInviteSecrets } from '../../src/net/crypto';
import { createEphemeralHostIdentity } from '../../src/net/hostIdentity';

function alternateTokenCharacter(token: string): string {
  const index = token.search(/[0-9A-HJ-NP-TV-Z]/u);
  if (index < 0) throw new Error('Expected a token symbol');
  const replacement = token[index] === '0' ? '1' : '0';
  return `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
}

describe('Phase 3 invite tokens', () => {
  it('uses a random root secret and commits the ephemeral host fingerprint', async () => {
    const host = await createEphemeralHostIdentity();
    const invite = await createInvite(host);

    expect(invite.rootSecret.byteLength).toBeGreaterThanOrEqual(16);
    expect(invite.rootSecret.byteLength).toBe(32);
    expect(invite.hostFingerprint).toBe(host.fingerprint);
    expect(invite.token).toMatch(/^[0-9A-HJ-NP-TV-Z]+(?:-[0-9A-HJ-NP-TV-Z]+)*$/u);
    expect(invite.url).toBe(invite.fragment);

    const parsed = parseInviteToken(invite.token);
    expect(Array.from(parsed.rootSecret)).toEqual(Array.from(invite.rootSecret));
    expect(parsed.hostFingerprint).toBe(host.fingerprint);
  });

  it('round-trips case-insensitively and ignores spaces and hyphens', async () => {
    const invite = await createInvite();
    const compact = invite.token.replaceAll('-', '');
    const decorated = compact.toLowerCase().replace(/(.{4})/gu, '$1 - ');
    const parsed = parseInviteToken(decorated);
    expect(parsed.token).toBe(invite.token);
    expect(parseInviteFragment(invite.fragment).token).toBe(invite.token);
  });

  it('rejects a changed symbol, ambiguous Crockford characters, and invalid input', async () => {
    const invite = await createInvite();
    expect(() => parseInviteToken(alternateTokenCharacter(invite.token))).toThrow();
    for (const character of ['I', 'L', 'O', 'U', '#']) {
      expect(() => parseInviteToken(`${invite.token}${character}`)).toThrow();
    }
    expect(() => decodeCrockfordBase32('I')).toThrow(/ambiguous/u);
    expect(() => parseInviteToken('')).toThrow();
    expect(() => parseInviteToken('0'.repeat(257))).toThrow(/too long/u);
  });

  it('places the token only in a #join fragment and does not read query/path joins', async () => {
    const invite = await createInvite();
    const url = createInviteUrl(invite, 'https://example.test/play?join=wrong');
    const parsedUrl = new URL(url);
    expect(parsedUrl.hash).toBe(invite.fragment);
    expect(parsedUrl.search).toBe('?join=wrong');
    expect(parsedUrl.pathname).toBe('/play');
    expect(() => parseInviteFragment('https://example.test/play?join=' + invite.token)).toThrow();
    expect(parseInviteFragment(parsedUrl.hash).hostFingerprint).toBe(invite.hostFingerprint);

    const optionsInvite = await createInvite({ baseUrl: 'https://example.test/rooms' });
    expect(new URL(optionsInvite.url).hash).toBe(optionsInvite.fragment);
  });

  it('derives five distinct invite-scoped values with host-context separation', async () => {
    const host = await createEphemeralHostIdentity();
    const invite = await createInvite(host);
    const first = await deriveInviteSecrets(invite.rootSecret, invite.hostFingerprint);
    const second = await deriveInviteSecrets(invite.rootSecret, '00'.repeat(32));
    const values = [
      first.discoveryRoomId,
      first.signalingPassword,
      first.reconnectNamespace,
      JSON.stringify(Array.from(first.lobbyAuthenticationKey)),
      JSON.stringify(Array.from(first.protocolSessionBinding)),
    ];
    expect(new Set(values).size).toBe(values.length);
    expect(first.discoveryRoomId).not.toBe(second.discoveryRoomId);
    expect(first.signalingPassword).not.toBe(second.signalingPassword);
    await expect(deriveInviteSecrets(invite.rootSecret, new Uint8Array(31))).rejects.toThrow(/32 bytes/u);
  });

  it('returns the host identity alongside a new host invite', async () => {
    const result = await createHostInvite();
    expect(result.hostIdentity.fingerprint).toBe(result.invite.hostFingerprint);
    expect(result.identity.publicKeySpki).toEqual(result.hostIdentity.publicKeySpki);
  });
});
