/**
 * QA: prove whether cast shadows actually reach the ground.
 *
 * A daylight frame with image-based lighting still present can hide a working
 * shadow map completely, and a frame with the key light behind the camera can
 * hide a broken one. This captures the same viewpoint with the IBL contribution
 * scaled to 1, 0.4 and 0 so any shadow that the rig produces is unmistakable,
 * and reports the live sun and shadow-camera state alongside each frame.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const VITE_PORT = 5219;

const CASES: Array<{ card: number; name: string; poi: Record<string, unknown> }> = [
  { card: 4, name: 'ashara-market', poi: { x: -34, z: -16, yaw: 0, pitch: -0.04, mode: 'standing' } },
  { card: 4, name: 'ashara-hall', poi: { x: -37.5, z: -24, yaw: -1.9, pitch: -0.03, mode: 'standing' } },
  { card: 2, name: 'oldfront', poi: { x: 6, z: -6, yaw: 2.6, pitch: -0.04, mode: 'standing' } },
];

const SCALES = [1, 0.4, 0];

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
    for (const c of CASES) {
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
      await page.click(`#map-list .map-card:nth-child(${c.card})`);
      await page.click('#btn-play-start');
      await page.waitForSelector('#hud:not(.hidden)', { timeout: 180000 });
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
      }, c.poi);
      await page.waitForTimeout(2500);
      const shadow = await page.evaluate(() => {
        const qa = window as unknown as { __xoShadowQa?: (x: number, z: number, r: number) => unknown };
        return qa.__xoShadowQa ? qa.__xoShadowQa(0, 0, 30) : null;
      });
      console.log('SHADOW', c.name, JSON.stringify(shadow).slice(0, 700));
      for (const scale of SCALES) {
        const applied = await page.evaluate(
          (s) => (window as unknown as { __xoEnvQa: (v: number) => unknown }).__xoEnvQa(s),
          scale,
        );
        await page.waitForTimeout(900);
        await page.screenshot({ path: `qa/shadow-${c.name}-ibl${String(scale).replace('.', '')}.png` });
        console.log('SHOT', c.name, scale, JSON.stringify(applied));
      }
    }
  } finally {
    console.log('ERRORS', errors.length, errors.slice(0, 6));
    await browser.close();
    await server.close();
  }
}

main().then(() => process.exit(0));
