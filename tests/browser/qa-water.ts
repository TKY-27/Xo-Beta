/**
 * Deterministic Eden water visual/performance capture.
 *
 * Run before and after renderer changes with identical conditions:
 *   QA_WATER_LABEL=before npx tsx tests/browser/qa-water.ts
 *   QA_WATER_LABEL=after  npx tsx tests/browser/qa-water.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { summarizeFrameDeltas } from './frame-metrics';

interface WaterView {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  time: number;
  player?: { x: number; z: number; yaw: number; mode: 'standing' | 'swim' };
  thirdPerson?: boolean;
}

const VIEWS: WaterView[] = [
  { name: 'lake-shoreline', position: [64, 0.4, 45], target: [102, -3.55, 58], fov: 66, time: 18 },
  { name: 'lake-low-sun', position: [205, 0.45, 124], target: [136, -3.45, 62], fov: 58, time: 18 },
  { name: 'lake-dock', position: [109, -0.8, 45], target: [126, -3.95, 68], fov: 64, time: 18 },
  { name: 'lake-elevated', position: [226, 50, -15], target: [143, -4, 64], fov: 62, time: 18 },
  { name: 'river-along', position: [170, -1.25, 133], target: [170, -3.75, 165], fov: 62, time: 18 },
  { name: 'river-across', position: [143, -1.4, 151], target: [191, -3.85, 151], fov: 60, time: 18 },
  { name: 'pond-close', position: [-174, 0.7, 204], target: [-218, -3.25, 204], fov: 60, time: 18 },
  { name: 'pond-elevated', position: [-163, 27, 164], target: [-215, -3.7, 204], fov: 62, time: 18 },
  {
    name: 'lake-swimming', position: [122, -1.35, 78], target: [110, -3.1, 70], fov: 62, time: 18,
    player: { x: 110, z: 70, yaw: -Math.PI / 3, mode: 'swim' }, thirdPerson: true,
  },
  {
    name: 'river-swimming', position: [182, -1.15, 163], target: [170, -3.05, 155], fov: 62, time: 18,
    player: { x: 170, z: 155, yaw: Math.PI / 2, mode: 'standing' }, thirdPerson: true,
  },
  { name: 'underwater-up', position: [139, -5.7, 71], target: [140, -3.3, 71], fov: 70, time: 18 },
];

const QUALITY_VALUES = ['low', 'medium', 'high', 'ultra', 'cinematic'] as const;
type WaterQaQuality = typeof QUALITY_VALUES[number];
const requestedQuality = process.env.QA_WATER_QUALITY ?? 'high';
if (!QUALITY_VALUES.includes(requestedQuality as WaterQaQuality)) {
  throw new Error(`Invalid QA_WATER_QUALITY: ${requestedQuality}`);
}
const QUALITY = requestedQuality as WaterQaQuality;

const SETTINGS = {
  quality: QUALITY,
  resolutionScale: 1,
  shadows: true,
  shadowQuality: 'high',
  postProcessing: true,
  bloom: true,
  reflections: true,
  ao: true,
  aa: 'smaa',
  motionBlur: false,
  dof: false,
  fpsLimit: 0,
  cameraMode: 'fps',
  onboarded: true,
  lang: 'en',
};

async function reachPractice(page: Page): Promise<void> {
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90_000 });
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click('#map-list .map-card:nth-child(3)');
  await page.click('#btn-practice-start');
  await page.waitForFunction(
    () => document.getElementById('hud')?.classList.contains('hidden') === false,
    undefined,
    { timeout: 90_000 },
  );
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await page.evaluate(() => {
      const value = (window as unknown as { __xoState?: { phase?: string; player?: { grounded?: boolean } } }).__xoState;
      return { phase: value?.phase, grounded: value?.player?.grounded };
    });
    if (state.phase === 'live' && state.grounded) return;
    await page.waitForTimeout(250);
  }
  throw new Error('Water QA did not reach a grounded Eden practice match');
}

async function setView(page: Page, view: WaterView): Promise<WaterView> {
  let effectiveView = view;
  if (view.player) {
    let ok = await page.evaluate((player) => {
      const teleport = (window as unknown as {
        __xoTeleport?: (x: number, z: number, yaw: number, refY?: number, pitch?: number, mode?: 'standing' | 'swim') => boolean;
      }).__xoTeleport;
      return teleport?.(player.x, player.z, player.yaw, undefined, -0.08, player.mode) ?? false;
    }, view.player);
    if (!ok && view.player.mode === 'swim') {
      const bounds = view.name.startsWith('river')
        ? { minX: 150, maxX: 190, minZ: 135, maxZ: 165, surfaceY: -4 }
        : { minX: 70, maxX: 215, minZ: -15, maxZ: 135, surfaceY: -4.2 };
      const resolved = await page.evaluate((search) => {
        const teleport = (window as unknown as {
          __xoTeleport?: (x: number, z: number, yaw: number, refY?: number, pitch?: number, mode?: 'standing' | 'swim') => boolean;
        }).__xoTeleport;
        if (!teleport) return null;
        for (let z = search.minZ + 4; z <= search.maxZ - 4; z += 4) {
          for (let x = search.minX + 4; x <= search.maxX - 4; x += 4) {
            if (teleport(x, z, -Math.PI / 3, undefined, -0.08, 'swim')) return { x, z };
          }
        }
        return null;
      }, bounds);
      ok = resolved !== null;
      if (resolved) {
        effectiveView = {
          ...view,
          position: [resolved.x + 12, bounds.surfaceY + 2.85, resolved.z + 8],
          target: [resolved.x, bounds.surfaceY + 1.1, resolved.z],
        };
      }
    }
    if (!ok) throw new Error(`Water QA teleport failed: ${view.name}`);
  }
  await page.evaluate((value) => {
    (window as unknown as { __xoWaterQaView?: WaterView }).__xoWaterQaView = value;
  }, effectiveView);
  await page.waitForTimeout(800);
  return effectiveView;
}

async function synchronousFrame(page: Page): Promise<number> {
  const nonce = `water-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await page.locator('#xo-qa-gpu-sync-command').fill(nonce);
  await page.waitForFunction((request) => {
    const raw = document.documentElement.dataset.xoQaGpuSyncResult;
    if (!raw) return false;
    try { return (JSON.parse(raw) as { nonce?: string }).nonce === request; } catch { return false; }
  }, nonce, { timeout: 10_000 });
  const result = await page.evaluate(() => JSON.parse(
    document.documentElement.dataset.xoQaGpuSyncResult ?? '{}',
  ) as { ms?: number });
  if (!Number.isFinite(result.ms)) throw new Error(`Invalid synchronous-frame result: ${JSON.stringify(result)}`);
  return result.ms!;
}

async function frameDeltas(page: Page, durationMs: number): Promise<number[]> {
  return page.evaluate(`(async () => {
    const stamps = [];
    const started = performance.now();
    await new Promise((resolve) => {
      const sample = (now) => {
        stamps.push(now);
        if (now - started >= ${Math.max(1, Math.round(durationMs))}) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
  })()`) as Promise<number[]>;
}

async function drawStats(page: Page): Promise<{ calls: number; triangles: number; frames: number }> {
  return page.evaluate(`(async () => {
    const renderer = window.__xoState.threeRenderer;
    renderer.info.autoReset = false;
    renderer.info.reset();
    let frames = 0;
    const started = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => {
        frames++;
        if (now - started >= 1000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const result = {
      calls: Math.round(renderer.info.render.calls / Math.max(1, frames)),
      triangles: Math.round(renderer.info.render.triangles / Math.max(1, frames)),
      frames,
    };
    renderer.info.autoReset = true;
    return result;
  })()`) as Promise<{ calls: number; triangles: number; frames: number }>;
}

async function main(): Promise<void> {
  const label = process.env.QA_WATER_LABEL ?? 'capture';
  const captureScreenshots = process.env.QA_WATER_SCREENSHOTS !== '0';
  const captureTemporalFrames = process.env.QA_WATER_TEMPORAL_FRAMES === '1';
  const outputRoot = path.resolve(process.env.QA_WATER_OUT ?? 'qa/water', label);
  await mkdir(outputRoot, { recursive: true });
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const headless = process.env.HEADLESS === '1';
  if (headless) console.warn('HEADLESS=1 is diagnostic only and not visual-acceptance evidence.');
  const browser = await chromium.launch({ channel: 'chrome', headless });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  try {
    await page.addInitScript({ content: `
      window.__xoCreatedWebGlCanvasIds = [];
      try { Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }); } catch {}
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        const context = originalGetContext.call(this, type, ...args);
        if ((type === 'webgl' || type === 'webgl2') && context) {
          const ids = window.__xoCreatedWebGlCanvasIds;
          if (!ids.includes(this.id)) ids.push(this.id);
        }
        return context;
      };
    ` });
    await page.addInitScript((settings) => {
      localStorage.setItem('xo-beta-settings-v1', JSON.stringify(settings));
    }, SETTINGS);
    await page.goto('http://localhost:5199/?qa=1&hero=1&seed=42042', { waitUntil: 'domcontentloaded' });
    await reachPractice(page);
    await page.evaluate(() => {
      (window as unknown as { __xoWaterQaFreezeSimulation?: boolean })
        .__xoWaterQaFreezeSimulation = true;
    });
    await page.addStyleTag({ content: [
      '#hud, #crosshair, #damage-vignette, #hitmarker, #interaction-prompt,',
      '#loot-panel, #captions, #fps-counter { display: none !important; }',
    ].join('\n') });

    await setView(page, VIEWS[2]!);
    const firstVisibleFrameMs = await synchronousFrame(page);
    const warmFrames: number[] = [];
    for (let i = 0; i < 12; i++) warmFrames.push(await synchronousFrame(page));
    const warmSorted = [...warmFrames].sort((a, b) => a - b);
    const warmVisibleFrameMs = warmSorted[Math.floor(warmSorted.length / 2)]!;
    const deltas = await frameDeltas(page, 10_000);
    const frameMetrics = summarizeFrameDeltas(deltas);
    const sortedDeltas = [...deltas].sort((a, b) => a - b);
    const p50Ms = sortedDeltas[Math.floor((sortedDeltas.length - 1) * 0.5)]!;
    const draw = await drawStats(page);

    let thirdPerson = false;
    const capturedViews: WaterView[] = [];
    for (const view of VIEWS) {
      if ((view.thirdPerson ?? false) !== thirdPerson) {
        await page.keyboard.press('KeyV');
        thirdPerson = !thirdPerson;
        await page.waitForTimeout(350);
      }
      capturedViews.push(await setView(page, view));
      if (captureScreenshots) {
        await page.screenshot({ path: path.join(outputRoot, `${view.name}.png`), timeout: 60_000 });
      }
    }

    let temporalFramesCaptured = 0;
    if (captureTemporalFrames) {
      const temporalDir = path.join(outputRoot, 'temporal-low-sun');
      await mkdir(temporalDir, { recursive: true });
      const baseView = VIEWS[1]!;
      for (let frameIndex = 0; frameIndex < 10; frameIndex++) {
        const temporalView = { ...baseView, time: baseView.time + frameIndex / 30 };
        await page.evaluate((value) => {
          (window as unknown as { __xoWaterQaView?: WaterView }).__xoWaterQaView = value;
        }, temporalView);
        await synchronousFrame(page);
        await page.screenshot({
          path: path.join(temporalDir, `${String(frameIndex).padStart(2, '0')}.png`),
          timeout: 60_000,
        });
        temporalFramesCaptured++;
      }
    }

    const runtime = await page.evaluate(() => {
      const state = (window as unknown as {
        __xoState: {
          seed: number;
          worldConstructionMs: number;
          perf: { presentMs: number };
          water: {
            quality: string;
            volumes: number;
            visibleVolumes: number;
            drawCalls: number;
            triangles: number;
            waveTextureBytes: number;
            depthTextureBytes: number;
            halfFloatWaveData: boolean;
            waveResolution: number;
          };
          threeRenderer: {
            info: {
              programs?: unknown[];
              memory: { geometries: number; textures: number };
            };
          };
        };
      }).__xoState;
      const webglCanvasIds = [...((window as unknown as { __xoCreatedWebGlCanvasIds?: string[] })
        .__xoCreatedWebGlCanvasIds ?? [])];
      return {
        seed: state.seed,
        worldConstructionMs: state.worldConstructionMs,
        presentMs: state.perf.presentMs,
        water: state.water,
        programs: state.threeRenderer.info.programs?.length ?? 0,
        rendererMemory: state.threeRenderer.info.memory,
        gpu: document.documentElement.dataset.xoQaGpuDevice ?? 'unavailable',
        webglCanvasIds,
        runtimeIssues: document.documentElement.dataset.xoQaRuntime ?? 'missing',
      };
    });
    if (errors.length > 0) throw new Error(`Water QA browser errors:\n${errors.join('\n')}`);
    if (runtime.runtimeIssues !== 'count=0') throw new Error(`Water QA runtime issue: ${runtime.runtimeIssues}`);
    if (runtime.webglCanvasIds.length !== 1 || runtime.webglCanvasIds[0] !== 'game-canvas') {
      throw new Error(`Unexpected WebGL canvases: ${runtime.webglCanvasIds.join(', ')}`);
    }
    const report = {
      label,
      capturedAt: new Date().toISOString(),
      browser: 'Google Chrome (Playwright channel)',
      viewport: { width: 1920, height: 1080 },
      map: 'eden',
      seed: 42042,
      quality: SETTINGS,
      views: capturedViews.map(({ name, position, target, fov, time }) => ({ name, position, target, fov, time })),
      frame: { p50Ms: +p50Ms.toFixed(2), ...frameMetrics },
      synchronousRender: {
        firstVisibleFrameMs,
        warmVisibleFrameMs,
        warmSamplesMs: warmFrames,
      },
      draw,
      runtime,
      browserErrors: errors,
      screenshotsCaptured: captureScreenshots,
      temporalFramesCaptured,
    };
    await writeFile(path.join(outputRoot, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
