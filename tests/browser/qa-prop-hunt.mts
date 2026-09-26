/**
 * Per-pixel prop provenance: fill the frame with a solid colour, render one
 * frame, and report the object/material that owns each non-blank pixel.
 *
 * The first-person and UI overlays stay in the way for a screen-centre pick, so
 * this bypasses picking entirely. Any frame region covered by a named prop is
 * reported, which is what the visual panel needs in order to name the offending
 * primitive instead of guessing at its coordinates.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const VITE_PORT = 5222;

type Poi = { card: number; name: string; poi: Record<string, unknown> };

const POIS: Poi[] = [
  { card: 4, name: 'ashara-fuel-court', poi: { x: 184, z: 112, yaw: Math.PI, pitch: -0.05, mode: 'standing' } },
  { card: 4, name: 'ashara-market-east', poi: { x: -12, z: -30, yaw: Math.PI / 2, pitch: -0.05, mode: 'standing' } },
  { card: 4, name: 'ashara-wadi', poi: { x: 0, z: 44, yaw: Math.PI, pitch: -0.05, mode: 'standing' } },
  { card: 4, name: 'ashara-market-south', poi: { x: -34, z: -44, yaw: Math.PI, pitch: -0.05, mode: 'standing' } },
  { card: 1, name: 'neocity-residential', poi: { x: -120, z: -95, yaw: Math.PI, pitch: -0.05, mode: 'standing' } },
  { card: 1, name: 'neocity-transit', poi: { x: 125, z: -100, yaw: Math.PI, pitch: -0.05, mode: 'standing' } },
  { card: 1, name: 'neocity-spire', poi: { x: 0, z: 30, yaw: Math.PI, pitch: -0.05, mode: 'standing' } },
  { card: 1, name: 'neocity-cyberdome', poi: { x: -130, z: 80, yaw: 0, pitch: -0.05, mode: 'standing' } },
  { card: 2, name: 'oldfront-farmstead', poi: { x: 148, z: 168, yaw: Math.PI, pitch: -0.05, mode: 'standing' } },
  { card: 2, name: 'oldfront-cathedral', poi: { x: 20, z: -20, yaw: Math.PI, pitch: -0.05, mode: 'standing' } },
];

async function main() {
const server = await createServer({ server: { port: VITE_PORT }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => {
  localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
    quality: 'ultra', shadows: true, shadowQuality: 'high',
    postProcessing: true, bloom: true, aa: 'smaa', resolutionScale: 1,
  }));
});

for (const entry of POIS) {
  await page.goto(`http://localhost:${VITE_PORT}/?qa=1&roster=2v2`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 30; i++) {
    const onboarding = await page.$('#onboarding-screen:not(.hidden)');
    if (onboarding) {
      await page.click('#btn-onb-en');
      await page.waitForTimeout(200);
      await page.click('#btn-onb-fp');
      await page.waitForTimeout(300);
      break;
    }
    if (await page.$('#main-menu:not(.hidden)')) break;
    await page.waitForTimeout(500);
  }
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click(`#map-list .map-card:nth-child(${entry.card})`);
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 60000 });
  await page.waitForTimeout(6000);
  await page.keyboard.press('Space');
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({
      phase: document.documentElement.dataset.xoQaPhase ?? '',
      collision: document.documentElement.dataset.xoQaCollision ?? '',
    }));
    if (st.phase === 'live' && /\|grounded=1(?:\||$)/.test(st.collision)) break;
  }
  await page.waitForTimeout(2500);
  const id = Date.now().toString(36);
  await page.evaluate(({ id, poi }) => {
    const el = document.querySelector('#xo-qa-teleport-command') as HTMLInputElement | null;
    if (!el) throw new Error('teleport input missing');
    el.value = JSON.stringify({ nonce: `qa-${id}`, ...poi });
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id, poi: entry.poi });
  await page.waitForTimeout(1600);
  await page.evaluate(() => {
    const hud = document.getElementById('hud');
    if (hud) hud.style.visibility = 'hidden';
  });
  const owner = await page.evaluate((): unknown => {
    const w = window as unknown as { __xoPropQa?: (c: number, r: number) => unknown };
    return w.__xoPropQa ? w.__xoPropQa(96, 54) : 'missing __xoPropQa';
  });
  await page.screenshot({ path: `qa/propshot-${entry.name}.png` });
  console.log(`PROPS ${entry.name} ${JSON.stringify(owner)}`);
}

console.log(`ERRORS ${errors.length} ${JSON.stringify(errors.slice(0, 4))}`);
await browser.close();
await server.close();
}

void main();
