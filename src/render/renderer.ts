/**
 * GameRenderer: WebGPU-first renderer with three.js WebGL2 fallback through
 * the same WebGPURenderer code path, HDRI image-based lighting, TSL
 * post-processing chain (GTAO / bloom / SMAA-FXAA / grading / scope optics),
 * per-map lighting rig and quality settings application.
 */

import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  AmbientLight,
  BackSide,
  CanvasTexture,
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Euler,
  FogExp2,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  NeutralToneMapping,
  PCFShadowMap,
  PMREMGenerator,
  RenderPipeline,
  RenderTarget,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import type { Camera, Node, Object3D, Texture } from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  float,
  length,
  Loop,
  max,
  mix,
  mrt,
  normalView,
  output,
  pass,
  positionLocal,
  pow,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { SkyConfig, WeatherProfile } from '../world/types';
import { SkyAtmosphereSystem } from './skyAtmosphere';
import { getSettings } from '../core/settings';
import { loadHdri, clampHdriPeaks } from '../assets/assets';

const _sunDirection = new Vector3();
const _lightRight = new Vector3();
const _lightUp = new Vector3();
const _snappedTarget = new Vector3();

/** Supported sniper scope magnification levels (angular-FOV based). */
export const SCOPE_MAGNIFICATIONS = [1, 2, 4] as const;
/** Default when scoping in. */
export const SCOPE_DEFAULT_MAGNIFICATION = 2;

/**
 * Angular field of view for a scope magnification: halving the tangent
 * halves the perceived angle, so a 2x scope shows exactly half the view.
 * At 1x this returns the base FOV unchanged (identity of the formula).
 */
export function scopeFovForMagnification(baseVerticalFov: number, magnification: number): number {
  const halfTan = Math.tan(MathUtils.degToRad(baseVerticalFov) / 2);
  const scoped = 2 * Math.atan(halfTan / magnification);
  return Math.max(1.5, MathUtils.radToDeg(scoped));
}

/** The renderer is created once per page and shared by lobby and match scenes. */
let sharedRenderer: WebGPURenderer | null = null;

export function getSharedGameRenderer(canvas: HTMLCanvasElement): WebGPURenderer {
  if (!sharedRenderer) {
    sharedRenderer = new WebGPURenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      // Logarithmic depth: the 500 m maps are viewed from a 0.08 m camera
      // near plane out to transport altitude; a linear buffer z-fights ground
      // planes at altitude (flickering terrain seen from the transport).
      logarithmicDepthBuffer: true,
    });
  }
  return sharedRenderer;
}

/** True when the active backend is native WebGPU (not the WebGL2 fallback). */
export function isWebGPUBackend(renderer: unknown): boolean {
  const backend = (renderer as { backend?: { isWebGPUBackend?: boolean } } | null)?.backend;
  return backend?.isWebGPUBackend === true;
}

export class GameRenderer {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  /** Resolves once the GPU backend is initialized and the renderer is usable. */
  readonly ready: Promise<void>;
  private postProcessing: RenderPipeline | null = null;
  private camera: Camera | null = null;
  // TSL uniforms for the display chain (kept so they can be updated live).
  private gradingU = {
    vignette: uniform(0.32),
    vignetteSoftness: uniform(0.55),
    saturation: uniform(1.04),
    contrast: uniform(1.02),
    lift: uniform(new Vector3(0, 0, 0.004)),
  };
  private scopeU = {
    aspect: uniform(1),
    radius: uniform(0.36),
    progress: uniform(0),
  };
  private scopeActive = false;
  private scopeProgress = 0;
  private scopeMagnification: number = SCOPE_DEFAULT_MAGNIFICATION;
  private sun: DirectionalLight | null = null;
  private hemi: HemisphereLight | null = null;
  private ambient: AmbientLight | null = null;
  private pmrem: PMREMGenerator | null = null;
  private envRenderTarget: RenderTarget | null = null;
  private ownedBackground: Texture | null = null;
  private fallbackSky: Mesh | null = null;
  private skyAtmosphere: SkyAtmosphereSystem | null = null;
  private baseFogDensity = 0;
  private baseExposure = 1.25;
  private sunOffset = new Vector3(120, 220, 90);
  private grading = { vignette: 0.3, saturation: 1.05, contrast: 1.03, lift: new Vector3(0, 0, 0.004) };
  private readonly gpuProfiling: boolean;
  private gpuDevice = 'unavailable';
  private readonly onResize = () => this.resize();

