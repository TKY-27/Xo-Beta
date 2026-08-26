/**
 * Vista: the world beyond the playable boundary plus the visible ground
 * surface itself.
 *
 * - A single displaced terrain mesh covers both the in-bounds area (matching
 *   the physics heightfield exactly) and a wide skirt beyond the boundary
 *   that continues rolling hills, ridges and shorelines outward so the
 *   player never sees an obvious map cutoff or void.
 * - Per-map distant silhouettes (city skyline / hedgerows and towers /
 *   forested ridge) sit near the horizon inside the fog.
 * - BoundaryBarrier reveals the invisible play-area wall as a subtle
 *   translucent red shimmer only when the viewer comes close to it.
 */

import * as THREE from 'three';
import type { MapDef } from '../world/types';
import type { MaterialLibrary } from './materials';
import { peekTextureSet } from '../assets/assets';

const SEG = 150;

function hash2(x: number, z: number): number {
  return Math.sin(x * 127.1 + z * 311.7) * 43758.5453 % 1;
}

function smoothNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}

/** Multi-octave value noise in roughly [-1, 1]. */
function fbm(x: number, z: number): number {
  return (
    smoothNoise(x, z) * 0.55 +
    smoothNoise(x * 2.13 + 7.7, z * 2.13 - 3.1) * 0.28 +
    smoothNoise(x * 4.7 - 11.3, z * 4.7 + 5.9) * 0.17
  ) * 2 - 1;
}

interface Palette {
  grass: number;
  grassFar: number;
  rock: number;
  sand: number;
  bed: number;
  rise: number;
}

const PALETTES: Record<string, Palette> = {
  eden: { grass: 0x55703c, grassFar: 0x5a7a48, rock: 0x808873, sand: 0xb8a877, bed: 0x4a4438, rise: 15 },
  oldfront: { grass: 0x77804b, grassFar: 0x5d6540, rock: 0x7a756b, sand: 0xa89a72, bed: 0x585141, rise: 12 },
};

export interface VistaHandle {
  group: THREE.Group;
  update: (viewPos: THREE.Vector3, time: number) => void;
  dispose: () => void;
}

class BoundaryBarrier {
  readonly group = new THREE.Group();
  private mats: THREE.LineBasicMaterial[] = [];
  private meshes: THREE.LineSegments[] = [];
  private half: number;

