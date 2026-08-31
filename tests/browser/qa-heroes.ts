/**
 * Captures map hero images for the play-menu browser (one per map).
 * Teleports to a curated scenic vantage and screenshots at 1600x900.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const SPOTS: Record<string, Array<[number, number, number]>> = {
  // [x, z, yaw] — first entry is the hero card capture
  neocity: [[120, 120, Math.PI * 0.62], [0, 0, 0], [-40, 90, Math.PI * 0.78]],
  oldfront: [[110, 30, 1.2], [20, -30, Math.PI * 0.9], [-150, -150, 0.4]],
  eden: [[-90, -20, Math.PI * 0.85], [120, 40, 2.2], [10, -195, 0.8]],
  ashara: [[0, 44, 0], [-82, -74, -Math.PI / 2], [132, -174, 2.2]],
};

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const headless = process.env.HEADLESS === '1';
  if (headless) console.warn('HEADLESS=1 is diagnostic only; it is not hero acceptance evidence.');
  const browser = await chromium.launch({ channel: 'chrome', headless });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 160));
  });
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'ultra', shadows: true, shadowQuality: 'high',
      postProcessing: true, bloom: true, aa: 'smaa', resolutionScale: 1,
    }));
  });
  await page.goto('http://localhost:5199/?qa=1&hero=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(600);

  const args = process.argv.slice(2);
  const updatePublic = args.includes('--update-public');
  const requestedMaps = args.filter((arg) => arg !== '--update-public');
  const maps = requestedMaps.length > 0 ? requestedMaps : ['neocity', 'oldfront', 'eden', 'ashara'];
  for (const map of maps) {
    if (!SPOTS[map]) throw new Error(`Unknown map: ${map}`);
    if (map !== 'neocity') {
      await page.goto('http://localhost:5199/?qa=1&hero=1', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
      await page.waitForTimeout(600);
    }
    await page.click('#btn-play');
    await page.waitForTimeout(300);
    const idx = ['neocity', 'oldfront', 'eden', 'ashara'].indexOf(map) + 1;
    await page.click(`#map-list .map-card:nth-child(${idx})`);
    await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
    const evalSoft = async <T>(expr: string, ms = 5000): Promise<T | null> =>
      Promise.race([page.evaluate(expr) as Promise<T>, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    let live = false;
    for (let i = 0; i < 120; i++) {
      const ph = await evalSoft<string>('window.__xoState ? window.__xoState.phase : "?"');
      if (ph === 'live') { live = true; break; }
      await page.keyboard.press('Space');
      await page.waitForTimeout(600);
    }
    if (!live) throw new Error(`Hero QA never reached live phase: ${map}`);
    // wait for landing
    let grounded = false;
    for (let i = 0; i < 60; i++) {
      const pl = await evalSoft<string>('window.__xoState ? JSON.stringify(window.__xoState.player) : "none"', 2500);
      if (pl && pl.includes('"grounded":true')) { grounded = true; break; }
      await page.waitForTimeout(400);
    }
    if (!grounded) throw new Error(`Hero QA never reached grounded state: ${map}`);
    // `?hero=1` is a DEV-only capture mode that hides gameplay UI and the FP
    // viewmodel without mutating production assets or read-only DOM state.
    await page.waitForTimeout(400);
    let shot = 0;
    for (const [x, z, yaw] of SPOTS[map]!) {
      const teleported = await Promise.race([
        page.evaluate((a: number[]) => {
          const teleport = (window as unknown as {
            __xoTeleport?: (x: number, z: number, yw: number) => boolean;
          }).__xoTeleport;
          return teleport?.(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) === true;
        }, [x, z, yaw]),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 4000)),
      ]);
      if (!teleported) throw new Error(`Hero teleport rejected: ${map} #${shot} (${x}, ${z})`);
      await page.waitForTimeout(1600);
      const resolvedPosition = await page.evaluate(
        () => document.documentElement.dataset.xoQaPosition ?? 'missing',
      );
      const resolved = resolvedPosition.split(',').map(Number);
      if (resolved.length !== 3 || resolved.some((value) => !Number.isFinite(value))
        || Math.hypot(resolved[0]! - x, resolved[2]! - z) > 2.3) {
        throw new Error(
          `Hero teleport resolved too far: ${map} #${shot}: requested=${x},${z} resolved=${resolvedPosition}`,
        );
      }
      const qaState = await page.evaluate(() => ({
        map: document.documentElement.dataset.xoQaMap ?? 'missing',
        collision: document.documentElement.dataset.xoQaCollision ?? 'missing',
        world: document.documentElement.dataset.xoQaWorld ?? 'missing',
        runtime: document.documentElement.dataset.xoQaRuntime ?? 'missing',
      }));
      if (qaState.map !== map) throw new Error(`Wrong hero map: expected ${map}, received ${qaState.map}`);
      if (!qaState.collision.includes('count=0|depth=0.0000')
        || !qaState.collision.includes('grounded=1')) {
        throw new Error(`Unsafe hero placement: ${map} #${shot}: ${qaState.collision}`);
      }
      const forwardClearance = /(?:^|\|)view=([\d.]+)/.exec(qaState.world)?.[1];
      if (qaState.world === 'missing'
        || !/(?:^|\|)side=(?:on|above)(?:\||$)/.test(qaState.world)
        || (forwardClearance !== undefined && Number(forwardClearance) < 1.25)) {
        throw new Error(`Rejected hero composition: ${map} #${shot}: ${qaState.world}`);
      }
      if (qaState.runtime !== 'count=0') {
        throw new Error(`Runtime issue before hero capture: ${map} #${shot}: ${qaState.runtime}`);
      }
      if (errors.length > 0) {
        throw new Error(`Browser error before hero capture: ${map} #${shot}: ${errors.join(' | ')}`);
      }
      await page.screenshot({ path: `qa/hero-${map}-${shot}.png`, timeout: 60000 });
      // QA captures are disposable evidence. Replacing shipped menu art is an
      // explicit promotion step so a routine visual probe cannot silently
      // overwrite reviewed production assets.
      if (shot === 0 && updatePublic) {
        await page.screenshot({ path: `public/assets/maps/${map}.jpg`, type: 'jpeg', quality: 84, timeout: 60000 });
      }
      console.log(`captured ${map} #${shot}`);
      shot++;
    }
  }
  console.log('errors:', errors.length);
  if (errors.length > 0) throw new Error(`Hero browser errors: ${errors.join(' | ')}`);
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
