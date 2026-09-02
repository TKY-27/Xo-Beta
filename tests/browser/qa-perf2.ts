/**
 * Perf attribution harness (iteration 21+): boots NEO CITY under different
 * quality configs and reports FPS + CPU(sim/present) + real draw stats.
 * Run: npx tsx tests/browser/qa-perf2.ts [map]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { summarizeFrameProfile } from './frame-metrics';

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
  let live = false;
  for (let i = 0; i < 120; i++) {
    const ph = await evalSoft<string>('window.__xoState ? window.__xoState.phase : "?"');
    if (ph === 'live') { live = true; break; }
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
  }
  if (!live) throw new Error('Perf attribution never reached live phase');
  let grounded = false;
  for (let i = 0; i < 60; i++) {
    const pl = await evalSoft<string>('window.__xoState ? JSON.stringify(window.__xoState.player) : "none"', 2500);
    if (pl && pl.includes('"grounded":true')) { grounded = true; break; }
    await page.waitForTimeout(400);
  }
  if (!grounded) throw new Error('Perf attribution never reached grounded state');
  if (stress) {
    const placement = await page.evaluate('window.__xoStress && window.__xoStress()') as null | {
      ok?: boolean;
      expected?: number;
      placed?: number;
      rejected?: number;
    };
    if (!placement?.ok || placement.placed !== placement.expected || placement.rejected !== 0) {
      throw new Error(`Stress placement incomplete: ${JSON.stringify(placement)}`);
    }
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
  // One chronological capture, split after collection. This prevents shader
  // warm-up frames and steady-state interaction frames from sharing metrics.
  const deltas = await page.evaluate(`(async () => {
    const s = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => { s.push(performance.now()); if (performance.now() - t0 > 10250) res(null); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const d = [];
    for (let i = 1; i < s.length; i++) d.push(s[i] - s[i - 1]);
    return d;
  })()`);
  const profile = summarizeFrameProfile(deltas as number[], 4000, 6000);
  const i2 = info ? JSON.parse(info) : {};
  const p2 = perf ? JSON.parse(perf) : {};
  void evalSoft;
  if (frames === null || frames <= 0) throw new Error(`Invalid draw-stat frame count: ${frames}`);
  const numeric = [...Object.values(profile.warmup), ...Object.values(profile.steady)];
  if (profile.warmup.n < 30 || profile.steady.n < 60 || numeric.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid frame profile: ${JSON.stringify(profile)}`);
  }
  const f = frames;
  const result = {
    warmupAvgFps: profile.warmup.avgFps,
    warmupP95Ms: profile.warmup.p95Ms,
    warmupP99Ms: profile.warmup.p99Ms,
    warmupWorstMs: profile.warmup.worstMs,
    steadyAvgFps: profile.steady.avgFps,
    steadyBestFps: profile.steady.bestFps,
    steadyOnePercentLowFps: profile.steady.onePercentLowFps,
    steadyP95Ms: profile.steady.p95Ms,
    steadyP99Ms: profile.steady.p99Ms,
    steadyWorstMs: profile.steady.worstMs,
    steadyOver33: profile.steady.over33,
    steadyOver50: profile.steady.over50,
    simMs: p2.simMs ?? -1,
    presentMs: p2.presentMs ?? -1,
    drawsPerFrame: Math.round((i2.calls ?? 0) / f),
    mtrisPerFrame: +((i2.triangles ?? 0) / f / 1e6).toFixed(2),
  };
  if (Object.values(result).some((value) => !Number.isFinite(value))) {
    throw new Error(`Non-finite perf attribution: ${JSON.stringify(result)}`);
  }
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const productionMaps = ['neocity', 'oldfront', 'eden', 'ashara'] as const;
  const requestedMap = args.find((arg) => !arg.startsWith('--'));
  if (requestedMap && !productionMaps.includes(requestedMap as typeof productionMaps[number])) {
    throw new Error(`Unknown map: ${requestedMap}`);
  }
  const maps = requestedMap ? [requestedMap] : [...productionMaps];
  const stress = args.includes('--stress');
  const scenario = args.find((a) => a.startsWith('--scenario='))?.slice(11) ?? 'practice';
  const scopeMag = args.find((a) => a.startsWith('--mag='))?.slice(6) ?? '2';
  if (!['practice', 'bot10', 'scope'].includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  const only = args.find((a) => a.startsWith('--only='))?.slice(7);
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  // NOTE: do NOT pass --use-angle=metal/--enable-gpu — that flag path falls
  // back to a severely constrained software/ANGLE backend.
  // Headed Chrome is the honest default measurement. HEADLESS=1 remains a
  // diagnostic-only override because headless frame scheduling distorts rAF.
  const headless = process.env.HEADLESS === '1';
  if (headless) console.warn('HEADLESS=1 is diagnostic only; it is not release QA evidence.');
  const browser = await chromium.launch({ channel: 'chrome', headless });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 160));
  });

  for (const map of maps) {
    for (const [name, patch] of CONFIGS) {
      if (only && name !== only) continue;
      const cfg = { onboarded: true, ...BASE, ...patch,
        ...(scenario === 'scope' ? { scopeMagnification: Number(scopeMag) } as Record<string, unknown> : {}) };
      await page.addInitScript((c) => {
        localStorage.setItem('xo-beta-settings-v1', JSON.stringify(c));
      }, cfg);
      const rosterQs = scenario === 'bot10' ? '&roster=4v6' : '';
      await page.goto(`http://localhost:5199/?qa=1${rosterQs}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
      await page.waitForTimeout(400);
      await page.click('#btn-play');
      await page.waitForTimeout(300);
      const idx = productionMaps.indexOf(map as typeof productionMaps[number]) + 1;
      await page.click(`#map-list .map-card:nth-child(${idx})`);
      await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
      await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
      await page.bringToFront();
      // Scenario setup: equip the sniper and hold ADS (right mouse) so the
      // measurement covers the scoped render path end to end.
      if (scenario === 'scope') {
        const gave = await page.evaluate('window.__xoGive ? window.__xoGive("sniper", "legendary") : false') as boolean;
        if (!gave) throw new Error('Scope scenario could not equip the sniper');
        await page.waitForTimeout(400);
        await page.mouse.down({ button: 'right' });
        await page.waitForTimeout(1200);
      }
      const stats = await measure(page, stress);
      if (scenario === 'scope') await page.mouse.up({ button: 'right' });
      if (errors.length > 0) throw new Error(`${map}/${name}: browser errors: ${errors.join(' | ')}`);
      console.log(`${map}/${name}${stress ? '/stress' : ''}/${scenario}${scenario === 'scope' ? `mag${scopeMag}` : ''}:`, JSON.stringify(stats));
    }
  }
  console.log('errors:', errors.length, errors.slice(0, 3));
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
