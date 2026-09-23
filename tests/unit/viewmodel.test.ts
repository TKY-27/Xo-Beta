import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Actor } from '../../src/sim/actor';
import * as THREE from 'three';
import type { ActorView } from '../../src/sim/gameStateView';
import { ViewModel } from '../../src/render/viewmodel';
import { ArmSolver, createHandRig } from '../../src/render/hands';
import { WeaponModelFactory, type WeaponModel } from '../../src/render/weaponModels';
import { WEAPONS, RARITY_MODS, type WeaponId } from '../../src/core/balance';

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

describe('bounded wrist solve', () => {
  it.each(['ar', 'shotgun'] as const)('%s keeps the deformed support palm near its actual holding surface', (id) => {
    const models = new WeaponModelFactory(null);
    const model = models.build(id, 'common')!;
    onTestFinished(() => models.dispose());
    const rig = createHandRig();
    model.group.add(rig.left, rig.right);
    model.group.scale.setScalar(id === 'ar' ? 0.82 : 0.85);
    rig.configure({ gripR: model.gripR, gripL: model.gripL, scale: model.group.scale.x });
    const input = { reloadPhase: -1, supportStyle: id === 'ar' ? 'under' as const : 'pump' as const, magLocal: model.mag?.position ?? null, pumpOffset: 0, pumpHand: id === 'shotgun', ads: 0, boltPhase: -1, boltLocal: null };
    rig.pose(input);
    model.group.updateMatrixWorld(true);
    const glove = rig.left.getObjectByName('continuous-glove') as THREE.SkinnedMesh;
    const vertices = glove.geometry.getAttribute('position');
    const palm: number[] = [];
    for (let i = 0; i < vertices.count; i++) {
      if (Math.abs(vertices.getX(i)) < 0.023 && vertices.getY(i) < -0.01 && vertices.getZ(i) > -0.012 && vertices.getZ(i) < 0.028) palm.push(i);
    }
    expect(palm.length).toBeGreaterThan(12);
    const triangles: THREE.Triangle[] = [];
    model.group.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || !mesh.visible) return;
      const positions = mesh.geometry.getAttribute('position');
      const indices = mesh.geometry.getIndex();
      for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
        const points = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(i + j) : i + j).applyMatrix4(mesh.matrixWorld));
        const triangle = new THREE.Triangle(points[0]!, points[1]!, points[2]!);
        if (triangle.closestPointToPoint(model.group.localToWorld(model.gripL.clone()), new THREE.Vector3()).distanceTo(model.group.localToWorld(model.gripL.clone())) < 0.11) triangles.push(triangle);
      }
    });
    expect(triangles.length).toBeGreaterThan(20);
    const closest = new THREE.Vector3();
    const distances = palm.map(index => {
      const p = glove.applyBoneTransform(index, new THREE.Vector3().fromBufferAttribute(vertices, index)).applyMatrix4(glove.matrixWorld);
      return Math.min(...triangles.map(triangle => triangle.closestPointToPoint(p, closest).distanceTo(p)));
    }).sort((a, b) => a - b);
    expect(distances[Math.floor(distances.length / 2)], `${id} median palm gap (metres)`).toBeLessThan(0.012);
    expect(distances[0], `${id} closest palm gap (metres)`).toBeLessThan(0.004);
    const rest = glove.skeleton.bones.map(bone => bone.quaternion.clone());
    const position = rig.left.position.clone();
    for (const amount of [0.2, 0.65, 1, 0.65, 0.2, 0]) rig.pose({ ...input, ads: amount, pumpOffset: id === 'shotgun' ? amount * 0.085 : 0 });
    expect(rig.left.position.distanceTo(position)).toBeLessThan(1e-8);
    glove.skeleton.bones.forEach((bone, i) => expect(bone.quaternion.angleTo(rest[i]!)).toBeLessThan(1e-7));
  });

  it('returns the real AR grip poses after ADS without rerunning surface fitting', () => {
    const models = new WeaponModelFactory(null);
    const vm = new ViewModel(models);
    onTestFinished(() => { vm.dispose(); models.dispose(); });
    const view = actor();
    vm.updateView(view, 0.4, 0, 0, 0);
    const hands = ['hand-wrist-left', 'hand-wrist-right'].map(name => vm.group.getObjectByName(name)!.parent!);
    const rest = hands.map(hand => ({ position: hand.position.clone(), quaternion: hand.quaternion.clone() }));
    const fitting = vi.spyOn(THREE.SkinnedMesh.prototype, 'applyBoneTransform');
    try {
      for (let frame = 0; frame < 180; frame++) vm.updateView(view, 1 / 60, 0, 0, 0, { adsAmount: frame < 60 ? 1 : 0 });
      hands.forEach((hand, i) => {
        expect(hand.position.distanceTo(rest[i]!.position)).toBeLessThan(1e-8);
        expect(hand.quaternion.angleTo(rest[i]!.quaternion)).toBeLessThan(1e-7);
      });
      expect(fitting).not.toHaveBeenCalled();
    } finally {
      fitting.mockRestore();
    }
  });

  it('reuses fitted contact poses during ADS and follows pump translation without refitting', () => {
    const rig = createHandRig();
    const parent = new THREE.Group();
    parent.add(rig.right, rig.left);
    rig.configure({ gripR: new THREE.Vector3(0.03, -0.1, -0.2), gripL: new THREE.Vector3(0, -0.02, -0.5), scale: 1 });
    const input = { reloadPhase: -1, supportStyle: 'pump' as const, magLocal: null, pumpOffset: 0, pumpHand: true, ads: 0, boltPhase: -1, boltLocal: null };
    rig.pose(input);
    const rest = rig.left.position.clone();
    const right = rig.right.quaternion.clone();
    const fit = vi.spyOn(THREE.SkinnedMesh.prototype, 'applyBoneTransform');
    try {
      for (const amount of [0.1, 0.35, 0.7, 1, 0.65, 0]) {
        rig.pose({ ...input, ads: amount, pumpOffset: amount * 0.085 });
        expect(rig.left.position.distanceTo(rest.clone().add(new THREE.Vector3(0, 0, amount * 0.085)))).toBeLessThan(1e-8);
        expect(rig.right.quaternion.angleTo(right)).toBeLessThan(1e-7);
      }
      expect(fit).not.toHaveBeenCalled();
    } finally {
      fit.mockRestore();
    }
  });

  it.each([0, 0.8, 2.8, -2.8])('preserves fitted grips and bounds sleeve swing/twist at %s radians', (angle) => {
    const pivot = new THREE.Group();
    pivot.rotation.set(0.2, -0.4, 0.1);
    pivot.position.set(2, 1, -3);
    const rig = createHandRig();
    const solver = new ArmSolver();
    pivot.add(rig.right, rig.left, solver.group);
    rig.configure({ gripR: new THREE.Vector3(0.08, -0.15, -0.3), gripL: new THREE.Vector3(-0.12, -0.1, -0.4), scale: 1 });
    rig.pose({ reloadPhase: -1, supportStyle: 'under', magLocal: null, pumpOffset: 0, pumpHand: false, ads: 0, boltPhase: -1, boltLocal: null });
    const hands = [rig.right, rig.left];
    hands.forEach(hand => hand.rotateZ(angle));
    pivot.updateMatrixWorld(true);
    const before = hands.map(hand => ({ position: hand.position.clone(), quaternion: hand.quaternion.clone() }));
    const wrists = [rig.wristR, rig.wristL].map(anchor => anchor.getWorldPosition(new THREE.Vector3()));
    solver.solve(pivot, wrists);
    pivot.updateMatrixWorld(true);
    hands.forEach((hand, i) => {
      expect(hand.position.distanceTo(before[i]!.position)).toBeLessThan(1e-10);
      expect(hand.quaternion.angleTo(before[i]!.quaternion)).toBeLessThan(1e-7);
      const glove = hand.getObjectByName('continuous-glove') as THREE.SkinnedMesh;
      expect(glove.skeleton.bones).toHaveLength(20);
      const sleeve = solver.group.children[i] as THREE.SkinnedMesh;
      const [upper, fore, twist, wrist] = sleeve.skeleton.bones;
      const foreFrame = upper!.quaternion.clone().multiply(fore!.quaternion).multiply(twist!.quaternion.clone().invert());
      const solved = upper!.quaternion.clone().multiply(fore!.quaternion).multiply(twist!.quaternion).multiply(wrist!.quaternion);
      const relative = foreFrame.invert().multiply(solved);
      const pronation = new THREE.Quaternion(0, relative.y, 0, relative.w).normalize();
      const swing = relative.clone().multiply(pronation.clone().invert());
      const twistAngle = 2 * Math.atan2(pronation.y, pronation.w);
      expect(2 * Math.acos(Math.min(1, Math.abs(swing.w)))).toBeLessThanOrEqual(0.55 + 1e-7);
      expect(Math.abs(Math.atan2(Math.sin(twistAngle), Math.cos(twistAngle)))).toBeLessThanOrEqual(1.4 + 1e-7);
      expect(wrist!.getWorldPosition(new THREE.Vector3()).distanceTo(wrists[i]!)).toBeLessThan(1e-6);
    });
  });
});

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

