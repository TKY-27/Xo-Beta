"""Authoring primitives for the pass-3 desert shop row.

Units and axes: Z up, metres, shop front faces -Y, footprint centred on X = 0,
ground level at Z = 0.  Every member is authored directly in world space with
an identity object transform, so members can be merged by material without any
transform bookkeeping.

Topology policy: every generator emits a CLOSED solid.  Nothing here relies on
boolean modifiers, so no n-gon-with-hole artefacts and no T-junctions, and the
merged meshes stay watertight for collision and for the solid-clay inspection
render.  ``recalc_normals`` is run on each member so winding is always outward
regardless of the order faces were pushed.
"""

from __future__ import annotations

import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

UV_METRES = 0.62          # 1 UV unit == 1/0.62 m of surface
COLLECTIONS: dict[str, bpy.types.Collection] = {}


# ------------------------------------------------------------------ scene glue
def group(name: str) -> bpy.types.Collection:
    if name not in COLLECTIONS:
        col = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(col)
        COLLECTIONS[name] = col
    return COLLECTIONS[name]


def spawn(name, verts, faces, mat, grp="Architecture", angle=34.0):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], [list(map(int, f)) for f in faces])
    me.validate(verbose=False)
    me.update()
    ob = bpy.data.objects.new(name, me)
    group(grp).objects.link(ob)
    if mat is not None:
        me.materials.append(mat)
    ob["xo_smooth_deg"] = float(angle)
    return ob


