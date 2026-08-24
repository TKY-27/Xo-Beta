/**
 * Captures map hero images for the play-menu browser (one per map).
 * Teleports to a curated scenic vantage and screenshots at 1600x900.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const SPOTS: Record<string, Array<[number, number, number]>> = {
  // [x, z, yaw] — first entry is the hero card capture
  neocity: [[120, 120, Math.PI * 0.62], [0, 0, 0], [-40, 90, Math.PI * 0.78]],
  oldfront: [[110, 30, 1.2], [20, -30, Math.PI * 0.9], [-150, -150, 0.4]],
  eden: [[-90, -20, Math.PI * 0.85], [120, 40, 2.2], [10, -195, 0.8]],
};

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
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(600);

  for (const map of ['neocity', 'oldfront', 'eden']) {
    if (map !== 'neocity') {
      await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
      await page.waitForTimeout(600);
    }
    await page.click('#btn-play');
    await page.waitForTimeout(300);
    const idx = ['neocity', 'oldfront', 'eden'].indexOf(map) + 1;
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
    // wait for landing
    for (let i = 0; i < 60; i++) {
      const pl = await evalSoft<string>('window.__xoState ? JSON.stringify(window.__xoState.player) : "none"', 2500);
      if (pl && pl.includes('"grounded":true')) break;
      await page.waitForTimeout(400);
    }
    // Hide gameplay UI + FP viewmodel for clean hero art
    await page.addStyleTag({ content: '#hud,#tac-map-overlay,#captions,.interact-prompt{visibility:hidden!important}' });
    await page.evaluate(`(() => {
      const vm = window.__xoState && window.__xoState.viewmodel;
      if (vm) Object.defineProperty(vm, 'visible', { get: () => false, set: () => {}, configurable: true });
    })()`);
    await page.waitForTimeout(400);
    let shot = 0;
    for (const [x, z, yaw] of SPOTS[map]!) {
            await Promise.race([
        page.evaluate((a: number[]) => {
          (window as unknown as { __xoTeleport?: (x: number, z: number, yw: number) => void }).__xoTeleport?.(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
        }, [x, z, yaw]),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
      await page.waitForTimeout(1600);
      await page.screenshot({ path: `qa/hero-${map}-${shot}.png`, timeout: 60000 });
      if (shot === 0) {
        await page.screenshot({ path: `public/assets/maps/${map}.jpg`, type: 'jpeg', quality: 84, timeout: 60000 });
      }
      console.log(`captured ${map} #${shot}`);
      shot++;
    }
  }
  console.log('errors:', errors.length);
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
