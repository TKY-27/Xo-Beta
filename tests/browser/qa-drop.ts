/** One-off: freefall pose + glide canopy screenshots (drop phase). */
import { chromium } from 'playwright';
import { createServer } from 'vite';

interface XoState {
  player?: { grounded?: boolean; state?: string };
}

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'ultra',
      shadows: true,
      shadowQuality: 'high',
      postProcessing: true,
      bloom: true,
      aa: 'smaa',
      resolutionScale: 1,
      cameraMode: 'tps',
      lang: 'en',
      onboarded: true,
    }));
  });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  // First-run onboarding may still cover the menu; clear it if present.
  const onboarding = await page.$('#onboarding-screen:not(.hidden)');
  if (onboarding) {
    await page.click('#btn-onb-en');
    await page.waitForTimeout(200);
    await page.click('#btn-onb-tp');
    await page.waitForTimeout(300);
  }
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click('#map-list .map-card:nth-child(1)');
  await page.waitForTimeout(150);
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });

  // Jump the moment the transport arms the drop (prompt up at ~6 s, same
  // lead qa-maps uses). Dispatch straight to window — Playwright's focused
  // element routing is unreliable on the janked drop thread. One press only:
  // a second jumpPressed deploys the canopy instantly.
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  });
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
  });
  // Back-to-back screenshots sweep the freefall window.
  let freefallShots = 0;
  for (let i = 0; i < 6; i++) {
    freefallShots++;
    await page.screenshot({ path: `qa/drop-freefall-${freefallShots}.png`, timeout: 60000 });
  }
  let glideShot = false;
  let landedShot = false;
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(150);
    const st = await page.evaluate('window.__xoState') as XoState | null;
    const state = st?.player?.state ?? '';
    if (state === 'glide' && !glideShot) {
      glideShot = true;
      await page.waitForTimeout(700); // let the canopy finish deploying
      await page.screenshot({ path: 'qa/drop-glide.png', timeout: 60000 });
    } else if (st?.player?.grounded && state !== 'freefall' && state !== 'glide' && !landedShot) {
      landedShot = true;
      await page.screenshot({ path: 'qa/drop-landed.png', timeout: 60000 });
      break;
    }
  }
  console.log(`freefall shots: ${freefallShots}, glide: ${glideShot}, landed: ${landedShot}`);
  if (errors.length) console.log(errors.slice(0, 5));
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
