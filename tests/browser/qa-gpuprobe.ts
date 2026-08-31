/** Probe: measures renderer FPS headless with different GPU flags. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function probe(args: string[], label: string): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(`[${label}] pageerror:`, e.message.slice(0, 160)));
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(500);
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click('#map-list .map-card:nth-child(1)');
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
  // Sample match clock progression for 10s
  const t0 = (await page.evaluate('window.__xoState ? window.__xoState.time : -1')) as number;
  await page.waitForTimeout(10000);
  const t1 = (await page.evaluate('window.__xoState ? window.__xoState.time : -1')) as number;
  const info = await page.evaluate(() => {
    const w = window as unknown as { __xoState?: { sceneInfo: { drawCalls: number } } };
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
    const dbg = gl ? gl.getExtension('WEBGL_debug_renderer_info') : null;
    return {
      unmasked: dbg && gl ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'n/a',
      drawCalls: w.__xoState ? w.__xoState.sceneInfo.drawCalls : -1,
    };
  });
  console.log(`[${label}] renderer=${info.unmasked} draws=${info.drawCalls} simTime advanced ${(t1 - t0).toFixed(2)}s in 10s wall (${((t1 - t0) / 10 * 100).toFixed(0)}% realtime)`);
  await browser.close();
  await server.close();
}

const mode = process.argv[2] ?? 'gpu';
if (mode === 'gpu') {
  await probe(['--use-angle=metal'], 'metal');
} else if (mode === 'default') {
  await probe([], 'default');
} else {
  await probe(['--enable-unsafe-swiftshader'], 'swiftshader');
}