  constructor(size: number) {
    this.half = size / 2;
    // Low energy-fence height: must never tower over the map or cover the
    // sky from inside (a full-height wall reads as a giant dark slab even
    // at low opacity). 12 m reads as a boundary fence at character scale.
    const wallY = 6;
    const wallH = 12;
    const linePositions: number[] = [];
    for (let x = -size / 2; x <= size / 2 + 0.01; x += 10) {
      linePositions.push(x, -wallH / 2, 0, x, wallH / 2, 0);
    }
    for (let y = -wallH / 2; y <= wallH / 2 + 0.01; y += 4) {
      linePositions.push(-size / 2, y, 0, size / 2, y, 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.LineBasicMaterial({
        color: 0xff4038,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      this.mats.push(mat);
      const mesh = new THREE.LineSegments(geo, mat);
      mesh.position.y = wallY;
      mesh.renderOrder = 30;
      mesh.visible = false;
      if (i < 2) {
        mesh.rotation.y = i === 0 ? Math.PI : 0;
        mesh.position.z = i === 0 ? this.half - 3 : -(this.half - 3);
      } else {
        mesh.rotation.y = i === 2 ? -Math.PI / 2 : Math.PI / 2;
        mesh.position.x = i === 2 ? this.half - 3 : -(this.half - 3);
      }
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Reveal each wall as the viewer approaches it; invisible otherwise. */
  update(viewPos: THREE.Vector3, time: number): void {
    const half = this.half;
    const walls: Array<[number, number]> = [
      [half - viewPos.z, 0],
      [viewPos.z + half, 1],
      [half - viewPos.x, 2],
      [viewPos.x + half, 3],
    ];
    for (const [dist, idx] of walls) {
      const mat = this.mats[idx]!;
      const near = 22;
      let target = dist < near ? Math.min(0.08, ((near - dist) / near) * 0.11) : 0;
      target *= 0.92 + 0.08 * Math.sin(time * 2.6 + idx);
      mat.opacity += (target - mat.opacity) * 0.18;
      // Hard visibility gate: an invisible-but-rendered transparent plane
      // still costs a draw call and can interact with post processing.
      this.meshes[idx]!.visible = mat.opacity > 0.004;
    }
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    this.meshes[0]?.geometry.dispose();
  }
}

function buildSkyline(size: number): THREE.Group {
  const group = new THREE.Group();
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 124; y += 8) {
    for (let x = 4; x < 60; x += 10) {
      if (Math.random() > 0.42) {
        // Mix warm residential windows into the cool office glow so distant
        // blocks read as lived-in city rather than a uniform cyan wall.
        ctx.fillStyle = Math.random() < 0.3 ? '#ffd9a0' : Math.random() < 0.5 ? '#9fdcff' : '#cfe0ee';
        ctx.fillRect(x + (Math.random() * 3 | 0), y, 4, 5);
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({
    color: 0x24303d,
    emissive: 0xbfe6ff,
    emissiveMap: tex,
    emissiveIntensity: 1.35,
    roughness: 0.9,
    metalness: 0,
  });
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  // Fewer towers with wider angular gaps: the old dense ring read as a solid
  // black shadow wall against the dusk gradient instead of a distant skyline.
  const count = 46;
  const inst = new THREE.InstancedMesh(box, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const e = new THREE.Euler();
  const half = size / 2;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + Math.random() * 0.18;
    const r = half + 90 + Math.random() * 340;
    p.set(Math.cos(ang) * r, -2, Math.sin(ang) * r);
    const h = 34 + Math.random() * Math.random() * 120;
    s.set(22 + Math.random() * 30, h, 22 + Math.random() * 30);
    e.set(0, Math.random() * Math.PI, 0);
    q.setFromEuler(e);
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  }
  inst.frustumCulled = false;
  group.add(inst);
  return group;
}

function buildRuralHorizon(size: number): THREE.Group {
  const group = new THREE.Group();
  // Distant treelines + village silhouettes.
  const treeGeo = mergeTreeGeo();
  const mat = new THREE.MeshStandardMaterial({ color: 0x39452c, roughness: 1, metalness: 0 });
  const count = 130;
  const inst = new THREE.InstancedMesh(treeGeo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const half = size / 2;
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = half + 40 + Math.random() * 300;
    p.set(Math.cos(ang) * r, -1 + fbm(p.x * 0.01, p.z * 0.01) * 3, Math.sin(ang) * r);
    const sc = 0.8 + Math.random() * 1.7;
    s.set(sc, sc * (0.85 + Math.random() * 0.5), sc);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  }
  inst.frustumCulled = false;
  group.add(inst);

  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6b675e, roughness: 0.95 });
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2 + 0.35;
    const r = half + 130 + (i % 3) * 90;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(14, 34 + (i % 3) * 12, 14), stoneMat);
    tower.position.set(Math.cos(ang) * r, 12, Math.sin(ang) * r);
    tower.rotation.y = ang;
    group.add(tower);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(8, 26, 8), stoneMat);
    spire.position.set(tower.position.x, tower.position.y + 28, tower.position.z);
    group.add(spire);
  }
  return group;
}

function mergeTreeGeo(): THREE.BufferGeometry {
  // Cheap two-part blob: trunk cylinder + canopy cone, merged once.
  const trunk = new THREE.CylinderGeometry(0.5, 0.7, 4, 5);
  trunk.translate(0, 2, 0);
  const canopy = new THREE.ConeGeometry(2.6, 7, 6);
  canopy.translate(0, 7, 0);
  // Manual merge without importing BufferGeometryUtils here.
  const tp = trunk.attributes.position!;
  const cp = canopy.attributes.position!;
  const tn = trunk.attributes.normal!;
  const cn = canopy.attributes.normal!;
  const posCount = tp.count + cp.count;
  const positions = new Float32Array(posCount * 3);
  const normals = new Float32Array(posCount * 3);
  positions.set(tp.array as Float32Array, 0);
  positions.set(cp.array as Float32Array, tp.count * 3);
  normals.set(tn.array as Float32Array, 0);
  normals.set(cn.array as Float32Array, tp.count * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  trunk.dispose();
  canopy.dispose();
  return geo;
}

/** Irregular hill/peak silhouette — kills the obvious "perfect pyramid" read. */
function jaggedCone(seg: number, rings: number, seed: number): THREE.ConeGeometry {
  const g = new THREE.ConeGeometry(1, 1, seg, rings);
  g.translate(0, 0.5, 0);
  const pos = g.attributes.position as THREE.BufferAttribute | undefined;
  if (!pos) return g;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) ?? 0;
    const y = pos.getY(i) ?? 0;
    const z = pos.getZ(i) ?? 0;
    const rad = Math.hypot(x, z);
    if (rad < 1e-4) continue;
    const ang = Math.atan2(z, x);
    const n = Math.sin(ang * 3.1 + seed * 12.9) * 0.5 + Math.sin(ang * 7.7 - seed * 4.2) * 0.5;
    const k = 1 + n * 0.24 * (1 - y * 0.35);
    pos.setX(i, x * k);
    pos.setZ(i, z * k);
    pos.setY(i, y * (1 + Math.sin(ang * 5.3 + seed) * 0.06));
  }
  g.computeVertexNormals();
  return g;
}

function buildEdenRidge(size: number, fogColor = 0xbfd6e4): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x46543a, roughness: 1, metalness: 0 });
  // Hazy blue-gray, close to fog color so far peaks blend instead of glowing.
  // Unlit (MeshBasicMaterial): sun-facing slopes can never clip to white, and
  // exponential fog does the aerial-perspective blending toward the sky.
  const fogC = new THREE.Color(fogColor);
  const hillGeos = [jaggedCone(18, 4, 1), jaggedCone(18, 4, 2), jaggedCone(20, 4, 3)];
  const count = 38;
  const perGeo = Math.ceil(count / hillGeos.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const half = size / 2;
  let placed = 0;
  for (const geo of hillGeos) {
    const inst = new THREE.InstancedMesh(geo, mat, perGeo);
    let n = 0;
    for (let i = 0; i < perGeo && placed < count; i++, placed++, n++) {
      const ang = Math.random() * Math.PI * 2;
      const r = half + 170 + Math.random() * 300;
      const hill = 16 + Math.random() * 24;
      p.set(Math.cos(ang) * r, -3, Math.sin(ang) * r);
      s.set(hill * (1.5 + Math.random()), hill, hill * (1.5 + Math.random()));
      e.set(0, Math.random() * Math.PI * 2, 0);
      q.setFromEuler(e);
      m.compose(p, q, s);
      inst.setMatrixAt(i, m);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    group.add(inst);
  }

  const peakGeo = jaggedCone(20, 5, 7);
  const peakGeo2 = jaggedCone(18, 5, 13);
  // Peaks converge toward the horizon-sky tone (not the bright ground fog)
  // so they read as hazy mountains instead of white paper cutouts.
  const skyHaze = new THREE.Color(0x7f9cc0);
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + 0.2;
    const r = half + 400 + Math.random() * 260;
    // Per-peak tint variation so the range doesn't read as one flat wall.
    const peakMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x5c6b76).lerp(skyHaze, 0.5 + Math.random() * 0.14),
      fog: false,
    });
    const peak = new THREE.Mesh(i % 2 === 0 ? peakGeo : peakGeo2, peakMat);
    const h = 70 + Math.random() * 60;
    peak.scale.set(h * 1.9, h, h * 1.9);
    peak.rotation.y = Math.random() * Math.PI * 2;
    peak.position.set(Math.cos(ang) * r, -6, Math.sin(ang) * r);
    group.add(peak);
  }

  // Near foothill band: low wide ridges that break the horizon before the
  // far peaks, reading as forested hills rather than floating triangles.
  const footGeo = jaggedCone(18, 4, 11);
  const footMat = new THREE.MeshBasicMaterial({
    color: fogC.clone().lerp(new THREE.Color(0x5f7261), 0.6),
    fog: true,
  });
  for (let i = 0; i < 14; i++) {
    const ang = (i / 14) * Math.PI * 2 + 0.45;
    const r = half + 240 + Math.random() * 220;
    const foot = new THREE.Mesh(footGeo, footMat);
    const h = 26 + Math.random() * 38;
    foot.scale.set(h * 2.6, h, h * 2.6);
    foot.rotation.y = Math.random() * Math.PI * 2;
    foot.position.set(Math.cos(ang) * r, -4, Math.sin(ang) * r);
    group.add(foot);
  }

  // Extended lake continuation eastward past the boundary.
  const lake = new THREE.Mesh(
    new THREE.CircleGeometry(190, 36),
    new THREE.MeshStandardMaterial({ color: 0x2e5a6e, roughness: 0.25, metalness: 0.1 }),
  );
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(half + 150, -1.6, 40);
  group.add(lake);
  return group;
}

