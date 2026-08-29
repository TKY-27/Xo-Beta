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
import {
  buildTerrainGridMesh,
  buildTerrainRibbonIndices,
} from '../world/terrainMesh';
import type { TerrainGridMesh } from '../world/types';
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

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
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
  ashara: { grass: 0xb79d72, grassFar: 0x8e795b, rock: 0x786c5e, sand: 0xc7ad7c, bed: 0x75624b, rise: 24 },
};

/**
 * Shared ground contract for the playable terrain skirt and every render-only
 * boundary detail. Keeping these on one sampler prevents hedges, trees, roads
 * and distant structures from floating above the continuation terrain.
 */
export function sampleVistaGroundHeight(def: MapDef, x: number, z: number): number {
  if (def.id === 'neocity') return -0.6;
  const sample = def.terrainHeight ?? null;
  if (!sample) return 0;
  const half = def.size / 2;
  const outside = Math.max(Math.abs(x), Math.abs(z)) - half;
  if (outside <= 0) return sample(x, z);
  const pal = PALETTES[def.id] ?? PALETTES['eden']!;
  const edgeH = sample(
    Math.min(half - 1, Math.max(-half + 1, x)),
    Math.min(half - 1, Math.max(-half + 1, z)),
  );
  const t = Math.min(1, Math.max(0, outside - 50) / 240);
  const rise = smoothstep(t) * (
    pal.rise * (0.35 + 0.65 * (fbm(x * 0.004 + 31, z * 0.004 - 17) * 0.5 + 0.5))
  );
  const roll = fbm(x * 0.008, z * 0.008) * 4 * t;
  return edgeH * (1 - smoothstep(Math.min(1, outside / 90))) + rise + roll;
}

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
  const random = seededRandom(0x4e454f33);
  const windowTextures = [0, 1, 2].map((family) => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 64, 128);
    if (family === 0) {
      for (let y = 4; y < 124; y += 8) {
        for (let x = 4; x < 60; x += 10) {
          if (random() <= 0.42) continue;
          ctx.fillStyle = random() < 0.24 ? '#ffd19a' : random() < 0.5 ? '#78bfe7' : '#bfd8e8';
          ctx.fillRect(x + (random() * 3 | 0), y, 4, 5);
        }
      }
    } else if (family === 1) {
      for (let floor = 0; floor < 12; floor++) {
        const y = 3 + floor * 10;
        ctx.fillStyle = '#151a20';
        ctx.fillRect(0, y + 6, 64, 2);
        for (let bay = 0; bay < 4; bay++) {
          if (random() < 0.26) continue;
          ctx.fillStyle = random() < 0.58 ? '#e7aa65' : '#77a8c1';
          ctx.fillRect(4 + bay * 16, y, 9, 4);
        }
      }
    } else {
      ctx.fillStyle = '#15212a';
      for (let rib = 0; rib < 5; rib++) ctx.fillRect(3 + rib * 13, 0, 2, 128);
      for (let y = 7; y < 124; y += 14) {
        ctx.fillStyle = random() < 0.28 ? '#c49b69' : '#4e86a5';
        ctx.fillRect(8, y, 9, 3);
        ctx.fillRect(34, y, 14, 3);
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(family === 1 ? 2.7 : 3.2, family === 2 ? 5.2 : 4.2);
    return texture;
  });
  const skylineMaterials = windowTextures.map((texture, family) => new THREE.MeshStandardMaterial({
    color: [0x24303d, 0x342e31, 0x182630][family],
    emissive: [0xbfe6ff, 0xd7a876, 0x6e9db8][family],
    emissiveMap: texture,
    emissiveIntensity: [1.15, 0.72, 0.68][family],
    roughness: [0.9, 0.95, 0.8][family],
    metalness: family === 2 ? 0.14 : 0,
  }));
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  // Fewer towers with wider angular gaps: the old dense ring read as a solid
  // black shadow wall against the dusk gradient instead of a distant skyline.
  const count = 46;
  const towers = skylineMaterials.map((material) => new THREE.InstancedMesh(box, material, count));
  const crownMat = new THREE.MeshStandardMaterial({
    color: 0x111923,
    roughness: 0.74,
    metalness: 0.26,
  });
  const crowns = new THREE.InstancedMesh(box, crownMat, count);
  const antennaCount = Math.ceil(count / 4);
  const antennas = new THREE.InstancedMesh(box, crownMat, antennaCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const e = new THREE.Euler();
  const half = size / 2;
  const cornerRadius = half * Math.SQRT2;
  const towerIndices = [0, 0, 0];
  let antennaIndex = 0;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + random() * 0.18;
    const r = cornerRadius + 120 + random() * 340;
    p.set(Math.cos(ang) * r, -2, Math.sin(ang) * r);
    const h = 34 + random() * random() * 120;
    s.set(22 + random() * 30, h, 22 + random() * 30);
    e.set(0, random() * Math.PI, 0);
    q.setFromEuler(e);
    m.compose(p, q, s);
    const family = i % 3;
    const towerIndex = towerIndices[family]!;
    towers[family]!.setMatrixAt(towerIndex, m);
    towers[family]!.setColorAt(
      towerIndex,
      new THREE.Color().setHSL(0.56 + random() * 0.045, 0.1 + random() * 0.08, 0.14 + random() * 0.08),
    );
    towerIndices[family] = towerIndex + 1;

    // Give every tower a deliberate roof termination. The former skyline
    // ended all façades as identical flat cuboids, so the window atlas—not
    // the architecture—defined the silhouette. Setback crowns and occasional
    // masts keep the same three batched draws while making the horizon legible.
    const crownH = 2.2 + random() * 7.5;
    const crownScaleX = s.x * (0.32 + random() * 0.42);
    const crownScaleZ = s.z * (0.3 + random() * 0.44);
    const crownP = p.clone();
    crownP.y = p.y + h;
    const crownScale = new THREE.Vector3(crownScaleX, crownH, crownScaleZ);
    m.compose(crownP, q, crownScale);
    crowns.setMatrixAt(i, m);
    if (i % 4 === 0) {
      const mastP = crownP.clone();
      mastP.y += crownH;
      m.compose(mastP, q, new THREE.Vector3(0.32, 9 + random() * 13, 0.32));
      antennas.setMatrixAt(antennaIndex++, m);
    }
  }
  towers.forEach((tower, family) => {
    tower.count = towerIndices[family]!;
    tower.instanceMatrix.needsUpdate = true;
    if (tower.instanceColor) tower.instanceColor.needsUpdate = true;
    tower.frustumCulled = false;
  });
  crowns.instanceMatrix.needsUpdate = true;
  antennas.count = antennaIndex;
  antennas.instanceMatrix.needsUpdate = true;
  crowns.frustumCulled = false;
  antennas.frustumCulled = false;
  group.add(...towers, crowns, antennas);
  group.userData.windowTextures = windowTextures;
  return group;
}

/**
 * Low-rise city fabric immediately outside the playable square. The far
 * skyline alone left a 90 m empty moat at the boundary, so legal cameras saw
 * towers floating on the sky line. Two instanced meshes establish grounded
 * podiums and rooftop service silhouettes without adding gameplay collision.
 */
