/**
 * WorldView: builds the renderable scene from a MapDef + Match state.
 * Instanced meshes per material for static geometry; tracked meshes for
 * destructibles, chests, loot, vehicles, trees, water, storm and transport.
 */

import * as THREE from 'three';
import type { MapDef, MatKey } from '../world/types';
import type { MaterialLibrary } from './materials';
import type { Match } from '../sim/match';
import type { WorldItem } from '../sim/loot';
import { RARITY_COLORS } from '../core/balance';
import { itemGlowColor } from '../sim/loot';

export class WorldView {
  readonly group = new THREE.Group();
  private destructibleMeshes = new Map<number, THREE.Object3D>();
  private chestMeshes = new Map<number, THREE.Object3D>();
  private lootMeshes = new Map<number, THREE.Object3D>();
  private lootLights = new Map<number, THREE.PointLight>();
  private waterMeshes: THREE.Mesh[] = [];
  private lampLights: THREE.PointLight[] = [];
  private lampPools: Array<{ mesh: THREE.Mesh; x: number; z: number }> = [];
  stormMesh: THREE.Mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24), new THREE.MeshBasicMaterial({ visible: false }));
  readonly transportGroup = new THREE.Group();
  private time = 0;

  constructor(
    def: MapDef,
    private mats: MaterialLibrary,
    match: Match | null,
  ) {
    this.buildStatic(def);
    this.buildScatter(def);
    this.buildWater(def);
    if (match) {
      this.trackDestructibles(match);
      this.trackChests(match);
      this.buildStorm(match);
      this.buildTransport(match);
    }
  }

  // -------------------------------------------------------------------------
  // Static geometry (instanced boxes/cylinders/spheres per material)
  // -------------------------------------------------------------------------

  private buildStatic(def: MapDef): void {
    const byMat = new Map<MatKey, THREE.Matrix4[]>();
    const cylByMat = new Map<MatKey, THREE.Matrix4[]>();
    const sphByMat = new Map<MatKey, THREE.Matrix4[]>();

    for (const g of def.geo) {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), g.kind === 'box' ? g.yaw : 0);
      const pos = new THREE.Vector3(g.x, g.y, g.z);
      const one = new THREE.Vector3(1, 1, 1);
      m.compose(pos, q, one);
      if (g.kind === 'box') {
        let arr = byMat.get(g.mat);
        if (!arr) { arr = []; byMat.set(g.mat, arr); }
        const s = new THREE.Vector3(g.sx, g.sy, g.sz);
        const m2 = new THREE.Matrix4().compose(pos, q, s);
        arr.push(m2);
        void m;
      } else if (g.kind === 'cyl') {
        let arr = cylByMat.get(g.mat);
        if (!arr) { arr = []; cylByMat.set(g.mat, arr); }
        const s = new THREE.Vector3(g.r, g.h, g.r);
        const m2 = new THREE.Matrix4().compose(pos, q, s);
        arr.push(m2);
      } else {
        let arr = sphByMat.get(g.mat);
        if (!arr) { arr = []; sphByMat.set(g.mat, arr); }
        const s = new THREE.Vector3(g.r, g.r, g.r);
        const m2 = new THREE.Matrix4().compose(pos, q, s);
        arr.push(m2);
      }
    }

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 12);
    const sphGeo = new THREE.SphereGeometry(1, 10, 8);

    for (const [mat, matrices] of byMat) {
      const inst = new THREE.InstancedMesh(boxGeo, this.mats.get(mat), matrices.length);
      matrices.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      inst.castShadow = true;
      inst.receiveShadow = true;
      this.group.add(inst);
    }
    for (const [mat, matrices] of cylByMat) {
      const inst = new THREE.InstancedMesh(cylGeo, this.mats.get(mat), matrices.length);
      matrices.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      inst.castShadow = true;
      this.group.add(inst);
    }
    for (const [mat, matrices] of sphByMat) {
      const inst = new THREE.InstancedMesh(sphGeo, this.mats.get(mat), matrices.length);
      matrices.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      this.group.add(inst);
    }
  }

  // -------------------------------------------------------------------------
  // Trees / rocks / lamps / lights
  // -------------------------------------------------------------------------

  private buildScatter(def: MapDef): void {
    // Trees: merged simple geometry — trunk cylinder + canopy cones/spheres
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 2.6, 6);
    const trunkMat = this.mats.get('woodDark');
    const pineGeo = new THREE.ConeGeometry(1.7, 4.6, 8);
    const oakGeo = new THREE.SphereGeometry(1.9, 8, 6);
    const palmGeo = new THREE.ConeGeometry(0.5, 3.2, 5);
    const pineMat = new THREE.MeshStandardMaterial({ color: 0x2f5233, roughness: 0.95 });
    const oakMat = new THREE.MeshStandardMaterial({ color: 0x44603a, roughness: 0.95 });
    const deadMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.98 });

    type VariantBuckets = Record<'pine' | 'oak' | 'palm' | 'dead', THREE.Object3D[]>;
    const groups: Record<'pine' | 'oak' | 'palm' | 'dead', VariantBuckets> = {
      pine: { pine: [], oak: [], palm: [], dead: [] },
      oak: { pine: [], oak: [], palm: [], dead: [] },
      palm: { pine: [], oak: [], palm: [], dead: [] },
      dead: { pine: [], oak: [], palm: [], dead: [] },
    };

    for (const t of def.trees) {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 1.3 * t.scale;
      trunk.scale.setScalar(t.scale);
      trunk.castShadow = true;
      g.add(trunk);
      let canopy: THREE.Mesh;
      if (t.variant === 'pine') canopy = new THREE.Mesh(pineGeo, pineMat);
      else if (t.variant === 'oak') canopy = new THREE.Mesh(oakGeo, oakMat);
      else if (t.variant === 'palm') canopy = new THREE.Mesh(palmGeo, oakMat);
      else canopy = new THREE.Mesh(pineGeo, deadMat);
      canopy.position.y = (t.variant === 'palm' ? 3.4 : 4.4) * t.scale;
      canopy.scale.setScalar(t.scale);
      canopy.castShadow = true;
      g.add(canopy);
      g.position.set(t.x, t.y, t.z);
      g.rotation.y = Math.random() * Math.PI * 2;
      groups[t.variant][t.variant].push(g);
    }
    for (const variant of ['pine', 'oak', 'palm', 'dead'] as const) {
      for (const mesh of groups[variant][variant]) this.group.add(mesh);
    }

    // Rocks: distorted spheres
    const rockGeo = new THREE.SphereGeometry(1, 7, 5);
    const rockMat = this.mats.get('rock');
    const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, def.rocks.length);
    const m4 = new THREE.Matrix4();
    def.rocks.forEach((r, i) => {
      m4.makeScale(r.scale, r.scale * 0.72, r.scale);
      m4.setPosition(r.x, r.y + r.scale * 0.25, r.z);
      rockInst.setMatrixAt(i, m4);
    });
    rockInst.frustumCulled = false;
    rockInst.castShadow = true;
    rockInst.receiveShadow = true;
    this.group.add(rockInst);

    // Lamps: emissive bulb + point light + fake ground light pool
    const poolGeo = new THREE.CircleGeometry(7, 20);
    poolGeo.rotateX(-Math.PI / 2);
    const poolTexCanvas = document.createElement('canvas');
    poolTexCanvas.width = poolTexCanvas.height = 128;
    {
      const g = poolTexCanvas.getContext('2d')!;
      const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
      grad.addColorStop(0, 'rgba(255,235,190,0.55)');
      grad.addColorStop(1, 'rgba(255,235,190,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    }
    const poolTex = new THREE.CanvasTexture(poolTexCanvas);
    poolTex.colorSpace = THREE.SRGBColorSpace;
    const bulbGeo = new THREE.SphereGeometry(0.28, 8, 6);
    const maxLamps = Math.min(def.lamps.length, 72);
    for (let i = 0; i < maxLamps; i++) {
      const l = def.lamps[i]!;
      const bulb = new THREE.Mesh(bulbGeo, new THREE.MeshBasicMaterial({ color: l.color }));
      bulb.position.set(l.x, l.y, l.z);
      this.group.add(bulb);
      const light = new THREE.PointLight(l.color, l.intensity, l.range, 1.6);
      light.position.set(l.x, l.y - 0.2, l.z);
      this.group.add(light);
      this.lampLights.push(light);
      // soft additive ground glow sells the lamp without extra lights
      if (i < 40) {
        const pool = new THREE.Mesh(poolGeo, new THREE.MeshBasicMaterial({
          map: poolTex, transparent: true, blending: THREE.AdditiveBlending,
          depthWrite: false, opacity: 0.85,
        }));
        pool.renderOrder = 1;
        this.group.add(pool);
        this.lampPools.push({ mesh: pool, x: l.x, z: l.z });
      }
    }

    // Free lights
    for (const l of def.lights.slice(0, 24)) {
      const light = new THREE.PointLight(l.color, l.intensity, l.range, 1.7);
      light.position.set(l.x, l.y, l.z);
      this.group.add(light);
    }
  }

  // -------------------------------------------------------------------------
  // Water
  // -------------------------------------------------------------------------

  private buildWater(def: MapDef): void {
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x2a6d8f, transparent: true, opacity: 0.72, roughness: 0.12,
      metalness: 0.05, transmission: 0.35,
    });
    for (const w of def.water) {
      const geo = new THREE.PlaneGeometry(w.maxX - w.minX, w.maxZ - w.minZ, 24, 24);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((w.minX + w.maxX) / 2, w.surfaceY, (w.minZ + w.maxZ) / 2);
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.waterMeshes.push(mesh);
    }
  }

  animateWater(t: number): void {
    for (const mesh of this.waterMeshes) {
      const geo = mesh.geometry as THREE.PlaneGeometry;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        pos.setZ(i, Math.sin(x * 0.14 + t * 1.6) * 0.14 + Math.cos(y * 0.11 + t * 1.1) * 0.12);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    }
  }

  // -------------------------------------------------------------------------
  // Destructibles / chests
  // -------------------------------------------------------------------------

  private trackDestructibles(match: Match): void {
    for (const d of match.combat.destructibleList()) {
      const g = d.geo;
      let mesh: THREE.Object3D;
      if (g.kind === 'box') {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(g.sx, g.sy, g.sz), this.mats.get((g as unknown as { mat: MatKey }).mat));
      } else {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(g.r ?? 0.5, g.r ?? 0.5, g.h ?? 1, 10), this.mats.get('wood'));
      }
      mesh.position.set(g.x, g.y, g.z);
      mesh.castShadow = true;
      this.destructibleMeshes.set(d.id, mesh);
      this.group.add(mesh);
    }
  }

  syncDestructibles(match: Match): void {
    for (const d of match.combat.destructibleList()) {
      if (!d.alive) {
        const mesh = this.destructibleMeshes.get(d.id);
        if (mesh) {
          this.group.remove(mesh);
          this.destructibleMeshes.delete(d.id);
        }
      }
    }
  }

  private chestBody(kind: string): THREE.Group {
    const g = new THREE.Group();
    const color = kind === 'vault' ? 0xffb43a : kind === 'elite' ? 0xb06ce8 : 0x4f9fe8;
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.45, metalness: 0.65 });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x111214, emissive: color, emissiveIntensity: 1.4, roughness: 0.4, metalness: 0.4,
    });
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.75, 1.0), bodyMat);
    base.position.y = 0.38;
    base.castShadow = true;
    g.add(base);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.42, 1.06), bodyMat);
    lid.position.y = 0.96;
    lid.name = 'lid';
    lid.castShadow = true;
    g.add(lid);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.1, 1.08), trimMat);
    stripe.position.y = 0.78;
    g.add(stripe);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), trimMat);
    core.position.set(0, 0.62, 0.52);
    g.add(core);
    return g;
  }

  private trackChests(match: Match): void {
    for (const c of match.chests) {
      const mesh = this.chestBody(c.kind);
      mesh.position.set(c.x, c.y, c.z);
      mesh.rotation.y = Math.random() * Math.PI * 2;
      this.chestMeshes.set(c.id, mesh);
      this.group.add(mesh);
    }
  }

  syncChests(match: Match): void {
    for (const c of match.chests) {
      const mesh = this.chestMeshes.get(c.id);
      if (!mesh) continue;
      const lid = mesh.getObjectByName('lid');
      if (lid) lid.rotation.x = -c.openT * 1.9;
      if (c.opened && c.openT < 0.2 && !mesh.userData.glowDone) {
        mesh.userData.glowDone = true;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Loot presentation: floating, bobbing, rarity glow
  // -------------------------------------------------------------------------

  private lootMeshFor(item: WorldItem): THREE.Object3D {
    const g = new THREE.Group();
    if (item.kind === 'weapon') {
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x33383e, roughness: 0.4, metalness: 0.75 });
      const accent = new THREE.MeshStandardMaterial({
        color: 0x101114, emissive: RARITY_COLORS[item.rarity], emissiveIntensity: 1.1, roughness: 0.4,
      });
      const len = item.weapon?.weaponId === 'sniper' ? 1.5 : item.weapon?.weaponId === 'shotgun' ? 1.15 : 0.95;
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.17, len), bodyMat);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.26, 0.14), bodyMat);
      grip.position.set(0, -0.18, len * 0.22);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.04, len * 0.7), accent);
      strip.position.y = 0.1;
      g.add(body, grip, strip);
    } else if (item.kind === 'ammo') {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.44, 0.3, 0.32),
        new THREE.MeshStandardMaterial({ color: 0x4a5038, roughness: 0.7, metalness: 0.2 }),
      );
      g.add(box);
    } else {
      const isMed = item.heal?.itemId === 'medkit';
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.36, 0.36),
        new THREE.MeshStandardMaterial({
          color: isMed ? 0xd8dde2 : 0x2a4a66, roughness: 0.5, metalness: 0.3,
          emissive: isMed ? 0x882030 : 0x10406a, emissiveIntensity: 0.5,
        }),
      );
      const cross1 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.02),
        new THREE.MeshBasicMaterial({ color: isMed ? 0xff5f6d : 0x53d8ff }));
      cross1.position.set(0, 0.05, 0.19);
      const cross2 = cross1.clone();
      cross2.rotation.z = Math.PI / 2;
      g.add(box, cross1, cross2);
    }
    return g;
  }

  syncLoot(match: Match): void {
    const seen = new Set<number>();
    for (const item of match.loot.items) {
      seen.add(item.id);
      let mesh = this.lootMeshes.get(item.id);
      if (!mesh) {
        mesh = this.lootMeshFor(item);
        this.lootMeshes.set(item.id, mesh);
        this.group.add(mesh);
        if (item.kind === 'weapon' && (item.rarity === 'epic' || item.rarity === 'legendary')) {
          const light = new THREE.PointLight(itemGlowColor(item), 1.4, 7, 2);
          this.lootLights.set(item.id, light);
          this.group.add(light);
        }
      }
      const bob = Math.sin(this.time * 2.2 + item.bobPhase) * 0.12;
      mesh.position.set(item.x, item.y + 0.55 + bob, item.z);
      mesh.rotation.y += 0.012;
      const light = this.lootLights.get(item.id);
      if (light) light.position.set(item.x, item.y + 0.8 + bob, item.z);
    }
    // Remove stale
    for (const [id, mesh] of this.lootMeshes) {
      if (!seen.has(id)) {
        this.group.remove(mesh);
        this.lootMeshes.delete(id);
        const light = this.lootLights.get(id);
        if (light) {
          this.group.remove(light);
          this.lootLights.delete(id);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Storm wall + transport
  // -------------------------------------------------------------------------

  private buildStorm(match: Match): void {
    const geo = new THREE.CylinderGeometry(1, 1, 240, 64, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x2e5f9e, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stormMesh = new THREE.Mesh(geo, mat);
    this.stormMesh.position.y = 60;
    this.stormMesh.visible = false;
    this.group.add(this.stormMesh);
    void match;
  }

  syncStorm(match: Match): void {
    if (match.storm.state === 'idle') {
      this.stormMesh.visible = false;
      return;
    }
    const me = match.player;
    const mat = this.stormMesh.material as THREE.MeshBasicMaterial;
    if (!me) {
      this.stormMesh.visible = false;
      return;
    }
    // Fade the wall in as the local player approaches the edge — from deep
    // inside a huge circle it must not tint the whole world.
    const distOutside = match.storm.distanceOutside(me.body.position.x, me.body.position.z);
    let proximity: number;
    if (distOutside >= 0) {
      proximity = 1; // outside: fully visible
    } else {
      const d = -distOutside;
      proximity = Math.max(0, Math.min(1, 1 - (d - 4) / 30));
    }
    if (proximity <= 0.01) {
      this.stormMesh.visible = false;
      return;
    }
    this.stormMesh.visible = true;
    this.stormMesh.position.x = match.storm.centerX;
    this.stormMesh.position.z = match.storm.centerZ;
    this.stormMesh.scale.set(match.storm.radius, 1, match.storm.radius);
    mat.opacity = Math.min(0.34, proximity * (0.2 + Math.sin(this.time * 1.4) * 0.04));
  }

  private buildTransport(match: Match): void {
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.5, metalness: 0.7 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x0c1218, emissive: 0x53e0ff, emissiveIntensity: 0.7, roughness: 0.3, metalness: 0.5,
    });
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(3.4, 14, 6, 12), hullMat);
    hull.geometry.rotateZ(Math.PI / 2);
    hull.castShadow = true;
    const wingL = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.3, 7), hullMat);
    wingL.position.set(-2, 0.6, 5.4);
    wingL.rotation.z = 0.16;
    const wingR = wingL.clone();
    wingR.position.z = -5.4;
    wingR.rotation.z = -0.16;
    const engineGlow = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), glassMat);
    engineGlow.position.set(-9.4, 0, 0);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(3.4, 4.4, 0.3), hullMat);
    fin.position.set(6.4, 2.4, 0);
    this.transportGroup.add(hull, wingL, wingR, engineGlow, fin);
    this.transportGroup.visible = false;
    this.group.add(this.transportGroup);
    void match;
  }

  /** Per-frame updates driven by the game loop. */
  update(dt: number, match: Match): void {
    this.time += dt;
    this.animateWater(this.time);
    this.syncLoot(match);
    this.syncChests(match);
    this.syncDestructibles(match);
    this.syncStorm(match);

    if (match.phase === 'transport') {
      this.transportGroup.visible = true;
      this.transportGroup.position.set(match.transportPos.x, match.transportPos.y, match.transportPos.z);
      this.transportGroup.rotation.y = Math.atan2(
        match.transportTo[0] - match.transportFrom[0],
        match.transportTo[1] - match.transportFrom[1],
      );
    } else {
      this.transportGroup.visible = false;
    }
  }
}
