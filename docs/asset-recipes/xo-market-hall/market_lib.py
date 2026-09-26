"""Authoring helpers for the XO desert market hall.

Conventions
-----------
* Z up, front facade faces -Y, origin at ground level / footprint centre.
* All mesh data is authored directly in world space (object transforms stay
  identity) so members can be joined by material without transform juggling.
* Every material gets a box-projected UV in *metres* (uv = local position
  projected on the dominant axis, times ``UV_SCALE``) so texel density is
  identical across every member that shares a material.
"""

from __future__ import annotations

import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

UV_SCALE = 0.5  # 1 UV unit == 2 m of surface

COLLECTIONS: dict[str, bpy.types.Collection] = {}


# ---------------------------------------------------------------- scene utils
def collection(name: str) -> bpy.types.Collection:
    if name not in COLLECTIONS:
        col = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(col)
        COLLECTIONS[name] = col
    return COLLECTIONS[name]


def new_object(name: str, verts, faces, mat, col="Architecture",
               smooth_angle: float | None = None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.validate(verbose=False)
    me.update()
    ob = bpy.data.objects.new(name, me)
    collection(col).objects.link(ob)
    if mat is not None:
        me.materials.append(mat)
    if smooth_angle is not None:
        ob["xo_smooth_angle"] = math.radians(smooth_angle)
    return ob


# ------------------------------------------------------------- mesh builders
def box(name, center, size, mat, rot_z=0.0, rot_y=0.0, rot_x=0.0, col="Architecture",
        smooth=32.0):
    """Axis-aligned (optionally rotated) box with clean quad topology."""
    cx, cy, cz = center
    sx, sy, sz = (s * 0.5 for s in size)
    corners = [
        (-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
        (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz),
    ]
    m = (Matrix.Translation((cx, cy, cz))
         @ Matrix.Rotation(rot_z, 4, 'Z')
         @ Matrix.Rotation(rot_y, 4, 'Y')
         @ Matrix.Rotation(rot_x, 4, 'X'))
    verts = [m @ Vector(c) for c in corners]
    faces = [
        (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
        (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
    ]
    return new_object(name, verts, faces, mat, col, smooth)


def strut(name, p0, p1, w, h, mat, col="Architecture", smooth=34.0):
    """A timber between two world points: long axis follows p0 -> p1."""
    a, b = Vector(p0), Vector(p1)
    d = b - a
    length = d.length
    x = d.normalized()
    up = Vector((0, 0, 1))
    if abs(x.dot(up)) > 0.995:
        up = Vector((0, 1, 0))
    y = up.cross(x).normalized()
    z = x.cross(y).normalized()
    rot = Matrix((x, y, z)).transposed().to_4x4()
    ob = box(name, (0, 0, 0), (length, w, h), mat, smooth=smooth)
    ob.data.transform(Matrix.Translation((a + b) * 0.5) @ rot)
    ob["xo_smooth_angle"] = math.radians(smooth)
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    collection(col).objects.link(ob)
    return ob


def panel(
name, width, height, thickness, holes, mat, col="Architecture",
          smooth=34.0, omit_soffit=()):
    """Authored wall panel with rectangular openings, all-quad topology.

    Local space: ``u`` in [0, width] -> +X, ``v`` in [0, height] -> +Z,
    front face at y = 0, solid occupies y in [0, thickness].

    The front and back faces are produced by a global (u, v) cut grid, so the
    result shares vertices across cell boundaries and contains no
    T-junctions.  Every opening gets a four-quad reveal (jambs, sill, soffit)
    running from the front face to its own ``depth``; openings listed in
    ``omit_soffit`` drop the soffit because an authored arch spandrel
    terminates there instead.
    """
    holes = [tuple(h) + (thickness,) * (5 - len(h)) for h in holes]
    ucuts = {0.0, width}
    vcuts = {0.0, height}
    for h in holes:
        ucuts.add(round(h[0], 6))
        ucuts.add(round(h[1], 6))
        vcuts.add(round(h[2], 6))
        vcuts.add(round(h[3], 6))
    U = sorted(ucuts)
    V = sorted(vcuts)

    verts: list[Vector] = []
    faces: list[tuple[int, ...]] = []
    cache: dict[tuple, int] = {}

    def vid(u, v, y):
        key = (round(u, 6), round(v, 6), round(y, 6))
        if key not in cache:
            cache[key] = len(verts)
            verts.append(Vector((u, y, v)))
        return cache[key]

    for side in (0, 1):
        y = side * thickness
        for i in range(len(U) - 1):
            ua, ub = U[i], U[i + 1]
            for j in range(len(V) - 1):
                va, vb = V[j], V[j + 1]
                mu, mv = (ua + ub) * 0.5, (va + vb) * 0.5
                if any(h[0] < mu < h[1] and h[2] < mv < h[3] for h in holes):
                    continue
                faces.append((vid(ua, va, y), vid(ub, va, y),
                              vid(ub, vb, y), vid(ua, vb, y)))

    def inside_span(lo, hi, axis):
        mid = (lo + hi) * 0.5
        if axis == 'u':
            return any(h[0] < mid < h[1] and h[2] <= 0.0 for h in holes)
        return any(h[2] < mid < h[3] and (h[0] <= 0.0 if axis == 'v0'
                                          else h[1] >= width) for h in holes)

    # outer rim
    for i in range(len(U) - 1):
        ua, ub = U[i], U[i + 1]
        if not inside_span(ua, ub, 'u'):
            faces.append((vid(ua, 0, 0), vid(ua, 0, thickness),
                          vid(ub, 0, thickness), vid(ub, 0, 0)))
        if not any(h[0] < (ua + ub) * 0.5 < h[1] and h[3] >= height for h in holes):
            faces.append((vid(ua, height, 0), vid(ub, height, 0),
                          vid(ub, height, thickness), vid(ua, height, thickness)))
    for j in range(len(V) - 1):
        va, vb = V[j], V[j + 1]
        if not any(h[2] < (va + vb) * 0.5 < h[3] and h[0] <= 0.0 for h in holes):
            faces.append((vid(0, va, 0), vid(0, va, thickness),
                          vid(0, vb, thickness), vid(0, vb, 0)))
        if not any(h[2] < (va + vb) * 0.5 < h[3] and h[1] >= width for h in holes):
            faces.append((vid(width, va, 0), vid(width, vb, 0),
                          vid(width, vb, thickness), vid(width, va, thickness)))

    # reveals
    for idx, h in enumerate(holes):
        u0, u1, v0, v1, d = h[0], h[1], h[2], h[3], h[4]
        faces.append((vid(u0, v0, 0), vid(u0, v0, d), vid(u0, v1, d), vid(u0, v1, 0)))
        faces.append((vid(u1, v0, 0), vid(u1, v1, 0), vid(u1, v1, d), vid(u1, v0, d)))
        faces.append((vid(u0, v0, 0), vid(u1, v0, 0), vid(u1, v0, d), vid(u0, v0, d)))
        if idx not in omit_soffit:
            faces.append((vid(u0, v1, 0), vid(u0, v1, d), vid(u1, v1, d), vid(u1, v1, 0)))
    return new_object(name, verts, faces, mat, col, smooth)


def panel_backplate(name, u0, u1, v0, v1, depth, thickness, mat,
                    col="Architecture", smooth=34.0):
    """Closing slab for a shallow (recessed) opening."""
    return box(name, ((u0 + u1) * 0.5, depth + 0.04, (v0 + v1) * 0.5),
               (u1 - u0, 0.08, v1 - v0), mat, col=col, smooth=smooth)



def arch_spandrel(name, u0, u1, spring, crown, thickness, mat, segments=9,
                  col="Architecture", y_front=0.0, y_back=None,
                  smooth=34.0, offset=0.0):
    """Plaster infill for the two corners left by a semicircular arch.

    The wall panel is cut as a plain rectangle up to ``crown``; this object
    closes the spandrels with an all-quad arch soffit that follows a true
    circular curve, and stays flush with the wall faces.
    """
    cu = (u0 + u1) * 0.5
    r = (u1 - u0) * 0.5
    y_back = thickness if y_back is None else y_back

    def top(u):
        du = min(r, abs(u - cu))
        return spring + math.sqrt(max(0.0, r * r - du * du)) + offset

    pts = []
    for side in (0, 1):
        a0 = u0 if side == 0 else cu
        a1 = cu if side == 0 else u1
        rng = [a0 + (a1 - a0) * i / segments for i in range(segments + 1)]
        pts.append(rng)
    full = pts[0] + pts[1][1:]

    verts: list[Vector] = []
    faces: list[tuple[int, ...]] = []
    cache: dict[tuple, int] = {}

    def vid(u, v, y):
        key = (round(u, 6), round(v, 6), round(y, 6))
        if key not in cache:
            cache[key] = len(verts)
            verts.append(Vector((u, y, v)))
        return cache[key]

    for y in (y_front, y_back):
        for i in range(segments):
            xa, xb = pts[0][i], pts[0][i + 1]
            ya, yb = top(xa), top(xb)
            faces.append((vid(xa, ya, y), vid(xb, yb, y), vid(xb, crown, y), vid(xa, crown, y)))
            xa, xb = pts[1][i], pts[1][i + 1]
            ya, yb = top(xa), top(xb)
            faces.append((vid(xa, ya, y), vid(xa, crown, y), vid(xb, crown, y), vid(xb, yb, y)))
    # arch soffit
    for i in range(len(full) - 1):
        xa, xb = full[i], full[i + 1]
        ya, yb = top(xa), top(xb)
        faces.append((vid(xa, ya, y_front), vid(xb, yb, y_front),
                      vid(xb, yb, y_back), vid(xa, ya, y_back)))
    return new_object(name, verts, faces, mat, col, smooth)


def arch_band(name, u0, u1, spring, thickness, width, mat, depth=0.12,
              y_face=0.0, segments=17, col="Architecture", smooth=30.0,
              offset=0.0):
    """Projecting voussoir ring following a semicircular arch."""
    cu = (u0 + u1) * 0.5
    r = (u1 - u0) * 0.5 + offset
    ang = [math.pi - math.pi * i / segments for i in range(segments + 1)]
    inner = [(cu + r * math.cos(a), spring + r * math.sin(a)) for a in ang]
    outer = [(cu + (r + width) * math.cos(a), spring + (r + width) * math.sin(a))
             for a in ang]
    verts: list[Vector] = []
    faces: list[tuple[int, ...]] = []

    def push(p):
        verts.append(Vector(p))
        return len(verts) - 1

    loops = {}
    for key, prof, y in (("ii", inner, y_face), ("oi", outer, y_face),
                         ("ib", inner, y_face - depth), ("ob", outer, y_face - depth)):
        loops[key] = [push((p[0], y, p[1])) for p in prof]
    n = segments + 1
    for i in range(segments):
        faces.append((loops["ii"][i], loops["ii"][i + 1], loops["ib"][i + 1], loops["ib"][i]))
        faces.append((loops["oi"][i], loops["ob"][i], loops["ob"][i + 1], loops["oi"][i + 1]))
        faces.append((loops["ib"][i], loops["ib"][i + 1], loops["ob"][i + 1], loops["ob"][i]))
        faces.append((loops["ii"][i], loops["oi"][i], loops["oi"][i + 1], loops["ii"][i + 1]))
    for i in (0, segments):
        faces.append((loops["ii"][i], loops["ib"][i], loops["ob"][i], loops["oi"][i]))
    return new_object(name, verts, faces, mat, col, smooth)


def lathe(name, profile, mat, segments=16, col="Props", smooth=50.0,
          rot_z=0.0, loc=(0, 0, 0), scale=(1, 1, 1), rib=0.0):
    """Surface of revolution from a (radius, z) profile; auto-capped.

    ``rib`` alternately pinches the radius, turning the body into a fluted
    column (saguaro cactus ribs, a fluted ceramic pot).
    """
    verts: list[Vector] = []
    faces: list[tuple[int, ...]] = []
    rings = []
    for r, z in profile:
        ring = []
        for s in range(segments):
            a = 2 * math.pi * s / segments
            rr = r * (1.0 - rib if s % 2 else 1.0)
            ring.append(len(verts))
            verts.append(Vector((rr * math.cos(a) * scale[0],
                                 rr * math.sin(a) * scale[1],
                                 z * scale[2])))
        rings.append(ring)
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for s in range(segments):
            t = (s + 1) % segments
            if profile[i][0] < 1e-6:
                faces.append((a[s], b[s], b[t]))
            elif profile[i + 1][0] < 1e-6:
                faces.append((a[s], a[t], b[t]))
            else:
                faces.append((a[s], a[t], b[t], b[s]))
    if profile[0][0] > 1e-6:
        faces.append(tuple(rings[0]))
    if profile[-1][0] > 1e-6:
        faces.append(tuple(reversed(rings[-1])))
    ob = new_object(name, verts, faces, mat, col, smooth)
    if rot_z or loc != (0, 0, 0):
        ob.matrix_world = (Matrix.Translation(loc) @ Matrix.Rotation(rot_z, 4, 'Z'))
    return ob


def sweep(name, path, radius, mat, segments=8, col="Props", smooth=60.0,
          caps=True, radii=None):
    """Sweep a circle along a polyline (ropes, chains, iron scrollwork)."""
    path = [Vector(p) for p in path]
    n = len(path)
    verts: list[Vector] = []
    faces: list[tuple[int, ...]] = []
    up = Vector((0, 0, 1))
    for i, p in enumerate(path):
        if i == 0:
            tan = (path[1] - path[0])
        elif i == n - 1:
            tan = (path[-1] - path[-2])
        else:
            tan = (path[i + 1] - path[i - 1])
        tan.normalize()
        ref = up if abs(tan.dot(up)) < 0.95 else Vector((1, 0, 0))
        nx = tan.cross(ref).normalized()
        ny = tan.cross(nx).normalized()
        r = radius if radii is None else radii[i]
        for s in range(segments):
            a = 2 * math.pi * s / segments
            verts.append(p + nx * (math.cos(a) * r) + ny * (math.sin(a) * r))
    for i in range(n - 1):
        a, b = i * segments, (i + 1) * segments
        for s in range(segments):
            t = (s + 1) % segments
            faces.append((a + s, a + t, b + t, b + s))
    if caps:
        faces.append(tuple(range(segments - 1, -1, -1)))
        base = (n - 1) * segments
        faces.append(tuple(range(base, base + segments)))
    return new_object(name, verts, faces, mat, col, smooth)


def grid_surface(name, nu, nv, fn, mat, col="Props", smooth=70.0, thick=0.0):
    """Subdivided quad surface from ``fn(i, j) -> (x, y, z)``.

    ``thick`` adds a Solidify modifier (used for canvas / cloth).
    """
    verts: list[Vector] = []
    for j in range(nv + 1):
        for i in range(nu + 1):
            verts.append(Vector(fn(i, j)))
    faces = []
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + 1, a + nu + 2, a + nu + 1))
    ob = new_object(name, verts, faces, mat, col, smooth)
    if thick:
        sol = ob.modifiers.new("Solidify", 'SOLIDIFY')
        sol.thickness = thick
        sol.offset = 0.0
    return ob


def bake(ob):
    """Push an object's transform into its mesh data and leave the transform
    identity, so every member of the build is stored the same way (world-space
    vertex coordinates, identity object matrix).  Without this, bpy.ops
    primitives keep their placement on the object matrix and any later
    `data.transform(...)` silently double-applies it."""
    bpy.context.view_layer.update()
    ob.data.transform(ob.matrix_world)
    ob.matrix_world = Matrix.Identity(4)
    return ob


def torus(name, center, major_r, minor_r, mat, major=16, minor=8, rot=(0, 0, 0),
          col="Props", smooth=60.0):
    bpy.ops.mesh.primitive_torus_add(
        major_segments=major, minor_segments=minor, location=center, rotation=rot,
        major_radius=major_r, minor_radius=minor_r)
    ob = bpy.context.object
    ob.name = name
    ob.data.name = name
    bake(ob)
    for c in ob.users_collection:
        c.objects.unlink(ob)
    collection(col).objects.link(ob)
    ob.data.materials.append(mat)
    ob["xo_smooth_angle"] = math.radians(smooth)
    return ob


def cylinder(name, center, radius, height, mat, verts_n=16, rot=(0, 0, 0),
             col="Props", smooth=40.0, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=verts_n, radius=radius, depth=height, location=center,
        rotation=rot, end_fill_type='NGON')
    ob = bpy.context.object
    ob.name = name
    ob.data.name = name
    ob.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bake(ob)
    for c in ob.users_collection:
        c.objects.unlink(ob)
    collection(col).objects.link(ob)
    ob.data.materials.append(mat)
    ob["xo_smooth_angle"] = math.radians(smooth)
    return ob


def cone(name, center, r1, r2, height, mat, verts_n=14, rot=(0, 0, 0),
         col="Props", smooth=40.0):
    bpy.ops.mesh.primitive_cone_add(
        vertices=verts_n, radius1=r1, radius2=r2, depth=height,
        location=center, rotation=rot, end_fill_type='NGON')
    ob = bpy.context.object
    ob.name = name
    ob.data.name = name
    bake(ob)
    for c in ob.users_collection:
        c.objects.unlink(ob)
    collection(col).objects.link(ob)
    ob.data.materials.append(mat)
    ob["xo_smooth_angle"] = math.radians(smooth)
    return ob


def join_meshes(name, objects, mat, col="Architecture"):
    """Merge members into one mesh, deduping coincident verts.

    Primitives created with bpy.ops carry their placement on the object
    transform, while box()/strut()/lathe()/grid_surface() bake world points
    into the mesh.  Both have to end up in the same space, so every member's
    world matrix is applied to its mesh and the object transform reset before
    the merge.
    """
    verts: list[Vector] = []
    faces: list[tuple[int, ...]] = []
    index: dict[tuple, int] = {}
    identity = Matrix.Identity(4)
    for ob in objects:
        if ob.matrix_world != identity:
            ob.data.transform(ob.matrix_world)
            ob.matrix_world = identity
        off = 0
        remap = []
        for v in ob.data.vertices:
            key = (round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5))
            if key not in index:
                index[key] = len(verts)
                verts.append(v.co.copy())
            remap.append(index[key])
        for p in ob.data.polygons:
            faces.append(tuple(remap[i] for i in p.vertices))
    for ob in objects:
        bpy.data.objects.remove(ob, do_unlink=True)
    return new_object(name, verts, faces, mat, col, 34.0)


# ------------------------------------------------------------------ uv + mods
def box_uv(ob, scale=UV_SCALE, offset=(0.0, 0.0)):
    """Box-project UVs from object-local coordinates (metres)."""
    me = ob.data
    if not me.polygons:
        return
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


def add_modifiers(ob, bevel=0.02, segments=2, smooth_angle=34.0,
                  weighted=True, clamp=True, angle_limit=30.0):
    if bevel > 0.0:
        b = ob.modifiers.new("Bevel", 'BEVEL')
        b.width = bevel
        b.segments = segments
        b.limit_method = 'ANGLE'
        b.angle_limit = math.radians(angle_limit)
        b.miter_outer = 'MITER_ARC'
        b.use_clamp_overlap = clamp
        b.harden_normals = False
    if smooth_angle:
        prev = bpy.context.view_layer.objects.active
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        try:
            bpy.ops.object.shade_auto_smooth(angle=math.radians(smooth_angle))
        except Exception:
            pass
        # guarantee the canonical order Bevel -> Smooth by Angle -> Weighted
        for _ in range(4):
            mods = [m.name for m in ob.modifiers]
            if "Smooth by Angle" in mods and "WeightedNormal" in mods:
                pass
            if "Smooth by Angle" in mods and mods.index("Smooth by Angle") > 1:
                bpy.ops.object.modifier_move_to_index(
                    modifier="Smooth by Angle", index=1)
            else:
                break
    if weighted:
        w = ob.modifiers.new("WeightedNormal", 'WEIGHTED_NORMAL')
        w.keep_sharp = True
        w.weight = 50
        w.mode = 'FACE_AREA_WITH_ANGLE'
    return ob


def apply_all_modifiers(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    for m in [m.name for m in ob.modifiers]:
        try:
            bpy.ops.object.modifier_apply(modifier=m)
        except RuntimeError:
            pass


def apply_modifier_types(ob, types):
    """Bake only the given modifier types (e.g. SOLIDIFY) so the later
    material-group merge cannot lose them."""
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    for m in [m.name for m in ob.modifiers if m.type in types]:
        try:
            bpy.ops.object.modifier_apply(modifier=m)
        except RuntimeError:
            pass


def finish(ob, bevel=0.02, segments=2, smooth_angle=None, uv_scale=UV_SCALE,
           apply=True):
    """UV + bevel + auto-smooth + weighted normals, then optionally apply."""
    if smooth_angle is None:
        smooth_angle = float(ob.get("xo_smooth_angle", 34.0))
    box_uv(ob, uv_scale)
    add_modifiers(ob, bevel=bevel, segments=segments, smooth_angle=smooth_angle)
    if apply:
        apply_all_modifiers(ob)
    return ob
