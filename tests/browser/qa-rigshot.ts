/** One-off: force-render a bot with override material to test visibility. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 200)));
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      postProcessing: false, bloom: false, quality: 'high',
    }));
  });
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(500);
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  // oldfront = daytime
  await page.click('#map-list .map-card:nth-child(2)');
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
  const evalSoft = async <T>(expr: string, ms = 5000): Promise<T | null> =>
    Promise.race([page.evaluate(expr) as Promise<T>, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  for (let i = 0; i < 120; i++) {
    const ph = await evalSoft<string>('window.__xoState ? window.__xoState.phase : "?"');
    if (ph === 'live') break;
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(1500);
  const botRaw = await evalSoft<string>('JSON.stringify(window.__xoState.actors[1])');
  const b = JSON.parse(botRaw ?? '{}') as { x?: number; z?: number };
  const bx = b.x ?? 0;
  const bz = b.z ?? 0;
  await page.evaluate((a: number[]) => {
    (window as unknown as { __xoTeleport?: (x: number, z: number, yw: number) => void }).__xoTeleport?.(a[0] ?? 0, (a[1] ?? 0) + 4, 0);
  }, [bx, bz]);
  await page.waitForTimeout(1200);

  // Apply red override to every skinned mesh material
  const matInfo = await evalSoft<string>(`(() => {
    const w = window;
    const scene = w.__xoState.scene;
    let count = 0; let sample = null;
    scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      count++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { m.color = { r: 1, g: 0, b: 0 }; m.emissive = { r: 1, g: 0, b: 0 }; m.emissiveIntensity = 1; }
      if (!sample) sample = { name: o.name, visible: o.visible, castShadow: o.castShadow, frustumCulled: o.frustumCulled,
        matCount: mats.length, mat0: { name: mats[0]?.name, transparent: mats[0]?.transparent, opacity: mats[0]?.opacity, depthWrite: mats[0]?.depthWrite, side: mats[0]?.side, alphaTest: mats[0]?.alphaTest },
        skeletonBones: o.skeleton?.bones?.length,
        bindMatrixValid: o.bindMatrix ? !isNaN(o.bindMatrix.elements[0]) : null,
        parentChain: (() => { let c = []; let p = o; while (p && c.length < 6) { c.push(p.name || p.type); p = p.parent; } return c; })() };
    });
    return JSON.stringify({ count, sample });
  })()`);
  console.log('override:', matInfo);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'qa/rig-override.png', timeout: 60000 });
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
