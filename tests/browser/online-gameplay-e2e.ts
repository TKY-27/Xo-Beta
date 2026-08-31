import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { selectedBrowserType } from './browser-engine';
import type { MatchMode } from '../../src/sim/roster';
import type { MatchStartPayload } from '../../src/net/matchStart';

const PORT = 5201;
const FIXTURE = `http://127.0.0.1:${PORT}/tests/browser/fixtures/online-gameplay.html`;
const MOCK_SIGNALING_INIT = readFileSync(new URL('./mock-signaling-init.js', import.meta.url), 'utf8');
const MATRIX_PREFERRED_SLOTS = {
  enabled: true,
  slots: ['pistol', 'shotgun', 'smg', 'ar', 'sniper'],
} as const;

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
}

interface GameplaySnapshot {
  readonly role: 'idle' | 'host' | 'guest';
  readonly screen: 'main' | 'create' | 'join' | 'lobby' | 'runtime';
  readonly coordinatorState: string;
  readonly phase: string | null;
  readonly hostTick: number;
  readonly networkTick: number | null;
  readonly aliveCount: number | null;
  readonly localActorId: number | null;
  readonly actors: readonly {
    id: number;
    name: string;
    alive: boolean;
    deployed: boolean;
    health: number;
    shots: number;
    teamId: number | null;
    ownership: 'local-human' | 'remote-human' | 'bot';
    crouched: boolean;
    inventory: { selected: number; slots: readonly (unknown | null)[]; ammo: Readonly<Record<string, number>> } | null;
  }[];
  readonly destructibles: readonly { id: string; destroyed: boolean }[];
  readonly lobbyPlayers: readonly {
    participantId: string;
    displayName: string;
    skinId: string;
    teamId: number | null;
    isHost: boolean;
    isLocal: boolean;
    connected: boolean;
    ready: boolean;
    directState: string;
  }[];
  readonly lobbyMap: string | null;
  readonly lobbyMode: MatchMode | null;
  readonly winner: { readonly kind: 'actor'; readonly actorId: number; readonly displayName: string } | { readonly kind: 'team'; readonly teamId: number } | null;
  readonly events: readonly string[];
  readonly notices: readonly string[];
  readonly inviteLink: string;
  readonly inviteCode: string;
  readonly startPayload: MatchStartPayload | null;
  readonly error: string | null;
  readonly inputPackets: number;
  readonly directStates: readonly string[];
  readonly hostDestructibleCount: number | null;
  readonly guestDestructibleCount: number | null;
  readonly lagTelemetry: {
    readonly accepted: boolean;
    readonly acceptedTick: number | null;
    readonly rewindTicks: number;
    readonly clamped: boolean;
    readonly rejectedReason?: string;
    readonly catchupSubsteps: number;
    readonly errorDistance?: number;
  } | null;
  readonly hostMetrics: {
    readonly tickRate: number;
    readonly snapshotRate: number;
    readonly snapshotSizes: { readonly p50: number; readonly p95: number; readonly p99: number };
    readonly snapshotsProduced: number;
    readonly packetsSent: number;
    readonly packetsDropped: number;
    readonly bytesProduced: number;
    readonly bytesSentByPeer: Readonly<Record<string, number>>;
    readonly totalUploadBytes: number;
  } | null;
  readonly predictionTelemetry: {
    readonly samples: number;
    readonly negligible: number;
    readonly soft: number;
    readonly hard: number;
    readonly acknowledgedInputs: number;
    readonly replayedInputs: number;
    readonly p50Error: number;
    readonly p95Error: number;
    readonly p99Error: number;
    readonly maxError: number;
  } | null;
}

/**
 * Browser-side signaling remains deterministic, while the game connection is
 * still the production RTCPeerConnection/DataChannel path. The hub carries
 * only the authenticated signaling/action messages between isolated contexts.
 */
class DeterministicSignalingHub {
  private readonly peers = new Map<string, PeerRecord>();
  private readonly handshakes = new Map<string, HandshakeRecord>();
  private sequence = 0;