function buildCityContinuation(size: number): THREE.Group {
  const group = new THREE.Group();
  const random = seededRandom(0x43495459);
  const half = size / 2;
  // Three deterministic facade families break the former cloned cyan-window
  // wall into office grids, residential balcony bands and darker service
  // towers. They remain batched per family instead of allocating one mesh per
  // building; the extra entrance and service silhouettes are batched too.
  const facadeTextures = [0, 1, 2].map((family) => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = family === 2 ? '#090d12' : '#070b0f';
    ctx.fillRect(0, 0, 64, 64);
    if (family === 0) {
      for (let row = 0; row < 6; row++) {
        for (let col = 0; col < 6; col++) {
          if (random() < 0.36) continue;
          ctx.fillStyle = random() < 0.2 ? '#f0bf82' : random() < 0.58 ? '#66add4' : '#a8c9dc';
          ctx.fillRect(4 + col * 10, 4 + row * 10, 4, 4);
        }
      }
    } else if (family === 1) {
      for (let row = 0; row < 5; row++) {
        const y = 5 + row * 12;
        ctx.fillStyle = '#151c23';
        ctx.fillRect(0, y + 6, 64, 3);
        for (let col = 0; col < 4; col++) {
          if (random() < 0.2) continue;
          ctx.fillStyle = random() < 0.44 ? '#e9b97a' : '#81b6d0';
          ctx.fillRect(5 + col * 15, y, 8, 5);
        }
      }
    } else {
      ctx.fillStyle = '#202a33';
      for (let col = 0; col < 4; col++) ctx.fillRect(5 + col * 16, 0, 3, 64);
      for (let row = 0; row < 7; row++) {
        if (row % 3 === 1) continue;
        ctx.fillStyle = row % 2 === 0 ? '#4f88a8' : '#c49a67';
        ctx.fillRect(10, 4 + row * 9, 9, 3);
        ctx.fillRect(42, 4 + row * 9, 7, 3);
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(family === 1 ? 3.6 : 4.5, family === 2 ? 8 : 6.5);
    return texture;
  });
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const octagonal = new THREE.CylinderGeometry(1, 1, 1, 8);
  octagonal.translate(0, 0.5, 0);
  const facadeMaterials = facadeTextures.map((texture, family) => new THREE.MeshStandardMaterial({
    color: [0x202a34, 0x313136, 0x18232c][family],
    emissive: [0x86bddc, 0xc39b70, 0x668da3][family],
    emissiveMap: texture,
    emissiveIntensity: [0.76, 0.55, 0.5][family],
    roughness: [0.86, 0.94, 0.78][family],
    metalness: [0.05, 0.02, 0.18][family],
  }));
  const roofMaterial = new THREE.MeshStandardMaterial({
    color: 0x151b22,
    roughness: 0.72,
    metalness: 0.22,
  });
  const slots = 10;
  const count = slots * 4;
  const familyGeometries = [box, box, octagonal];
  const blocks = facadeMaterials.map((material, family) => (
    new THREE.InstancedMesh(familyGeometries[family]!, material, count)
  ));
  const setbacks = facadeMaterials.map((material, family) => (
    new THREE.InstancedMesh(familyGeometries[family]!, material, count)
  ));
  const roofs = new THREE.InstancedMesh(box, roofMaterial, count);
  const wings = new THREE.InstancedMesh(box, facadeMaterials[1]!, count);
  const serviceCores = new THREE.InstancedMesh(box, roofMaterial, count);
  const balconyBands = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x66717b, roughness: 0.64, metalness: 0.28 }),
    count * 2,
  );
  const entranceFrameMaterial = new THREE.MeshStandardMaterial({
    color: 0x111820,
    roughness: 0.7,
    metalness: 0.34,
  });
  const entranceMaterial = new THREE.MeshStandardMaterial({
    color: 0x253a46,
    emissive: 0x315d70,
    emissiveIntensity: 0.42,
    roughness: 0.58,
    metalness: 0.24,
  });
  const entrances = new THREE.InstancedMesh(box, entranceMaterial, count);
  const entranceFrames = new THREE.InstancedMesh(box, entranceFrameMaterial, count);
  const entranceCanopies = new THREE.InstancedMesh(box, roofMaterial, count);
  const entrancePosts = new THREE.InstancedMesh(box, roofMaterial, count * 2);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const roofScale = new THREE.Vector3();
  const featureOffset = new THREE.Vector3();
  const instanceColor = new THREE.Color();
  const groundY = -0.58;
  const familyIndices = [0, 0, 0];
  let roofIndex = 0;
  let wingIndex = 0;
  let coreIndex = 0;
  let balconyIndex = 0;
  let entranceIndex = 0;
  let entrancePostIndex = 0;
  for (let side = 0; side < 4; side++) {
    for (let slot = 0; slot < slots; slot++) {
      const cornerSlot = slot === 0 || slot === slots - 1;
      const nearCornerSlot = slot === 1 || slot === slots - 2;
      const family = (slot + side * 2) % 3;
      const rawAlong = -half + 26 + slot * ((size - 52) / (slots - 1));
      const along = cornerSlot ? Math.sign(rawAlong) * (half - 58) : rawAlong;
      const depth = (family === 2 ? 20 : 24) + random() * (family === 1 ? 16 : 20);
      const widthBase = cornerSlot ? 17 + random() * 8 : 22 + random() * 17;
      const width = family === 1 ? widthBase * 1.12 : family === 2 ? widthBase * 0.8 : widthBase;
      const height = family === 0
        ? 15 + random() * 18
        : family === 1
          ? 8 + random() * 10
          : 20 + random() * 22;
      // Leave one perimeter service street between the legal edge and the
      // first façade. The old blocks started almost immediately outside the
      // clamp and became a wall of identical window boxes at corner cameras.
      const cornerSetback = cornerSlot ? 76 : nearCornerSlot ? 20 : 0;
      const outward = half + depth / 2 + 21 + (slot % 3) * 4 + cornerSetback;
      const isXAxis = side < 2;
      position.set(
        isXAxis ? (side === 0 ? outward : -outward) : along,
        groundY,
        isXAxis ? along : (side === 2 ? outward : -outward),
      );
      const baseX = position.x;
      const baseZ = position.z;
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), isXAxis ? 0 : Math.PI / 2);
      scale.set(family === 2 ? depth / 2 : depth, height, family === 2 ? width / 2 : width);
      matrix.compose(position, rotation, scale);
      const familyIndex = familyIndices[family]!;
      blocks[family]!.setMatrixAt(familyIndex, matrix);
      instanceColor.setHSL(
        family === 1 ? 0.08 + random() * 0.03 : 0.56 + random() * 0.055,
        family === 1 ? 0.05 + random() * 0.05 : 0.11 + random() * 0.08,
        family === 2 ? 0.1 + random() * 0.045 : 0.13 + random() * 0.075,
      );
      blocks[family]!.setColorAt(familyIndex, instanceColor);

      const tierHeight = family === 1 ? 1.4 + random() * 2.8 : 2.5 + random() * 7.5;
      featureOffset
        .set(0, 0, family === 1 ? width * 0.1 : family === 2 ? -width * 0.08 : 0)
        .applyQuaternion(rotation);
      position.set(baseX + featureOffset.x, groundY + height, baseZ + featureOffset.z);
      const setbackDepth = depth * (family === 2 ? 0.46 + random() * 0.18 : 0.54 + random() * 0.25);
      const setbackWidth = width * (family === 1 ? 0.76 + random() * 0.12 : 0.5 + random() * 0.3);
      scale.set(
        family === 2 ? setbackDepth / 2 : setbackDepth,
        tierHeight,
        family === 2 ? setbackWidth / 2 : setbackWidth,
      );
      matrix.compose(position, rotation, scale);
      setbacks[family]!.setMatrixAt(familyIndex, matrix);
      setbacks[family]!.setColorAt(familyIndex, instanceColor.clone().offsetHSL(0, -0.02, 0.025));

      if (family === 1) {
        featureOffset.set(0, 0, width * 0.43).applyQuaternion(rotation);
        position.set(baseX + featureOffset.x, groundY, baseZ + featureOffset.z);
        scale.set(depth * 0.7, height * 0.62, width * 0.3);
        matrix.compose(position, rotation, scale);
        wings.setMatrixAt(wingIndex++, matrix);

        const inwardX = isXAxis ? (side === 0 ? -1 : 1) : 0;
        const inwardZ = isXAxis ? 0 : (side === 2 ? -1 : 1);
        for (const level of [0.33, 0.67]) {
          position.set(
            baseX + inwardX * (depth / 2 + 0.14),
            groundY + height * level,
            baseZ + inwardZ * (depth / 2 + 0.14),
          );
          scale.set(0.3, 0.18, width * 0.88);
          matrix.compose(position, rotation, scale);
          balconyBands.setMatrixAt(balconyIndex++, matrix);
        }
      } else if (family === 2) {
        featureOffset.set(0, 0, -width * 0.42).applyQuaternion(rotation);
        position.set(baseX + featureOffset.x, groundY, baseZ + featureOffset.z);
        scale.set(depth * 0.58, height * 0.84, Math.max(2.4, width * 0.2));
        matrix.compose(position, rotation, scale);
        serviceCores.setMatrixAt(coreIndex++, matrix);
      }

      // Every perimeter building now has a legible street entrance. A dark
      // frame, recessed door, supported canopy and posts establish human
      // scale at the service street, where the old continuation exposed only
      // full-height textured slabs. All pieces face the playable boundary.
      const inwardX = isXAxis ? (side === 0 ? -1 : 1) : 0;
      const inwardZ = isXAxis ? 0 : (side === 2 ? -1 : 1);
      const facadeDepth = family === 2 ? depth * Math.cos(Math.PI / 8) * 0.5 : depth * 0.5;
      const doorAlong = ((slot % 3) - 1) * width * 0.17;
      featureOffset.set(0, 0, doorAlong).applyQuaternion(rotation);
      const doorX = baseX + inwardX * (facadeDepth + 0.09) + featureOffset.x;
      const doorZ = baseZ + inwardZ * (facadeDepth + 0.09) + featureOffset.z;
      position.set(doorX, groundY + 0.08, doorZ);
      scale.set(0.2, 3.05, 2.65);
      matrix.compose(position, rotation, scale);
      entranceFrames.setMatrixAt(entranceIndex, matrix);
      position.set(
        doorX + inwardX * 0.12,
        groundY + 0.18,
        doorZ + inwardZ * 0.12,
      );
      scale.set(0.12, 2.72, 2.12);
      matrix.compose(position, rotation, scale);
      entrances.setMatrixAt(entranceIndex, matrix);
      position.set(
        doorX + inwardX * 0.92,
        groundY + 3.08,
        doorZ + inwardZ * 0.92,
      );
      scale.set(1.95, 0.18, 3.35);
      matrix.compose(position, rotation, scale);
      entranceCanopies.setMatrixAt(entranceIndex, matrix);
      for (const postSide of [-1, 1]) {
        featureOffset.set(0, 0, postSide * 1.42).applyQuaternion(rotation);
        position.set(
          doorX + inwardX * 1.72 + featureOffset.x,
          groundY + 0.08,
          doorZ + inwardZ * 1.72 + featureOffset.z,
        );
        scale.set(0.14, 3, 0.14);
        matrix.compose(position, rotation, scale);
        entrancePosts.setMatrixAt(entrancePostIndex++, matrix);
      }
      entranceIndex++;

      const roofHeight = 0.9 + random() * 1.8;
      const roofWidth = width * (0.22 + random() * 0.18);
      const roofDepth = depth * (0.2 + random() * 0.18);
      position.set(baseX, groundY + height + tierHeight, baseZ);
      roofScale.set(roofDepth, roofHeight, roofWidth);
      matrix.compose(position, rotation, roofScale);
      roofs.setMatrixAt(roofIndex++, matrix);
      familyIndices[family] = familyIndex + 1;
    }
  }
  blocks.forEach((mesh, family) => {
    mesh.count = familyIndices[family]!;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
  });
  setbacks.forEach((mesh, family) => {
    mesh.count = familyIndices[family]!;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
  });
  roofs.count = roofIndex;
  roofs.instanceMatrix.needsUpdate = true;
  wings.count = wingIndex;
  wings.instanceMatrix.needsUpdate = true;
  serviceCores.count = coreIndex;
  serviceCores.instanceMatrix.needsUpdate = true;
  balconyBands.count = balconyIndex;
  balconyBands.instanceMatrix.needsUpdate = true;
  entrances.count = entranceIndex;
  entranceFrames.count = entranceIndex;
  entranceCanopies.count = entranceIndex;
  entrancePosts.count = entrancePostIndex;
  entrances.instanceMatrix.needsUpdate = true;
  entranceFrames.instanceMatrix.needsUpdate = true;
  entranceCanopies.instanceMatrix.needsUpdate = true;
  entrancePosts.instanceMatrix.needsUpdate = true;
  roofs.frustumCulled = false;
  wings.frustumCulled = false;
  serviceCores.frustumCulled = false;
  balconyBands.frustumCulled = false;
  entrances.frustumCulled = false;
  entranceFrames.frustumCulled = false;
  entranceCanopies.frustumCulled = false;
  entrancePosts.frustumCulled = false;

  // Carry the four main street axes over the 0.6 m-deep vista ground. Before
  // this bed existed, the playable asphalt and lane paint ended at the legal
  // boundary and exposed a visible step into an empty grey plane. All pieces
  // remain render-only and are batched into three instanced draws.
  const roadLength = 128;
  const roadCentre = half - 1.5 + roadLength / 2;
  const roadMaterial = new THREE.MeshStandardMaterial({
    color: 0x171d24,
    roughness: 0.78,
    metalness: 0.08,
  });
  const curbMaterial = new THREE.MeshStandardMaterial({
    color: 0x4c5660,
    roughness: 0.92,
    metalness: 0.02,
  });
  const markMaterial = new THREE.MeshBasicMaterial({ color: 0x8192a2, fog: true });
  const roads = new THREE.InstancedMesh(box, roadMaterial, 4);
  const curbs = new THREE.InstancedMesh(box, curbMaterial, 8);
  const ringRoads = new THREE.InstancedMesh(box, roadMaterial, 4);
  const ringCurbs = new THREE.InstancedMesh(box, curbMaterial, 8);
  const marksPerRoad = 10;
  const marks = new THREE.InstancedMesh(box, markMaterial, marksPerRoad * 4);
  let roadIndex = 0;
  let curbIndex = 0;
  let markIndex = 0;
  let ringCurbIndex = 0;
  for (let side = 0; side < 4; side++) {
    const isXAxis = side < 2;
    const sign = side % 2 === 0 ? 1 : -1;
    position.set(isXAxis ? sign * roadCentre : 0, groundY, isXAxis ? 0 : sign * roadCentre);
    scale.set(isXAxis ? roadLength : 13.2, 0.6, isXAxis ? 13.2 : roadLength);
    matrix.compose(position, rotation.identity(), scale);
    roads.setMatrixAt(roadIndex++, matrix);
    for (const laneSide of [-1, 1]) {
      position.set(
        isXAxis ? sign * roadCentre : laneSide * 6.78,
        0.015,
        isXAxis ? laneSide * 6.78 : sign * roadCentre,
      );
      scale.set(isXAxis ? roadLength : 0.34, 0.24, isXAxis ? 0.34 : roadLength);
      matrix.compose(position, rotation.identity(), scale);
      curbs.setMatrixAt(curbIndex++, matrix);
    }
    for (let dash = 0; dash < marksPerRoad; dash++) {
      const outward = half + 4 + dash * 11.5;
      position.set(isXAxis ? sign * outward : 0, 0.025, isXAxis ? 0 : sign * outward);
      scale.set(isXAxis ? 5.8 : 0.15, 0.025, isXAxis ? 0.15 : 5.8);
      matrix.compose(position, rotation.identity(), scale);
      marks.setMatrixAt(markIndex++, matrix);
    }

    // A continuous service street wraps the full boundary and intersects the
    // four outbound axes. It gives corner cameras a road hierarchy instead of
    // an empty asphalt apron between monolithic façade blocks.
    const ringOutward = half + 11.5;
    position.set(isXAxis ? sign * ringOutward : 0, groundY, isXAxis ? 0 : sign * ringOutward);
    scale.set(isXAxis ? 17 : size + 74, 0.6, isXAxis ? size + 74 : 17);
    matrix.compose(position, rotation.identity(), scale);
    ringRoads.setMatrixAt(side, matrix);
    for (const edge of [-1, 1]) {
      const edgeOffset = ringOutward + edge * 8.65;
      position.set(isXAxis ? sign * edgeOffset : 0, 0.015, isXAxis ? 0 : sign * edgeOffset);
      scale.set(isXAxis ? 0.3 : size + 74, 0.24, isXAxis ? size + 74 : 0.3);
      matrix.compose(position, rotation.identity(), scale);
      ringCurbs.setMatrixAt(ringCurbIndex++, matrix);
    }
  }
  roads.instanceMatrix.needsUpdate = true;
  curbs.instanceMatrix.needsUpdate = true;
  marks.instanceMatrix.needsUpdate = true;
  ringRoads.instanceMatrix.needsUpdate = true;
  ringCurbs.instanceMatrix.needsUpdate = true;
  roads.frustumCulled = false;
  curbs.frustumCulled = false;
  marks.frustumCulled = false;
  ringRoads.frustumCulled = false;
  ringCurbs.frustumCulled = false;

  // Repeated poles and compact luminous heads carry human scale around the
  // service street without adding 24 point lights or gameplay collision.
  const poleCount = 24;
  const poles = new THREE.InstancedMesh(box, roofMaterial, poleCount);
  const heads = new THREE.InstancedMesh(
    box,
    new THREE.MeshBasicMaterial({ color: 0xa9d7ec, fog: true }),
    poleCount,
  );
  let poleIndex = 0;
  for (let side = 0; side < 4; side++) {
    const isXAxis = side < 2;
    const sign = side % 2 === 0 ? 1 : -1;
    for (let slot = 0; slot < 6; slot++) {
      const along = -half - 16 + (slot + 0.5) * ((size + 32) / 6);
      const outward = half + 2.8;
      position.set(isXAxis ? sign * outward : along, groundY, isXAxis ? along : sign * outward);
      scale.set(0.18, 5.4, 0.18);
      matrix.compose(position, rotation.identity(), scale);
      poles.setMatrixAt(poleIndex, matrix);
      position.y = groundY + 5.25;
      scale.set(isXAxis ? 1.25 : 0.18, 0.15, isXAxis ? 0.18 : 1.25);
      matrix.compose(position, rotation.identity(), scale);
      heads.setMatrixAt(poleIndex, matrix);
      poleIndex++;
    }
  }
  poles.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  poles.frustumCulled = false;
  heads.frustumCulled = false;
  group.add(
    ...blocks, ...setbacks, roofs, wings, serviceCores, balconyBands,
    entrances, entranceFrames, entranceCanopies, entrancePosts,
    roads, curbs, marks, ringRoads, ringCurbs, poles, heads,
  );
  group.userData.facadeTextures = facadeTextures;
  return group;
}

