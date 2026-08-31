/**
 * Real-main-app online water smoke and capture.
 *
 * The two pages use the production PrivateRoomController, GameConnection,
 * RTCPeerConnection, and DataChannel paths.  Only discovery/signaling is
 * deterministic and in-memory; no application gameplay transport is mocked.
 *
 * Run headed by default:
 *   npx tsx tests/browser/online-water-e2e.ts
 * A HEADLESS=1 run is useful for diagnostics but is not visual acceptance
 * evidence.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

const PORT = 5202;
const APP_URL = `http://127.0.0.1:${PORT}/`;
const SEED_HINT = 42042;
const OUTPUT_ROOT = path.resolve(process.env.QA_WATER_ONLINE_OUT ?? 'qa/water/online-after');
const EXPECT_WATER_STATS = process.env.QA_WATER_ONLINE_EXPECT_WATER !== '0';
const MOCK_SIGNALING_INIT = readFileSync(new URL('./mock-signaling-init.js', import.meta.url), 'utf8');

const SETTINGS = {
  quality: 'high',
  resolutionScale: 1,
  shadows: true,
  shadowQuality: 'high',
  postProcessing: true,
  bloom: true,
  reflections: true,
  ao: true,
  aa: 'smaa',
  motionBlur: false,
  dof: false,
  fpsLimit: 0,
  cameraMode: 'fps',
  onboarded: true,
  lang: 'en',
};

const WATER_VIEW = {
  name: 'lake-shoreline',
  position: [64, 0.4, 45] as [number, number, number],
  target: [102, -3.55, 58] as [number, number, number],
  fov: 66,
  time: 18,
};

interface PeerRecord {
  readonly id: string;
  readonly roomId: string;
  readonly page: Page;
  readonly sequence: number;
  readonly joined: Set<string>;
}

interface HandshakeRecord {
  readonly successes: Set<string>;
  failed: boolean;
  joined: boolean;
}

interface BrowserPeer {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly errors: string[];
}

interface WaterStats {
  readonly quality: string;
  readonly volumes: number;
  readonly visibleVolumes: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly waveTextureBytes: number;
  readonly depthTextureBytes: number;
  readonly halfFloatWaveData: boolean;
  readonly waveResolution: number;
}

interface RuntimeSnapshot {
  readonly source: 'host-match' | 'guest-replica' | 'missing';
  readonly role: string | null;
  readonly map: string | null;
  readonly seed: number | null;
  readonly phase: string | null;
  readonly onlineState: string | null;
  readonly water: WaterStats | null;
  readonly cameraPosition: { x: number; y: number; z: number } | null;
  readonly qaView: typeof WATER_VIEW | null;
  readonly runtimeIssues: string | null;
  readonly webglCanvasIds: readonly string[];
  readonly webglErrors: readonly number[];
}

interface RtcPeerSnapshot {
  readonly connectionState: string | null;
  readonly iceConnectionState: string | null;
  readonly bytesSent: number | null;
  readonly bytesReceived: number | null;
  readonly packetsSent: number | null;
  readonly packetsReceived: number | null;
  readonly packetsLost: number | null;
  readonly candidatePair: {
    readonly state: string | null;
    readonly nominated: boolean;
    readonly selected: boolean;
    readonly protocol: string | null;
    readonly localCandidateType: string | null;
    readonly remoteCandidateType: string | null;
  } | null;
}

interface RtcSnapshot {
  readonly available: boolean;
  readonly peerConnections: readonly RtcPeerSnapshot[];
  readonly channelLabels: readonly string[];
  readonly channelSends: Readonly<Record<string, { sends: number; bytes: number }>>;
  readonly webSocketCount: number;
  readonly webSocketTargets: readonly string[];
  readonly externalWebSocketCount: number;
}

/**
 * Test-only RTC observation.  It records no addresses, SDP, credentials, or
 * payloads.  The app still owns every real peer and channel operation.
 */
