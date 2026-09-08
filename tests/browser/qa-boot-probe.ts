/**
 * WebGPU migration boot probe: launches headed Chrome, boots the dev server,
 * and verifies the lobby/menu renders through the WebGPURenderer path.
 * Screenshots + backend identity + console errors go to qa/boot-probe/.
 *
 * Usage: npx tsx tests/browser/qa-boot-probe.ts
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';

const mapArg = (process.argv[2] ?? 'neocity').toLowerCase();
const mapIndex = ['neocity', 'oldfront', 'eden', 'ashara'].indexOf(mapArg) + 1;
const OUT = `qa/boot-probe-${mapArg}`;
mkdirSync(OUT, { recursive: true });

// QA_PORT lets parallel review agents run probes without port conflicts.
const PORT = Number(process.env.QA_PORT ?? 5199);
const server = await createServer({ server: { port: PORT }, logLevel: 'silent' });
await server.listen();
const errors: string[] = [];

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
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
const gfxSettings: Record<string, unknown> = { cameraMode: 'fps', playerSkin: process.env.QA_SKIN ?? 'vanguard', ...gfxConfigs[gfx] };
await page.addInitScript((settings) => {
  window.localStorage.setItem('xo-beta-settings-v1', JSON.stringify(settings));
}, gfxSettings);
if (process.env.QA_FORCE_WEBGL === '1') {
  // Verify the WebGL2 fallback backend through the same code path.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined });
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
  const give = process.env.QA_GIVE;
  if (give) {
    const [wid, rar] = give.split(':');
    await page.evaluate((args) => {
      (window as unknown as { __xoGive?: (id: string, rarity: string) => void }).__xoGive?.(args[0]!, args[1] ?? 'common');
    }, [wid, rar]).catch(() => undefined);
    await page.waitForTimeout(900);
  }
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
  }
} catch (err) {
  errors.push(`match entry failed: ${err}`);
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

console.log(JSON.stringify({ backend, state, errors }, null, 2));
await browser.close();
await server.close();
if (errors.length > 0) process.exitCode = 2;
