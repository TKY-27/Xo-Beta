/**
 * Perf profile: boots each map at 1600x900 ultra, samples rAF deltas for
 * one chronological 4s warm-up + 6s steady interval, then reports temporal
 * frame metrics and scene stats for each production map.
 * Run: npx tsx tests/browser/qa-perf.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { summarizeFrameProfile } from './frame-metrics';

const MAPS = ['neocity', 'oldfront', 'eden', 'ashara'] as const;

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const headless = process.env.HEADLESS === '1';
  if (headless) console.warn('HEADLESS=1 is diagnostic only; it is not release QA evidence.');
  const browser = await chromium.launch({ channel: 'chrome', headless });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 160));
  });
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      onboarded: true, quality: 'ultra', shadows: true, shadowQuality: 'high',
      postProcessing: true, bloom: true, aa: 'smaa', resolutionScale: 1,
    }));
  });

  for (const map of MAPS) {
    await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
    await page.waitForTimeout(500);
    await page.click('#btn-play');
    await page.waitForTimeout(300);
    const idx = MAPS.indexOf(map) + 1;
    await page.click(`#map-list .map-card:nth-child(${idx})`);
    await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });

    const evalSoft = async <T>(expr: string, ms = 5000): Promise<T | null> =>
      Promise.race([page.evaluate(expr) as Promise<T>, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    let live = false;
    for (let i = 0; i < 120; i++) {
      const ph = await evalSoft<string>('window.__xoState ? window.__xoState.phase : "?"');
      if (ph === 'live') { live = true; break; }
      await page.keyboard.press('Space');
      await page.waitForTimeout(600);
    }
    if (!live) throw new Error(`${map}: perf capture never reached live phase`);
    let grounded = false;
    for (let i = 0; i < 60; i++) {
      const pl = await evalSoft<string>('window.__xoState ? JSON.stringify(window.__xoState.player) : "none"', 2500);
      if (pl && pl.includes('"grounded":true')) { grounded = true; break; }
      await page.waitForTimeout(400);
    }
    if (!grounded) throw new Error(`${map}: perf capture never reached grounded state`);
    const raw = await page.evaluate(`(async () => {
      const samples = [];
      const t0 = performance.now();
      await new Promise((res) => {
        const tick = () => {
          samples.push(performance.now());
          if (performance.now() - t0 > 10250) res(null);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const deltas = [];
      for (let i = 1; i < samples.length; i++) deltas.push(samples[i] - samples[i - 1]);
      const st = window.__xoState ? window.__xoState.sceneInfo : {};
      return { deltas, scene: {
        triangles: st.triangles, drawCalls: st.drawCalls,
        lights: st.lights ? st.lights.length : 0,
      } };
    })()`);
    const stats = raw as { deltas: number[]; scene: Record<string, number> };
    const profile = summarizeFrameProfile(stats.deltas, 4000, 6000);
    const numeric = [...Object.values(profile.warmup), ...Object.values(profile.steady)];
    if (profile.warmup.n < 30 || profile.steady.n < 60 || numeric.some((value) => !Number.isFinite(value))) {
      throw new Error(`${map}: invalid frame profile ${JSON.stringify(profile)}`);
    }
    if (errors.length > 0) throw new Error(`${map}: browser errors: ${errors.join(' | ')}`);
    console.log(map, JSON.stringify({
      mode: headless ? 'headless-diagnostic' : 'headed-chrome',
      ...profile,
      scene: stats.scene,
    }));
  }
  console.log('errors:', errors.length, errors.slice(0, 3));
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
