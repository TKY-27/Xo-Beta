/**
 * Standalone GTAO probe driver.
 *
 * The r185 GTAONode is hard-disabled in the renderer with a note that it
 * "returns ~0 occlusion on the WebGPU backend". That note records a symptom
 * (a black frame), not a diagnosis: `GTAONode.updateBefore()` clears the AO
 * target to white, so an all-black result means the *depth input* is wrong, not
 * that the effect is unsupported.
 *
 * The scene half lives in `fixtures/qa-gtao-probe-page.ts`. It renders a ground
 * plane with a row of boxes and reports the luminance distribution of the AO
 * buffer itself. Because `GTAONode.updateBefore()` clears the AO target to
 * white, `aoMin === 1.0` means the effect is dead while any value below 1.0
 * proves the depth reached it. `thickness` and `radius` are swept so the
 * parameters that actually produce contact darkening are measured, not guessed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';

const PORT = Number(process.env.QA_GTAO_PORT ?? 5212);
const TIMEOUT_MS = 180_000;

type Sample = {
  geoMean: number;
  geoMin: number;
  p05: number;
  p50: number;
  spread: number;
  coverage: number;
  frameMin: number;
};
type Run = { mode: string; samples: Sample | null; error: string | null };

async function main(): Promise<void> {
  const server: ViteDevServer = await createServer({
    configFile: new URL('../../vite.config.ts', import.meta.url).pathname,
    server: { port: PORT, strictPort: true },
    logLevel: 'error',
  });
  await server.listen();

  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--use-angle=metal'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(`http://localhost:${PORT}/tests/browser/fixtures/gtao.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => Boolean((window as unknown as { __GTAO_DONE?: boolean }).__GTAO_DONE), null, {
    timeout: TIMEOUT_MS,
  });

  const runs = (await page.evaluate(
    () => (window as unknown as { __GTAO_RESULTS: Run[] }).__GTAO_RESULTS,
  )) as Run[];

  const report = runs
    .map((run) => {
      if (run.error || !run.samples) return `${run.mode}  ERROR ${run.error ?? 'no samples'}`;
      const s: Sample = run.samples;
      return `${run.mode}  geoMean=${s.geoMean.toFixed(3)} min=${s.geoMin.toFixed(3)} p05=${s.p05.toFixed(3)} p50=${s.p50.toFixed(3)} spread=${s.spread.toFixed(3)} coverage=${(s.coverage * 100).toFixed(0)}%`;
    })
    .join('\n');
  process.stdout.write(`${report}\n`);

  // Persist the AO buffer captures so the occlusion pattern can be inspected
  // directly rather than inferred from statistics.
  const shots = (await page.evaluate(
    () => (window as unknown as { __GTAO_SHOTS: Record<string, string> }).__GTAO_SHOTS,
  )) as Record<string, string>;
  const outDir = new URL('../../qa/gtao-probe/', import.meta.url).pathname;
  await mkdir(outDir, { recursive: true });
  for (const [name, dataUrl] of Object.entries(shots)) {
    const file = `${outDir}${name.replace(/[^a-z0-9-]+/gi, '_')}.png`;
    await writeFile(file, Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'));
    process.stdout.write(`shot: ${file}\n`);
  }
  process.stdout.write(`errors: ${JSON.stringify(errors)}\n`);

  await browser.close();
  await server.close();
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
