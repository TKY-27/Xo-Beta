/**
 * Fast hands/viewmodel snapshot runner (pairs with qa-hands-isolate.html):
 * renders the real ViewModel updateView path at gameplay framing for each
 * weapon class and writes qa/hands-isolate/<w><suffix>.png in seconds.
 *
 * Usage: npx tsx tests/browser/qa-hands-isolate.ts   (env: QA_WEAPONS, QA_ADS,
 * QA_ZOOM, QA_OUT suffix, HEADLESS=1)
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const weapons = (process.env.QA_WEAPONS ?? 'ar,shotgun,pistol,smg,sniper').split(',').filter(Boolean);
const ads = process.env.QA_ADS === '1' ? '1' : '0';
const zoom = process.env.QA_ZOOM ?? '0';
const suffix = process.env.QA_OUT ?? '';
const OUT = 'qa/hands-isolate';
mkdirSync(OUT, { recursive: true });

const server = await createVite();
await server.listen();

async function createVite(): Promise<import('vite').ViteDevServer> {
  const { createServer } = await import('vite');
  return createServer({ server: { port: 5198 }, logLevel: 'silent' });
}

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text().split('\n')[0]!.slice(0, 170));
});
page.on('pageerror', (err) => errors.push(String(err)));

for (const w of weapons) {
  await page.goto(`http://localhost:5198/tests/browser/qa-hands-isolate.html?w=${w}&ads=${ads}&zoom=${zoom}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${w}${suffix}.png` });
  console.log(`captured ${OUT}/${w}${suffix}.png`);
}

await browser.close();
await server.close();
if (errors.length > 0) {
  console.log(JSON.stringify({ errors }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ ok: true, count: weapons.length }));
}
