/** One-off: TPS player-character visibility check on flat ground. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 200)));
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(500);
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
  // teleport to flat neocity plaza, TPS, walk forward
  await page.evaluate(() => {
    (window as unknown as { __xoTeleport?: (x: number, z: number, yw: number) => void }).__xoTeleport?.(20, 20, 0);
  });
  await page.waitForTimeout(600);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(400);
  const mode = await evalSoft<string>('window.__xoState ? window.__xoState.cameraMode : "?"');
  console.log('cameraMode:', mode);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'qa/tps-player.png', timeout: 60000 });
  await page.keyboard.up('KeyW');
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
