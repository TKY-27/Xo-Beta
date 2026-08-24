/**
 * 3D lobby: near-future hangar scene with the selected combatant standing
 * under studio lighting while menus are open. Rendered on the game canvas;
 * torn down when a match starts.
 */

import * as THREE from 'three';
import { CharacterFactory, type CharacterRig } from './characters';
import type { WeaponModelFactory } from './weaponModels';

/** Minimal actor-shaped stub that drives the idle/aim pose. */
function lobbyActor(pitch = 0): Parameters<NonNullable<CharacterRig['update']>>[0] {
  return {
    body: {
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: true,
    },
    state: 'ground',
    alive: true,
    yaw: 0,
    pitch,
    crouched: false,
    healing: null,
    grappleActive: false,
    wallSide: 1,
    wpn: { adsAmount: 0, reloadTimer: 0, reloadTotal: 1, boltTimer: 0, reloadingEmpty: false, lastShotTime: 99, recoilYaw: 0, recoilPitch: 0 },
    inv: { selectedWeapon: { weaponId: 'ar', rarity: 'rare', ammoInMag: 30 }, slots: [], ammo: {}, selected: 0 },
  } as never;
}

export class LobbyScene {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private rig: CharacterRig | null = null;
  private running = false;
  private t = 0;
  private last = 0;
  private reduced = false;

  start(
    canvas: HTMLCanvasElement,
    characters: CharacterFactory,
    weapons: WeaponModelFactory,
  ): void {
    this.stop();
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070a12);
    scene.fog = new THREE.Fog(0x070a12, 14, 42);

    // Floor: dark reflective disc
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(18, 48),
      new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.32, metalness: 0.78 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Concentric accent rings
    for (const [r, color] of [[5.2, 0x2b7fd4], [9.5, 0x18324a]] as Array<[number, number]>) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.06, r, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      scene.add(ring);
    }

    // Light strips behind the character (vertical bars, cyan/magenta)
    const stripGeo = new THREE.BoxGeometry(0.22, 7, 0.22);
    const mkStrip = (x: number, z: number, color: number) => {
      const strip = new THREE.Mesh(stripGeo, new THREE.MeshBasicMaterial({ color }));
      strip.position.set(x, 3.5, z);
      scene.add(strip);
      const light = new THREE.PointLight(color, 26, 26, 2);
      light.position.set(x * 0.72, 3.2, z * 0.72);
      scene.add(light);
    };
    mkStrip(-4.4, -5.5, 0x53d8ff);
    mkStrip(4.4, -5.5, 0xb06ce8);
    mkStrip(0, -7.5, 0x5fd0ff);

    // Backdrop wall panels
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 0.85, metalness: 0.25 });
    for (let i = -3; i <= 3; i++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 9.5, 0.3), wallMat);
      panel.position.set(i * 3.8, 4.75, -10.5);
      panel.rotation.y = i * -0.05;
      scene.add(panel);
    }

    // Key + fill lights
    const key = new THREE.SpotLight(0xeaf4ff, 420, 34, Math.PI / 4.6, 0.42, 1.7);
    key.position.set(3.4, 7.6, 4.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key, key.target);
    const rim = new THREE.SpotLight(0x9fd8ff, 130, 26, Math.PI / 3.4, 0.6, 1.9);
    rim.position.set(-4.6, 5.2, -3.4);
    scene.add(rim, rim.target);
    const fill = new THREE.HemisphereLight(0x33465e, 0x0b0e14, 1.0);
    scene.add(fill);

    // Combatant display: character + held weapon
    const rig = characters.create('LOBBY_YOU', 0x5fd0ff, false);
    const wm = weapons.build('ar', 'epic');
    if (wm) {
      wm.group.scale.multiplyScalar(1.35);
      rig.attachWeapon?.(wm.group);
    }
    rig.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = true;
    });
    scene.add(rig.group);
    const actor = lobbyActor();

    const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 90);

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.rig = rig;
    this.reduced = (localStorage.getItem('xo-beta-settings-v1') ?? '').includes('"reducedMotion":true');
    this.running = true;
    this.last = performance.now();

    const loop = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;

      this.rig!.group.rotation.y = Math.sin(this.t * 0.22) * 0.55;
      this.rig!.update?.(actor, now / 1000, dt);

      // Character framed right-of-center; nav rail owns the left edge.
      if (!this.reduced && this.camera) {
        const a = this.t * 0.1;
        const r = 5.2;
        this.camera.position.set(Math.sin(a) * r - 1.15, 1.74 + Math.sin(this.t * 0.31) * 0.15, Math.cos(a) * r + 0.9);
        this.camera.lookAt(-1.35, 1.04, 0);
      } else if (this.camera) {
        this.camera.position.set(1.6, 1.7, 4.9);
        this.camera.lookAt(-1.35, 1.04, 0);
      }

      renderer.render(scene, this.camera!);
    };
    requestAnimationFrame(loop);

    const onResize = () => {
      if (!this.renderer || !this.camera) return;
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', onResize);
    this.cleanupResize = () => window.removeEventListener('resize', onResize);
  }

  private cleanupResize: (() => void) | null = null;

  stop(): void {
    this.running = false;
    this.cleanupResize?.();
    this.cleanupResize = null;
    if (this.rig) {
      for (const m of [...this.rig.accentMats, ...this.rig.baseMats]) m.dispose();
    }
    this.scene?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else mat?.dispose();
      }
    });
    this.scene = null;
    this.rig = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.camera = null;
  }
}
