import { chromium } from 'playwright';
import { createServer } from 'vite';
import { tmpdir } from 'node:os';

const out = process.env.MATERIAL_QA_DIR ?? tmpdir();
const source = `
import * as THREE from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { toNodeStandard } from '/src/render/props.ts';
import { makeGunMaterials } from '/src/render/weaponGeometry.ts';
const forceWebGL = new URLSearchParams(location.search).has('webgl');
const converted = new URLSearchParams(location.search).has('converted');
const renderer = new WebGPURenderer({ antialias: true, forceWebGL });
await renderer.init();
renderer.setSize(1000, 600);
renderer.setPixelRatio(1);
document.body.style.margin = '0';
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x252932);
const camera = new THREE.OrthographicCamera(-5, 5, 3, -3, 0.1, 30);
camera.position.set(0, 0, 10);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(-3, 4, 6);
scene.add(sun, new THREE.HemisphereLight(0xdbeaff, 0x6c594b, 1));
function texture(kind) {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const u = x / size * Math.PI * 8, v = y / size * Math.PI * 8;
    if (kind === 'normal') {
      const n = new THREE.Vector3(-0.25 * Math.cos(u) * Math.sin(v), -0.25 * Math.sin(u) * Math.cos(v), 1).normalize();
      data[i] = Math.round((n.x * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
    } else if (kind === 'albedo') {
      const checker = ((x >> 3) + (y >> 3)) % 2;
      data[i] = checker ? 180 : 130; data[i + 1] = checker ? 140 : 100; data[i + 2] = checker ? 90 : 65;
    } else {
      const h = Math.round(150 + 60 * Math.sin(u) * Math.sin(v));
      data[i] = data[i + 1] = data[i + 2] = h;
    }
    data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.colorSpace = kind === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
const map = texture('albedo'), roughnessMap = texture('roughness'), normalMap = texture('normal'), bumpMap = texture('bump');
const common = { map, roughnessMap, roughness: 0.8, metalness: 0.05 };
const { polymer, rubber } = makeGunMaterials();
for (const material of [polymer, rubber]) {
  if (material.normalMap !== null || !material.bumpMap || material.bumpMap.colorSpace !== THREE.NoColorSpace || material.bumpScale <= 0 || material.bumpScale > 0.001) throw new Error('Invalid weapon stipple relief');
}
const materials = [
  new THREE.MeshStandardMaterial(common),
  new THREE.MeshStandardMaterial({ ...common, normalMap, normalScale: new THREE.Vector2(0.6, 0.8) }),
  new THREE.MeshStandardMaterial({ ...common, bumpMap, bumpScale: 0.0002 }),
  polymer,
];
const names = ['albedo + rough', 'RGB normal + albedo + rough', 'bump + albedo + rough', 'weapon polymer'];
const draws = [];
for (let col = 0; col < materials.length; col++) {
  const original = materials[col];
  const material = converted ? toNodeStandard(original) : new MeshStandardNodeMaterial().copy(original);
  for (let row = 0; row < 2; row++) {
    const geometry = new THREE.SphereGeometry(0.78, 64, 48);
    const mesh = row === 0 ? new THREE.Mesh(geometry, material) : new THREE.InstancedMesh(geometry, material, 1);
    mesh.position.set(-3.75 + col * 2.5, row === 0 ? 1.2 : -1.2, 0);
    if (row === 1) mesh.setMatrixAt(0, new THREE.Matrix4());
    scene.add(mesh);
    draws.push({ x: 125 + col * 250, y: row === 0 ? 180 : 420, label: names[col] + (row === 0 ? ' mesh' : ' instanced') });
    const label = document.createElement('div');
    label.textContent = names[col] + (row === 0 ? ' / Mesh' : ' / InstancedMesh');
    label.style.cssText = 'position:absolute;color:white;font:12px monospace;left:' + (col * 250 + 8) + 'px;top:' + (row === 0 ? 285 : 525) + 'px';
    document.body.append(label);
  }
}
const heading = document.createElement('div');
heading.textContent = (forceWebGL ? 'WebGL2 forced' : 'WebGPU') + ' / ' + (converted ? 'toNodeStandard' : 'node copy baseline');
heading.style.cssText = 'position:absolute;top:8px;left:8px;color:white;font:16px monospace';
document.body.append(heading);
await renderer.compileAsync(scene, camera);
renderer.render(scene, camera);
const canvas = document.createElement('canvas');
canvas.width = 1000; canvas.height = 600;
const ctx = canvas.getContext('2d');
ctx.drawImage(renderer.domElement, 0, 0);
const metrics = draws.map(({ x, y, label }) => {
  const pixels = ctx.getImageData(x - 30, y - 30, 60, 60).data;
  let sum = 0, black = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const l = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    sum += l; if (l < 5) black++;
  }
  return { label, mean: sum / (pixels.length / 4), blackFraction: black / (pixels.length / 4) };
});
window.__materialQA = { backend: renderer.backend.isWebGPUBackend ? 'WebGPU' : renderer.backend.isWebGLBackend ? 'WebGL2' : 'unknown', metrics,
  polymer: { normalMap: !!polymer.normalMap, bumpMap: !!polymer.bumpMap, bumpScale: polymer.bumpScale, colorSpace: polymer.bumpMap?.colorSpace } };
renderer.setAnimationLoop(() => renderer.render(scene, camera));
`;
const server = await createServer({
  server: { port: 0 }, logLevel: 'error',
  plugins: [{
    name: 'material-qa',
    resolveId(id) { if (id === '/material-qa.js') return '\0material-qa'; },
    load(id) { if (id === '\0material-qa') return source; },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/material-qa') {
          res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script type="module" src="/material-qa.js"></script>');
        } else next();
      });
    },
  }],
});
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-webgpu'] });
try {
  for (const backend of ['webgpu', 'webgl']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    const converted = process.argv.includes('--converted');
    await page.goto(server.resolvedUrls!.local[0] + 'material-qa?' + (backend === 'webgl' ? 'webgl&' : '') + (converted ? 'converted' : ''));
    await page.waitForFunction('window.__materialQA', { timeout: 30000 });
    const result = await page.evaluate('window.__materialQA') as { backend: string; metrics: { label: string; mean: number; blackFraction: number }[]; polymer: object };
    const screenshot = out + '/material-' + backend + (converted ? '-converted' : '-baseline') + '.png';
    await page.screenshot({ path: screenshot });
    console.log(JSON.stringify({ ...result, errorCount: errors.length, errors: [...new Set(errors.map((error) => error.split('\n')[0]))], screenshot }, null, 2));
    if (result.backend !== (backend === 'webgpu' ? 'WebGPU' : 'WebGL2') || errors.length || result.metrics.some((metric) => metric.mean < 20 || metric.blackFraction > 0.01)) process.exitCode = 1;
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