function buildGableRoofGeometry(): THREE.BufferGeometry {
  // Unit triangular prism with its eaves on y=0 and ridge on y=0.5.
  // Scaling therefore preserves a true gable instead of turning a four-sided
  // cone into the pyramid roofs that previously dominated Old Front's vista.
  const positions = new Float32Array([
    -0.55, 0, -0.55, 0.55, 0, -0.55, 0, 0.5, -0.55,
    -0.55, 0, 0.55, 0, 0.5, 0.55, 0.55, 0, 0.55,
    -0.55, 0, -0.55, -0.55, 0, 0.55, 0, 0.5, 0.55,
    -0.55, 0, -0.55, 0, 0.5, 0.55, 0, 0.5, -0.55,
    0.55, 0, -0.55, 0, 0.5, -0.55, 0, 0.5, 0.55,
    0.55, 0, -0.55, 0, 0.5, 0.55, 0.55, 0, 0.55,
    -0.55, 0, -0.55, 0.55, 0, 0.55, -0.55, 0, 0.55,
    -0.55, 0, -0.55, 0.55, 0, -0.55, 0.55, 0, 0.55,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function buildHedgeClusterGeometry(): THREE.BufferGeometry {
  const specs: Array<[number, number, number, number]> = [
    [-0.36, 0.54, 0, 0.62],
    [0, 0.7, 0.04, 0.78],
    [0.38, 0.52, -0.03, 0.6],
  ];
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, y, z, scale] of specs) {
    const source = new THREE.DodecahedronGeometry(scale, 1);
    // DodecahedronGeometry is already non-indexed in current Three.js. Calling
    // toNonIndexed() unconditionally emits one warning per hedge lobe on every
    // map load and performs no useful conversion.
    const part = source.index ? source.toNonIndexed() : source;
    if (part !== source) source.dispose();
    part.translate(x, y, z);
    parts.push(part);
  }
  const vertexCount = parts.reduce((sum, part) => sum + part.attributes.position!.count, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  let vertexOffset = 0;
  for (const part of parts) {
    const position = part.attributes.position!;
    const normal = part.attributes.normal!;
    positions.set(position.array as Float32Array, vertexOffset * 3);
    normals.set(normal.array as Float32Array, vertexOffset * 3);
    vertexOffset += position.count;
    part.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geometry;
}

function buildRuralHorizon(def: MapDef): THREE.Group {
  const group = new THREE.Group();
  const size = def.size;
  const half = size / 2;
  const random = seededRandom(0x4f4c4435);
  const heightAt = (x: number, z: number) => sampleVistaGroundHeight(def, x, z);
  // Two low moor bands preserve depth underneath the overcast sky. The old
  // horizon relied on isolated trees alone, leaving a flat grey strip between
  // the playable fields and distant silhouettes.
  const farMoor = new THREE.Mesh(
    buildRidgeBandGeometry(half + 390, 42, 8.1),
    new THREE.MeshBasicMaterial({ color: 0x59605b, fog: true }),
  );
  farMoor.frustumCulled = false;
  group.add(farMoor);
  const nearMoor = new THREE.Mesh(
    buildRidgeBandGeometry(half + 185, 24, 3.8),
    new THREE.MeshBasicMaterial({ color: 0x4d5842, fog: true }),
  );
  nearMoor.frustumCulled = false;
  group.add(nearMoor);
  // A dense mid-distance treeline bridges the empty 50–150 m strip between
  // playable farmland and the distant moors. Every trunk starts on the same
  // continuation-height sampler as the terrain mesh.
  const treeGeo = mergeTreeGeo();
  const mat = new THREE.MeshStandardMaterial({ color: 0x39452c, roughness: 1, metalness: 0 });
  const count = 180;
  const inst = new THREE.InstancedMesh(treeGeo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + (random() - 0.5) * 0.14;
    const r = half + 28 + random() * 170;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    p.set(x, heightAt(x, z), z);
    const sc = 0.62 + random() * 0.82;
    s.set(sc, sc * (0.92 + random() * 0.3), sc);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2);
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  }
  inst.frustumCulled = false;
  group.add(inst);

  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();

  // Field boundaries make the near vista read as cultivated land rather than
  // an unbounded green plane. Hedges and lower dry-stone segments alternate so
  // the ring is not a continuous artificial wall.
  const hedgeCount = 72;
  const hedgeGeo = buildHedgeClusterGeometry();
  const hedges = new THREE.InstancedMesh(
    hedgeGeo,
    new THREE.MeshStandardMaterial({ color: 0x66784c, roughness: 1, metalness: 0 }),
    hedgeCount,
  );
  for (let i = 0; i < hedgeCount; i++) {
    const ang = (i / hedgeCount) * Math.PI * 2 + (random() - 0.5) * 0.09;
    const r = half + 13 + random() * 72;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const length = 7 + random() * 12;
    const height = 1.25 + random() * 0.85;
    const depth = 1.4 + random() * 1.1;
    position.set(x, heightAt(x, z) - 0.08, z);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang + Math.PI / 2 + (random() - 0.5) * 0.26);
    scale.set(length * 0.5, height, depth * 0.74);
    matrix.compose(position, rotation, scale);
    hedges.setMatrixAt(i, matrix);
    hedges.setColorAt(
      i,
      new THREE.Color().setHSL(0.22 + random() * 0.05, 0.2 + random() * 0.12, 0.32 + random() * 0.09),
    );
  }
  hedges.instanceMatrix.needsUpdate = true;
  if (hedges.instanceColor) hedges.instanceColor.needsUpdate = true;
  hedges.frustumCulled = false;

  const wallCount = 36;
  const walls = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x6a675d, roughness: 0.98, metalness: 0 }),
    wallCount,
  );
  for (let i = 0; i < wallCount; i++) {
    const ang = (i / wallCount) * Math.PI * 2 + 0.06 + (random() - 0.5) * 0.12;
    const r = half + 42 + random() * 92;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    position.set(x, heightAt(x, z) - 0.24, z);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang + Math.PI / 2 + (random() - 0.5) * 0.22);
    scale.set(8 + random() * 15, 0.9 + random() * 0.45, 0.75 + random() * 0.35);
    matrix.compose(position, rotation, scale);
    walls.setMatrixAt(i, matrix);
  }
  walls.instanceMatrix.needsUpdate = true;
  walls.frustumCulled = false;

  // Short post-and-rail runs provide a second, human-scale field boundary.
  // Their open silhouette prevents the vista from becoming a ring of solid
  // hedges while giving the broad meadow a readable agricultural structure.
  const fenceSegments = 32;
  const fenceMaterial = new THREE.MeshStandardMaterial({ color: 0x514a3c, roughness: 1, metalness: 0 });
  const fencePosts = new THREE.InstancedMesh(box, fenceMaterial, fenceSegments * 2);
  const fenceRails = new THREE.InstancedMesh(box, fenceMaterial, fenceSegments * 2);
  let fencePostIndex = 0;
  let fenceRailIndex = 0;
  for (let i = 0; i < fenceSegments; i++) {
    const ang = (i / fenceSegments) * Math.PI * 2 + 0.11 + (random() - 0.5) * 0.16;
    const r = half + 8 + random() * 58;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const length = 7.5 + random() * 7.5;
    const yaw = -ang + Math.PI / 2 + (random() - 0.5) * 0.18;
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const tangentX = Math.cos(yaw);
    const tangentZ = -Math.sin(yaw);
    for (const end of [-1, 1]) {
      const postX = x + tangentX * length * 0.5 * end;
      const postZ = z + tangentZ * length * 0.5 * end;
      position.set(postX, heightAt(postX, postZ) - 0.08, postZ);
      scale.set(0.18, 1.55, 0.18);
      matrix.compose(position, rotation, scale);
      fencePosts.setMatrixAt(fencePostIndex++, matrix);
    }
    for (const railY of [0.48, 1.05]) {
      position.set(x, heightAt(x, z) + railY, z);
      scale.set(length, 0.14, 0.16);
      matrix.compose(position, rotation, scale);
      fenceRails.setMatrixAt(fenceRailIndex++, matrix);
    }
  }
  fencePosts.instanceMatrix.needsUpdate = true;
  fenceRails.instanceMatrix.needsUpdate = true;
  fencePosts.frustumCulled = false;
  fenceRails.frustumCulled = false;

  // Replace seven isolated 50 m obelisks with a low, clustered village band.
  // Cottages establish believable scale; only three churches break the ridge.
  const cottageCount = 28;
  const cottages = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x625f57, roughness: 0.96, metalness: 0 }),
    cottageCount,
  );
  const roofGeo = buildGableRoofGeometry();
  const roofs = new THREE.InstancedMesh(
    roofGeo,
    new THREE.MeshStandardMaterial({ color: 0x3d3934, roughness: 0.94, metalness: 0 }),
    cottageCount,
  );
  const cottageWindows = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({
      color: 0x243039,
      emissive: 0xc49a67,
      emissiveIntensity: 0.32,
      roughness: 0.62,
      metalness: 0.02,
    }),
    cottageCount * 2,
  );
  const cottageDoors = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x342d27, roughness: 0.96, metalness: 0 }),
    cottageCount,
  );
  const chimneys = new THREE.InstancedMesh(box, cottageDoors.material, cottageCount);
  let cottageWindowIndex = 0;
  for (let i = 0; i < cottageCount; i++) {
    const ang = (i / cottageCount) * Math.PI * 2 + 0.18 + (random() - 0.5) * 0.12;
    const r = half + 125 + random() * 185;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const ground = heightAt(x, z) - 0.35;
    const width = 7 + random() * 7;
    const depth = 7 + random() * 6;
    const height = 5 + random() * 5;
    position.set(x, ground, z);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI);
    scale.set(width, height, depth);
    matrix.compose(position, rotation, scale);
    cottages.setMatrixAt(i, matrix);
    for (const side of [-1, 1]) {
      const windowOffset = new THREE.Vector3(side * width * 0.22, 0, depth / 2 + 0.06).applyQuaternion(rotation);
      position.set(x + windowOffset.x, ground + height * 0.36, z + windowOffset.z);
      scale.set(Math.max(0.75, width * 0.18), 1.35, 0.12);
      matrix.compose(position, rotation, scale);
      cottageWindows.setMatrixAt(cottageWindowIndex++, matrix);
    }
    const doorOffset = new THREE.Vector3(-width * 0.31, 0, depth / 2 + 0.075).applyQuaternion(rotation);
    position.set(x + doorOffset.x, ground, z + doorOffset.z);
    scale.set(1.05, 2.15, 0.15);
    matrix.compose(position, rotation, scale);
    cottageDoors.setMatrixAt(i, matrix);
    position.y = ground + height;
    scale.set(width, 4.2, depth);
    matrix.compose(position, rotation, scale);
    roofs.setMatrixAt(i, matrix);
    const chimneyOffset = new THREE.Vector3(width * 0.22, 0, -depth * 0.12).applyQuaternion(rotation);
    position.set(x + chimneyOffset.x, ground + height + 1.05, z + chimneyOffset.z);
    scale.set(0.55, 3, 0.55);
    matrix.compose(position, rotation, scale);
    chimneys.setMatrixAt(i, matrix);
  }
  cottages.instanceMatrix.needsUpdate = true;
  roofs.instanceMatrix.needsUpdate = true;
  cottageWindows.instanceMatrix.needsUpdate = true;
  cottageDoors.instanceMatrix.needsUpdate = true;
  chimneys.instanceMatrix.needsUpdate = true;
  cottages.frustumCulled = false;
  roofs.frustumCulled = false;
  cottageWindows.frustumCulled = false;
  cottageDoors.frustumCulled = false;
  chimneys.frustumCulled = false;

  const churchCount = 3;
  const churches = new THREE.InstancedMesh(box, cottages.material, churchCount);
  const spireGeo = new THREE.ConeGeometry(1, 1, 8);
  const spires = new THREE.InstancedMesh(spireGeo, roofs.material, churchCount);
  for (let i = 0; i < churchCount; i++) {
    const ang = i / churchCount * Math.PI * 2 + 0.52;
    const r = half + 225 + i * 58;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const ground = heightAt(x, z) - 0.6;
    const height = 15 + i * 2;
    position.set(x, ground, z);
    rotation.identity();
    scale.set(6.5, height, 6.5);
    matrix.compose(position, rotation, scale);
    churches.setMatrixAt(i, matrix);
    position.y = ground + height + 4.3;
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    scale.set(4.8, 8.6, 4.8);
    matrix.compose(position, rotation, scale);
    spires.setMatrixAt(i, matrix);
  }
  churches.instanceMatrix.needsUpdate = true;
  spires.instanceMatrix.needsUpdate = true;
  churches.frustumCulled = false;
  spires.frustumCulled = false;
  group.add(
    hedges, walls, fencePosts, fenceRails,
    cottages, roofs, cottageWindows, cottageDoors, chimneys,
    churches, spires,
  );
  return group;
}

