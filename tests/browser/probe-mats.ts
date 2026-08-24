/**
 * Material dump: lists unique materials (name, color, map) in the live scene.
 * Run: npx tsx tests/browser/probe-mats.ts [map]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const map = process.argv[2] ?? 'oldfront';
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: [] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'ultra', resolutionScale: 1, shadows: true, shadowQuality: 'high',
      postProcessing: true, bloom: true, ao: true, aa: 'smaa',
    }));
  });
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  if (map !== 'neocity') {
    const idx = ['neocity', 'oldfront', 'eden'].indexOf(map) + 1;
    await page.click(`#map-list .map-card:nth-child(${idx})`);
  }
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(6000);
  const dump = await page.evaluate(`(() => {
    const seen = new Map();
    window.__xoState.scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (seen.has(m.uuid)) continue;
        seen.set(m.uuid, {
          name: m.name || '(unnamed)',
          type: m.type,
          color: m.color ? '#' + m.color.getHexString() : null,
          hasMap: !!m.map,
          alphaTest: m.alphaTest ?? 0,
        });
      }
    });
    return JSON.stringify([...seen.values()].filter((m) => /wood|grass|plaster|stone/.test(m.name)));
  })()`);
  console.log(dump);
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
