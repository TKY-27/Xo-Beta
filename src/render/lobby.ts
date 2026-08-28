/**
 * 3D lobby: bright near-future hangar scene with the selected combatant
 * standing under studio lighting while menus are open. Rendered on the game
 * canvas; torn down when a match starts.
 */

import * as THREE from 'three';
import { getSettings, onSettingsChanged } from '../core/settings';
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
    inv: { selectedWeapon: { weaponId: 'ar', rarity: 'common', ammoInMag: 30 }, slots: [], ammo: {}, selected: 0 },
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
  private characters: CharacterFactory | null = null;
  private actor = lobbyActor();
  private previewSkin = getSettings().playerSkin;
  private cleanupSettings: (() => void) | null = null;
  /** Horizontal look-at offset, eased each frame (pans the character in frame). */
  private lookX = -1.35;
  private lookXTarget = -1.35;

  start(
    canvas: HTMLCanvasElement,
    characters: CharacterFactory,
    _weapons: WeaponModelFactory,
  ): void {
    this.stop();
    this.characters = characters;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e1622);
    scene.fog = new THREE.Fog(0x0e1622, 18, 52);

    // Floor: bright steel disc with a soft cyan sheen
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(18, 48),
      new THREE.MeshStandardMaterial({ color: 0x232c3a, roughness: 0.38, metalness: 0.72 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Concentric accent rings
    for (const [r, color] of [[5.2, 0x3f9de8], [9.5, 0x27455e]] as Array<[number, number]>) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.06, r, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      scene.add(ring);
    }

    // Luminous backdrop core: a tall soft glow behind the combatant gives the
    // scene its bright cyan identity (reference-style hero backlight).
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(13, 10),
      new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.16 }),
    );
    glow.position.set(0, 4.6, -11.8);
    scene.add(glow);
    const glowCore = new THREE.Mesh(
      new THREE.PlaneGeometry(6.4, 7.6),
      new THREE.MeshBasicMaterial({ color: 0xcdeeff, transparent: true, opacity: 0.2 }),
    );
    glowCore.position.set(0, 4.2, -11.7);
    scene.add(glowCore);

    // Light strips behind the character (vertical bars, cyan/magenta)
    const stripGeo = new THREE.BoxGeometry(0.22, 7, 0.22);
    const mkStrip = (x: number, z: number, color: number) => {
      const strip = new THREE.Mesh(stripGeo, new THREE.MeshBasicMaterial({ color }));
      strip.position.set(x, 3.5, z);
      scene.add(strip);
      const light = new THREE.PointLight(color, 18, 30, 2);
      light.position.set(x * 0.72, 3.2, z * 0.72);
      scene.add(light);
    };
    mkStrip(-4.4, -5.5, 0x53d8ff);
    mkStrip(4.4, -5.5, 0xb06ce8);
    mkStrip(0, -7.5, 0x5fd0ff);

    // Backdrop wall panels
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a2331, roughness: 0.8, metalness: 0.3 });
    for (let i = -3; i <= 3; i++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 9.5, 0.3), wallMat);
      panel.position.set(i * 3.8, 4.75, -10.5);
      panel.rotation.y = i * -0.05;
      scene.add(panel);
    }

    // Key + fill lights
    const key = new THREE.SpotLight(0xeaf4ff, 230, 36, Math.PI / 4.4, 0.45, 1.6);
    key.position.set(3.4, 7.6, 4.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key, key.target);
    const rim = new THREE.SpotLight(0x9fd8ff, 92, 28, Math.PI / 3.2, 0.55, 1.8);
    rim.position.set(-4.6, 5.2, -3.4);
    scene.add(rim, rim.target);
    const fill = new THREE.HemisphereLight(0x4a688c, 0x141a24, 1.7);
    scene.add(fill);

    // Combatant display: unarmed hero (fists guard pose — the permanent
    // melee stance). Weapon poses read poorly at lobby framing; the in-match
    // TPS rig shows weapons correctly.
    const rig = characters.create('LOBBY_YOU', 0x5fd0ff, false, null, getSettings().playerSkin);
    rig.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = true;
    });
    scene.add(rig.group);
    this.actor = lobbyActor();
    this.previewSkin = getSettings().playerSkin;

    const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 90);

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.rig = rig;
    this.reduced = getSettings().reducedMotion;
    this.running = true;
    this.last = performance.now();
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__xoLobbyRig = rig;
    }
    this.cleanupSettings = onSettingsChanged((settings) => {
      this.reduced = settings.reducedMotion;
      if (settings.playerSkin !== this.previewSkin) {
        this.previewSkin = settings.playerSkin;
        this.replacePreviewRig();
      }
    });

    const loop = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;

      // Keep the costume front aimed at the slowly orbiting camera. A fixed
      // gameplay yaw inevitably drifted into a side/back view, hiding the
      // palette and chest armour that players are trying to compare.
      const previewFacing = this.camera
        ? Math.atan2(this.camera.position.x, this.camera.position.z)
        : 0;
      this.actor.yaw = previewFacing + Math.PI + Math.sin(this.t * 0.32) * 0.06;
      this.rig?.update?.(this.actor, now / 1000, dt);

      this.lookX += (this.lookXTarget - this.lookX) * Math.min(1, dt * 4.5);

      // Character framed right-of-center; nav rail owns the left edge.
      if (!this.reduced && this.camera) {
        // A restrained studio dolly reveals silhouette depth without orbiting
        // behind the model or leaving the authored key light. Full 360-degree
        // rotation made the selected skin periodically collapse to black.
        const a = Math.sin(this.t * 0.18) * 0.18;
        const r = 5.4;
        this.camera.position.set(Math.sin(a) * r - 1.15, 1.76 + Math.sin(this.t * 0.31) * 0.12, Math.cos(a) * r + 0.9);
        this.camera.lookAt(this.lookX, 1.06, 0);
      } else if (this.camera) {
        this.camera.position.set(1.6, 1.7, 4.9);
        this.camera.lookAt(this.lookX, 1.06, 0);
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

  /** Rebuild only the preview rig; the selected skin is persisted by settings. */
  private replacePreviewRig(): void {
    if (!this.scene || !this.characters) return;
    this.rig?.dispose();
    const next = this.characters.create('LOBBY_YOU', 0x5fd0ff, false, null, this.previewSkin);
    next.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = true;
    });
    this.scene.add(next.group);
    this.rig = next;
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__xoLobbyRig = next;
    }
  }

  /**
   * Recompose the hero for the active screen: centered for the main menu,
   * panned toward the left edge when a wide panel (settings) owns the right.
   */
  compose(screen: 'main' | 'settings'): void {
    this.lookXTarget = screen === 'settings' ? 0.4 : -1.35;
  }

  stop(): void {
    this.running = false;
    this.cleanupSettings?.();
    this.cleanupSettings = null;
    if (import.meta.env.DEV) {
      delete (window as unknown as Record<string, unknown>).__xoLobbyRig;
    }
    this.cleanupResize?.();
    this.cleanupResize = null;
    if (this.rig) {
      // Remove the rig before traversing lobby-owned resources: its skinned
      // geometry is shared with the page-lifetime character prototype.
      this.rig.dispose();
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
    this.characters = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.camera = null;
  }
}
