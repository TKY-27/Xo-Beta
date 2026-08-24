/**
 * GameRenderer: WebGL renderer, HDRI image-based lighting, post-processing
 * composer (bloom / GTAO / SMAA-FXAA / grading), per-map lighting rig and
 * quality settings application.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import type { SkyConfig } from '../world/types';
import { getSettings } from '../core/settings';
import { loadHdri } from '../assets/assets';

/** Display-referred grading: vignette + gentle saturation/contrast shaping. */
const GradingShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.32 },
    uVignetteSoftness: { value: 0.55 },
    uSaturation: { value: 1.04 },
    uContrast: { value: 1.02 },
    uLift: { value: new THREE.Vector3(0.0, 0.0, 0.004) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uVignetteSoftness;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3 uLift;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      // contrast around mid gray
      c = (c - 0.5) * uContrast + 0.5;
      // saturation
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      // gentle blue lift in shadows for filmic feel
      c += uLift * (1.0 - l);
      // vignette
      vec2 d = vUv - 0.5;
      float vig = smoothstep(uVignette, uVignette - uVignetteSoftness, length(d));
      c *= mix(1.0 - uVignette * 0.35, 1.0, vig);
      gl_FragColor = vec4(max(c, 0.0), src.a);
    }`,
};

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private gtaoPass: GTAOPass | null = null;
  private smaaPass: SMAAPass | null = null;
  private fxaaPass: ShaderPass | null = null;
  private gradingPass: ShaderPass | null = null;
  private outputPass: OutputPass | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private hemi: THREE.HemisphereLight | null = null;
  private ambient: THREE.AmbientLight | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private sunOffset = new THREE.Vector3(120, 220, 90);
  private grading = { vignette: 0.3, saturation: 1.05, contrast: 1.03, lift: new THREE.Vector3(0, 0, 0.004) };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(this.effectivePixelRatio());

    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const settings = getSettings();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = this.effectivePixelRatio() * settings.resolutionScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    if (this.composer) {
      // EffectComposer caches the pixel ratio at construction — keep it in
      // sync or its render targets silently keep the stale resolution.
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
    }
    if (this.fxaaPass) {
      (this.fxaaPass.material.uniforms['resolution']!.value as THREE.Vector2).set(1 / (w * pr), 1 / (h * pr));
    }
  }

  /**
   * Quality-gated device-pixel-ratio cap. Full native retina (dpr 2) with the
   * complete PBR+post pipeline exceeds the fill budget of reference GPUs at
   * 60fps; every shipped title renders internally below native. 'cinematic'
   * keeps native resolution; interactive presets render at a crisp
   * supersampled-but-bounded scale (browser upscales; SMAA catches edges).
   */
  private effectivePixelRatio(): number {
    const q = getSettings().quality;
    const cap = q === 'cinematic' ? 2 : q === 'ultra' ? 1.2 : q === 'high' ? 1.05 : 1;
    return Math.min(window.devicePixelRatio, cap);
  }

  /**
   * Configure sky, IBL environment and lights from a map's SkyConfig.
   * When `sky.hdri` is set the equirect HDR becomes both background and the
   * radiance source (PMREM), giving real image-based lighting.
   */
  async setupSkyAndLights(sky: SkyConfig): Promise<void> {
    if (this.pmrem) this.disposeEnvironment();
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    if (sky.preset === 'bluehour') {
      // Authored competitive blue-hour city sky: bright enough to fight in,
      // deep blue gradient with a glowing horizon. Also drives IBL.
      const tex = makeBlueHourSkyTexture();
      this.envRenderTarget?.dispose();
      this.envRenderTarget = this.pmrem.fromEquirectangular(tex);
      this.scene.environment = this.envRenderTarget.texture;
      this.scene.environmentIntensity = sky.envIntensity ?? 0.9;
      this.scene.background = tex;
      this.scene.backgroundIntensity = sky.backgroundIntensity ?? 1.0;
      this.scene.backgroundBlurriness = sky.backgroundBlurriness ?? 0;
    } else if (sky.hdri) {
      try {
        const equirect = await loadHdri(sky.hdri);
        this.envRenderTarget?.dispose();
        this.envRenderTarget = this.pmrem.fromEquirectangular(equirect);
        this.scene.environment = this.envRenderTarget.texture;
        this.scene.environmentIntensity = sky.envIntensity ?? 0.8;
        if (sky.preset === 'night') {
          // Authored starfield backdrop instead of photographic horizon.
          this.scene.background = makeNightSkyTexture();
          this.scene.backgroundIntensity = sky.backgroundIntensity ?? 1.0;
        } else {
          this.scene.background = equirect;
          this.scene.backgroundBlurriness = sky.backgroundBlurriness ?? 0.04;
          this.scene.backgroundIntensity = sky.backgroundIntensity ?? 1.0;
        }
      } catch (err) {
        console.warn('HDRI unavailable, falling back to gradient sky', err);
        this.setupGradientSky(sky);
      }
    } else {
      this.setupGradientSky(sky);
    }

    this.scene.fog = new THREE.FogExp2(sky.fogColor, sky.fogDensity);
    this.renderer.toneMappingExposure = sky.exposure ?? 1.25;

    const sunDir = new THREE.Vector3(...sky.sunDirection).normalize();
    const sunPos = sunDir.multiplyScalar(300).negate();
    sunPos.y = Math.abs(sunPos.y) + 60;
    this.sun = new THREE.DirectionalLight(sky.sunColor, sky.sunIntensity);
    this.sun.position.copy(sunPos);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 560;
    this.sun.shadow.camera.left = -110;
    this.sun.shadow.camera.right = 110;
    this.sun.shadow.camera.top = 110;
    this.sun.shadow.camera.bottom = -110;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(sky.hemisphereSky, sky.hemisphereGround, sky.hemisphereIntensity);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(sky.ambientColor, sky.ambientIntensity);
    this.scene.add(this.ambient);
  }

  private setupGradientSky(sky: SkyConfig): void {
    const geo = new THREE.SphereGeometry(800, 24, 16);
    const top = new THREE.Color(sky.preset === 'night' ? 0x0b1022 : sky.preset === 'bluehour' ? 0x050b1c : sky.preset === 'overcast' ? 0x9fb0bd : 0x8fc4e8);
    const bottom = new THREE.Color(sky.preset === 'night' ? 0x141a2e : sky.preset === 'bluehour' ? 0x24406e : sky.preset === 'overcast' ? 0xc4cdd5 : 0xd8ecf6);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { topColor: { value: top }, bottomColor: { value: bottom } },
      vertexShader: `varying vec3 vPos; void main(){ vPos=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `varying vec3 vPos; uniform vec3 topColor; uniform vec3 bottomColor;
        void main(){ float h=normalize(vPos).y*0.5+0.5; gl_FragColor=vec4(mix(bottomColor,topColor,pow(clamp(h,0.0,1.0),0.7)),1.0); }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.name = 'fallback-sky';
    this.scene.add(mesh);
  }  private disposeEnvironment(): void {
    this.envRenderTarget?.dispose();
    this.envRenderTarget = null;
    this.scene.environment = null;
    this.scene.background = null;
    this.pmrem?.dispose();
    this.pmrem = null;
  }

  /** Keep the shadow frustum centered near the viewer for crisp shadows. */
  followSunTarget(pos: THREE.Vector3): void {
    if (!this.sun) return;
    this.sun.target.position.copy(pos);
    this.sun.position.copy(pos).add(this.sunOffset);
  }

  /** Legacy no-op retained for API stability (background is infinite). */
  followViewer(_pos: THREE.Vector3): void {
    void _pos;
  }

  buildComposer(camera: THREE.Camera): void {
    this.composer?.dispose();
    const settings = getSettings();
    const w = Math.max(8, window.innerWidth);
    const h = Math.max(8, window.innerHeight);
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.effectivePixelRatio() * settings.resolutionScale);
    this.composer.setSize(w, h);

    this.renderPass = new RenderPass(this.scene, camera);
    this.composer.addPass(this.renderPass);

    const cinematic = settings.quality === 'cinematic';
    const wantAO = settings.ao && (settings.quality === 'ultra' || cinematic) && settings.postProcessing;
    if (wantAO && !this.gtaoPass) {
      this.gtaoPass = new GTAOPass(this.scene, camera, w, h);
      this.gtaoPass.updateGtaoMaterial({
        radius: cinematic ? 0.35 : 0.28,
        distanceExponent: 1.4,
        thickness: 1,
        scale: 1.1,
        samples: cinematic ? 24 : 12,
        screenSpaceRadius: false,
      });
      this.gtaoPass.output = GTAOPass.OUTPUT.Default;
      // AO is a low-frequency effect — render its depth/normal + compute at
      // half resolution and let the composite bilinearly upsample. ~4x cheaper
      // with no visible difference at gameplay camera distances.
      if (!cinematic) {
        const origSetSize = this.gtaoPass.setSize.bind(this.gtaoPass);
        this.gtaoPass.setSize = (w: number, h: number) => origSetSize(Math.max(8, Math.round(w / 2)), Math.max(8, Math.round(h / 2)));
      }
      this.composer.addPass(this.gtaoPass);
    } else if (!wantAO && this.gtaoPass) {
      this.gtaoPass.dispose();
      this.gtaoPass = null;
    }

    if (settings.bloom && settings.postProcessing) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(w, h),
        cinematic ? 0.42 : 0.5,
        cinematic ? 0.75 : 0.62,
        cinematic ? 0.86 : 0.84,
      );
      this.composer.addPass(this.bloomPass);
    } else {
      this.bloomPass = null;
    }

    if (settings.aa === 'smaa') {
      this.smaaPass = new SMAAPass();
      this.composer.addPass(this.smaaPass);
      this.fxaaPass = null;
    } else if (settings.aa === 'fxaa') {
      this.fxaaPass = new ShaderPass(FXAAShader);
      this.resize();
      this.composer.addPass(this.fxaaPass);
      this.smaaPass = null;
    } else {
      this.smaaPass = null;
      this.fxaaPass = null;
    }

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    if (settings.postProcessing) {
      this.gradingPass = new ShaderPass(GradingShader);
      const u = this.gradingPass.uniforms as Record<string, { value: unknown }> | undefined;
      if (u) {
        u['uVignette']!.value = this.grading.vignette;
        u['uSaturation']!.value = this.grading.saturation;
        u['uContrast']!.value = this.grading.contrast;
        (u['uLift']!.value as THREE.Vector3).copy(this.grading.lift);
      }
      this.composer.addPass(this.gradingPass);
    } else {
      this.gradingPass = null;
    }

    this.renderPass.camera = camera;
    this.resize();
  }

  applyQuality(): void {
    const settings = getSettings();
    this.renderer.shadowMap.enabled = settings.shadows;
    if (this.sun) {
      const size =
        settings.shadowQuality === 'cinematic' || (settings.quality === 'cinematic' && settings.shadowQuality === 'high')
          ? 4096
          : settings.shadowQuality === 'high'
            ? 2048
            : settings.shadowQuality === 'medium'
              ? 1024
              : 512;
      this.sun.castShadow = settings.shadows;
      if (this.sun.shadow.map && this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null as never;
        this.sun.shadow.mapSize.set(size, size);
      }
      // Tighter frustum on high presets for contact-quality shadows.
      const ext = settings.quality === 'low' ? 160 : 110;
      const cam = this.sun.shadow.camera;
      cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
      cam.updateProjectionMatrix();
    }
    const needsRebuild = !this.composer ||
      (this.bloomPass === null) !== !(settings.bloom && settings.postProcessing) ||
      (this.smaaPass === null) !== !(settings.aa === 'smaa') ||
      (this.fxaaPass === null) !== !(settings.aa === 'fxaa') ||
      (this.gradingPass === null) !== !(settings.postProcessing);
    if (needsRebuild && this.renderPass) {
      this.buildComposer(this.renderPass.camera);
    }
    this.resize();
  }

  /** Set the per-map display grade (called when a map loads). */
  setGrading(grade: { vignette?: number; saturation?: number; contrast?: number; lift?: [number, number, number] }): void {
    if (grade.vignette !== undefined) this.grading.vignette = grade.vignette;
    if (grade.saturation !== undefined) this.grading.saturation = grade.saturation;
    if (grade.contrast !== undefined) this.grading.contrast = grade.contrast;
    if (grade.lift) this.grading.lift.set(...grade.lift);
  }

  render(dt: number): void {
    const settings = getSettings();
    const usePost = settings.postProcessing || settings.aa !== 'off';
    if (this.composer && usePost && this.renderPass) {
      this.composer.render(dt);
    } else {
      const cam = (this.renderPass?.camera ?? undefined) as THREE.Camera | undefined;
      if (cam) this.renderer.render(this.scene, cam);
    }
  }
}

/**
 * Authored blue-hour city sky (equirect): deep zenith blue, luminous cyan
 * horizon with a warm sodium band, high cirrus streaks and sparse stars.
 * Bright enough for readable night combat while clearly reading as night.
 */
function makeBlueHourSkyTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  // Vertical gradient: deep night zenith → luminous blue horizon → dark below
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, '#050b1c');
  grad.addColorStop(0.26, '#0b1c3e');
  grad.addColorStop(0.4, '#16305f');
  grad.addColorStop(0.47, '#2a4f88');
  grad.addColorStop(0.5, '#4f7fb4');
  grad.addColorStop(0.525, '#8fb2d4');
  grad.addColorStop(0.55, '#c8a878'); // thin warm sodium band at the horizon
  grad.addColorStop(0.58, '#2c3450');
  grad.addColorStop(0.72, '#10141f');
  grad.addColorStop(1.0, '#090b11');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Stars: dense near zenith, fading toward the horizon glow
  let seed = 90210;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed & 0x7fffffff) / 0x7fffffff;
  };
  for (let i = 0; i < 420; i++) {
    const x = rnd() * w;
    const y = rnd() * h * 0.42;
    const fade = 1 - y / (h * 0.42);
    const a = (0.2 + rnd() * 0.6) * fade * fade;
    ctx.fillStyle = `rgba(215,228,252,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, rnd() < 0.08 ? rnd() * 1.1 + 0.5 : rnd() * 0.6 + 0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Distant city glow patches along the horizon (wrap-safe)
  for (let i = 0; i < 10; i++) {
    const x = rnd() * w;
    const rw = 50 + rnd() * 130;
    const g3 = ctx.createRadialGradient(x, h * 0.53, 3, x, h * 0.53, rw);
    g3.addColorStop(0, 'rgba(255,190,120,0.22)');
    g3.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = g3;
    ctx.fillRect(x - rw, h * 0.53 - rw, rw * 2, rw * 2);
    ctx.fillRect(x - rw + w, h * 0.53 - rw, rw * 2, rw * 2);
    ctx.fillRect(x - rw - w, h * 0.53 - rw, rw * 2, rw * 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Authored night-sky backdrop: deep gradient, stars, subtle milky band. */
function makeNightSkyTexture(): THREE.CanvasTexture {  const w = 1024;
  const h = 1024;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, '#04060f');
  grad.addColorStop(0.55, '#0a1226');
  grad.addColorStop(0.78, '#182338');
  grad.addColorStop(1.0, '#232c44');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // faint galactic band (drawn twice for seamless equirect wrap)
  ctx.save();
  ctx.translate(w / 2, h * 0.42);
  ctx.rotate(-0.35);
  const band = ctx.createLinearGradient(0, -140, 0, 140);
  band.addColorStop(0, 'rgba(120,150,220,0)');
  band.addColorStop(0.5, 'rgba(130,155,215,0.10)');
  band.addColorStop(1, 'rgba(120,150,220,0)');
  ctx.fillStyle = band;
  ctx.fillRect(-w, -140, w * 2, 280);
  ctx.fillRect(-w * 1.5, -140, w * 2, 280);
  ctx.fillRect(w * 0.5, -140, w * 2, 280);
  ctx.restore();
  // stars
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed & 0x7fffffff) / 0x7fffffff;
  };
  for (let i = 0; i < 950; i++) {
    const x = rnd() * w;
    const y = rnd() * h * 0.82;
    const r = rnd() < 0.06 ? rnd() * 1.4 + 0.7 : rnd() * 0.75 + 0.25;
    const a = 0.28 + rnd() * 0.62;
    const tint = rnd() < 0.16 ? '200,220,255' : rnd() < 0.1 ? '255,225,190' : '235,240,250';
    ctx.fillStyle = `rgba(${tint},${a.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (r > 1.3) {
      ctx.fillStyle = `rgba(${tint},${(a * 0.22).toFixed(2)})`;
      ctx.fillRect(x - r * 3.2, y - 0.4, r * 6.4, 0.8);
      ctx.fillRect(x - 0.4, y - r * 3.2, 0.8, r * 6.4);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