  async attach(page: Page): Promise<void> {
    await page.exposeBinding('__xoMockRegister', (source, peerId: string, roomId: string) => this.register(source.page, peerId, roomId));
    await page.exposeBinding('__xoMockHandshakeSend', (source, from: string, to: string, data: unknown) => this.handshakeSend(source.page, from, to, data));
    await page.exposeBinding('__xoMockHandshakeDone', (_source, from: string, to: string, ok: boolean) => this.handshakeDone(from, to, ok));
    await page.exposeBinding('__xoMockActionSend', (_source, from: string, namespace: string, data: unknown, target: unknown) => this.actionSend(from, namespace, data, target));
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
    if (!ok) { handshake.failed = true; return; }
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
      if (namespace === 'xo-game-signal-v1' && isRecord(data) && data.type === 'offer') {
        const peerJoinComplete = await this.evaluate(sender.page, '__xoMockIsPeerJoinComplete', peerId);
        if (peerJoinComplete !== true) {
          await this.evaluate(sender.page, '__xoMockRecordEarlyGameOffer', peerId);
        }
      }
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

  private async evaluate(page: Page, method: string, ...args: unknown[]): Promise<unknown> {
    if (page.isClosed()) return undefined;
    return page.evaluate(({ methodName, values }) => {
      const fn = (window as unknown as Record<string, unknown>)[methodName];
      if (typeof fn === 'function') return (fn as (...items: unknown[]) => unknown)(...values);
      return undefined;
    }, { methodName: method, values: args }).catch(() => undefined);
  }
}

async function openPeer(browser: Browser, hub: DeterministicSignalingHub): Promise<BrowserPeer> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console:${message.text()} @ ${message.location().url}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) browserErrors.push(`http:${response.status()}:${response.url()}`);
  });
  await hub.attach(page);
  await page.addInitScript((preferredSlots) => {
    const settings: Record<string, unknown> = { onboarded: true, playerSkin: 'vanguard', lang: 'en' };
    if (preferredSlots !== null) settings.preferredItemSlots = preferredSlots;
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify(settings));
  }, process.env.XO_MODE_MATRIX === '1' ? MATRIX_PREFERRED_SLOTS : null);
  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as unknown as { __xoGameplayTest?: unknown }).__xoGameplayTest));
  await page.evaluate(() => {
    const test = (window as unknown as { __xoGameplayTest: { latest: unknown } }).__xoGameplayTest;
    (test as unknown as { __browserErrors?: string[] }).__browserErrors = [];
  });
  if (browserErrors.length > 0) throw new Error(browserErrors.join('\n'));
  return { context, page };
}

async function snapshot(peer: BrowserPeer): Promise<GameplaySnapshot> {
  return peer.page.evaluate(() => {
    const test = (window as unknown as { __xoGameplayTest?: { latest: GameplaySnapshot } }).__xoGameplayTest;
    if (test) return test.latest;
    return {
      role: 'idle', screen: 'main', coordinatorState: 'missing', phase: null, hostTick: 0, networkTick: null,
      aliveCount: null, localActorId: null, actors: [], destructibles: [], lobbyPlayers: [], lobbyMap: null, lobbyMode: null, winner: null, events: [], notices: [], inviteLink: '', inviteCode: '',
      startPayload: null, error: `test hook missing at ${location.href}`, inputPackets: 0, directStates: [],
      hostDestructibleCount: null, guestDestructibleCount: null, lagTelemetry: null,
      hostMetrics: null, predictionTelemetry: null,
    } satisfies GameplaySnapshot;
  });
}

async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
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

type MatrixMode = Exclude<MatchMode, 'solo'>;

interface ModeMatrixCase {
  readonly name: string;
  readonly mode: MatrixMode;
  readonly guests: number;
  readonly teams?: readonly (0 | 1)[];
  readonly rosterSize: number;
}