const RTC_OBSERVATION_INIT = String.raw`(() => {
  const root = window;
  const nativePeer = root.RTCPeerConnection;
  const observation = {
    peerConnections: [],
    channels: [],
    webSocketCount: 0,
    webSocketTargets: [],
    webglContexts: [],
  };
  root.__xoOnlineWaterRtc = observation;

  const byteLength = (value) => {
    if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
    return 0;
  };
  const trackChannel = (channel) => {
    if (!channel || channel.__xoOnlineWaterTracked) return;
    try { Object.defineProperty(channel, '__xoOnlineWaterTracked', { value: true }); } catch {}
    const record = { label: String(channel.label || ''), sends: 0, bytes: 0 };
    observation.channels.push(record);
    try {
      const send = channel.send.bind(channel);
      channel.send = (value) => {
        record.sends++;
        record.bytes += byteLength(value);
        return send(value);
      };
    } catch {}
  };

  if (nativePeer) {
    const createDataChannel = nativePeer.prototype.createDataChannel;
    if (typeof createDataChannel === 'function') {
      nativePeer.prototype.createDataChannel = function(label, options) {
        const channel = createDataChannel.call(this, label, options);
        trackChannel(channel);
        return channel;
      };
    }
    const trackedPeer = new Proxy(nativePeer, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget);
        observation.peerConnections.push(peer);
        return peer;
      },
    });
    try {
      Object.defineProperty(root, 'RTCPeerConnection', {
        configurable: true,
        writable: true,
        value: trackedPeer,
      });
    } catch {}
  }

  const nativeWebSocket = root.WebSocket;
  if (nativeWebSocket) {
    const trackedWebSocket = new Proxy(nativeWebSocket, {
      construct(target, args, newTarget) {
        observation.webSocketCount++;
        try {
          const url = new URL(String(args[0] || ''), location.href);
          observation.webSocketTargets.push(url.protocol + '//' + url.host + url.pathname);
        } catch {}
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      Object.defineProperty(root, 'WebSocket', {
        configurable: true,
        writable: true,
        value: trackedWebSocket,
      });
    } catch {}
  }

  const canvasIds = [];
  root.__xoOnlineWaterCanvasIds = canvasIds;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    const context = originalGetContext.call(this, type, ...args);
    if ((type === 'webgl' || type === 'webgl2') && context) {
      if (!canvasIds.includes(this.id)) canvasIds.push(this.id);
      if (!observation.webglContexts.includes(context)) observation.webglContexts.push(context);
    }
    return context;
  };
})();`;

/**
 * Provenance: this smallest in-memory room hub is adapted from the existing
 * repository browser test at tests/browser/online-gameplay-e2e.ts.  It only
 * carries authenticated signaling/action messages between these two pages;
 * gameplay remains the production RTCPeerConnection/DataChannel path.
 */
class DeterministicSignalingHub {
  private readonly peers = new Map<string, PeerRecord>();
  private readonly handshakes = new Map<string, HandshakeRecord>();
  private sequence = 0;

  async attach(page: Page): Promise<void> {
    await page.exposeBinding('__xoMockRegister', (source, peerId: string, roomId: string) => (
      this.register(source.page, peerId, roomId)
    ));
    await page.exposeBinding('__xoMockHandshakeSend', (source, from: string, to: string, data: unknown) => (
      this.handshakeSend(source.page, from, to, data)
    ));
    await page.exposeBinding('__xoMockHandshakeDone', (_source, from: string, to: string, ok: boolean) => (
      this.handshakeDone(from, to, ok)
    ));
    await page.exposeBinding('__xoMockActionSend', (_source, from: string, namespace: string, data: unknown, target: unknown) => (
      this.actionSend(from, namespace, data, target)
    ));
    await page.exposeBinding('__xoMockLeave', (_source, peerId: string) => this.leave(peerId));
    await page.addInitScript({ content: MOCK_SIGNALING_INIT });
  }

