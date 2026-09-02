/**
 * SkyAtmosphereSystem: the visible sky dome.
 *
 * One BackSide sphere with a compact shader provides the atmospheric
 * gradient, sun/moon disc aligned with the directional light, scrolling
 * procedural cloud layers sampled from one generated noise texture, masked
 * stars and a horizon haze band. The existing HDRI/canvas environment map
 * remains the PBR IBL source — this system owns only the visible sky.
 *
 * Presentation-only: never affects simulation, collision or the gameplay
 * map hash. Deterministic: the noise texture is generated from fixed seeds.
 */

import * as THREE from 'three';
import type { SkyAtmosphereProfile } from '../world/types';

const DOME_RADIUS = 700;

const vertexShader = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunDirection;
  uniform vec3 uDiscColor;
  uniform vec3 uCloudTint;
  uniform vec3 uCloudShade;
  uniform vec3 uHazeColor;
  uniform float uDiscSize;
  uniform float uDiscGlow;
  uniform float uCloudCover;
  uniform float uWindSpeed;
  uniform float uStarOpacity;
  uniform float uHazeStrength;
  uniform float uTime;
  uniform sampler2D uNoise;
  varying vec3 vDirection;

  // Two octaves from the packed noise texture (R = low frequency, G = high).
  float cloudDensity(vec2 uv) {
    float low = texture2D(uNoise, uv).r;
    float high = texture2D(uNoise, uv * 3.7).g;
    float d = low * 0.72 + high * 0.28;
    // Remap around the coverage control: 0 = clear, 1 = heavy overcast.
    return smoothstep(1.0 - uCloudCover * 1.15, 1.0 - uCloudCover * 0.35, d);
  }

  void main() {
    vec3 dir = normalize(vDirection);
    float height = clamp(dir.y, -1.0, 1.0);

    // Atmospheric gradient: zenith colour falling to horizon, with a darker
    // below-horizon band so terrain silhouettes read cleanly.
    float t = clamp(height * 1.6 + 0.08, 0.0, 1.0);
    vec3 color = mix(uHorizon, uZenith, pow(t, 0.75));

    // Sun/moon disc and restrained glow, aligned with the directional light.
    float cosAngle = dot(dir, normalize(uSunDirection));
    float disc = smoothstep(cos(uDiscSize), cos(uDiscSize * 0.82), cosAngle);
    float glow = pow(max(cosAngle, 0.0), 46.0) * uDiscGlow;

    // Clouds: project the view direction onto a virtual layer plane and
    // scroll with the deterministic wind. Two layers, the higher one slower
    // and fainter, produce parallax without any extra draw.
    vec2 plane = dir.xz / max(0.14, dir.y + 0.22);
    float wind = uTime * uWindSpeed;
    float c1 = cloudDensity(plane * 0.055 + vec2(wind * 0.9, wind * 0.32));
    float c2 = cloudDensity(plane * 0.11 + vec2(-wind * 0.55, wind * 0.7) + 13.7);
    float clouds = clamp(c1 * 0.78 + c2 * 0.34, 0.0, 1.0);
    // Fade clouds toward the horizon line into the haze.
    clouds *= smoothstep(-0.02, 0.16, height);
    // Cloud shading: brighter toward the sun, cooler away.
    vec3 cloudColor = mix(uCloudShade, uCloudTint, 0.45 + 0.55 * glow);
    color = mix(color, cloudColor, clouds);

    // Stars: high-frequency noise texels, masked by cloud coverage.
    float star = step(0.9965, texture2D(uNoise, dir.xz * 0.34 + dir.y * 1.7).b);
    float twinkle = 0.72 + 0.28 * sin(uTime * 1.9 + dot(dir, vec3(31.7, 17.3, 11.1)) * 8.0);
    color += vec3(star * twinkle * uStarOpacity * (1.0 - clouds));

    // Disc drawn over clouds (moon/sun behind thin cloud reads washed out,
    // which is the correct look for overcast profiles with a low glow).
    color = mix(color, uDiscColor, disc);
    color += uDiscColor * glow;

    // Horizon haze band.
    float haze = exp(-abs(height) * 9.0) * uHazeStrength;
    color = mix(color, uHazeColor, haze);

    gl_FragColor = vec4(color, 1.0);
  }
`;

export class SkyAtmosphereSystem {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.CanvasTexture;
  private time = 0;

  constructor(profile: SkyAtmosphereProfile, sunDirection: [number, number, number]) {
    this.texture = SkyAtmosphereSystem.makeNoiseTexture();
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color(profile.zenith) },
        uHorizon: { value: new THREE.Color(profile.horizon) },
        uSunDirection: { value: new THREE.Vector3(...sunDirection).normalize() },
        uDiscColor: { value: new THREE.Color(profile.discColor) },
        uCloudTint: { value: new THREE.Color(profile.cloudTint) },
        uCloudShade: { value: new THREE.Color(profile.cloudShade) },
        uHazeColor: { value: new THREE.Color(profile.hazeColor) },
        uDiscSize: { value: profile.discSize },
        uDiscGlow: { value: profile.discGlow },
        uCloudCover: { value: profile.cloudCover },
        uWindSpeed: { value: profile.windSpeed },
        uStarOpacity: { value: profile.starOpacity },
        uHazeStrength: { value: profile.hazeStrength },
        uTime: { value: 0 },
        uNoise: { value: this.texture },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 18), this.material);
    this.mesh.name = 'sky-atmosphere';
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  /**
   * One 256x256 periodic noise texture packed with the cloud octaves and the
   * star mask. Generated once from fixed seeds — deterministic across peers
   * and reloads, and no runtime texture churn.
   */
  private static makeNoiseTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(size, size);
    // Value noise from hashed lattice + smooth interpolation, periodic.
    const lattice = (x: number, y: number, seed: number): number => {
      const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
      return h - Math.floor(h);
    };
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    const valueNoise = (x: number, y: number, period: number, seed: number): number => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = smooth(x - xi), yf = smooth(y - yi);
      const wrap = (v: number, period: number): number => ((v % period) + period) % period;
      const a = lattice(wrap(xi, period), wrap(yi, period), seed);
      const b = lattice(wrap(xi + 1, period), wrap(yi, period), seed);
      const c = lattice(wrap(xi, period), wrap(yi + 1, period), seed);
      const d = lattice(wrap(xi + 1, period), wrap(yi + 1, period), seed);
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / size) * 8, v = (y / size) * 8;
        const low = valueNoise(u, v, 8, 1) * 0.65 + valueNoise(u * 2, v * 2, 16, 2) * 0.35;
        const high = valueNoise(u * 4, v * 4, 32, 3) * 0.6 + valueNoise(u * 8, v * 8, 64, 4) * 0.4;
        const star = lattice(x, y, 5) > 0.9995 ? 1 : 0;
        const i = (y * size + x) * 4;
        image.data[i] = Math.round(low * 255);
        image.data[i + 1] = Math.round(high * 255);
        image.data[i + 2] = star ? 255 : 0;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.NoColorSpace;
    return texture;
  }

  update(dt: number): void {
    this.time += Math.min(dt, 0.05);
    this.material.uniforms.uTime!.value = this.time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
