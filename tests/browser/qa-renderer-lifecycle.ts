import { chromium } from 'playwright';
import { createServer, type Plugin } from 'vite';

type ResourceSample = {
  programs: number;
  textures: number;
  geometries: number;
  renderTargets: number;
};

const resourceProbePlugin: Plugin = {
  name: 'xo-resource-probe',
  enforce: 'pre',
  transform(code, id) {
    if (id.split('?')[0] !== `${process.cwd()}/src/main.ts`) return;
    return `${code}
window.__xoResourceProbe = () => {
  const active = live?.renderer;
  if (!active) return null;
  const memory = active.renderer.info.memory;
  return {
    programs: memory.programs ?? 0,
    textures: memory.textures ?? 0,
    geometries: memory.geometries ?? 0,
    renderTargets: memory.renderTargets ?? 0,
  };
};
window.__xoRebuildComposer = () => {
  if (!live) return false;
  live.renderer.buildComposer(live.rig.camera);
  return true;
};`;
  },
};

async function main(): Promise<void> {
  const port = 5511;
  const server = await createServer({
    server: { port, strictPort: true },
    logLevel: 'silent',
    plugins: [resourceProbePlugin],
  });
  await server.listen();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=metal'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text().split('\n')[0] ?? 'console error');
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
      } catch (error) {
        void error;
      }
      localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
        quality: 'high',
        resolutionScale: 1,
        shadows: true,
        shadowQuality: 'high',
        postProcessing: true,
        bloom: true,
        reflections: false,
        ao: false,
        aa: 'smaa',
        motionBlur: false,
        dof: false,
        fpsLimit: 0,
        cameraMode: 'fps',
        onboarded: true,
        lang: 'en',
      }));
    });
    await page.goto(`http://localhost:${port}/?qa=1&hero=1&seed=42042`, { waitUntil: 'domcontentloaded' });
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
    for (let i = 0; i < 120; i++) {
      const grounded = await page.evaluate(
        () => (window as { __xoState?: { player?: { grounded?: boolean } } }).__xoState?.player?.grounded === true,
      );
      if (grounded) break;
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1500);
    const sample = async (label: string): Promise<ResourceSample> => {
      const value = await page.evaluate(
        () => (window as { __xoResourceProbe?: () => ResourceSample | null }).__xoResourceProbe?.(),
      );
      if (!value) throw new Error(`${label}: renderer probe unavailable`);
      console.log(label, JSON.stringify(value));
      return value;
    };
    const baseline = await sample('before');
    for (let i = 0; i < 3; i++) {
      const rebuilt = await page.evaluate(
        () => (window as { __xoRebuildComposer?: () => boolean }).__xoRebuildComposer?.(),
      );
      await page.waitForTimeout(700);
      console.log('rebuild', i + 1, rebuilt);
      const current = await sample(`after-${i + 1}`);
      for (const key of ['programs', 'textures', 'geometries', 'renderTargets'] as const) {
        if (current[key] !== baseline[key]) {
          throw new Error(`renderer resource drift after rebuild ${i + 1}: ${key} ${baseline[key]} -> ${current[key]}`);
        }
      }
    }
    if (errors.length > 0) throw new Error(`browser errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