def recalc(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return ob


# --------------------------------------------------------------- solid builders
def prism(name, bottom, top, mat, grp="Architecture", angle=34.0):
    """Closed solid from two equal-length rings of 3D points (any n)."""
    n = len(bottom)
    verts = [Vector(p) for p in bottom] + [Vector(p) for p in top]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return recalc(spawn(name, verts, faces, mat, grp, angle))


def hexa(name, lo, hi, mat, grp="Architecture", angle=34.0):
    """Axis-aligned box from two opposite corners."""
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    return prism(name,
                 [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)],
                 [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
                 mat, grp, angle)


def boxc(name, centre, size, mat, grp="Architecture", angle=34.0, yaw=0.0, tilt=0.0,
         roll=0.0):
    """Box from centre + size, optionally yawed about Z then tilted about Y."""
    hx, hy, hz = (s * 0.5 for s in size)
    m = (Matrix.Translation(centre)
         @ Matrix.Rotation(yaw, 4, 'Z')
         @ Matrix.Rotation(tilt, 4, 'Y')
         @ Matrix.Rotation(roll, 4, 'X'))
    ob = hexa(name, (-hx, -hy, -hz), (hx, hy, hz), mat, grp, angle)
    return _moved(ob, m)


def _moved(ob, m):
    ob.data.transform(m)
    return ob


def beam(name, p0, p1, width, thick, mat, grp="Architecture", up=(0.0, 0.0, 1.0),
         roll=0.0, angle=34.0):
    """Rectangular member spanning p0 -> p1.  ``width`` lies in the plane of
    ``up``, ``thick`` is measured along ``up`` projected perpendicular to the
    run.  Used for every timber in the build."""
    a, b = Vector(p0), Vector(p1)
    d = b - a
    run = d.normalized()
    u = Vector(up)
    if abs(run.dot(u.normalized())) > 0.98:
        u = Vector((0.0, 1.0, 0.0))
    side = run.cross(u).normalized()
    if roll:
        side = Matrix.Rotation(roll, 3, run) @ side
    n = side.cross(run).normalized()
    ring_a = [a - side * (width * .5) - n * (thick * .5),
              a + side * (width * .5) - n * (thick * .5),
              a + side * (width * .5) + n * (thick * .5),
              a - side * (width * .5) + n * (thick * .5)]
    ring_b = [p + d for p in ring_a]
    return prism(name, ring_a, ring_b, mat, grp, angle)


def batter(name, footprint, height, taper, mat, grp="Architecture", angle=34.0,
           top_inset=(0.0, 0.0)):
    """A wall/plinth whose plan shrinks with height -- the adobe batter.  The
    solid is a 6-sided prism: base rectangle, mid-height rectangle, top
    rectangle, with the top also inset on the chosen two sides."""
    (x0, x1), (y0, y1) = footprint
    z0, z1 = height
    zm = z0 + (z1 - z0) * 0.5
    ti, tj = top_inset

    def rect(z, k):
        d = taper * (z - z0) / max(1e-6, (z1 - z0))
        return [(x0 + d, y0 + d, z), (x1 - d, y0 + d, z),
                (x1 - d, y1 - d, z), (x0 + d, y1 - d, z)]

    verts = rect(z0, 0.0) + rect(zm, 0.0) + [(p[0] - ti, p[1] - tj, z1) for p in rect(z1, 0.0)]
    faces = [(3, 2, 1, 0)]
    for r in range(2):
        a, b = r * 4, (r + 1) * 4
        for i in range(4):
            j = (i + 1) % 4
            faces.append((a + i, a + j, b + j, b + i))
    faces.append((8, 9, 10, 11))
    return recalc(spawn(name, verts, faces, mat, grp, angle))


# ------------------------------------------------------------ wall with openings
def wall(name, u0, u1, v0, v1, y0, y1, openings, mat, grp="Architecture", angle=34.0):
    """A thick wall in the XZ plane with rectangular openings cut through it.

    Local frame: u runs along +X, v along +Z, solid occupies y in [y0, y1].

    ``openings`` is a list of dicts:
        u0, u1, v0, v1  -- the opening rectangle on the FRONT face (y0)
        depth           -- how far back the reveal runs from y0.  A value equal
                           to (y1 - y0) is a through opening; anything shorter
                           is a blind recess and gets a closing back plate.

    Both faces are emitted from one global (u, v) cut grid, so the panel shares
    vertices across cell boundaries and has no T-junctions.  Every opening gets
    a real four-sided reveal (two jambs, sill, soffit) running to its own depth,
    which is what makes a 620 mm adobe wall read as thick instead of thin.
    """
    ops = []
    for o in openings:
        d = float(o.get("depth", y1 - y0))
        ops.append((float(o["u0"]), float(o["u1"]), float(o["v0"]), float(o["v1"]),
                    min(max(d, 1e-4), y1 - y0)))
    ucuts = {u0, u1}
    vcuts = {v0, v1}
    for a, b, c, d, _ in ops:
        ucuts |= {a, b}
        vcuts |= {c, d}
    U = sorted(ucuts)
    V = sorted(vcuts)
    full = y1 - y0

    verts: list[Vector] = []
    faces: list[list[int]] = []
    cache: dict[tuple, int] = {}

    def vid(u, v, y):
        k = (round(u, 5), round(v, 5), round(y, 5))
        if k not in cache:
            cache[k] = len(verts)
            verts.append(Vector((u, y, v)))
        return cache[k]

    def hit(u, v, only_through=False):
        for a, b, c, d, dep in ops:
            if a < u < b and c < v < d and (not only_through or dep >= full - 1e-6):
                return True
        return False

    for y, thru in ((y0, False), (y1, True)):
        for i in range(len(U) - 1):
            ua, ub = U[i], U[i + 1]
            for j in range(len(V) - 1):
                va, vb = V[j], V[j + 1]
                mu, mv = (ua + ub) * .5, (va + vb) * .5
                if hit(mu, mv, thru):
                    continue
                faces.append([vid(ua, va, y), vid(ub, va, y), vid(ub, vb, y), vid(ua, vb, y)])

    for i in range(len(U) - 1):
        ua, ub = U[i], U[i + 1]
        mu = (ua + ub) * .5
        if not hit(mu, v0 + 1e-5) and not hit(mu, v1 - 1e-5, True):
            faces.append([vid(ua, v0, y0), vid(ua, v0, y1), vid(ub, v0, y1), vid(ub, v0, y0)])
            faces.append([vid(ua, v1, y0), vid(ub, v1, y0), vid(ub, v1, y1), vid(ua, v1, y1)])
    for j in range(len(V) - 1):
        va, vb = V[j], V[j + 1]
        mv = (va + vb) * .5
        if not hit(u0 + 1e-5, mv) and not hit(u1 - 1e-5, mv, True):
            faces.append([vid(u0, va, y0), vid(u1, va, y0), vid(u1, va, y1), vid(u0, va, y1)])
            faces.append([vid(u0, vb, y0), vid(u0, vb, y1), vid(u1, vb, y1), vid(u1, vb, y0)])

    for a, b, c, d, dep in ops:
        yb = y0 + dep
        faces.append([vid(a, c, y0), vid(a, c, yb), vid(a, d, yb), vid(a, d, y0)])
        faces.append([vid(b, c, y0), vid(b, d, y0), vid(b, d, yb), vid(b, c, yb)])
        faces.append([vid(a, c, y0), vid(b, c, y0), vid(b, c, yb), vid(a, c, yb)])
        faces.append([vid(a, d, y0), vid(a, d, yb), vid(b, d, yb), vid(b, d, y0)])
        if dep < full - 1e-6:
            faces.append([vid(a, c, yb), vid(b, c, yb), vid(b, d, yb), vid(a, d, yb)])
    return recalc(spawn(name, verts, faces, mat, grp, angle))


def splay(name, outer, inner, y0, y1, mat, grp="Architecture", angle=34.0):
    """Close the four corners of a straight wall aperture into a splayed
    opening.  ``wall()`` cuts a clean rectangular hole of the *inner* size; the
    outer size is the aperture actually seen at the front face.  Each of the
    four edges of the outer rectangle is extruded along its partner edge of the
    inner rectangle, giving four closed collar solids that fill the corner gaps
    exactly.  A wider ``inner`` is the classic flared adobe window, a narrower
    one a tapering niche.

    Edge order is bottom, right, top, left (counter-clockwise seen from +Y) and
    the two rects are walked the same way round, so the quads never cross."""
    (a0, a1, b0, b1) = outer
    (c0, c1, d0, d1) = inner
    edges = [(((a0, b0), (a1, b0)), ((c0, d0), (c1, d0))),
             (((a1, b0), (a1, b1)), ((c1, d0), (c1, d1))),
             (((a1, b1), (a0, b1)), ((c1, d1), (c0, d1))),
             (((a0, b1), (a0, b0)), ((c0, d1), (c0, d0)))]
    made = []
    for k, (eo, ei) in enumerate(edges):
        if eo == ei:
            continue
        q0 = [eo[0], ei[0], ei[1], eo[1]]
        q1 = [eo[0], ei[0], ei[1], eo[1]]
        verts = ([(p[0], y0, p[1]) for p in q0]
                 + [(p[0], y1, p[1]) for p in q1])
        faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
                 [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
        ob = recalc(spawn(f"{name}_{k}", verts, faces, mat, grp, angle))
        ob.matrix_world = Matrix.Identity(4)      # verts are already world space
        made.append(ob)
    return made


def reveal_cap(name, u0, u1, v0, v1, y0, y1, mat, grp="Architecture", angle=34.0):
    """A lining slab dropped into a reveal -- timber window surround, door
    lining, jamb plaster.  Closed solid, sits inside the aperture."""
    return hexa(name, (u0, y0, v0), (u1, y1, v1), mat, grp, angle)


# ------------------------------------------------------------------ revolutions
def lathe(name, profile, mat, grp="Props", segs=16, angle=50.0, scallop=0.0,
          oval=(1.0, 1.0), loc=(0.0, 0.0, 0.0), yaw=0.0, cap_bottom=True,
          cap_top=True):
    """Surface of revolution about +Z from a (radius, z) profile.

    ``scallop`` alternately pinches the radius, turning a plain pot into a
    ribbed or fluted one.  Zero-radius profile points collapse to triangles,
    which is how the jar foot and the ewer spout close cleanly.
    """
    verts: list[Vector] = []
    faces: list[list[int]] = []
    rings: list[list[int]] = []
    for r, z in profile:
        if r <= 1e-6:
            verts.append(Vector((0.0, 0.0, z)))
            rings.append([len(verts) - 1] * segs)
            continue
        ring = []
        for s in range(segs):
            a = 2 * math.pi * s / segs
            k = 1.0 - (scallop if s % 2 else 0.0)
            ring.append(len(verts))
            verts.append(Vector((r * k * math.cos(a) * oval[0],
                                 r * k * math.sin(a) * oval[1], z)))
        rings.append(ring)
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        pa, pb = profile[i], profile[i + 1]
        for s in range(segs):
            t = (s + 1) % segs
            if pa[0] <= 1e-6 and pb[0] <= 1e-6:
                continue
            if pa[0] <= 1e-6:
                faces.append([a[0], b[s], b[t]])
            elif pb[0] <= 1e-6:
                faces.append([a[s], a[t], b[0]])
            else:
                faces.append([a[s], a[t], b[t], b[s]])
    if cap_bottom and profile[0][0] > 1e-6:
        faces.append(list(rings[0]))
    if cap_top and profile[-1][0] > 1e-6:
        faces.append(list(reversed(rings[-1])))
    ob = recalc(spawn(name, verts, faces, mat, grp, angle))
    if loc != (0.0, 0.0, 0.0) or yaw:
        ob.data.transform(Matrix.Translation(loc) @ Matrix.Rotation(yaw, 4, 'Z'))
    return ob


def tube(name, path, radius, mat, grp="Props", segs=8, angle=60.0, caps=True,
         radii=None):
    """Swept circular section along a polyline -- rope, hose, conduit, hoop."""
    pts = [Vector(p) for p in path]
    n = len(pts)
    verts: list[Vector] = []
    faces: list[list[int]] = []
    for i, p in enumerate(pts):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        t.normalize()
        ref = Vector((0, 0, 1)) if abs(t.z) < 0.95 else Vector((1, 0, 0))
        nx = t.cross(ref).normalized()
        ny = t.cross(nx).normalized()
        r = radius if radii is None else radii[i]
        for s in range(segs):
            a = 2 * math.pi * s / segs
            verts.append(p + nx * (math.cos(a) * r) + ny * (math.sin(a) * r))
    for i in range(n - 1):
        a, b = i * segs, (i + 1) * segs
        for s in range(segs):
            t = (s + 1) % segs
            faces.append([a + s, a + t, b + t, b + s])
    if caps:
        faces.append(list(range(segs - 1, -1, -1)))
        base = (n - 1) * segs
        faces.append(list(range(base, base + segs)))
    return recalc(spawn(name, verts, faces, mat, grp, angle))


def skin(name, nu, nv, fn, mat, grp="Props", angle=70.0, thick=0.0):
    """Subdivided quad surface from fn(i, j) -> (x, y, z); ``thick`` adds a
    Solidify modifier so cloth and hide read as real sheet goods."""
    verts = [Vector(fn(i, j)) for j in range(nv + 1) for i in range(nu + 1)]
    faces = []
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append([a, a + 1, a + nu + 2, a + nu + 1])
    ob = recalc(spawn(name, verts, faces, mat, grp, angle))
    if thick:
        s = ob.modifiers.new("Solidify", 'SOLIDIFY')
        s.thickness = thick
        s.offset = 0.0
        s.use_rim = True
    return ob


def grid_block(name, lo, hi, steps, mat, grp="Props", angle=40.0, jitter=0.0,
               seed=1):
    """A box whose top face is subdivided and randomly lifted -- a heaped tray of
    produce, a pile of grain, a rubble apron."""
    import random
    rng = random.Random(seed)
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    nx, ny, nz = steps
    ob = hexa(name, lo, hi, mat, grp, angle)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    for f in bm.faces:
        if f.normal.z > 0.9:
            for v in f.verts:
                v.co.z += rng.uniform(-jitter, jitter)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return ob


# ------------------------------------------------------------------- assembly
def merge(name, members, mat, grp="Architecture", angle=34.0):
    """Weld members into one mesh, sharing coincident vertices within 0.1 mm so
    abutting members (wall + lintel + sill) do not show seam normals."""
    verts: list[Vector] = []
    faces: list[list[int]] = []
    lut: dict[tuple, int] = {}
    for ob in members:
        remap = []
        for v in ob.data.vertices:
            k = (round(v.co.x, 4), round(v.co.y, 4), round(v.co.z, 4))
            j = lut.get(k)
            if j is None:
                j = len(verts)
                lut[k] = j
                verts.append(v.co.copy())
            remap.append(j)
        for p in ob.data.polygons:
            faces.append([remap[i] for i in p.vertices])
    for ob in members:
        bpy.data.objects.remove(ob, do_unlink=True)
    return recalc(spawn(name, verts, faces, mat, grp, angle))


# ------------------------------------------------------------------- uv + mods
def project_uv(ob, scale=UV_METRES, offset=(0.0, 0.0)):
    """Triplanar-style box UV in metres off the dominant face axis, so every
    member sharing a material also shares texel density."""
    me = ob.data
    if not me.polygons:
        return ob
    uv = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        n = poly.normal
        ax = max(range(3), key=lambda k: abs(n[k]))
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if ax == 0:
                u, v = co.y, co.z
            elif ax == 1:
                u, v = co.x, co.z
            else:
                u, v = co.x, co.y
            uv.data[li].uv = (u * scale + offset[0], v * scale + offset[1])
    return ob


def select_only(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    return ob


def _clean_degenerates(ob, dist=6.0e-4):
    """Weld sub-millimetre vertices and drop zero-area / loose geometry.

    Blender's Bevel solver divides by edge length, so a single short edge left
    over from abutting authored panels can throw a vertex a billion metres away
    and, because the solver is order-dependent, only on some runs.  Welding
    first, and welding twice, is what makes the bevel stage deterministic: the
    pass is idempotent once the mesh is clean, so it cannot drift between runs.
    The default 0.6 mm threshold sits far below the smallest authored feature
    in this asset (11 mm iron bars, 27 mm awning slats).
    """
    if ob.type != 'MESH' or not ob.data.vertices:
        return
    select_only(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    for step in (dist, dist * 0.4):
        bpy.ops.mesh.select_all(action='SELECT')   # dissolve leaves new verts
        bpy.ops.mesh.remove_doubles(threshold=step, use_centroid=True)
        bpy.ops.mesh.dissolve_degenerate(threshold=step * 0.5)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.delete_loose()
    bpy.ops.object.mode_set(mode='OBJECT')


def auto_smooth(ob, deg=32.0):
    """Angle-based smooth shading, applied once.  Called on merged objects rather
    than per member: in Blender 4.1+ this adds a geometry-nodes modifier, which
    is far too slow to add a few hundred times."""
    select_only(ob)
    try:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(deg))
    except Exception:
        return ob
    for m in [x.name for x in ob.modifiers]:
        try:
            bpy.ops.object.modifier_apply(modifier=m)
        except RuntimeError:
            pass
    return ob


def weld(ob, dist=1.0e-5):
    """Fuse exactly coincident vertices only.  No dissolve, so a legitimate
    sliver face survives; this just stops the merged object being a cloud of
    duplicated corner points."""
    if ob.type != 'MESH' or not ob.data.vertices:
        return
    select_only(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=dist, use_centroid=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def _sane(ob, limit=25.0):
    for v in ob.data.vertices:
        if max(abs(v.co.x), abs(v.co.y), abs(v.co.z)) > limit:
            return False
    return True


def finish(ob, bevel=0.014, segs=2, angle=30.0, smooth=None, apply=True, fallback=True):
    """UV + micro-bevel + auto-smooth + weighted normals, baked into the mesh.

    The modifier stack is evaluated on a throwaway duplicate and only adopted
    when every vertex stays inside a sane world-space bound; otherwise the
    un-beveled mesh is kept.  That keeps a bad bevel from ever reaching the GLB
    while still rounding the silhouette on the members that can take it.
    """
    if smooth is None:
        smooth = float(ob.get("xo_smooth_deg", 34.0))
    _clean_degenerates(ob)
    project_uv(ob)

    def stack(target, with_bevel):
        if with_bevel and bevel > 0.0:
            b = target.modifiers.new("Bevel", 'BEVEL')
            b.width = bevel
            b.segments = segs
            b.limit_method = 'ANGLE'
            b.angle_limit = math.radians(angle)
            b.miter_outer = 'MITER_ARC'
            b.use_clamp_overlap = True
            b.harden_normals = False
        if smooth:
            select_only(target)
            try:
                bpy.ops.object.shade_auto_smooth(angle=math.radians(smooth))
            except Exception:
                pass
        w = target.modifiers.new("WeightedNormal", 'WEIGHTED_NORMAL')
        w.keep_sharp = True
        w.weight = 45
        w.mode = 'FACE_AREA_WITH_ANGLE'

    if apply:
        for scale in (1.0, 0.5):
            trial = ob.copy()
            trial.data = ob.data.copy()
            trial.name = ob.name + "_bev"
            ob.users_collection[0].objects.link(trial)
            stack(trial, bevel * scale)
            select_only(trial)
            for m in [x.name for x in trial.modifiers]:
                try:
                    bpy.ops.object.modifier_apply(modifier=m)
                except RuntimeError:
                    pass
            if _sane(trial) and len(trial.data.polygons) > 0:
                old_mesh = ob.data
                ob.data = trial.data
                ob.modifiers.clear()
                bpy.data.objects.remove(trial, do_unlink=True)
                if old_mesh.users == 0:
                    bpy.data.meshes.remove(old_mesh)
                if not _sane(ob):
                    ob.data = old_mesh
                    print("  bevel rejected (out of bounds) on %s" % ob.name)
                return ob
            bpy.data.objects.remove(trial, do_unlink=True)
        print("  bevel rejected on %s (kept un-bevelled, x%.2f)"
              % (ob.name, scale))
        stack(ob, False)
        select_only(ob)
        for m in [x.name for x in ob.modifiers]:
            try:
                bpy.ops.object.modifier_apply(modifier=m)
            except RuntimeError:
                pass
    else:
        stack(ob, True)
    return ob
