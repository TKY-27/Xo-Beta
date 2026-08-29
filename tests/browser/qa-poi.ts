/** POI screenshot tour for one map (uses ?qa=1 teleport hook). */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const POIS: Record<string, Array<{ name: string; x: number; z: number; yaw: number; mode?: 'standing' | 'swim' }>> = {
  neocity: [
    { name: 'spire', x: 0, z: 30, yaw: Math.PI },
    { name: 'market', x: 120, z: 80, yaw: Math.PI },
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
    { name: 'lake-swim', x: 70, z: 60, yaw: -Math.PI / 3, mode: 'swim' },
  ],
  ashara: [
    { name: 'market', x: -34, z: -70, yaw: Math.PI },
    { name: 'relay', x: 205, z: -110, yaw: Math.PI / 4 },
    { name: 'works', x: 108, z: 32, yaw: -Math.PI / 2 },
    { name: 'wadi', x: 0, z: 44, yaw: Math.PI },
    { name: 'compound', x: -205, z: 86, yaw: -Math.PI / 2 },
    { name: 'fuel-court', x: 184, z: 112, yaw: Math.PI },
    { name: 'caravanserai', x: 58, z: -202, yaw: 0 },
  ],
};

async function main(): Promise<void> {
  const requestedMap = process.argv[2];
  const maps = requestedMap ? [requestedMap] : Object.keys(POIS);
  for (const map of maps) {
    if (!POIS[map]) throw new Error(`Unknown or unconfigured map: ${map}`);
  }
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const headless = process.env.HEADLESS === '1';
  if (headless) console.warn('HEADLESS=1 is diagnostic only; it is not POI visual acceptance evidence.');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: ['--enable-unsafe-swiftshader'],
  });
  const allErrors: string[] = [];
  try {
    for (const map of maps) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.addInitScript((diagnosticHeadless) => {
        localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
          quality: diagnosticHeadless ? 'low' : 'ultra',
          shadows: !diagnosticHeadless,
          shadowQuality: diagnosticHeadless ? 'low' : 'high',
          postProcessing: !diagnosticHeadless,
          bloom: !diagnosticHeadless,
          aa: diagnosticHeadless ? 'off' : 'smaa',
          resolutionScale: diagnosticHeadless ? 0.7 : 1,
        }));
      }, headless);
      await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(9000);
      await page.click('#btn-play');
      await page.waitForTimeout(300);
      const mapIndex = Object.keys(POIS).indexOf(map) + 1;
      await page.click(`#map-list .map-card:nth-child(${mapIndex})`);
      await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
      await page.waitForSelector('#hud:not(.hidden)', { timeout: 60000 });

      let landed = false;
      for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(1200);
        const st = await Promise.race([
          page.evaluate('window.__xoState ? { grounded: window.__xoState.player && window.__xoState.player.grounded, phase: window.__xoState.phase } : null') as Promise<null | { grounded?: boolean; phase?: string }>,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        if (st?.phase === 'live' && st.grounded) {
          landed = true;
          break;
        }
        await page.evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })); window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }))');
      }
      if (!landed) throw new Error(`POI QA never reached live grounded state: ${map}`);
      await page.waitForTimeout(2500);

      for (const poi of POIS[map]!) {
        const teleported = await page.evaluate((p) => {
          const tp = (window as unknown as {
            __xoTeleport?: (
              x: number, z: number, yaw: number, refY?: number, pitch?: number,
              mode?: 'standing' | 'swim',
            ) => boolean;
          }).__xoTeleport;
          return tp?.(p.x, p.z, p.yaw, undefined, -0.12, p.mode ?? 'standing') ?? false;
        }, poi);
        if (!teleported) throw new Error(`QA teleport rejected for ${map}/${poi.name}`);
        await page.waitForTimeout(700);
        const resolvedPosition = await page.evaluate(
          () => document.documentElement.dataset.xoQaPosition ?? 'missing',
        );
        const resolved = resolvedPosition.split(',').map(Number);
        if (resolved.length !== 3 || resolved.some((value) => !Number.isFinite(value))
          || Math.hypot(resolved[0]! - poi.x, resolved[2]! - poi.z) > 2.3) {
          throw new Error(
            `QA teleport resolved too far from ${map}/${poi.name}: requested=${poi.x},${poi.z} resolved=${resolvedPosition}`,
          );
        }
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
        await page.waitForTimeout(520);
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' })));
        await page.waitForTimeout(180);
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD' })));
        await page.waitForTimeout(1200);
        const state = await page.evaluate(() => ({
          map: document.documentElement.dataset.xoQaMap ?? 'missing',
          collision: document.documentElement.dataset.xoQaCollision ?? 'missing',
          world: document.documentElement.dataset.xoQaWorld ?? 'missing',
          movement: document.documentElement.dataset.xoQaMovement ?? 'missing',
          position: document.documentElement.dataset.xoQaPosition ?? 'missing',
          water: document.documentElement.dataset.xoQaWater ?? 'missing',
          runtime: document.documentElement.dataset.xoQaRuntime ?? 'missing',
        }));
        if (state.map !== map) throw new Error(`Wrong QA map for ${map}/${poi.name}: ${state.map}`);
        if (!state.collision.startsWith('count=0|depth=0.0000|')) {
          throw new Error(`Unsafe POI placement ${map}/${poi.name}: ${state.collision}`);
        }
        if (poi.mode === 'swim') {
          if (!state.movement.startsWith('swim|') || !state.water.startsWith('in=1|')) {
            throw new Error(`Invalid swim POI ${map}/${poi.name}: ${state.movement} ${state.water}`);
          }
        } else if (!state.collision.includes('|grounded=1') || state.movement.startsWith('air|')) {
          throw new Error(
            `Unstable POI approach ${map}/${poi.name}: ${state.position} ${state.movement} ${state.collision}`,
          );
        }
        const forwardClearance = /(?:^|\|)view=([\d.]+)/.exec(state.world)?.[1];
        if (state.world === 'missing'
          || !/(?:^|\|)side=(?:on|above)(?:\||$)/.test(state.world)
          || (forwardClearance !== undefined && Number(forwardClearance) < 1.25)) {
          throw new Error(
            `Rejected POI composition ${map}/${poi.name}: ${state.position} ${state.world}`,
          );
        }
        if (state.runtime !== 'count=0') {
          throw new Error(`Runtime issue at ${map}/${poi.name}: ${state.runtime}`);
        }
        await page.screenshot({ path: `qa/poi-${map}-${poi.name}.png`, timeout: 60000 });
        console.log('shot:', `${map}/${poi.name}`, state.position, state.movement, state.collision);
      }
      if (errors.length > 0) allErrors.push(...errors.map((error) => `${map}: ${error}`));
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (allErrors.length > 0) {
    throw new Error(`POI browser errors:\n${allErrors.slice(0, 8).join('\n')}`);
  }
}
void main().catch((e) => { console.error(e); process.exit(1); });
