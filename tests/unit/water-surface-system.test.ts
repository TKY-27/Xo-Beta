import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWaterlineRibbonPositions,
  traceWaterline,
  WaterSurfaceSystem,
} from '../../src/render/waterSurfaceSystem';
import { loadMap } from '../../src/world';
import type { MapDef, WaterVisualKind, WaterVolume } from '../../src/world/types';

function testMap(water: readonly WaterVolume[], terrainHeight?: (x: number, z: number) => number): MapDef {
  return {
    id: 'water-surface-test',
    name: 'Water surface test',
    description: 'A minimal renderer-only map for water tests.',
    size: 100,
    sky: {
      preset: 'day',
      fogColor: 0xa9c2d4,
      fogDensity: 0.001,
      sunDirection: [0.45, -0.8, 0.35],
      sunColor: 0xfff2dd,
      sunIntensity: 2,
      ambientColor: 0xb6ccd8,
      ambientIntensity: 0.46,
      hemisphereSky: 0xa8d4f0,
      hemisphereGround: 0x55663f,
      hemisphereIntensity: 1.2,
    },
    terrainHeight,
    surfacePaths: [],
    geo: [],
    destructibles: [],
    vehicles: [],
    trees: [],
    rocks: [],
    lamps: [],
    lights: [],
    water: [...water],
    chests: [],
    loot: [],
    pois: [],
    platforms: [],
    transportRoute: { from: [-40, -40], to: [40, 40] },
  };
}

function volume(kind: WaterVisualKind, index = 0): WaterVolume {
  return {
    minX: index * 24 - 12,
    maxX: index * 24 + 12,
    minZ: -10,
    maxZ: 10,
    surfaceY: 0,
    depth: 5,
    visual: { kind, seed: 700 + index },
  };
}

describe('waterline tracing', () => {
  it('keeps actual Eden shoreline output finite, bounded, and terrain-shaped', () => {
    const { def, terrainHeight } = loadMap('eden');
    const lake = def.water.find((water) => water.visual?.kind === 'lake');
    if (!lake) throw new Error('Eden lake water volume is missing');

    const segments = traceWaterline(terrainHeight, lake, 3);
    expect(segments.length).toBeGreaterThan(0);

    const points = segments.flatMap((segment): Array<[number, number]> => [
      [segment.ax, segment.az],
      [segment.bx, segment.bz],
    ]);
    expect(points.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z))).toBe(true);
    expect(points.every(([x, z]) => (
      x >= lake.minX && x <= lake.maxX && z >= lake.minZ && z <= lake.maxZ
    ))).toBe(true);

    // The authored lake bed intersects the terrain both inside and at a
    // volume edge. A rectangle-edge outline would have no interior points;
    // the traced shoreline must expose the terrain-shaped interior path.
    const interiorPoints = points.filter(([x, z]) => (
      x > lake.minX + 1e-6 && x < lake.maxX - 1e-6
      && z > lake.minZ + 1e-6 && z < lake.maxZ - 1e-6
    ));
    expect(interiorPoints.length).toBeGreaterThan(8);
    expect(new Set(points.map(([x, z]) => `${x.toFixed(3)},${z.toFixed(3)}`)).size).toBeGreaterThan(8);
  });

  it('ignores zero-length shoreline segments when building a ribbon', () => {
    const positions = buildWaterlineRibbonPositions([
      { ax: -2, az: 0, bx: 2, bz: 0, y: 1 },
      { ax: 4, az: 4, bx: 4, bz: 4, y: 9 },
      { ax: 5, az: 5, bx: 5 + 1e-8, bz: 5, y: 9 },
    ], 0.4, 0.03);

    expect(positions).toHaveLength(18);
    expect(positions.every(Number.isFinite)).toBe(true);
  });
});

