/**
 * Headed Chrome all-map QA: runs each map, jumps, lands, moves, captures
 * screenshots, and checks collision plus console state. HEADLESS=1 is a
 * diagnostic override, never visual acceptance evidence.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';

const MAPS = ['neocity', 'oldfront', 'eden', 'ashara'] as const;

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const headless = process.env.HEADLESS === '1';
  if (headless) console.warn('HEADLESS=1 is diagnostic only; it is not visual QA evidence.');
  const browser = await chromium.launch({ channel: 'chrome', headless });

  const allErrors: string[] = [];

  for (let i = 0; i < MAPS.length; i++) {
    const mapId = MAPS[i]!;
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript((diagnosticHeadless) => {
      localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
        quality: diagnosticHeadless ? 'low' : 'ultra',
        shadows: !diagnosticHeadless,
        shadowQuality: diagnosticHeadless ? 'low' : 'high',
        postProcessing: !diagnosticHeadless,
        bloom: !diagnosticHeadless,
        aa: diagnosticHeadless ? 'off' : 'smaa',
        resolutionScale: diagnosticHeadless ? 0.6 : 1,
      }));
    }, headless);
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

    console.log(`\n=== ${mapId.toUpperCase()} ===`);
    await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'networkidle' });
    // Fresh profiles land on the first-run onboarding overlay and the main
    // menu stays hidden behind it, so poll for whichever appears first and
    // clear onboarding before waiting for the menu.
    for (let i = 0; i < 30; i++) {
      const onboarding = await page.$('#onboarding-screen:not(.hidden)');
      if (onboarding) {
        await page.click('#btn-onb-en');
        await page.waitForTimeout(200);
        await page.click('#btn-onb-fp');
        await page.waitForTimeout(300);
        break;
      }
      const menu = await page.$('#main-menu:not(.hidden)');
      if (menu) break;
      await page.waitForTimeout(500);
    }
    await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
    await page.waitForTimeout(300);

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
      allErrors.push(`${mapId}: HUD did not appear`);
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
    if (!landed) errors.push('LANDING: timed out before grounded state');

    // Exercise real controller movement after landing, then assert that the
    // final rendered actor capsule is clear and contact state is coherent.
    const beforeMove = await page.evaluate(() => document.documentElement.dataset.xoQaPosition ?? 'missing');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(900);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(500);
    const afterMove = await page.evaluate(() => document.documentElement.dataset.xoQaPosition ?? 'missing');
    const parsePosition = (value: string): [number, number, number] | null => {
      const parts = value.split(',').map(Number);
      return parts.length === 3 && parts.every(Number.isFinite)
        ? [parts[0]!, parts[1]!, parts[2]!]
        : null;
    };
    const from = parsePosition(beforeMove);
    const to = parsePosition(afterMove);
    if (!from || !to || Math.hypot(to[0] - from[0], to[2] - from[2]) < 0.25) {
      errors.push(`MOVEMENT: ${beforeMove} -> ${afterMove}`);
    }
    const qaMap = await page.evaluate(() => document.documentElement.dataset.xoQaMap ?? 'missing');
    if (qaMap !== mapId) errors.push(`MAP: expected ${mapId}, received ${qaMap}`);
    const collision = await page.evaluate(() => document.documentElement.dataset.xoQaCollision ?? 'missing');
    if (!collision.includes('count=0|depth=0.0000') || !collision.includes('grounded=1')) {
      errors.push(`COLLISION: ${collision}`);
    }
    const world = await page.evaluate(() => document.documentElement.dataset.xoQaWorld ?? 'missing');
    const forwardClearance = /(?:^|\|)view=([\d.]+)/.exec(world)?.[1];
    if (world === 'missing'
      || !/(?:^|\|)side=(?:on|above)(?:\||$)/.test(world)
      || (forwardClearance !== undefined && Number(forwardClearance) < 1.25)) {
      errors.push(`COMPOSITION: ${world}`);
    }
    const runtime = await page.evaluate(() => document.documentElement.dataset.xoQaRuntime ?? 'missing');
    if (runtime !== 'count=0') errors.push(`RUNTIME: ${runtime}`);
    const qaPhase = await page.evaluate(() => document.documentElement.dataset.xoQaPhase ?? 'missing');
    if (qaPhase !== 'live') errors.push(`PHASE: ${qaPhase}`);
    console.log('collision:', collision);
    console.log('world:', world);
    console.log('runtime:', runtime);

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
    if (!state.alive?.trim() || !state.phase?.trim()) errors.push(`HUD STATE: ${JSON.stringify(state)}`);
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