  private async register(page: Page, id: string, roomId: string): Promise<void> {
    if (this.peers.has(id)) throw new Error(`Duplicate mock peer: ${id}`);
    const existing = [...this.peers.values()].filter((peer) => peer.roomId === roomId);
    this.peers.set(id, { id, roomId, page, sequence: this.sequence++, joined: new Set() });
    for (const peer of existing) {
      const record: HandshakeRecord = { successes: new Set(), failed: false, joined: false };
      this.handshakes.set(pairKey(id, peer.id), record);
      await Promise.all([
        this.evaluate(peer.page, '__xoMockBeginHandshake', id, true),
        this.evaluate(page, '__xoMockBeginHandshake', peer.id, false),
      ]);
    }
  }

  private async handshakeSend(page: Page, from: string, to: string, data: unknown): Promise<void> {
    const target = this.peers.get(to);
    const sender = this.peers.get(from);
    if (!target || !sender || sender.page !== page || sender.roomId !== target.roomId) return;
    await this.evaluate(target.page, '__xoMockReceiveHandshake', from, data);
  }

  private async handshakeDone(from: string, to: string, ok: boolean): Promise<void> {
    const handshake = this.handshakes.get(pairKey(from, to));
    if (!handshake || handshake.joined || handshake.failed) return;
    if (!ok) {
      handshake.failed = true;
      return;
    }
    handshake.successes.add(from);
    if (handshake.successes.size !== 2) return;
    const left = this.peers.get(from);
    const right = this.peers.get(to);
    if (!left || !right) return;
    handshake.joined = true;
    left.joined.add(right.id);
    right.joined.add(left.id);
    const [first, second] = left.sequence > right.sequence ? [left, right] : [right, left];
    await this.evaluate(first.page, '__xoMockPeerJoin', second.id);
    await this.evaluate(second.page, '__xoMockPeerJoin', first.id);
  }

  private async actionSend(from: string, namespace: string, data: unknown, target: unknown): Promise<void> {
    const sender = this.peers.get(from);
    if (!sender) return;
    const requested = target === null || target === undefined
      ? [...sender.joined]
      : Array.isArray(target) ? target : [target];
    for (const peerId of requested) {
      if (typeof peerId !== 'string' || !sender.joined.has(peerId)) continue;
      const peer = this.peers.get(peerId);
      if (peer) await this.evaluate(peer.page, '__xoMockReceiveAction', namespace, data, from);
    }
  }

  private async leave(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    for (const otherId of peer.joined) {
      const other = this.peers.get(otherId);
      if (!other) continue;
      other.joined.delete(peerId);
      await this.evaluate(other.page, '__xoMockPeerLeave', peerId);
    }
  }

  private async evaluate(page: Page, method: string, ...args: unknown[]): Promise<void> {
    if (page.isClosed()) return;
    await page.evaluate(({ methodName, values }) => {
      const fn = (window as unknown as Record<string, unknown>)[methodName];
      if (typeof fn === 'function') return (fn as (...items: unknown[]) => unknown)(...values);
      return undefined;
    }, { methodName: method, values: args }).catch(() => undefined);
  }
}