const MODE_MATRIX: readonly ModeMatrixCase[] = Object.freeze([
  { name: '2-player FFA', mode: 'ffa', guests: 1, rosterSize: 2 },
  { name: '3-player FFA', mode: 'ffa', guests: 2, rosterSize: 3 },
  { name: '4-player FFA', mode: 'ffa', guests: 3, rosterSize: 4 },
  { name: '4 humans + 6 Bots', mode: 'ffa-bot-fill', guests: 3, rosterSize: 10 },
  { name: '1v1', mode: 'teams', guests: 1, teams: [0, 1], rosterSize: 2 },
  { name: '2v1', mode: 'teams', guests: 2, teams: [0, 1, 0], rosterSize: 3 },
  { name: '2v2', mode: 'teams', guests: 3, teams: [0, 1, 0, 1], rosterSize: 4 },
  { name: '5v5 Bot fill', mode: 'teams-bot-fill', guests: 3, teams: [0, 1, 0, 1], rosterSize: 10 },
  { name: '4 humans vs 6 Bots', mode: 'humans-vs-bots', guests: 3, teams: [0, 0, 0, 0], rosterSize: 10 },
]);

type GameplayAction = 'setSkin' | 'setMap' | 'setMode' | 'setTeam' | 'setInput' | 'resetPredictionTelemetry'
  | 'fastForwardTransport' | 'pickupWeapons' | 'prepareCombat' | 'breakUpperGlass' | 'finishMatch' | 'returnToMenu';

async function action<T>(peer: BrowserPeer, name: GameplayAction, value?: unknown): Promise<T> {
  return peer.page.evaluate(({ actionName, actionValue }) => {
    const test = (window as unknown as { __xoGameplayTest: { actions: Record<string, (...args: unknown[]) => unknown> } }).__xoGameplayTest;
    const operation = test.actions[actionName];
    if (typeof operation !== 'function') throw new Error(`Missing gameplay action: ${actionName}`);
    const args = Array.isArray(actionValue) ? actionValue : actionValue === undefined ? [] : [actionValue];
    return operation(...args);
  }, { actionName: name, actionValue: value }) as Promise<T>;
}

function localActor(value: GameplaySnapshot): GameplaySnapshot['actors'][number] {
  const actor = value.actors.find((candidate) => candidate.id === value.localActorId);
  assert.ok(actor, `local actor ${String(value.localActorId)} is present`);
  return actor;
}

