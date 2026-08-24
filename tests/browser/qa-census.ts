/**
 * Scene census: counts meshes/draws by top-level group + material to find
 * draw-call hotspots. Run: npx tsx tests/browser/qa-census.ts [map]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const map = process.argv[2] ?? 'neocity';
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.error('pageerror:', e.message.slice(0, 120)));
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'ultra', resolutionScale: 1, shadows: true, shadowQuality: 'high',
      postProcessing: true, bloom: true, ao: true, aa: 'smaa',
    }));
  });
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(400);
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
  await page.waitForTimeout(2000);

  const census = await page.evaluate(`(() => {
    const scene = window.__xoState.scene;
    const world = window.__xoState.worldGroup;
    const countTree = (root) => {
      let meshes = 0, instanced = 0, skinned = 0, lights = 0, tris = 0;
      const mats = new Map();
      root.traverse((o) => {
        if (o.isLight) lights++;
        if (!o.isMesh && !o.isPoints && !o.isLine) return;
        meshes++;
        const geo = o.geometry;
        const instMul = o.isInstancedMesh && o.count ? o.count : 1;
        if (geo) {
          const pos = geo.attributes ? geo.attributes.position : null;
          const idx = geo.index ? geo.index.count / 3 : (pos ? pos.count / 3 : 0);
          tris += idx * instMul;
        }
        if (o.isInstancedMesh) instanced++;
        if (o.isSkinnedMesh) skinned++;
        const mk = (o.material && o.material.name ? o.material.name : (o.material && o.material.type) || '?');
        mats.set(mk, (mats.get(mk) ?? 0) + 1);
      });
      return { meshes, instanced, skinned, lights, tris: Math.round(tris), topMats: [...mats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) };
    };
    const out = (world ? world.children : scene.children).map((c) => ({
      name: c.name || c.type,
      kind: c.isMesh ? 'mesh' : c.isInstancedMesh ? 'inst' : 'group',
      ...countTree(c),
    }));
    out.sort((a, b) => (b.tris ?? 0) - (a.tris ?? 0) || b.meshes - a.meshes);
    const others = countTree({ traverse: (cb) => scene.children.filter((c) => c !== world).forEach(cb) });
    return { worldChildren: (world ? world.children.length : 0), groups: out.slice(0, 20), outsideWorld: others };
  })()`);
  console.log(JSON.stringify(census, null, 1));
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
