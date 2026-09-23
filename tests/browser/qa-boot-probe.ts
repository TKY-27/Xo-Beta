/**
 * WebGPU migration boot probe: launches headed Chrome, boots the dev server,
 * and verifies the lobby/menu renders through the WebGPURenderer path.
 * Screenshots + backend identity + console errors go to qa/boot-probe/.
 *
 * Usage: npx tsx tests/browser/qa-boot-probe.ts
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';

const mapArg = (process.argv[2] ?? 'neocity').toLowerCase();
const mapIndex = ['neocity', 'oldfront', 'eden', 'ashara'].indexOf(mapArg) + 1;
const operations = process.env.QA_OPERATIONS === '1';
const fixed1080 = process.env.QA_FIXED1080 === '1';
const width = Number(process.env.QA_WIDTH ?? (fixed1080 ? 1920 : 1280));
const height = Number(process.env.QA_HEIGHT ?? (fixed1080 ? 1080 : 720));
if (![width, height].every((n) => Number.isInteger(n) && n > 0)) throw new Error('Invalid QA_WIDTH/QA_HEIGHT');
if (fixed1080 && (width !== 1920 || height !== 1080)) throw new Error('QA_FIXED1080 requires 1920x1080');
const OUT = process.env.QA_OUT ?? (operations ? 'qa/quality-rework/ar-operations' : `qa/boot-probe-${mapArg}`);
mkdirSync(OUT, { recursive: true });
const sourcePaths = ['tests/browser/qa-boot-probe.ts', 'src/main.ts', 'src/core/settings.ts', 'src/sim/combat.ts', 'src/player/controller.ts', 'src/render/viewmodel.ts', 'src/render/hands.ts', 'src/render/weaponModels.ts', 'src/render/weaponGeometry.ts', 'src/render/renderer.ts'];
const sourceHashes = () => Object.fromEntries(sourcePaths.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const hashesBefore = operations ? sourceHashes() : null;

// QA_PORT lets parallel review agents run probes without port conflicts.
const PORT = Number(process.env.QA_PORT ?? 5199);
const server = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'silent',
  plugins: operations ? [{
    name: 'qa-operations-readonly',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== `${process.cwd()}/src/main.ts`) return;
      return `${code}\nwindow.__xoOperationsRead = () => {
        const p = live?.kind === 'match' ? live.match.localActor : null;
        const w = p?.wpn;
        const vm = live?.viewmodel;
        const r = live?.renderer.renderer;
        const c = r?.domElement;
        return {
          now: performance.now(), timeOrigin: performance.timeOrigin,
          phase: livePhase(), alive: p?.alive ?? false, grounded: p?.body.grounded ?? false,
          weapon: p?.inv.selectedWeapon?.weaponId ?? null, ammo: p?.inv.selectedWeapon?.ammoInMag ?? null,
          shots: p?.stats.shotsFired ?? null, health: p?.health ?? null,
          reloadTimer: w?.reloadTimer ?? null, reloadTotal: w?.reloadTotal ?? null,
          reloadPhase: w && w.reloadTimer > 0 && w.reloadTotal > 0 ? 1 - w.reloadTimer / w.reloadTotal : null,
          reloadingEmpty: w?.reloadingEmpty ?? null, ads: w?.adsAmount ?? null,
          reloadOwner: vm?.currentModel?.group.userData.reloadOwner ?? null,
          settings: { cameraMode: getSettings().cameraMode, quality: getSettings().quality,
            postProcessing: getSettings().postProcessing, bloom: getSettings().bloom, ao: getSettings().ao,
            aa: getSettings().aa, resolutionScale: getSettings().resolutionScale,
            dynamicResolution: getSettings().dynamicResolution, shadows: getSettings().shadows,
            shadowQuality: getSettings().shadowQuality },
          backend: { exposed: !!r, isWebGPUBackend: r?.backend?.isWebGPUBackend ?? false,
            device: live?.renderer.gpuDeviceLabel() ?? null },
          render: { width: c?.width ?? null, height: c?.height ?? null,
            cssWidth: c?.clientWidth ?? null, cssHeight: c?.clientHeight ?? null,
            dpr: devicePixelRatio, pixelRatio: r?.getPixelRatio() ?? null,
            dynamicScale: live?.renderer.dynamicResolutionScale ?? null }
        };
      };`;
    },
  }] : [],
});
await server.listen();
const errors: string[] = [];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADLESS === '1',
  // Headless Chrome defaults to a software GL path that intermittently loses
  // the WebGPU device mid-probe; force the native Metal ANGLE backend.
  args: process.env.HEADLESS === '1' ? ['--use-angle=metal'] : [],
});
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: fixed1080 ? 1 : undefined,
  recordVideo: process.env.QA_VIDEO === '1' ? { dir: OUT, size: { width, height } } : undefined,
});
const page = await context.newPage();
const video = page.video();
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const text = msg.text();
    const phaseMatch = text.match(/PHASE=(\S+)/);
    errors.push(`[${phaseMatch?.[1] ?? 'unknown'}] ${text.split('\n')[0]!.slice(0, 170)}`);
  }
});
page.on('pageerror', (err) => errors.push(String(err)));

const gfx = process.env.QA_GFX ?? 'full';
const gfxConfigs: Record<string, Record<string, unknown>> = {
  // (cameraMode forced separately below)
  raw: { quality: 'high', postProcessing: false, bloom: false, ao: false, aa: 'off', resolutionScale: 1 },
  noshadow: { quality: 'high', postProcessing: false, bloom: false, ao: false, aa: 'off', shadows: false, shadowQuality: 'low', resolutionScale: 1 },
  post: { quality: 'high', postProcessing: true, bloom: false, ao: true, aa: 'off', resolutionScale: 1 },
  bloom: { quality: 'high', postProcessing: true, bloom: true, ao: false, aa: 'off', resolutionScale: 1 },
  ao: { quality: 'ultra', postProcessing: true, bloom: false, ao: true, aa: 'off', resolutionScale: 1 },
  smaa: { quality: 'high', postProcessing: true, bloom: false, ao: false, aa: 'smaa', resolutionScale: 1 },
  full: { quality: 'ultra', postProcessing: true, bloom: true, ao: true, aa: 'smaa', resolutionScale: 1 },
};
const gfxSettings: Record<string, unknown> = { cameraMode: 'fps', playerSkin: process.env.QA_SKIN ?? 'vanguard', onboarded: true, ...gfxConfigs[gfx], ...(fixed1080 ? { dynamicResolution: false, resolutionScale: 1 } : {}) };
await page.addInitScript((settings) => {
  window.localStorage.setItem('xo-beta-settings-v1', JSON.stringify(settings));
}, gfxSettings);
if (process.env.QA_FORCE_WEBGL === '1') {
  // Verify the WebGL2 fallback backend through the same code path.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined });
  });
}
type OperationSample = {
  now: number; timeOrigin: number; phase: string | null; alive: boolean; grounded: boolean;
  weapon: string | null; ammo: number | null; shots: number | null; health: number | null;
  reloadTimer: number | null; reloadTotal: number | null; reloadPhase: number | null;
  reloadingEmpty: boolean | null; ads: number | null; reloadOwner: string | null;
  settings: Record<string, unknown>; backend: Record<string, unknown>;
  render: { width: number | null; height: number | null; dpr: number; dynamicScale: number | null };
};
type OperationsWindow = Window & {
  __xoOperationsRead: () => OperationSample;
  __xoQaInput: (input: { firePressed?: boolean; fireHeld?: boolean; adsHeld?: boolean } | null) => void;
  __xoOperationsSamples: OperationSample[];
  __xoOperationsRecording: boolean;
};
const frames: unknown[] = [];
const actions: unknown[] = [];
let telemetry: OperationSample[] = [];
const phaseTargets: Array<{ label: string; target: number; origin: number; observed: OperationSample }> = [];
const screencast: Array<{ timestampMs: number | null; data: Buffer }> = [];
let screencastCollecting = false;
const startScreencast = async () => {
  const session = await context.newCDPSession(page);
  session.on('Page.screencastFrame', (frame: { sessionId: number; data?: string; metadata?: { timestamp?: number } }) => {
    void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    if (screencastCollecting && frame.data) {
      screencast.push({
        timestampMs: typeof frame.metadata?.timestamp === 'number' ? frame.metadata.timestamp * 1000 : null,
        data: Buffer.from(frame.data, 'base64'),
      });
    }
  });
  await session.send('Page.enable');
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1, maxWidth: width, maxHeight: height });
};
const nearestScreencastFrame = (nowMs: number, toleranceMs = 80) => {
  let best: { timestampMs: number | null; data: Buffer } | null = null;
  let bestDelta = Infinity;
  for (const frame of screencast) {
    if (frame.timestampMs === null) continue;
    const delta = Math.abs(frame.timestampMs - nowMs);
    if (delta < bestDelta) { bestDelta = delta; best = frame; }
  }
  return best && bestDelta <= toleranceMs
    ? { frame: best, deltaMs: bestDelta }
    : null;
};
const readOperation = () => page.evaluate(() => (window as unknown as OperationsWindow).__xoOperationsRead());
const screencastDir = `${OUT}/screencast`;
mkdirSync(screencastDir, { recursive: true });
const capture = async (label: string, target: number | null = null, origin: number | null = null) => {
  const before = await readOperation();
  const path = `${OUT}/${label}-${Math.round(before.now)}ms.png`;
  await page.screenshot({ path });
  const after = await readOperation();
  frames.push({ label, path, target, before, after,
    elapsedMs: origin === null ? null : before.now - origin,
    screenshotIntervalMs: after.now - before.now,
    targetErrorBefore: target === null || before.reloadPhase === null ? null : before.reloadPhase - target,
    precision: 'Screenshot occurred between before/after observations; not an exact phase frame.' });
};
const capturePhaseTarget = async (label: string, target: number, origin: number) => {
  await page.waitForFunction((value) => {
    const sample = (window as unknown as OperationsWindow).__xoOperationsRead();
    return !sample.alive || sample.phase !== 'live' || sample.reloadPhase === null || sample.reloadPhase >= value;
  }, target, { timeout: 10000 });
  const observed = await readOperation();
  phaseTargets.push({ label, target, origin, observed });
};
const savePhaseFrames = () => {
  for (const { label, target, origin, observed } of phaseTargets) {
    const match = nearestScreencastFrame(observed.timeOrigin + observed.now);
    const frameNow = match?.frame.timestampMs === null || !match ? null : match.frame.timestampMs - observed.timeOrigin;
    const nearestSample = frameNow === null ? null : telemetry.reduce<OperationSample | null>((best, sample) =>
      !best || Math.abs(sample.now - frameNow) < Math.abs(best.now - frameNow) ? sample : best, null);
    const entry: Record<string, unknown> = {
      label, target, observed, elapsedMs: observed.now - origin,
      observedReloadPhase: observed.reloadPhase, observedReloadOwner: observed.reloadOwner,
      framePath: null, frameTimestampMs: frameNow, frameDeltaMs: match?.deltaMs ?? null,
      frameElapsedMs: frameNow === null ? null : frameNow - origin,
      nearestFrameSample: nearestSample,
      frameSampleDeltaMs: nearestSample && frameNow !== null ? Math.abs(nearestSample.now - frameNow) : null,
      precision: match
        ? 'Timestamp-matched compositor frame; nearest telemetry is not an exact render-phase guarantee.'
        : 'Not captured: no screencast frame within 80 ms. Video, when enabled, remains the continuous record.',
    };
    if (match) {
      const path = `${screencastDir}/${label}-${Math.round(frameNow!)}ms.jpg`;
      writeFileSync(path, match.frame.data);
      entry.framePath = path;
    }
    frames.push(entry);
  }
};
const runOperations = async () => {
  const initial = await readOperation();
  if (initial.phase !== 'live' || !initial.alive || !initial.grounded || initial.weapon !== 'ar') {
    throw new Error(`AR operations require live grounded AR: ${JSON.stringify(initial)}`);
  }
  if (fixed1080 && (initial.render.width !== 1920 || initial.render.height !== 1080 || initial.render.dpr !== 1
    || initial.settings.dynamicResolution !== false || initial.render.dynamicScale !== 1)) {
    throw new Error(`Fixed1080 mismatch: ${JSON.stringify(initial.render)} ${JSON.stringify(initial.settings)}`);
  }
  await startScreencast();
  await page.evaluate(() => {
    const w = window as unknown as OperationsWindow;
    w.__xoOperationsSamples = [];
    w.__xoOperationsRecording = true;
    const tick = () => {
      if (!w.__xoOperationsRecording) return;
      w.__xoOperationsSamples.push(w.__xoOperationsRead());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  screencastCollecting = true;
  await capture('operation-hip');
  const shoot = async (adsHeld: boolean) => {
    const result = await page.evaluate(async (ads) => {
      const w = window as unknown as OperationsWindow;
      const before = w.__xoOperationsRead();
      w.__xoQaInput({ firePressed: true, fireHeld: true, adsHeld: ads });
      let current = before;
      do {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        w.__xoQaInput({ fireHeld: true, adsHeld: ads });
        current = w.__xoOperationsRead();
      } while (current.alive && current.phase === 'live' && (current.shots ?? 0) < (before.shots ?? 0) + 3 && current.now - before.now < 4000);
      w.__xoQaInput(ads ? { adsHeld: true } : null);
      return { before, after: current };
    }, adsHeld);
    actions.push({ input: adsHeld ? 'ADS fire via __xoQaInput' : 'hip fire via __xoQaInput', ...result });
    if ((result.after.shots ?? 0) <= (result.before.shots ?? 0)) throw new Error('No actual shot observed');
    await capture(adsHeld ? 'operation-ads-fired' : 'operation-hip-fired');
  };
  await shoot(false);
  const reloadBefore = await readOperation();
  actions.push({ input: 'keyboard KeyR', before: reloadBefore });
  await page.keyboard.press('r');
  await page.waitForFunction(() => ((window as unknown as OperationsWindow).__xoOperationsRead().reloadTimer ?? 0) > 0, undefined, { timeout: 5000 });
  const reloadStart = await readOperation();
  const trackSource = readFileSync('src/render/viewmodel.ts', 'utf8');
  const arTrack = trackSource.match(/ar: \{ contact:[^}]+\}/)?.[0];
  if (!arTrack) throw new Error('AR reload track not found');
  const boundaries = [...arTrack.matchAll(/(contact|extracted|stowed|fetched|aligned|seated|released|action): ([\d.]+)/g)]
    .map((match) => ({ label: `handoff-${match[1]}`, value: Number(match[2]) }));
  const targets = [...[0, 15, 30, 45, 60, 75, 90].map((percent) => ({ label: `reload-${percent}`, value: percent / 100 })), ...boundaries]
    .sort((a, b) => a.value - b.value);
  for (const target of targets) {
    await capturePhaseTarget(target.label, target.value, reloadBefore.now);
  }
  await page.waitForFunction(() => (window as unknown as OperationsWindow).__xoOperationsRead().reloadTimer === 0, undefined, { timeout: 10000 });
  await capturePhaseTarget('reload-end', 1, reloadBefore.now);
  const reloadEnd = await readOperation();
  actions.push({ input: 'reload outcome', before: reloadStart, after: reloadEnd, boundaries });
  if ((reloadEnd.ammo ?? 0) <= (reloadBefore.ammo ?? 0)) throw new Error('Reload did not replenish ammo');
  await page.evaluate(() => (window as unknown as OperationsWindow).__xoQaInput({ adsHeld: true }));
  await capture('operation-ads-start');
  await page.waitForFunction(() => ((window as unknown as OperationsWindow).__xoOperationsRead().ads ?? 0) > 0.95, undefined, { timeout: 5000 });
  await capture('operation-ads-held');
  await shoot(true);
  await page.evaluate(() => (window as unknown as OperationsWindow).__xoQaInput(null));
  await page.waitForTimeout(500);
  await capture('operation-ads-released');
  const final = await readOperation();
  if (final.phase !== 'live' || !final.alive) throw new Error('Live gameplay ended during operation capture');
};
if (operations) {
  await page.addInitScript(() => {
    (window as unknown as { __name?: unknown }).__name = (f: unknown) => f;
  });
}
const qaHide = process.env.QA_HIDE ?? '';
const seed = process.env.QA_SEED ?? '42042';
const qaQuery = `${qaHide ? `&qaHide=${qaHide}` : ''}&seed=${seed}`;
await page.goto(`http://localhost:${PORT}/?qa=1${qaQuery}`, { waitUntil: 'networkidle' });
// Fresh profiles land on the first-run onboarding overlay; its handlers only
// attach once boot completes, so poll for whichever screen appears first and
// clear onboarding before waiting for the menu.
for (let i = 0; i < 60; i++) {
  const onboarding = await page.$('#onboarding-screen:not(.hidden)');
  if (onboarding) {
    await page.click('#btn-onb-en');
    await page.waitForTimeout(200);
    await page.click('#btn-onb-fp');
    await page.waitForTimeout(300);
    break;
  }
  const menu = await page.$('#main-menu:not(.hidden)');
  if (menu) break;
  await page.waitForTimeout(500);
}
await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
await page.waitForTimeout(1000);
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/01-menu.png` });

const backend = await page.evaluate(() => {
  const w = window as unknown as {
    __xoState?: { threeRenderer?: { backend?: { isWebGPUBackend?: boolean } } };
  };
  const r = w.__xoState?.threeRenderer;
  return {
    exposed: Boolean(r),
    isWebGPUBackend: r?.backend?.isWebGPUBackend ?? null,
    adapterName: navigator.gpu ? 'navigator.gpu present' : 'navigator.gpu missing',
  };
});

// Try entering a match (NeoCity) to exercise the game render path.
try {
  await page.click('#btn-play', { timeout: 3000 });
  await page.click(`#map-list .map-card:nth-child(${mapIndex})`, { timeout: 3000 });
  await page.click('#btn-play-start', { timeout: 3000 });
  // Wait for HUD (up to 60 s: warmup + transport).
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 150000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/02-transport.png` });
  // Jump from the transport and wait for ground.
  await page.keyboard.press('Space');
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    const phase = await page.evaluate(() => (window as unknown as { __xoState?: { phase?: string; player?: { grounded?: boolean; state?: string } } }).__xoState?.player);
    if (phase?.grounded && phase.state !== 'freefall' && phase.state !== 'glide') break;
  }
  await page.waitForFunction(() => {
    const state = (window as unknown as { __xoState?: { phase?: string; player?: { grounded?: boolean } } }).__xoState;
    return state?.phase === 'live' && state.player?.grounded;
  }, undefined, { timeout: 150000 });
  await page.screenshot({ path: `${OUT}/03-grounded.png` });
  // Tactical-map aerial (top-down terrain render) when the DEV bridge
  // exposed it — the best view for tiling/texture-defect sweeps map-wide.
  try {
    const aerial = await page.evaluate(() => {
      const c = (window as unknown as { __xoAerial?: HTMLCanvasElement }).__xoAerial;
      return c ? c.toDataURL('image/png') : null;
    });
    if (aerial) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${OUT}/00-aerial.png`, Buffer.from(aerial.split(',')[1]!, 'base64'));
    }
  } catch { /* cosmetic */ }
  // Optional loadout (env QA_GIVE="weaponId:rarity") before the look shot.
  const give = process.env.QA_GIVE ?? (operations ? 'ar:common' : undefined);
  if (give) {
    const [wid, rar] = give.split(':');
    await page.evaluate((args) => {
      (window as unknown as { __xoGive?: (id: string, rarity: string) => void }).__xoGive?.(args[0]!, args[1] ?? 'common');
    }, [wid, rar]).catch(() => undefined);
    await page.waitForTimeout(900);
  }
  if (operations) {
    await runOperations();
  } else {
  // Pointer lock is unavailable headless-ish; force a ground-level view via
  // the QA teleport (same position, pitched down).
  await page.evaluate(() => {
    const pos = document.documentElement.dataset.xoQaPosition ?? '';
    const m = pos.match(/x=([-\d.]+),y=([-\d.]+),z=([-\d.]+)/) ?? pos.match(/([-\d.]+),([-\d.]+),([-\d.]+)/);
    const input = document.getElementById('xo-qa-teleport-command') as HTMLInputElement | null;
    if (!input) return;
    const cur = (window as unknown as { __xoState?: { camera?: { position?: { x: number; z: number } } } }).__xoState?.camera?.position;
    const x = m ? parseFloat(m[1]!) : (cur?.x ?? 0);
    const z = m ? parseFloat(m[3]!) : (cur?.z ?? 0);
    input.value = JSON.stringify({ nonce: `look-${Date.now()}`, x, z, yaw: 0, pitch: -0.28 });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }).catch(() => undefined);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/04-look.png` });
  // Optional teleport (env QA_TP="x,z[,yaw]") for POI-targeted captures.
  const tp = process.env.QA_TP;
  if (tp) {
    const [x, z, yaw, pitch, mode, refY] = tp.split(',').map((v) => v.trim());
    await page.evaluate((pos) => {
      const input = document.getElementById('xo-qa-teleport-command') as HTMLInputElement | null;
      if (input) {
        input.value = JSON.stringify({
          nonce: `tp-${Date.now()}`,
          x: Number(pos.x),
          z: Number(pos.z),
          yaw: pos.yaw === undefined || pos.yaw === '' ? 0 : Number(pos.yaw),
          pitch: pos.pitch === undefined || pos.pitch === '' ? -0.12 : Number(pos.pitch),
          mode: pos.mode === 'swim' ? 'swim' : undefined,
          refY: pos.refY === undefined || pos.refY === '' ? undefined : Number(pos.refY),
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, { x, z, yaw, pitch, mode, refY }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const posNow = await page.evaluate(() => ({
      pos: document.documentElement.dataset.xoQaPosition ?? 'unknown',
      result: document.documentElement.dataset.xoQaTeleportResult ?? 'no-result',
      inputVal: (document.getElementById('xo-qa-teleport-command') as HTMLInputElement | null)?.value ?? 'no-input',
    }));
    console.log(`after teleport: ${JSON.stringify(posNow)}`);
    // Attribute what the crosshair sits on (object/material identity).
    const picked = await page.evaluate(() => {
      const pick = (window as unknown as { __xoPick?: () => unknown }).__xoPick;
      return pick ? pick() : 'no-pick-bridge';
    });
    console.log(`center pick: ${JSON.stringify(picked)}`);
    await page.screenshot({ path: `${OUT}/05-teleport.png` });
    if (process.env.QA_ADS_PAIR === '1') {
      await page.evaluate(() => (window as unknown as OperationsWindow).__xoQaInput({ adsHeld: true }));
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `${OUT}/06-ads.png` });
      const camera = await page.evaluate(() => {
        const c = (window as unknown as { __xoState: { camera: { position: { toArray(): number[] }; quaternion: { toArray(): number[] }; fov: number } } }).__xoState.camera;
        return { position: c.position.toArray(), quaternion: c.quaternion.toArray(), fov: c.fov };
      });
      writeFileSync(`${OUT}/ads-pair.json`, JSON.stringify({ camera, sourceHashes: sourceHashes(), map: mapArg, teleport: tp, width, height, gfx, fixed1080 }, null, 2));
    }
  }
  // Optional shadow-pipeline introspection (env QA_INTROSPECT=1).
  if (process.env.QA_INTROSPECT === '1') {
    const shadow = await page.evaluate(() => {
      type LightRec = {
        isDirectionalLight?: boolean;
        intensity?: number;
        castShadow?: boolean;
        position?: { x: number; y: number; z: number };
        target?: { position: { x: number; y: number; z: number } };
        shadow?: null | {
          mapSize: { x: number; y: number };
          camera: { near: number; far: number };
          bias: number;
          normalBias: number;
          map?: { texture?: unknown } | null;
        };
      };
      type MeshRec = { isMesh?: boolean; receiveShadow?: boolean; castShadow?: boolean };
      type SceneRec = { traverse: (cb: (o: LightRec & MeshRec) => void) => void };
      const s = (window as unknown as {
        __xoState?: {
          threeRenderer?: { shadowMap?: { enabled?: boolean; type?: number } };
          scene?: SceneRec;
        };
      }).__xoState;
      if (!s?.scene) return 'no-scene';
      const suns: unknown[] = [];
      let recvCount = 0;
      let castCount = 0;
      let meshCount = 0;
      s.scene.traverse((o) => {
        if (o.isDirectionalLight) {
          suns.push({
            intensity: o.intensity,
            castShadow: o.castShadow,
            pos: o.position ? [o.position.x, o.position.y, o.position.z].map(Math.round) : null,
            target: o.target ? [o.target.position.x, o.target.position.y, o.target.position.z].map(Math.round) : null,
            shadow: o.shadow
              ? {
                  mapSize: [o.shadow.mapSize.x, o.shadow.mapSize.y],
                  near: o.shadow.camera.near,
                  far: o.shadow.camera.far,
                  bias: o.shadow.bias,
                  normalBias: o.shadow.normalBias,
                  mapAllocated: Boolean(o.shadow.map && o.shadow.map.texture),
                }
              : null,
          });
        }
        if (o.isMesh) {
          meshCount++;
          if (o.receiveShadow) recvCount++;
          if (o.castShadow) castCount++;
        }
      });
      return {
        shadowMapEnabled: s.threeRenderer?.shadowMap?.enabled ?? 'n/a',
        suns, meshCount, recvCount, castCount,
      };
    });
    console.log(`shadow introspect: ${JSON.stringify(shadow)}`);
    const bigMeshes = await page.evaluate(() => {
      type MeshRec = {
        name?: string;
        geometry?: { attributes?: { position?: { count?: number } } };
        material?: { type?: string };
        receiveShadow?: boolean;
        castShadow?: boolean;
        parent?: { name?: string; type?: string } | null;
      };
      const scene = (window as unknown as { __xoState?: { scene?: { traverse: (cb: (o: MeshRec) => void) => void } } }).__xoState?.scene;
      if (!scene) return 'no-scene';
      const out: unknown[] = [];
      scene.traverse((o) => {
        const count = o.geometry?.attributes?.position?.count ?? 0;
        if (count > 20000 || /terrain|ground/i.test(String(o.name ?? ''))) {
          out.push({
            name: o.name || '(unnamed)',
            verts: count,
            receive: o.receiveShadow,
            cast: o.castShadow,
            mat: o.material?.type,
            parent: o.parent ? (o.parent.name || o.parent.type) : '?',
          });
        }
      });
      return out;
    });
    console.log(`big meshes: ${JSON.stringify(bigMeshes)}`);
  }
  // Generic live-eval hook (env QA_EVAL='() => { ... }') for in-game probes.
  if (process.env.QA_EVAL) {
    const evalFn = new Function(`return (${process.env.QA_EVAL})()`) as () => unknown;
    const result = await page.evaluate(evalFn);
    console.log(`QA_EVAL: ${JSON.stringify(result)}`);
  }
  }
} catch (err) {
  errors.push(`match entry/operations failed: ${err}`);
} finally {
  if (operations) {
    telemetry = await page.evaluate(() => {
      const w = window as unknown as OperationsWindow;
      w.__xoQaInput?.(null);
      w.__xoOperationsRecording = false;
      return w.__xoOperationsSamples ?? [];
    });
    screencastCollecting = false;
    savePhaseFrames();
  }
}
await page.screenshot({ path: `${OUT}/05-final.png` });

const state = await page.evaluate(() => {
  const w = window as unknown as {
    __xoState?: { phase?: string; sceneInfo?: { drawCalls?: number; triangles?: number } };
    document?: Document;
  };
  return {
    phase: w.__xoState?.phase ?? null,
    drawCalls: w.__xoState?.sceneInfo?.drawCalls ?? null,
    triangles: w.__xoState?.sceneInfo?.triangles ?? null,
  };
});

const afterGame = operations ? await readOperation() : await page.evaluate(() => {
  const r = (window as unknown as { __xoState?: { threeRenderer?: { backend?: { isWebGPUBackend?: boolean }; domElement?: HTMLCanvasElement; getPixelRatio: () => number } } }).__xoState?.threeRenderer;
  return { backend: { exposed: Boolean(r), isWebGPUBackend: r?.backend?.isWebGPUBackend ?? null },
    render: { width: r?.domElement?.width ?? null, height: r?.domElement?.height ?? null, dpr: devicePixelRatio, pixelRatio: r?.getPixelRatio() ?? null } };
});
await context.close();
const videoPath = video ? await video.path() : null;
const report = { menuBackend: backend, afterGame, state, errors, videoPath, frames, actions,
  requested: { width, height, fixed1080, gfx, headless: process.env.HEADLESS === '1', operations, loadout: process.env.QA_GIVE ?? (operations ? 'ar:common' : null) },
  method: 'Normal menu, transport drop and live gameplay. QA grant is setup only. Read-only Vite bridge reads main live actor wpn; no actor timers or render poses written. Fire/ADS use __xoQaInput; reload uses keyboard R. Continuous video is browser-recorded, not guaranteed every rendered frame. Screenshots are sequential with before/after timestamps, not exact-phase claims.',
  hashesBefore, hashesAfter: operations ? sourceHashes() : null };
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
if (operations) writeFileSync(`${OUT}/telemetry.json`, JSON.stringify(telemetry, null, 2));
console.log(JSON.stringify({ backend: afterGame.backend, state, errors, videoPath, frames: frames.length, telemetrySamples: telemetry.length }, null, 2));
await browser.close();
await server.close();
if (errors.length > 0) process.exitCode = 2;
