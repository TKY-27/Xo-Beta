#!/usr/bin/env python3
"""Collision proxy set for the authored 2-bay desert shop row.

Twelve explicit axis-aligned boxes, one Blender object per box, exported as
shop_row_collision.glb.  No textures, no materials, no donor geometry: the
file is a pure collision mesh that a physics layer can triangulate directly.

Deliberate omissions, recorded in README.md:
  * the awning canopy and its slats are omitted -- the clear height under the
    front edge is 2.07 m, so it is walkable and needs a headroom check, not a
    blocker; only its two props are proxied;
  * the roof, parapets, corbels, loft and roof clutter are omitted, so this is
    a ground-level set only;
  * the lean-to in the rear yard and the gate head beam are omitted;
  * the two front boundary stubs are folded into the front-wall boxes, which
    over-blocks a 0.50 x 0.58 m footprint at each front corner.

Run:  blender -b --factory-startup export/shop_row.blend \
           --python src/build_collision.py
"""
import json
import os

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# name, (x0, y0, z0), (x1, y1, z1)  -- metres, Z-up, front facade faces -Y
BOXES = [
    ("ground_apron",      (-4.40, -3.66, -0.14), (4.52, 3.05, 0.10)),
    ("wall_front_west",    (-4.40, -2.68,  0.00), (0.42, -1.17, 3.05)),
    ("wall_front_east",    (0.42, -2.68,  0.00), (4.52, -1.17, 2.82)),
    ("wall_rear",          (-4.40,  1.17,  0.00), (4.52, 2.05, 3.05)),
    ("wall_end_west",      (-4.40, -1.17,  0.00), (-3.12, 1.17, 3.05)),
    ("wall_end_east",      (3.12, -1.17,  0.00), (4.52, 1.17, 2.82)),
    ("wall_bay_divider",   (-0.18, -1.17,  0.00), (0.06, 1.17, 2.82)),
    ("boundary_rear_w",    (-4.40,  2.60,  0.00), (-2.42, 2.99, 0.94)),
    ("boundary_rear_e",    (2.42,  2.60,  0.00), (4.52, 2.99, 0.94)),
    ("stall_counter",      (0.36, -2.10,  0.86), (3.24, -1.13, 1.02)),
    ("awning_post_west",   (0.54, -3.22,  0.00), (0.70, -3.06, 2.18)),
    ("awning_post_east",   (2.92, -3.22,  0.00), (3.08, -3.06, 2.18)),
]

QUADS = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.length_unit = 'METERS'

    root = bpy.data.objects.new("XO_ShopRow_collision", None)
    root.empty_display_type = 'CUBE'
    root.empty_display_size = 0.4
    scene.collection.objects.link(root)

    total = 0
    for name, lo, hi in BOXES:
        v = [(lo[0], lo[1], lo[2]), (hi[0], lo[1], lo[2]), (hi[0], hi[1], lo[2]),
             (lo[0], hi[1], lo[2]), (lo[0], lo[1], hi[2]), (hi[0], lo[1], hi[2]),
             (hi[0], hi[1], hi[2]), (lo[0], hi[1], hi[2])]
        me = bpy.data.meshes.new("COL_%s" % name)
        me.from_pydata(v, [], QUADS)
        me.validate()
        me.update()
        ob = bpy.data.objects.new("COL_%s" % name, me)
        ob.display_type = 'WIRE'
        ob.parent = root
        ob["xo_role"] = "collision_proxy"
        ob["xo_proxy"] = name
        ob["xo_size_m"] = [round(hi[i] - lo[i], 3) for i in range(3)]
        scene.collection.objects.link(ob)
        total += len(me.polygons)

    root["xo_boxes"] = len(BOXES)
    root["xo_kind"] = "AABB collision proxies, geometry only, no materials"
    root["xo_units"] = "metres, Z-up in Blender / Y-up in glTF"
    root["xo_licence"] = "CC0 1.0 (see PROVENANCE.md)"

    os.makedirs(os.path.join(ROOT, "export"), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.join(ROOT, "export", "shop_row_collision.blend"))
    out = os.path.join(ROOT, "export", "shop_row_collision.glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True,
                              export_yup=True, export_extras=True,
                              export_cameras=False, export_lights=False,
                              export_materials='NONE')
    print("COLLISION %s" % json.dumps(
        {"boxes": len(BOXES), "faces": total,
         "bytes": os.path.getsize(out)}, sort_keys=True), flush=True)
    return out


def verify(glb_path):
    """Re-open the finished .blend and check every proxy still overlaps real
    model geometry, so the collision set cannot silently drift away from the
    asset it was cut for."""
    from mathutils import Vector
    bpy.ops.wm.open_mainfile(filepath=os.path.join(ROOT, "export",
                                                   "shop_row.blend"))
    spans = [(list(lo), list(hi)) for _, lo, hi in BOXES]
    names = [n for n, _, _ in BOXES]
    hits = [0] * len(BOXES)
    model_verts = 0
    for o in bpy.data.objects:
        if o.type != 'MESH' or o.name.startswith("COL_"):
            continue
        mw = o.matrix_world
        for v in o.data.vertices:
            model_verts += 1
            w = mw @ v.co
            for k, (lo, hi) in enumerate(spans):
                if (lo[0] <= w.x <= hi[0] and lo[1] <= w.y <= hi[1]
                        and lo[2] <= w.z <= hi[2]):
                    hits[k] += 1
    empty = [n for n, h in zip(names, hits) if h == 0]
    tris = sum(len(p.vertices) - 2 for o in bpy.data.objects
               if o.type == 'MESH' and not o.name.startswith("COL_")
               for p in o.data.polygons)
    print("COLLISION_VERIFY boxes=%d empty=%s hits=%s detail_tris=%d"
          % (len(spans), empty or "none", hits, tris), flush=True)
    return empty




if __name__ == "__main__":
    build()
    verify(os.path.join(ROOT, "export", "shop_row_collision.glb"))
