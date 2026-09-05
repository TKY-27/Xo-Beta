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

const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
await server.listen();
const errors: string[] = [];

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

const gfx = process.env.QA_GFX ?? 'full';
const gfxSettings: Record<string, unknown> = {
  raw: { quality: 'high', postProcessing: false, bloom: false, ao: false, aa: 'off', resolutionScale: 1 },
  post: { quality: 'high', postProcessing: true, bloom: false, ao: false, aa: 'off', resolutionScale: 1 },
  bloom: { quality: 'high', postProcessing: true, bloom: true, ao: false, aa: 'off', resolutionScale: 1 },
  ao: { quality: 'ultra', postProcessing: true, bloom: false, ao: true, aa: 'off', resolutionScale: 1 },
  smaa: { quality: 'high', postProcessing: true, bloom: false, ao: false, aa: 'smaa', resolutionScale: 1 },
  full: { quality: 'ultra', postProcessing: true, bloom: true, ao: true, aa: 'smaa', resolutionScale: 1 },
}[gfx] ?? {};
await page.addInitScript((settings) => {
  window.localStorage.setItem('xo-beta-settings-v1', JSON.stringify(settings));
}, gfxSettings);
if (process.env.QA_FORCE_WEBGL === '1') {
  // Verify the WebGL2 fallback backend through the same code path.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined });
  });
}
await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'networkidle' });
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
  await page.mouse.move(640, 360);
  await page.mouse.move(800, 340);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/04-look.png` });
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
