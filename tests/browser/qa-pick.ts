/**
 * One-off QA picker: boots a match on the chosen map, teleports to QA_TP,
 * then raycasts from the screen centre and dumps rich object/material/
 * geometry info for the first hits. Faster loop than the full boot probe
 * when diagnosing a single suspicious object.
 *
 * Usage: QA_TP="x,z,yaw,pitch" npx tsx tests/browser/qa-pick.ts [map]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const mapArg = (process.argv[2] ?? 'ashara').toLowerCase();
const mapIndex = ['neocity', 'oldfront', 'eden', 'ashara'].indexOf(mapArg) + 1;

const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (err) => console.log('PAGEERROR', String(err).slice(0, 200)));

await page.addInitScript((settings) => {
  window.localStorage.setItem('xo-beta-settings-v1', JSON.stringify(settings));
}, (() => {
  const base: Record<string, unknown> = { cameraMode: 'fps', quality: 'ultra', postProcessing: true, bloom: true, ao: true, aa: 'smaa', resolutionScale: 1 };
  if (process.env.QA_GFX === 'noshadow') Object.assign(base, { shadows: false, shadowQuality: 'low' });
  if (process.env.QA_GFX === 'raw') Object.assign(base, { postProcessing: false, bloom: false, ao: false, aa: 'off' });
  return base;
})());

await page.goto(`http://localhost:5199/?qa=1&seed=42042`, { waitUntil: 'networkidle' });
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
await page.waitForTimeout(1000);
await page.click('#btn-play', { timeout: 3000 });
await page.click(`#map-list .map-card:nth-child(${mapIndex})`, { timeout: 3000 });
await page.click('#btn-play-start', { timeout: 3000 });
await page.waitForSelector('#hud:not(.hidden)', { timeout: 150000 });
await page.waitForTimeout(3000);
await page.keyboard.press('Space');
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const phase = await page.evaluate(() => (window as unknown as { __xoState?: { player?: { grounded?: boolean } } }).__xoState?.player);
  if (phase?.grounded) break;
}

const [x, z, yaw, pitch] = (process.env.QA_TP ?? '0,0,0,-0.1').split(',').map((v) => Number(v.trim()));
await page.evaluate((pos) => {
  const input = document.getElementById('xo-qa-teleport-command') as HTMLInputElement | null;
  if (input) {
    input.value = JSON.stringify({ nonce: `pick-${Date.now()}`, x: pos.x, z: pos.z, yaw: pos.yaw, pitch: pos.pitch });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}, { x, z, yaw, pitch });
await page.waitForTimeout(2000);

const boxEnv = process.env.QA_BOX ?? '-0.6,0.6,-0.6,0.6';
const picked = await page.evaluate((boxSpec) => {
  const w = window as unknown as { __xoPick?: (x?: number, y?: number) => unknown };
  const pick = w.__xoPick;
  if (!pick) return 'no-bridge';
  // Dense sweep over the NDC window QA_BOX="nx0,nx1,ny0,ny1" (default whole
  // frame at coarse grid) so a specific suspect can be attributed exactly.
  const box = boxSpec.split(',').map(Number);
  const step = boxSpec === '-0.6,0.6,-0.6,0.6' ? 0.25 : 0.05;
  const census: Array<{ at: string; hit: unknown }> = [];
  for (let ny = box[2]!; ny <= box[3]! + 1e-6; ny += step) {
    for (let nx = box[0]!; nx <= box[1]! + 1e-6; nx += step) {
      census.push({ at: `${nx.toFixed(2)},${ny.toFixed(2)}`, hit: pick(nx, ny) });
    }
  }
  return census;
}, boxEnv);
console.log(JSON.stringify(picked, null, 1));

// Optional: brute-force sight-line census through the suspect point
// (QA_RAYENUM="nx,ny" in NDC), independent of the raycaster's filters.
const rayEnum = process.env.QA_RAYENUM;
if (rayEnum) {
  const [nx, ny] = rayEnum.split(',').map(Number);
  const enumerated = await page.evaluate(([ex, ey]) => {
    const w = window as unknown as { __xoRayEnum?: (x?: number, y?: number) => unknown };
    return w.__xoRayEnum ? w.__xoRayEnum(ex, ey) : 'no-bridge';
  }, [nx, ny]);
  console.log(`ray-enum ${rayEnum}: ${JSON.stringify(enumerated, null, 1)}`);
}

// Optional experiment: hide meshes by uuid prefix or MATERIAL NAME
// (comma-separated list; re-shoots after each hide in sequence).
const hideUuid = process.env.QA_HIDE_UUID;
if (hideUuid) {
  let shot = 0;
  for (const target of hideUuid.split(',')) {
    const toggled = await page.evaluate((t) => {
      const w = window as unknown as { __xoHideUuid?: (u: string) => unknown };
      return w.__xoHideUuid ? w.__xoHideUuid(t) : 'no-bridge';
    }, target);
    await page.waitForTimeout(800);
    shot += 1;
    await page.screenshot({ path: `qa/pick-${mapArg}-hidden${shot > 1 ? shot : ''}.png` });
    console.log(`hid ${target}: ${JSON.stringify(toggled)} -> qa/pick-${mapArg}-hidden${shot > 1 ? shot : ''}.png`);
  }
}

// Optional: recolour a material pool for maximum-contrast A/B.
const tint = process.env.QA_TINT;
if (tint) {
  const [target, hex] = tint.split('@');
  const res = await page.evaluate((t) => {
    const w = window as unknown as { __xoTint?: (p: string, h?: string) => unknown };
    return w.__xoTint ? w.__xoTint(t[0]!, t[1]) : 'no-bridge';
  }, [target!, hex ?? 'ff00ff']);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `qa/pick-${mapArg}-tinted.png` });
  console.log(`tinted: ${JSON.stringify(res)} -> qa/pick-${mapArg}-tinted.png`);
}

// DOM hit test at screen centre of the suspect box (QA_DOM="x,y").
const dom = process.env.QA_DOM;
if (dom) {
  const [dx, dy] = dom.split(',').map(Number);
  const el = await page.evaluate(([x, y]) => {
    const e = document.elementFromPoint(x ?? 640, y ?? 360);
    return e ? `${e.tagName}#${e.id}.${String(e.className).slice(0, 60)}` : 'none';
  }, [dx, dy]);
  console.log(`elementFromPoint(${dx},${dy}): ${el}`);
}
// Second capture with the camera yawed ~0.4 rad: a screen-fixed artifact
// stays put; world geometry parallax-shifts.
if (process.env.QA_SECOND_YAW) {
  const yaw2 = Number(process.env.QA_SECOND_YAW);
  await page.evaluate((arg) => {
    const input = document.getElementById('xo-qa-teleport-command') as HTMLInputElement | null;
    if (input) {
      input.value = JSON.stringify({ nonce: `yaw2-${Date.now()}`, x: arg.x, z: arg.z, yaw: arg.yaw, pitch: arg.pitch });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, { x, z, yaw: yaw2, pitch: pitch ?? -0.1 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `qa/pick-${mapArg}-yaw2.png` });
}

await page.screenshot({ path: `qa/pick-${mapArg}.png` });
await browser.close();
await server.close();
