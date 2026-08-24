/** One-off: NEO CITY lighting verification screenshots. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

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
  await page.click('#btn-play');
  await page.waitForTimeout(300);
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
  // Hide HUD for clean captures
  await page.evaluate(() => { document.getElementById('hud')!.style.visibility = 'hidden'; });
  const spots: Array<[number, number, number, string]> = [
    [-40, 90, Math.PI * 0.78, 'street-north'],
    [60, -80, Math.PI * 0.3, 'street-east'],
    [120, 120, Math.PI * 0.6, 'neon-market'],
    [0, 0, Math.PI, 'spire-plaza'],
    [125, -125, Math.PI * 0.5, 'transit-hub'],
  ];
  let i = 0;
  for (const [x, z, yaw, label] of spots) {
    await Promise.race([
      page.evaluate((a: number[]) => {
        (window as unknown as { __xoTeleport?: (x: number, z: number, yw: number) => void }).__xoTeleport?.(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
      }, [x, z, yaw]),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `qa/nc-${i}-${label}.png`, timeout: 60000 });
    console.log('shot', label);
    i++;
  }
  console.log('errors:', errors.length);
  for (const e of errors.slice(0, 6)) console.log(' •', e);
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