function mergeTreeGeo(): THREE.BufferGeometry {
  // One merged low-poly pine: grounded trunk plus three overlapping canopy
  // tiers. A single tall cone was recognisably a primitive from boundary
  // cameras and repeated as a uniform row rather than reading as woodland.
  const trunkSource = new THREE.CylinderGeometry(0.52, 0.76, 5.5, 7);
  const trunk = trunkSource.index ? trunkSource.toNonIndexed() : trunkSource;
  if (trunk !== trunkSource) trunkSource.dispose();
  trunk.translate(0, 2.75, 0);
  const canopySpecs: Array<[number, number, number, number]> = [
    [3.2, 5.6, 5.6, 9],
    [2.55, 5.1, 8.0, 8],
    [1.8, 4.7, 10.35, 7],
  ];
  const parts: THREE.BufferGeometry[] = [trunk];
  for (const [radius, height, y, segments] of canopySpecs) {
    const source = new THREE.ConeGeometry(radius, height, segments);
    const part = source.index ? source.toNonIndexed() : source;
    if (part !== source) source.dispose();
    part.translate(0, y, 0);
    parts.push(part);
  }
  // Manual merge without importing BufferGeometryUtils here. Both sources
  // must be non-indexed: copying indexed position attributes into an
  // unindexed result made their vertex order render as stray needle-like
  // triangles instead of trunks and canopies.
  const posCount = parts.reduce((sum, part) => sum + part.attributes.position!.count, 0);
  const positions = new Float32Array(posCount * 3);
  const normals = new Float32Array(posCount * 3);
  let offset = 0;
  for (const part of parts) {
    const partPos = part.attributes.position!;
    const partNormal = part.attributes.normal!;
    positions.set(partPos.array as Float32Array, offset * 3);
    normals.set(partNormal.array as Float32Array, offset * 3);
    offset += partPos.count;
    part.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geo;
}

/** Continuous sloped horizon band with a deterministic non-repeating ridge. */
function buildRidgeBandGeometry(radius: number, baseHeight: number, seed: number): THREE.BufferGeometry {
  const segments = 192;
  const rings = 3;
  const positions = new Float32Array((segments + 1) * rings * 3);
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = i / segments * Math.PI * 2;
    const wave = Math.sin(angle * 3 + seed) * 0.34
      + Math.sin(angle * 7 - seed * 1.7) * 0.2
      + Math.sin(angle * 13 + seed * 0.7) * 0.09;
    const height = baseHeight * (0.78 + wave);
    const root = radius
      + Math.sin(angle * 5 - seed) * baseHeight * 0.42
      + Math.sin(angle * 11 + seed * 2.1) * baseHeight * 0.16;
    const radial = [root, root + height * 0.62, root + height * 1.48];
    const y = [-14, height * 0.43 - 7, height - 8];
    for (let ring = 0; ring < rings; ring++) {
      const offset = (i * rings + ring) * 3;
      positions[offset] = Math.cos(angle) * radial[ring]!;
      positions[offset + 1] = y[ring]!;
      positions[offset + 2] = Math.sin(angle) * radial[ring]!;
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let ring = 0; ring < rings - 1; ring++) {
      const a = i * rings + ring;
      const b = (i + 1) * rings + ring;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildEdenRidge(def: MapDef, fogColor = 0xbfd6e4): THREE.Group {
  const group = new THREE.Group();
  const size = def.size;
  const fogC = new THREE.Color(fogColor);
  const half = size / 2;
  const random = seededRandom(0x4544454e);
  const heightAt = (x: number, z: number) => sampleVistaGroundHeight(def, x, z);
  const farMat = new THREE.MeshBasicMaterial({
    color: fogC.clone().lerp(new THREE.Color(0x667789), 0.42),
    fog: true,
  });
  const nearMat = new THREE.MeshBasicMaterial({
    color: fogC.clone().lerp(new THREE.Color(0x4f6250), 0.66),
    fog: true,
  });
  const far = new THREE.Mesh(buildRidgeBandGeometry(half + 480, 108, 6.4), farMat);
  far.frustumCulled = false;
  group.add(far);
  const near = new THREE.Mesh(buildRidgeBandGeometry(half + 205, 44, 2.7), nearMat);
  near.frustumCulled = false;
  group.add(near);

  // The previous ridge began behind a completely empty grass apron. Continue
  // Eden's woodland immediately outside the playable square, while preserving
  // a narrower eastern wetland corridor instead of clearing most of the view.
  const treeCount = 220;
  const trees = new THREE.InstancedMesh(
    mergeTreeGeo(),
    new THREE.MeshStandardMaterial({ color: 0x36533b, roughness: 1, metalness: 0 }),
    treeCount,
  );
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  let treeIndex = 0;
  for (let attempt = 0; treeIndex < treeCount && attempt < 1600; attempt++) {
    const ang = random() * Math.PI * 2;
    const r = half + 30 + random() * 168;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (x > half && Math.abs(z - 40) < 48) continue;
    const ground = heightAt(x, z);
    position.set(x, ground - 0.25, z);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2);
    const treeScale = 0.62 + random() * 0.84;
    scale.set(treeScale, treeScale * (0.9 + random() * 0.32), treeScale);
    matrix.compose(position, rotation, scale);
    trees.setMatrixAt(treeIndex, matrix);
    trees.setColorAt(
      treeIndex,
      new THREE.Color().setHSL(0.30 + random() * 0.035, 0.2 + random() * 0.12, 0.24 + random() * 0.08),
    );
    treeIndex++;
  }
  trees.count = treeIndex;
  trees.instanceMatrix.needsUpdate = true;
  if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
  trees.frustumCulled = false;

  // Establish a forest floor instead of placing identical conifers on an
  // uninterrupted lawn. Low shrub colonies fill the woodland edge, while a
  // small number of grounded fallen trunks create age and storm history. All
  // pieces remain batched, render-only vista detail beyond the legal wall.
  const shrubCount = 230;
  const shrubs = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0x48633b, roughness: 1, metalness: 0 }),
    shrubCount,
  );
  let shrubIndex = 0;
  for (let attempt = 0; shrubIndex < shrubCount && attempt < 1400; attempt++) {
    const ang = random() * Math.PI * 2;
    const r = half + 8 + random() * 112;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (x > half && Math.abs(z - 40) < 42) continue;
    const ground = heightAt(x, z);
    const width = 0.55 + random() * 1.45;
    const height = 0.32 + random() * 0.62;
    position.set(x, ground + height * 0.62 - 0.12, z);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2);
    scale.set(width, height, 0.5 + random() * 1.15);
    matrix.compose(position, rotation, scale);
    shrubs.setMatrixAt(shrubIndex, matrix);
    shrubs.setColorAt(
      shrubIndex,
      new THREE.Color().setHSL(0.25 + random() * 0.08, 0.25 + random() * 0.16, 0.25 + random() * 0.1),
    );
    shrubIndex++;
  }
  shrubs.count = shrubIndex;
  shrubs.instanceMatrix.needsUpdate = true;
  if (shrubs.instanceColor) shrubs.instanceColor.needsUpdate = true;
  shrubs.frustumCulled = false;

  const logCount = 28;
  const logGeometry = new THREE.CylinderGeometry(0.5, 0.62, 1, 7);
  const logs = new THREE.InstancedMesh(
    logGeometry,
    new THREE.MeshStandardMaterial({ color: 0x4c3f31, roughness: 1, metalness: 0 }),
    logCount,
  );
  for (let i = 0; i < logCount; i++) {
    const ang = random() * Math.PI * 2;
    const r = half + 18 + random() * 105;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const ground = heightAt(x, z);
    position.set(x, ground + 0.36, z);
    rotation.setFromEuler(new THREE.Euler(0, random() * Math.PI * 2, Math.PI / 2));
    scale.set(0.65 + random() * 0.45, 3.8 + random() * 4.8, 0.65 + random() * 0.45);
    matrix.compose(position, rotation, scale);
    logs.setMatrixAt(i, matrix);
  }
  logs.instanceMatrix.needsUpdate = true;
  logs.frustumCulled = false;

  // A restrained maintenance line on the north side extends the facility's
  // utilities into the vista. Ten poles and low service sheds provide scale
  // without advertising traversable out-of-bounds buildings.
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const poleCount = 10;
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x48565b, roughness: 0.82, metalness: 0.38 });
  const poles = new THREE.InstancedMesh(box, poleMat, poleCount);
  const arms = new THREE.InstancedMesh(box, poleMat, poleCount);
  for (let i = 0; i < poleCount; i++) {
    const x = -half - 14 + (i + 0.5) * ((size + 28) / poleCount);
    const z = half + 27 + (i % 2) * 5;
    const ground = heightAt(x, z) - 0.25;
    position.set(x, ground, z);
    rotation.identity();
    scale.set(0.24, 7.6, 0.24);
    matrix.compose(position, rotation, scale);
    poles.setMatrixAt(i, matrix);
    position.y = ground + 7.25;
    scale.set(2.9, 0.18, 0.18);
    matrix.compose(position, rotation, scale);
    arms.setMatrixAt(i, matrix);
  }
  poles.instanceMatrix.needsUpdate = true;
  arms.instanceMatrix.needsUpdate = true;
  poles.frustumCulled = false;
  arms.frustumCulled = false;

  const shedCount = 8;
  const sheds = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x58696c, roughness: 0.9, metalness: 0.12 }),
    shedCount,
  );
  const shedRoofs = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x2f3c40, roughness: 0.75, metalness: 0.26 }),
    shedCount,
  );
  for (let i = 0; i < shedCount; i++) {
    const onNorth = i < 5;
    const x = onNorth ? -175 + i * 82 : half + 68 + (i - 5) * 55;
    const z = onNorth ? half + 76 + (i % 2) * 24 : -175 + (i - 5) * 174;
    const ground = heightAt(x, z) - 0.35;
    const width = 10 + (i % 3) * 2.5;
    const depth = 7 + (i % 2) * 2;
    const height = 3.8 + (i % 3) * 0.7;
    position.set(x, ground, z);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), onNorth ? 0 : Math.PI / 2);
    scale.set(width, height, depth);
    matrix.compose(position, rotation, scale);
    sheds.setMatrixAt(i, matrix);
    position.y = ground + height;
    scale.set(width + 0.7, 0.45, depth + 0.7);
    matrix.compose(position, rotation, scale);
    shedRoofs.setMatrixAt(i, matrix);
  }
  sheds.instanceMatrix.needsUpdate = true;
  shedRoofs.instanceMatrix.needsUpdate = true;
  sheds.frustumCulled = false;
  shedRoofs.frustumCulled = false;
  group.add(trees, shrubs, logs, poles, arms, sheds, shedRoofs);
  return group;
}

