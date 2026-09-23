import * as THREE from 'three';

export type SupportStyle = 'under' | 'side' | 'pump' | 'over';

export interface HandPoseInput {
  reloadPhase: number;
  supportStyle: SupportStyle;
  magLocal: THREE.Vector3 | null;
  pumpOffset: number;
  pumpHand: boolean;
  ads: number;
  boltPhase: number;
  boltLocal: THREE.Vector3 | null;
  triggerAmount?: number;
}

export interface HandRig {
  right: THREE.Group;
  left: THREE.Group;
  wristR: THREE.Object3D;
  wristL: THREE.Object3D;
  configure(anchors: { gripR: THREE.Vector3; gripL: THREE.Vector3; scale: number }): void;
  pose(input: HandPoseInput): void;
}

interface HandMats {
  glove: THREE.MeshStandardMaterial;
  shell: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  palm: THREE.MeshStandardMaterial;
}

let fabricBump: THREE.CanvasTexture | null = null;
let handMatsSingleton: HandMats | null = null;

function getFabricBump(): THREE.CanvasTexture | null {
  if (fabricBump) return fabricBump;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 64, 64);
  for (let i = -64; i < 128; i += 4) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 64, 64);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.moveTo(i + 2, 0);
    ctx.lineTo(i + 66, 64);
    ctx.stroke();
  }
  fabricBump = new THREE.CanvasTexture(canvas);
  fabricBump.wrapS = fabricBump.wrapT = THREE.RepeatWrapping;
  fabricBump.repeat.set(6, 6);
  fabricBump.colorSpace = THREE.NoColorSpace;
  return fabricBump;
}

export function getHandMaterialSet(): HandMats {
  if (handMatsSingleton) return handMatsSingleton;
  const bumpMap = getFabricBump();
  handMatsSingleton = {
    glove: new THREE.MeshStandardMaterial({ color: 0x5a626b, roughness: 0.82, metalness: 0.02, bumpMap, bumpScale: 0.00018 }),
    shell: new THREE.MeshStandardMaterial({ color: 0x646d78, roughness: 0.84, metalness: 0.02, bumpMap, bumpScale: 0.0001 }),
    skin: new THREE.MeshStandardMaterial({ color: 0x2f343a, roughness: 0.88 }),
    plate: new THREE.MeshStandardMaterial({ color: 0x394049, roughness: 0.54, metalness: 0.12 }),
    palm: new THREE.MeshStandardMaterial({ color: 0x474e56, roughness: 0.9 }),
  };
  return handMatsSingleton;
}

interface SurfaceVertex {
  position: THREE.Vector3;
  uv: THREE.Vector2;
  weights: number[];
}

interface SurfaceFace {
  vertices: number[];
  material: number;
}

function mixVertices(vertices: SurfaceVertex[], factors?: number[]): SurfaceVertex {
  const result: SurfaceVertex = {
    position: new THREE.Vector3(), uv: new THREE.Vector2(), weights: new Array<number>(vertices[0]!.weights.length).fill(0),
  };
  vertices.forEach((vertex, i) => {
    const factor = factors?.[i] ?? 1 / vertices.length;
    result.position.addScaledVector(vertex.position, factor);
    result.uv.addScaledVector(vertex.uv, factor);
    vertex.weights.forEach((weight, bone) => { result.weights[bone]! += weight * factor; });
  });
  return result;
}

class SkinSurface {
  vertices: SurfaceVertex[] = [];
  faces: SurfaceFace[] = [];

  constructor(private readonly boneCount: number) {}

  vertex(x: number, y: number, z: number, bone = 0, parent = bone, blend = 1): number {
    const weights = new Array<number>(this.boneCount).fill(0);
    weights[parent] = 1 - blend;
    weights[bone]! += blend;
    this.vertices.push({ position: new THREE.Vector3(x, y, z), uv: new THREE.Vector2(x * 8 + y * 3 + 0.5, z * 7 + y * 2), weights });
    return this.vertices.length - 1;
  }

  face(vertices: number[], material = 0): void {
    this.faces.push({ vertices, material });
  }

  bridge(a: number[], b: number[], material = 0): void {
    for (let j = 0; j < a.length; j++) {
      const next = (j + 1) % a.length;
      this.face([a[j]!, a[next]!, b[next]!, b[j]!], material);
    }
  }

  cap(ring: number[], material = 0): void {
    const center = this.vertices.length;
    this.vertices.push(mixVertices(ring.map(index => this.vertices[index]!)));
    for (let j = 0; j < ring.length; j += 2) {
      this.face([ring[j]!, ring[(j + 1) % ring.length]!, ring[(j + 2) % ring.length]!, center], material);
    }
  }

