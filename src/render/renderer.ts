/**
 * GameRenderer: WebGL renderer, post-processing composer, sky, lighting rig
 * per map preset, quality settings application.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import type { SkyConfig } from '../world/types';
import { getSettings } from '../core/settings';

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cameraAttached = new THREE.Group();
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private fxaaPass: ShaderPass | null = null;
  private outputPass: OutputPass | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private hemi: THREE.HemisphereLight | null = null;
  private ambient: THREE.AmbientLight | null = null;
  private skyMesh: THREE.Mesh | null = null;

  /** Keep the sky centered on the viewer so it never hits the far plane. */
  followViewer(pos: THREE.Vector3): void {
    if (!this.skyMesh) return;
    this.skyMesh.position.set(pos.x, 0, pos.z);
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.32;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const settings = getSettings();
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * settings.resolutionScale);
    this.renderer.setSize(w, h);
    this.composer?.setSize(w * settings.resolutionScale, h * settings.resolutionScale);
    if (this.fxaaPass) {
      (this.fxaaPass.material.uniforms['resolution']!.value as THREE.Vector2).set(
        1 / (w * settings.resolutionScale),
        1 / (h * settings.resolutionScale),
      );
    }
  }

  setupSkyAndLights(sky: SkyConfig): void {
    // Background gradient via large inverted sphere
    const geo = new THREE.SphereGeometry(800, 24, 16);
    const top = new THREE.Color(sky.preset === 'night' ? 0x0b1022 : sky.preset === 'overcast' ? 0x9fb0bd : 0x8fc4e8);
    const bottom = new THREE.Color(sky.preset === 'night' ? 0x141a2e : sky.preset === 'overcast' ? 0xc4cdd5 : 0xd8ecf6);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: top },
        bottomColor: { value: bottom },
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vPos;
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        void main() {
          float h = normalize(vPos).y * 0.5 + 0.5;
          gl_FragColor = vec4(mix(bottomColor, topColor, pow(clamp(h, 0.0, 1.0), 0.7)), 1.0);
        }`,
    });
    const skyMesh = new THREE.Mesh(geo, mat);
    skyMesh.frustumCulled = false;
    this.scene.add(skyMesh);
    this.skyMesh = skyMesh;

    this.scene.fog = new THREE.FogExp2(sky.fogColor, sky.fogDensity);

    const sunDir = new THREE.Vector3(...sky.sunDirection).normalize();
    const sunPos = sunDir.multiplyScalar(300).negate();
    sunPos.y = Math.abs(sunPos.y) + 60;
    this.sun = new THREE.DirectionalLight(sky.sunColor, sky.sunIntensity);
    this.sun.position.copy(sunPos);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 20;
    this.sun.shadow.camera.far = 700;
    this.sun.shadow.camera.left = -260;
    this.sun.shadow.camera.right = 260;
    this.sun.shadow.camera.top = 260;
    this.sun.shadow.camera.bottom = -260;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(sky.hemisphereSky, sky.hemisphereGround, sky.hemisphereIntensity);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(sky.ambientColor, sky.ambientIntensity);
    this.scene.add(this.ambient);
  }

  /** Keep the shadow frustum centered near the player for crisp shadows. */
  followSunTarget(pos: THREE.Vector3): void {
    if (!this.sun) return;
    this.sun.target.position.copy(pos);
    this.sun.position.copy(pos).add(this.sunOffset ?? new THREE.Vector3(120, 220, 90));
  }
  private sunOffset: THREE.Vector3 | null = null;

  buildComposer(camera: THREE.Camera): void {
    this.composer?.dispose();
    const settings = getSettings();
    const w = window.innerWidth * settings.resolutionScale;
    const h = window.innerHeight * settings.resolutionScale;
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(w, h);

    this.renderPass = new RenderPass(this.scene, camera);
    this.composer.addPass(this.renderPass);

    if (settings.bloom && settings.postProcessing) {
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.55, 0.82);
      this.composer.addPass(this.bloomPass);
    } else {
      this.bloomPass = null;
    }

    if (settings.aa === 'fxaa') {
      this.fxaaPass = new ShaderPass(FXAAShader);
      this.resize();
      this.composer.addPass(this.fxaaPass);
    } else {
      this.fxaaPass = null;
    }

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
    this.renderPass.camera = camera;
  }

  applyQuality(): void {
    const settings = getSettings();
    this.renderer.shadowMap.enabled = settings.shadows;
    if (this.sun) {
      const size = settings.shadowQuality === 'high' ? 2048 : settings.shadowQuality === 'medium' ? 1024 : 512;
      this.sun.castShadow = settings.shadows;
      if (this.sun.shadow.map && this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null as never;
        this.sun.shadow.mapSize.set(size, size);
      }
    }
    if (this.hemi) this.hemi.intensity = settings.quality === 'low' ? 0.7 : 1;
    const needsRebuild =
      (this.bloomPass === null) !== !(settings.bloom && settings.postProcessing) ||
      (this.fxaaPass === null) !== !(settings.aa === 'fxaa');
    if (needsRebuild && this.renderPass) {
      this.buildComposer(this.renderPass.camera);
    }
    this.resize();
  }

  render(dt: number): void {
    const settings = getSettings();
    const usePost = settings.postProcessing || settings.aa === 'fxaa';
    if (this.composer && usePost && this.renderPass) {
      this.composer.render(dt);
    } else {
      // Direct path (also used by the 'low' preset / headless QA).
      const cam = (this.renderPass?.camera ?? undefined) as THREE.Camera | undefined;
      if (cam) this.renderer.render(this.scene, cam);
    }
  }
}