/**
 * Height contract for the render-only continuation of Ashara's main highway.
 * The first vertex is identical to the authored road ribbon, then the road
 * eases onto the wider vista terrain instead of jumping between flat boxes.
 */
export function sampleDesertHighwayHeight(def: MapDef, x: number, z: number): number {
  const authored = def.terrainHeight?.(x, z) ?? sampleVistaGroundHeight(def, x, z);
  const join = def.size / 2 + 0.2;
  const outside = Math.max(0, Math.abs(x) - join);
  const blend = smoothstep(Math.min(1, outside / 24));
  return THREE.MathUtils.lerp(authored, sampleVistaGroundHeight(def, x, z), blend);
}

function buildDesertRidge(def: MapDef, fogColor: number, mats?: MaterialLibrary): THREE.Group {
  const group = new THREE.Group();
  const size = def.size;
  const half = size / 2;
  const fog = new THREE.Color(fogColor);
  const random = seededRandom(0x41534835);
  const heightAt = (x: number, z: number) => sampleVistaGroundHeight(def, x, z);
  const nearMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x766956).lerp(fog, 0.28),
    fog: true,
  });
  const farMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x6c6870).lerp(fog, 0.52),
    fog: false,
  });
  const far = new THREE.Mesh(buildRidgeBandGeometry(half + 515, 118, 4.2), farMat);
  far.frustumCulled = false;
  group.add(far);
  const near = new THREE.Mesh(buildRidgeBandGeometry(half + 190, 50, 1.4), nearMat);
  near.frustumCulled = false;
  group.add(near);

  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();

  // Continue the logistics highway beyond both east/west clamps. The old
  // implementation placed one flat box at each segment centre: every change
  // in terrain height therefore became a transverse step, and its bespoke
  // brown material changed at the same seam. These ribbons share the exact
  // playable-road edge, widths, vertical offsets and material family.
  const roadMaterial = mats?.get('asphaltDesert').clone()
    ?? new THREE.MeshStandardMaterial({ color: 0x4d4437, roughness: 0.96, metalness: 0 });
  const shoulderMaterial = mats?.get('dirt').clone()
    ?? new THREE.MeshStandardMaterial({ color: 0x8d7654, roughness: 1, metalness: 0 });
  const addRibbon = (
    start: number,
    end: number,
    width: number,
    yOffset: number,
    material: THREE.Material,
  ): THREE.Mesh => {
    const steps = Math.max(2, Math.ceil(Math.abs(end - start) / 2));
    const positions: number[] = [];
    const uvs: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = THREE.MathUtils.lerp(start, end, t);
      for (const side of [-1, 1]) {
        const z = -5 + side * width / 2;
        positions.push(x, sampleDesertHighwayHeight(def, x, z) + yOffset, z);
        uvs.push(t * Math.abs(end - start) / 8, side < 0 ? 0 : 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(buildTerrainRibbonIndices(steps), 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  };
  const join = half + 0.2;
  const extent = half + 160;
  const shoulders = [
    addRibbon(-join, -extent, 10.8, 0.064, shoulderMaterial),
    addRibbon(join, extent, 10.8, 0.064, shoulderMaterial),
  ];
  const roads = [
    addRibbon(-join, -extent, 9, 0.116, roadMaterial),
    addRibbon(join, extent, 9, 0.116, roadMaterial),
  ];

  // Lane marks are one merged terrain-following mesh rather than flat boxes,
  // so they neither float above a crest nor disappear into a dip.
  const dashPositions: number[] = [];
  const dashUvs: number[] = [];
  const dashIndices: number[] = [];
  let dashVertex = 0;
  for (const side of [-1, 1]) {
    for (let step = 0; step < 14; step++) {
      const centre = side * (join + 4 + step * 11.2);
      const x0 = centre - 2.7;
      const x1 = centre + 2.7;
      for (const x of [x0, x1]) {
        for (const z of [-5.08, -4.92]) {
          dashPositions.push(x, sampleDesertHighwayHeight(def, x, z) + 0.132, z);
          dashUvs.push(x === x0 ? 0 : 1, z < -5 ? 0 : 1);
        }
      }
      dashIndices.push(
        dashVertex, dashVertex + 2, dashVertex + 1,
        dashVertex + 2, dashVertex + 3, dashVertex + 1,
      );
      dashVertex += 4;
    }
  }
  const dashGeometry = new THREE.BufferGeometry();
  dashGeometry.setAttribute('position', new THREE.Float32BufferAttribute(dashPositions, 3));
  dashGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(dashUvs, 2));
  dashGeometry.setIndex(dashIndices);
  dashGeometry.computeVertexNormals();
  dashGeometry.computeBoundingBox();
  dashGeometry.computeBoundingSphere();
  const dashes = new THREE.Mesh(
    dashGeometry,
    new THREE.MeshBasicMaterial({ color: 0xc6ad78, fog: true }),
  );
  dashes.receiveShadow = false;

  // Continue the existing roadside utility rhythm so the highway does not
  // lose all human infrastructure at the exact gameplay boundary.
  const poleCount = 14;
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x4c4033, roughness: 0.94, metalness: 0 });
  const poles = new THREE.InstancedMesh(box, poleMat, poleCount);
  const crossbars = new THREE.InstancedMesh(box, poleMat, poleCount);
  for (let i = 0; i < poleCount; i++) {
    const side = i < poleCount / 2 ? -1 : 1;
    const step = i % (poleCount / 2);
    const x = side * (half + 10 + step * 27);
    const z = -17;
    const ground = heightAt(x, z) - 0.2;
    position.set(x, ground, z);
    rotation.identity();
    scale.set(0.3, 8.2, 0.3);
    matrix.compose(position, rotation, scale);
    poles.setMatrixAt(i, matrix);
    position.y = ground + 7.55;
    scale.set(5.2, 0.2, 0.2);
    matrix.compose(position, rotation, scale);
    crossbars.setMatrixAt(i, matrix);
  }
  poles.instanceMatrix.needsUpdate = true;
  crossbars.instanceMatrix.needsUpdate = true;
  poles.frustumCulled = false;
  crossbars.frustumCulled = false;

  // Low scrub, rocks and compact waystations form the missing desert midground
  // while leaving a broad clear band around the continued highway.
  const scrubCount = 120;
  const scrubGeo = new THREE.IcosahedronGeometry(1, 0);
  const scrub = new THREE.InstancedMesh(
    scrubGeo,
    new THREE.MeshStandardMaterial({ color: 0x6e6845, roughness: 1, metalness: 0 }),
    scrubCount,
  );
  let scrubIndex = 0;
  for (let attempt = 0; scrubIndex < scrubCount && attempt < 1800; attempt++) {
    const ang = random() * Math.PI * 2;
    const r = half + 14 + random() * 178;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (Math.abs(z + 5) < 17) continue;
    const ground = heightAt(x, z);
    position.set(x, ground + 0.45, z);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2);
    const sizeScale = 0.8 + random() * 1.5;
    scale.set(sizeScale * 1.35, sizeScale * 0.5, sizeScale);
    matrix.compose(position, rotation, scale);
    scrub.setMatrixAt(scrubIndex++, matrix);
  }
  scrub.count = scrubIndex;
  scrub.instanceMatrix.needsUpdate = true;
  scrub.frustumCulled = false;

  const rockCount = 72;
  const rocks = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ color: 0x786b59, roughness: 0.98, metalness: 0 }),
    rockCount,
  );
  let rockIndex = 0;
  for (let attempt = 0; rockIndex < rockCount && attempt < 1400; attempt++) {
    const ang = random() * Math.PI * 2;
    const r = half + 30 + random() * 195;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (Math.abs(z + 5) < 20) continue;
    const rockScale = 1.2 + random() * 3;
    position.set(x, heightAt(x, z) + rockScale * 0.42, z);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2);
    scale.set(rockScale * (0.8 + random() * 0.6), rockScale * (0.55 + random() * 0.35), rockScale);
    matrix.compose(position, rotation, scale);
    rocks.setMatrixAt(rockIndex++, matrix);
  }
  rocks.count = rockIndex;
  rocks.instanceMatrix.needsUpdate = true;
  rocks.frustumCulled = false;

  const outpostCount = 8;
  const outposts = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x786754, roughness: 0.97, metalness: 0 }),
    outpostCount,
  );
  const outpostRoofs = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x493f37, roughness: 0.83, metalness: 0.18 }),
    outpostCount,
  );
  for (let i = 0; i < outpostCount; i++) {
    const ang = i / outpostCount * Math.PI * 2 + 0.28;
    const r = half + 112 + (i % 3) * 48;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const ground = heightAt(x, z) - 0.45;
    const width = 9 + (i % 3) * 2;
    const depth = 7 + (i % 2) * 2;
    const height = 3.5 + (i % 3) * 0.8;
    position.set(x, ground, z);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang + Math.PI / 2);
    scale.set(width, height, depth);
    matrix.compose(position, rotation, scale);
    outposts.setMatrixAt(i, matrix);
    position.y = ground + height;
    scale.set(width + 0.8, 0.35, depth + 0.8);
    matrix.compose(position, rotation, scale);
    outpostRoofs.setMatrixAt(i, matrix);
  }
  outposts.instanceMatrix.needsUpdate = true;
  outpostRoofs.instanceMatrix.needsUpdate = true;
  outposts.frustumCulled = false;
  outpostRoofs.frustumCulled = false;

  // A compact solar/service yard gives the broad northern approach a legible
  // middle distance. Random scatter alone became sub-pixel noise from the
  // legal edge, leaving this entire quadrant visually empty even though the
  // terrain itself continued correctly. The yard is deliberately outside the
  // play clamp and remains render-only.
  const yardCount = 6;
  const yardBodies = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x806b52, roughness: 0.95, metalness: 0.02 }),
    yardCount,
  );
  const yardCanopies = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x55483d, roughness: 0.78, metalness: 0.24 }),
    yardCount,
  );
  const yardPosts = new THREE.InstancedMesh(box, poleMat, yardCount * 2);
  let yardPostIndex = 0;
  for (let i = 0; i < yardCount; i++) {
    const x = -155 + i * 62;
    const z = half + 45 + (i % 2) * 18;
    const ground = heightAt(x, z) - 0.18;
    const width = 12 + (i % 3) * 2.2;
    position.set(x, ground, z);
    rotation.identity();
    scale.set(width, 2.8 + (i % 2) * 0.5, 7.5);
    matrix.compose(position, rotation, scale);
    yardBodies.setMatrixAt(i, matrix);
    position.y = ground + 3.35 + (i % 2) * 0.5;
    scale.set(width + 4.5, 0.32, 11.5);
    matrix.compose(position, rotation, scale);
    yardCanopies.setMatrixAt(i, matrix);
    for (const side of [-1, 1]) {
      position.set(x + side * (width / 2 + 1.55), ground, z - 3.4);
      scale.set(0.24, 3.45 + (i % 2) * 0.5, 0.24);
      matrix.compose(position, rotation, scale);
      yardPosts.setMatrixAt(yardPostIndex++, matrix);
    }
  }
  yardBodies.instanceMatrix.needsUpdate = true;
  yardCanopies.instanceMatrix.needsUpdate = true;
  yardPosts.instanceMatrix.needsUpdate = true;
  yardBodies.frustumCulled = false;
  yardCanopies.frustumCulled = false;
  yardPosts.frustumCulled = false;

  const panelCount = 18;
  const panels = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0x28333a, roughness: 0.48, metalness: 0.48 }),
    panelCount,
  );
  const panelStands = new THREE.InstancedMesh(box, poleMat, panelCount);
  const panelTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0, 0));
  for (let i = 0; i < panelCount; i++) {
    const row = i >= panelCount / 2 ? 1 : 0;
    const slot = i % (panelCount / 2);
    const x = -168 + slot * 42;
    const z = half + 22 + row * 13;
    const ground = heightAt(x, z);
    position.set(x, ground + 1.65, z);
    scale.set(10.5, 0.18, 4.5);
    matrix.compose(position, panelTilt, scale);
    panels.setMatrixAt(i, matrix);
    position.set(x, ground, z);
    rotation.identity();
    scale.set(0.3, 1.55, 0.3);
    matrix.compose(position, rotation, scale);
    panelStands.setMatrixAt(i, matrix);
  }
  panels.instanceMatrix.needsUpdate = true;
  panelStands.instanceMatrix.needsUpdate = true;
  panels.frustumCulled = false;
  panelStands.frustumCulled = false;

  group.add(
    ...shoulders, ...roads, dashes, poles, crossbars, scrub, rocks,
    outposts, outpostRoofs, yardBodies, yardCanopies, yardPosts, panels, panelStands,
  );
  return group;
}