/**
 * One terrain mesh covering the playable area (exact heightfield match)
 * plus a wide skirt continuing the landscape beyond the boundary.
 */
function buildTerrain(def: MapDef, grassTex?: THREE.Texture | null): { mesh: THREE.Mesh; dispose: () => void } | null {
  const sample = def.terrainHeight ?? null;
  const isCity = def.id === 'neocity';
  const pal = PALETTES[def.id] ?? PALETTES['eden']!;
  const span = def.size * 3.2;
  const half = def.size / 2;
  const geo = new THREE.PlaneGeometry(span, span, isCity ? 24 : SEG, isCity ? 24 : SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  // With a real albedo texture the vertex layer becomes a near-white
  // multiplier (the texture carries hue); without it the palette colors
  // carry the look on their own.
  const texMode = !!grassTex;
  const cGrass = new THREE.Color(texMode ? 0xf4f6ec : pal.grass);
  // Far/skirt tints must stay clearly green even under the warm sun — the
  // raw grass albedo reads as tan dunes at distance otherwise.
  const cGrassFar = new THREE.Color(texMode ? 0xa8bd9a : pal.grassFar);
  const cRock = new THREE.Color(texMode ? 0x99a294 : pal.rock);
  const cSand = new THREE.Color(texMode ? 0xe4d9b4 : pal.sand);
  const cBed = new THREE.Color(texMode ? 0x5c6a5f : pal.bed);
  const cAsphalt = new THREE.Color(0x23262b);
  const cDry = new THREE.Color(texMode ? 0xd6cda6 : 0x9a9160);
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)!;
    const z = pos.getZ(i)!;
    let h = 0;
    if (!isCity) {
      const outside = Math.max(Math.abs(x), Math.abs(z)) - half;
      if (outside <= 0 || !sample) {
        h = sample ? sample(x, z) : 0;
      } else {
        // Continue from the edge height outward into rising hills. Keep a
        // ~50 m natural run-out of meadow before hills climb, so the playable
        // boundary doesn't sit against a sudden wall of terrain.
        const edgeH = sample(Math.min(half - 1, Math.max(-half + 1, x)), Math.min(half - 1, Math.max(-half + 1, z)));
        const t = Math.min(1, Math.max(0, outside - 50) / 240);
        const rise = smoothstep(t) * (pal.rise * (0.35 + 0.65 * (fbm(x * 0.004 + 31, z * 0.004 - 17) * 0.5 + 0.5)));
        const roll = fbm(x * 0.008, z * 0.008) * 4 * t;
        h = edgeH * (1 - smoothstep(Math.min(1, outside / 90))) + rise + roll;
      }
    } else {
      // City outskirts: flat sprawl with a gentle dip so streets sit above.
      h = -0.6;
    }
    pos.setY(i, h);

    // Vertex color by context.
    if (isCity) {
      tmp.copy(cAsphalt);
    } else {
      const slope = Math.abs(fbm(x * 0.02, z * 0.02)); // cheap variation proxy
      tmp.copy(cGrass).lerp(cGrassFar, Math.min(1, Math.max(0, (Math.max(Math.abs(x), Math.abs(z)) - half - 40) / 220)));
      if (h > pal.rise * 0.92) tmp.lerp(cRock, Math.min(1, (h - pal.rise * 0.92) / 12));
      // Inside-bounds meadow variation: large soft patches of drier/ greener
      // grass so open fields don't read as one flat color. Kept subtle when
      // a texture is present (the albedo already provides detail).
      const patch = fbm(x * 0.013 + 40.7, z * 0.013 - 17.3);
      const patch2 = fbm(x * 0.045 - 9.1, z * 0.045 + 23.8);
      const varAmt = texMode ? 0.4 : 1;
      tmp.offsetHSL(
        patch2 * 0.014 * varAmt,
        patch * 0.05 * varAmt,
        (patch * 0.035 + patch2 * 0.02) * varAmt,
      );
      tmp.offsetHSL(0, 0, slope * 0.012 * varAmt);
      // Large dry/tan swaths (worn grazing land) so big meadows never read
      // as one uniform toy-green lawn.
      const dry = Math.max(0, fbm(x * 0.006 + 71.3, z * 0.006 + 3.9) - 0.15) * 1.7;
      tmp.lerp(cDry, Math.min(0.5, dry));
      // Water shading: beds + sandy shores around registered volumes.
      for (const w of def.water) {
        const pad = 9;
        if (x > w.minX - pad && x < w.maxX + pad && z > w.minZ - pad && z < w.maxZ + pad) {
          const inside = x >= w.minX && x <= w.maxX && z <= w.maxZ && z >= w.minZ;
          if (inside && h < w.surfaceY - 0.35) tmp.copy(cBed);
          else if (h < w.surfaceY + 0.4) tmp.copy(cSand);
          break;
        }
      }
    }
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // Base surface: CC0 ambientCG grass albedo, UV-tiled (~5 m per tile) so the
  // huge terrain never shows stretching. Albedo only — the projected PBR
  // normal map reads as shiny swirls at terrain grazing angles. Vertex colors
  // keep the large-scale meadow/rock/sand variation on top.
  let map: THREE.Texture | null = null;
  if (grassTex) {
    map = grassTex.clone();
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(span / 5, span / 5);
    map.needsUpdate = true;
  }
  const mat = new THREE.MeshStandardMaterial({
    map: map ?? undefined,
    vertexColors: true,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh,
    dispose: () => {
      geo.dispose();
      map?.dispose();
      mat.dispose();
    },
  };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export function buildVista(def: MapDef, mats?: MaterialLibrary): VistaHandle {
  const group = new THREE.Group();
  const disposables: Array<() => void> = [];

  const grassSet = mats ? peekTextureSet('grass') : null;
  const terrain = buildTerrain(def, grassSet?.color ?? null);
  if (terrain) {
    group.add(terrain.mesh);
    disposables.push(terrain.dispose);
  }

  if (def.id === 'neocity') {
    const skyline = buildSkyline(def.size);
    group.add(skyline);
    disposables.push(() => skyline.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }));
  } else if (def.id === 'oldfront') {
    const rural = buildRuralHorizon(def.size);
    group.add(rural);
    disposables.push(() => rural.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }));
  } else {
    const ridge = buildEdenRidge(def.size, def.sky.fogColor);
    group.add(ridge);
    disposables.push(() => ridge.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }));
  }

  const barrier = new BoundaryBarrier(def.size);
  group.add(barrier.group);
  disposables.push(() => barrier.dispose());

  return {
    group,
    update: (viewPos, time) => barrier.update(viewPos, time),
    dispose: () => {
      for (const d of disposables) d();
    },
  };
}
