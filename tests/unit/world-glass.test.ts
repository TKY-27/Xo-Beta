import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addBuilding } from '../../src/world/maps/common';
import { WorldBuilder } from '../../src/world/builder';
import { GlassInstancePool } from '../../src/render/worldView';

describe('shared building destructible glazing', () => {
  it('makes ground, second-floor and highest-floor panes authoritative', () => {
    const b = new WorldBuilder('glass-fixture', 'Glass fixture', 'Glass fixture', 100);
    addBuilding(b, {
      x: 0, z: 0, baseY: 0, w: 12, d: 10, floors: 3, floorHeight: 3.6,
      wallMat: 'concrete', trimMat: 'metal', windows: true, interiorDividers: false,
    });

    const panes = b.def.destructibles.filter((d) => d.type === 'glass' && d.geo.kind === 'box');
    expect(panes).toHaveLength(30);
    expect(panes.filter((pane) => pane.geo.kind === 'box' && pane.geo.y < 3.6)).toHaveLength(2);
    expect(panes.some((pane) => pane.geo.kind === 'box' && pane.geo.y > 4.5 && pane.geo.y < 6.5)).toBe(true);
    expect(panes.some((pane) => pane.geo.kind === 'box' && pane.geo.y > 8.5)).toBe(true);
    expect(new Set(panes.map((pane) => pane.stableId)).size).toBe(panes.length);
  });

  it('keeps pane dimensions correct for front, back, left and right orientations', () => {
    const b = new WorldBuilder('glass-orientation', 'Glass orientation', 'Glass orientation', 100);
    addBuilding(b, {
      x: 10, z: -4, baseY: 0, w: 12, d: 10, floors: 2, floorHeight: 3.6,
      wallMat: 'concrete', windows: true, interiorDividers: false,
    });
    const panes = b.def.destructibles.filter((d) => d.type === 'glass' && d.geo.kind === 'box')
      .map((d) => d.geo.kind === 'box' ? d.geo : null)
      .filter((geo): geo is Exclude<typeof geo, null> => geo !== null && geo.y > 3.6);
    const alongX = panes.filter((pane) => pane.sx > 1 && pane.sz < 0.1);
    const alongZ = panes.filter((pane) => pane.sx < 0.1 && pane.sz > 1);
    expect(alongX.length).toBe(8);
    expect(alongZ.length).toBe(6);
    expect(new Set(alongX.map((pane) => Math.sign(pane.z))).size).toBe(2);
    expect(new Set(alongZ.map((pane) => Math.sign(pane.x - 10))).size).toBe(2);
    expect(panes.every((pane) => pane.sy > 2)).toBe(true);
  });

  it('does not leave visual-only glass over the shared helper openings', () => {
    const b = new WorldBuilder('glass-no-duplicates', 'Glass', 'Glass', 100);
    addBuilding(b, {
      x: 0, z: 0, baseY: 0, w: 12, d: 10, floors: 3,
      wallMat: 'concrete', windows: true, interiorDividers: false,
    });
    expect(b.def.geo.filter((geo) => geo.mat === 'glass')).toHaveLength(0);
  });
});

describe('bounded glass rendering pool', () => {
  it('maps stable destructible identities to instances and hides a broken pane once', () => {
    const material = new THREE.MeshBasicMaterial({ color: 0x9edfff });
    const pool = new GlassInstancePool([
      { id: 3, stableId: 'fixture:glass:0003', geo: { x: 1, y: 2, z: 3, sx: 1.2, sy: 2.2, sz: 0.08 } },
      { id: 4, stableId: 'fixture:glass:0004', geo: { x: -1, y: 2, z: 3, sx: 0.08, sy: 2.2, sz: 1.2, yaw: 0.2 } },
    ], material);

    expect(pool.mesh.count).toBe(2);
    expect(pool.visibleCount).toBe(2);
    expect(pool.mesh.castShadow).toBe(false);
    expect(pool.mesh.receiveShadow).toBe(false);
    expect(pool.hasStableId('fixture:glass:0004')).toBe(true);
    expect(pool.hideStableId('fixture:glass:0004')).toBe(true);
    expect(pool.visibleCount).toBe(1);
    expect(pool.hideStableId('fixture:glass:0004')).toBe(false);
    expect(pool.hide(4)).toBe(false);
    expect(pool.hide(99)).toBe(false);
    expect(pool.visibleCount).toBe(1);
    const hidden = new THREE.Matrix4();
    pool.mesh.getMatrixAt(1, hidden);
    expect([hidden.elements[0], hidden.elements[5], hidden.elements[10]]).toEqual([0, 0, 0]);
    pool.dispose();
    pool.dispose();
    material.dispose();
  });
});
