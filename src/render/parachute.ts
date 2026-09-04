/**
 * Presentation-only glide canopy. A striped semi-ellipsoid canopy with
 * suspension lines rides above a character rig while the actor's move state
 * is `glide`. Pure decoration on top of the authored movement code — it
 * never touches the sim, colliders, or network state.
 */

import * as THREE from 'three';

const CANOPY_Y = 2.35;
const DEPLOY_RATE = 7.5;

/** Classic radial panel stripes tinted with the actor's accent colour. */
function panelTexture(accent: number): THREE.CanvasTexture | null {
  // Unit-test/node environments have no DOM: fall back to a plain material.
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const accentCss = `#${accent.toString(16).padStart(8, '0').slice(2)}`;
  const panels = 8;
  for (let i = 0; i < panels; i++) {
    ctx.fillStyle = i % 2 === 0 ? accentCss : '#e8e4da';
    ctx.fillRect(i * (c.width / panels), 0, c.width / panels, c.height);
  }
  // Panel seam shading keeps the dome readable instead of flat poster art.
  const shade = ctx.createLinearGradient(0, 0, 0, c.height);
  shade.addColorStop(0, 'rgba(0,0,0,0.22)');
  shade.addColorStop(0.55, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, c.width, c.height);
  return new THREE.CanvasTexture(c);
}

export class ParachuteView {
  readonly group = new THREE.Group();
  private canopy: THREE.Mesh;
  private lines: THREE.LineSegments;
  private deployed = 0;

  constructor(accent: number) {
    // Shallow dome: sphere top cap squashed on Y, open rim facing down so
    // the classic chase camera (below and behind) sees the striped inside.
    const geo = new THREE.SphereGeometry(1.35, 20, 10, 0, Math.PI * 2, 0, 1.15);
    geo.scale(1, 0.62, 0.86);
    const stripeMap = panelTexture(accent);
    const mat = new THREE.MeshStandardMaterial({
      ...(stripeMap ? { map: stripeMap } : {}),
      color: stripeMap ? 0xffffff : new THREE.Color(accent).lerp(new THREE.Color(0xe8e4da), 0.4),
      side: THREE.DoubleSide,
      roughness: 0.86,
      metalness: 0,
      emissive: new THREE.Color(accent),
      emissiveIntensity: 0.05,
    });
    this.canopy = new THREE.Mesh(geo, mat);
    this.canopy.castShadow = true;
    this.group.add(this.canopy);

    // Suspension lines: canopy rim down to the rig's shoulder harness
    // (harness sits ~1.55 above the rig's feet origin).
    const rim = 1.24;
    const rimY = 0.34;
    const harnessY = 1.55 - CANOPY_Y;
    const anchors: Array<[number, number]> = [[-0.16, 0.1], [0.16, 0.1]];
    const points: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = Math.cos(a) * rim;
      const pz = Math.sin(a) * rim * 0.86;
      const [ax, az] = anchors[i % 2]!;
      points.push(px, rimY, pz, ax, harnessY, az);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xd8dde4,
      transparent: true,
      opacity: 0,
    });
    this.lines = new THREE.LineSegments(lineGeo, lineMat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);

    // Rest folded at the rig's feet: a canopy parked overhead would inflate
    // every rig bounding box (and with it LOD/QA metrics) for a prop that is
    // invisible until the glide state lifts it into place.
    this.group.position.set(0, 0.01, 0);
    this.group.scale.setScalar(0.001);
    this.group.visible = false;
  }

  /** Ease the canopy toward `deploy` (true while the actor glides). */
  update(deploy: boolean, t: number, dt: number): void {
    this.deployed += ((deploy ? 1 : 0) - this.deployed) * Math.min(1, dt * DEPLOY_RATE);
    const k = this.deployed;
    if (k < 0.002) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.set(0, CANOPY_Y, 0.05);
    // easeOutBack: a fast snatch past full size sells canopy inflation.
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const x = k - 1;
    const pop = 1 + c3 * x * x * x + c1 * x * x;
    const breathe = 1 + Math.sin(t * 2.3) * 0.014 * k;
    this.group.scale.setScalar(Math.max(0.001, pop * breathe));
    // Gentle pendulum sway so a deployed canopy reads as load-bearing.
    this.group.rotation.z = Math.sin(t * 1.1) * 0.05 * k;
    this.group.rotation.x = Math.sin(t * 0.83 + 1.3) * 0.04 * k;
    (this.lines.material as THREE.LineBasicMaterial).opacity = 0.85 * k;
  }

  dispose(): void {
    this.canopy.geometry.dispose();
    const canopyMat = this.canopy.material as THREE.MeshStandardMaterial;
    canopyMat.map?.dispose();
    canopyMat.dispose();
    this.lines.geometry.dispose();
    (this.lines.material as THREE.LineBasicMaterial).dispose();
    this.group.removeFromParent();
  }
}
