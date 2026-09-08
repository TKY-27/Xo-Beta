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
      gripR: new THREE.Vector3(0, -0.05, -0.1),
      gripL: new THREE.Vector3(0, -0.01, -0.5),
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

describe('replica viewmodel combat presentation (cycle 48)', () => {
  interface MockModel {
    group: THREE.Group;
    muzzle: THREE.Vector3;
    mag: THREE.Group;
    bolt: THREE.Group;
    accents: THREE.Object3D[];
    gripR: THREE.Vector3;
    gripL: THREE.Vector3;
  }

  function mockModel(): { model: MockModel; build: ReturnType<typeof vi.fn> } {
    const model: MockModel = {
      group: new THREE.Group(),
      muzzle: new THREE.Vector3(0, 0, -1),
      mag: new THREE.Group(),
      bolt: new THREE.Group(),
      accents: [],
      gripR: new THREE.Vector3(0, -0.05, -0.1),
      gripL: new THREE.Vector3(0, -0.01, -0.5),
    };
    const build = vi.fn(() => model);
    return { model, build };
  }

  it('animates the mag travel from the online reloadStarted event timeline', () => {
    const { model, build } = mockModel();
    const viewmodel = new ViewModel(factory(build));
    const view = actor();

    // Arm the weapon first (matches real ordering: equipped before the event).
    viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    const baseY = model.mag.position.y;

    // AR tactical reload: 2.2 s × 0.92 rare modifier.
    viewmodel.notifyReloadStarted('ar', 'rare', false);
    expect(viewmodel.presentationReloadPhase).toBe(0);

    // Mid-reload: mag has travelled down from its well.
    for (let i = 0; i < 30; i++) viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    expect(viewmodel.presentationReloadPhase).toBeGreaterThan(0.2);
    expect(viewmodel.presentationReloadPhase).toBeLessThan(0.35);
    expect(model.mag.position.y).toBeLessThan(baseY);

    // Past the end of the timeline the mag is seated again.
    for (let i = 0; i < 120; i++) viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    expect(viewmodel.presentationReloadPhase).toBe(-1);
    expect(model.mag.position.y).toBe(baseY);
    expect(model.mag.visible).toBe(true);

    viewmodel.dispose();
  });

  it('hides the mag during the empty-reload presentation and restores it', () => {
    const { model, build } = mockModel();
    const viewmodel = new ViewModel(factory(build));
    const view = actor({ equippedWeapon: 'smg' });

    viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    viewmodel.notifyReloadStarted('smg', 'common', true);
    viewmodel.updateView(view, 1 / 60, 0, 0, 0);

    expect(model.mag.visible).toBe(false);

    for (let i = 0; i < 200; i++) viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    expect(model.mag.visible).toBe(true);

    viewmodel.dispose();
  });

  it('cycles the bolt/pump travel when notifyShotFired seeds a heavy weapon', () => {
    const { model, build } = mockModel();
    const viewmodel = new ViewModel(factory(build));
    const view = actor({ equippedWeapon: 'shotgun' });

    viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    const baseZ = model.bolt.position.z;

    viewmodel.notifyShotFired('shotgun');
    viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    // Pump travel is rearward (+z) mid-cycle.
    expect(model.bolt.position.z).toBeGreaterThan(baseZ);

    // The 0.9 s presentation sweep returns the pump to (near) its rest
    // position — the same last-frame residue update() leaves offline.
    for (let i = 0; i < 70; i++) viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    expect(Math.abs(model.bolt.position.z - baseZ)).toBeLessThan(0.01);

    viewmodel.dispose();
  });

  it('leaves semi/auto weapons untouched by notifyShotFired', () => {
    const { model, build } = mockModel();
    const viewmodel = new ViewModel(factory(build));
    const view = actor();

    viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    const baseZ = model.bolt.position.z;

    viewmodel.notifyShotFired('ar');
    viewmodel.updateView(view, 1 / 60, 0, 0, 0);

    expect(model.bolt.position.z).toBe(baseZ);

    viewmodel.dispose();
  });

  it('cancels the presentation timelines on weapon swap and death', () => {
    const { build } = mockModel();
    const viewmodel = new ViewModel(factory(build));
    const view = actor();

    viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    viewmodel.notifyReloadStarted('ar', 'rare', false);
    viewmodel.updateView(view, 1 / 60, 0, 0, 0);
    expect(viewmodel.presentationReloadPhase).toBeGreaterThanOrEqual(0);

    // Swap to another weapon: the reload sweep must not bleed across.
    viewmodel.updateView(actor({ equippedWeapon: 'pistol' }), 1 / 60, 0, 0, 0);
    expect(viewmodel.presentationReloadPhase).toBe(-1);

    viewmodel.notifyReloadStarted('pistol', 'common', false);
    expect(viewmodel.presentationReloadPhase).toBe(0);
    viewmodel.updateView(actor({ alive: false }), 1 / 60, 0, 0, 0);
    expect(viewmodel.presentationReloadPhase).toBe(-1);

    viewmodel.dispose();
  });
});