function buildDesertDust(size: number): {
  points: THREE.Points;
  update: (viewer: THREE.Vector3, time: number) => void;
  dispose: () => void;
} {
  const count = 150;
  const radius = Math.min(115, size * 0.24);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const a = i * 2.399963229728653;
    const r = radius * Math.sqrt((i + 0.5) / count);
    seeds[i * 4] = Math.cos(a) * r;
    const heightSeed = ((i * 37) % 97) / 97;
    seeds[i * 4 + 1] = 0.18 + heightSeed * heightSeed * 2.5;
    seeds[i * 4 + 2] = Math.sin(a) * r;
    seeds[i * 4 + 3] = 0.6 + ((i * 53) % 89) / 89 * 1.4;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const spriteSize = 32;
  const spriteData = new Uint8Array(spriteSize * spriteSize * 4);
  for (let y = 0; y < spriteSize; y++) {
    for (let x = 0; x < spriteSize; x++) {
      const nx = (x + 0.5) / spriteSize * 2 - 1;
      const ny = (y + 0.5) / spriteSize * 2 - 1;
      const radius2 = nx * nx + ny * ny;
      const alpha = Math.max(0, 1 - radius2);
      const offset = (y * spriteSize + x) * 4;
      spriteData[offset] = 255;
      spriteData[offset + 1] = 255;
      spriteData[offset + 2] = 255;
      spriteData[offset + 3] = Math.round(alpha * alpha * 255);
    }
  }
  const sprite = new THREE.DataTexture(spriteData, spriteSize, spriteSize, THREE.RGBAFormat);
  sprite.needsUpdate = true;
  const material = new THREE.PointsMaterial({
    color: 0xb69b70,
    map: sprite,
    alphaTest: 0.015,
    size: 1.15,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.065,
    depthWrite: false,
    fog: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  const update = (viewer: THREE.Vector3, time: number) => {
    points.position.set(viewer.x, 0, viewer.z);
    for (let i = 0; i < count; i++) {
      const baseX = seeds[i * 4]!;
      const baseY = seeds[i * 4 + 1]!;
      const baseZ = seeds[i * 4 + 2]!;
      const speed = seeds[i * 4 + 3]!;
      positions[i * 3] = ((baseX + time * speed * 2.3 + radius) % (radius * 2)) - radius;
      positions[i * 3 + 1] = Math.max(0.08, baseY + Math.sin(time * 0.7 + i * 0.37) * 0.18);
      positions[i * 3 + 2] = baseZ + Math.sin(time * 0.16 + i * 1.13) * 2.2;
    }
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  };
  return {
    points,
    update,
    dispose: () => {
      geometry.dispose();
      sprite.dispose();
      material.dispose();
    },
  };
}

/** Seamless deterministic sand grain and wind ripples for close terrain. */
function buildSandMicroTexture(): THREE.DataTexture {
  const size = 384;
  const data = new Uint8Array(size * size * 4);
  const tau = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const warp = Math.sin(tau * v * 3) * 0.055 + Math.sin(tau * v * 7) * 0.018;
      const longRipple = Math.sin(tau * (u * 13 + warp));
      const crossRipple = Math.sin(tau * (v * 5 - u * 2)) * 0.34;
      const hash = Math.sin((x * 127.1 + y * 311.7) * 0.0174533) * 43758.5453;
      const grain = (hash - Math.floor(hash)) * 2 - 1;
      const shade = THREE.MathUtils.clamp(0.955 + longRipple * 0.014 + crossRipple * 0.008 + grain * 0.019, 0.87, 1);
      const offset = (y * size + x) * 4;
      data[offset] = Math.round(255 * shade);
      data[offset + 1] = Math.round(249 * shade);
      data[offset + 2] = Math.round(236 * shade);
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/**
 * One terrain mesh covering the playable area (exact heightfield match)
 * plus a wide skirt continuing the landscape beyond the boundary.
 */
function buildTerrain(def: MapDef, grassTex?: THREE.Texture | null): { mesh: THREE.Mesh; dispose: () => void } | null {
  const sample = def.terrainHeight ?? null;
  const isCity = def.id === 'neocity';
  const isDesert = def.id === 'ashara';
  const pal = PALETTES[def.id] ?? PALETTES['eden']!;
  const span = def.size * 3.2;
  const half = def.size / 2;
  const segments = isCity ? 24 : SEG;
  const cutouts = def.terrainCutouts ?? [];
  const removals = isCity
    ? [...cutouts, { minX: -half - 1.5, maxX: half + 1.5, minZ: -half - 1.5, maxZ: half + 1.5, surfaceY: 0 }]
    : cutouts;
  const sampleHeightAt = (x: number, z: number): number => sampleVistaGroundHeight(def, x, z);
  let geo: THREE.BufferGeometry;
  if (def.terrainMesh) {
    // The playable triangles are the exact compiled surface used by physics.
    // The surrounding grid has a rectangular hole for that surface, so vista
    // detail cannot re-triangulate, overlap or visually drift from gameplay.
    const skirt = buildTerrainGridMesh({
      minX: -span / 2,
      maxX: span / 2,
      minZ: -span / 2,
      maxZ: span / 2,
      segmentsX: segments,
      segmentsZ: segments,
      heightAt: sampleHeightAt,
      removals: [{
        minX: -half,
        maxX: half,
        minZ: -half,
        maxZ: half,
        surfaceY: 0,
      }],
    });
    const parts: TerrainGridMesh[] = [def.terrainMesh, skirt];
    const vertexCount = parts.reduce((count, part) => count + part.positions.length / 3, 0);
    const indexCount = parts.reduce((count, part) => count + part.indices.length, 0);
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(indexCount);
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const part of parts) {
      positions.set(part.positions, vertexOffset * 3);
      for (let i = 0; i < part.positions.length / 3; i++) {
        const x = part.positions[i * 3]!;
        const z = part.positions[i * 3 + 2]!;
        uvs[(vertexOffset + i) * 2] = x / span + 0.5;
        uvs[(vertexOffset + i) * 2 + 1] = z / span + 0.5;
      }
      for (let i = 0; i < part.indices.length; i++) {
        indices[indexOffset + i] = part.indices[i]! + vertexOffset;
      }
      vertexOffset += part.positions.length / 3;
      indexOffset += part.indices.length;
    }
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
  } else if (removals.length > 0 || sample) {
    const grid = buildTerrainGridMesh({
      minX: -span / 2,
      maxX: span / 2,
      minZ: -span / 2,
      maxZ: span / 2,
      segmentsX: segments,
      segmentsZ: segments,
      heightAt: sampleHeightAt,
      removals,
    });
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(grid.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(grid.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(grid.indices, 1));
  } else {
    // Truly flat maps without a sampler can keep the cheaper plane. Sampled
    // maps must use the same height data as physics and authored structures.
    const plane = new THREE.PlaneGeometry(span, span, segments, segments);
    plane.rotateX(-Math.PI / 2);
    geo = plane;
  }
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  // With a real albedo texture the vertex layer becomes a near-white
  // multiplier (the texture carries hue); without it the palette colors
  // carry the look on their own.
  const texMode = !!grassTex;
  const cGrass = new THREE.Color(texMode ? (isDesert ? 0xd8c39d : 0xf4f6ec) : pal.grass);
  // Far/skirt tints must stay clearly green even under the warm sun — the
  // raw grass albedo reads as tan dunes at distance otherwise.
  const cGrassFar = new THREE.Color(texMode ? (isDesert ? 0xa58c68 : 0xa8bd9a) : pal.grassFar);
  const cRock = new THREE.Color(texMode ? (isDesert ? 0x8f8272 : 0x99a294) : pal.rock);
  const cSand = new THREE.Color(texMode ? (isDesert ? 0xe1c995 : 0xe4d9b4) : pal.sand);
  const cBed = new THREE.Color(texMode ? (isDesert ? 0x76634d : 0x5c6a5f) : pal.bed);
  const cAsphalt = new THREE.Color(0x23262b);
  const cDry = new THREE.Color(texMode ? (isDesert ? 0xc2a675 : 0xd6cda6) : 0x9a9160);
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)!;
    const z = pos.getZ(i)!;
    const h = sampleHeightAt(x, z);
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
      tmp.lerp(cDry, Math.min(isDesert ? 0.72 : 0.5, dry));
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
  } else if (isDesert) {
    map = buildSandMicroTexture();
    // Repeat the seamless field every 8 m: thirteen internal ridges then read
    // as sub-metre wind ripples instead of broad water-like corrugation.
    // Broad colour breakup remains in the vertex palette.
    map.repeat.set(span / 8, span / 8);
  }
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
  });
  if (map) {
    mat.map = map;
    if (isDesert) {
      mat.bumpMap = map;
      mat.bumpScale = 0.018;
    }
  }
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

  // The available dirt scan is dark, damp forest soil. Desert terrain uses
  // the dedicated vertex palette until a provenance-cleared sand scan ships.
  const terrainSet = mats && def.id !== 'ashara' && def.id !== 'neocity' ? peekTextureSet('grass') : null;
  const terrain = buildTerrain(def, terrainSet?.color ?? null);
  if (terrain) {
    group.add(terrain.mesh);
    disposables.push(terrain.dispose);
  }

  if (def.id === 'neocity') {
    const continuation = buildCityContinuation(def.size);
    group.add(continuation);
    disposables.push(() => {
      (continuation.userData.facadeTextures as THREE.Texture[] | undefined)?.forEach((texture) => texture.dispose());
      continuation.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
      });
    });
    const skyline = buildSkyline(def.size);
    group.add(skyline);
    disposables.push(() => {
      (skyline.userData.windowTextures as THREE.Texture[] | undefined)?.forEach((texture) => texture.dispose());
      skyline.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
      });
    });
  } else if (def.id === 'oldfront') {
    const rural = buildRuralHorizon(def);
    group.add(rural);
    disposables.push(() => rural.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }));
  } else if (def.id === 'ashara') {
    const ridge = buildDesertRidge(def, def.sky.fogColor, mats);
    group.add(ridge);
    disposables.push(() => ridge.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }));
  } else {
    const ridge = buildEdenRidge(def, def.sky.fogColor);
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

  const dust = def.id === 'ashara' ? buildDesertDust(def.size) : null;
  if (dust) {
    group.add(dust.points);
    disposables.push(dust.dispose);
  }

  return {
    group,
    update: (viewPos, time) => {
      barrier.update(viewPos, time);
      dust?.update(viewPos, time);
    },
    dispose: () => {
      for (const d of disposables) d();
    },
  };
}
