/**
 * SkyAtmosphereSystem: the visible sky dome.
 *
 * One BackSide sphere with a TSL node material provides the atmospheric
 * gradient, sun/moon disc aligned with the directional light, scrolling
 * procedural cloud layers sampled from one generated noise texture, masked
 * stars and a horizon haze band. The existing HDRI/canvas environment map
 * remains the PBR IBL source — this system owns only the visible sky.
 *
 * Presentation-only: never affects simulation, collision or the gameplay
 * map hash. Deterministic: the noise texture is generated from fixed seeds.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  abs, clamp, cos, dot, exp, float, max, mix, normalize, positionLocal, pow,
  sin, smoothstep, step, texture, uniform, vec2, vec3,
} from 'three/tsl';
import type { SkyAtmosphereProfile } from '../world/types';

const DOME_RADIUS = 700;

interface SkyUniforms {
  zenith: UniformNode<'color', THREE.Color>;
  horizon: UniformNode<'color', THREE.Color>;
  sunDirection: UniformNode<'vec3', THREE.Vector3>;
  discColor: UniformNode<'color', THREE.Color>;
  cloudTint: UniformNode<'color', THREE.Color>;
  cloudShade: UniformNode<'color', THREE.Color>;
  hazeColor: UniformNode<'color', THREE.Color>;
  discSize: UniformNode<'float', number>;
  discGlow: UniformNode<'float', number>;
  cloudCover: UniformNode<'float', number>;
  windSpeed: UniformNode<'float', number>;
  starOpacity: UniformNode<'float', number>;
  hazeStrength: UniformNode<'float', number>;
  time: UniformNode<'float', number>;
}

export class SkyAtmosphereSystem {
  readonly mesh: THREE.Mesh;
  private readonly material: MeshBasicNodeMaterial;
  private readonly u: SkyUniforms;
  private readonly noise: ReturnType<typeof texture>;
  private readonly texture: THREE.CanvasTexture;
  private time = 0;

  constructor(profile: SkyAtmosphereProfile, sunDirection: [number, number, number]) {
    this.texture = SkyAtmosphereSystem.makeNoiseTexture();
    this.noise = texture(this.texture);
    this.u = {
      zenith: uniform(new THREE.Color(profile.zenith)),
      horizon: uniform(new THREE.Color(profile.horizon)),
      sunDirection: uniform(new THREE.Vector3(...sunDirection).normalize()),
      discColor: uniform(new THREE.Color(profile.discColor)),
      cloudTint: uniform(new THREE.Color(profile.cloudTint)),
      cloudShade: uniform(new THREE.Color(profile.cloudShade)),
      hazeColor: uniform(new THREE.Color(profile.hazeColor)),
      discSize: uniform(profile.discSize),
      discGlow: uniform(profile.discGlow),
      cloudCover: uniform(profile.cloudCover),
      windSpeed: uniform(profile.windSpeed),
      starOpacity: uniform(profile.starOpacity),
      hazeStrength: uniform(profile.hazeStrength),
      time: uniform(0),
    };
    this.material = new MeshBasicNodeMaterial();
    this.material.side = THREE.BackSide;
    this.material.depthWrite = false;
    this.material.depthTest = false;
    this.material.fog = false;
    this.material.colorNode = this.buildColorNode();

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 18), this.material);
    this.mesh.name = 'sky-atmosphere';
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  /**
   * Atmospheric gradient → clouds → stars → disc → haze, in the same order
   * as the original GLSL fragment shader.
   */
  private buildColorNode(): Node<'vec3'> {
    const u = this.u;
    const dir = positionLocal.normalize();
    const height = clamp(dir.y, -1.0, 1.0);

    // Atmospheric gradient: zenith colour falling to horizon, with a darker
    // below-horizon band so terrain silhouettes read cleanly.
    const t = clamp(height.mul(1.6).add(0.08), 0.0, 1.0);
    let color: Node<'vec3'> = mix(u.horizon, u.zenith, pow(t, 0.75));

    // Sun/moon disc and restrained glow, aligned with the directional light.
    const cosAngle = dot(dir, normalize(u.sunDirection));
    const disc = smoothstep(cos(u.discSize), cos(u.discSize.mul(0.82)), cosAngle);
    const glow = pow(max(cosAngle, 0.0), 46.0).mul(u.discGlow);

    // Clouds: project the view direction onto a virtual layer plane and
    // scroll with the deterministic wind. Two layers, the higher one slower
    // and fainter, produce parallax without any extra draw.
    const density = (uv: Node<'vec2'>): Node<'float'> => {
      const low = this.noise.sample(uv).r;
      const high = this.noise.sample(uv.mul(3.7)).g;
      const d = low.mul(0.72).add(high.mul(0.28));
      // Remap around the coverage control: 0 = clear, 1 = heavy overcast.
      return smoothstep(float(1.0).sub(u.cloudCover.mul(1.15)), float(1.0).sub(u.cloudCover.mul(0.35)), d);
    };
    const plane = dir.xz.div(max(dir.y.add(0.22), 0.14));
    const wind = u.time.mul(u.windSpeed);
    const c1 = density(plane.mul(0.055).add(vec2(wind.mul(0.9), wind.mul(0.32))));
    const c2 = density(plane.mul(0.11).add(vec2(wind.mul(-0.55), wind.mul(0.7))).add(13.7));
    const clouds = clamp(c1.mul(0.78).add(c2.mul(0.34)), 0.0, 1.0)
      // Fade clouds toward the horizon line into the haze.
      .mul(smoothstep(-0.02, 0.16, height));
    // Cloud shading: brighter toward the sun, cooler away.
    const cloudColor = mix(u.cloudShade, u.cloudTint, float(0.45).add(glow.mul(0.55)));
    color = mix(color, cloudColor, clouds);

    // Stars: high-frequency noise texels, masked by cloud coverage.
    const star = step(0.9965, this.noise.sample(dir.xz.mul(0.34).add(dir.y.mul(1.7))).b);
    const twinkle = float(0.72).add(float(0.28).mul(sin(u.time.mul(1.9).add(dot(dir, vec3(31.7, 17.3, 11.1)).mul(8.0)))));
    color = color.add(vec3(star.mul(twinkle).mul(u.starOpacity).mul(float(1.0).sub(clouds))));

    // Disc drawn over clouds (moon/sun behind thin cloud reads washed out,
    // which is the correct look for overcast profiles with a low glow).
    color = mix(color, u.discColor, disc);
    color = color.add(u.discColor.mul(glow));

    // Horizon haze band.
    const haze = exp(abs(height).mul(9.0).negate()).mul(u.hazeStrength);
    color = mix(color, u.hazeColor, haze);

    return color;
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
    const textureOut = new THREE.CanvasTexture(canvas);
    textureOut.wrapS = THREE.RepeatWrapping;
    textureOut.wrapT = THREE.RepeatWrapping;
    textureOut.colorSpace = THREE.NoColorSpace;
    // Explicit smooth filtering: without it the WebGPU backend samples the
    // 256px canvas nearest-neighbour and clouds break into hard texel squares.
    textureOut.magFilter = THREE.LinearFilter;
    textureOut.minFilter = THREE.LinearMipmapLinearFilter;
    textureOut.generateMipmaps = true;
    textureOut.anisotropy = 4;
    return textureOut;
  }

  update(dt: number): void {
    this.time += Math.min(dt, 0.05);
    this.u.time.value = this.time;
  }

  /**
   * Per-match weather overrides over the authored atmosphere profile. Only
   * provided fields change; uniform updates never recompile the program.
   */
  setWeatherOverrides(profile: {
    cloudCover?: number;
    cloudTint?: number;
    cloudShade?: number;
    windSpeed?: number;
    starOpacity?: number;
    hazeStrength?: number;
  }): void {
    const u = this.u;
    if (profile.cloudCover !== undefined) u.cloudCover.value = profile.cloudCover;
    if (profile.cloudTint !== undefined) u.cloudTint.value = new THREE.Color(profile.cloudTint);
    if (profile.cloudShade !== undefined) u.cloudShade.value = new THREE.Color(profile.cloudShade);
    if (profile.windSpeed !== undefined) u.windSpeed.value = profile.windSpeed;
    if (profile.starOpacity !== undefined) u.starOpacity.value = profile.starOpacity;
    if (profile.hazeStrength !== undefined) u.hazeStrength.value = profile.hazeStrength;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
