/**
 * QA: measure the image-based-lighting ratio per map.
 *
 * `Scene.environmentIntensity` is inert under r185's node pipeline, so the real
 * lever is per-material `envMapIntensity`. This walks every map, teleports to a
 * representative viewpoint, and captures the default frame alongside reduced-IBL
 * frames so `SkyConfig.envMapScale` can be set from evidence instead of from
 * values that were tuned against an inert control.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const VITE_PORT = 5218;

const MAPS: Array<{ card: number; name: string; poi: { x: number; z: number; yaw: number; pitch: number } }> = [
  { card: 1, name: 'neocity', poi: { x: 0, z: 0, yaw: 0.6, pitch: -0.06 } },
  { card: 2, name: 'oldfront', poi: { x: 0, z: 0, yaw: 2.2, pitch: -0.05 } },
  { card: 3, name: 'eden', poi: { x: 0, z: 0, yaw: 1.1, pitch: -0.05 } },
  { card: 4, name: 'ashara', poi: { x: -34, z: 4, yaw: 0, pitch: -0.05 } },
];

const SCALES = [1, 0.4, 0.2];

async function main() {
  const server = await createServer({ server: { port: VITE_PORT }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--enable-unsafe-swiftshader'],
  });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.addInitScript(() => {
      localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
        quality: 'ultra', shadows: true, shadowQuality: 'high',
        postProcessing: true, bloom: true, aa: 'smaa', resolutionScale: 1,
      }));
    });
    for (const map of MAPS) {
      await page.goto(`http://localhost:${VITE_PORT}/?qa=1&roster=2v2`, { waitUntil: 'domcontentloaded' });
      for (let i = 0; i < 40; i++) {
        const onb = await page.$('#onboarding-screen:not(.hidden)');
        if (onb) {
          await page.click('#btn-onb-en'); await page.waitForTimeout(200);
          await page.click('#btn-onb-fp'); await page.waitForTimeout(300);
        }
        if (await page.$('#main-menu:not(.hidden)')) break;
        await page.waitForTimeout(500);
      }
      await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
      await page.click('#btn-play');
      await page.waitForTimeout(300);
      await page.click(`#map-list .map-card:nth-child(${map.card})`);
      await page.click('#btn-play-start');
      try {
        await page.waitForSelector('#hud:not(.hidden)', { timeout: 180000 });
      } catch (e) {
        await page.screenshot({ path: `qa/ibl-${map.name}-FAILED.png` });
        console.log('HUD TIMEOUT', map.name, String(e).slice(0, 120));
        continue;
      }
      await page.waitForTimeout(6000);
      await page.keyboard.press('Space');
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(1000);
        const st = await page.evaluate(() => ({
          phase: document.documentElement.dataset.xoQaPhase ?? '',
          collision: document.documentElement.dataset.xoQaCollision ?? '',
        }));
        if (st.phase === 'live' && /\|grounded=1(?:\||$)/.test(st.collision)) break;
      }
      await page.waitForTimeout(2500);
      await page.evaluate(() => {
        const revive = (window as unknown as { __xoQaRevive?: () => boolean }).__xoQaRevive;
        if (revive) revive();
      });
      await page.evaluate((request) => {
        const input = document.getElementById('xo-qa-teleport-command') as HTMLInputElement | null;
        if (!input) return;
        input.value = JSON.stringify({ nonce: `qa-${Date.now()}`, ...request });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, { ...map.poi, mode: 'standing' });
      await page.waitForTimeout(2500);
      for (const scale of SCALES) {
        const applied = await page.evaluate(
          (s) => (window as unknown as { __xoEnvQa: (v: number) => unknown }).__xoEnvQa(s),
          scale,
        );
        await page.waitForTimeout(900);
        const tag = scale === 1 ? 'default' : `ibl${String(scale).replace('.', '')}`;
        await page.screenshot({ path: `qa/ibl-${map.name}-${tag}.png` });
        console.log('SHOT', map.name, tag, JSON.stringify(applied));
      }
    }
  } finally {
    console.log('ERRORS', errors.length, errors.slice(0, 6));
    await browser.close();
    await server.close();
  }
}

main().then(() => process.exit(0));
