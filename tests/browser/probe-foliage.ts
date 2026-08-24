/**
 * Foliage side probe: measures fps + captures screenshots with DoubleSide vs
 * FrontSide foliage materials. Run: HEADED=1 npx tsx tests/browser/probe-foliage.ts [map]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const map = process.argv[2] ?? 'eden';
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
  await page.addStyleTag({ content: '#hud,#tac-map-overlay{visibility:hidden!important}' });

  const sample = `async () => {
    const s = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => { s.push(performance.now()); if (s.length >= 150 || performance.now() - t0 > 4000) res(null); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const d = [];
    for (let i = 1; i < s.length; i++) d.push(s[i] - s[i - 1]);
    let best = Infinity;
    for (let i = 60; i < d.length; i++) {
      let sum = 0;
      for (let k = i - 59; k <= i; k++) sum += d[k];
      best = Math.min(best, sum / 60);
    }
    return Math.round(1000 / best);
  }`;

  const foliageMats = `(() => {
    const mats = new Set();
    window.__xoState.scene.traverse((o) => {
      if (o.isMesh && o.material && o.material.alphaTest > 0) mats.add(o.material);
    });
    return [...mats];
  })()`;

  const fps0 = await evalSoft<string>(`(${sample})()`);
  console.log(map, 'Standard best fps:', fps0);
  await page.screenshot({ path: `qa/foliage-${map}-standard.png` });

  await page.evaluate(`(() => {
    const THREE = window.__xoState.THREE;
    const swap = new Map();
    window.__xoState.scene.traverse((o) => {
      if (o.isMesh && o.material && o.material.alphaTest > 0) {
        let l = swap.get(o.material);
        if (!l) {
          l = new THREE.MeshLambertMaterial({
            map: o.material.map, alphaTest: o.material.alphaTest, side: o.material.side,
            color: o.material.color.clone(), fog: true,
          });
          swap.set(o.material, l);
        }
        o.material = l;
      }
    });
  })()`);
  await page.waitForTimeout(600);
  const fps1 = await evalSoft<string>(`(${sample})()`);
  console.log(map, 'Lambert   best fps:', fps1);
  await page.screenshot({ path: `qa/foliage-${map}-lambert.png` });

  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