  subdivide(): void {
    const facePoints = this.faces.map(face => mixVertices(face.vertices.map(index => this.vertices[index]!)));
    const edges = new Map<string, { a: number; b: number; faces: number[]; index: number }>();
    const vertexFaces = this.vertices.map(() => [] as number[]);
    const neighbors = this.vertices.map(() => new Set<number>());
    const key = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`;
    this.faces.forEach((face, f) => {
      face.vertices.forEach((a, j) => {
        const b = face.vertices[(j + 1) % face.vertices.length]!;
        vertexFaces[a]!.push(f);
        neighbors[a]!.add(b);
        neighbors[b]!.add(a);
        const id = key(a, b);
        const edge = edges.get(id) ?? { a, b, faces: [], index: -1 };
        edge.faces.push(f);
        edges.set(id, edge);
      });
    });
    const vertices = this.vertices.map((vertex, i) => {
      const adjacent = [...neighbors[i]!];
      const n = adjacent.length;
      const faceAverage = mixVertices(vertexFaces[i]!.map(f => facePoints[f]!));
      const edgeAverage = mixVertices(adjacent.map(j => mixVertices([vertex, this.vertices[j]!])));
      const result = mixVertices([faceAverage, edgeAverage, vertex], [1 / n, 2 / n, (n - 3) / n]);
      result.weights = mixVertices([vertex, faceAverage], [0.8, 0.2]).weights;
      result.uv.copy(vertex.uv);
      return result;
    });
    for (const edge of edges.values()) {
      edge.index = vertices.length;
      vertices.push(mixVertices([this.vertices[edge.a]!, this.vertices[edge.b]!, ...edge.faces.map(f => facePoints[f]!)]));
    }
    const faceOffset = vertices.length;
    vertices.push(...facePoints);
    const faces: SurfaceFace[] = [];
    this.faces.forEach((face, f) => {
      face.vertices.forEach((a, j) => {
        const b = face.vertices[(j + 1) % face.vertices.length]!;
        const previous = face.vertices[(j + face.vertices.length - 1) % face.vertices.length]!;
        faces.push({ vertices: [a, edges.get(key(a, b))!.index, faceOffset + f, edges.get(key(previous, a))!.index], material: face.material });
      });
    });
    this.vertices = vertices;
    this.faces = faces;
  }

  geometry(mirrored = false): THREE.BufferGeometry {
    const positions: number[] = [];
    const uv: number[] = [];
    const skinIndices: number[] = [];
    const skinWeights: number[] = [];
    for (const vertex of this.vertices) {
      positions.push(vertex.position.x * (mirrored ? -1 : 1), vertex.position.y, vertex.position.z);
      uv.push(vertex.uv.x, vertex.uv.y);
      const weights = vertex.weights.map((weight, bone) => ({ bone, weight })).sort((a, b) => b.weight - a.weight).slice(0, 4);
      const total = weights.reduce((sum, item) => sum + item.weight, 0);
      for (let i = 0; i < 4; i++) {
        skinIndices.push(weights[i]?.bone ?? 0);
        skinWeights.push((weights[i]?.weight ?? 0) / total);
      }
    }
    const geometry = new THREE.BufferGeometry();
    const indices: number[] = [];
    for (let material = 0; material < 5; material++) {
      const start = indices.length;
      for (const face of this.faces) {
        if (face.material !== material) continue;
        for (let i = 1; i < face.vertices.length - 1; i++) {
          const a = face.vertices[0]!;
          const b = face.vertices[i]!;
          const c = face.vertices[i + 1]!;
          indices.push(a, mirrored ? c : b, mirrored ? b : c);
        }
      }
      if (indices.length > start) geometry.addGroup(start, indices.length - start, material);
    }
    geometry.setIndex(indices);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

interface FingerChain {
  bones: THREE.Bone[];
  index: number;
}

interface Glove {
  group: THREE.Group;
  mesh: THREE.SkinnedMesh;
  metacarpals: THREE.Bone[];
  fingers: FingerChain[];
  thumb: THREE.Bone[];
  contacts: number[][];
  palmContacts: number[];
  thumbContacts: number[];
  gripCache: Map<string, number[]>;
  side: 1 | -1;
}

function makeBone(name: string, x: number, y: number, z: number, parent?: THREE.Bone): THREE.Bone {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.set(x, y, z);
  parent?.add(bone);
  return bone;
}

function bindSurface(surface: SkinSurface, bones: THREE.Bone[], materials: THREE.MeshStandardMaterial[], mirrored = false): THREE.SkinnedMesh {
  const mesh = new THREE.SkinnedMesh(surface.geometry(mirrored), materials);
  mesh.add(bones[0]!);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.frustumCulled = false;
  mesh.castShadow = mesh.receiveShadow = false;
  return mesh;
}

function buildHand(mats: HandMats, side: 1 | -1, fist = false): Glove {
  const surface = new SkinSurface(20);
  const root = makeBone('wrist', 0, 0, 0);
  const metacarpals = Array.from({ length: 4 }, (_, i) => makeBone(`metacarpal-${3 - i}`, (i - 1.5) * 0.012 * side, 0, 0.042, root));
  const bones = [root, ...metacarpals];
  const fingers: FingerChain[] = [];
  const rows = [0.077, 0.072, 0.065, 0.057, 0.048, 0.027, 0.006, -0.015, -0.032];
  const widths = [0.025, 0.025, 0.0225, 0.0235, 0.025, 0.031, 0.035, 0.037, 0.037];
  const top: number[][] = [];
  const bottom: number[][] = [];
  for (let row = 0; row < rows.length; row++) {
    top.push([]);
    bottom.push([]);
    for (let col = 0; col <= 12; col++) {
      const across = col / 6 - 1;
      const x = across * widths[row]!;
      const arch = 1 - across * across;
      const cuff = row < 4;
      const fold = cuff ? Math.sin(row * 2.7 + across * 3) * 0.0012 : 0;
      const knuckle = Math.sin(col / 3 * Math.PI) ** 2 * Math.exp(-(((rows[row]! + 0.024) / 0.019) ** 2));
      const dorsal = cuff ? 0.013 + arch * 0.004 + fold : 0.006 + arch * 0.009 + knuckle * 0.004;
      const thenar = Math.exp(-((across - 0.55) ** 2) * 6) * Math.exp(-(((rows[row]! - 0.022) / 0.035) ** 2));
      const knuckleArc = row >= rows.length - 2 ? (1 - arch) * 0.009 + Math.max(0, -across) * 0.004 : 0;
      const web = row === rows.length - 1 && col > 0 && col < 12 && col % 3 === 0 ? 0.014 : 0;
      const indices = [surface.vertex(x, dorsal - 0.002, rows[row]! + knuckleArc + web), surface.vertex(x, -0.01 - arch * 0.003 - thenar * 0.005 - fold, rows[row]! + knuckleArc + web)];
      const column = THREE.MathUtils.clamp(col / 3 - 0.5, 0, 3);
      const low = Math.floor(column);
      const high = Math.min(3, low + 1);
      const influence = smooth((0.058 - rows[row]!) / 0.065);
      for (const index of indices) {
        const weights = surface.vertices[index]!.weights;
        weights[0] = 1 - influence;
        weights[low + 1]! += influence * (1 - (column - low));
        weights[high + 1]! += influence * (column - low);
      }
      top[row]!.push(indices[0]!);
      bottom[row]!.push(indices[1]!);
    }
  }
  for (let row = 0; row < rows.length - 1; row++) {
    for (let col = 0; col < 12; col++) {
      const dorsalMaterial = row < 2 ? 2 : row < 4 ? 1 : row >= 5 && col >= 2 && col < 10 && col % 3 !== 0 ? 3 : 0;
      surface.face([top[row]![col]!, top[row]![col + 1]!, top[row + 1]![col + 1]!, top[row + 1]![col]!], dorsalMaterial);
      surface.face([bottom[row]![col + 1]!, bottom[row]![col]!, bottom[row + 1]![col]!, bottom[row + 1]![col + 1]!], row < 1 ? 1 : 4);
    }
    surface.face([top[row]![0]!, top[row + 1]![0]!, bottom[row + 1]![0]!, bottom[row]![0]!]);
    if (row !== 4 && row !== 5) {
      surface.face([top[row + 1]![12]!, top[row]![12]!, bottom[row]![12]!, bottom[row + 1]![12]!]);
    }
  }
  surface.cap([...top[0]!].reverse().concat(bottom[0]!), 1);
  const last = rows.length - 1;
  for (let finger = 0; finger < 4; finger++) {
    const anatomicalIndex = 3 - finger;
    const length = [0.068, 0.078, 0.073, 0.057][anatomicalIndex]!;
    const x = (finger - 1.5) * 0.0185;
    const z = -0.032 + (x / 0.037) ** 2 * 0.009 + Math.max(0, -x / 0.037) * 0.004;
    const base = bones.length;
    const metacarpal = metacarpals[finger]!;
    const chain = [makeBone(`finger-${anatomicalIndex}-mcp`, x * side - metacarpal.position.x, -0.003, z - metacarpal.position.z, metacarpal)];
    chain.push(makeBone(`finger-${anatomicalIndex}-pip`, 0, 0, -length * 0.43, chain[0]));
    chain.push(makeBone(`finger-${anatomicalIndex}-dip`, 0, 0, -length * 0.32, chain[1]));
    bones.push(...chain);
    fingers.push({ bones: chain, index: anatomicalIndex });
    let ring = top[last]!.slice(finger * 3, finger * 3 + 4).concat(bottom[last]!.slice(finger * 3, finger * 3 + 4).reverse());
    const angles = [Math.PI * 0.9, Math.PI * 0.63, Math.PI * 0.37, Math.PI * 0.1, -Math.PI * 0.1, -Math.PI * 0.37, -Math.PI * 0.63, -Math.PI * 0.9];
    for (const t of [0.10, 0.25, 0.37, 0.43, 0.49, 0.64, 0.70, 0.75, 0.81, 0.92, 0.985, 1.015]) {
      const joint = Math.exp(-(((t - 0.43) / 0.065) ** 2)) * 0.0008 + Math.exp(-(((t - 0.75) / 0.055) ** 2)) * 0.0005;
      const radius = ([0.0085, 0.0088, 0.0083, 0.0073][anatomicalIndex]! * (1 - t * 0.2) + joint) * (t > 0.92 ? Math.sqrt(Math.max(0.04, 1 - ((t - 0.92) / 0.11) ** 2)) : 1);
      let bone = base;
      let parent = finger + 1;
      let blend = smooth(t / 0.18);
      if (t > 0.33) { bone = base + 1; parent = base; blend = smooth((t - 0.33) / 0.2); }
      if (t > 0.65) { bone = base + 2; parent = base + 1; blend = smooth((t - 0.65) / 0.2); }
      const next = angles.map(angle => surface.vertex(x + Math.cos(angle) * radius, -0.003 + Math.sin(angle) * radius * (Math.sin(angle) < 0 ? 1.04 : 0.88), z - length * t, bone, parent, blend));
      for (let j = 0; j < ring.length; j++) {
        surface.face([ring[j]!, ring[(j + 1) % ring.length]!, next[(j + 1) % ring.length]!, next[j]!], j >= 4 ? 4 : t > 0.81 ? 2 : 0);
      }
      ring = next;
    }
    surface.cap(ring, 2);
  }
  const thumbBase = bones.length;
  const thumbDirection = new THREE.Vector3(0.78, -0.12, -0.61).normalize();
  const thumbOrigin = new THREE.Vector3(0.029, -0.004, 0.027);
  const thumb = [makeBone('thumb-cmc', thumbOrigin.x * side, thumbOrigin.y, thumbOrigin.z, root)];
  thumb.push(makeBone('thumb-mcp', thumbDirection.x * 0.025 * side, thumbDirection.y * 0.025, thumbDirection.z * 0.025, thumb[0]));
  thumb.push(makeBone('thumb-ip', thumbDirection.x * 0.043 * side - thumb[1]!.position.x, thumbDirection.y * 0.018, thumbDirection.z * 0.018, thumb[1]));
  bones.push(...thumb);
  const thumbU = new THREE.Vector3(0, 1, 0).cross(thumbDirection).normalize();
  const thumbV = thumbDirection.clone().cross(thumbU).normalize();
  let thumbRing = [top[6]![12]!, top[5]![12]!, top[4]![12]!, bottom[4]![12]!, bottom[5]![12]!, bottom[6]![12]!];
  for (const t of [0.15, 0.3, 0.39, 0.45, 0.51, 0.65, 0.72, 0.78, 0.9, 0.98, 1.02]) {
    const center = thumbOrigin.clone().addScaledVector(thumbDirection, 0.061 * t);
    const radius = (0.016 * (1 - smooth(t / 0.5)) + 0.009 * smooth(t / 0.5)) * (t > 0.9 ? Math.sqrt(Math.max(0.03, 1 - ((t - 0.9) / 0.13) ** 2)) : 1);
    let bone = thumbBase;
    let parent = 0;
    let blend = smooth(t / 0.35);
    if (t > 0.31) { bone++; parent = thumbBase; blend = smooth((t - 0.31) / 0.2); }
    if (t > 0.61) { bone = thumbBase + 2; parent = thumbBase + 1; blend = smooth((t - 0.61) / 0.2); }
    const next = Array.from({ length: 6 }, (_, j) => {
      const angle = Math.PI * (1 / 6 + j / 3);
      const p = center.clone().addScaledVector(thumbU, Math.cos(angle) * radius).addScaledVector(thumbV, Math.sin(angle) * radius * 0.86);
      return surface.vertex(p.x, p.y, p.z, bone, parent, blend);
    });
    surface.bridge(thumbRing, next, t > 0.8 ? 2 : 0);
    thumbRing = next;
  }
  surface.cap(thumbRing, 2);
  surface.subdivide();
  const mesh = bindSurface(surface, bones, [mats.glove, mats.shell, mats.skin, mats.plate, mats.palm], side === -1);
  mesh.name = 'continuous-glove';
  const group = new THREE.Group();
  group.add(mesh);
  const contacts = fingers.map(finger => {
    const boneIndices = finger.bones.map(bone => bones.indexOf(bone));
    const positions = mesh.geometry.getAttribute('position');
    const indices = mesh.geometry.getAttribute('skinIndex');
    const weights = mesh.geometry.getAttribute('skinWeight');
    return boneIndices.map(bone => {
      let best = -1;
      let score = -Infinity;
      for (let i = 0; i < positions.count; i++) {
        let weight = 0;
        for (let j = 0; j < 4; j++) if (indices.getComponent(i, j) === bone) weight += weights.getComponent(i, j);
        const candidate = weight - Math.abs(positions.getY(i) + 0.01) * 80;
        if (candidate > score) { best = i; score = candidate; }
      }
      return best;
    });
  });
  const positions = mesh.geometry.getAttribute('position');
  const patch = (targets: THREE.Vector3[]): number[] => targets.map(target => {
    let best = 0;
    let minimum = Infinity;
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i);
      const distance = point.distanceToSquared(target);
      if (distance < minimum) { minimum = distance; best = i; }
    }
    return best;
  });
  const palmContacts = patch([-0.018, 0, 0.018].flatMap(x => [0.025, -0.012].map(z => new THREE.Vector3(x * side, -0.015, z))));
  const thumbContacts = patch([0.018, 0.032, 0.05, 0.065].flatMap(x => [-0.012, 0.004].map(y => new THREE.Vector3(x * side, y, 0.027 - (x - 0.029) * 0.8))));
  const glove = { group, mesh, metacarpals, fingers, thumb, contacts, palmContacts, thumbContacts, gripCache: new Map<string, number[]>(), side };
  articulate(glove, fist ? 1 : 0.62, 0, fist);
  return glove;
}

function articulate(glove: Glove, curl: number, spread: number, fist = false, trigger = false, triggerAmount = 0): void {
  for (let i = 0; i < glove.metacarpals.length; i++) {
    const ulnar = (3 - i) / 3;
    glove.metacarpals[i]!.rotation.set(-curl * (0.12 + ulnar * 0.3), glove.side * (i - 1.5) * spread * 0.04, glove.side * (1.5 - i) * curl * 0.12);
  }
  for (const finger of glove.fingers) {
    const c = THREE.MathUtils.clamp(curl + finger.index * 0.035 - (trigger && finger.index === 0 ? 0.14 : 0), 0, 1);
    finger.bones[0]!.rotation.set(-c * 1.18, glove.side * (finger.index - 1.5) * spread * 0.14, 0);
    finger.bones[1]!.rotation.x = -c * 1.52;
    finger.bones[2]!.rotation.x = -c * 1.02;
    if (trigger && finger.index === 0) {
      const pull = THREE.MathUtils.clamp(triggerAmount, 0, 1);
      finger.bones[0]!.rotation.x = -0.12 - pull * 0.12;
      finger.bones[1]!.rotation.x = -0.72 - pull * 0.28;
      finger.bones[2]!.rotation.x = -0.38 - pull * 0.16;
    }
  }
  glove.thumb[0]!.rotation.set(-curl * 0.32, glove.side * (curl * 0.7 - spread * 0.12), -glove.side * curl * 0.52);
  glove.thumb[1]!.rotation.set(-curl * 0.26, glove.side * curl * (fist ? 0.9 : 0.62), 0);
  glove.thumb[2]!.rotation.set(-curl * 0.18, glove.side * curl * 0.48, 0);
}

function fitGrip(glove: Glove, group: THREE.Group, contact: THREE.Vector3, support: boolean, pump = false): void {
  const key = `${support}:${pump}:${group.scale.x}:${[...contact.toArray(), ...group.quaternion.toArray(), ...(group.parent ? [...group.parent.position.toArray(), ...group.parent.quaternion.toArray(), ...group.parent.scale.toArray()] : [])].map(v => v.toFixed(3)).join(':')}`;
  const cached = glove.gripCache.get(key);
  if (cached) {
    glove.fingers.forEach((finger, i) => {
      finger.bones.forEach((bone, j) => { if (support || finger.index !== 0) bone.rotation.x = cached[i * 3 + j]!; });
      glove.metacarpals[i]!.rotation.x = cached[12 + i]!;
    });
    group.position.copy(contact).add(_contactOffset.fromArray(cached, 16));
    group.quaternion.fromArray(cached, 19);
    glove.thumb.forEach((bone, i) => bone.rotation.set(cached[23 + i * 3]!, cached[24 + i * 3]!, cached[25 + i * 3]!));
    return;
  }
  const mesh = glove.mesh;
  const position = mesh.geometry.getAttribute('position');
  const inverse = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const center = contact.clone();
  if (support) center.y += pump ? -0.012 : 0.023;
  else center.x = 0;
  const triangles: THREE.Triangle[] = [];
  if (group.parent) {
    group.parent.updateWorldMatrix(true, false);
    const parentInverse = group.parent.matrixWorld.clone().invert();
    group.parent.traverse(object => {
      const obstacle = object as THREE.Mesh;
      if (!obstacle.isMesh || (obstacle as THREE.SkinnedMesh).isSkinnedMesh || !obstacle.visible) return;
      obstacle.updateWorldMatrix(true, false);
      const transform = parentInverse.clone().multiply(obstacle.matrixWorld);
      const vertices = obstacle.geometry.getAttribute('position');
      const indices = obstacle.geometry.getIndex();
      for (let i = 0; i < (indices?.count ?? vertices.count); i += 3) {
        const corners = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(vertices, indices ? indices.getX(i + j) : i + j).applyMatrix4(transform));
        const triangle = new THREE.Triangle(corners[0]!, corners[1]!, corners[2]!);
        const nearest = triangle.closestPointToPoint(center, new THREE.Vector3());
        if (nearest.distanceTo(center) < (support ? 0.08 : 0.14)) triangles.push(triangle);
      }
    });
  }
  const nearest = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const difference = new THREE.Vector3();
  const distance = (): number => {
    if (triangles.length) {
      let minimum = Infinity;
      let signed = Infinity;
      for (const triangle of triangles) {
        triangle.closestPointToPoint(point, nearest);
        const squared = nearest.distanceToSquared(point);
        if (squared < minimum) {
          minimum = squared;
          signed = Math.sqrt(squared) * (difference.copy(point).sub(nearest).dot(triangle.getNormal(normal)) < 0 ? -1 : 1);
        }
      }
      return signed;
    }
    const x = point.x - center.x;
    const y = support ? point.y - center.y : (point.z - center.z) * 0.95 + (point.y - center.y) * 0.31;
    const qx = Math.abs(x) - (support ? 0.017 : 0.01);
    const qy = Math.abs(y) - (support ? pump ? 0.012 : 0.016 : 0.016);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 0.006;
  };
  const score = (i: number): number => {
    group.updateWorldMatrix(true, false);
    group.updateMatrixWorld(true);
    if (group.parent) inverse.copy(group.parent.matrixWorld).invert();
    else inverse.identity();
    let total = 0;
    for (const index of glove.contacts[i]!) {
      mesh.applyBoneTransform(index, point.fromBufferAttribute(position, index)).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      const d = distance();
      total += d * d * (d < 0 ? 8 : 1);
    }
    return total;
  };
  glove.fingers.forEach((finger, i) => {
    if (!support && finger.index === 0) return;
    for (const step of [0.28, 0.14, 0.07, 0.035]) {
      for (let pass = 0; pass < 3; pass++) {
        for (let j = 0; j < 3; j++) {
          const bone = finger.bones[j]!;
          const original = bone.rotation.x;
          let best = original;
          let error = score(i);
          for (const delta of [-step, step]) {
            bone.rotation.x = THREE.MathUtils.clamp(original + delta, j === 1 ? -1.85 : -1.5, j === 0 ? -0.25 : -0.12);
            const candidate = score(i);
            if (candidate < error) { error = candidate; best = bone.rotation.x; }
          }
          bone.rotation.x = best;
        }
      }
    }
  });
  const patchScore = (): number => {
    group.updateWorldMatrix(true, true);
    if (group.parent) inverse.copy(group.parent.matrixWorld).invert();
    let total = 0;
    for (const index of [...glove.palmContacts, ...glove.thumbContacts]) {
      mesh.applyBoneTransform(index, point.fromBufferAttribute(position, index)).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      const d = distance() - 0.002;
      const thumb = glove.thumbContacts.includes(index);
      total += d * d * (d < 0 ? 32 : thumb ? 0.15 : 2);
    }
    return total;
  };
  const initialRotation = group.quaternion.clone();
  const shoulder = new THREE.Vector3(support ? -0.2 : 0.16, support ? -0.22 : -0.16, support ? 0.02 : 0.12);
  const weaponScale = group.parent?.scale.x ?? 1;
  if (group.parent) shoulder.sub(group.parent.position).applyQuaternion(group.parent.quaternion.clone().invert()).divideScalar(weaponScale);
  const wrist = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const toWrist = new THREE.Vector3();
  const wristScore = (): number => {
    if (!support || !group.userData.boundWrist) return 0;
    wrist.set(0, 0, 0.073).multiply(group.scale).applyQuaternion(group.quaternion).add(group.position);
    axis.set(0, 0, -1).applyQuaternion(group.quaternion);
    toWrist.copy(wrist).sub(shoulder);
    const reach = THREE.MathUtils.clamp(toWrist.length() * weaponScale, 0.0301, 0.5699);
    toWrist.normalize();
    const bend = new THREE.Vector3(support ? -1.2 : 1, support ? -1.8 : -2, support ? 0.1 : -2);
    if (group.parent) bend.applyQuaternion(group.parent.quaternion.clone().invert());
    bend.addScaledVector(toWrist, -bend.dot(toWrist)).normalize();
    const alongLength = (0.3 ** 2 + reach ** 2 - 0.27 ** 2) / (2 * reach);
    const bendLength = Math.sqrt(Math.max(0, 0.3 ** 2 - alongLength ** 2));
    const forearm = toWrist.clone().multiplyScalar(reach - alongLength).addScaledVector(bend, -bendLength);
    const swing = axis.angleTo(forearm);
    return Math.max(0, swing - 0.45) ** 2 * 0.08;
  };
  const totalScore = (): number => glove.fingers.reduce((sum, finger, i) => sum + (!support && finger.index === 0 ? 0 : score(i)), patchScore())
    + group.quaternion.angleTo(initialRotation) ** 2 * 0.003 + wristScore();
  for (const step of [0.008, 0.004, 0.002]) {
    for (let pass = 0; pass < 3; pass++) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const original = group.position[axis];
        let best = original;
        let error = totalScore();
        for (const delta of [-step, step]) {
          group.position[axis] = original + delta;
          const candidate = totalScore();
          if (candidate < error) { best = group.position[axis]; error = candidate; }
        }
        group.position[axis] = best;
      }
      for (const axis of ['x', 'y', 'z'] as const) {
        const original = group.rotation[axis];
        let best = original;
        let error = totalScore();
        for (const delta of support ? [-step * 24, step * 24] : [-0.06, 0.06]) {
          group.rotation[axis] = original + delta;
          const candidate = totalScore();
          if (candidate < error) { error = candidate; best = group.rotation[axis]; }
        }
        group.rotation[axis] = best;
        for (const bone of glove.thumb) {
          const original = bone.rotation[axis];
          let best = original;
          let error = patchScore();
          for (const delta of [-0.12, 0.12]) {
            bone.rotation[axis] = THREE.MathUtils.clamp(original + delta, -0.9, 0.9);
            const candidate = patchScore();
            if (candidate < error) { error = candidate; best = bone.rotation[axis]; }
          }
          bone.rotation[axis] = best;
        }
      }
      glove.fingers.forEach((finger, i) => {
        if (!support && finger.index === 0) return;
        for (const bone of [glove.metacarpals[i]!, ...finger.bones]) {
          const original = bone.rotation.x;
          let best = original;
          let error = score(i);
          for (const delta of [-0.1, 0.1]) {
            bone.rotation.x = THREE.MathUtils.clamp(original + delta, bone === glove.metacarpals[i] ? -0.55 : -1.85, -0.08);
            const candidate = score(i);
            if (candidate < error) { best = bone.rotation.x; error = candidate; }
          }
          bone.rotation.x = best;
        }
      });
    }
  }
  if (glove.gripCache.size > 24) glove.gripCache.clear();
  glove.gripCache.set(key, [...glove.fingers.flatMap(finger => finger.bones.map(bone => bone.rotation.x)), ...glove.metacarpals.map(bone => bone.rotation.x), ...group.position.clone().sub(contact).toArray(), ...group.quaternion.toArray(), ...glove.thumb.flatMap(bone => [bone.rotation.x, bone.rotation.y, bone.rotation.z])]);
}

function wrapSupport(glove: Glove, group: THREE.Group, contact: THREE.Vector3, squeeze: number): void {
  const approach = new THREE.Vector3(-0.2, -0.22, 0.02).sub(contact);
  approach.z = 0;
  orientHand(group, _palm.copy(approach).negate(), _fingers.set(0, 0, -1), true);
  placePalm(group, contact, 0.018);
  fitGrip(glove, group, contact, true, squeeze > 0);
}

function placePalm(group: THREE.Object3D, contact: THREE.Vector3, depth = 0.013): void {
  group.position.copy(contact).addScaledVector(_palm.set(0, -1, 0).applyQuaternion(group.quaternion), -depth * group.scale.y);
}

const _contactOffset = new THREE.Vector3();
const _palm = new THREE.Vector3();
const _target = new THREE.Vector3();
const _upY = new THREE.Vector3(0, 1, 0);
const _fingers = new THREE.Vector3();
const _bp = new THREE.Vector3();
const _bf = new THREE.Vector3();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _quatA = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();

function handBasisQuat(out: THREE.Quaternion, palm: THREE.Vector3, fingers: THREE.Vector3, _mirrored: boolean): THREE.Quaternion {
  _bp.copy(palm).normalize();
  _bf.copy(fingers).addScaledVector(_bp, -fingers.dot(_bp)).normalize();
  _axisX.copy(_bp).cross(_bf);
  _axisY.copy(_bp).negate();
  _axisZ.copy(_bf).negate();
  _basis.makeBasis(_axisX, _axisY, _axisZ);
  return out.setFromRotationMatrix(_basis);
}

function orientHand(group: THREE.Object3D, palm: THREE.Vector3, fingers: THREE.Vector3, mirrored: boolean): void {
  group.quaternion.copy(handBasisQuat(_quatA, palm, fingers, mirrored));
}

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function reachEnvelope(phase: number, start: number, peak: number, end: number): number {
  if (phase < start || phase > end) return 0;
  return phase < peak ? smooth((phase - start) / (peak - start)) : 1 - smooth((phase - peak) / (end - peak));
}

export function createHandRig(): HandRig {
  const mats = getHandMaterialSet();
  const gloveL = buildHand(mats, 1);
  const gloveR = buildHand(mats, -1);
  const leftWrap = new THREE.Group();
  leftWrap.add(gloveL.group);
  const left = leftWrap;
  const right = gloveR.group;
  const wristR = new THREE.Object3D();
  wristR.name = 'hand-wrist-right';
  wristR.position.set(0, 0, 0.073);
  right.add(wristR);
  const wristL = new THREE.Object3D();
  wristL.name = 'hand-wrist-left';
  wristL.position.set(0, 0, 0.073);
  left.add(wristL);
  const gripR = new THREE.Vector3();
  const gripL = new THREE.Vector3();
  return {
    right, left, wristR, wristL,
    configure(anchors) {
      gripR.copy(anchors.gripR);
      gripL.copy(anchors.gripL);
      const s = 1.1 / anchors.scale;
      right.position.copy(gripR);
      right.scale.setScalar(s);
      left.position.copy(gripL);
      left.scale.setScalar(s);
    },
    pose({ reloadPhase, supportStyle, magLocal, pumpOffset, pumpHand, ads, boltPhase, boltLocal, triggerAmount = 0 }) {
      right.userData.boundWrist = boltPhase < 0 && reloadPhase < 0;
      left.userData.boundWrist = reloadPhase < 0;
      const pumping = pumpHand || supportStyle === 'pump';
      const leftReach = !pumping && magLocal && reloadPhase >= 0
        ? Math.max(reachEnvelope(reloadPhase, 0, 0.13, 0.3), reachEnvelope(reloadPhase, 0.85, 0.92, 1)) : 0;
      const rightReach = boltLocal && boltPhase >= 0
        ? Math.max(reachEnvelope(boltPhase, 0, 0.14, 0.3), reachEnvelope(boltPhase, 0.7, 0.84, 1)) : 0;
      const pumpSqueeze = pumping ? smooth(Math.abs(pumpOffset) / 0.085) * 0.1 : 0;
      articulate(gloveL, (supportStyle === 'side' ? 0.68 : 0.58) * (1 - leftReach) + 0.08 * leftReach + pumpSqueeze, leftReach);
      articulate(gloveR, 0.67 * (1 - rightReach) + 0.1 * rightReach, rightReach, false, boltPhase < 0, triggerAmount);
      const longGun = supportStyle !== 'over';
      const gripPalm = _palm.set(-0.88, 0.08, -0.46);
      const gripFingers = longGun ? _fingers.set(-0.35, -0.36, -0.86) : _fingers.set(-0.35, -0.46, -0.82);
      if (boltPhase >= 0 && boltLocal) {
        const target = _target;
        if (boltPhase < 0.3) {
          target.lerpVectors(gripR, boltLocal, smooth(boltPhase / 0.3));
        } else if (boltPhase < 0.7) {
          target.copy(boltLocal);
          const swing = boltPhase < 0.5 ? smooth((boltPhase - 0.3) / 0.2) : smooth((0.7 - boltPhase) / 0.2);
          target.z += 0.05 * swing;
        } else {
          target.lerpVectors(boltLocal, gripR, smooth((boltPhase - 0.7) / 0.3));
        }
        right.position.copy(target);
        orientHand(right, gripPalm, gripFingers, false);
      } else {
        orientHand(right, gripPalm, gripFingers, false);
        placePalm(right, gripR);
        fitGrip(gloveR, right, gripR, false);
      }
      if (pumping) {
        orientHand(left, _palm.set(0, 1, 0), _fingers.set(1, 0, 0), true);
        _target.copy(gripL).y += 0.006;
        placePalm(left, _target, 0.022);
        wrapSupport(gloveL, left, _target, 0.1);
        left.position.z += pumpOffset;
        return;
      }
      if (reloadPhase >= 0 && magLocal) {
        const p = reloadPhase;
        const target = _target;
        let blend: number;
        if (p < 0.3) {
          target.lerpVectors(gripL, magLocal, smooth(p / 0.3));
          blend = smooth(p / 0.3);
        } else if (p < 0.85) {
          target.copy(magLocal);
          target.y -= 0.02;
          blend = 1;
        } else {
          target.lerpVectors(magLocal, gripL, smooth((p - 0.85) / 0.15));
          blend = 1 - smooth((p - 0.85) / 0.15);
        }
        left.position.copy(target);
        const tuck = ads * 0.012;
        if (supportStyle === 'side') {
          handBasisQuat(_quatA, _palm.set(0.95, -0.25, 0.18), _fingers.set(0.05, -0.5, -0.86), true);
        } else if (supportStyle === 'over') {
          handBasisQuat(_quatA, _palm.set(0.45, 0.7, 0.55), _fingers.set(0.1, 0.6, -0.79), true);
        } else {
          handBasisQuat(_quatA, _palm.set(0, 1, 0), _fingers.set(1, 0, 0), true);
        }
        handBasisQuat(_quatB, _palm.set(0.85, -0.35, 0.2), _fingers.set(0, -0.5, -0.86), true);
        leftWrap.quaternion.slerpQuaternions(_quatA, _quatB, blend);
        left.position.y -= tuck * (1 - blend);
        return;
      }
      const tuck = ads * 0.012;
      if (supportStyle === 'side') {
        left.position.set(gripL.x - 0.018, gripL.y + 0.012 - tuck, gripL.z);
        orientHand(left, _palm.set(0.98, -0.15, 0.1), _fingers.set(0.05, -0.2, -0.98), true);
        return;
      }
      if (supportStyle === 'over') {
        left.position.set(gripL.x - 0.008, gripL.y - 0.025, gripL.z - 0.028);
        orientHand(left, _palm.set(0.45, 0.7, 0.55), _fingers.set(0.1, 0.6, -0.79), true);
        return;
      }
      orientHand(left, _palm.set(0, 1, 0), _fingers.set(1, 0, 0), true);
      _target.copy(gripL).y += 0.006;
      placePalm(left, _target, 0.022);
      wrapSupport(gloveL, left, _target, 0);
    },
  };
}

export interface FistRig {
  group: THREE.Group;
  right: THREE.Group;
  left: THREE.Group;
  wristR: THREE.Object3D;
  wristL: THREE.Object3D;
  baseQuatR: THREE.Quaternion;
  baseQuatL: THREE.Quaternion;
}

export function createFistRig(): FistRig {
  const mats = getHandMaterialSet();
  const group = new THREE.Group();
  const right = buildHand(mats, -1, true).group;
  const left = new THREE.Group();
  left.add(buildHand(mats, 1, true).group);
  group.add(right, left);
  orientHand(right, _palm.set(-0.2, -0.9, -0.38), _fingers.set(-0.12, 0.12, -0.99), false);
  orientHand(left, _palm.set(0.2, -0.9, -0.38), _fingers.set(0.12, 0.12, -0.99), true);
  right.position.set(0.16, -0.16, -0.34);
  right.scale.setScalar(1.18);
  left.position.set(-0.15, -0.19, -0.38);
  left.scale.setScalar(1.18);
  const wristR = new THREE.Object3D();
  wristR.name = 'hand-wrist-right';
  wristR.position.set(0, 0, 0.073);
  right.add(wristR);
  const wristL = new THREE.Object3D();
  wristL.name = 'hand-wrist-left';
  wristL.position.set(0, 0, 0.073);
  left.add(wristL);
  return { group, right, left, wristR, wristL, baseQuatR: right.quaternion.clone(), baseQuatL: left.quaternion.clone() };
}

interface Sleeve {
  upper: THREE.Bone;
  fore: THREE.Bone;
  twist: THREE.Bone;
  wrist: THREE.Bone;
  mesh: THREE.SkinnedMesh;
}

function buildSleeve(upperLength: number, foreLength: number, side: number): Sleeve {
  const upper = makeBone('upper-arm', 0, 0, 0);
  const fore = makeBone('elbow', 0, upperLength, 0, upper);
  const twist = makeBone('forearm-pronation', 0, foreLength * 0.5, 0, fore);
  const wrist = makeBone('sleeve-wrist', 0, foreLength * 0.5, 0, twist);
  const surface = new SkinSurface(4);
  const length = upperLength + foreLength;
  const samples = [0, 0.02, 0.15, 0.3, 0.48, 0.66, 0.78, 0.86, 0.92, 0.97, 1].map(t => t * upperLength)
    .concat([0.04, 0.09, 0.16, 0.25, 0.36, 0.49, 0.62, 0.74, 0.8, 0.85, 0.9, 0.94, 0.98, 1].map(t => upperLength + t * foreLength));
  let ring: number[] = [];
  for (let row = 0; row < samples.length; row++) {
    const y = samples[row]!;
    const t = y / length;
    const upperT = Math.min(1, y / upperLength);
    const foreT = Math.max(0, (y - upperLength) / foreLength);
    const belly = Math.sin(Math.PI * smooth(foreT)) * (1 - foreT);
    const radius = y < upperLength
      ? 0.052 - 0.013 * upperT + 0.008 * Math.sin(Math.PI * upperT)
      : 0.039 - 0.015 * smooth(foreT) + 0.012 * belly;
    const next = Array.from({ length: 16 }, (_, j) => {
      const angle = -j / 16 * Math.PI * 2;
      const elbowFold = Math.exp(-(((y - upperLength) / 0.052) ** 2)) * Math.cos((y - upperLength) * 230 + Math.sin(angle) * 2) * 0.004;
      const wristFold = Math.exp(-(((foreT - 0.85) / 0.14) ** 2)) * Math.cos(foreT * 72 + angle * 2) * 0.0025;
      const muscle = belly * (0.004 * Math.cos(angle - side * 0.7) + 0.002 * Math.cos(angle * 2));
      const seam = j === 3 || j === 11 ? 0.0008 : 0;
      const r = radius + muscle + elbowFold + wristFold + seam;
      const center = side * 0.006 * belly;
      const index = surface.vertex(center + Math.cos(angle) * r, y, Math.sin(angle) * r * (0.84 + 0.08 * foreT), 1, 0, smooth((y - upperLength + 0.04) / 0.08));
      const twistWeight = smooth((foreT - 0.12) / 0.65);
      const wristWeight = smooth((foreT - 0.94) / 0.06);
      if (twistWeight > 0) {
        surface.vertices[index]!.weights[1] = 1 - twistWeight;
        surface.vertices[index]!.weights[2] = twistWeight * (1 - wristWeight);
        surface.vertices[index]!.weights[3] = twistWeight * wristWeight;
      }
      surface.vertices[index]!.uv.set(j / 16, t * 3);
      return index;
    });
    if (row === 0) surface.cap([...next].reverse(), 1);
    else surface.bridge(ring, next, 1);
    ring = next;
  }
  surface.cap(ring, 1);
  surface.subdivide();
  const mats = getHandMaterialSet();
  const mesh = bindSurface(surface, [upper, fore, twist, wrist], [mats.glove, mats.shell, mats.skin, mats.plate, mats.palm]);
  mesh.name = 'continuous-sleeve';
  return { upper, fore, twist, wrist, mesh };
}

export class ArmSolver {
  readonly group = new THREE.Group();
  private readonly shoulders = [new THREE.Vector3(0.16, -0.16, 0.12), new THREE.Vector3(-0.2, -0.22, 0.02)];
  private readonly upperLen = 0.3;
  private readonly foreLen = 0.27;
  readonly reachDeficit = [0, 0];
  private readonly bends = [new THREE.Vector3(1, -2, -2), new THREE.Vector3(-1.2, -1.8, 0.1)];
  private readonly sleeves: Sleeve[] = [];
  private readonly shoulder = new THREE.Vector3();
  private readonly wristTarget = new THREE.Vector3();
  private readonly wristClamped = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly along = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly foreQuaternion = new THREE.Quaternion();
  private readonly wristQuaternion = new THREE.Quaternion();
  private readonly pivotQuaternion = new THREE.Quaternion();
  private readonly wristAxis = new THREE.Quaternion().setFromUnitVectors(_upY, new THREE.Vector3(0, 0, -1));
  private readonly anchorPosition = new THREE.Vector3();

  constructor() {
    for (let i = 0; i < 2; i++) {
      const sleeve = buildSleeve(this.upperLen, this.foreLen, i === 0 ? -1 : 1);
      this.sleeves.push(sleeve);
      this.group.add(sleeve.mesh);
    }
    this.group.visible = false;
  }

  solve(pivot: THREE.Object3D, wristWorld: THREE.Vector3[], settle = 0): void {
    this.group.visible = true;
    for (let i = 0; i < 2; i++) {
      this.shoulder.copy(this.shoulders[i]!);
      this.shoulder.y -= 0.012 * settle;
      this.shoulder.z += 0.015 * settle;
      pivot.worldToLocal(this.wristTarget.copy(wristWorld[i]!));
      this.along.copy(this.wristTarget).sub(this.shoulder);
      const reach = this.along.length();
      if (reach < 1e-8) this.along.set(0, 0, -1);
      else this.along.multiplyScalar(1 / reach);
      const distance = THREE.MathUtils.clamp(reach, Math.abs(this.upperLen - this.foreLen) + 0.0001, this.upperLen + this.foreLen - 0.0001);
      this.reachDeficit[i] = Math.abs(reach - distance);
      this.wristClamped.copy(this.shoulder).addScaledVector(this.along, distance);
      let anchor: THREE.Object3D | undefined;
      let nearest = Infinity;
      pivot.traverse(object => {
        if (object.name !== (i === 0 ? 'hand-wrist-right' : 'hand-wrist-left')) return;
        object.getWorldPosition(this.anchorPosition);
        const distance = this.anchorPosition.distanceToSquared(wristWorld[i]!);
        if (distance < nearest) { nearest = distance; anchor = object; }
      });
      const hand = anchor?.parent;
      const bounded = hand?.userData.boundWrist === true;
      if (anchor) {
        anchor.getWorldQuaternion(this.wristQuaternion);
        pivot.getWorldQuaternion(this.pivotQuaternion);
        this.wristQuaternion.premultiply(this.pivotQuaternion.invert()).multiply(this.wristAxis);
      }
      this.bend.copy(this.bends[i]!);
      this.bend.addScaledVector(this.along, -this.bend.dot(this.along));
      if (this.bend.lengthSq() < 1e-8) {
        this.bend.set(Math.abs(this.along.x) < 0.8 ? 1 : 0, Math.abs(this.along.x) < 0.8 ? 0 : 1, 0);
        this.bend.addScaledVector(this.along, -this.bend.dot(this.along));
      }
      this.bend.normalize();
      const alongLength = (this.upperLen ** 2 + distance ** 2 - this.foreLen ** 2) / (2 * distance);
      const bendLength = Math.sqrt(Math.max(0, this.upperLen ** 2 - alongLength ** 2));
      this.elbow.copy(this.shoulder).addScaledVector(this.along, alongLength).addScaledVector(this.bend, bendLength);
      const sleeve = this.sleeves[i]!;
      sleeve.upper.position.copy(this.shoulder);
      this.direction.copy(this.elbow).sub(this.shoulder).normalize();
      sleeve.upper.quaternion.setFromUnitVectors(_upY, this.direction);
      this.direction.copy(this.wristClamped).sub(this.elbow).normalize();
      this.foreQuaternion.setFromUnitVectors(_upY, this.direction);
      const relative = this.foreQuaternion.clone().invert().multiply(anchor ? this.wristQuaternion : this.foreQuaternion);
      const twist = new THREE.Quaternion(0, relative.y, 0, relative.w).normalize();
      const swing = relative.clone().multiply(twist.clone().invert());
      const swingAngle = 2 * Math.acos(Math.min(1, Math.abs(swing.w)));
      if (bounded && swingAngle > 0.55) swing.slerp(new THREE.Quaternion(), 1 - 0.55 / swingAngle);
      const twistAngle = 2 * Math.atan2(twist.y, twist.w);
      const wrappedTwist = Math.atan2(Math.sin(twistAngle), Math.cos(twistAngle));
      const pronation = bounded ? THREE.MathUtils.clamp(wrappedTwist, -1.4, 1.4) : wrappedTwist;
      const halfTwist = new THREE.Quaternion().setFromAxisAngle(_upY, pronation * 0.5);
      sleeve.fore.quaternion.copy(sleeve.upper.quaternion).invert().multiply(this.foreQuaternion).multiply(halfTwist);
      sleeve.twist.quaternion.copy(halfTwist);
      const fullTwist = halfTwist.clone().multiply(halfTwist);
      sleeve.wrist.quaternion.copy(fullTwist).invert().multiply(swing).multiply(fullTwist);
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}
