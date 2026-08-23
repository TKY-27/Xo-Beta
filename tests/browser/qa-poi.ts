/** POI screenshot tour for one map (uses ?qa=1 teleport hook). */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const POIS: Record<string, Array<{ name: string; x: number; z: number; yaw: number }>> = {
  neocity: [
    { name: 'spire', x: 0, z: 30, yaw: Math.PI },
    { name: 'market', x: 120, z: 100, yaw: 0 },
    { name: 'cyberdome', x: -130, z: 80, yaw: 0 },
    { name: 'residential', x: -120, z: -95, yaw: Math.PI },
    { name: 'transit', x: 125, z: -100, yaw: Math.PI },
    { name: 'street', x: 12, z: 60, yaw: Math.PI / 2 },
    { name: 'garage', x: 30, z: 150, yaw: 0 },
  ],
  oldfront: [
    { name: 'cathedral', x: 20, z: -20, yaw: Math.PI },
    { name: 'oldtown', x: 106, z: 44, yaw: Math.PI },
    { name: 'keep', x: -140, z: -140, yaw: Math.PI / 4 },
    { name: 'farmstead', x: 148, z: 168, yaw: Math.PI },
    { name: 'checkpoint', x: -166, z: 66, yaw: 2.2 },
    { name: 'forestcamp', x: 90, z: 190, yaw: 0 },
    { name: 'bridge', x: 0, z: 108, yaw: 0 },
  ],
  eden: [
    { name: 'research', x: -92, z: -8, yaw: Math.PI },
    { name: 'dorms', x: -106, z: 96, yaw: 0 },
    { name: 'dock', x: 116, z: 52, yaw: Math.PI / 2 },
    { name: 'greenhouse', x: 12, z: 46, yaw: Math.PI },
    { name: 'treatment', x: -164, z: -102, yaw: Math.PI / 4 },
    { name: 'meadow', x: 224, z: 110, yaw: 0 },
    { name: 'lake', x: 70, z: 60, yaw: -Math.PI / 3 },
  ],
};

async function main(): Promise<void> {
  const map = process.argv[2] ?? 'neocity';
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'low', shadows: false, shadowQuality: 'low',
      postProcessing: false, bloom: false, aa: 'off', resolutionScale: 0.7,
    }));
  });
  await page.goto(`http://localhost:5199/?qa=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  if (map !== 'neocity') await page.click(`#map-list .map-card:nth-child(${['neocity','oldfront','eden'].indexOf(map)+1})`);
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 60000 });
  // skip through transport quickly
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500);
    const st = await Promise.race([
      page.evaluate('window.__xoState ? window.__xoState.player : null') as Promise<null | { grounded?: boolean }>,
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    if (st?.grounded) break;
  }
  const pois = POIS[map] ?? [];
  for (const poi of pois) {
    await page.evaluate((p) => {
      const tp = (window as unknown as { __xoTeleport?: (x: number, z: number, yaw: number) => void }).__xoTeleport;
      if (tp) tp(p.x, p.z, p.yaw);
    }, poi);
    await page.waitForTimeout(2600);
    await page.screenshot({ path: `qa/poi-${map}-${poi.name}.png`, timeout: 60000 });
    console.log('shot:', poi.name);
  }
  console.log('errors:', errors.length);
  for (const e of errors.slice(0, 8)) console.log(' •', e.slice(0, 180));
  await browser.close();
  await server.close();
}
void main().catch((e) => { console.error(e); process.exit(1); });
