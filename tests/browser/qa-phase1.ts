/**
 * Phase 1 headed QA: map selection, skin ownership, transport cameras, and
 * destructible-glass presentation. Screenshots are written outside the repo
 * through QA_OUT so this script never overwrites tracked evidence.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { type Page } from 'playwright';
import { createServer } from 'vite';
import { selectedBrowserType } from './browser-engine';

const MAPS = ['neocity', 'oldfront', 'eden', 'ashara'] as const;
const SKINS = ['vanguard', 'pathfinder', 'specter', 'striker', 'warden', 'nova'] as const;
const PORT = Number(process.env.QA_PORT ?? 5199);
const OUT = process.env.QA_OUT ?? '/tmp/xo-beta-phase1-qa';
const BASE_URL = `http://localhost:${PORT}`;

interface GlassSpec {
  id: number;
  stableId: string;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

interface QaState {
  map: string;
  phase: string;
  cameraMode: string;
  player: { x: number; y: number; z: number };
  transportPos: { x: number; y: number; z: number };
  playerSkin: string | null;
  playerRigSkin: string | null;
  worldConstructionMs: number;
  destructibleCount: number;
  aliveGlassCount: number;
  destructibleRender: { glassInstances: number; glassVisible: number; individual: number };
  glassSpecs: GlassSpec[];
  glassBreakTimes: number[];
  glassBreakFrames: Array<{ time: number; presentMs: number }>;
  sceneInfo: { drawCalls: number; triangles: number };
  perf: { presentMs: number; p95: number; p99: number; worst: number; spikes33: number; spikes50: number };
  camera: {
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
  };
}

type QaWindow = Window & {
  __xoState?: QaState;
  __xoTeleport?: (x: number, z: number, yaw?: number, refY?: number, pitch?: number) => boolean;
  __xoGive?: (weaponId: string, rarity?: string) => boolean;
  __xoQaInput?: (input: { firePressed?: boolean; fireHeld?: boolean; adsHeld?: boolean } | null) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function state(page: Page): Promise<QaState | null> {
  return page.evaluate(() => {
    const s = (window as unknown as QaWindow).__xoState;
    if (!s) return null;
    return {
      map: s.map,
      phase: s.phase,
      cameraMode: s.cameraMode,
      player: { x: s.player.x, y: s.player.y, z: s.player.z },
      transportPos: { ...s.transportPos },
      playerSkin: s.playerSkin,
      playerRigSkin: s.playerRigSkin,
      worldConstructionMs: s.worldConstructionMs,
      destructibleCount: s.destructibleCount,
      aliveGlassCount: s.aliveGlassCount,
      destructibleRender: { ...s.destructibleRender },
      glassSpecs: s.glassSpecs.map((g) => ({ ...g })),
      glassBreakTimes: [...s.glassBreakTimes],
      glassBreakFrames: s.glassBreakFrames.map((f) => ({ ...f })),
      sceneInfo: { ...s.sceneInfo },
      perf: { ...s.perf },
      camera: {
        position: { x: s.camera.position.x, y: s.camera.position.y, z: s.camera.position.z },
        quaternion: {
          x: s.camera.quaternion.x,
          y: s.camera.quaternion.y,
          z: s.camera.quaternion.z,
          w: s.camera.quaternion.w,
        },
      },
    };
  });
}

async function waitForState(page: Page, predicate: (value: QaState) => boolean, label: string, timeoutMs = 12000): Promise<QaState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await state(page);
    if (current && predicate(current)) return current;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForMain(page: Page): Promise<void> {
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
}

async function openPlay(page: Page): Promise<void> {
  await page.locator('#btn-play').click();
  await page.locator('#map-list .map-card').first().waitFor({ state: 'visible', timeout: 10000 });
  await sleep(150);
}

async function openSkinCustomization(page: Page): Promise<void> {
  if (!(await page.locator('#skin-customization-menu').isVisible())) {
    if (await page.locator('#play-menu').isVisible()) await page.locator('#btn-play-back').click();
    await page.locator('#btn-skin-customization').click();
  }
  await page.locator('#skin-customization-selector .skin-card').first().waitFor({ state: 'visible', timeout: 10000 });
}

async function assertMapSelection(page: Page, map: string, viewport: string): Promise<void> {
  await page.locator(`.map-card[data-map-id="${map}"]`).click();
  await sleep(450);
  const selected = page.locator('#map-list .map-card[aria-selected="true"]');
  assert.equal(await selected.count(), 1, `${viewport}: exactly one map selected for ${map}`);
  assert.equal(await selected.getAttribute('data-map-id'), map);
  const panel = page.locator('#selected-arena');
  assert.notEqual((await panel.locator('.selected-arena-label').innerText()).trim(), '');
  assert.notEqual((await panel.locator('.selected-arena-preview').evaluate((el) => getComputedStyle(el).backgroundImage)).trim(), 'none');
  const title = (await panel.locator('#selected-arena-title').innerText()).trim();
  assert.notEqual(title, '');
  assert.notEqual((await panel.locator('p').innerText()).trim(), '');
  assert.equal(await panel.locator('dd').count(), 3);
  assert.match((await page.locator('#btn-play-start').innerText()).trim(), new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await page.screenshot({ path: `${OUT}/arena-${map}-${viewport}.png`, animations: 'disabled', timeout: 120000 });
}

async function assertKeyboardSelection(page: Page): Promise<void> {
  const first = page.locator('#map-list .map-card').first();
  await first.focus();
  await page.keyboard.press('Home');
  for (const map of MAPS) {
    const active = page.locator(`#map-list .map-card[data-map-id="${map}"]`);
    assert.equal(await active.getAttribute('aria-selected'), 'true', `keyboard selected ${map}`);
    if (map !== MAPS.at(-1)) await page.keyboard.press('ArrowRight');
  }
}

async function localSkin(page: Page): Promise<{ setting: string | null; preview: string | null }> {
  return page.evaluate(() => {
    const parsed = JSON.parse(localStorage.getItem('xo-beta-settings-v1') ?? '{}') as { playerSkin?: string };
    const rig = (window as unknown as QaWindow & { __xoLobbyRig?: { group?: { userData?: { xoSkinId?: string } } } }).__xoLobbyRig;
    return { setting: parsed.playerSkin ?? null, preview: rig?.group?.userData?.xoSkinId ?? null };
  });
}

async function setSkin(page: Page, skin: string): Promise<void> {
  await openSkinCustomization(page);
  await page.locator(`#skin-customization-selector .skin-card[data-skin="${skin}"]`).click();
  await sleep(500);
  const selected = page.locator('#skin-customization-selector .skin-card[aria-selected="true"]');
  assert.equal(await selected.count(), 1);
  assert.equal(await selected.getAttribute('data-skin'), skin);
  const current = await localSkin(page);
  assert.equal(current.setting, skin, `settings skin ${skin}`);
  assert.equal(current.preview, skin, `lobby preview skin ${skin}`);
}

async function practiceSkin(page: Page, skin: string): Promise<void> {
  await setSkin(page, skin);
  await page.locator('#btn-skin-customization-back').click();
  await openPlay(page);
  await page.locator('#map-list .map-card').first().click();
  await page.locator('#btn-practice-start').click();
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
  const matchState = await waitForState(page, (s) => s.playerSkin === skin && s.playerRigSkin === skin, `practice rig ${skin}`, 30000);
  assert.equal(matchState.playerRigSkin, skin);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pause-menu:not(.hidden)', { timeout: 10000 });
  await page.locator('#btn-quit').click();
  await waitForMain(page);
  await openPlay(page);
}

function cameraMetrics(s: QaState): { vertical: number; horizontal: number; finite: boolean; values: number[] } {
  const dx = s.camera.position.x - s.transportPos.x;
  const dz = s.camera.position.z - s.transportPos.z;
  const values = [s.camera.position.x, s.camera.position.y, s.camera.position.z, s.camera.quaternion.x, s.camera.quaternion.y, s.camera.quaternion.z, s.camera.quaternion.w];
  return { vertical: s.camera.position.y - s.transportPos.y, horizontal: Math.hypot(dx, dz), finite: values.every(Number.isFinite), values };
}

function cameraOffset(s: QaState): { x: number; y: number; z: number } {
  return {
    x: s.camera.position.x - s.transportPos.x,
    y: s.camera.position.y - s.transportPos.y,
    z: s.camera.position.z - s.transportPos.z,
  };
}

async function breakGlass(page: Page, glass: GlassSpec): Promise<QaState> {
  const axisX = glass.sx >= glass.sz;
  const sign = axisX ? 1 : 1;
  const startX = axisX ? glass.x : glass.x + sign * 4.5;
  const startZ = axisX ? glass.z + sign * 4.5 : glass.z;
  const yaw = Math.atan2(-(glass.x - startX), -(glass.z - startZ));
  const teleported = await page.evaluate(({ x, z, yaw, refY }) => {
    const fn = (window as unknown as QaWindow).__xoTeleport;
    return fn?.(x, z, yaw, refY, 0) ?? false;
  }, { x: startX, z: startZ, yaw, refY: glass.y });
  assert.equal(teleported, true, `teleported to ${glass.stableId}`);
  await sleep(350);
  const placed = await state(page);
  assert.ok(placed);
  const eyeY = placed.player.y + 0.705;
  const horizontalDistance = Math.hypot(glass.x - placed.player.x, glass.z - placed.player.z);
  const pitch = Math.max(-1.2, Math.min(1.2, Math.atan2(glass.y - eyeY, Math.max(1, horizontalDistance))));
  const aimed = await page.evaluate(({ x, z, yaw, refY, pitch }) => {
    const fn = (window as unknown as QaWindow).__xoTeleport;
    return fn?.(x, z, yaw, refY, pitch) ?? false;
  }, { x: startX, z: startZ, yaw, refY: glass.y, pitch });
  assert.equal(aimed, true, `aimed at ${glass.stableId}`);
  await sleep(250);
  const gave = await page.evaluate(() => (window as unknown as QaWindow).__xoGive?.('sniper', 'rare') ?? false);
  assert.equal(gave, true, 'sniper granted');
  // The real bolt cycle is close to one second. Keep the two deterministic
  // probes independent even when the first shot resolves unusually quickly.
  await sleep(1100);
  const before = await state(page);
  assert.ok(before);
  const firedAt = performance.now();
  await page.evaluate(() => (window as unknown as QaWindow).__xoQaInput?.({ firePressed: true }));
  await sleep(100);
  await page.evaluate(() => (window as unknown as QaWindow).__xoQaInput?.(null));
  const broken = await waitForState(page, (s) => s.glassBreakTimes.length > before.glassBreakTimes.length, `glass break ${glass.stableId}`, 8000);
  console.log(JSON.stringify({
    glass: glass.stableId,
    responseMs: +(performance.now() - firedAt).toFixed(1),
    frame: broken.glassBreakFrames.at(-1),
    aliveGlassCount: broken.aliveGlassCount,
    visibleGlassInstances: broken.destructibleRender.glassVisible,
  }));
  return broken;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'silent' });
  await server.listen();
  const browser = await selectedBrowserType().launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem('xo-beta-settings-v1')) {
      localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
        onboarded: true, lang: 'en', playerSkin: 'vanguard', gamepadEnabled: true,
        quality: 'low', shadows: false, shadowQuality: 'low', postProcessing: false,
        bloom: false, aa: 'off', resolutionScale: 0.6,
      }));
    }
    localStorage.setItem('xo-beta-lang', 'en');
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
    if (message.type() === 'warning') consoleWarnings.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    for (const viewport of [{ width: 1280, height: 720, name: '1280x720' }, { width: 1920, height: 1080, name: '1920x1080' }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${BASE_URL}/?qa=1`, { waitUntil: 'domcontentloaded' });
      await waitForMain(page);
      await page.addStyleTag({ content: '* { animation-duration: 0s !important; transition-duration: 0s !important; }' });
      await openPlay(page);
      for (const map of MAPS) await assertMapSelection(page, map, viewport.name);
      await assertKeyboardSelection(page);
      await page.screenshot({ path: `${OUT}/play-${viewport.name}.png`, animations: 'disabled', timeout: 120000 });
    }

    // Entering the play flow starts with no arena selected. Start actions stay
    // visually unavailable but return a localized validation message instead
    // of silently choosing the first map.
    await page.locator('#btn-play-back').click();
    await openPlay(page);
    assert.equal(await page.locator('#map-list .map-card[aria-selected="true"]').count(), 0);
    await page.locator('#btn-play-start').click();
    assert.notEqual((await page.locator('#play-selection-error').innerText()).trim(), '');

    // Language changes rebuild the details panel while preserving the explicit
    // selection state only until the player re-enters the play flow.
    await page.locator('#btn-play-back').click();
    await page.locator('#btn-settings').click();
    await page.locator('#settings-controls select').first().selectOption('ja');
    await sleep(600);
    await page.locator('#btn-settings-back').click();
    await openPlay(page);
    assert.equal(await page.locator('#map-list .map-card[aria-selected="true"]').count(), 0);
    await page.locator('#map-list .map-card[data-map-id="ashara"]').click();
    assert.notEqual((await page.locator('#selected-arena-title').innerText()).trim(), 'ASHARA');
    await page.locator('#btn-play-back').click();
    await page.locator('#btn-settings').click();
    await page.locator('#settings-controls select').first().selectOption('en');
    await sleep(600);
    await page.locator('#btn-settings-back').click();
    await openPlay(page);

    // Exercise the dedicated skin screen, keyboard traversal, settings sync,
    // reload persistence, and actual practice rig creation.
    await page.locator('#btn-play-back').click();
    await openSkinCustomization(page);
    assert.equal(await page.locator('#skin-customization-selector .skin-card').count(), SKINS.length);
    await setSkin(page, 'vanguard');
    await page.locator('#skin-customization-selector .skin-card[data-skin="vanguard"]').focus();
    await page.keyboard.press('ArrowRight');
    await sleep(500);
    assert.equal((await localSkin(page)).setting, 'pathfinder');
    for (const skin of SKINS) await setSkin(page, skin);
    await page.locator('#btn-skin-customization-back').click();
    await page.locator('#btn-settings').click();
    await page.locator('#settings-tab-gameplay').click();
    const settingsSkin = page.locator('#settings-gameplay select').nth(2);
    assert.equal(await settingsSkin.inputValue(), 'nova', 'settings selector follows lobby selection');
    await settingsSkin.selectOption('nova');
    await sleep(500);
    assert.equal((await localSkin(page)).setting, 'nova');
    await page.locator('#btn-settings-back').click();
    await openSkinCustomization(page);
    assert.equal(await page.locator('#skin-customization-selector .skin-card[aria-selected="true"]').getAttribute('data-skin'), 'nova');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMain(page);
    await openSkinCustomization(page);
    assert.equal((await localSkin(page)).setting, 'nova', 'skin survives reload');
    await page.screenshot({ path: `${OUT}/skin-selector.png`, animations: 'disabled', timeout: 120000 });
    for (const skin of SKINS) await practiceSkin(page, skin);

    // Transport camera: both settings share one external rig and remain well
    // clear of the interpolated transport position while the route is active.
    await page.locator('#map-list .map-card[data-map-id="neocity"]').click();
    await page.locator('#btn-play-start').click();
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
    await sleep(2500);
    const transportFps = await state(page);
    assert.ok(transportFps);
    assert.equal(transportFps.phase, 'transport');
    assert.equal(transportFps.cameraMode, 'fps');
    const fpsMetrics = cameraMetrics(transportFps);
    assert.equal(fpsMetrics.finite, true, `non-finite FPS camera values: ${JSON.stringify(fpsMetrics.values)}`);
    assert.ok(fpsMetrics.vertical > 15 && fpsMetrics.horizontal > 25);
    await page.screenshot({ path: `${OUT}/transport-fps.png`, animations: 'disabled', timeout: 120000 });
    await page.keyboard.press('KeyV');
    await sleep(500);
    const transportTps = await state(page);
    assert.ok(transportTps);
    assert.equal(transportTps.phase, 'transport');
    assert.equal(transportTps.cameraMode, 'tps');
    const tpsMetrics = cameraMetrics(transportTps);
    assert.equal(tpsMetrics.finite, true);
    assert.ok(tpsMetrics.vertical > 15 && tpsMetrics.horizontal > 25);
    const fpsOffset = cameraOffset(transportFps);
    const tpsOffset = cameraOffset(transportTps);
    assert.ok(Math.abs(tpsOffset.x - fpsOffset.x) < 1.5 && Math.abs(tpsOffset.y - fpsOffset.y) < 0.5 && Math.abs(tpsOffset.z - fpsOffset.z) < 1.5, 'FPS/TPS share the external transport offset');
    await page.screenshot({ path: `${OUT}/transport-tps.png`, animations: 'disabled', timeout: 120000 });
    await page.keyboard.press('Space');
    await sleep(900);

    // Practice match gives a quiet deterministic surface for the browser
    // break measurement. Use ground-floor and upper-floor panes separately.
    await page.keyboard.press('Escape');
    await page.waitForSelector('#pause-menu:not(.hidden)', { timeout: 10000 });
    await page.locator('#btn-quit').click();
    await waitForMain(page);
    await openPlay(page);
    await page.locator('#map-list .map-card[data-map-id="neocity"]').click();
    await page.locator('#btn-practice-start').click();
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
    await sleep(1200);
    await page.keyboard.press('Space');
    await waitForState(page, (s) => s.phase === 'live' || s.phase === 'drop', 'practice deployment', 20000);
    const initial = await waitForState(page, (s) => s.glassSpecs.length > 0, 'glass census', 15000);
    const ground = initial.glassSpecs.find((g) => g.y < 3.5);
    const upper = initial.glassSpecs.find((g) => g.y > 4.5);
    assert.ok(ground && upper, 'ground and upper panes present in Neo City');
    const afterGround = await breakGlass(page, ground);
    const afterUpper = await breakGlass(page, upper);
    assert.equal(afterGround.glassBreakTimes.length + 1, afterUpper.glassBreakTimes.length);
    assert.ok(afterUpper.destructibleRender.glassVisible < initial.destructibleRender.glassVisible);
    assert.ok(afterUpper.glassBreakFrames.length >= 2);
    console.log(JSON.stringify({
      glassPerformance: {
        map: afterUpper.map,
        destructibleCount: initial.destructibleCount,
        glassInstances: initial.destructibleRender.glassInstances,
        drawCallsSettled: initial.sceneInfo.drawCalls,
        trianglesSettled: initial.sceneInfo.triangles,
        worldConstructionMs: initial.worldConstructionMs,
        firstBreakPresentMs: afterGround.glassBreakFrames.at(-1)?.presentMs,
        secondBreakPresentMs: afterUpper.glassBreakFrames.at(-1)?.presentMs,
        glassVisibleAfterTwo: afterUpper.destructibleRender.glassVisible,
        p95: afterUpper.perf.p95,
        p99: afterUpper.perf.p99,
        worst: afterUpper.perf.worst,
      },
    }));

    assert.equal(consoleErrors.length, 0, `console errors: ${consoleErrors.join(' | ')}`);
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`);
    console.log(JSON.stringify({ ok: true, screenshots: OUT, warnings: consoleWarnings.length }));
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
