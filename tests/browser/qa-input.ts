/**
 * Input-direction QA: verifies W/S/A/D displacement matches the camera
 * convention (W = camera-forward, S = back, D = screen-right), plus a
 * TPS screenshot of a moving bot for facing verification.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const t0 = Date.now();
  const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'low', shadows: false, shadowQuality: 'low',
      postProcessing: false, bloom: false, aa: 'off', resolutionScale: 0.7,
    }));
  });
  const map = process.argv[2] ?? 'neocity';
  // Flat, open test spots per map (wide POI areas)
  const spot = { neocity: [20, 20], oldfront: [150, 170], eden: [225, 100], ashara: [0, 44] }[map] ?? [20, 20];
  const sx: number = spot[0] ?? 20;
  const sz: number = spot[1] ?? 20;
  log('goto…');
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  log('loaded');
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 }); log('menu ready');
  await page.waitForTimeout(800);
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click(`#map-list .map-card:nth-child(${['neocity','oldfront','eden','ashara'].indexOf(map)+1})`);
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 }); log('hud up');

  // Wait until landed & live (press jump to leave the transport).
  // NOTE: first-map-load shader compilation can block the main thread for
  // minutes under SwiftShader, so evaluates are soft-timed.
  const evalSoft = async <T>(expr: string, ms = 4000): Promise<T | null> => {
    return Promise.race([
      page.evaluate(expr) as Promise<T>,
      new Promise<null>((r) => setTimeout(() => r(null), ms)),
    ]);
  };

  let phase = '';
  let lastSeen = '';
  for (let i = 0; i < 200; i++) {
    const raw = await evalSoft<string>(
      'window.__xoState ? JSON.stringify({ p: window.__xoState.phase, py: window.__xoState.player ? Math.round(window.__xoState.player.y) : -1 }) : "none"', 2500,
    );
    let ph = '';
    let py = -1;
    if (raw) {
      try { const o = JSON.parse(raw) as { p: string; py: number }; ph = o.p; py = o.py; } catch { /* ignore */ }
    }
    phase = ph;
    if ((i % 8 === 0 || (ph && ph !== lastSeen))) log(`poll ${i}: phase=${ph || '(timeout)'} playerY=${py}`);
    if (ph) lastSeen = ph;
    if (phase === 'live') break;
    await Promise.race([
      page.keyboard.press('Space'),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    await page.waitForTimeout(700);
  }
  log('phase:', phase);

  // Wait for the player to actually touch down (glide can persist into 'live')
  for (let i = 0; i < 90; i++) {
    const raw = await evalSoft<string>('window.__xoState ? JSON.stringify(window.__xoState.player) : "none"', 2500);
    if (raw && raw.includes('"grounded":true')) break;
    await page.waitForTimeout(400);
  }
  log('player grounded');

  // Watchdog: never hang forever (starts once we're live)
  const watchdog = setTimeout(() => { console.error('WATCHDOG TIMEOUT'); process.exit(3); }, 300000);

  const getPos = async () => (await evalSoft<{ x: number; z: number }>('({x: window.__xoState.player.x, z: window.__xoState.player.z})', 4000)) ?? { x: NaN, z: NaN };

  async function settle(): Promise<void> {
    for (let i = 0; i < 24; i++) {
      const a = await getPos();
      await page.waitForTimeout(250);
      const b = await getPos();
      if (Math.abs(a.x - b.x) < 0.05 && Math.abs(a.z - b.z) < 0.05) return;
    }
  }

  async function moveTest(key: string, ms: number, yaw = 0): Promise<{ dx: number; dz: number }> {
    const args: [number, number, number] = [sx, sz, yaw];
    await Promise.race([
      page.evaluate((a) => {
        const tp = (window as unknown as { __xoTeleport?: (x: number, z: number, yw: number) => void }).__xoTeleport;
        if (tp) tp(a[0], a[1], a[2]);
      }, args),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    await page.waitForTimeout(400);
    await settle();
    const p0 = await getPos();
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
    const p1 = await getPos();
    return { dx: +(p1.x - p0.x).toFixed(2), dz: +(p1.z - p0.z).toFixed(2) };
  }

  let failures = 0;
  const check = (label: string, ok: boolean, d: { dx: number; dz: number }) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: Δ=(${d.dx}, ${d.dz})`);
    if (!ok) failures++;
  };

  // yaw=0 faces -Z. W forward → z decreases.
  const w = await moveTest('KeyW', 1100, 0);
  check('W forward (yaw 0)', w.dz < -1, w);
  const s = await moveTest('KeyS', 1100, 0);
  check('S backward (yaw 0)', s.dz > 1, s);
  const d = await moveTest('KeyD', 1100, 0);
  check('D right (yaw 0)', d.dx > 1, d);
  const a = await moveTest('KeyA', 1100, 0);
  check('A left (yaw 0)', a.dx < -1, a);
  // yaw=+π/2 → camera forward = (-1, 0). W must decrease x.
  const w90 = await moveTest('KeyW', 1100, Math.PI / 2);
  check('W forward (yaw π/2 → -X)', w90.dx < -1, w90);
  // yaw=-π/4 → forward=(sin(π/4)? no: (-sin(-π/4), -cos(-π/4)) = (0.707, -0.707): x+, z-
  const wDiag = await moveTest('KeyW', 1100, -Math.PI / 4);
  check('W forward (yaw -π/4 → +X,-Z)', wDiag.dx > 1 && wDiag.dz < -1, wDiag);

  // TPS facing screenshot while walking forward
  const targs: [number, number, number] = [sx, sz, Math.PI * 0.75];
  await Promise.race([
    page.evaluate((a) => {
      const tp = (window as unknown as { __xoTeleport?: (x: number, z: number, yw: number) => void }).__xoTeleport;
      if (tp) tp(a[0], a[1], a[2]);
    }, targs),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(500);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `qa/input-${map}-tps.png`, timeout: 60000 });
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyV');

  console.log('errors:', errors.length);
  for (const e of errors.slice(0, 6)) console.log(' •', e);
  clearTimeout(watchdog);
  await browser.close();
  await server.close();
  if (failures > 0 || errors.length > 0) process.exitCode = 2;
  else console.log(`\nINPUT QA PASS (${map})`);
}

void main().catch((e) => { console.error(e); process.exit(1); });