  constructor(canvas: HTMLCanvasElement, gpuProfiling = false) {
    this.renderer = getSharedGameRenderer(canvas);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(this.effectivePixelRatio());
    this.gpuProfiling = gpuProfiling;
    if (gpuProfiling) this.renderer.info.autoReset = false;
    // GPU identity resolves asynchronously once the backend reports in.
    this.ready = this.renderer.init().then(() => this.resolveGpuDevice());
    this.ready.catch((err) => console.error('renderer init failed', err));

    window.addEventListener('resize', this.onResize);
  }

  private async resolveGpuDevice(): Promise<void> {
    try {
      if (isWebGPUBackend(this.renderer)) {
        const gpu = (navigator as Navigator & {
          gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string } | null } | null> };
        }).gpu;
        const info = (await gpu?.requestAdapter())?.info;
        this.gpuDevice = info ? ([info.vendor, info.architecture].filter(Boolean).join(' / ') || 'webgpu') : 'webgpu';
      } else {
        this.gpuDevice = 'webgl2';
      }
    } catch {
      this.gpuDevice = isWebGPUBackend(this.renderer) ? 'webgpu' : 'webgl2';
    }
  }

  resize(): void {
    const settings = getSettings();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = this.effectivePixelRatio() * settings.resolutionScale * this.dynamicScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.scopeU.aspect.value = w / Math.max(1, h);
    // Post-processing pass targets derive from the renderer's drawing buffer
    // every frame, so no per-pass resize is needed.
  }

  private dynamicScale = 1;

  /**
   * Adaptive-resolution factor (0.5..1) multiplied into the pixel ratio.
   * The frame-time watchdog in main steps it down when the rolling average
   * frame time exceeds the 60 FPS budget and back up when headroom returns —
   * holding 60 FPS beats holding an authored pixel count. 1 restores the
   * fully authored resolution.
   */
  setDynamicResolutionScale(scale: number): void {
    const clamped = Math.max(0.5, Math.min(1, scale));
    if (Math.abs(clamped - this.dynamicScale) < 0.001) return;
    this.dynamicScale = clamped;
    this.resize();
  }

  get dynamicResolutionScale(): number {
    return this.dynamicScale;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.postProcessing?.dispose();
    this.postProcessing = null;
    this.disposeEnvironment();
    // The underlying renderer is a page-lifetime singleton shared with the
    // lobby — it must survive per-match teardown.
  }

  gpuDeviceLabel(): string {
    return this.gpuDevice;
  }

  /** QA-only one-shot frame cost measurement. */
  measureSynchronousFrame(dt = 0): number {
    const start = performance.now();
    this.render(dt);
    return performance.now() - start;
  }

  /**
   * Switch magnification without recreating any renderer resource; the next
   * scoped frame simply projects with the new angular FOV.
   */
  setScopeMagnification(magnification: number): void {
    this.scopeMagnification = (SCOPE_MAGNIFICATIONS as readonly number[]).includes(magnification)
      ? magnification
      : SCOPE_DEFAULT_MAGNIFICATION;
  }

  get scopeFovMagnification(): number {
    return this.scopeMagnification;
  }

  /**
   * Enable the optical sniper view. Single-pass optics: this only updates a
   * uniform-gated overlay in the display chain — no render target, camera or
   * scene-compile work happens here, so right-click can never allocate GPU
   * resources. Overlay weights track continuous ADS progress via
   * setScopeUniforms().
   */
  setScopeActive(active: boolean, _sourceCamera?: Camera): void {
    this.scopeActive = active;
    this.syncScopeUniforms();
  }

  /** Continuous ADS progress for the scope overlay weights (0..1). */
  setScopeUniforms(progress: number): void {
    this.scopeProgress = MathUtils.clamp(progress, 0, 1);
    this.syncScopeUniforms();
  }

  private syncScopeUniforms(): void {
    this.scopeU.progress.value = this.scopeActive ? this.scopeProgress : 0;
    this.scopeU.aspect.value = window.innerWidth / Math.max(1, window.innerHeight);
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
    await this.ready;
    if (this.pmrem) this.disposeEnvironment();
    this.pmrem = new PMREMGenerator(this.renderer);

    if (sky.preset === 'bluehour') {
      // Authored competitive blue-hour city sky: bright enough to fight in,
      // deep blue gradient with a glowing horizon. Also drives IBL.
      const tex = makeBlueHourSkyTexture();
      this.envRenderTarget?.dispose();
      this.envRenderTarget = this.pmrem.fromEquirectangular(tex);
      this.scene.environment = this.envRenderTarget.texture;
      this.scene.environmentIntensity = sky.envIntensity ?? 0.9;
      this.scene.background = tex;
      this.ownedBackground = tex;
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
          this.ownedBackground = makeNightSkyTexture();
          this.scene.background = this.ownedBackground;
          this.scene.backgroundIntensity = sky.backgroundIntensity ?? 1.0;
        } else {
          // Peak-clamped backdrop: keeps the baked sun disc from blooming
          // into a screen-filling white wall; env map stays full-range.
          this.ownedBackground = clampHdriPeaks(equirect, 4.5);
          this.scene.background = this.ownedBackground;
          this.scene.backgroundBlurriness = sky.backgroundBlurriness ?? 0.04;
          this.scene.backgroundIntensity = sky.backgroundIntensity ?? 1.0;
          // Align the HDR image's baked sun disc with the analytic sunDirection
          // so visible glare, IBL hotspot and shadows agree. The intrinsic disc
          // bearing was measured in-engine per asset (radians, atan2(x, z)).
          const discYaw = sky.hdri.includes('qwantani') ? -2.2 : 0.4;
          const sunYaw = Math.atan2(sky.sunDirection[0], sky.sunDirection[2]);
          const rot = new Euler(0, sunYaw - discYaw, 0);
          this.scene.backgroundRotation = rot;
          this.scene.environmentRotation = rot;
        }
      } catch (err) {
        console.warn('HDRI unavailable, falling back to gradient sky', err);
        this.setupGradientSky(sky);
      }
    } else {
      this.setupGradientSky(sky);
    }

    // Authored visible-sky dome: overrides the photographic background when
    // the map defines an atmosphere profile (weather then drives the visible
    // sky at runtime). The HDRI/canvas texture remains the IBL source.
    if (sky.atmosphere) {
      this.skyAtmosphere?.dispose();
      this.skyAtmosphere = new SkyAtmosphereSystem(sky.atmosphere, sky.sunDirection);
      this.scene.add(this.skyAtmosphere.mesh);
    }

    this.scene.fog = new FogExp2(sky.fogColor, sky.fogDensity);
    this.renderer.toneMappingExposure = sky.exposure ?? 1.25;
    // Base values for per-match weather modulation (see applyWeather).
    this.baseFogDensity = sky.fogDensity;
    this.baseExposure = sky.exposure ?? 1.25;

    const sunDir = new Vector3(...sky.sunDirection).normalize();
    const sunPos = sunDir.multiplyScalar(300).negate();
    sunPos.y = Math.abs(sunPos.y) + 60;
    this.sun = new DirectionalLight(sky.sunColor, sky.sunIntensity);
    this.sun.position.copy(sunPos);
    // Shadow light must travel with the same direction as the visible sun,
    // otherwise shadows fall the wrong way on every map but one.
    this.sunOffset.copy(sunPos).setLength(260);
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

    this.hemi = new HemisphereLight(sky.hemisphereSky, sky.hemisphereGround, sky.hemisphereIntensity);
    this.scene.add(this.hemi);
    this.ambient = new AmbientLight(sky.ambientColor, sky.ambientIntensity);
    this.scene.add(this.ambient);
    // Sky-fill from the opposite side of the sun: keeps sun-facing contrast but
    // lifts shaded facades so north walls don't read as near-black slabs.
    const fillIntensity = sky.preset === 'bluehour' ? 0.92 : sky.preset === 'overcast' ? 0.22 : 0.72;
    const fill = new DirectionalLight(sky.hemisphereSky, fillIntensity);
    fill.position.copy(sunPos).negate().setY(90);
    this.scene.add(fill);
  }

  /**
   * Per-match weather modulation. Fog density, exposure and sky-atmosphere
   * uniforms are runtime values — no shader recompiles, safe mid-match.
   * `null` restores the authored base look.
   */
  applyWeather(profile: WeatherProfile | null): void {
    if (this.scene.fog instanceof FogExp2) {
      const scale = profile?.fogDensityScale ?? 1;
      this.scene.fog.density = this.baseFogDensity * scale;
    }
    this.renderer.toneMappingExposure = this.baseExposure * (profile?.exposureScale ?? 1);
    if (this.skyAtmosphere) {
      this.skyAtmosphere.setWeatherOverrides(profile ?? {});
    }
  }

  private setupGradientSky(sky: SkyConfig): void {
    const geo = new SphereGeometry(800, 24, 16);
    const top = new Color(sky.preset === 'night' ? 0x0b1022 : sky.preset === 'bluehour' ? 0x050b1c : sky.preset === 'overcast' ? 0x9fb0bd : 0x8fc4e8);
    const bottom = new Color(sky.preset === 'night' ? 0x141a2e : sky.preset === 'bluehour' ? 0x24406e : sky.preset === 'overcast' ? 0xc4cdd5 : 0xd8ecf6);
    const topU = uniform(top);
    const bottomU = uniform(bottom);
    const mat = new MeshBasicNodeMaterial();
    mat.side = BackSide;
    mat.depthWrite = false;
    mat.colorNode = mix(bottomU, topU, pow(clamp(positionLocal.normalize().y.mul(0.5).add(0.5), 0, 1), 0.7));
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.name = 'fallback-sky';
    this.scene.add(mesh);
    this.fallbackSky = mesh;
  }

  private disposeEnvironment(): void {
    this.skyAtmosphere?.dispose();
    this.skyAtmosphere = null;
    this.envRenderTarget?.dispose();
    this.envRenderTarget = null;
    this.ownedBackground?.dispose();
    this.ownedBackground = null;
    if (this.fallbackSky) {
      this.scene.remove(this.fallbackSky);
      this.fallbackSky.geometry.dispose();
      const material = this.fallbackSky.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
      this.fallbackSky = null;
    }
    this.scene.environment = null;
    this.scene.background = null;
    this.pmrem?.dispose();
    this.pmrem = null;
  }

  /** Keep the shadow frustum centered near the viewer for crisp shadows. */
  followSunTarget(pos: Vector3): void {
    if (!this.sun) return;
    // Snap the target to shadow-map texel increments in light space: without
    // this the shadow camera slides continuously with the viewer and every
    // shadow edge shimmers as texels resample frame to frame.
    const cam = this.sun.shadow.camera;
    const extent = cam.right - cam.left;
    const texel = extent / this.sun.shadow.mapSize.x;
    const sunDir = _sunDirection.copy(this.sunOffset).normalize();
    // Light-space right axis: perpendicular to the sun direction, horizontal.
    _lightRight.set(0, 1, 0).cross(sunDir).normalize();
    _lightUp.copy(sunDir).cross(_lightRight).normalize();
    const dx = pos.dot(_lightRight);
    const dy = pos.dot(_lightUp);
    const snappedX = Math.round(dx / texel) * texel - dx;
    const snappedY = Math.round(dy / texel) * texel - dy;
    _snappedTarget.copy(pos).addScaledVector(_lightRight, snappedX).addScaledVector(_lightUp, snappedY);
    this.sun.target.position.copy(_snappedTarget);
    this.sun.position.copy(_snappedTarget).add(this.sunOffset);
  }

  /** Azimuth (atan2(x, z)) pointing toward the visible sun, for camera framing. */
  sunAzimuth(): number {
    return Math.atan2(this.sunOffset.x, this.sunOffset.z);
  }

  /** Legacy no-op retained for API stability (background is infinite). */
  followViewer(_pos: Vector3): void {
    void _pos;
  }

  /**
   * One-shot top-down aerial render of the world for the tactical map.
   * Renders orthographically from above into an offscreen target and returns
   * it as a 2D canvas (north = -Z up, +X right — matches map coordinate math).
   * Call once during match load; costs a single async GPU readback.
   */
  async captureAerial(half: number, size = 1024, hide: Object3D[] = []): Promise<HTMLCanvasElement | null> {
    await this.ready;
    const cam = new OrthographicCamera(-half, half, half, -half, 1, 800);
    cam.position.set(0, 380, 0);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const rt = new RenderTarget(size, size);
    const saved = hide.map((o) => o.visible);
    hide.forEach((o) => { o.visible = false; });
    const prevFog = this.scene.fog;
    try {
      this.scene.fog = null;
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, cam);
      const buf = await this.renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // The render target receives linear color (tone mapping / sRGB encode
      // only run for the default framebuffer) — encode to sRGB. Copy origins
      // differ per backend: WebGPU copies are top-down, WebGL readbacks
      // address from the bottom-left.
      const flip = !isWebGPUBackend(this.renderer);
      const img = ctx.createImageData(size, size);
      const out = img.data;
      for (let y = 0; y < size; y++) {
        const src = (flip ? size - 1 - y : y) * size * 4;
        const dst = y * size * 4;
        for (let x = 0; x < size; x++) {
          for (let c = 0; c < 3; c++) {
            const v = bytes[src + x * 4 + c]! / 255;
            out[dst + x * 4 + c] = (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
          }
          out[dst + x * 4 + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    } catch (err) {
      console.warn('aerial capture failed', err);
      return null;
    } finally {
      this.renderer.setRenderTarget(null);
      this.scene.fog = prevFog;
      hide.forEach((o, i) => { o.visible = saved[i]!; });
      rt.dispose();
    }
  }

  /** Wire the display chain for the given camera (rebuilt on quality changes). */
  buildComposer(camera: Camera): void {
    this.camera = camera;
    this.postProcessing?.dispose();
    this.postProcessing = null;

    const settings = getSettings();
    const pp = new RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, camera);

    const cinematic = settings.quality === 'cinematic';
    const wantAO = settings.ao && (settings.quality === 'ultra' || cinematic) && settings.postProcessing;
    let color: Node<'vec4'> = scenePass.getTextureNode('output');
    if (wantAO) {
      scenePass.setMRT(mrt({ output, normal: normalView }));
      color = scenePass.getTextureNode('output');
      const aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera);
      // AO at native resolution: half-res compute + bilinear upsample haloed
      // around distant geometry and read as grain. Samples stay moderate so
      // the fill cost stays bounded.
      aoPass.resolutionScale = 1;
      aoPass.radius.value = cinematic ? 0.35 : 0.28;
      aoPass.distanceExponent.value = 1.4;
      aoPass.thickness.value = 1;
      aoPass.scale.value = 1.1;
      aoPass.samples.value = cinematic ? 24 : 12;
      // GTAONode emits the occlusion factor as a float in the red channel.
      color = color.mul(vec4(vec3(aoPass.getTextureNode().r), 1.0));
    }

    // Composite the linear optical scope image before bloom, AA and grading so
    // the lens receives the same display treatment as the primary view.
    color = this.applyScopeComposite(color);

    if (settings.bloom && settings.postProcessing) {
      // BloomNode emits only the bloom layer — add it on top of the scene.
      color = color.add(bloom(
        color,
        cinematic ? 0.42 : 0.5,
        cinematic ? 0.75 : 0.62,
        // Threshold above 1.0 keeps daylight albedo (even white walls) out of
        // the bloom; only true emitters (neon, muzzle flashes, sun) bloom.
        cinematic ? 1.32 : 1.62,
      ));
    }

    if (settings.aa === 'smaa') {
      // The SMAA/FXAA node types are declared vec3 in the type package but
      // sample and emit vec4 at runtime — normalize at the boundary.
      color = smaa(color) as unknown as Node<'vec4'>;
    } else if (settings.aa === 'fxaa') {
      color = fxaa(color) as unknown as Node<'vec4'>;
    }

    if (settings.postProcessing) {
      // All scene and optical passes remain linear until the PostProcessing
      // output transform applies tone mapping + sRGB.
      pp.outputNode = this.applyGrading(color);
    } else {
      pp.outputNode = color;
    }
    this.postProcessing = pp;
    this.resize();
  }

  /** Vignette + gentle saturation/contrast shaping over the linear image. */
  private applyGrading(src: Node<'vec4'>): Node<'vec3'> {
    const u = this.gradingU;
    u.vignette.value = this.grading.vignette;
    u.vignetteSoftness.value = 0.55;
    u.saturation.value = this.grading.saturation;
    u.contrast.value = this.grading.contrast;
    u.lift.value.copy(this.grading.lift);

    const c = src.rgb;
    // contrast around mid gray
    const contrasted = c.sub(0.5).mul(u.contrast).add(0.5);
    // saturation
    const l = dot(contrasted, vec3(0.2126, 0.7152, 0.0722));
    const saturated = mix(vec3(l), contrasted, u.saturation);
    // gentle blue lift in shadows for filmic feel
    const lifted = saturated.add(u.lift.mul(float(1.0).sub(l)));
    // vignette
    const d = screenUV.sub(0.5);
    const vig = float(1.0).sub(smoothstep(u.vignette, u.vignette.add(u.vignetteSoftness), length(d)));
    return lifted.mul(mix(float(1.0).sub(u.vignette.mul(0.35)), float(1.0), vig)).max(0.0);
  }

  /**
   * Single-pass scope optics: the primary camera already carries the angular
   * magnification, so this overlay only shapes the lens. The periphery outside
   * the aperture is the same magnified render, progressively dimmed — it is
   * visually hidden behind the DOM housing at full ADS. With the scope fully
   * inactive every overlay term collapses to the source image.
   */
  private applyScopeComposite(src: Node<'vec4'>): Node<'vec4'> {
    const u = this.scopeU;
    const progress = u.progress;
    const p = screenUV.sub(vec2(0.5, 0.5)).mul(vec2(u.aspect, float(1.0)));
    const d = length(p);
    const outside = smoothstep(u.radius.sub(0.02), u.radius.add(0.006), d);
    let color = mix(src, src.mul(0.12), outside.mul(progress));
    // Fine optical edge marks the aperture boundary.
    const edge = float(1.0).sub(smoothstep(0.0, 0.012, abs(d.sub(u.radius))));
    color = mix(color, color.mul(0.52), edge.mul(0.42).mul(progress));
    color = color.add(vec3(0.16, 0.21, 0.23).mul(edge).mul(progress));
    // Reticle in lens-space; central gap avoids hiding the target point.
    const lineX = float(1.0).sub(smoothstep(0.0015, 0.004, abs(p.x)));
    const lineY = float(1.0).sub(smoothstep(0.0015, 0.004, abs(p.y)));
    const gap = smoothstep(0.022, 0.036, d);
    const reticle = max(lineX, lineY).mul(gap).mul(float(1.0).sub(outside)).toVar();
    Loop(17, ({ i }) => {
      const tick = float(i).sub(8).mul(0.045);
      const horizontal = float(1.0).sub(smoothstep(0.0015, 0.0035, abs(p.x.sub(tick))))
        .mul(float(1.0).sub(smoothstep(0.0012, 0.0035, abs(p.y.sub(0.028)))));
      const vertical = float(1.0).sub(smoothstep(0.0015, 0.0035, abs(p.y.sub(tick))))
        .mul(float(1.0).sub(smoothstep(0.0012, 0.0035, abs(p.x.sub(0.028)))));
      reticle.assign(max(reticle, horizontal.add(vertical).mul(float(1.0).sub(outside)).mul(0.85)));
      const rangeTick = float(1.0).sub(smoothstep(0.0014, 0.0035, abs(p.x.sub(tick))))
        .mul(float(1.0).sub(smoothstep(0.0012, 0.0035, abs(p.y.add(0.22)))));
      reticle.assign(max(reticle, rangeTick.mul(float(1.0).sub(outside)).mul(0.7)));
    });
    color = mix(color, vec3(0.01, 0.016, 0.014), clamp(reticle, 0, 1).mul(0.92).mul(progress));
    // A small reflection streak provides a glass cue without hiding the view.
    const reflection = float(1.0).sub(smoothstep(0.0, 0.035, abs(p.y.add(p.x.mul(0.44)).sub(0.24))))
      .mul(float(1.0).sub(outside)).mul(0.055);
    color = color.add(vec3(0.8, 0.93, 1.0).mul(reflection).mul(progress));
    return color;
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
    // The TSL graph is cheap to rebuild and branch positions depend on every
    // display setting, so rebuild the whole chain on each quality application.
    if (this.camera) {
      this.buildComposer(this.camera);
    }
    this.resize();
  }

  /** Set the per-map display grade (called when a map loads). */
  setGrading(grade: { vignette?: number; saturation?: number; contrast?: number; lift?: [number, number, number]; toneMapping?: 'aces' | 'agx' | 'neutral' }): void {
    if (grade.vignette !== undefined) this.grading.vignette = grade.vignette;
    if (grade.saturation !== undefined) this.grading.saturation = grade.saturation;
    if (grade.contrast !== undefined) this.grading.contrast = grade.contrast;
    if (grade.lift) this.grading.lift.set(...grade.lift);
    if (grade.toneMapping) {
      this.renderer.toneMapping =
        grade.toneMapping === 'agx' ? AgXToneMapping
        : grade.toneMapping === 'neutral' ? NeutralToneMapping
        : ACESFilmicToneMapping;
    }
  }

  render(_dt: number): void {
    const settings = getSettings();
    const usePost = settings.postProcessing || settings.aa !== 'off' || this.scopeActive;
    if (this.gpuProfiling) this.renderer.info.reset();
    if (!this.camera) return;
    if (this.postProcessing && usePost) {
      this.postProcessing.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

/**
 * Authored blue-hour city sky (equirect): deep zenith blue, luminous cyan
 * horizon with a warm sodium band, high cirrus streaks and sparse stars.
 * Bright enough for readable night combat while clearly reading as night.
 */
function makeBlueHourSkyTexture(): CanvasTexture {
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

  const tex = new CanvasTexture(c);
  tex.mapping = EquirectangularReflectionMapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Authored night-sky backdrop: deep gradient, stars, subtle milky band. */
function makeNightSkyTexture(): CanvasTexture {
  const w = 1024;
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
  const tex = new CanvasTexture(c);
  tex.mapping = EquirectangularReflectionMapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
