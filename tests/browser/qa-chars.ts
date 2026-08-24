/** Character inspection: TPS close-ups of combatants. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'low', shadows: false, shadowQuality: 'low',
      postProcessing: false, bloom: false, aa: 'off', resolutionScale: 0.7,
    }));
  });
  const map = process.argv[2] ?? 'neocity';
  await page.goto(`http://localhost:5199/?qa=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(1000);
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  if (map !== 'neocity') await page.click(`#map-list .map-card:nth-child(${['neocity','oldfront','eden'].indexOf(map)+1})`);
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500);
    const st = await Promise.race([
      page.evaluate('window.__xoState ? window.__xoState.player : null') as Promise<null | { grounded?: boolean }>,
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    if (st?.grounded) break;
  }
  // Switch to TPS
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(800);

  interface A { id:number; name:string; x:number; y:number; z:number; yaw:number }
  for (let shot = 0; shot < 4; shot++) {
    const actors = (await page.evaluate('window.__xoState ? window.__xoState.actors : []')) as A[];
    if (!actors.length) break;
    // pick a distant bot to avoid self
    const me = ((await page.evaluate('window.__xoState.player.x')) as number);
    const pool = actors.filter(a => Math.abs(a.x - me) > 2);
    if (!pool.length) continue;
    const target = pool[shot % pool.length]!;
    await page.evaluate((t) => {
      const tp = (window as unknown as { __xoTeleport?: (x: number, z: number, yaw: number) => void }).__xoTeleport;
      if (tp) tp(t.x - 2.4, t.z - 1.6, t.yaw + Math.PI);
    }, target);
    await page.waitForTimeout(2200);
    await page.screenshot({ path: `qa/char-${map}-${shot}.png`, timeout: 60000 });
    console.log('shot', shot, target.name);
  }
  console.log('errors:', errors.length);
  for (const e of errors.slice(0, 6)) console.log(' •', e);
  await browser.close();
  await server.close();
}
void main().catch((e) => { console.error(e); process.exit(1); });
