/**
 * Blind A/B capture: boots a match on the build this tree serves, grounds,
 * grants the AR, teleports to the authored viewpoint, waits for every
 * presentation spring to settle, then captures steady hip + ADS frames.
 * Runs unchanged against the old and new builds so the A/B judge sees the
 * same protocol on both sides.
 *
 * Usage: npx tsx tests/browser/ab-capture.ts <map> <outDir> <port>
 * Viewpoint: TP 0,0 facing 60,-40 (matches the campaign's fixed view).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';

const mapArg = (process.argv[2] ?? 'eden').toLowerCase();
const mapIndex = ['neocity', 'oldfront', 'eden', 'ashara'].indexOf(mapArg) + 1;
if (mapIndex === 0) throw new Error(`unknown map: ${mapArg}`);
const OUT = process.argv[3] ?? `/tmp/ab-capture/${mapArg}`;
const PORT = Number(process.argv[4] ?? 5501);
mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });

const gfx = { cameraMode: 'fps', playerSkin: 'vanguard', onboarded: true, quality: 'ultra', postProcessing: true, bloom: true, ao: true, aa: 'smaa', resolutionScale: 1 };
await page.addInitScript((s) => { window.localStorage.setItem('xo-beta-settings-v1', JSON.stringify(s)); }, gfx);
await page.goto(`http://localhost:${PORT}/?qa=1&seed=42042`, { waitUntil: 'networkidle' });
for (let i = 0; i < 40; i++) {
  const onboarding = await page.$('#onboarding-screen:not(.hidden)');
  if (onboarding) { await page.click('#btn-onb-en'); await page.waitForTimeout(200); await page.click('#btn-onb-fp'); break; }
  if (await page.$('#main-menu:not(.hidden)')) break;
  await page.waitForTimeout(500);
}
await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
await page.click('#btn-play');
await page.click(`#map-list .map-card:nth-child(${mapIndex})`);
await page.click('#btn-play-start');
await page.waitForSelector('#hud:not(.hidden)', { timeout: 150000 });
await page.keyboard.press('Space');
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(1000);
  const grounded = await page.evaluate(() => {
    const s = (window as unknown as { __xoState?: { phase?: string; player?: { grounded?: boolean; state?: string } } }).__xoState;
    return s?.phase === 'live' && s.player?.grounded && s.player?.state !== 'freefall' && s.player?.state !== 'glide';
  }).catch(() => false);
  if (grounded) break;
}
// Grant the weapon, then teleport to the fixed viewpoint.
await page.evaluate(() => { (window as unknown as { __xoGive?: (id: string) => void }).__xoGive?.('ar'); });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const input = document.getElementById('xo-qa-teleport-command') as HTMLInputElement | null;
  if (!input) return;
  input.value = JSON.stringify({ nonce: `ab-${Date.now()}`, x: 0, z: 0, yaw: 0, pitch: -0.1 });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
// Settle: weapon swap, sway, bob and any damage sway all decay before frames.
await page.waitForTimeout(4500);
await page.screenshot({ path: `${OUT}/hip.png` });
await page.evaluate(() => { (window as unknown as { __xoQaInput?: (o: unknown) => void }).__xoQaInput?.({ adsHeld: true }); });
await page.waitForTimeout(1600);
await page.screenshot({ path: `${OUT}/ads.png` });
console.log(JSON.stringify({ map: mapArg, out: OUT, errors }));
await browser.close();
await server.close();