async function openPeer(browser: Browser, hub: DeterministicSignalingHub): Promise<BrowserPeer> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.stack ?? error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await hub.attach(page);
  await page.addInitScript({ content: RTC_OBSERVATION_INIT });
  await page.addInitScript((settings) => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify(settings));
  }, SETTINGS);
  await page.goto(`${APP_URL}?qa=1&seed=${SEED_HINT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90_000 });
  return { context, page, errors };
}

async function createRoom(host: BrowserPeer): Promise<string> {
  await host.page.click('#btn-create-room');
  await host.page.waitForSelector('#create-room-menu:not(.hidden)');
  await host.page.fill('#create-display-name', 'WATER HOST');
  await host.page.click('#btn-confirm-create-room');
  await host.page.waitForSelector('#online-lobby-menu:not(.hidden)', { timeout: 20_000 });
  const code = (await host.page.locator('#online-room-code').textContent())?.trim() ?? '';
  assert.ok(code.length > 0, 'host publishes an invite token');
  return code;
}

async function joinRoom(guest: BrowserPeer, inviteCode: string): Promise<void> {
  await guest.page.click('#btn-join-room');
  await guest.page.waitForSelector('#join-room-menu:not(.hidden)');
  await guest.page.fill('#join-room-invite', inviteCode);
  await guest.page.fill('#join-display-name', 'WATER GUEST');
  await guest.page.click('#btn-confirm-join-room');
  await guest.page.waitForSelector('#online-lobby-menu:not(.hidden)', { timeout: 20_000 });
}

async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function directStates(page: Page): Promise<string[]> {
  return page.locator('#lobby-direct-status dd').evaluateAll((elements) => (
    elements.map((element) => element.textContent?.trim().toLowerCase() ?? '')
  ));
}

async function runtime(page: Page): Promise<RuntimeSnapshot> {
  return page.evaluate(() => {
    const root = window as unknown as {
      __xoState?: {
        map?: string;
        seed?: number;
        phase?: string;
        water?: WaterStats;
        camera?: { position?: { x?: number; y?: number; z?: number } };
        onlineRole?: string;
      };
      __xoReplicaState?: {
        map?: string;
        seed?: number;
        phase?: string;
        water?: WaterStats;
        camera?: { position?: { x?: number; y?: number; z?: number } };
        onlineRole?: string;
      };
      __xoWaterQaView?: typeof WATER_VIEW;
      __xoOnlineWaterCanvasIds?: string[];
      __xoOnlineWaterRtc?: { webglContexts?: Array<WebGLRenderingContext | WebGL2RenderingContext> };
    };
    const host = root.__xoState;
    const guest = root.__xoReplicaState;
    const state = host ?? guest;
    const position = state?.camera?.position;
    const cameraPosition = position
      && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)
      ? { x: position.x!, y: position.y!, z: position.z! }
      : null;
    return {
      source: host ? 'host-match' : guest ? 'guest-replica' : 'missing',
      role: state?.onlineRole ?? document.documentElement.dataset.xoOnlineRole ?? null,
      map: state?.map ?? null,
      seed: typeof state?.seed === 'number' ? state.seed : null,
      phase: state?.phase ?? null,
      onlineState: document.documentElement.dataset.xoOnlineState ?? null,
      water: state?.water ?? null,
      cameraPosition,
      qaView: root.__xoWaterQaView ?? null,
      runtimeIssues: document.documentElement.dataset.xoQaRuntime ?? null,
      webglCanvasIds: [...(root.__xoOnlineWaterCanvasIds ?? [])],
      webglErrors: (root.__xoOnlineWaterRtc?.webglContexts ?? []).flatMap((context) => {
        const values: number[] = [];
        if (context.isContextLost?.()) values.push(-1);
        if (context.getError) {
          for (let index = 0; index < 8; index++) {
            const error = context.getError();
            if (error === 0) break;
            values.push(error);
          }
        }
        return values;
      }),
    } satisfies RuntimeSnapshot;
  });
}

async function rtc(page: Page): Promise<RtcSnapshot> {
  return page.evaluate(String.raw`(async () => {
    const observation = window.__xoOnlineWaterRtc;
    if (!observation) {
      return {
        available: false, peerConnections: [], channelLabels: [], channelSends: {},
        webSocketCount: 0, webSocketTargets: [], externalWebSocketCount: 0,
      };
    }
    function numberValue(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    function boolValue(value) {
      return value === true;
    }
    function textValue(value) {
      return typeof value === 'string' ? value : null;
    }
    const peerConnections = [];
    for (const peer of observation.peerConnections) {
      const records = [];
      try {
        const report = await peer.getStats();
        report.forEach((value) => records.push(value));
      } catch {
        // A snapshot during negotiation can briefly lack stats; state is still
        // retained in the result and the caller polls for connected peers.
      }
      const candidates = records.filter((record) => (
        record.type === 'local-candidate' || record.type === 'remote-candidate'
      ));
      const candidateById = new Map(candidates.map((record) => [record.id, record]));
      const pair = records
        .filter((record) => record.type === 'candidate-pair'
          && record.state === 'succeeded'
          && (record.selected === true || record.nominated === true))
        .sort((left, right) => Number(right.selected === true) - Number(left.selected === true)
          || Number(right.nominated === true) - Number(left.nominated === true))[0];
      const local = pair ? candidateById.get(pair.localCandidateId) : undefined;
      const remote = pair ? candidateById.get(pair.remoteCandidateId) : undefined;
      let bytesSent = 0;
      let bytesReceived = 0;
      let packetsSent = 0;
      let packetsReceived = 0;
      let packetsLost = 0;
      let hasBytesSent = false;
      let hasBytesReceived = false;
      let hasPacketsSent = false;
      let hasPacketsReceived = false;
      let hasPacketsLost = false;
      for (const record of records) {
        if (record.type === 'candidate-pair') {
          const sent = numberValue(record.bytesSent);
          const received = numberValue(record.bytesReceived);
          if (sent !== null) { bytesSent = Math.max(bytesSent, sent); hasBytesSent = true; }
          if (received !== null) { bytesReceived = Math.max(bytesReceived, received); hasBytesReceived = true; }
        }
        if (record.type === 'data-channel') {
          const sent = numberValue(record.bytesSent);
          const received = numberValue(record.bytesReceived);
          if (sent !== null) { bytesSent += sent; hasBytesSent = true; }
          if (received !== null) { bytesReceived += received; hasBytesReceived = true; }
        }
        if (record.type === 'outbound-rtp') {
          const sent = numberValue(record.bytesSent);
          const packets = numberValue(record.packetsSent);
          if (sent !== null) { bytesSent += sent; hasBytesSent = true; }
          if (packets !== null) { packetsSent += packets; hasPacketsSent = true; }
        }
        if (record.type === 'inbound-rtp') {
          const received = numberValue(record.bytesReceived);
          const packets = numberValue(record.packetsReceived);
          const lost = numberValue(record.packetsLost);
          if (received !== null) { bytesReceived += received; hasBytesReceived = true; }
          if (packets !== null) { packetsReceived += packets; hasPacketsReceived = true; }
          if (lost !== null) { packetsLost += lost; hasPacketsLost = true; }
        }
      }
      peerConnections.push({
        connectionState: textValue(peer.connectionState),
        iceConnectionState: textValue(peer.iceConnectionState),
        bytesSent: hasBytesSent ? bytesSent : null,
        bytesReceived: hasBytesReceived ? bytesReceived : null,
        packetsSent: hasPacketsSent ? packetsSent : null,
        packetsReceived: hasPacketsReceived ? packetsReceived : null,
        packetsLost: hasPacketsLost ? packetsLost : null,
        candidatePair: pair ? {
          state: textValue(pair.state),
          nominated: boolValue(pair.nominated),
          selected: boolValue(pair.selected),
          protocol: textValue(pair.protocol),
          localCandidateType: textValue(local && local.candidateType),
          remoteCandidateType: textValue(remote && remote.candidateType),
        } : null,
      });
    }
    const channelSends = {};
    for (const channel of observation.channels) {
      const current = channelSends[channel.label] || { sends: 0, bytes: 0 };
      current.sends += channel.sends;
      current.bytes += channel.bytes;
      channelSends[channel.label] = current;
    }
    return {
      available: true,
      peerConnections,
      channelLabels: [...new Set(observation.channels.map((channel) => channel.label))],
      channelSends,
      webSocketCount: observation.webSocketCount,
      webSocketTargets: [...new Set(observation.webSocketTargets)],
      externalWebSocketCount: observation.webSocketTargets.filter((target) => {
        try { return new URL(target).host !== location.host; } catch { return true; }
      }).length,
    };
  })()`) as Promise<RtcSnapshot>;
}

function distance(left: { x: number; y: number; z: number }, right: readonly [number, number, number]): number {
  return Math.hypot(left.x - right[0], left.y - right[1], left.z - right[2]);
}

function metricDelta(before: RtcSnapshot, after: RtcSnapshot): Record<string, unknown> {
  const first = before.peerConnections[0];
  const last = after.peerConnections[0];
  const delta = (left: number | null | undefined, right: number | null | undefined): number | null => (
    left !== null && left !== undefined && right !== null && right !== undefined ? right - left : null
  );
  return {
    bytesSent: delta(first?.bytesSent, last?.bytesSent),
    bytesReceived: delta(first?.bytesReceived, last?.bytesReceived),
    packetsSent: delta(first?.packetsSent, last?.packetsSent),
    packetsReceived: delta(first?.packetsReceived, last?.packetsReceived),
    packetsLost: delta(first?.packetsLost, last?.packetsLost),
  };
}

async function closePeers(peers: readonly BrowserPeer[]): Promise<void> {
  for (const peer of peers) await peer.context.close().catch(() => undefined);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const peers: BrowserPeer[] = [];
  try {
    server = await createServer({
      server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false },
      logLevel: 'silent',
    });
    await server.listen();
    const headless = process.env.HEADLESS === '1';
    if (headless) console.warn('HEADLESS=1 is diagnostic only; headed Chrome is required for visual acceptance.');
    browser = await chromium.launch({ channel: 'chrome', headless });
    const hub = new DeterministicSignalingHub();
    const host = await openPeer(browser, hub);
    peers.push(host);
    const inviteCode = await createRoom(host);
    const guest = await openPeer(browser, hub);
    peers.push(guest);
    await joinRoom(guest, inviteCode);

    await waitUntil(async () => {
      const [hostStates, guestStates] = await Promise.all([directStates(host.page), directStates(guest.page)]);
      return hostStates.length === 1 && guestStates.length === 1
        && hostStates.every((state) => state === 'open')
        && guestStates.every((state) => state === 'open');
    }, 'direct lobby DataChannels', 35_000);

    await host.page.selectOption('#lobby-arena', 'eden');
    await waitUntil(async () => (await guest.page.inputValue('#lobby-arena')) === 'eden', 'guest Eden selection');
    await host.page.selectOption('#lobby-mode', 'ffa');
    await waitUntil(async () => (await guest.page.inputValue('#lobby-mode')) === 'ffa', 'guest FFA selection');

    await host.page.click('#btn-lobby-ready');
    await guest.page.click('#btn-lobby-ready');
    await waitUntil(async () => (
      await host.page.getAttribute('#btn-lobby-ready', 'aria-pressed') === 'true'
      && await guest.page.getAttribute('#btn-lobby-ready', 'aria-pressed') === 'true'
      && await host.page.isEnabled('#btn-online-start')
    ), 'ready/start eligibility');

    await host.page.click('#btn-online-start');
    await waitUntil(async () => {
      const [hostValue, guestValue] = await Promise.all([runtime(host.page), runtime(guest.page)]);
      return hostValue.source === 'host-match' && guestValue.source === 'guest-replica'
        && hostValue.onlineState === 'active' && guestValue.onlineState === 'active';
    }, 'host Match and guest ClientReplica active runtime', 120_000);
    const lobbyHidden = {
      host: await host.page.locator('#online-lobby-menu').evaluate((element) => element.classList.contains('hidden')),
      guest: await guest.page.locator('#online-lobby-menu').evaluate((element) => element.classList.contains('hidden')),
    };
    assert.equal(lobbyHidden.host, true, 'locked host lobby stays hidden over the active match');
    assert.equal(lobbyHidden.guest, true, 'locked guest lobby stays hidden over the active replica');

    const before = {
      host: await rtc(host.page),
      guest: await rtc(guest.page),
    };
    assert.equal(before.host.available, true, 'host exposes the native RTC observation');
    assert.equal(before.guest.available, true, 'guest exposes the native RTC observation');
    assert.ok(before.host.peerConnections.length > 0, 'host constructed a real RTCPeerConnection');
    assert.ok(before.guest.peerConnections.length > 0, 'guest constructed a real RTCPeerConnection');
    const peerSnapshots: ReadonlyArray<readonly [string, RtcSnapshot]> = [
      ['host', before.host],
      ['guest', before.guest],
    ];
    for (const [label, snapshot] of peerSnapshots) {
      for (const peer of snapshot.peerConnections) {
        assert.equal(peer.connectionState, 'connected', `${label} direct peer is connected`);
        assert.ok(peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed', `${label} ICE is direct-connected`);
        if (peer.candidatePair) {
          assert.equal(peer.candidatePair.state, 'succeeded', `${label} candidate pair succeeded`);
          assert.ok(peer.candidatePair.selected || peer.candidatePair.nominated, `${label} candidate pair selected/nominated`);
          assert.ok(peer.candidatePair.localCandidateType, `${label} local candidate type is exposed`);
          assert.ok(peer.candidatePair.remoteCandidateType, `${label} remote candidate type is exposed`);
          assert.notEqual(peer.candidatePair.localCandidateType, 'relay', `${label} local candidate is not relay`);
          assert.notEqual(peer.candidatePair.remoteCandidateType, 'relay', `${label} remote candidate is not relay`);
        } else assert.fail(`${label} selected/nominated succeeded candidate pair is unavailable`);
      }
    }

    await Promise.all([
      host.page.evaluate((view) => {
        (window as unknown as { __xoWaterQaView?: typeof view }).__xoWaterQaView = view;
      }, WATER_VIEW),
      guest.page.evaluate((view) => {
        (window as unknown as { __xoWaterQaView?: typeof view }).__xoWaterQaView = view;
      }, WATER_VIEW),
    ]);
    await waitUntil(async () => {
      const [hostValue, guestValue] = await Promise.all([runtime(host.page), runtime(guest.page)]);
      return hostValue.cameraPosition !== null && guestValue.cameraPosition !== null
        && distance(hostValue.cameraPosition, WATER_VIEW.position) < 0.5
        && distance(guestValue.cameraPosition, WATER_VIEW.position) < 0.5;
    }, 'both cameras fixed at the lake view', 15_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const after = {
      host: await rtc(host.page),
      guest: await rtc(guest.page),
    };

    const [hostRuntime, guestRuntime] = await Promise.all([runtime(host.page), runtime(guest.page)]);
    assert.equal(hostRuntime.source, 'host-match');
    assert.equal(guestRuntime.source, 'guest-replica');
    assert.equal(hostRuntime.role, 'host');
    assert.equal(guestRuntime.role, 'guest');
    assert.equal(hostRuntime.map, 'eden');
    assert.equal(guestRuntime.map, 'eden');
    assert.equal(hostRuntime.seed, guestRuntime.seed, 'host and guest use the canonical seed');
    assert.ok(Number.isSafeInteger(hostRuntime.seed), 'online seed is finite and safe');
    const runtimeSnapshots: ReadonlyArray<readonly [string, RuntimeSnapshot]> = [
      ['host', hostRuntime],
      ['guest', guestRuntime],
    ];
    for (const [label, value] of runtimeSnapshots) {
      if (EXPECT_WATER_STATS) {
        assert.ok(value.water, `${label} exposes water QA stats`);
        assert.equal(value.water?.quality, SETTINGS.quality, `${label} water quality is configured`);
        assert.ok((value.water?.volumes ?? 0) > 0, `${label} has authored water volumes`);
        assert.ok((value.water?.visibleVolumes ?? 0) > 0, `${label} lake is visible`);
        assert.ok((value.water?.drawCalls ?? 0) > 0, `${label} water contributes draw calls`);
        assert.ok((value.water?.triangles ?? 0) > 0, `${label} water contributes triangles`);
        assert.ok((value.water?.waveResolution ?? 0) > 0, `${label} has a wave field`);
      } else {
        assert.equal(value.water, null, `${label} baseline predates water QA counters`);
      }
      assert.equal(value.runtimeIssues, 'count=0', `${label} reports no runtime QA issues`);
      assert.deepEqual(value.qaView, WATER_VIEW, `${label} retains the requested __xoWaterQaView`);
      assert.deepEqual(value.webglCanvasIds, ['game-canvas'], `${label} has one WebGL canvas`);
      assert.deepEqual(value.webglErrors, [], `${label} reports no WebGL errors`);
      assert.ok(distance(value.cameraPosition!, WATER_VIEW.position) < 0.5, `${label} camera is near the lake view`);
    }
    if (EXPECT_WATER_STATS) {
      assert.equal(hostRuntime.water?.quality, guestRuntime.water?.quality, 'host and guest water quality match');
      assert.equal(hostRuntime.water?.volumes, guestRuntime.water?.volumes, 'host and guest water volume counts match');
    }
    assert.deepEqual(after.host.channelLabels.filter((label) => label.length > 0).sort(), ['control', 'event', 'input', 'snapshot'], 'host uses only gameplay channel labels');
    assert.equal(after.host.externalWebSocketCount, 0, 'host uses no external relay WebSocket with in-memory signaling');
    assert.equal(after.guest.externalWebSocketCount, 0, 'guest uses no external relay WebSocket with in-memory signaling');
    assert.deepEqual(after.host.channelLabels.filter((label) => /water|relay/iu.test(label)), [], 'host has no water/relay channel');
    assert.deepEqual(after.guest.channelLabels.filter((label) => /water|relay/iu.test(label)), [], 'guest has no water/relay channel');
    assert.equal(host.errors.length, 0, `host page/console errors: ${host.errors.join('\n')}`);
    assert.equal(guest.errors.length, 0, `guest page/console errors: ${guest.errors.join('\n')}`);

    await Promise.all([
      host.page.screenshot({ path: path.join(OUTPUT_ROOT, 'host.png'), timeout: 60_000 }),
      guest.page.screenshot({ path: path.join(OUTPUT_ROOT, 'guest.png'), timeout: 60_000 }),
    ]);
    const report = {
      capturedAt: new Date().toISOString(),
      browser: 'Google Chrome (Playwright channel)',
      headed: !process.env.HEADLESS,
      viewport: { width: 1440, height: 900 },
      signaling: 'deterministic in-memory hub; no server relay',
      directTransport: 'native RTCPeerConnection/DataChannels',
      isolatedContexts: 2,
      path: ['create', 'join', 'direct-connect', 'ready', 'start-barrier', 'host-match', 'guest-replica', 'lake-camera'],
      map: { host: hostRuntime.map, guest: guestRuntime.map },
      seed: { host: hostRuntime.seed, guest: guestRuntime.seed },
      roles: { host: hostRuntime.role, guest: guestRuntime.role },
      lobbyHidden,
      expectsWaterQaStats: EXPECT_WATER_STATS,
      water: { host: hostRuntime.water, guest: guestRuntime.water, view: WATER_VIEW },
      rtc: {
        before,
        after,
        delta: {
          host: metricDelta(before.host, after.host),
          guest: metricDelta(before.guest, after.guest),
        },
        note: 'Water view mutation is presentation-only; counters shown are ordinary online transport activity during the one-second observation window.',
      },
      webgl: {
        host: { canvasIds: hostRuntime.webglCanvasIds, errors: hostRuntime.webglErrors },
        guest: { canvasIds: guestRuntime.webglCanvasIds, errors: guestRuntime.webglErrors },
      },
      browserErrors: { host: host.errors, guest: guest.errors },
      screenshots: ['host.png', 'guest.png'],
    };
    await writeFile(path.join(OUTPUT_ROOT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await closePeers(peers);
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('|');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
