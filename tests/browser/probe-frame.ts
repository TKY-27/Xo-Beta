/**
 * Frame-cost bisect: samples FPS at full ultra, then with worldGroup hidden,
 * then storm hidden, then shadows off — isolates the per-pixel offender.
 * Run: HEADED=1 npx tsx tests/browser/probe-frame.ts [map]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const map = process.argv[2] ?? 'neocity';
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ headless: false, args: [] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'ultra', resolutionScale: 1, shadows: true, shadowQuality: 'high',
      postProcessing: true, bloom: true, ao: true, aa: 'smaa',
    }));
  });
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  if (map !== 'neocity') {
    const idx = ['neocity', 'oldfront', 'eden'].indexOf(map) + 1;
    await page.click(`#map-list .map-card:nth-child(${idx})`);
  }
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
  const evalSoft = async <T>(expr: string, ms = 6000): Promise<T | null> =>
    Promise.race([page.evaluate(expr) as Promise<T>, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  for (let i = 0; i < 120; i++) {
    const ph = await evalSoft<string>('window.__xoState ? window.__xoState.phase : "?"');
    if (ph === 'live') break;
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(2500);

  const sample = `async (label) => {
    const s = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => { s.push(performance.now()); if (s.length >= 150 || performance.now() - t0 > 4000) res(null); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const d = [];
    for (let i = 1; i < s.length; i++) d.push(s[i] - s[i - 1]);
    const avg = d.reduce((a, b) => a + b, 0) / d.length;
    return label + ': ' + Math.round(1000 / avg) + 'fps (' + Math.round(avg * 10) / 10 + 'ms, n=' + d.length + ')';
  }`;

  console.log(await evalSoft<string>(`(${sample})('a-normal')`));
  await page.evaluate('window.__w = window.__xoState.worldGroup; window.__w.visible = false');
  console.log(await evalSoft<string>(`(${sample})('b-worldHidden')`));
  await page.evaluate('window.__w.visible = true');
  await page.evaluate('window.__xoState.scene.traverse(o => { if (o.isMesh && o.material && o.material.transparent) o.visible = false })');
  console.log(await evalSoft<string>(`(${sample})('c-transparentHidden')`));
  await page.evaluate('window.__xoState.scene.traverse(o => { if (o.isMesh && o.visible === false && !o.userData.__wasHidden) o.visible = true })');
  await page.evaluate('window.__xoState.threeRenderer.shadowMap.enabled = false');
  console.log(await evalSoft<string>(`(${sample})('d-shadowsOff')`));
  await page.evaluate('window.__xoState.threeRenderer.shadowMap.enabled = true');
  // hide characters
  await page.evaluate('window.__xoState.scene.traverse(o => { if (o.isSkinnedMesh) o.visible = false })');
  console.log(await evalSoft<string>(`(${sample})('e-charsHidden')`));
  await page.evaluate('window.__xoState.scene.traverse(o => { if (o.isSkinnedMesh) o.visible = true })');
  const matInfo = await evalSoft<string>(`(() => {
    const seen = new Map();
    window.__xoState.scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const key = m.uuid;
        if (seen.has(key)) continue;
        seen.set(key, true);
        if (m.transparent || m.alphaTest > 0 || m.map || m.transmission > 0) {
          seen.set(m.uuid, JSON.stringify({
            name: m.name || m.type, transparent: m.transparent, alphaTest: m.alphaTest,
            transmission: m.transmission ?? 0, opacity: m.opacity, side: m.side, hasMap: !!m.map,
          }));
        }
      }
    });
    return JSON.stringify([...seen.values()].filter(Boolean));
  })()`);
  console.log('special mats:', matInfo);
  console.log('done');
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
