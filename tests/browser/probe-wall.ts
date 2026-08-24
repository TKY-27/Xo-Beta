/**
 * Wall identify: teleports to a spot, raycasts a screen point, dumps the hit
 * material. Run: npx tsx tests/browser/probe-wall.ts [map] [x] [z] [yaw] [ndx] [ndy]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const map = process.argv[2] ?? 'oldfront';
  const x = Number(process.argv[3] ?? 90);
  const z = Number(process.argv[4] ?? 190);
  const yaw = Number(process.argv[5] ?? 0);
  const ndx = Number(process.argv[6] ?? -0.5);
  const ndy = Number(process.argv[7] ?? -0.1);
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
  const evalSoft = async <T>(expr: string, ms = 6000): Promise<T | null> =>
    Promise.race([page.evaluate(expr) as Promise<T>, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  for (let i = 0; i < 120; i++) {
    const ph = await evalSoft<string>('window.__xoState ? window.__xoState.phase : "?"');
    if (ph === 'live') break;
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(1500);
  await page.evaluate(`window.__xoTeleport(${x}, ${z}, ${yaw})`);
  await page.waitForTimeout(1200);
  const hit = await evalSoft<string>(`(() => {
    const st = window.__xoState;
    const THREE = st.THREE;
    const cam = st.camera;
    if (!cam) return 'no camera';
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(${ndx}, ${ndy}), cam);
    const hits = ray.intersectObjects(st.scene.children, true);
    if (!hits.length) return 'no hit';
    const h = hits[0];
    const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
    return JSON.stringify({
      dist: Math.round(h.distance * 10) / 10,
      mat: m.name || '(unnamed)', type: m.type,
      color: m.color ? '#' + m.color.getHexString() : null,
      isInstanced: !!h.object.isInstancedMesh,
      point: [h.point.x, h.point.y, h.point.z].map((v) => Math.round(v)),
    });
  })()`);
  console.log('hit:', hit);
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
