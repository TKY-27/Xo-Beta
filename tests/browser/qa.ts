/**
 * Browser QA harness: boots the built game in headless Chromium, drives the
 * menu flow, starts a match, captures screenshots and console errors.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  console.log('1. Loading page…');
  await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.screenshot({ timeout: 60000, path: 'qa/01-loading.png' });
  const loadingHidden = await page.evaluate(() => document.getElementById('loading-screen')?.classList.contains('hidden') ?? false);
  console.log('   loading hidden:', loadingHidden);

  console.log('2. Main menu visible?');
  const menuVisible = await page.evaluate(() => !document.getElementById('main-menu')?.classList.contains('hidden'));
  console.log('   menu visible:', menuVisible);
  if (!menuVisible) {
    // maybe mobile gate
    const mobile = await page.evaluate(() => !document.getElementById('mobile-gate')?.classList.contains('hidden'));
    console.log('   MOBILE GATE SHOWN:', mobile);
  }
  await page.screenshot({ timeout: 60000, path: 'qa/02-menu.png' });

  console.log('3. Opening play flow + starting match…');
  await page.click('#btn-play');
  await page.waitForTimeout(400);
  await page.click('#map-list .map-card:nth-child(1)');
  await page.waitForTimeout(200);
  await page.click('#btn-play-start');
  await page.waitForTimeout(1500);
  await page.screenshot({ timeout: 60000, path: 'qa/03-loading-match.png' });

  // Wait for HUD to appear
  try {
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 30000 });
    console.log('   HUD shown ✓');
  } catch {
    console.log('   HUD DID NOT APPEAR ✗');
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ timeout: 60000, path: 'qa/04-transport.png' });

  // Jump from transport
  await page.keyboard.press('Space');
  await page.waitForTimeout(3500);
  await page.screenshot({ timeout: 60000, path: 'qa/05-freefall.png' });

  // Wait to land, look around
  await page.waitForTimeout(9000);
  await page.mouse.move(640, 360);
  await page.mouse.move(700, 380, { steps: 5 });
  await page.screenshot({ timeout: 60000, path: 'qa/06-landed.png' });

  // Toggle third person
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(800);
  await page.screenshot({ timeout: 60000, path: 'qa/07-tps.png' });
  await page.keyboard.press('KeyV');

  // Fire a shot if weapon present; move around
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await page.mouse.move(600, 340, { steps: 3 });
  await page.mouse.click(640, 360);
  await page.waitForTimeout(500);
  await page.screenshot({ timeout: 60000, path: 'qa/08-combat.png' });

  // Pause menu
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.screenshot({ timeout: 60000, path: 'qa/09-pause.png' });
  const pauseVisible = await page.evaluate(() => !document.getElementById('pause-menu')?.classList.contains('hidden'));
  console.log('   pause visible:', pauseVisible);
  if (pauseVisible) {
    await page.click('#btn-resume');
    await page.waitForTimeout(300);
  }

  const aliveText = await page.evaluate(() => document.getElementById('alive-count')?.textContent ?? '?');
  console.log('   alive count:', aliveText);

  // Run ~20s more and check for fatal errors
  await page.waitForTimeout(20000);
  await page.screenshot({ timeout: 60000, path: 'qa/10-later.png' });

  const realErrors = errors.filter((e) =>
    !e.includes('favicon') && !e.includes('WebGL: INVALID') &&
    !e.includes('THREE.WebGLRenderer: Context Lost'));
  console.log('\nConsole errors:', realErrors.length);
  for (const e of realErrors.slice(0, 12)) console.log('   •', e.slice(0, 220));

  await browser.close();
  await server.close();

  if (realErrors.length > 0) process.exitCode = 2;
  else console.log('\nQA PASS — no fatal console errors');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
