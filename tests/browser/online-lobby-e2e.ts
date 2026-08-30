import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import type { LobbyViewModel } from '../../src/ui/onlineLobby';

const PORT = 5198;
const FIXTURE = `http://127.0.0.1:${PORT}/tests/browser/fixtures/online-lobby.html`;
const MOCK_SIGNALING_INIT = readFileSync(new URL('./mock-signaling-init.js', import.meta.url), 'utf8');

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

class DeterministicSignalingHub {
  private readonly peers = new Map<string, PeerRecord>();
  private readonly handshakes = new Map<string, HandshakeRecord>();
  private sequence = 0;

  async attach(page: Page): Promise<void> {
    await page.exposeBinding('__xoMockRegister', (source, peerId: string, roomId: string) =>
      this.register(source.page, peerId, roomId));
    await page.exposeBinding('__xoMockHandshakeSend', (source, from: string, to: string, data: unknown) =>
      this.handshakeSend(source.page, from, to, data));
    await page.exposeBinding('__xoMockHandshakeDone', (_source, from: string, to: string, ok: boolean) =>
      this.handshakeDone(from, to, ok));
    await page.exposeBinding('__xoMockActionSend', (_source, from: string, namespace: string, data: unknown, target: unknown) =>
      this.actionSend(from, namespace, data, target));
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
    let delivered = data;
    if (new URL(page.url()).searchParams.has('wrong-proof')
      && isRecord(data) && data.type === 'admission-request' && typeof data.proof === 'string') {
      delivered = { ...data, proof: `${data.proof.startsWith('A') ? 'B' : 'A'}${data.proof.slice(1)}` };
    }
    await this.evaluate(target.page, '__xoMockReceiveHandshake', from, delivered);
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
    // Notify the later peer first. Guests create no initial offer, so this
    // ensures their signal handler exists before the host publishes one.
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

interface BrowserPeer {
  readonly context: BrowserContext;
  readonly page: Page;
}

async function openPeer(browser: Browser, hub: DeterministicSignalingHub, query = ''): Promise<BrowserPeer> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`fixture page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`fixture console error: ${message.text()}`);
  });
  await hub.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({ onboarded: true, playerSkin: 'vanguard', lang: 'en' }));
  });
  await page.goto(`${FIXTURE}${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as unknown as { __xoLobbyTest?: unknown }).__xoLobbyTest));
  return { context, page };
}

async function createRoom(peer: BrowserPeer, name: string): Promise<{ link: string; code: string }> {
  await peer.page.click('#open-create');
  await peer.page.fill('#create-display-name', name);
  await peer.page.click('#btn-confirm-create-room');
  await peer.page.waitForSelector('#online-lobby-menu:not(.hidden)');
  return peer.page.evaluate(() => {
    const view = (window as unknown as { __xoLobbyTest: { latest: { inviteLink: string; inviteCode: string } } }).__xoLobbyTest.latest;
    return { link: view.inviteLink, code: view.inviteCode };
  });
}

async function joinRoom(peer: BrowserPeer, invite: string, name: string, useLink: boolean): Promise<void> {
  if (useLink) {
    await peer.page.goto(invite, { waitUntil: 'domcontentloaded' });
    // A same-document fragment navigation does not rerun startup logic. Reload
    // to model an invite opened as a fresh browser navigation.
    await peer.page.reload({ waitUntil: 'domcontentloaded' });
    await peer.page.waitForFunction(() => Boolean((window as unknown as { __xoLobbyTest?: unknown }).__xoLobbyTest));
    await peer.page.waitForSelector('#join-room-menu:not(.hidden)');
    assert.equal(await peer.page.inputValue('#join-room-invite'), peer.page.url(), 'fragment invite opens and prefills join');
  } else {
    await peer.page.click('#open-join');
    await peer.page.fill('#join-room-invite', invite);
  }
  await peer.page.fill('#join-display-name', name);
  await peer.page.click('#btn-confirm-join-room');
  await peer.page.waitForSelector('#online-lobby-menu:not(.hidden)', { timeout: 15_000 });
}

async function latest<T>(peer: BrowserPeer, selector: (view: LobbyViewModel) => T): Promise<T> {
  return peer.page.evaluate(selector, await peer.page.evaluate(() =>
    (window as unknown as { __xoLobbyTest: { latest: LobbyViewModel } }).__xoLobbyTest.latest));
}

async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function closePeers(peers: readonly BrowserPeer[]): Promise<void> {
  for (const peer of peers) await peer.context.close().catch(() => undefined);
}

