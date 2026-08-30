import { describe, expect, it } from 'vitest';
import { Actor } from '../../src/sim/actor';
import { Perception } from '../../src/ai/perception';

function actor(id: number, name: string, x: number, z: number): Actor {
  const body = {
    actorId: id,
    position: { x, y: 1.5, z },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
  } as never;
  return new Actor(name, body, 0xffffff);
}

describe('team-aware Bot perception', () => {
  it('never exposes an ally as a visible target and may select an enemy behind it', () => {
    const self = actor(1, 'SELF', 0, 0);
    const ally = actor(2, 'ALLY', 0, -4);
    const enemy = actor(3, 'ENEMY', 0, -8);
    const perception = new Perception(self, (other) => other === enemy);

    perception.updateVision(1, [self, ally, enemy], () => false, 1);

    expect(perception.visible.has(ally.id)).toBe(false);
    expect(perception.memories.has(ally.id)).toBe(false);
    expect(perception.bestVisibleTarget(10)?.actor).toBe(enemy);
  });

  it('drops a remembered actor as soon as that actor becomes a teammate', () => {
    const self = actor(1, 'SELF', 0, 0);
    const other = actor(2, 'OTHER', 0, -5);
    let hostile = true;
    const perception = new Perception(self, (candidate) => candidate === other && hostile);
    perception.updateVision(1, [self, other], () => false, 1);
    expect(perception.memories.has(other.id)).toBe(true);

    hostile = false;
    perception.updateVision(1, [self, other], () => false, 1);
    expect(perception.visible.has(other.id)).toBe(false);
    expect(perception.memories.has(other.id)).toBe(false);
  });
});
