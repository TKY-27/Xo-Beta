import { describe, expect, it } from 'vitest';
import {
  CHANNEL_CONFIGS,
  FAKE_MATCH_CHANNELS,
  FakeMatchTransport,
  createFakeMatchHarness,
  type FakeMatchChannel,
  type FakeTransportMessage,
} from '../../src/net/fakeTransport';

function collect(transport: FakeMatchTransport, endpoint = 'guest'): FakeTransportMessage[] {
  const messages: FakeTransportMessage[] = [];
  transport.endpoint(endpoint).onMessage((message) => messages.push(message));
  return messages;
}

describe('deterministic fake match transport', () => {
  it('keeps channel contracts explicit and delivers only after manual latency', () => {
    expect(FAKE_MATCH_CHANNELS).toEqual(['control', 'event', 'input', 'snapshot']);
    expect(CHANNEL_CONFIGS.control).toMatchObject({ ordered: true, reliable: true, maxRetransmits: null });
    expect(CHANNEL_CONFIGS.event).toMatchObject({ ordered: true, reliable: true, maxRetransmits: null });
    expect(CHANNEL_CONFIGS.input).toMatchObject({ ordered: false, reliable: false, maxRetransmits: 0 });
    expect(CHANNEL_CONFIGS.snapshot).toMatchObject({ ordered: false, reliable: false, maxRetransmits: 0 });

    const transport = new FakeMatchTransport({ latencyMs: 25, seed: 7 });
    const received = collect(transport);
    expect(transport.host.send('control', { tick: 1 })).toBe(true);
    expect(received).toHaveLength(0);
    transport.advance(24);
    expect(received).toHaveLength(0);
    transport.advance(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      from: 'host',
      to: 'guest',
      channel: 'control',
      data: { tick: 1 },
      sentAt: 0,
      deliveredAt: 25,
      sequence: 0,
    });
    expect(transport.getMetrics().latency.p50Ms).toBe(25);
  });

  it('reassembles ordered reliable channels under loss, duplication, and reordering', () => {
    const transport = new FakeMatchTransport({
      seed: 42,
      latencyMs: 10,
      lossRate: 0.45,
      duplicateRate: 1,
      reorderRate: 1,
      maxRetries: 12,
      retryDelayMs: 3,
    });
    const received = collect(transport);
    for (let tick = 0; tick < 20; tick += 1) expect(transport.host.send('event', { tick })).toBe(true);
    transport.flushAll();
    expect(received.map((message) => (message.data as { tick: number }).tick)).toEqual(
      Array.from({ length: 20 }, (_, tick) => tick),
    );
    expect(new Set(received.map((message) => message.sequence)).size).toBe(20);
    expect(transport.getMetrics().retries).toBeGreaterThan(0);
    expect(transport.getMetrics().duplicates).toBeGreaterThan(0);
    expect(transport.getMetrics().reordered).toBeGreaterThan(0);
    expect(transport.queueDepth).toBe(0);
  });

  it('keeps unordered lossy channels lossy and exposes deterministic duplicate/reorder metrics', () => {
    const options = {
      seed: 99,
      latencyMs: 5,
      lossRate: 0.35,
      duplicateRate: 0.5,
      reorderRate: 1,
    } as const;
    const first = new FakeMatchTransport(options);
    const second = new FakeMatchTransport(options);
    const firstReceived = collect(first);
    const secondReceived = collect(second);
    for (let tick = 0; tick < 50; tick += 1) {
      expect(first.host.send('snapshot', { tick })).toBe(true);
      expect(second.host.send('snapshot', { tick })).toBe(true);
    }
    first.flushAll();
    second.flushAll();
    expect(firstReceived).toEqual(secondReceived);
    expect(first.getMetrics()).toEqual(second.getMetrics());
    expect(firstReceived.length).toBeLessThanOrEqual(75);
    expect(first.getMetrics().lost).toBeGreaterThan(0);
    expect(first.getMetrics().duplicates).toBeGreaterThan(0);
    expect(first.getMetrics().reordered).toBeGreaterThan(0);
  });

  it('bounds queued messages and bytes rather than growing an application queue', () => {
    const transport = new FakeMatchTransport({
      latencyMs: 1_000,
      maxQueueMessages: 3,
      maxQueueBytes: 30,
    });
    const accepted = Array.from({ length: 20 }, (_, tick) => transport.host.send('control', `tick-${tick}`));
    expect(accepted.filter(Boolean)).toHaveLength(3);
    expect(transport.queueDepth).toBe(3);
    expect(transport.queueBytes).toBeLessThanOrEqual(30);
    expect(transport.getMetrics().queueDepth).toBe(3);
    expect(transport.getMetrics().maxQueueDepth).toBe(3);
    expect(transport.getMetrics().queueRejected).toBeGreaterThan(0);
    transport.flushAll();
    expect(transport.queueDepth).toBe(0);
  });

  it('defers reliable packets through a temporary disconnect and drops lossy packets', () => {
    const transport = new FakeMatchTransport({ latencyMs: 10, retryDelayMs: 5, maxRetries: 20 });
    const received = collect(transport);
    transport.temporaryDisconnect('host', 'guest', 30);
    expect(transport.host.send('control', 'reliable')).toBe(false);
    transport.advance(30);
    expect(transport.host.send('control', 'reliable')).toBe(true);
    expect(transport.host.send('snapshot', 'lossy')).toBe(true);
    transport.disconnect('host', 'guest');
    transport.advance(100);
    expect(received).toHaveLength(0);
    transport.reconnect('host', 'guest');
    expect(transport.host.send('control', 'after-reconnect')).toBe(true);
    transport.flushAll();
    expect(received.map((message) => message.data)).toEqual(['reliable', 'after-reconnect']);
    expect(transport.getMetrics().disconnectedDrops).toBeGreaterThan(0);
  });

  it('supports stale and malformed application injection without a network dependency', () => {
    const transport = new FakeMatchTransport({ latencyMs: 5 });
    const received = collect(transport);
    const staleId = transport.injectStale('guest', 'snapshot', { tick: 3 });
    const malformedId = transport.injectMalformed('guest', 'control', { invalid: true });
    expect(staleId).toBeGreaterThan(0);
    expect(malformedId).toBeGreaterThan(staleId);
    transport.flushAll();
    expect(received.map((message) => [message.kind, message.data])).toEqual([
      ['stale', { tick: 3 }],
      ['malformed', { invalid: true }],
    ]);
    expect(transport.getMetrics()).toMatchObject({ staleInjected: 1, malformedInjected: 1, malformedDelivered: 1 });
  });

  it('applies the same fault matrix to every channel without leaking mutable metrics state', () => {
    const transport = new FakeMatchTransport({ latencyMs: 0, maxQueueMessages: 16, maxRetries: 2 });
    const received: FakeTransportMessage[] = [];
    transport.guest.onMessage((message) => received.push(message));
    for (const channel of FAKE_MATCH_CHANNELS) {
      expect(transport.host.send(channel, channel)).toBe(true);
    }
    transport.flush();
    expect(received.map((message) => message.channel)).toEqual([...FAKE_MATCH_CHANNELS]);
    const snapshot = transport.getMetrics();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.perChannel)).toBe(true);
    expect(Object.isFrozen(snapshot.perChannel.control)).toBe(true);
    const depth = snapshot.queueDepth;
    expect(() => {
      (snapshot.perChannel.control as { sent: number }).sent = 999;
    }).toThrow();
    expect(transport.getMetrics().queueDepth).toBe(depth);
  });

  it('supports additional endpoints and explicit endpoint pairing', () => {
    const transport = new FakeMatchTransport({ endpointIds: ['host', 'guest', 'spectator'], latencyMs: 2 });
    const spectator = transport.endpoint('spectator');
    spectator.setRemote('host');
    const received = collect(transport, 'host');
    expect(spectator.send('event', { role: 'spectator' })).toBe(true);
    transport.advance(2);
    expect(received[0]).toMatchObject({ from: 'spectator', to: 'host', data: { role: 'spectator' } });
  });

  it('rejects invalid probabilities, clocks, and unknown channels early', () => {
    expect(() => new FakeMatchTransport({ lossRate: 1.1 })).toThrow(/lossRate/u);
    expect(() => new FakeMatchTransport({ jitterMs: -1 })).toThrow(/jitterMs/u);
    const transport = new FakeMatchTransport();
    expect(() => transport.advance(-1)).toThrow(/advance/u);
    expect(() => transport.send('host', 'guest', 'nope' as FakeMatchChannel, 'x')).toThrow(/channel/u);
  });
});

describe('fake match harness factory', () => {
  it('returns paired endpoints and delegates clock/metrics controls', () => {
    const harness = createFakeMatchHarness({ latencyMs: 3 });
    const received: FakeTransportMessage[] = [];
    harness.guest.onMessage((message) => received.push(message));
    expect(harness.host.sendControl('hello')).toBe(true);
    harness.advance(3);
    expect(received).toHaveLength(1);
    expect(harness.getMetrics().delivered).toBe(1);
    expect(harness.endpoints.host).toBe(harness.host);
    expect(harness.endpoints.guest).toBe(harness.guest);
  });
});
