import { beforeAll, describe, expect, it } from 'vitest';
import { GROUPS, PhysicsWorld } from '../../src/physics/physics';
import { buildColliders, WorldBuilder } from '../../src/world/builder';
import { ensureWorldReady, loadMap, MAP_LIST, type MapId } from '../../src/world';
import { computeGameplayMapHash } from '../../src/net/matchStart';
import { rockColliderProfile } from '../../src/world/rockProfiles';

beforeAll(async () => {
  await ensureWorldReady();
});

const MAPS: MapId[] = MAP_LIST.map((entry) => entry.id);

describe('rock collider determinism and parity', () => {
  it('every authored rock resolves a known variant with a finite measured profile', () => {
    for (const id of MAPS) {
      const def = loadMap(id).def;
      for (const rock of def.rocks) {
        const profile = rockColliderProfile(rock.variant);
        expect(profile.boxes.length).toBeGreaterThanOrEqual(2);
        expect(profile.boxes.length).toBeLessThanOrEqual(3);
        expect(profile.footprintRadius).toBeGreaterThan(0);
        expect(profile.height).toBeGreaterThan(0);
        expect(Number.isFinite(rock.yaw)).toBe(true);
      }
    }
  });

  it('host and client prediction worlds produce identical rock collider results', () => {
    // Both online peers run the same buildColliders; assert that a second
    // independent world (the prediction world's situation) yields byte-equal
    // raycast outcomes against every rock's compound envelope.
    for (const id of MAPS) {
      const def = loadMap(id).def;
      if (def.rocks.length === 0) continue;
      const buildWorld = (): PhysicsWorld => {
        const phys = new PhysicsWorld();
        buildColliders(def, phys);
        phys.flush();
        return phys;
      };
      const host = buildWorld();
      const prediction = buildWorld();
      try {
        let sampled = 0;
        for (const rock of def.rocks.slice(0, 12)) {
          const profile = rockColliderProfile(rock.variant);
          // Horizontal rays at mid height from eight compass directions.
          for (let k = 0; k < 8; k++) {
            const angle = (k / 8) * Math.PI * 2;
            const dx = Math.cos(angle);
            const dz = Math.sin(angle);
            const start = 3.2 * rock.scale;
            const ox = rock.x - dx * start;
            const oz = rock.z - dz * start;
            const oy = rock.y + 0.9 * rock.scale;
            const a = host.raycast(ox, oy, oz, dx, 0, dz, start * 2, GROUPS.rayWorldOnly);
            const b = prediction.raycast(ox, oy, oz, dx, 0, dz, start * 2, GROUPS.rayWorldOnly);
            expect((a?.dist ?? -1).toFixed(6)).toBe((b?.dist ?? -1).toFixed(6));
            expect(a?.normal.x.toFixed(5)).toBe(b?.normal.x.toFixed(5));
            void profile;
            sampled++;
          }
        }
        expect(sampled).toBeGreaterThan(0);
      } finally {
        host.dispose();
        prediction.dispose();
      }
    }
  });

  it('gameplay map hash is stable across rebuilds and changes with rock data', async () => {
    const def = loadMap('ashara').def;
    if (def.rocks.length === 0) throw new Error('ashara should contain rocks');
    const hashA = await computeGameplayMapHash(def);
    const hashB = await computeGameplayMapHash(loadMap('ashara').def);
    expect(hashA).toBe(hashB);
    const mutated = loadMap('ashara').def;
    mutated.rocks = mutated.rocks.map((rock, index) => (
      index === 0 ? { ...rock, variant: rock.variant === 'medium-1' ? 'medium-2' as const : 'medium-1' as const } : rock
    ));
    const hashC = await computeGameplayMapHash(mutated);
    expect(hashC).not.toBe(hashA);
  });

  it('a rock compound collider blocks movement where the profile boxes stand', () => {
    const builder = new WorldBuilder('rock-parity', 'Rock parity', 'Compound fixture', 100);
    builder.rock(0, 0, 0, 1);
    const def = builder.def;
    const phys = new PhysicsWorld();
    buildColliders(def, phys);
    phys.flush();
    const rock = def.rocks[0]!;
    const profile = rockColliderProfile(rock.variant);
    // Ray at the mid box's centre height must stop at or inside its yawed
    // extent in every direction where a profile box exists.
    const mid = profile.boxes[1]!;
    for (let k = 0; k < 12; k++) {
      const angle = (k / 12) * Math.PI * 2;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      const hit = phys.raycast(-dx * 3, mid.y - 0.22, -dz * 3, dx, 0, dz, 6, GROUPS.rayWorldOnly);
      expect(hit, `direction ${k}`).not.toBeNull();
      expect(hit!.dist).toBeLessThan(3 + 0.05);
    }
    phys.dispose();
  });
});
