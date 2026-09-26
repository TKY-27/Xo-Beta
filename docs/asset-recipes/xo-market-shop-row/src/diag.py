"""Diagnostics for the pass3 desert shop row.

Reports, for the built blend file:
  * per-object vert/face counts and axis-aligned bounds (outliers flagged)
  * global bounds with and without outlier objects
  * triangle count after triangulation, non-manifold edge and loose-vertex counts
  * material list with image resolution
  * a pass/fail verdict line

Run:  blender -b --factory-startup export/shop_row.blend --python src/diag.py
"""
import json
import os
import sys

import bpy
from mathutils import Vector

LIMIT = 40.0
OUTLIER = 60.0


def mesh_facts(ob):
    me = ob.data
    mw = ob.matrix_world
    co = [mw @ v.co for v in me.vertices]
    if not co:
        return None
    lo = Vector((min(c.x for c in co), min(c.y for c in co), min(c.z for c in co)))
    hi = Vector((max(c.x for c in co), max(c.y for c in co), max(c.z for c in co)))
    return lo, hi


def tri_count(ob):
    me = ob.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def nonmanifold(ob):
    me = ob.data
    counts = {}
    for poly in me.polygons:
        for ek in poly.edge_keys:
            counts[ek] = counts.get(ek, 0) + 1
    bad = sum(1 for v in counts.values() if v not in (2,))
    used = set()
    for poly in me.polygons:
        used.update(poly.vertices)
    loose = len(me.vertices) - len(used)
    return bad, loose


def main():
    scene = bpy.context.scene
    rows = []
    gl = Vector((1e9, 1e9, 1e9))
    gh = Vector((-1e9, -1e9, -1e9))
    gl_clean = Vector((1e9, 1e9, 1e9))
    gh_clean = Vector((-1e9, -1e9, -1e9))
    tot_v = tot_f = tot_t = 0
    nm_total = loose_total = 0
    clean = True
    for ob in sorted(scene.objects, key=lambda o: o.name):
        if ob.type != "MESH":
            continue
        f = mesh_facts(ob)
        if f is None:
            continue
        lo, hi = f
        span = max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
        flagged = max(abs(v) for v in (*lo, *hi)) > LIMIT
        t = tri_count(ob)
        nm, loose = nonmanifold(ob)
        mats = [m.name for m in ob.data.materials]
        rows.append({
            "object": ob.name,
            "verts": len(ob.data.vertices),
            "faces": len(ob.data.polygons),
            "tris": t,
            "lo": [round(v, 3) for v in lo],
            "hi": [round(v, 3) for v in hi],
            "materials": mats,
            "nonmanifold_edges": nm,
            "loose_verts": loose,
            "outlier": flagged,
            "span_m": round(span, 3),
        })
        tot_v += len(ob.data.vertices)
        tot_f += len(ob.data.polygons)
        tot_t += t
        nm_total += nm
        loose_total += loose
        for i in range(3):
            gl[i] = min(gl[i], lo[i])
            gh[i] = max(gh[i], hi[i])
            if not flagged:
                gl_clean[i] = min(gl_clean[i], lo[i])
                gh_clean[i] = max(gh_clean[i], hi[i])
        if flagged:
            clean = False

    mats = sorted({m.name for ob in scene.objects if ob.type == "MESH"
                   for m in ob.data.materials})
    images = {}
    for img in bpy.data.images:
        if img.name in ("Render Result", "Viewer Node"):
            continue
        images[img.name] = [img.size[0], img.size[1], img.source]

    report = {
        "objects": len(rows),
        "materials": len(mats),
        "material_names": mats,
        "verts": tot_v,
        "faces": tot_f,
        "tris": tot_t,
        "nonmanifold_edges": nm_total,
        "loose_verts": loose_total,
        "bounds_min": [round(v, 4) for v in gl],
        "bounds_max": [round(v, 4) for v in gh],
        "bounds_min_clean": [round(v, 4) for v in gl_clean],
        "bounds_max_clean": [round(v, 4) for v in gh_clean],
        "clean": clean,
        "images": images,
        "per_object": rows,
    }
    print("DIAG_JSON " + json.dumps(report, sort_keys=True))
    for r in rows:
        mark = "  <== OUTLIER" if r["outlier"] else ""
        print("  %-34s v=%-6d f=%-6d t=%-6d nm=%-4d %s%s"
              % (r["object"], r["verts"], r["faces"], r["tris"],
                 r["nonmanifold_edges"], r["lo"], mark))
    print("DIAG_TOTAL objects=%d mats=%d verts=%d faces=%d tris=%d nm=%d clean=%s"
          % (len(rows), len(mats), tot_v, tot_f, tot_t, nm_total, clean))
    print("DIAG_BOUNDS %s %s" % (list(gl_clean), list(gh_clean)))
    sys.stdout.flush()


main()