describe('replica viewmodel combat presentation', () => {
  type MockModel = WeaponModel & { mag: THREE.Object3D; bolt: THREE.Object3D };

  function mockModel(): { model: MockModel; build: ReturnType<typeof vi.fn> } {
    const model: MockModel = {
      group: new THREE.Group(),
      muzzle: new THREE.Vector3(0, 0, -1),
      mag: new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06)),
      bolt: new THREE.Group(),
      accents: [],
      gripR: new THREE.Vector3(0, -0.05, -0.1),
      gripL: new THREE.Vector3(0, -0.01, -0.5),
    };
    model.mag.name = 'mag';
    model.mag.position.set(0.01, -0.09, -0.23);
    model.mag.rotation.set(-0.12, 0.04, 0.02);
    model.bolt.name = 'bolt';
    model.bolt.position.set(0.03, 0.02, -0.31);
    model.bolt.rotation.set(0.05, -0.08, 0.12);
    const shell = new THREE.Group();
    shell.name = 'reload-shell';
    shell.visible = false;
    model.group.add(model.mag, model.bolt, shell);
    const build = vi.fn(() => mockModel().model).mockReturnValueOnce(model);
    return { model, build };
  }

  function armedView(id: WeaponId, ammoInMag = 0): ActorView {
    const base = actor();
    return actor({
      equippedWeapon: id,
      inventory: {
        ...base.inventory!, selected: 0,
        slots: [{ kind: 'weapon', weaponId: id, rarity: 'common', ammoInMag }, null, null, null, null],
      },
    });
  }

  function setup(id: WeaponId, ammoInMag = 0) {
    const { model, build } = mockModel();
    const viewmodel = new ViewModel(factory(build));
    onTestFinished(() => viewmodel.dispose());
    const view = armedView(id, ammoInMag);
    viewmodel.updateView(view, 0.4, 0, 0, 0);
    return { model, viewmodel, view, build };
  }

  function expectPose(actual: THREE.Object3D, expected: THREE.Object3D): void {
    expect(actual.position.distanceTo(expected.position)).toBeLessThan(1e-12);
    expect(1 - Math.abs(actual.quaternion.dot(expected.quaternion))).toBeLessThan(1e-12);
    expect(actual.scale.toArray()).toEqual(expected.scale.toArray());
  }

  function expectOffscreen(viewmodel: ViewModel, item: THREE.Object3D): void {
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.08, 100);
    viewmodel.syncCamera(camera);
    viewmodel.group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(item);
    expect(bounds.isEmpty()).toBe(false);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(camera.projectionMatrix);
    expect(frustum.intersectsBox(bounds)).toBe(false);
  }

  function expectHandContact(model: MockModel, magazine: THREE.Object3D): void {
    const hands = model.group.children.filter((child) => child.getObjectByName('continuous-glove'));
    expect(hands).toHaveLength(2);
    const left = hands[1]!;
    const contact = model.reloadSockets!.magazineContact;
    const expected = contact.position.clone().applyQuaternion(magazine.quaternion).add(magazine.position);
    expect(left.position.distanceTo(expected)).toBeLessThan(1e-12);
    const rotation = magazine.quaternion.clone().multiply(contact.quaternion);
    expect(1 - Math.abs(left.quaternion.dot(rotation))).toBeLessThan(1e-12);
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

  const magazineTracks = [
    { id: 'pistol', contact: 0.13, extracted: 0.24, stowed: 0.36, fetched: 0.44, seated: 0.69 },
    { id: 'smg', contact: 0.12, extracted: 0.23, stowed: 0.35, fetched: 0.43, seated: 0.72 },
    { id: 'ar', contact: 0.16, extracted: 0.29, stowed: 0.41, fetched: 0.49, seated: 0.77 },
    { id: 'sniper', contact: 0.18, extracted: 0.31, stowed: 0.43, fetched: 0.51, seated: 0.76 },
  ] satisfies { id: WeaponId; contact: number; extracted: number; stowed: number; fetched: number; seated: number }[];

  describe.each([false, true])('magazine ownership with empty=%s', (empty) => {
    it.each(magazineTracks)('$id stays seated until contact, extracts visibly, exchanges offscreen and seats a distinct replacement', (track) => {
      const { model, viewmodel, view } = setup(track.id, empty ? 0 : 2);
      const old = model.mag;
      const seated = old.clone();
      const fresh = model.group.getObjectByName('reload-spare-magazine')!;
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(old);
      expect(fresh.parent).toBe(model.group);
      expect(old.parent).toBe(model.group);
      const total = empty ? WEAPONS[track.id].reloadEmpty : WEAPONS[track.id].reloadTactical;
      let phase = 0;
      const advance = (next: number): void => {
        viewmodel.updateView(view, (next - phase) * total, 0, 0, 0);
        phase = next;
      };
      viewmodel.notifyReloadStarted(track.id, 'common', empty);
      for (const next of [0, track.contact / 2, track.contact - 0.0001]) {
        advance(next);
        expect(old.visible).toBe(true);
        expect(fresh.visible).toBe(false);
        expectPose(old, seated);
      }
      advance(track.contact + 0.0001);
      expectHandContact(model, old);
      advance((track.contact + track.extracted) / 2);
      expect(old.visible).toBe(true);
      expect(fresh.visible).toBe(false);
      expect(old.position.distanceTo(seated.position)).toBeGreaterThan(0.05);
      expectHandContact(model, old);
      advance(track.stowed - 0.0001);
      expect(old.visible).toBe(true);
      expectHandContact(model, old);
      expectOffscreen(viewmodel, old);
      advance((track.stowed + track.fetched) / 2);
      expect(old.visible).toBe(false);
      expect(fresh.visible).toBe(false);
      expectOffscreen(viewmodel, old);
      advance(track.fetched + 0.0001);
      expect(old.visible).toBe(false);
      expect(fresh.visible).toBe(true);
      expectOffscreen(viewmodel, fresh);
      expectHandContact(model, fresh);
      advance((track.fetched + track.seated) / 2);
      expect(fresh.position.distanceTo(seated.position)).toBeGreaterThan(0.02);
      expectHandContact(model, fresh);
      advance(track.seated + 0.0001);
      expect(fresh.visible).toBe(true);
      expect(old.visible).toBe(false);
      expectPose(fresh, seated);
      advance(1.001);
      expect(viewmodel.presentationReloadPhase).toBe(-1);
      expect(model.mag).toBe(fresh);
      expectPose(model.mag, seated);
      expect(model.mag.visible).toBe(true);
      expect(old.visible).toBe(false);
      viewmodel.notifyReloadStarted(track.id, 'common', empty);
      viewmodel.updateView(view, total * 0.05, 0, 0, 0);
      expect(model.mag).toBe(fresh);
      expectPose(fresh, seated);
      expect(fresh.visible).toBe(true);
      expect(old.visible).toBe(false);
    });
  });

  it.each(['shotgun', 'sniper'] as const)('%s cycles rearward and returns to its exact authored bolt rest over repeated shots', (id) => {
    const { model, viewmodel, view } = setup(id);
    const rest = model.bolt.clone();
    const total = id === 'shotgun' ? Math.max(0.55, 60 / WEAPONS[id].rpm - 0.3) : Math.max(0.9, 60 / WEAPONS[id].rpm - 0.35);
    const distance = id === 'shotgun' ? 0.085 : 0.06;
    for (let shot = 0; shot < 3; shot++) {
      viewmodel.notifyShotFired(id);
      viewmodel.updateView(view, 0, 0, 0, 0);
      expectPose(model.bolt, rest);
      for (let step = 1; step <= 3; step++) {
        viewmodel.updateView(view, total / 4, 0, 0, 0);
        expect(model.bolt.position.z).toBeGreaterThan(rest.position.z);
        expect(model.bolt.position.z - rest.position.z).toBeCloseTo(Math.sin(step / 4 * Math.PI) * distance, 12);
        expect(model.bolt.position.x).toBe(rest.position.x);
        expect(model.bolt.position.y).toBe(rest.position.y);
        expect(model.bolt.quaternion.toArray()).toEqual(rest.quaternion.toArray());
      }
      viewmodel.updateView(view, total / 4 + 0.00001, 0, 0, 0);
      expect(model.bolt.position.toArray()).toEqual(rest.position.toArray());
      expect(model.bolt.quaternion.toArray()).toEqual(rest.quaternion.toArray());
      viewmodel.updateView(view, 1 / 60, 0, 0, 0);
      expectPose(model.bolt, rest);
    }
  });

  describe.each(['swap', 'death', 'missing actor', 'fire'] as const)('%s interruption', (interruption) => {
    it.each([0.08, 0.22, 0.46, 0.58, 0.7])('restores the seated original and hides the spare at reload phase %s', (phase) => {
      const { model, viewmodel, view } = setup('ar');
      const old = model.mag;
      const rest = old.clone();
      const boltRest = model.bolt.clone();
      const fresh = model.group.getObjectByName('reload-spare-magazine')!;
      viewmodel.notifyReloadStarted('ar', 'common', true);
      viewmodel.updateView(view, WEAPONS.ar.reloadEmpty * phase, 0, 0, 0);
      if (interruption === 'swap') viewmodel.updateView(armedView('pistol'), 0, 0, 0, 0);
      else if (interruption === 'death') viewmodel.updateView({ ...view, alive: false }, 0, 0, 0, 0);
      else if (interruption === 'missing actor') viewmodel.updateView(null, 0, 0, 0, 0);
      else viewmodel.kick(0);
      expect(viewmodel.presentationReloadPhase).toBe(-1);
      expect(model.mag).toBe(old);
      expectPose(old, rest);
      expectPose(model.bolt, boltRest);
      expect(old.visible).toBe(true);
      expect(fresh.visible).toBe(false);
      viewmodel.updateView(view, 1 / 60, 0, 0, 0);
      expect(viewmodel.group.visible).toBe(true);
      expect(model.group.visible).toBe(true);
      expectPose(model.mag, rest);
      expect(fresh.visible).toBe(false);
    });
  });

  it('commits the replacement when a frame crosses seating and reload completion together', () => {
    const { model, viewmodel, view } = setup('ar');
    const old = model.mag;
    const rest = old.clone();
    const fresh = model.group.getObjectByName('reload-spare-magazine')!;
    viewmodel.notifyReloadStarted('ar', 'common', true);
    viewmodel.updateView(view, WEAPONS.ar.reloadEmpty * 0.74, 0, 0, 0);
    expect(fresh.visible).toBe(true);
    expect(old.visible).toBe(false);
    viewmodel.updateView(view, WEAPONS.ar.reloadEmpty * 0.27, 0, 0, 0);
    expect(viewmodel.presentationReloadPhase).toBe(-1);
    expect(model.mag).toBe(fresh);
    expectPose(fresh, rest);
    expect(fresh.visible).toBe(true);
    expect(old.visible).toBe(false);
  });

  it.each(['swap', 'death'] as const)('ignores late reload and shot events after %s without reviving either timeline', (interruption) => {
    const { model, viewmodel, view, build } = setup('sniper');
    const magRest = model.mag.clone();
    const boltRest = model.bolt.clone();
    viewmodel.notifyShotFired('sniper');
    viewmodel.updateView(view, 0.2, 0, 0, 0);
    expect(model.bolt.position.z).toBeGreaterThan(boltRest.position.z);
    viewmodel.notifyReloadStarted('sniper', 'common', true);
    viewmodel.updateView(view, WEAPONS.sniper.reloadEmpty * 0.25, 0, 0, 0);
    const next = interruption === 'swap' ? armedView('shotgun') : { ...view, alive: false };
    viewmodel.updateView(next, 0, 0, 0, 0);
    expectPose(model.mag, magRest);
    expectPose(model.bolt, boltRest);
    const current = interruption === 'swap' ? build.mock.results[1]!.value as MockModel : model;
    const currentBoltRest = current.bolt.clone();
    viewmodel.notifyReloadStarted('sniper', 'common', true);
    viewmodel.notifyShotFired('sniper');
    expect(viewmodel.presentationReloadPhase).toBe(-1);
    viewmodel.updateView(next, 0.2, 0, 0, 0);
    expect(viewmodel.presentationReloadPhase).toBe(-1);
    expectPose(current.bolt, currentBoltRest);
    expectPose(model.bolt, boltRest);
    expect(viewmodel.group.visible).toBe(interruption === 'swap');
    viewmodel.updateView(view, 0.2, 0, 0, 0);
    expect(viewmodel.presentationReloadPhase).toBe(-1);
    expectPose(model.mag, magRest);
    expectPose(model.bolt, boltRest);
  });

  function offlineActor(id: WeaponId, ammoInMag: number): Actor {
    const body = {
      actorId: 1,
      position: { x: 0, y: 1.6, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: true,
    } as never;
    const local = new Actor('TEST', body, 0xffffff);
    local.inv.add({ kind: 'weapon', weaponId: id, rarity: 'common', ammoInMag });
    local.inv.select(0);
    return local;
  }

  function meshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
    const result: THREE.SkinnedMesh[] = [];
    root.traverse((object) => {
      if (object instanceof THREE.SkinnedMesh) result.push(object);
    });
    return result;
  }

  function expectSamePresentation(a: THREE.Object3D, b: THREE.Object3D, context = 'presentation'): void {
    const path = `${context}/${a.name || a.type}`;
    expect(a.visible, `${path} visibility`).toBe(b.visible);
    expectPose(a, b);
    expect(a.children).toHaveLength(b.children.length);
    for (let i = 0; i < a.children.length; i++) expectSamePresentation(a.children[i]!, b.children[i]!, path);
  }

  describe.each([false, true])('offline/replica reload parity with empty=%s', (empty) => {
    it.each(['pistol', 'smg', 'ar', 'sniper', 'shotgun'] as const)('%s matches real Actor timer-driven transforms throughout reload', (id) => {
      const ammo = empty ? 0 : WEAPONS[id].magSize - 2;
      const online = setup(id, ammo);
      const offline = mockModel();
      const vm = new ViewModel(factory(offline.build));
      onTestFinished(() => vm.dispose());
      const local = offlineActor(id, ammo);
      vm.update(local, 0.4, 0, 0, 0);
      expectSamePresentation(vm.group, online.viewmodel.group);
      const total = (empty ? WEAPONS[id].reloadEmpty : WEAPONS[id].reloadTactical) * RARITY_MODS.common.reloadMult;
      local.wpn.reloadTotal = total;
      local.wpn.reloadingEmpty = empty;
      local.wpn.reloadInitialAmmo = ammo;
      online.viewmodel.notifyReloadStarted(id, 'common', empty);
      let elapsed = 0;
      for (const phase of [0, 0.05, 0.13, 0.22, 0.32, 0.4, 0.46, 0.56, 0.67, 0.79, 0.87, 0.91, 0.97, 1.01]) {
        const next = total * phase;
        const dt = next - elapsed;
        elapsed = next;
        local.wpn.reloadTimer = Math.max(0, total - elapsed);
        vm.update(local, dt, 0, 0, 0);
        online.viewmodel.updateView(online.view, dt, 0, 0, 0);
        expectSamePresentation(vm.group, online.viewmodel.group, `${id} phase=${phase}`);
        expectPose(offline.model.mag, online.model.mag);
        expectPose(offline.model.bolt, online.model.bolt);
      }
    });
  });

  it.each(['shotgun', 'sniper'] as const)('%s offline and replica bolt timelines agree through exact completion', (id) => {
    const online = setup(id);
    const offline = mockModel();
    const vm = new ViewModel(factory(offline.build));
    onTestFinished(() => vm.dispose());
    const local = offlineActor(id, 2);
    vm.update(local, 0.4, 0, 0, 0);
    const rest = offline.model.bolt.clone();
    const total = id === 'shotgun' ? Math.max(0.55, 60 / WEAPONS[id].rpm - 0.3) : Math.max(0.9, 60 / WEAPONS[id].rpm - 0.35);
    online.viewmodel.notifyShotFired(id);
    let elapsed = 0;
    for (const phase of [0, 0.1, 0.25, 0.5, 0.75, 0.99, 1.01, 1.1]) {
      const next = total * phase;
      const dt = next - elapsed;
      elapsed = next;
      local.wpn.boltTimer = Math.max(0, total - elapsed);
      vm.update(local, dt, 0, 0, 0);
      online.viewmodel.updateView(online.view, dt, 0, 0, 0);
      expectSamePresentation(vm.group, online.viewmodel.group);
    }
    expect(offline.model.bolt.position.toArray()).toEqual(rest.position.toArray());
    expect(online.model.bolt.position.toArray()).toEqual(rest.position.toArray());
  });

  it('allocates independent hand, fist and sleeve skeletons across instances and leaves the idle instance untouched', () => {
    const active = setup('ar');
    const idle = setup('ar');
    const activeMeshes = meshes(active.viewmodel.group);
    const idleMeshes = meshes(idle.viewmodel.group);
    expect(activeMeshes.length).toBeGreaterThanOrEqual(6);
    expect(idleMeshes).toHaveLength(activeMeshes.length);
    const allMeshes = [...activeMeshes, ...idleMeshes];
    expect(new Set(allMeshes.map((mesh) => mesh.skeleton)).size).toBe(allMeshes.length);
    const allBones = allMeshes.flatMap((mesh) => mesh.skeleton.bones);
    expect(allBones.length).toBeGreaterThan(50);
    expect(new Set(allBones).size).toBe(allBones.length);
    const poses = idleMeshes.map((mesh) => mesh.skeleton.bones.map((bone) => bone.clone(false)));
    const activePoses = activeMeshes.map((mesh) => mesh.skeleton.bones.map((bone) => bone.quaternion.clone()));
    active.viewmodel.notifyReloadStarted('ar', 'common', true);
    active.viewmodel.updateView(active.view, WEAPONS.ar.reloadEmpty * 0.22, 0, 0, 0);
    expect(activeMeshes.some((mesh, i) => mesh.skeleton.bones.some((bone, j) => !bone.quaternion.equals(activePoses[i]![j]!)))).toBe(true);
    for (let i = 0; i < idleMeshes.length; i++) {
      for (let j = 0; j < idleMeshes[i]!.skeleton.bones.length; j++) {
        expectPose(idleMeshes[i]!.skeleton.bones[j]!, poses[i]![j]!);
      }
    }
    const activeBone = activeMeshes[0]!.skeleton.bones[0]!;
    activeBone.position.x += 0.123;
    activeBone.rotation.y += 0.5;
    idle.viewmodel.updateView(idle.view, 1 / 60, 0, 0, 0);
    for (let i = 0; i < idleMeshes.length; i++) {
      for (let j = 0; j < idleMeshes[i]!.skeleton.bones.length; j++) {
        expectPose(idleMeshes[i]!.skeleton.bones[j]!, poses[i]![j]!);
      }
    }
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