describe('water surface handles', () => {
  it('preserves explicit lake, river, and pond selection in the handle and QA stats', () => {
    const system = new WaterSurfaceSystem(testMap([
      volume('lake', 0),
      volume('river', 1),
      volume('pond', 2),
    ]), { quality: 'low' });

    try {
      expect(system.group.children.map((child) => child.name)).toEqual([
        'water:lake:0',
        'water:river:1',
        'water:pond:2',
      ]);
      expect(system.getQaStats()).toMatchObject({
        quality: 'low',
        volumes: 3,
        visibleVolumes: 3,
        halfFloatWaveData: false,
        waveResolution: 32,
      });
    } finally {
      system.dispose();
    }
  });

  it('falls back to unsigned-byte wave data when half-float support is unavailable', () => {
    const renderer = {
      capabilities: { isWebGL2: true },
      extensions: { has: vi.fn(() => false) },
    } as unknown as THREE.WebGLRenderer;
    const system = new WaterSurfaceSystem(testMap([volume('lake')]), { renderer, quality: 'low' });

    try {
      expect(system.getQaStats().halfFloatWaveData).toBe(false);
      const root = system.group.children[0];
      if (!(root instanceof THREE.Group)) throw new Error('Water root group is missing');
      const mesh = root.children.find((child) => child.name.startsWith('water-surface:'));
      if (!(mesh instanceof THREE.Mesh)) throw new Error('Water surface mesh is missing');
      const material = mesh.material;
      if (!(material instanceof THREE.ShaderMaterial)) throw new Error('Water surface material is missing');
      const waveTexture = material.uniforms['uWaveTexture']?.value;
      expect(waveTexture).toBeInstanceOf(THREE.DataTexture);
      expect((waveTexture as THREE.DataTexture).type).toBe(THREE.UnsignedByteType);
      expect(renderer.extensions.has).toHaveBeenCalledWith('OES_texture_half_float_linear');
    } finally {
      system.dispose();
    }
  });

  it('uses half-float wave data only when WebGL2 linear filtering is supported', () => {
    const renderer = {
      capabilities: { isWebGL2: true },
      extensions: { has: vi.fn((name: string) => name === 'OES_texture_float_linear') },
    } as unknown as THREE.WebGLRenderer;
    const system = new WaterSurfaceSystem(testMap([volume('river')]), { renderer, quality: 'medium' });

    try {
      expect(system.getQaStats()).toMatchObject({
        halfFloatWaveData: true,
        waveResolution: 64,
        waveTextureBytes: 64 * 64 * 4 * 2,
      });
      const root = system.group.children[0];
      const mesh = root?.children.find((child) => child.name.startsWith('water-surface:'));
      if (!(mesh instanceof THREE.Mesh) || !(mesh.material instanceof THREE.ShaderMaterial)) {
        throw new Error('Water surface material is missing');
      }
      expect((mesh.material.uniforms['uWaveTexture']?.value as THREE.DataTexture).type)
        .toBe(THREE.HalfFloatType);
    } finally {
      system.dispose();
    }
  });

  it('does not duplicate group children across quality changes and disposes idempotently', () => {
    const system = new WaterSurfaceSystem(testMap([
      volume('lake', 0),
      volume('pond', 1),
    ]), { quality: 'low' });
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const textures = new Set<THREE.Texture>();
    system.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.push(object.geometry);
      if (Array.isArray(object.material)) materials.push(...object.material);
      else materials.push(object.material);
      const shader = object.material instanceof THREE.ShaderMaterial ? object.material : null;
      for (const uniform of Object.values(shader?.uniforms ?? {})) {
        if (uniform.value instanceof THREE.Texture && uniform.value.userData.xoWaterOwned === true) {
          textures.add(uniform.value);
        }
      }
    });
    const geometryDisposals = geometries.map((geometry) => vi.spyOn(geometry, 'dispose'));
    const materialDisposals = materials.map((material) => vi.spyOn(material, 'dispose'));
    const initialTextureDisposals = [...textures].map((texture) => vi.spyOn(texture, 'dispose'));

    const childNames = system.group.children.map((child) => child.name);
    for (const quality of ['medium', 'high', 'low'] as const) system.setQuality(quality);

    expect(system.group.children).toHaveLength(2);
    expect(system.group.children.map((child) => child.name)).toEqual(childNames);
    expect(new Set(system.group.children.map((child) => child.uuid)).size).toBe(2);

    const currentTextures = new Set<THREE.Texture>();
    system.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.ShaderMaterial)) return;
      for (const uniform of Object.values(object.material.uniforms)) {
        if (uniform.value instanceof THREE.Texture && uniform.value.userData.xoWaterOwned === true) {
          currentTextures.add(uniform.value);
        }
      }
    });
    const currentTextureDisposals = [...currentTextures].map((texture) => vi.spyOn(texture, 'dispose'));

    system.dispose();
    system.dispose();

    expect(system.group.children).toHaveLength(0);
    expect(geometryDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(materialDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(initialTextureDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(currentTextureDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('reserves the highest-density LOD for Ultra and Cinematic quality', () => {
    const system = new WaterSurfaceSystem(testMap([volume('lake')]), { quality: 'low' });
    try {
      system.update(0, new THREE.Vector3(0, 2, 0));
      const lowTriangles = system.getQaStats().triangles;
      system.setQuality('medium');
      const mediumTriangles = system.getQaStats().triangles;
      system.setQuality('high');
      const highTriangles = system.getQaStats().triangles;
      system.setQuality('ultra');
      const ultraTriangles = system.getQaStats().triangles;

      expect(mediumTriangles).toBe(lowTriangles);
      expect(highTriangles).toBeGreaterThan(mediumTriangles);
      expect(ultraTriangles).toBeGreaterThan(highTriangles);
    } finally {
      system.dispose();
    }
  });

  it('releases every owned resource across repeated create and dispose cycles', () => {
    for (let cycle = 0; cycle < 6; cycle++) {
      const system = new WaterSurfaceSystem(testMap([
        volume('lake', cycle * 2),
        volume('river', cycle * 2 + 1),
      ]), { quality: cycle % 2 === 0 ? 'high' : 'ultra' });
      const resources = new Set<{ dispose(): void }>();
      system.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        resources.add(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          resources.add(material);
          if (!(material instanceof THREE.ShaderMaterial)) continue;
          for (const uniform of Object.values(material.uniforms)) {
            if (uniform.value instanceof THREE.Texture && uniform.value.userData.xoWaterOwned === true) {
              resources.add(uniform.value);
            }
          }
        }
      });
      const disposeSpies = [...resources].map((resource) => vi.spyOn(resource, 'dispose'));

      system.dispose();

      expect(system.group.children).toHaveLength(0);
      expect(disposeSpies.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    }
  });

  it('releases the wave texture when depth generation fails before entry registration', () => {
    const dispose = vi.spyOn(THREE.DataTexture.prototype, 'dispose');
    const map = testMap([volume('lake')], () => {
      throw new Error('terrain fixture failure');
    });

    expect(() => new WaterSurfaceSystem(map, { quality: 'low' })).toThrow('terrain fixture failure');
    expect(dispose).toHaveBeenCalledTimes(1);
    dispose.mockRestore();
  });

  it('releases geometry and textures when material construction fails before mesh registration', () => {
    const prototype = WaterSurfaceSystem.prototype as unknown as {
      makeMaterial: (...args: unknown[]) => THREE.ShaderMaterial;
    };
    const material = vi.spyOn(prototype, 'makeMaterial').mockImplementationOnce(() => {
      throw new Error('material fixture failure');
    });
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const textureDispose = vi.spyOn(THREE.DataTexture.prototype, 'dispose');

    expect(() => new WaterSurfaceSystem(testMap([volume('lake')]), { quality: 'low' }))
      .toThrow('material fixture failure');
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(2);

    material.mockRestore();
    geometryDispose.mockRestore();
    textureDispose.mockRestore();
  });
});
