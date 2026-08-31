import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUFFERED_AMOUNT_LOW_THRESHOLD,
  CHANNEL_CONFIGS,
  GameConnection,
  MAX_BUFFERED_AMOUNT,
  type GameDataChannel,
  type GameProtocolBinding,
  type PeerConnectionFactory,
  type PeerConnectionLike,
  type SignalMessage,
} from '../../src/net/gameConnection';

class FakeChannel implements GameDataChannel {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null = null;
  readyState = 'connecting';
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: ArrayBuffer[] = [];
  closed = false;

  constructor(label: string, options: RTCDataChannelInit) {
    this.label = label;
    this.ordered = options.ordered ?? true;
    this.maxRetransmits = options.maxRetransmits ?? null;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === 'string') {
      this.sent.push(new TextEncoder().encode(data).buffer);
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(data);
    } else {
      this.sent.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = 'closed';
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.(new Event('open'));
  }
}

class FakePeer implements PeerConnectionLike {
  readonly channels: FakeChannel[] = [];
  readonly offers: Array<RTCOfferOptions | undefined> = [];
  readonly answers: Array<RTCAnswerOptions | undefined> = [];
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: { readonly candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { readonly channel: GameDataChannel }) => void) | null = null;
  restartIce = vi.fn();
  close = vi.fn();
  stats = new Map<string, unknown>();

  createDataChannel(label: string, options?: RTCDataChannelInit): GameDataChannel {
    const channel = new FakeChannel(label, options ?? {});
    this.channels.push(channel);
    return channel;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offers.push(options);
    return { type: 'offer', sdp: options?.iceRestart ? 'restart-offer' : 'offer' };
  }

  async createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
    this.answers.push(options);
    return { type: 'answer', sdp: 'answer' };
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (!description?.type) throw new Error('missing local description');
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (!description.type) throw new Error('missing remote description');
    this.remoteDescription = description as RTCSessionDescription;
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
    if (candidate) this.addedCandidates.push(candidate);
  }

  async getStats(): Promise<Map<string, unknown>> {
    return this.stats;
  }

  emitGuestChannel(channel: FakeChannel): void {
    this.ondatachannel?.({ channel });
  }
}

function openAll(peer: FakePeer): void {
  for (const channel of peer.channels) channel.open();
}

const HOST_BINDING: GameProtocolBinding = Object.freeze({
  protocolVersion: 3,
  buildId: 'build-test',
  roomId: 'room-test',
  role: 'host',
  participantId: 'participant-host',
  peerId: 'peer-host',
  protocolSession: 'session-host',
});
const GUEST_BINDING: GameProtocolBinding = Object.freeze({
  protocolVersion: 3,
  buildId: 'build-test',
  roomId: 'room-test',
  role: 'guest',
  participantId: 'participant-guest',
  peerId: 'peer-guest',
  protocolSession: 'session-guest',
});