async function modeMatrixMain(): Promise<void> {
  const output = process.env.QA_MODE_MATRIX_OUT ?? '/tmp/xo-beta-phase5-online-mode-matrix.json';
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const allPeers: BrowserPeer[] = [];
  const results: Array<Record<string, unknown>> = [];
  try {
    server = await createServer({
      server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false },
      logLevel: 'silent',
    });
    await server.listen();
    browser = await selectedBrowserType().launch({ headless: process.env.HEADLESS === '1' });

    for (const [caseIndex, testCase] of MODE_MATRIX.entries()) {
      const hub = new DeterministicSignalingHub();
      const peers: BrowserPeer[] = [];
      const host = await openPeer(browser, hub);
      peers.push(host); allPeers.push(host);
      const hostName = `MATRIX-HOST-${caseIndex + 1}`;
      const invite = await createRoom(host, hostName);
      await action(host, 'setMap', 'neocity');

      for (let guestIndex = 0; guestIndex < testCase.guests; guestIndex++) {
        const guest = await openPeer(browser, hub);
        peers.push(guest); allPeers.push(guest);
        await joinRoom(guest, invite.link, `MATRIX-GUEST-${caseIndex + 1}-${guestIndex + 1}`);
      }

      await waitUntil(async () => {
        const values = await Promise.all(peers.map(snapshot));
        return values.every((value) => value.lobbyPlayers.length === testCase.guests + 1
          && value.lobbyPlayers.every((player) => player.directState === 'open'));
      }, `${testCase.name} direct lobby channels`, 60_000);

      const skins = ['vanguard', 'pathfinder', 'specter', 'striker'] as const;
      for (const [index, peer] of peers.entries()) await action(peer, 'setSkin', skins[index]!);
      await action(host, 'setMode', testCase.mode);
      if (testCase.teams && testCase.mode !== 'humans-vs-bots') {
        const lobby = await snapshot(host);
        assert.equal(lobby.lobbyPlayers.length, testCase.teams.length, `${testCase.name} human roster is complete before team assignment`);
        for (const [index, teamId] of testCase.teams.entries()) {
          await action(host, 'setTeam', [lobby.lobbyPlayers[index]!.participantId, teamId]);
        }
      }
      await waitUntil(async () => {
        const value = await snapshot(host);
        return value.lobbyMap === 'neocity' && value.lobbyMode === testCase.mode
          && value.lobbyPlayers.length === testCase.guests + 1
          && value.lobbyPlayers.every((player, index) => player.skinId === skins[index]);
      }, `${testCase.name} lobby configuration`, 30_000);

      for (const peer of peers) await peer.page.click('#btn-lobby-ready');
      await waitUntil(async () => (await snapshot(host)).lobbyPlayers.every((player) => player.ready), `${testCase.name} ready barrier`, 30_000);
      await host.page.click('#btn-lobby-start');
      await waitUntil(async () => {
        const values = await Promise.all(peers.map(snapshot));
        return values.every((value) => value.startPayload !== null
          && (value.coordinatorState === 'waiting-ready' || value.coordinatorState === 'countdown' || value.coordinatorState === 'active'));
      }, `${testCase.name} canonical start`, 60_000);

      const started = await Promise.all(peers.map(snapshot));
      const canonicalPayload = started[0]!.startPayload!;
      for (const value of started) assert.deepEqual(value.startPayload, canonicalPayload, `${testCase.name} canonical payload matches on every peer`);
      assert.equal(canonicalPayload.mapId, 'neocity', `${testCase.name} map is canonical`);
      assert.equal(canonicalPayload.mode, testCase.mode, `${testCase.name} mode is canonical`);
      assert.equal(canonicalPayload.roster.length, testCase.rosterSize, `${testCase.name} roster capacity`);
      const humanRoster = canonicalPayload.roster.filter((entry) => entry.ownership.kind !== 'bot');
      assert.equal(humanRoster.length, testCase.guests + 1, `${testCase.name} human roster count`);
      assert.deepEqual(humanRoster.map((entry) => entry.skinId), skins.slice(0, testCase.guests + 1), `${testCase.name} skin assignment`);
      assert.ok(humanRoster.every((entry) => entry.preferredItemSlots?.enabled === true), `${testCase.name} preferred pickup profile is admitted`);
      assert.ok(humanRoster.every((entry) => entry.preferredItemSlots?.slots[0] === 'pistol'), `${testCase.name} preferred pistol slot is admitted`);
      if (testCase.mode === 'humans-vs-bots') {
        assert.ok(humanRoster.every((entry) => entry.teamId === 0), `${testCase.name} humans are on team 0`);
        assert.ok(canonicalPayload.roster.filter((entry) => entry.ownership.kind === 'bot').every((entry) => entry.teamId === 1), `${testCase.name} Bots are on team 1`);
      } else if (testCase.mode === 'teams' || testCase.mode === 'teams-bot-fill') {
        assert.ok(canonicalPayload.roster.some((entry) => entry.teamId === 0), `${testCase.name} has team 0`);
        assert.ok(canonicalPayload.roster.some((entry) => entry.teamId === 1), `${testCase.name} has team 1`);
      } else {
        assert.ok(canonicalPayload.roster.every((entry) => entry.teamId === null), `${testCase.name} FFA has no teams`);
      }

      await waitUntil(async () => (await snapshot(host)).coordinatorState === 'active'
        && (await snapshot(peers[1]!)).coordinatorState === 'active', `${testCase.name} active transport`, 30_000);
      assert.equal(await action<boolean>(host, 'fastForwardTransport'), true, `${testCase.name} host transport control`);
      await waitUntil(async () => {
        const values = await Promise.all(peers.map(snapshot));
        return values.every((value) => value.phase !== 'transport' && value.actors.length === testCase.rosterSize
          && value.actors.every((actor) => actor.deployed));
      }, `${testCase.name} deployment`, 30_000);

      const picked = await action<readonly { actorId: number; slot: number }[]>(host, 'pickupWeapons');
      assert.equal(picked.length, testCase.guests + 1, `${testCase.name} authoritative pickups for every human`);
      await waitUntil(async () => (await Promise.all(peers.map(snapshot))).every((value) => {
        const owner = localActor(value);
        return owner.inventory?.slots.some((item) => (item as { weaponId?: string } | null)?.weaponId === 'pistol') === true
          && value.actors.filter((actor) => actor.id !== value.localActorId).every((actor) => actor.inventory === null)
          && value.events.filter((event) => event === 'itemPickedUp').length === testCase.guests + 1;
      }), `${testCase.name} inventory synchronization`, 30_000);
      assert.ok(picked.every((entry) => entry.slot === 0), `${testCase.name} preferred pickup placement`);

      const guest = peers[1]!;
      await action(guest, 'resetPredictionTelemetry');
      await action(guest, 'setInput', { moveZ: 0, crouchHeld: true });
      await waitUntil(async () => localActor(await snapshot(guest)).crouched, `${testCase.name} crouch prediction`, 10_000);
      await action(guest, 'setInput', null);
      await waitUntil(async () => ((await snapshot(guest)).predictionTelemetry?.samples ?? 0) > 0, `${testCase.name} prediction reconciliation`, 10_000);
      const crouch = await snapshot(guest);
      assert.ok((crouch.predictionTelemetry?.samples ?? 0) > 0, `${testCase.name} prediction samples`);

      assert.equal(await action<boolean>(host, 'prepareCombat'), true, `${testCase.name} deterministic combat setup`);
      await waitUntil(async () => (await snapshot(host)).phase === 'live', `${testCase.name} live combat`, 10_000);
      const combatBefore = await snapshot(host);
      const hostActorBefore = combatBefore.actors.find((actor) => actor.id === 1);
      const guestActorBefore = combatBefore.actors.find((actor) => actor.id === 2);
      assert.ok(hostActorBefore && guestActorBefore);
      const friendly = hostActorBefore.teamId !== null && hostActorBefore.teamId === guestActorBefore.teamId;
      await guest.page.click('#btn-runtime-fire');
      await waitUntil(async () => (await snapshot(host)).events.includes('shotFired'), `${testCase.name} authoritative shot`, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const combatAfter = await snapshot(host);
      if (friendly) {
        assert.equal(combatAfter.actors.find((actor) => actor.id === 1)?.health, hostActorBefore.health, `${testCase.name} friendly fire remains disabled`);
        assert.equal(combatAfter.events.includes('actorHit'), false, `${testCase.name} friendly shot has no hit event`);
      }

      assert.equal(await action<boolean>(host, 'breakUpperGlass'), true, `${testCase.name} upper-floor glass control`);
      await waitUntil(async () => (await Promise.all(peers.map(snapshot))).every((value) => value.events.filter((event) => event === 'glassBreak').length === 1), `${testCase.name} glass replication`, 15_000);
      const glassStates = await Promise.all(peers.map(snapshot));
      const destroyed = glassStates[0]!.destructibles.filter((item) => item.destroyed).map((item) => item.id).sort();
      assert.ok(destroyed.length > 0, `${testCase.name} upper-floor glass is destroyed`);
      for (const value of glassStates) assert.deepEqual(value.destructibles.filter((item) => item.destroyed).map((item) => item.id).sort(), destroyed, `${testCase.name} glass state agrees`);

      assert.equal(await action<boolean>(host, 'finishMatch', 1), true, `${testCase.name} authoritative elimination`);
      await waitUntil(async () => (await Promise.all(peers.map(snapshot))).every((value) => value.phase === 'results' && value.winner !== null), `${testCase.name} legal results`, 30_000);
      const resultsSnapshots = await Promise.all(peers.map(snapshot));
      for (const value of resultsSnapshots) {
        assert.equal(value.events.filter((event) => event === 'matchWon').length, 1, `${testCase.name} winner event is not duplicated`);
        assert.ok(value.events.filter((event) => event === 'eliminated').length > 0, `${testCase.name} has an elimination`);
        assert.equal(value.winner?.kind, testCase.mode === 'teams' || testCase.mode === 'teams-bot-fill' || testCase.mode === 'humans-vs-bots' ? 'team' : 'actor', `${testCase.name} winner type is legal`);
      }

      for (const peer of peers.slice(1)) await action(peer, 'returnToMenu');
      await action(host, 'returnToMenu');
      await waitUntil(async () => (await Promise.all(peers.map(snapshot))).every((value) => value.screen === 'main' && value.role === 'idle' && value.coordinatorState === 'none'), `${testCase.name} resource disposal`, 20_000);
      results.push({
        name: testCase.name,
        mode: testCase.mode,
        humanCount: testCase.guests + 1,
        rosterSize: testCase.rosterSize,
        preferredPickupSlot: picked[0]?.slot ?? null,
        crouchPredictionSamples: crouch.predictionTelemetry?.samples ?? 0,
        predictionHardCorrections: crouch.predictionTelemetry?.hard ?? 0,
        resourceDisposed: true,
      });
    }
    const report = {
      capturedAt: new Date().toISOString(),
      browser: `${process.env.XO_BROWSER ?? 'chromium'} (Playwright-managed engine)`,
      headed: process.env.HEADLESS !== '1',
      signaling: 'deterministic in-memory hub; no server relay',
      transport: 'native RTCPeerConnection/DataChannels',
      matrix: results,
      note: 'Same-machine local protocol lifecycle evidence; not external-network compatibility evidence.',
    };
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await closePeers(allPeers);
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

async function createRoom(host: BrowserPeer, displayName = 'HOST'): Promise<{ link: string; code: string }> {
  await host.page.click('#open-create');
  await host.page.fill('#create-display-name', displayName);
  await host.page.click('#btn-confirm-create-room');
  await host.page.waitForSelector('#online-lobby-menu:not(.hidden)');
  return host.page.evaluate(() => {
    const view = (window as unknown as { __xoGameplayTest: { latest: GameplaySnapshot } }).__xoGameplayTest.latest;
    return { link: view.inviteLink, code: view.inviteCode };
  });
}

async function joinRoom(guest: BrowserPeer, invite: string, displayName = 'GUEST'): Promise<void> {
  await guest.page.click('#open-join');
  await guest.page.fill('#join-room-invite', invite);
  await guest.page.fill('#join-display-name', displayName);
  await guest.page.click('#btn-confirm-join-room');
  await guest.page.waitForSelector('#online-lobby-menu:not(.hidden)', { timeout: 20_000 });
}

async function main(): Promise<void> {
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const peers: BrowserPeer[] = [];
  try {
    // Disable Vite HMR so a concurrent source edit cannot reload an isolated
    // peer while a long-running authoritative-match assertion is polling it.
    server = await createServer({
      server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false },
      logLevel: 'silent',
    });
    await server.listen();
    browser = await selectedBrowserType().launch({ headless: true });
    const hub = new DeterministicSignalingHub();
    const host = await openPeer(browser, hub);
    peers.push(host);
    const invite = await createRoom(host);
    // Use the bounded Eden fixture for the browser smoke path. It exercises
    // authored glass while keeping host simulation cost low enough that the
    // two independent 60 Hz browser loops do not drift during headless CI.
    await host.page.evaluate(async () => {
      await (window as unknown as { __xoGameplayTest: { controller: { setMap(mapId: string): Promise<void> } } })
        .__xoGameplayTest.controller.setMap('neocity');
    });
    const guest = await openPeer(browser, hub);
    peers.push(guest);
    await joinRoom(guest, invite.link);
    await waitUntil(async () => (await snapshot(host)).directStates.includes('open'), 'direct game channel');
    const signalingDiagnostics = await host.page.evaluate(() => (
      (window as unknown as { __xoMockGetDiagnostics: () => { earlyGameOffers: number } })
        .__xoMockGetDiagnostics()
    ));
    assert.equal(signalingDiagnostics.earlyGameOffers, 0, 'initial SDP offer waits for the Trystero onPeerJoin activation');
    assert.equal((await snapshot(host)).role, 'host');
    assert.equal((await snapshot(guest)).role, 'guest');

    await host.page.selectOption('#lobby-mode', 'ffa');
    try {
      await waitUntil(async () => (await snapshot(host)).directStates.every((value) => value === 'open'), 'lobby direct states');
    } catch (error) {
      console.error(JSON.stringify({ host: await snapshot(host), guest: await snapshot(guest) }, null, 2));
      throw error;
    }
    await host.page.click('#btn-lobby-ready');
    await guest.page.click('#btn-lobby-ready');
    await waitUntil(async () => (await snapshot(host)).coordinatorState === 'none'
      && (await snapshot(guest)).coordinatorState === 'none', 'ready lobby state');
    await host.page.click('#btn-lobby-start');
    try {
      await waitUntil(async () => (await snapshot(host)).coordinatorState === 'waiting-ready', 'host start barrier');
    } catch (error) {
      console.error(JSON.stringify({ host: await snapshot(host), guest: await snapshot(guest) }, null, 2));
      throw error;
    }
    try {
      await waitUntil(async () => (await snapshot(guest)).startPayload !== null, 'guest canonical start payload', 30_000);
    } catch (error) {
      console.error(JSON.stringify({ host: await snapshot(host), guest: await snapshot(guest) }, null, 2));
      throw error;
    }
    const preparedHost = await snapshot(host);
    const preparedGuest = await snapshot(guest);
    assert.deepEqual(preparedGuest.startPayload, preparedHost.startPayload, 'guest accepts the exact canonical start payload');
    assert.equal((preparedHost.startPayload as { mapId: string }).mapId, 'neocity', 'the heavy browser map is explicit');
    assert.equal(preparedHost.hostDestructibleCount, preparedGuest.guestDestructibleCount, 'host and guest share the destructible dictionary');
    await waitUntil(async () => (await snapshot(host)).coordinatorState === 'countdown'
      && (await snapshot(guest)).coordinatorState === 'countdown', 'start countdown', 20_000);
    await waitUntil(async () => (await snapshot(host)).coordinatorState === 'active'
      && (await snapshot(guest)).coordinatorState === 'active', 'active match', 20_000);

    const deployed = await host.page.evaluate(() => (
      (window as unknown as { __xoGameplayTest: { actions: { fastForwardTransport(): boolean } } })
        .__xoGameplayTest.actions.fastForwardTransport()
    ));
    assert.equal(deployed, true, 'host fixture exposes transport fast-forward');
    await waitUntil(async () => (await snapshot(host)).phase !== 'transport', 'transport deployment', 12_000);
    const deploymentTick = (await snapshot(host)).hostTick;
    await waitUntil(async () => (await snapshot(host)).hostTick >= deploymentTick + 6, 'post-deployment baseline');
    await guest.page.evaluate(() => {
      (window as unknown as { __xoGameplayTest: { actions: { resetPredictionTelemetry(): void } } })
        .__xoGameplayTest.actions.resetPredictionTelemetry();
    });
    const predictionStartTick = (await snapshot(host)).hostTick;
    await guest.page.evaluate(() => {
      (window as unknown as { __xoGameplayTest: { actions: { setInput(input: { moveZ: number; sprint: boolean }): void } } })
        .__xoGameplayTest.actions.setInput({ moveZ: 1, sprint: true });
    });
    await waitUntil(async () => (await snapshot(host)).hostTick >= predictionStartTick + 12, 'predicted guest movement');
    await guest.page.evaluate(() => {
      (window as unknown as { __xoGameplayTest: { actions: { setInput(input: null): void } } })
        .__xoGameplayTest.actions.setInput(null);
    });
    await waitUntil(async () => (await snapshot(host)).hostTick >= predictionStartTick + 18, 'movement reconciliation');
    await waitUntil(async () => ((await snapshot(guest)).predictionTelemetry?.samples ?? 0) > 0, 'prediction telemetry sample');
    const movementPrediction = (await snapshot(guest)).predictionTelemetry;
    assert.ok((movementPrediction?.samples ?? 0) > 0, 'guest reconciles predicted movement');
    const combatPrepared = await host.page.evaluate(() => (
      (window as unknown as { __xoGameplayTest: { actions: { prepareCombat(): boolean } } })
        .__xoGameplayTest.actions.prepareCombat()
    ));
    assert.equal(combatPrepared, true, 'host fixture can place both actors for deterministic combat');
    await waitUntil(async () => (await snapshot(host)).phase === 'live', 'live combat state');
    await guest.page.click('#btn-runtime-fire');
    try {
      await waitUntil(async () => (await snapshot(host)).events.includes('shotFired'), 'authoritative shot event');
    } catch (error) {
      console.error(JSON.stringify({ host: await snapshot(host), guest: await snapshot(guest) }, null, 2));
      throw error;
    }
    const glassBroken = await host.page.evaluate(() => (
      (window as unknown as { __xoGameplayTest: { actions: { breakGlass(): boolean } } })
        .__xoGameplayTest.actions.breakGlass()
    ));
    assert.equal(glassBroken, true, 'host fixture can authoritatively break a glass destructible');
    await waitUntil(async () => (await snapshot(guest)).events.includes('glassBreak'), 'replicated glass break');
    const eliminated = await host.page.evaluate(() => (
      (window as unknown as { __xoGameplayTest: { actions: { eliminateHost(): boolean } } })
        .__xoGameplayTest.actions.eliminateHost()
    ));
    assert.equal(eliminated, true, 'host fixture can authoritatively eliminate the host Actor');
    await waitUntil(async () => (await snapshot(host)).actors.some((actor) => actor.id === 1 && !actor.alive), 'host enters spectating state');
    await waitUntil(async () => (await snapshot(guest)).actors.some((actor) => actor.id === 1 && !actor.alive), 'guest sees eliminated host');
    await waitUntil(async () => (await snapshot(host)).phase === 'results'
      && (await snapshot(guest)).phase === 'results', 'authoritative results', 20_000);
    const healthyHost = await snapshot(host);
    const healthyGuest = await snapshot(guest);
    assert.equal(healthyHost.error, null, 'host reports no protocol/runtime error before leave');
    assert.equal(healthyGuest.error, null, 'guest reports no protocol/runtime error before leave');
    assert.equal(healthyHost.lagTelemetry?.accepted, true, 'browser firing uses host lag compensation');
    await guest.page.click('#btn-runtime-leave');
    await waitUntil(async () => (await snapshot(guest)).screen === 'main' && (await snapshot(guest)).role === 'idle', 'return to menu');

    const finalHost = await snapshot(host);
    const finalGuest = await snapshot(guest);
    assert.ok(finalHost.hostTick > 0, 'host fixed simulation advanced');
    assert.ok(finalHost.inputPackets === 0, 'host does not sample guest input');
    assert.ok(finalGuest.inputPackets > 0, 'guest sends compact input ticks');
    for (const event of ['shotFired', 'glassBreak', 'eliminated', 'matchWon']) {
      assert.ok(finalHost.events.includes(event), `host observed authoritative ${event}`);
      assert.ok(finalGuest.events.includes(event), `guest received reliable ${event}`);
    }
    console.log(JSON.stringify({
      isolatedContexts: peers.length,
      directConnection: 'same-machine WebRTC DataChannels',
      path: ['create', 'join', 'ready', 'start-barrier', 'transport', 'combat', 'glass', 'elimination', 'spectating', 'results', 'menu'],
      hostTick: finalHost.hostTick,
      guestInputPackets: finalGuest.inputPackets,
      hostEvents: finalHost.events,
      guestEvents: finalGuest.events,
      lagCompensation: healthyHost.lagTelemetry,
      hostNetwork: healthyHost.hostMetrics,
      guestPrediction: movementPrediction,
      note: 'deterministic localhost signaling; not real-network compatibility evidence',
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
  return typeof value === 'object' && value !== null;
}

void (process.env.XO_MODE_MATRIX === '1' ? modeMatrixMain() : main());
