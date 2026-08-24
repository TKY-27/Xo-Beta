/**
 * Resolution probe: verifies actual canvas backing size + frame-time shape
 * at ultra. Run: HEADED=1 npx tsx tests/browser/probe-res.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const headed = process.env.HEADED === '1';
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-angle=metal', '--enable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'ultra', resolutionScale: 1, shadows: true, shadowQuality: 'high',
      postProcessing: true, bloom: true, ao: true, aa: 'smaa',
    }));
  });
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  const info1 = await page.evaluate('JSON.stringify({dpr: window.devicePixelRatio, cw: document.getElementById("game-canvas")?.width, ch: document.getElementById("game-canvas")?.height})');
  console.log('menu:', info1);
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(4000);
  const info2 = await page.evaluate(`(async () => {
    const c = document.getElementById('game-canvas');
    const s = [];
    const t0 = performance.now();
    await new Promise((res) => { const tick = () => { s.push(performance.now()); if (s.length >= 120) res(null); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    const d = []; for (let i = 1; i < s.length; i++) d.push(s[i] - s[i-1]);
    d.sort((a,b)=>a-b);
    return JSON.stringify({
      dpr: window.devicePixelRatio, cw: c?.width, ch: c?.height,
      avg: Math.round(d.reduce((a,b)=>a+b,0)/d.length*10)/10,
      med: d[Math.floor(d.length/2)], p90: d[Math.floor(d.length*0.9)], min: d[0], max: d[d.length-1],
    });
  })()`);
  console.log('game:', info2);
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