async function validateProductionShell(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
        onboarded: true,
        playerSkin: 'vanguard',
        lang: 'en',
      }));
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/#join=INVALID`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#join-room-menu:not(.hidden)', { timeout: 20_000 });
    assert.equal(await page.inputValue('#join-room-invite'), page.url(), 'production shell prefills fragment invite');
    for (const selector of ['#btn-play', '#btn-create-room', '#btn-join-room', '#btn-settings', '#btn-credits']) {
      assert.ok(await page.locator(selector).count(), `production shell contains ${selector}`);
    }
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const peers: BrowserPeer[] = [];
  try {
    server = await createServer({ server: { host: '127.0.0.1', port: PORT, strictPort: true }, logLevel: 'silent' });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    await validateProductionShell(browser);
    const hub = new DeterministicSignalingHub();
    const host = await openPeer(browser, hub);
    peers.push(host);
    const invite = await createRoom(host, 'HOST');

    const guest1 = await openPeer(browser, hub);
    peers.push(guest1);
    await joinRoom(guest1, invite.link, 'ALPHA', true);
    await waitUntil(async () => latest(host, (view) => view.players.length === 2), 'two participants');

    const guest2 = await openPeer(browser, hub);
    peers.push(guest2);
    await joinRoom(guest2, invite.code, 'BRAVO', false);
    await waitUntil(async () => latest(host, (view) => view.players.length === 3), 'three participants');

    const guest3 = await openPeer(browser, hub);
    peers.push(guest3);
    await joinRoom(guest3, invite.link, 'CHARLIE', true);
    await waitUntil(async () => latest(host, (view) => view.players.length === 4), 'four participants');
    await waitUntil(async () => latest(host, (view) => view.players.every((player: { directState: string }) => player.directState === 'open')), 'direct data channels', 25_000);

    const fifth = await openPeer(browser, hub);
    peers.push(fifth);
    await fifth.page.click('#open-join');
    await fifth.page.fill('#join-room-invite', invite.code);
    await fifth.page.fill('#join-display-name', 'FIFTH');
    await fifth.page.click('#btn-confirm-join-room');
    await fifth.page.waitForFunction(() => document.querySelector('#join-room-error')?.textContent?.includes('four human'));

    await guest1.page.click('#lobby-skin-selector .skin-card[data-skin="nova"]');
    await waitUntil(async () => latest(host, (view) => view.players.some((player: { displayName: string; skinId: string }) => player.displayName === 'ALPHA' && player.skinId === 'nova')), 'skin synchronization');
    await host.page.selectOption('#lobby-arena', 'oldfront');
    await waitUntil(async () => latest(guest2, (view) => view.map === 'oldfront'), 'map synchronization');
    await host.page.selectOption('#lobby-mode', 'teams-bot-fill');
    await waitUntil(async () => latest(guest3, (view) => view.mode === 'teams-bot-fill'), 'mode synchronization');
    await host.page.selectOption('#lobby-team-controls select', '1');
    await waitUntil(async () => latest(guest1, (view) => view.players[0]?.teamId === 1), 'team synchronization');

    for (const guest of [guest1, guest2, guest3]) await guest.page.click('#btn-lobby-ready');
    await waitUntil(async () => latest(host, (view) => view.players.filter((player: { isHost: boolean }) => !player.isHost).every((player: { ready: boolean }) => player.ready)), 'Ready flow');
    await host.page.selectOption('#lobby-bot-difficulty', 'elite');
    await waitUntil(async () => latest(host, (view) => view.players.filter((player: { isHost: boolean }) => !player.isHost).every((player: { ready: boolean }) => !player.ready)), 'Ready invalidation');

    const reclaimBefore = await latest(guest1, (view) => ({ id: view.localParticipantId, slot: view.players.find((player: { isLocal: boolean }) => player.isLocal)?.slotId }));
    const inviteFragment = await guest1.page.evaluate(() => location.hash);
    assert.ok(inviteFragment.startsWith('#join='), 'joined room keeps the invite in the URL fragment');
    await guest1.page.evaluate(() => (window as unknown as {
      __xoLobbyTest: { controller: { leaveRoom(preserveInviteFragment: boolean): Promise<void> } };
    }).__xoLobbyTest.controller.leaveRoom(true));
    await waitUntil(async () => latest(host, (view) => view.players.some((player: { displayName: string; connected: boolean }) => player.displayName === 'ALPHA' && !player.connected)), 'guest leave');
    await guest1.page.reload({ waitUntil: 'domcontentloaded' });
    await guest1.page.waitForFunction(() => Boolean((window as unknown as { __xoLobbyTest?: unknown }).__xoLobbyTest));
    assert.equal(await guest1.page.evaluate(() => location.hash), inviteFragment, 'reload preserves the fragment-only invite');
    await guest1.page.waitForSelector('#join-room-menu:not(.hidden)');
    assert.equal(await guest1.page.inputValue('#join-room-invite'), guest1.page.url(), 'reload prefills the fragment invite');
    await guest1.page.fill('#join-display-name', 'ALPHA');
    await guest1.page.click('#btn-confirm-join-room');
    await guest1.page.waitForSelector('#online-lobby-menu:not(.hidden)');
    const reclaimAfter = await latest(guest1, (view) => ({ id: view.localParticipantId, slot: view.players.find((player: { isLocal: boolean }) => player.isLocal)?.slotId }));
    assert.deepEqual(reclaimAfter, reclaimBefore, 'reclaim must preserve participant and slot identity');
    await waitUntil(async () => latest(host, (view) => view.players.some((player: { displayName: string; connected: boolean }) => player.displayName === 'ALPHA' && player.connected)), 'reclaimed lobby connection');

    const wrongBuild = await openPeer(browser, hub, '?build=wrong-build');
    peers.push(wrongBuild);
    await wrongBuild.page.click('#open-join');
    await wrongBuild.page.fill('#join-room-invite', invite.code);
    await wrongBuild.page.fill('#join-display-name', 'WRONG BUILD');
    await wrongBuild.page.click('#btn-confirm-join-room');
    await wrongBuild.page.waitForFunction(() => document.querySelector('#join-room-error')?.textContent?.includes('incompatible'));

    const wrongSecret = await openPeer(browser, hub, '?wrong-proof=1');
    peers.push(wrongSecret);
    await wrongSecret.page.click('#open-join');
    await wrongSecret.page.fill('#join-room-invite', invite.code);
    await wrongSecret.page.fill('#join-display-name', 'WRONG SECRET');
    await wrongSecret.page.click('#btn-confirm-join-room');
    await wrongSecret.page.waitForFunction(() => document.querySelector('#join-room-error')?.textContent?.includes('secret'));

    const relayFailure = await openPeer(browser, hub, '?relay-fail=1');
    peers.push(relayFailure);
    await relayFailure.page.click('#open-join');
    await relayFailure.page.fill('#join-room-invite', invite.code);
    await relayFailure.page.fill('#join-display-name', 'NO RELAY');
    await relayFailure.page.click('#btn-confirm-join-room');
    await relayFailure.page.waitForFunction(() => document.querySelector('#join-room-error')?.textContent?.includes('every configured public relay'));

    await guest3.page.evaluate(() => (window as unknown as { __xoLobbyTest: { controller: { leaveRoom(): Promise<void> } } }).__xoLobbyTest.controller.leaveRoom());
    await waitUntil(async () => latest(host, (view) => view.players.some((player: { displayName: string; connected: boolean }) => player.displayName === 'CHARLIE' && !player.connected)), 'second guest leave');

    await host.page.evaluate(() => (window as unknown as { __xoLobbyTest: { controller: { leaveRoom(): Promise<void> } } }).__xoLobbyTest.controller.leaveRoom());
    await guest2.page.waitForFunction(() => document.querySelector('#lobby-status-message')?.textContent?.includes('host left'));

    const failHost = await openPeer(browser, hub);
    peers.push(failHost);
    const failInvite = await createRoom(failHost, 'FAIL HOST');
    const directFailure = await openPeer(browser, hub, '?direct-fail=1');
    peers.push(directFailure);
    await joinRoom(directFailure, failInvite.code, 'DIRECT FAIL', false);
    await directFailure.page.waitForFunction(() => document.querySelector('#lobby-status-message')?.textContent?.includes('no paid relay server'));

    console.log(JSON.stringify({
      participants: [2, 3, 4],
      productionShell: true,
      isolatedContexts: peers.length,
      directConnection: 'same-machine WebRTC',
      cases: [
        'fifth-rejected', 'link', 'manual-code', 'skin', 'map', 'mode', 'team',
        'ready', 'host-leave', 'guest-leave', 'reclaim', 'wrong-build',
        'wrong-secret', 'relay-failure', 'direct-failure-ui',
      ],
    }));
  } finally {
    await closePeers(peers);
    await browser?.close().catch(() => undefined);
    await server?.close();
  }
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('|');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

void main();
