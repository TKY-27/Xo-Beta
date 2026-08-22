/**
 * Procedural PBR material library. All textures are generated at runtime on
 * canvases (original work, no external assets). Small sizes keep GPU memory
 * and load time low while retaining believable surface detail.
 */

import * as THREE from 'three';
import type { MatKey } from '../world/types';

/** All canvas textures hold sRGB pixel data. */
function finalize(tex: THREE.CanvasTexture): THREE.CanvasTexture {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeCanvas(size = 256): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  return [canvas, ctx];
}

function noiseTexture(size: number, base: string, variance: number, scale = 1): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * variance;
    d[i] = Math.max(0, Math.min(255, d[i]! + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(scale, scale);
  return tex;
}

function brickTexture(size: number, mortar: string, brickA: string, brickB: string, rows: number): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = mortar;
  ctx.fillRect(0, 0, size, size);
  const bh = size / rows;
  const bw = size / (rows / 2);
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 === 0 ? 0 : bw / 2;
    for (let c = -1; c < rows / 2 + 1; c++) {
      ctx.fillStyle = (r + c) % 3 === 0 ? brickB : brickA;
      ctx.fillRect(c * bw + offset + 2, r * bh + 2, bw - 4, bh - 4);
    }
  }
  // grime
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    d[i] = Math.max(0, Math.min(255, d[i]! + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function panelTexture(size: number, base: string, line: string, panels: number): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = line;
  ctx.lineWidth = 3;
  const step = size / panels;
  for (let i = 0; i <= panels; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] = Math.max(0, Math.min(255, d[i]! + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export interface MaterialLibrary {
  get(key: MatKey): THREE.Material;
  dispose(): void;
}

export function createMaterials(): MaterialLibrary {
  const std = (
    color: number,
    roughness: number,
    metalness: number,
    map?: THREE.Texture,
    extra?: Partial<THREE.MeshStandardMaterialParameters>,
  ): THREE.MeshStandardMaterial => {
    const params: THREE.MeshStandardMaterialParameters = { color, roughness, metalness };
    if (map) params.map = map;
    if (extra) Object.assign(params, extra);
    return new THREE.MeshStandardMaterial(params);
  };

  const mats = new Map<MatKey, THREE.Material>();
  const set = (k: MatKey, m: THREE.Material) => mats.set(k, m);

  set('concrete', std(0x8f9296, 0.92, 0.02, noiseTexture(256, '#8f9296', 30)));
  set('concreteDark', std(0x74777c, 0.93, 0.03, noiseTexture(256, '#6f7278', 26)));
  set('asphalt', std(0x6a6e75, 0.94, 0.03, noiseTexture(256, '#60646b', 20)));
  set('sidewalk', std(0x777a7d, 0.93, 0.02, panelTexture(256, '#777a7d', '#5f6265', 4)));
  set('metal', std(0x9aa4ad, 0.42, 0.85, panelTexture(256, '#9aa4ad', '#78828b', 3)));
  set('metalDark', std(0x59636d, 0.48, 0.8, panelTexture(256, '#525c66', '#3d454e', 3)));
  set('rust', std(0x7a4a30, 0.86, 0.35, noiseTexture(256, '#7a4a30', 40)));
  set('wood', std(0xa07848, 0.85, 0.02, noiseTexture(256, '#a07848', 24)));
  set('woodDark', std(0x5f4630, 0.88, 0.02, noiseTexture(256, '#5f4630', 22)));
  set('stoneBrick', std(0xffffff, 0.95, 0.01, brickTexture(256, '#57544e', '#8d897f', '#7b776d', 8)));
  set('plaster', std(0xcfc8ba, 0.9, 0.01, noiseTexture(256, '#cfc8ba', 20)));
  set('plasterOld', std(0xb0a48c, 0.94, 0.01, noiseTexture(256, '#b0a48c', 32)));
  set('glass', new THREE.MeshPhysicalMaterial({
    color: 0x9fc8dd, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.32,
    transmission: 0.6, thickness: 0.2,
  }));
  set('grass', std(0x5d7a43, 0.98, 0, noiseTexture(256, '#5d7a43', 34)));
  set('dirt', std(0x6e5a41, 0.97, 0, noiseTexture(256, '#6e5a41', 30)));
  set('rock', std(0x76736c, 0.95, 0.02, noiseTexture(256, '#76736c', 38)));
  set('roofTile', std(0x8a4a3a, 0.9, 0.05, panelTexture(256, '#8a4a3a', '#63352a', 6)));
  set('gold', std(0xd8b45a, 0.35, 0.9));
  set('marble', std(0xd9d6cf, 0.4, 0.04, noiseTexture(256, '#d9d6cf', 12)));
  set('sandbag', std(0x9c8b62, 0.98, 0, noiseTexture(256, '#9c8b62', 26)));
  set('facadeA', std(0x66788a, 0.72, 0.22, panelTexture(256, '#5d7080', '#48586a', 4)));
  set('facadeB', std(0x767088, 0.74, 0.2, panelTexture(256, '#6e6880', '#575064', 4)));
  set('facadeC', std(0x5a6a76, 0.7, 0.25, panelTexture(256, '#54646e', '#414e58', 4)));

  // Neon emissives
  const neon = (color: number, intensity: number) =>
    new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.1,
    });
  set('neonCyan', neon(0x53e0ff, 2.6));
  set('neonMagenta', neon(0xff53c8, 2.6));
  set('neonOrange', neon(0xff9040, 2.4));
  set('neonGreen', neon(0x54ff9f, 2.6));
  set('neonBlue', neon(0x5f8cff, 2.6));

  return {
    get(key: MatKey): THREE.Material {
      return mats.get(key) ?? mats.get('concrete')!;
    },
    dispose() {
      for (const m of mats.values()) m.dispose();
      mats.clear();
    },
  };
}
