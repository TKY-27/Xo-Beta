/** One-off: transport-phase FP + TPS screenshots. */
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
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'qa/transport-fp.png', timeout: 60000 });
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'qa/transport-tps.png', timeout: 60000 });
  await page.keyboard.press('KeyV');
  // jump and capture the handoff
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'qa/transport-jump.png', timeout: 60000 });
  console.log('done');
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
