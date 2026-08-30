import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ICE_CONFIGURATION,
  PHASE_3_ICE_CONFIGURATION,
  PUBLIC_STUN_SERVER_URLS,
  assertStunOnlyConfiguration,
  createIceConfiguration,
  isRelayIceCandidate,
} from '../../src/net/ice';
import { PUBLIC_NOSTR_RELAYS } from '../../src/net/signaling';

describe('Phase 3 zero-cost ICE boundary', () => {
  it('uses multiple public STUN URLs with the all policy and no credentials', () => {
    expect(PUBLIC_STUN_SERVER_URLS.length).toBeGreaterThanOrEqual(2);
    const configuration = createIceConfiguration();
    expect(configuration.iceTransportPolicy).toBe('all');
    expect(configuration.iceServers).toHaveLength(PUBLIC_STUN_SERVER_URLS.length);
    expect(configuration.iceServers?.every((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.every((url) => url.startsWith('stun:'))
        && server.username === undefined
        && server.credential === undefined;
    })).toBe(true);
    expect(JSON.stringify(configuration)).not.toMatch(/turn:/iu);
    expect(JSON.stringify(configuration)).not.toMatch(/credential/iu);
    expect(JSON.stringify(configuration)).not.toMatch(/cloudflare/iu);
    assertStunOnlyConfiguration(configuration);
  });

  it('does not share mutable server arrays between connections', () => {
    const first = createIceConfiguration();
    const second = createIceConfiguration();
    expect(first).not.toBe(second);
    expect(first.iceServers).not.toBe(second.iceServers);
    first.iceServers?.push({ urls: 'stun:example.invalid:3478' });
    expect(second.iceServers).toHaveLength(PUBLIC_STUN_SERVER_URLS.length);
    expect(PHASE_3_ICE_CONFIGURATION.iceTransportPolicy).toBe('all');
    expect(ICE_CONFIGURATION.iceServers).toHaveLength(PUBLIC_STUN_SERVER_URLS.length);
  });

  it('identifies relay candidates before they reach addIceCandidate', () => {
    expect(isRelayIceCandidate({
      candidate: 'candidate:0 1 udp 1 192.0.2.1 9 typ relay',
    })).toBe(true);
    expect(isRelayIceCandidate({
      candidate: 'candidate:0 1 udp 1 192.0.2.1 9 typ host',
    })).toBe(false);
    expect(isRelayIceCandidate([
      'a=candidate:0 1 udp 1 192.0.2.1 9 typ host',
      'a=candidate:1 1 udp 1 192.0.2.2 9 typ relay',
    ].join('\r\n'))).toBe(true);
  });

  it('keeps production networking source free of TURN configuration and secret logging', () => {
    const networkingFiles = [
      'src/net/ice.ts',
      'src/net/signaling.ts',
      'src/net/gameConnection.ts',
      'src/net/privateRoom.ts',
    ];
    const source = networkingFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/['"`]turns?:/iu);
    expect(source).not.toMatch(/\bturnConfig\b/u);
    expect(source).not.toMatch(/console\.(?:log|info|debug|warn|error)\s*\(/u);
    const signalingSource = readFileSync('src/net/signaling.ts', 'utf8');
    expect(signalingSource).toMatch(/manualReconnection:\s*true/u);
    expect(signalingSource).toMatch(/MAX_RELAY_RECONNECT_ATTEMPTS\s*=\s*3/u);
    expect(signalingSource).toMatch(/onRelayExhausted/u);
  });

  it('allows every pinned relay through the production CSP without a WebSocket wildcard', () => {
    const headers = readFileSync('public/_headers', 'utf8');
    const csp = headers.split('\n').find((line) => line.includes('Content-Security-Policy:')) ?? '';
    for (const relay of PUBLIC_NOSTR_RELAYS) expect(csp).toContain(relay);
    expect(csp).not.toMatch(/(?:^|\s)wss:(?:\s|;)/u);
  });
});
