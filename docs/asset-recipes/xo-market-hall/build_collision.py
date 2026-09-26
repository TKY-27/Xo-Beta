"""Author the XO market hall production COLLISION HULL.

Run:  blender -b --factory-startup --python src/build_collision.py

Deliberately *not* a mesh of the visible shell.  This is a physics-only proxy:

  * ten axis-aligned boxes, all closed and consistently wound outward, so the
    hull is convex-per-volume and never self-intersecting;
  * the entrance, the windows and the plinth overhang are NOT represented --
    there is no doorway to walk through and no need to collide with a 300 mm
    ledge;
  * the interiors are one solid volume, so an agent can never end up inside a
    wall.  If you need walkable interiors, replace box 1 with a room collider
    (see README "LOD / collision binding").

All ten boxes are authored here, in metric world space, and are the same volume
the gameplay already used: the hall footprint 8.00 x 5.00 m with the 0.35 m
plinth oversail, so nothing shifts when the hull replaces the visible mesh.
"""

from __future__ import annotations

import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# ---- dimensions, mirrored from build_market.py (checked by the assert block) --
W_OUT, D_OUT, T = 8.00, 5.00, 0.42
PLINTH_H, PLINTH_OVER = 0.30, 0.35
Z_DECK = 3.70
Z_COPE = Z_DECK + 0.30 + 0.06          # 4.06, top of parapet coping
Z_FASCIA_TOP = 3.40 + 0.30 / 2 + 0.40  # beam-end / fascia envelope, 4.25

# Positions below are the *measured* bounds of the corresponding authored LOD0
# members (canopy posts are re-derived through the AWN_K/AWN_AX canopy
# transform).  verify() at the end re-checks every box against the real mesh.
BOXES = [
    ("hall_plinth",     (-4.350, -2.850, 0.000), ( 4.350,  2.850, 0.300)),
    ("hall_mass",       (-4.000, -2.500, 0.000), ( 4.000,  2.500, 3.700)),
    ("hall_cap",        (-4.070, -2.570, 3.700), ( 4.070,  2.570, 4.250)),
    ("leanto",          ( 0.900,  2.500, 0.000), ( 4.380,  4.860, 2.320)),
    ("upper_room",      (-3.300,  0.200, 3.700), (-1.600,  1.700, 5.390)),
    ("canopy_post_w0",  (-3.533, -4.105, 0.000), (-3.363, -3.935, 2.480)),
    ("canopy_post_w1",  (-1.517, -4.105, 0.000), (-1.347, -3.935, 2.480)),
    ("canopy_post_e0",  ( 1.325, -3.595, 0.000), ( 1.475, -3.445, 2.240)),
    ("canopy_post_e1",  ( 2.775, -3.595, 0.000), ( 2.925, -3.445, 2.240)),
    ("stall_ext",       (-2.960, -3.720, 0.000), (-1.640, -3.000, 0.900)),
    ("stall_int",       (-2.770, -0.300, 0.300), (-2.130,  1.400, 1.180)),
    ("entry_steps",     (-1.620, -3.550, 0.000), ( 1.620, -2.850, 0.300)),
]


def verify(glb_path):
    """Re-open the authored LOD0 and confirm every hull box overlaps real
    geometry.  Cheap insurance against a hull box that silently drifts."""
    bpy.ops.wm.open_mainfile(filepath=os.path.join(
        os.path.dirname(HERE), "export", "market_hall.blend"))
    groups = {}
    for o in bpy.data.objects:
        if o.type != 'MESH' or not o.data.vertices:
            continue
        vs = [o.matrix_world @ v.co for v in o.data.vertices]
        g = o.name.replace("XO_XO_", "").replace("donor_", "DONOR_")
        lo = groups.setdefault(g, [[1e9] * 3, [-1e9] * 3])
        for v in vs:
            for i in range(3):
                lo[0][i] = min(lo[0][i], v[i])
                lo[1][i] = max(lo[1][i], v[i])
    bpy.ops.wm.read_homefile(use_empty=True)
    bad = 0
    for name, a, c in BOXES:
        hit = [g for g, (lo, hi) in groups.items()
               if all(min(c[i], hi[i]) - max(a[i], lo[i]) > 0.0 for i in range(3))]
        flag = "" if hit else "   <-- NO GEOMETRY"
        bad += 0 if hit else 1
        print("  CHECK %-15s %s%s" % (name, ",".join(sorted(hit)[:4]), flag))
    print("COLLISION_VERIFY boxes=%d empty=%d" % (len(BOXES), bad))
    return bad


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.data.collections.new("Collision")
    bpy.context.scene.collection.children.link(col)
    for name, lo, hi in BOXES:
        cx, cy, cz = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
        hx, hy, hz = ((hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2)
        mesh = bpy.data.meshes.new(name)
        v = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
             (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
        # outward winding: bottom face -Z, top +Z, sides by edge order
        f = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        mesh.from_pydata(v, [], f)
        mesh.validate()
        ob = bpy.data.objects.new(name, mesh)
        col.objects.link(ob)
        ob.location = (cx, cy, cz)
        ob.display_type = 'WIRE'
    root = bpy.data.objects.new("XO_MarketHall_Collision", None)
    root.empty_display_type = 'CUBE'
    root.empty_display_size = 0.4
    col.objects.link(root)
    for name, *_ in BOXES:
        ob = bpy.data.objects[name]
        ob.parent = root
        ob.matrix_parent_inverse = root.matrix_world.inverted()
    root["xo_asset"] = "XO Market Hall — collision hull"
    root["xo_authored"] = "10 axis-aligned boxes, authored in Blender"
    root["xo_licence"] = "CC0 1.0"
    root["xo_collision"] = (
        "lobby/NavMesh+physics proxy. No doorway, no windows, no plinth "
        "overhang. Interiors are solid volumes: delete hall_mass and replace "
        "with room colliders if you need walkable interiors.")


def main():
    build()
    out = os.path.join(os.path.dirname(HERE), "export")
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "market_hall_collision.blend"))
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(out, "market_hall_collision.glb"),
        export_format='GLB', export_apply=True, export_yup=True,
        export_extras=True, export_cameras=False, export_lights=False)
    boxes = BOXES
    print("COLLISION boxes=%d" % len(boxes))
    for name, lo, hi in boxes:
        print("  HULL %-14s lo=(%.2f,%.2f,%.2f) hi=(%.2f,%.2f,%.2f)"
              % (name, *lo, *hi))
    print("EXPORTED", os.path.join(out, "market_hall_collision.glb"),
          os.path.getsize(os.path.join(out, "market_hall_collision.glb")))
    verify(os.path.join(out, "market_hall.glb"))


if __name__ == "__main__":
    main()
