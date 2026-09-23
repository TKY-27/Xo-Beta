/**
 * Fast world-pass probe: boots a match, waits for ground, screenshots. 
 * Usage: npx tsx /tmp/qa-quick-probe.ts [map] 
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
const mapArg = (process.argv[2] ?? 'eden').toLowerCase();
const mapIndex = ['neocity', 'oldfront', 'eden', 'ashara'].indexOf(mapArg) + 1;
const PORT = Number(process.env.QA_PORT ?? 5230);
const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1', args: process.env.HEADLESS === '1' ? ['--use-angle=metal'] : [] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errors.push(String(e)));
const gfx = { cameraMode: 'fps', playerSkin: 'vanguard', onboarded: true, quality: 'ultra', postProcessing: true, bloom: true, ao: true, aa: 'smaa', resolutionScale: 1 };
await page.addInitScript((s) => { window.localStorage.setItem('xo-beta-settings-v1', JSON.stringify(s)); }, gfx);
await page.goto(`http://localhost:${PORT}/?qa=1&seed=42042`, { waitUntil: 'networkidle' });
for (let i = 0; i < 60; i++) {
  const onboarding = await page.$('#onboarding-screen:not(.hidden)');
  if (onboarding) { await page.click('#btn-onb-en'); await page.waitForTimeout(200); await page.click('#btn-onb-fp'); break; }
  if (await page.$('#main-menu:not(.hidden)')) break;
  await page.waitForTimeout(500);
}
await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
await page.click('#btn-play');
await page.click(`#map-list .map-card:nth-child(${mapIndex})`);
await page.click('#btn-play-start');
try {
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 30000 });
  } catch {
    console.log(JSON.stringify({ earlyErrors: errors }));
    await context.close();
    await browser.close();
    await server.close();
    process.exit(2);
  }
await page.waitForTimeout(2500);
await page.screenshot({ path: `/tmp/quick-${mapArg}-transport.png` });
await page.keyboard.press('Space');
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(1000);
  const grounded = await page.evaluate(() => {
    const s = (window as unknown as { __xoState?: { phase?: string; player?: { grounded?: boolean; state?: string } } }).__xoState;
    return s?.phase === 'live' && s.player?.grounded && s.player?.state !== 'freefall' && s.player?.state !== 'glide';
  });
  if (grounded) break;
}
await page.waitForTimeout(1000);
await page.evaluate(() => { (window as unknown as { __xoGive?: (id: string) => void }).__xoGive?.('ar'); });
await page.waitForTimeout(1200);
const diag = await page.evaluate(() => {
  const r = (window as unknown as { __xoState?: { threeRenderer?: { _clearColor?: unknown; alpha?: boolean; autoClear?: boolean } } }).__xoState?.threeRenderer;
  return { clearColor: r?._clearColor, alpha: r?.alpha, autoClear: r?.autoClear };
});
await page.screenshot({ path: `/tmp/quick-${mapArg}-ground.png` });
console.log(JSON.stringify({ diag, errors }));
await context.close();
await browser.close();
await server.close();
