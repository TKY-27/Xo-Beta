/**
 * Perf profile: boots each map at 1600x900 ultra, samples rAF deltas for
 * 4s after a 2s warmup, reports avg/1%-low FPS + scene stats.
 * Run: npx tsx tests/browser/qa-perf.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const MAPS = ['neocity', 'oldfront', 'eden'] as const;

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'ultra', shadows: true, shadowQuality: 'high',
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
    if (map !== 'neocity') await page.click(`#map-list .map-card:nth-child(${idx})`);
    await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });

    const evalSoft = async <T>(expr: string, ms = 5000): Promise<T | null> =>
      Promise.race([page.evaluate(expr) as Promise<T>, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    for (let i = 0; i < 120; i++) {
      const ph = await evalSoft<string>('window.__xoState ? window.__xoState.phase : "?"');
      if (ph === 'live') break;
      await page.keyboard.press('Space');
      await page.waitForTimeout(600);
    }
    for (let i = 0; i < 60; i++) {
      const pl = await evalSoft<string>('window.__xoState ? JSON.stringify(window.__xoState.player) : "none"', 2500);
      if (pl && pl.includes('"grounded":true')) break;
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(2000); // warmup (shader compile, streaming)

    const stats = await page.evaluate(`(async () => {
      const samples = [];
      const t0 = performance.now();
      await new Promise((res) => {
        const tick = () => {
          samples.push(performance.now());
          if (samples.length >= 240 || performance.now() - t0 > 6000) res(null);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const deltas = [];
      for (let i = 1; i < samples.length; i++) deltas.push(samples[i] - samples[i - 1]);
      deltas.sort((a, b) => a - b);
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const p1 = deltas[Math.floor(deltas.length * 0.01)] ?? deltas[0];
      const p99 = deltas[Math.floor(deltas.length * 0.99)] ?? deltas[deltas.length - 1];
      const st = window.__xoState ? window.__xoState.sceneInfo : {};
      return {
        frames: deltas.length,
        avgFps: Math.round(1000 / avg),
        lowFps: Math.round(1000 / p99),
        highFps: Math.round(1000 / p1),
        triangles: st.triangles, drawCalls: st.drawCalls,
        lights: st.lights ? st.lights.length : 0,
      };
    })()`);
    console.log(map, JSON.stringify(stats));
  }
  console.log('errors:', errors.length, errors.slice(0, 3));
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
