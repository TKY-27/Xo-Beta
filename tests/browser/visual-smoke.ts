/**
 * Visual smoke check for the AAA pass: lobby text, stats screen, match HUD,
 * inspect flourish and weather presence. Writes PNGs to /tmp/xo-visual/.
 * Run: npx tsx tests/browser/visual-smoke.ts
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';

const OUT = '/tmp/xo-visual';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      onboarded: true, quality: 'ultra', shadows: true, shadowQuality: 'high',
      postProcessing: true, bloom: true, aa: 'smaa', resolutionScale: 1,
      lang: 'ja',
    }));
  });
  await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/01-main-menu.png` });

  // Play menu: verify the start button text is the plain マッチ開始.
  await page.click('#btn-play');
  await page.waitForTimeout(400);
  await page.click('#map-list .map-card:nth-child(1)');
  await page.waitForTimeout(300);
  const startText = await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).textContent?.trim());
  console.log('start button text:', JSON.stringify(startText));
  await page.screenshot({ path: `${OUT}/02-play-menu.png` });

  // Career stats screen.
  await page.click('#btn-play-back');
  await page.waitForTimeout(300);
  await page.click('#btn-stats');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/03-stats-empty.png` });
  await page.evaluate(() => (document.getElementById('btn-stats-back') as HTMLButtonElement).click());
  await page.waitForTimeout(200);

  // Start a match (seed makes weather deterministic per run). qa=1 unlocks
  // the __xoGive/__xoTeleport hooks used below.
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(400);
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click('#map-list .map-card:nth-child(1)');
  await page.waitForTimeout(200);
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
  // Skip the drop: force-deploy via jump spam until grounded (qa-perf pattern).
  const evalSoft = async <T>(expr: string, ms = 5000): Promise<T | null> =>
    Promise.race([page.evaluate(expr) as Promise<T>, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  for (let i = 0; i < 120; i++) {
    const ph = await evalSoft<string>('window.__xoState ? window.__xoState.phase : "?"');
    if (ph === 'live') break;
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < 60; i++) {
    const pl = await evalSoft<string>('window.__xoState ? JSON.stringify(window.__xoState.player) : "none"', 2500);
    if (pl && pl.includes('"grounded":true')) break;
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/04-match-landing.png` });

  // Give a weapon and look at it, then trigger inspect and capture mid-sweep.
  await page.evaluate(() => {
    const give = (window as unknown as { __xoGive?: (id: string, rarity: string) => unknown }).__xoGive;
    give?.('ar', 'epic');
  });
  await page.waitForTimeout(600);
  const vmDump = await evalSoft<string>(`(() => {
    const s = window.__xoState;
    if (!s || !s.viewmodel) return 'no-state';
    const vm = s.viewmodel;
    return JSON.stringify({
      pos: vm.position.toArray().map((n) => +n.toFixed(2)),
      visible: vm.visible,
      parent: vm.parent ? (vm.parent.name || vm.parent.type) : 'none',
      camPos: s.camera ? s.camera.position.toArray().map((n) => +n.toFixed(2)) : null,
      camChildren: s.camera ? s.camera.children.length : -1,
    });
  })()`, 3000);
  console.log('vm dump:', vmDump);
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/05-inspect-mid.png` });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/05b-hip.png` });

  // Teleport next to a Spire Plaza floor-loot spawn and look down at the
  // cartridge clusters.
  await page.evaluate(() => {
    (window as unknown as Record<string, (x: number, z: number, yaw?: number, refY?: number, pitch?: number) => boolean>)
      .__xoTeleport?.(2, -36, 0, 0.6, -0.7);
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/06-ground-loot.png` });

  // Combat stress: bring bots into the area via the QA stress hook.
  await page.evaluate(() => {
    const w = window as unknown as { __xoStress?: (spec: string) => unknown };
    w.__xoStress?.('count=2');
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/07-combat.png` });

  const perf = await evalSoft<string>(
    'window.__xoState ? JSON.stringify(window.__xoState.perf && { worst: window.__xoState.perf.worstFrameMs, spikes33: window.__xoState.perf.spikes33, fps: window.__xoState.perf.avgFps }) : "none"',
    4000,
  );
  console.log('perf snapshot:', perf);
  await page.screenshot({ path: `${OUT}/07-final.png` });

  console.log('page errors:', errors.length, errors.slice(0, 5));
  await browser.close();
  await server.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
