/**
 * Baseline capture suite for the first-person quality campaign: one headed
 * Chrome session per map, fixed seed/quality/viewport, capturing the full
 * scenario matrix (grounded look, per-weapon hip/ADS, reload mid-phase,
 * sprint, POI close-up, vegetation close-up) into qa/quality-rework/.
 *
 * Usage: npx tsx tests/browser/qa-baseline-suite.ts [neocity|oldfront|eden|ashara]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';

const mapArg = (process.argv[2] ?? 'eden').toLowerCase();
const mapIndex = ['neocity', 'oldfront', 'eden', 'ashara'].indexOf(mapArg) + 1;
if (mapIndex === 0) throw new Error(`unknown map: ${mapArg}`);
const width = Number(process.env.QA_WIDTH ?? 1280);
const height = Number(process.env.QA_HEIGHT ?? 720);
const OUT = process.env.QA_OUT ?? `qa/quality-rework/baseline-suite/${mapArg}`;
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.QA_PORT ?? 5210);
const server = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'silent',
  plugins: [{
    name: 'qa-suite-readonly',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== `${process.cwd()}/src/main.ts`) return;
      return `${code}\nwindow.__xoSuiteRead = () => {
        const p = live?.kind === 'match' ? live.match.localActor : null;
        const w = p?.wpn;
        return {
          phase: livePhase(), alive: p?.alive ?? false, grounded: p?.body?.grounded ?? false,
          weapon: p?.inv.selectedWeapon?.weaponId ?? null,
          ads: w?.adsAmount ?? null,
          reloadPhase: w && w.reloadTimer > 0 && w.reloadTotal > 0 ? 1 - w.reloadTimer / w.reloadTotal : null,
          state: p?.state ?? null,
        };
      };`;
    },
  }],
});
await server.listen();
const errors: string[] = [];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADLESS === '1',
  args: process.env.HEADLESS === '1' ? ['--use-angle=metal'] : [],
});
const context = await browser.newContext({ viewport: { width, height } });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text().split('\n')[0]!.slice(0, 170));
});
page.on('pageerror', (err) => errors.push(String(err)));

type Read = { phase: string; alive: boolean; grounded: boolean; weapon: string | null; ads: number | null; reloadPhase: number | null; state: string | null };
const read = (): Promise<Read> => page.evaluate(() => (window as unknown as { __xoSuiteRead: () => Read }).__xoSuiteRead());
const shot = async (label: string): Promise<void> => {
  const s = await read().catch(() => null);
  if (s && (!s.alive || s.phase !== 'live')) {
    throw new Error(`state broken before ${label}: ${JSON.stringify(s)}`);
  }
  await page.screenshot({ path: `${OUT}/${label}.png` });
  console.log(`captured ${label} ${s ? JSON.stringify({ w: s.weapon, ads: s.ads, rl: s.reloadPhase, st: s.state }) : ''}`);
};
const give = async (weapon: string): Promise<void> => {
  await page.evaluate(([id, rarity]) => {
    (window as unknown as { __xoGive?: (id: string, rarity?: string) => void }).__xoGive?.(id!, rarity);
  }, weapon.split(':'));
  await page.waitForTimeout(900);
};
/** Teleport and face a target point. Yaw convention: forward = (-sin yaw, 0, -cos yaw). */
const tp = async (x: number, z: number, faceX: number, faceZ: number, pitch = -0.08): Promise<void> => {
  const dx = faceX - x;
  const dz = faceZ - z;
  const yaw = Math.atan2(-dx, -dz);
  await page.evaluate((pos) => {
    const input = document.getElementById('xo-qa-teleport-command') as HTMLInputElement | null;
    if (!input) return;
    input.value = JSON.stringify({ nonce: `suite-${Date.now()}`, x: pos.x, z: pos.z, yaw: pos.yaw, pitch: pos.pitch });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { x, z, yaw, pitch });
  await page.waitForTimeout(2200);
};
const waitLiveGrounded = async (): Promise<void> => {
  await page.waitForFunction(() => {
    const s = (window as unknown as { __xoSuiteRead?: () => { phase: string; alive: boolean; grounded: boolean } }).__xoSuiteRead?.();
    return s?.phase === 'live' && s.alive && s.grounded;
  }, undefined, { timeout: 180000 });
};

// Per-map scenario targets: [label, standX, standZ, faceX, faceZ, pitch]
const targets: Record<string, Array<{ label: string; x: number; z: number; fx: number; fz: number; pitch?: number }>> = {
  neocity: [
    { label: 'poi-kiosk-row', x: 185, z: 48, fx: 185, fz: 20 },
    { label: 'poi-intersection', x: 12, z: 62, fx: 0, fz: 30 },
    { label: 'poi-parking-garage', x: 30, z: 138, fx: 30, fz: 165 },
  ],
  oldfront: [
    { label: 'poi-cathedral', x: 20, z: -22, fx: 20, fz: -55 },
    { label: 'poi-orchard-trees', x: 172, z: 60, fx: 190, fz: 60 },
    { label: 'poi-town', x: -30, z: 40, fx: 0, fz: 10 },
  ],
  eden: [
    { label: 'poi-lab-main', x: -72, z: -30, fx: -95, fz: -30 },
    { label: 'poi-forest', x: 40, z: 120, fx: 70, fz: 140 },
    { label: 'poi-lakeside', x: 40, z: 150, fx: 75, fz: 185 },
  ],
  ashara: [
    { label: 'poi-sunwall-market', x: -34, z: 4, fx: -34, fz: -30 },
    { label: 'poi-dry-canals', x: -160, z: 150, fx: -188, fz: 178 },
    { label: 'poi-compound', x: -130, z: 60, fx: -158, fz: 86 },
  ],
};

const gfxSettings: Record<string, unknown> = {
  cameraMode: 'fps', playerSkin: 'vanguard', onboarded: true,
  quality: 'ultra', postProcessing: true, bloom: true, ao: true, aa: 'smaa', resolutionScale: 1,
};
await page.addInitScript((settings) => {
  window.localStorage.setItem('xo-beta-settings-v1', JSON.stringify(settings));
}, gfxSettings);

const seed = process.env.QA_SEED ?? '42042';
await page.goto(`http://localhost:${PORT}/?qa=1&seed=${seed}`, { waitUntil: 'networkidle' });
for (let i = 0; i < 60; i++) {
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
await page.click('#btn-play', { timeout: 5000 });
await page.click(`#map-list .map-card:nth-child(${mapIndex})`, { timeout: 5000 });
await page.click('#btn-play-start', { timeout: 5000 });
await page.waitForSelector('#hud:not(.hidden)', { timeout: 150000 });
await page.waitForTimeout(3000);
// Jump from the transport and wait for the live grounded state.
await page.keyboard.press('Space');
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(1000);
  const s = await read().catch(() => null);
  if (s?.grounded && s.state !== 'freefall' && s.state !== 'glide') break;
}
await waitLiveGrounded();
await page.waitForTimeout(1200);
await shot('01-grounded');

const scenario = async (): Promise<void> => {
  // AR operation matrix at the spawn area first.
  await give('ar:common');
  await shot('10-ar-hip');
  await page.evaluate(() => {
    (window as unknown as { __xoQaInput: (o: unknown) => void }).__xoQaInput({ adsHeld: true });
  });
  await page.waitForFunction(() => {
    const s = (window as unknown as { __xoSuiteRead?: () => { ads: number | null } }).__xoSuiteRead?.();
    return (s?.ads ?? 0) > 0.9;
  }, undefined, { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await shot('11-ar-ads');
  await page.evaluate(() => {
    (window as unknown as { __xoQaInput: (o: unknown) => void }).__xoQaInput(null);
  });
  await page.waitForTimeout(600);
  // Fire burst (muzzle flash / tracers visible in frame).
  await page.evaluate(() => {
    (window as unknown as { __xoQaInput: (o: unknown) => void }).__xoQaInput({ firePressed: true, fireHeld: true });
  });
  await page.waitForTimeout(240);
  await shot('12-ar-fire');
  await page.evaluate(() => {
    (window as unknown as { __xoQaInput: (o: unknown) => void }).__xoQaInput(null);
  });
  await page.waitForTimeout(500);
  // Mid-reload frame.
  await page.keyboard.press('r');
  await page.waitForFunction(() => {
    const s = (window as unknown as { __xoSuiteRead?: () => { reloadPhase: number | null } }).__xoSuiteRead?.();
    return s?.reloadPhase !== null && (s?.reloadPhase ?? 0) > 0.3;
  }, undefined, { timeout: 5000 });
  await page.waitForFunction(() => {
    const s = (window as unknown as { __xoSuiteRead?: () => { reloadPhase: number | null } }).__xoSuiteRead?.();
    return (s?.reloadPhase ?? 0) >= 0.42;
  }, undefined, { timeout: 5000 }).catch(() => undefined);
  await shot('13-ar-reload-mid');
  await page.waitForFunction(() => {
    const s = (window as unknown as { __xoSuiteRead?: () => { reloadPhase: number | null } }).__xoSuiteRead?.();
    return s?.reloadPhase === null;
  }, undefined, { timeout: 8000 }).catch(() => undefined);
  // Sprint pose: run forward while capturing.
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(1500);
  await shot('14-ar-sprint');
  await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(800);
};
await scenario();

// POI close-ups with the AR held.
for (const t of targets[mapArg] ?? []) {
  await tp(t.x, t.z, t.fx, t.fz, t.pitch ?? -0.06);
  await shot(`20-${t.label}`);
}

// Remaining weapons at the last POI stand.
for (const w of ['shotgun', 'sniper', 'pistol', 'smg']) {
  await give(`${w}:common`);
  await page.waitForTimeout(600);
  await shot(`30-${w}-hip`);
}
await give('ar:common');
await page.waitForTimeout(600);

await shot('99-final');
const state = await page.evaluate(() => {
  const w = (window as unknown as { __xoState?: { phase?: string; sceneInfo?: { drawCalls?: number; triangles?: number } } }).__xoState;
  return { phase: w?.phase ?? null, drawCalls: w?.sceneInfo?.drawCalls ?? null, triangles: w?.sceneInfo?.triangles ?? null };
});
console.log(JSON.stringify({ map: mapArg, state, errors }, null, 2));
await context.close();
await browser.close();
await server.close();
if (errors.length > 0) process.exitCode = 2;
