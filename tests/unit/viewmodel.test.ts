import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ActorView } from '../../src/sim/gameStateView';
import { ViewModel } from '../../src/render/viewmodel';
import type { WeaponModelFactory } from '../../src/render/weaponModels';

function actor(overrides: Partial<ActorView> = {}): ActorView {
  return Object.freeze({
    id: 1,
    displayName: 'LOCAL',
    ownership: Object.freeze({ kind: 'local-human' as const, peerId: 'guest-peer' }),
    connectionState: 'connected' as const,
    teamId: null,
    skinId: 'vanguard' as const,
    accentColor: 0x33aaff,
    alive: true,
    health: 100,
    shield: 100,
    position: Object.freeze({ x: 0, y: 0, z: 0 }),
    velocity: Object.freeze({ x: 0, y: 0, z: 0 }),
    yaw: 0,
    pitch: 0,
    grounded: true,
    moveState: 'ground' as const,
    crouched: false,
    deployed: true,
    equippedWeapon: 'ar' as const,
    inventory: Object.freeze({
      selected: 0,
      slots: Object.freeze([
        Object.freeze({ kind: 'weapon' as const, weaponId: 'ar' as const, rarity: 'rare' as const, ammoInMag: 30 }),
        null, null, null, null,
      ]),
      ammo: Object.freeze({ light: 0, medium: 90, shells: 0, heavy: 0 }),
      healing: null,
    }),
    placement: 0,
    stats: Object.freeze({ kills: 0, damageDealt: 0, shotsFired: 0, shotsHit: 0, headshots: 0, survivalTime: 0 }),
    ...overrides,
  });
}

function factory(build: ReturnType<typeof vi.fn>): WeaponModelFactory {
  return { build } as unknown as WeaponModelFactory;
}

describe('replica viewmodel presentation', () => {
  it('renders an ActorView weapon with local ADS and does not require combat runtime state', () => {
    const modelGroup = new THREE.Group();
    const build = vi.fn(() => ({
      group: modelGroup,
      muzzle: new THREE.Vector3(0, 0, -1),
      mag: null,
      bolt: null,
      accents: [],
    }));
    const viewmodel = new ViewModel(factory(build));
    const view = actor();

    viewmodel.kick(1);
    for (let i = 0; i < 30; i++) viewmodel.updateView(view, 1 / 60, 3, -2, 4, { adsAmount: 1 });

    expect(build).toHaveBeenCalledWith('ar', 'rare');
    expect(modelGroup.visible).toBe(true);
    expect(viewmodel.group.visible).toBe(true);
    expect(viewmodel.group.position.x).toBeLessThan(0.12);
    expect(view.equippedWeapon).toBe('ar');
    expect(view.inventory?.slots[0]?.kind).toBe('weapon');

    viewmodel.dispose();
  });

  it('renders permanent fists when the replica selects the melee pseudo-slot', () => {
    const build = vi.fn();
    const viewmodel = new ViewModel(factory(build));

    viewmodel.updateView(actor({ equippedWeapon: null, inventory: null }), 1 / 60, 0, 0, 0, { adsAmount: 1 });

    expect(build).not.toHaveBeenCalled();
    expect(viewmodel.group.visible).toBe(true);

    viewmodel.dispose();
  });
});
