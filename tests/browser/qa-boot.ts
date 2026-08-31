/** Boot smoke test: enter match, drop, land, inspect world. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') errors.push(`[${t}] ${m.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on('crash', () => errors.push('PAGE CRASHED'));
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      onboarded: true,
      quality: 'low', shadows: false, shadowQuality: 'low',
      postProcessing: false, bloom: false, aa: 'off', resolutionScale: 0.6,
    }));
  });
  const map = process.argv[2] ?? 'neocity';
  const t0 = Date.now();
  const log = (s: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
  log('page loaded');
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(1200);
  log('assets settled');
  await page.click('#btn-play');
  await page.waitForTimeout(400);
  await page.click(`#map-list .map-card:nth-child(${['neocity','oldfront','eden','ashara'].indexOf(map)+1})`);
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  try {
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 60000 });
    log('HUD OK');
  } catch { log('HUD FAILED'); }
  await page.waitForTimeout(3000);
  await page.keyboard.press('Space');
  log('jumped');
  let landed = false;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(2000);
    try {
      const st = await Promise.race([
        page.evaluate('window.__xoState ? window.__xoState.player : null') as Promise<{ grounded?: boolean; state?: string } | null>,
        new Promise<null>((r) => setTimeout(() => r(null), 4000)),
      ]);
      if (st === null) { log(`poll ${i}: evaluate TIMEOUT`); continue; }
      log(`poll ${i}: ${JSON.stringify(st)}`);
      if (st?.grounded && st.state !== 'freefall' && st.state !== 'glide') { landed = true; break; }
    } catch (e) { log(`poll ${i} error: ${e}`); break; }
  }
  log(landed ? 'landed ✓' : 'land ✗ (timeout)');
  await page.mouse.move(640, 360); await page.mouse.move(640, 520, { steps: 4 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `qa/boot-${map}-ground.png`, timeout: 60000 });
  log('ground shot saved');
  await page.mouse.move(900, 260, { steps: 4 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `qa/boot-${map}-look.png`, timeout: 60000 });
  log('look shot saved');
  const state = await page.evaluate('window.__xoState ? { drawCalls: window.__xoState.sceneInfo.drawCalls, tris: window.__xoState.sceneInfo.triangles } : null');
  log('perf: ' + JSON.stringify(state));
  console.log('errors:', errors.length);
  for (const e of errors.slice(0, 14)) console.log(' •', e.slice(0, 220));
  await browser.close();
  await server.close();
}
void main().catch((e) => { console.error(e); process.exit(1); });
