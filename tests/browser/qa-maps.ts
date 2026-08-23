/**
 * Browser QA harness v2: runs each map, jumps, lands, captures screenshots,
 * checks console errors and basic HUD state.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';

const MAPS = ['neocity', 'oldfront', 'eden'] as const;

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });

  const allErrors: string[] = [];

  for (let i = 0; i < MAPS.length; i++) {
    const mapId = MAPS[i]!;
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    // Headless SwiftShader is extremely slow — force low settings for QA.
    await page.addInitScript(() => {
      localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
        quality: 'low', shadows: false, shadowQuality: 'low',
        postProcessing: false, bloom: false, aa: 'off', resolutionScale: 0.6,
      }));
    });
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

    console.log(`\n=== ${mapId.toUpperCase()} ===`);
    await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);

    await page.click('#btn-play');
    await page.waitForTimeout(300);
    await page.click(`#map-list .map-card:nth-child(${i + 1})`);
    await page.waitForTimeout(150);
    await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());

    try {
      await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
      console.log('HUD ✓');
    } catch {
      console.log('HUD ✗ (did not appear)');
      allErrors.push(...errors);
      await page.close();
      continue;
    }

    // Wait through transport, jump mid-way
    await page.waitForTimeout(6000);
    await page.keyboard.press('Space');
    await page.screenshot({ path: `qa/${mapId}-01-drop.png`, timeout: 60000 });

    // Poll until landed (headless sim runs slower than real time)
    let landed = false;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(2000);
      const st = await page.evaluate('window.__xoState') as { player?: { grounded?: boolean; state?: string } } | null;
      if (st?.player?.grounded && st.player.state !== 'freefall' && st.player.state !== 'glide') {
        landed = true;
        break;
      }
    }
    console.log(landed ? 'landed ✓' : 'land ✗ (timeout)');

    // Look slightly downward and capture ground level
    await page.mouse.move(640, 400);
    await page.mouse.move(640, 540, { steps: 8 });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `qa/${mapId}-02-ground.png`, timeout: 60000 });
    await page.mouse.move(900, 300, { steps: 8 });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `qa/${mapId}-03-look.png`, timeout: 60000 });

    const state = await page.evaluate(() => ({
      alive: document.getElementById('alive-count')?.textContent,
      phase: document.getElementById('storm-timer')?.textContent,
    }));
    console.log('state:', JSON.stringify(state));

    await page.close();
    allErrors.push(...errors.filter((e) => !e.includes('favicon')));
  }

  await browser.close();
  await server.close();

  console.log('\nConsole errors total:', allErrors.length);
  for (const e of allErrors.slice(0, 10)) console.log(' •', e.slice(0, 200));
  process.exitCode = allErrors.length > 0 ? 2 : 0;
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
