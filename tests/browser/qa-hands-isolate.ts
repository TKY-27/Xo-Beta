/**
 * Fast hands/viewmodel snapshot runner (pairs with qa-hands-isolate.html):
 * renders the real ViewModel updateView path at gameplay framing for each
 * weapon class and writes qa/hands-isolate/<w><suffix>.png in seconds.
 *
 * Usage: npx tsx tests/browser/qa-hands-isolate.ts   (env: QA_WEAPONS, QA_ADS,
 * QA_ZOOM, QA_OUT suffix, HEADLESS=1)
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const weapons = (process.env.QA_WEAPONS ?? 'ar,shotgun,pistol,smg,sniper').split(',').filter(Boolean);
const ads = process.env.QA_ADS === '1' ? '1' : '0';
const zoom = process.env.QA_ZOOM ?? '0';
const aim = process.env.QA_AIM ?? 'grip';
const suffix = process.env.QA_OUT ?? '';
const OUT = 'qa/hands-isolate';
mkdirSync(OUT, { recursive: true });

const server = await createVite();
await server.listen();

async function createVite(): Promise<import('vite').ViteDevServer> {
  const { createServer } = await import('vite');
  return createServer({ server: { port: 5198 }, logLevel: 'silent' });
}

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADLESS === '1' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || process.env.QA_DUMP === '1') console.log(`browser console: ${msg.text()}`);
  if (msg.type() === 'error') {
    const location = msg.location();
    errors.push(`${msg.text().split('\n')[0]!.slice(0, 170)} @ ${location.url}:${location.lineNumber}`);
  }
});
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});
page.on('requestfailed', (request) => {
  errors.push(`requestfailed ${request.url()} ${request.failure()?.errorText ?? ''}`);
});
page.on('pageerror', (err) => errors.push(String(err)));

for (const w of weapons) {
  await page.goto(`http://localhost:5198/tests/browser/qa-hands-isolate.html?w=${w}&ads=${ads}&zoom=${zoom}&aim=${aim}&gizmo=${process.env.QA_GIZMO ?? '0'}&hideSleeves=${process.env.QA_HIDE_SLEEVE ?? '0'}&hideHands=${process.env.QA_HIDE_HANDS ?? '0'}&hideViewmodel=${process.env.QA_HIDE_VIEWMODEL ?? '0'}&hideWeapon=${process.env.QA_HIDE_WEAPON ?? '0'}&action=${encodeURIComponent(process.env.QA_ACTION ?? '')}&phase=${encodeURIComponent(process.env.QA_PHASE ?? '')}&empty=${process.env.QA_EMPTY ?? '0'}&onlyMesh=${encodeURIComponent(process.env.QA_ONLY_MESH ?? '')}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  const authoredAssetsLoaded = await page.evaluate(() => (window as unknown as { __xoQaAuthoredAssetsLoaded?: boolean }).__xoQaAuthoredAssetsLoaded === true);
  if (!authoredAssetsLoaded) throw new Error(`${w}: authored assets were not preloaded`);
  await page.waitForTimeout(Number(process.env.QA_WAIT_MS ?? '1800'));
  await page.screenshot({ path: `${OUT}/${w}${suffix}.png` });
  console.log(`captured ${OUT}/${w}${suffix}.png`);
  if (process.env.QA_DUMP === '1') {
    const dump = await page.evaluate(`(() => {
      const vm = window.__vm;
      const rig = vm.rigs.get([...vm.rigs.keys()][0]);
      const model = vm.currentModel;
      vm.pivot.updateMatrixWorld(true);
      const V = model.gripR.constructor;
       const p = (o) => { const v = new V(); o.getWorldPosition(v); return v.toArray().map((n) => +n.toFixed(4)); };
       const screen = (o) => { const v = new V(); o.getWorldPosition(v); v.project(window.__camera); return [Math.round((v.x + 1) * 640), Math.round((1 - v.y) * 360), +v.z.toFixed(3)]; };
        const materials = [];
        const semantic = [];
        model.group.traverse((object) => {
          if (!object.name || !/(trigger|mag|muzzle|bolt|pump|grip)/i.test(object.name)) return;
          object.geometry?.computeBoundingBox?.();
          const b = object.geometry?.boundingBox;
          const out = { name: object.name, local: object.position.toArray().map((n) => +n.toFixed(4)), world: p(object), bounds: b ? [b.min.toArray().map((n) => +n.toFixed(4)), b.max.toArray().map((n) => +n.toFixed(4))] : null };
          semantic.push(out);
        });
       model.group.traverse((object) => {
         if (!object.isMesh) return;
         const list = Array.isArray(object.material) ? object.material : [object.material];
         for (const material of list) materials.push({
           name: material.name,
           type: material.type,
           color: material.color?.getHexString?.() ?? null,
           roughness: material.roughness ?? null,
           metalness: material.metalness ?? null,
           map: Boolean(material.map),
         });
       });
         const modelBoundsMin = [Infinity, Infinity, Infinity];
         const modelBoundsMax = [-Infinity, -Infinity, -Infinity];
           const modelMeshes = [];
           model.group.traverse((object) => {
             if (!object.isMesh || !object.visible) return;
             object.geometry.computeBoundingBox();
             const box = object.geometry.boundingBox;
             if (!box) return;
             const min = [Infinity, Infinity, Infinity];
             const max = [-Infinity, -Infinity, -Infinity];
             for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
               const point = new V(x, y, z).applyMatrix4(object.matrixWorld);
               min[0] = Math.min(min[0], point.x); min[1] = Math.min(min[1], point.y); min[2] = Math.min(min[2], point.z);
               max[0] = Math.max(max[0], point.x); max[1] = Math.max(max[1], point.y); max[2] = Math.max(max[2], point.z);
               modelBoundsMin[0] = Math.min(modelBoundsMin[0], point.x); modelBoundsMin[1] = Math.min(modelBoundsMin[1], point.y); modelBoundsMin[2] = Math.min(modelBoundsMin[2], point.z);
               modelBoundsMax[0] = Math.max(modelBoundsMax[0], point.x); modelBoundsMax[1] = Math.max(modelBoundsMax[1], point.y); modelBoundsMax[2] = Math.max(modelBoundsMax[2], point.z);
             }
             modelMeshes.push({ name: object.name, min: min.map((n) => +n.toFixed(3)), max: max.map((n) => +n.toFixed(3)) });
           });
         const sleeves = [];
         vm.armSolver.group.traverse((object) => {
          if (!object.isMesh || !object.name.startsWith('authored-sleeve')) return;
          const end = object.localToWorld(new V(0, object.name.includes('fore') ? 0.219375 : 0.3, 0));
           sleeves.push({ name: object.name, position: p(object), end: end.toArray().map((n) => +n.toFixed(4)), endScreen: (() => { const v = end.clone().project(window.__camera); return [Math.round((v.x + 1) * 640), Math.round((1 - v.y) * 360), +v.z.toFixed(3)]; })(), scale: object.scale.toArray() });
         });
             const armDebug = { children: vm.armSolver.group.children.map((object) => ({ name: object.name, type: object.type, visible: object.visible })), authored: vm.armSolver.authoredSleeves?.length ?? null, integrated: vm.armSolver.integratedArm };
             const armMeshes = [];
             vm.armSolver.group.traverse((object) => {
               if (!object.isMesh) return;
               object.geometry.computeBoundingBox();
               const box = object.geometry.boundingBox;
               if (!box) return;
               const min = [Infinity, Infinity, Infinity];
               const max = [-Infinity, -Infinity, -Infinity];
               for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
                 const point = new V(x, y, z).applyMatrix4(object.matrixWorld);
                 for (let axis = 0; axis < 3; axis += 1) {
                   min[axis] = Math.min(min[axis], point.getComponent(axis));
                   max[axis] = Math.max(max[axis], point.getComponent(axis));
                 }
               }
               armMeshes.push({ name: object.name, position: p(object), scale: object.scale.toArray(), min: min.map((n) => +n.toFixed(3)), max: max.map((n) => +n.toFixed(3)), material: Array.isArray(object.material) ? object.material[0]?.name ?? null : object.material.name });
             });
           const timeline = { presentBoltElapsed: vm.presentBoltElapsed ?? null, presentBoltTotal: vm.presentBoltTotal ?? null, presentReloadElapsed: vm.presentReloadElapsed ?? null, presentReloadTotal: vm.presentReloadTotal ?? null, reloadPhase: vm.presentationReloadPhase ?? null };
          return JSON.stringify({
            materials,
            semantic,
            modelMeshes,
           sleeves,
               armDebug,
               armMeshes,
              timeline,
           rightWorld: p(rig.right),
          leftWorld: p(rig.left),
          rightScreen: screen(rig.right),
          leftScreen: screen(rig.left),
         rightLocal: rig.right.position.toArray().map((n) => +n.toFixed(4)),
         leftLocal: rig.left.position.toArray().map((n) => +n.toFixed(4)),
         gripR: model.gripR.toArray(),
         gripL: model.gripL.toArray(),
           viewScale: model.group.scale.x,
           modelVisible: model.group.visible,
           modelPos: p(model.group),
           modelRot: model.group.rotation.toArray().slice(0, 3).map((n) => +n.toFixed(4)),
           modelScale: model.group.scale.toArray().map((n) => +n.toFixed(4)),
           pivotRot: vm.pivot.rotation.toArray().slice(0, 3).map((n) => +n.toFixed(4)),
           cameraPos: window.__camera.position.toArray().map((n) => +n.toFixed(4)),
           cameraRot: window.__camera.rotation.toArray().slice(0, 3).map((n) => +n.toFixed(4)),
           modelBoundsMin: modelBoundsMin.map((n) => +n.toFixed(4)),
          modelBoundsMax: modelBoundsMax.map((n) => +n.toFixed(4)),
          pivotPos: vm.pivot.position.toArray().map((n) => +n.toFixed(4)),
       });
    })()`);
    console.log(`DUMP ${w}: ${dump}`);
  }
}

await browser.close();
await server.close();
if (errors.length > 0) {
  console.log(JSON.stringify({ errors }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ ok: true, count: weapons.length }));
}
