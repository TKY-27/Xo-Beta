/**
 * Perf attribution harness (iteration 21+): boots NEO CITY under different
 * quality configs and reports FPS + CPU(sim/present) + real draw stats.
 * Run: npx tsx tests/browser/qa-perf2.ts [map]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const BASE = {
  quality: 'ultra', resolutionScale: 1, shadows: true, shadowQuality: 'high',
  postProcessing: true, bloom: true, ao: true, aa: 'smaa',
};

const CONFIGS: Array<[string, Record<string, unknown>]> = [
  ['ultra', {}],
  ['noao', { ao: false }],
  ['nobloom', { bloom: false }],
  ['nopost', { postProcessing: false }],
  ['noshadow', { shadows: false }],
  ['shadowmed', { shadowQuality: 'medium' }],
  ['res075', { resolutionScale: 0.75 }],
  ['res05', { resolutionScale: 0.5 }],
  ['res065', { resolutionScale: 0.65 }],
  ['raw', { postProcessing: false, aa: 'off' }],
  ['rawnoshadow', { postProcessing: false, aa: 'off', shadows: false }],
  ['rawnoibl', { postProcessing: false, aa: 'off', shadows: false, quality: 'medium' }],
  ['fxaa', { aa: 'fxaa' }],
  ['highq', { quality: 'high', shadowQuality: 'medium' }],
];

async function measure(page: import('playwright').Page, stress: boolean): Promise<Record<string, number>> {
  const evalSoft = async <T>(expr: string, ms = 6000): Promise<T | null> =>
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
  await page.waitForTimeout(2500);
  if (stress) {
    await page.evaluate('window.__xoStress && window.__xoStress()');
    await page.waitForTimeout(1200);
  }
  // real draw stats: accumulate across the frame (composer resets per pass)
  await page.evaluate(`(async () => {
    const r = window.__xoState.threeRenderer.info;
    r.autoReset = false;
    r.reset();
    window.__frames = 0;
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => { window.__frames++; if (performance.now() - t0 > 500) res(null); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  })()`);
  const info = await evalSoft<string>('JSON.stringify(window.__xoState.threeRenderer.info.render)');
  const frames = await evalSoft<number>('window.__frames');
  await page.evaluate('window.__xoState.threeRenderer.info.autoReset = true');
  const perf = await evalSoft<string>('JSON.stringify(window.__xoState.perf)');
  // FPS sample
  const fps = await page.evaluate(`(async () => {
    const s = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => { s.push(performance.now()); if (s.length >= 180 || performance.now() - t0 > 5000) res(null); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const d = [];
    for (let i = 1; i < s.length; i++) d.push(s[i] - s[i - 1]);
    d.sort((a, b) => a - b);
    // best-window estimate: median of the fastest contiguous 60-frame span
    // (robust against occlusion throttling hiccups in headed runs)
    let best = Infinity;
    for (let i = 60; i < d.length; i++) {
      let sum = 0;
      for (let k = i - 59; k <= i; k++) sum += d[k];
      best = Math.min(best, sum / 60);
    }
    const avg = d.reduce((a, b) => a + b, 0) / d.length;
    return { avgFps: Math.round(1000 / avg), bestFps: Math.round(1000 / best), n: d.length };
  })()`);
  const i2 = info ? JSON.parse(info) : {};
  const p2 = perf ? JSON.parse(perf) : {};
  void evalSoft;
  const f = Math.max(1, frames ?? 1);
  return {
    avgFps: (fps as { avgFps: number }).avgFps,
    bestFps: (fps as { bestFps: number }).bestFps,
    simMs: p2.simMs ?? -1,
    presentMs: p2.presentMs ?? -1,
    drawsPerFrame: Math.round((i2.calls ?? 0) / f),
    mtrisPerFrame: +((i2.triangles ?? 0) / f / 1e6).toFixed(2),
  };
}

async function main(): Promise<void> {
  const map = process.argv[2] ?? 'neocity';
  const stress = process.argv.includes('--stress');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  // NOTE: do NOT pass --use-angle=metal/--enable-gpu — that flag path falls
  // back to a severely constrained software/ANGLE backend.
  // Headed mode (HEADED=1) is the honest measurement: headless frame
  // scheduling throttles rAF without the metal-flag workaround.
  const headed = process.env.HEADED === '1';
  const browser = await chromium.launch({ headless: !headed, args: [] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));

  for (const [name, patch] of CONFIGS) {
    if (only && name !== only) continue;
    const cfg = { ...BASE, ...patch };
    await page.addInitScript((c) => {
      localStorage.setItem('xo-beta-settings-v1', JSON.stringify(c));
    }, cfg);
    await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
    await page.waitForTimeout(400);
    await page.click('#btn-play');
    await page.waitForTimeout(300);
    if (map !== 'neocity') {
      const idx = ['neocity', 'oldfront', 'eden'].indexOf(map) + 1;
      await page.click(`#map-list .map-card:nth-child(${idx})`);
    }
    await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
    await page.bringToFront();
    const stats = await measure(page, stress);
    console.log(`${map}/${name}${stress ? '/stress' : ''}:`, JSON.stringify(stats));
  }
  console.log('errors:', errors.length, errors.slice(0, 3));
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