describe('dedicated WebRTC game connection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates exactly the four host channels with the fixed delivery contract', async () => {
    const peer = new FakePeer();
    const signals: SignalMessage[] = [];
    const factory: PeerConnectionFactory = vi.fn((_configuration) => peer);
    const connection = new GameConnection({
      role: 'host',
      peerConnectionFactory: factory,
      onSignal: (signal) => { signals.push(signal); },
    });

    await connection.start();

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ iceTransportPolicy: 'all' }));
    expect(peer.channels.map((channel) => channel.label)).toEqual(['control', 'event', 'input', 'snapshot']);
    expect(peer.channels.map((channel) => [channel.ordered, channel.maxRetransmits])).toEqual([
      [true, null],
      [true, null],
      [false, 0],
      [false, 0],
    ]);
    expect(signals[0]).toEqual({ type: 'offer', sdp: 'offer' });
    for (const channel of peer.channels) {
      expect(channel.binaryType).toBe('arraybuffer');
      expect(channel.bufferedAmountLowThreshold).toBe(BUFFERED_AMOUNT_LOW_THRESHOLD);
    }
    expect(CHANNEL_CONFIGS.snapshot).toEqual({ ordered: false, maxRetransmits: 0 });
    connection.dispose();
  });

  it('marks a guest connected only after every exact channel is open', async () => {
    const peer = new FakePeer();
    const connection = new GameConnection({ role: 'guest', peerConnection: peer });
    await connection.start();

    const incoming = (['control', 'event', 'input', 'snapshot'] as const).map((label) => {
      const channel = new FakeChannel(label, CHANNEL_CONFIGS[label]);
      peer.emitGuestChannel(channel);
      return channel;
    });
    expect(connection.state).not.toBe('connected');
    incoming.slice(0, 3).forEach((channel) => channel.open());
    expect(connection.state).not.toBe('connected');
    incoming[3]!.open();
    expect(incoming.every((channel) => channel.binaryType === 'arraybuffer')).toBe(true);
    expect(connection.state).toBe('connected');
    connection.dispose();
  });

  it('binds the dedicated connection to the admitted protocol identities', async () => {
    const peer = new FakePeer();
    const connection = new GameConnection({
      role: 'host',
      peerConnection: peer,
      protocolBinding: HOST_BINDING,
      expectedRemoteProtocolBinding: GUEST_BINDING,
    });
    await connection.start();
    openAll(peer);

    const control = peer.channels.find((channel) => channel.label === 'control');
    expect(control).toBeDefined();
    expect(control!.sent).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(control!.sent[0]))).toEqual({
      type: 'xo-control-handshake-v1',
      binding: HOST_BINDING,
    });
    expect(connection.state).not.toBe('connected');
    expect(connection.sendControl('too-early')).toBe(false);

    control!.onmessage?.({
      data: JSON.stringify({ type: 'xo-control-handshake-v1', binding: GUEST_BINDING }),
    } as MessageEvent);
    expect(connection.state).toBe('connected');
    expect(connection.sendControl('application-control')).toBe(true);
    expect(control!.sent).toHaveLength(2);
    connection.dispose();

    const mismatchedPeer = new FakePeer();
    const mismatched = new GameConnection({
      role: 'host',
      peerConnection: mismatchedPeer,
      protocolBinding: HOST_BINDING,
      expectedRemoteProtocolBinding: GUEST_BINDING,
    });
    await mismatched.start();
    openAll(mismatchedPeer);
    const mismatchedControl = mismatchedPeer.channels.find((channel) => channel.label === 'control');
    mismatchedControl!.onmessage?.({
      data: JSON.stringify({
        type: 'xo-control-handshake-v1',
        binding: { ...GUEST_BINDING, protocolSession: 'wrong-session' },
      }),
    } as MessageEvent);
    expect(mismatched.state).toBe('failed');
  });

  it('fails closed on oversized inbound channel messages', async () => {
    const peer = new FakePeer();
    const connection = new GameConnection({ role: 'guest', peerConnection: peer });
    await connection.start();
    const incoming = (['control', 'event', 'input', 'snapshot'] as const).map((label) => {
      const channel = new FakeChannel(label, CHANNEL_CONFIGS[label]);
      peer.emitGuestChannel(channel);
      channel.open();
      return channel;
    });
    expect(connection.state).toBe('connected');
    incoming[1]!.onmessage?.({ data: new ArrayBuffer(256 * 1024 + 1) } as MessageEvent);
    expect(connection.state).toBe('failed');
  });

  it('rejects malformed guest channels and relay candidates', async () => {
    const peer = new FakePeer();
    const onError = vi.fn();
    const connection = new GameConnection({ role: 'guest', peerConnection: peer, onError });
    await connection.start();

    const bad = new FakeChannel('snapshot', { ordered: true, maxRetransmits: 0 });
    peer.emitGuestChannel(bad);
    expect(bad.closed).toBe(true);
    expect(connection.state).toBe('failed');
    expect(onError).toHaveBeenCalledOnce();

    const otherPeer = new FakePeer();
    const other = new GameConnection({ role: 'guest', peerConnection: otherPeer });
    await other.start();
    await expect(other.handleSignal({
      type: 'candidate',
      candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ relay' },
    })).rejects.toThrow(/relay/i);
    expect(otherPeer.addedCandidates).toHaveLength(0);
    other.dispose();
  });

  it('drops lossy sends at the low-water bound and never queues them', async () => {
    const peer = new FakePeer();
    const connection = new GameConnection({ role: 'host', peerConnection: peer });
    await connection.start();
    openAll(peer);

    const snapshot = peer.channels.find((channel) => channel.label === 'snapshot');
    const control = peer.channels.find((channel) => channel.label === 'control');
    expect(snapshot).toBeDefined();
    expect(control).toBeDefined();
    snapshot!.bufferedAmount = BUFFERED_AMOUNT_LOW_THRESHOLD + 1;
    expect(connection.sendSnapshot(new Uint8Array([1]).buffer, 2)).toBe(false);
    expect((snapshot as FakeChannel).sent).toHaveLength(0);

    control!.bufferedAmount = MAX_BUFFERED_AMOUNT + 1;
    expect(connection.sendControl(new Uint8Array([1]).buffer)).toBe(false);
    expect((control as FakeChannel).sent).toHaveLength(0);
    connection.dispose();
  });

  it('sends every chunk of one logical snapshot while dropping older snapshots', async () => {
    const peer = new FakePeer();
    const connection = new GameConnection({ role: 'host', peerConnection: peer });
    await connection.start();
    openAll(peer);
    const snapshot = peer.channels.find((channel) => channel.label === 'snapshot')!;

    expect(connection.sendSnapshot(new Uint8Array([1]).buffer, 7)).toBe(true);
    expect(connection.sendSnapshot(new Uint8Array([2]).buffer, 7)).toBe(true);
    expect(connection.sendSnapshot(new Uint8Array([3]).buffer, 7)).toBe(true);
    expect(connection.sendSnapshot(new Uint8Array([0]).buffer, 6)).toBe(false);
    expect(snapshot.sent.map((packet) => new Uint8Array(packet)[0])).toEqual([1, 2, 3]);
    connection.dispose();
  });

  it('performs at most one bounded ICE restart before clean failure', async () => {
    vi.useFakeTimers();
    const peer = new FakePeer();
    const connection = new GameConnection({ role: 'host', peerConnection: peer, connectionTimeoutMs: 20 });
    await connection.start();

    await vi.advanceTimersByTimeAsync(20);
    expect(peer.restartIce).toHaveBeenCalledOnce();
    expect(peer.offers).toHaveLength(2);
    expect(peer.offers[1]).toEqual({ iceRestart: true });
    expect(connection.state).toBe('restarting');

    await vi.advanceTimersByTimeAsync(20);
    expect(connection.state).toBe('failed');
    expect(peer.restartIce).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('bounds recovery when an established connection becomes disconnected', async () => {
    vi.useFakeTimers();
    const peer = new FakePeer();
    const connection = new GameConnection({ role: 'host', peerConnection: peer, connectionTimeoutMs: 20 });
    await connection.start();
    openAll(peer);
    expect(connection.state).toBe('connected');

    peer.connectionState = 'disconnected';
    peer.onconnectionstatechange?.();
    peer.oniceconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.state).toBe('restarting');
    expect(peer.restartIce).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(20);
    expect(connection.state).toBe('failed');
    expect(peer.restartIce).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('clears the bounded restart timeout after transient disconnect recovery', async () => {
    vi.useFakeTimers();
    const peer = new FakePeer();
    const connection = new GameConnection({ role: 'host', peerConnection: peer, connectionTimeoutMs: 20 });
    await connection.start();
    openAll(peer);

    peer.connectionState = 'disconnected';
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.state).toBe('restarting');

    peer.connectionState = 'connected';
    peer.iceConnectionState = 'connected';
    peer.onconnectionstatechange?.();
    expect(connection.state).toBe('connected');
    await vi.advanceTimersByTimeAsync(40);
    expect(connection.state).toBe('connected');

    // The single lifetime restart budget is not reset by recovery.
    peer.connectionState = 'disconnected';
    peer.iceConnectionState = 'disconnected';
    peer.onconnectionstatechange?.();
    expect(connection.state).toBe('failed');
    expect(peer.restartIce).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('exposes selected candidate diagnostics and rejects relay pairs', async () => {
    const peer = new FakePeer();
    peer.stats.set('pair', {
      id: 'pair', type: 'candidate-pair', state: 'succeeded', selected: true,
      localCandidateId: 'local', remoteCandidateId: 'remote', protocol: 'udp',
    });
    peer.stats.set('local', { id: 'local', type: 'local-candidate', candidateType: 'host' });
    peer.stats.set('remote', { id: 'remote', type: 'remote-candidate', candidateType: 'srflx' });
    const connection = new GameConnection({ role: 'guest', peerConnection: peer });
    const diagnostics = await connection.getSelectedCandidatePairDiagnostics();
    expect(diagnostics).toMatchObject({ localCandidateType: 'host', remoteCandidateType: 'srflx', protocol: 'udp' });
    connection.dispose();

    const relayPeer = new FakePeer();
    relayPeer.stats.set('pair', {
      id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true,
      localCandidateId: 'local', remoteCandidateId: 'remote',
    });
    relayPeer.stats.set('local', { id: 'local', type: 'local-candidate', candidateType: 'relay' });
    relayPeer.stats.set('remote', { id: 'remote', type: 'remote-candidate', candidateType: 'host' });
    const relayConnection = new GameConnection({ role: 'guest', peerConnection: relayPeer });
    await expect(relayConnection.getSelectedCandidatePairDiagnostics()).rejects.toThrow(/relay/i);
    expect(relayConnection.state).toBe('failed');
  });

  it('parses bounded transport metrics without exposing candidate addresses', async () => {
    const peer = new FakePeer();
    peer.stats.set('pair', {
      id: 'pair', type: 'candidate-pair', state: 'succeeded', selected: true,
      currentRoundTripTime: 0.075, bytesSent: 12_000, bytesReceived: 9_000,
      localCandidateId: 'local', remoteCandidateId: 'remote',
    });
    peer.stats.set('local', { id: 'local', type: 'local-candidate', candidateType: 'host', address: '192.0.2.1' });
    peer.stats.set('remote', { id: 'remote', type: 'remote-candidate', candidateType: 'srflx', address: '198.51.100.2' });
    peer.stats.set('inbound', { id: 'inbound', type: 'inbound-rtp', packetsReceived: 90, packetsLost: 10 });
    peer.stats.set('outbound', { id: 'outbound', type: 'outbound-rtp', packetsSent: 120 });
    const onMetrics = vi.fn();
    const connection = new GameConnection({ role: 'guest', peerConnection: peer, onNetworkMetrics: onMetrics });

    const metrics = await connection.getNetworkMetrics();

    expect(metrics.rttMs).toBe(75);
    expect(metrics.packetLossPercent).toBe(10);
    expect(metrics.bytesSent).toBe(12_000);
    expect(metrics.bytesReceived).toBe(9_000);
    expect(metrics.packetsSent).toBe(120);
    expect(metrics.packetsReceived).toBe(90);
    expect(metrics.packetsLost).toBe(10);
    expect(metrics.candidatePair).toMatchObject({ localCandidateType: 'host', remoteCandidateType: 'srflx' });
    expect(JSON.stringify(metrics)).not.toContain('192.0.2.1');
    expect(JSON.stringify(metrics)).not.toContain('198.51.100.2');
    expect(onMetrics).toHaveBeenCalledWith(metrics);
    connection.dispose();
  });

  it('reports a terminal peer close once and disposes idempotently', async () => {
    const peer = new FakePeer();
    const disconnected = vi.fn();
    const connection = new GameConnection({ role: 'host', peerConnection: peer, onDisconnected: disconnected });
    await connection.start();
    openAll(peer);

    peer.connectionState = 'closed';
    peer.iceConnectionState = 'closed';
    peer.onconnectionstatechange?.();
    expect(connection.state).toBe('closed');
    expect(disconnected).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledWith('closed');
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.onconnectionstatechange).toBeNull();
    connection.dispose();
    connection.dispose();
    expect(peer.close).toHaveBeenCalledOnce();
  });
});
