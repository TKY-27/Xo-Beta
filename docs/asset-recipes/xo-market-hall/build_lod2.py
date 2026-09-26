"""Author the XO market hall LOD2 -- a low-triangle silhouette-preserving swap.

Run:  blender -b --factory-startup --python src/build_lod2.py

LOD0  (export/market_hall.glb)        ~72 k tris   19 meshes   full detail
LOD2  (export/market_hall_lod2.glb)   3-5 k tris   ~19 meshes  this file

LOD2 is HAND AUTHORED, not a Decimate modifier.  Decimation destroys exactly
the things a distant silhouette depends on: the round-headed arch collapses
into a rectangle, the voussoir ring dissolves, the fascia merges into the
parapet, and the two canopy bays turn into one flat card.  Every part below is
re-authored from the same dimensions, with reduced tessellation (1-segment
bevels, coarse grids, no reveals deeper than 40 mm, no window mullions or
shutters, no ironwork, no donor mesh).

What is deliberately PRESERVED, because it is the read at 40 m:
  the arched entrance silhouette (spandrel + voussoir ring + lintel + jambs)
  the single dominant timber fascia, the low parapet and its thin coping
  the west gable canopy and the lower east mono-pitch bay
  the back-east lean-to with its mono-pitch roof and upstand
  the upper roof chamber with its cornice and coping
  the mudbrick base course and corner quoining
  the threshold and two entry steps
  the exterior stall, the crate stack and the roof water jars

What is dropped: window mullions, shutters, sills, grilles, every iron fitting,
the lanterns' glass, the hanging cloths, the sacks, the stool, the ladder, the
cactus, all beam-end rhythm, the pendant jars' profiles, and the donor lantern.
"""

from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import market_lib as L            # noqa: E402
import market_materials as MM     # noqa: E402
import build_market as B          # noqa: E402   (dimensions only)
import market_massing as MS       # noqa: E402   (dimension block only)

# ---------------------------------------------------------------- dimensions
W_OUT, D_OUT, T = B.W_OUT, B.D_OUT, B.T
W_IN, D_IN = B.W_IN, B.D_IN
PLINTH_H, PLINTH_OVER = B.PLINTH_H, B.PLINTH_OVER
Z_DECK, WALL_H = B.Z_DECK, B.WALL_H
FRONT_Y, BACK_Y, LEFT_X, RIGHT_X = B.FRONT_Y, B.BACK_Y, B.LEFT_X, B.RIGHT_X
DOOR_W, DOOR_SPRING, DOOR_CROWN = B.DOOR_W, B.DOOR_SPRING, B.DOOR_CROWN
DOOR_TOP = B.DOOR_TOP
VIGA_Z, VIGA_H, VIGA_OUT = B.VIGA_Z, B.VIGA_H, B.VIGA_OUT
PARA_H, PARA_T, COPE_H, COPE_OVER = B.PARA_H, B.PARA_T, B.COPE_H, B.COPE_OVER
BC_H, BC_P = 0.86, 0.032   # local to build_market's base_course()

LEAN_X0, LEAN_X1, LEAN_Y0, LEAN_Y1 = MS.LEAN_X0, MS.LEAN_X1, MS.LEAN_Y0, MS.LEAN_Y1
LEAN_TH, LEAN_LOW, LEAN_RISE = MS.LEAN_TH, MS.LEAN_LOW, MS.LEAN_RISE
LEAN_OS_X, LEAN_OS_N = MS.LEAN_OS_X, MS.LEAN_OS_N
LEAN_PITCH = MS.LEAN_PITCH
PENT_X, PENT_Y, PENT_W, PENT_D = MS.PENT_X, MS.PENT_Y, MS.PENT_W, MS.PENT_D
PENT_BASE, PENT_H, PENT_TH = MS.PENT_BASE, MS.PENT_H, MS.PENT_TH
PENT_UW, PENT_ULH = MS.PENT_UW, MS.PENT_ULH
# LOCALS in build_market's canopy builders -- mirrored here so LOD2 and LOD0
# cannot drift apart.  src/check_lods.py asserts these against the built LOD0.
AWN_K, AWN_AX = 0.56, -2.44
POST_Y = -4.02
SPAN = 1.95
RIDGE_Z = 3.46
FRONT_BEAM_TOP = 2.90
E_X0, E_X1 = 1.30, 2.95
E_POST_Y = -3.52
E_BACK_Z, E_FRONT_Z, E_BEAM_Z = 2.66, 2.30, 2.24

def DOOR_U(x):
    return x - LEFT_X - T


UV_TABLE = {
    "XO_Mudbrick": 1.15, "XO_Plaster": 0.55, "XO_Stone_Limestone": 1.50,
    "XO_Fabric_Rust": 0.40,
    "XO_Earth_Floor": 0.90, "XO_Wood": 0.85, "XO_Terracotta": 0.45,
    "XO_Fabric_Awning_Terracotta": 2.00, "XO_Fabric_Canvas": 0.40,
}
LEFT_XI, RIGHT_XI = LEFT_X + T, RIGHT_X - T             # -3.58, 3.58

# LOD2 cheats: 0.020 bevel = 1 segment, 0.0 = no modifier
BEVEL_TABLE = {
    "XO_Plaster": 0.020, "XO_Mudbrick": 0.016, "XO_Wood": 0.012,
    "XO_Stone_Limestone": 0.014, "XO_Earth_Floor": 0.0, "XO_Terracotta": 0.0, "XO_Fabric_Rust": 0.0,
    "XO_Fabric_Canvas": 0.0, "XO_Rope": 0.0,
}
SMOOTH_TABLE = {k: math.radians(v) for k, v in {
    "XO_Plaster": 30, "XO_Mudbrick": 30, "XO_Wood": 32, "XO_Stone_Limestone": 28,
    "XO_Earth_Floor": 34, "XO_Terracotta": 24, "XO_Fabric_Canvas": 70, "XO_Fabric_Rust": 70,
    "XO_Rope": 60}.items()}

PARTS = {}


def add(ob, mat, col="Shell", smooth=None):
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    PARTS[ob.name] = ob
    return ob


def gable(name, x0, x1, y0, y1, z0, z_peak, axis, mat):
    """Triangular gable prism.  axis='x': ridge runs along X (falls in Y)."""
    if axis == "x":
        v = [(x0, y0, z0), (x1, y0, z0), (x0, y1, z0), (x1, y1, z0),
             (x0, y0, z_peak), (x1, y0, z_peak)]
        f = [(0, 1, 3, 2), (0, 2, 4), (1, 5, 3), (0, 4, 5, 1), (2, 3, 5, 4)]
    else:
        v = [(x0, y0, z0), (x1, y0, z0), (x0, y1, z0), (x1, y1, z0),
             (x0, y0, z_peak), (x1, y0, z_peak)]
        f = [(0, 1, 3, 2), (0, 2, 4), (1, 5, 3), (0, 4, 5, 1), (2, 3, 5, 4)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], f)
    me.validate()
    ob = bpy.data.objects.new(name, me)
    L.collection("Shell").objects.link(ob)
    return add(ob, mat, "Shell")


def mtx(loc, rz=0.0):
    return Matrix.Translation(loc) @ Matrix.Rotation(rz, 4, 'Z')


# --------------------------------------------------------------------- shell
def shell(MAT):
    # plinth (4 boxes) + interior floor + roof deck slab
    for tag, loc, size in (
            ("p_f", (0, FRONT_Y - PLINTH_OVER / 2, PLINTH_H / 2),
             (W_OUT + 2 * PLINTH_OVER, PLINTH_OVER, PLINTH_H)),
            ("p_b", (0, BACK_Y + PLINTH_OVER / 2, PLINTH_H / 2),
             (W_OUT + 2 * PLINTH_OVER, PLINTH_OVER, PLINTH_H)),
            ("p_l", (LEFT_X - PLINTH_OVER / 2, 0, PLINTH_H / 2),
             (PLINTH_OVER, D_OUT + 2 * PLINTH_OVER, PLINTH_H)),
            ("p_r", (RIGHT_X + PLINTH_OVER / 2, 0, PLINTH_H / 2),
             (PLINTH_OVER, D_OUT + 2 * PLINTH_OVER, PLINTH_H))):
        add(L.box("plinth_" + tag, loc, size, MAT["Stone"], smooth=30), MAT["Stone"])
    add(L.box("floor", (0, 0, PLINTH_H + 0.03), (W_IN + 0.16, D_IN + 0.16, 0.06),
              MAT["Earth"], smooth=34), MAT["Earth"], "Interior")
    add(L.box("deck", (0, 0, Z_DECK - 0.05), (W_IN + 0.16, D_IN + 0.16, 0.10),
              MAT["Earth"], smooth=34), MAT["Earth"], "Roof")

    # four wall panels, real cut openings, no reveals deeper than the wall
    front = L.panel("w_front", W_IN, WALL_H, T,
                    [(DOOR_U(-DOOR_W / 2), DOOR_U(DOOR_W / 2), 0.0, DOOR_TOP),
                     (0.50, 1.60, 1.05, 2.05), (5.56, 6.66, 1.05, 2.05)],
                    MAT["Plaster"], omit_soffit=(0,))
    front.data.transform(mtx((LEFT_XI, FRONT_Y, PLINTH_H)))
    add(front, MAT["Plaster"], "Shell")

    # The rear service door is BOARDED shut in LOD0, so it must not be a hole here
    # either: cut it, then plank it over from the outside.
    back = L.panel("w_back", W_IN, WALL_H, T,
                   [(3.105, 4.055, 0.0, 2.10), (1.10, 2.10, 1.15, 2.10),
                    (5.06, 6.06, 1.15, 2.10)], MAT["Plaster"])
    back.data.transform(mtx((RIGHT_XI, BACK_Y, PLINTH_H), math.pi))
    add(back, MAT["Plaster"], "Shell")
    for k, (v0, v1) in enumerate(((0.0, 0.50), (0.54, 1.04), (1.08, 1.58),
                                  (1.62, 2.10))):
        pl = L.panel("b_plank%d" % k, 0.95, v1 - v0, 0.05, [], MAT["Wood"])
        pl.data.transform(mtx((0.475, BACK_Y + 0.02, PLINTH_H + v0), math.pi))
        add(pl, MAT["Wood"], "Shell")
    for k, u in enumerate((0.16, 0.76)):
        db = L.box("b_dbatten%d" % k, (0.475 - u, BACK_Y + 0.06,
                                       PLINTH_H + 1.05), (0.10, 0.05, 2.10),
                   MAT["Wood"], smooth=34)
        add(db, MAT["Wood"], "Shell")

    left = L.panel("w_left", D_OUT, WALL_H, T,
                   [(0.90, 2.00, 1.10, 2.10)], MAT["Plaster"])
    left.data.transform(mtx((LEFT_XI, FRONT_Y, PLINTH_H), math.radians(90)))
    add(left, MAT["Plaster"], "Shell")

    right = L.panel("w_right", D_OUT, WALL_H, T,
                    [(0.90, 2.00, 1.10, 2.10)], MAT["Plaster"])
    right.data.transform(mtx((RIGHT_XI, BACK_Y, PLINTH_H), math.radians(-90)))
    add(right, MAT["Plaster"], "Shell")

    # the arch: spandrel infill + a coarse voussoir ring, both on the real springing
    sp = L.arch_spandrel("arch_spandrel", DOOR_U(-DOOR_W / 2), DOOR_U(DOOR_W / 2),
                         DOOR_SPRING - PLINTH_H, DOOR_CROWN - PLINTH_H, T,
                         MAT["Plaster"], segments=9)
    sp.data.transform(mtx((LEFT_XI, FRONT_Y, PLINTH_H)))
    add(sp, MAT["Plaster"], "Shell")
    band = L.arch_band("arch_band", DOOR_U(-DOOR_W / 2), DOOR_U(DOOR_W / 2),
                       DOOR_SPRING - PLINTH_H, T, 0.24, MAT["Stone"],
                       depth=0.17, y_face=-0.17, segments=16, offset=-0.02)
    band.data.transform(mtx((LEFT_XI, FRONT_Y, PLINTH_H)))
    add(band, MAT["Stone"], "Shell")


def entrance(MAT):
    y = FRONT_Y
    add(L.box("lintel", (0, y - 0.13, DOOR_SPRING - 0.15), (2.62, 0.26, 0.28),
              MAT["Wood"], smooth=32), MAT["Wood"], "Openings")
    for sx in (-1, 1):
        add(L.box("jamb%s" % ("r" if sx > 0 else "l"),
                  (sx * 1.03, y - 0.12, PLINTH_H + 0.68), (0.26, 0.24, 1.36),
                  MAT["Wood"], smooth=32), MAT["Wood"], "Openings")
        add(L.box("jambcap%s" % ("r" if sx > 0 else "l"),
                  (sx * 1.03, y - 0.14, PLINTH_H + 1.40), (0.32, 0.28, 0.10),
                  MAT["Wood"], smooth=32), MAT["Wood"], "Openings")
        add(L.box("corbel%s" % ("r" if sx > 0 else "l"),
                  (sx * 1.16, y - 0.12, DOOR_SPRING - 0.49), (0.30, 0.26, 0.22),
                  MAT["Wood"], smooth=32), MAT["Wood"], "Openings")
    add(L.box("threshold", (0, y - 0.18, 0.35), (2.34, 0.54, 0.12),
              MAT["Stone"], smooth=30), MAT["Stone"], "Openings")
    add(L.box("step_up", (0, -3.02, 0.225), (2.94, 0.34, 0.15),
              MAT["Stone"], smooth=30), MAT["Stone"], "Openings")
    add(L.box("step_lo", (0, -3.37, 0.075), (3.24, 0.36, 0.15),
              MAT["Stone"], smooth=30), MAT["Stone"], "Openings")


def cornice(MAT):
    add(L.box("fascia_f", (0, FRONT_Y - VIGA_OUT / 2 + 0.02, VIGA_Z),
              (W_OUT + 0.34, VIGA_OUT + 0.06, VIGA_H), MAT["Wood"], smooth=32),
        MAT["Wood"], "Facade")
    add(L.box("fascia_b", (0, BACK_Y + VIGA_OUT / 2 - 0.02, VIGA_Z),
              (W_OUT + 0.34, VIGA_OUT + 0.06, VIGA_H), MAT["Wood"], smooth=32),
        MAT["Wood"], "Facade")
    for sx in (-1, 1):
        for i in range(2):
            y = -1.60 + i * 3.20
            add(L.box("viga%s%d" % ("l" if sx < 0 else "r", i),
                      (sx * (W_OUT / 2 + VIGA_OUT / 2 - 0.02), y, VIGA_Z),
                      (VIGA_OUT + 0.06, 0.19, VIGA_H), MAT["Wood"], smooth=32),
                MAT["Wood"], "Facade")
    for tag, loc, size, h in (
            ("f", (0, FRONT_Y - PARA_T / 2, Z_DECK + 0.14), (W_OUT, PARA_T, 0.14), 0.14),
            ("b", (0, BACK_Y + PARA_T / 2, Z_DECK + PARA_H / 2), (W_OUT, PARA_T, PARA_H), PARA_H),
            ("l", (LEFT_X - PARA_T / 2, 0, Z_DECK + PARA_H / 2), (PARA_T, D_OUT, PARA_H), PARA_H),
            ("r", (RIGHT_X + PARA_T / 2, 0, Z_DECK + PARA_H / 2), (PARA_T, D_OUT, PARA_H), PARA_H)):
        add(L.box("parapet_" + tag, loc, size, MAT["Mudbrick"], smooth=30),
            MAT["Mudbrick"], "Facade")
    for tag, loc, size in (
            ("f", (0, FRONT_Y - COPE_OVER, Z_DECK + 0.14 + 0.03), (W_OUT + 2 * COPE_OVER, PARA_T + 2 * COPE_OVER, COPE_H)),
            ("b", (0, BACK_Y + COPE_OVER, Z_DECK + PARA_H + COPE_H / 2), (W_OUT + 2 * COPE_OVER, PARA_T + 2 * COPE_OVER, COPE_H)),
            ("l", (LEFT_X - COPE_OVER, 0, Z_DECK + PARA_H + COPE_H / 2), (PARA_T + 2 * COPE_OVER, D_OUT, COPE_H)),
            ("r", (RIGHT_X + COPE_OVER, 0, Z_DECK + PARA_H + COPE_H / 2), (PARA_T + 2 * COPE_OVER, D_OUT, COPE_H))):
        add(L.box("coping_" + tag, loc, size, MAT["Stone"], smooth=30), MAT["Stone"], "Facade")
    # base course + 3 courses of quoining (1 block per corner per course)
    for tag, loc, size, rz in (
            ("f", (0, FRONT_Y - BC_P / 2, PLINTH_H + BC_H / 2), (W_OUT, BC_P, BC_H), 0.0),
            ("b", (0, BACK_Y + BC_P / 2, PLINTH_H + BC_H / 2), (W_OUT, BC_P, BC_H), 0.0),
            # NB: with rot_z the SIZE must already be in the rotated frame, i.e.
            # (length, thickness, height) -- giving (thickness, length, height)
            # double-rotates it and flings the band 2.5 m out past the wall.
            ("l", (LEFT_X - BC_P / 2, 0, PLINTH_H + BC_H / 2), (D_OUT, BC_P, BC_H), math.pi / 2),
            ("r", (RIGHT_X + BC_P / 2, 0, PLINTH_H + BC_H / 2), (D_OUT, BC_P, BC_H), math.pi / 2)):
        add(L.box("bc_" + tag, loc, size, MAT["Mudbrick"], rot_z=rz, smooth=30),
            MAT["Mudbrick"], "Facade")
    QH, QP = 0.235, 0.030
    for ci, cz in enumerate((PLINTH_H + BC_H + 0.14 + QH / 2 + ci * QH * 1.30
                             for ci in range(2))):
        for sx in (-1, 1):
            add(L.box("quoin_f%s%d" % ("r" if sx > 0 else "l", ci),
                      (sx * 3.54, FRONT_Y - QP, cz), (0.46, QP * 2, QH),
                      MAT["Mudbrick"], smooth=30), MAT["Mudbrick"], "Facade")
            add(L.box("quoin_s%s%d" % ("r" if sx > 0 else "l", ci),
                      (sx * 4.0 - QP, 1.80, cz), (QP * 2, 0.46, QH),
                      MAT["Mudbrick"], smooth=30), MAT["Mudbrick"], "Facade")


def lean_to(MAT):
    z0, z1 = LEAN_LOW, LEAN_LOW + LEAN_RISE
    # three plaster walls, butted to the hall
    add(L.box("lean_n", (LEAN_X0, LEAN_Y1 - LEAN_TH / 2, z0 / 2),
              (LEAN_X1 - LEAN_X0, LEAN_TH, z0), MAT["Plaster"], smooth=30), MAT["Plaster"])
    add(L.box("lean_e", (LEAN_X1 - LEAN_TH / 2, (LEAN_Y0 + LEAN_Y1) / 2, z0 / 2),
              (LEAN_TH, LEAN_Y1 - LEAN_Y0, z0), MAT["Plaster"], smooth=30), MAT["Plaster"])
    add(L.box("lean_w", (LEAN_X0 + LEAN_TH / 2, (LEAN_Y0 + LEAN_Y1) / 2, z0 / 2),
              (LEAN_TH, LEAN_Y1 - LEAN_Y0, z0), MAT["Plaster"], smooth=30), MAT["Plaster"])
    for tag, x0, x1, y0, y1, ax in (("e", LEAN_X1 - LEAN_TH, LEAN_X1, LEAN_Y0, LEAN_Y1, "y"),
                                    ("w", LEAN_X0, LEAN_X0 + LEAN_TH, LEAN_Y0, LEAN_Y1, "y")):
        g0, g1 = ((z0, z0 + LEAN_RISE) if tag == "e" else (z0, z0))
        gable("lean_gable_" + tag, x0, x1, y0, y1, g0, g1, "x", MAT["Plaster"])
    roof = L.box("lean_roof", (0, 0, 0), (LEAN_X1 - LEAN_X0 + 2 * LEAN_OS_X,
                                           LEAN_Y1 - LEAN_Y0 + LEAN_OS_N, 0.13),
                 MAT["Plaster"], smooth=30)
    cx, cy = (LEAN_X0 + LEAN_X1) / 2, (LEAN_Y0 + LEAN_Y1) / 2
    roof.data.transform(Matrix.Translation((cx, cy, (z0 + z1) / 2 - 0.05))
                        @ Matrix.Rotation(-LEAN_PITCH, 4, 'X'))
    add(roof, MAT["Plaster"])
    up = L.box("lean_upstand", (0, 0, 0), (LEAN_X1 - LEAN_X0 + 2 * LEAN_OS_X, 0.17, 0.16),
               MAT["Mudbrick"], smooth=30)
    up.data.transform(Matrix.Translation((cx, LEAN_Y1 + LEAN_OS_N - 0.10, z0 + 0.14))
                       @ Matrix.Rotation(-LEAN_PITCH, 4, 'X'))
    add(up, MAT["Mudbrick"])
    cop = L.box("lean_cope", (0, 0, 0), (LEAN_X1 - LEAN_X0 + 2 * LEAN_OS_X + 0.08,
                                          0.23, 0.06), MAT["Stone"], smooth=30)
    cop.data.transform(Matrix.Translation((cx, LEAN_Y1 + LEAN_OS_N - 0.10, z0 + 0.27))
                       @ Matrix.Rotation(-LEAN_PITCH, 4, 'X'))
    add(cop, MAT["Stone"])
    add(L.box("lean_base", ((LEAN_X0 + LEAN_X1) / 2, LEAN_Y1 - 0.02, 0.33),
              (LEAN_X1 - LEAN_X0, 0.04, 0.66), MAT["Mudbrick"], smooth=30), MAT["Mudbrick"])
    add(L.box("lean_door_dark", (2.07, LEAN_Y1 - 0.02, 0.66), (0.90, 0.30, 1.32),
              MAT["Earth"], smooth=30), MAT["Earth"], "Interior")
    add(L.box("lean_door", (2.07, LEAN_Y1 - 0.17, 0.66), (0.86, 0.06, 1.28),
              MAT["Wood"], smooth=32), MAT["Wood"], "Openings")
    add(L.box("lean_win_dark", (3.67, LEAN_Y1 - 0.02, 1.70), (0.70, 0.30, 0.70),
              MAT["Earth"], smooth=30), MAT["Earth"], "Interior")


def upper(MAT):
    x0, x1 = PENT_X - PENT_W / 2, PENT_X + PENT_W / 2
    y0, y1 = PENT_Y - PENT_D / 2, PENT_Y + PENT_D / 2
    z0 = Z_DECK + PENT_BASE          # top of the brick base band
    zc = z0 + PENT_ULH              # top of the upper storey = 5.20
    add(L.box("pent_base", (PENT_X, PENT_Y, Z_DECK + PENT_BASE / 2),
              (PENT_W, PENT_D, PENT_BASE), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], "Roof")
    add(L.box("pent_foot", (PENT_X, PENT_Y, Z_DECK + 0.06),
              (PENT_W + 0.26, PENT_D + 0.26, 0.12), MAT["Stone"], smooth=30),
        MAT["Stone"], "Roof")
    for tag, loc, size in (("s", (PENT_X, y0 + PENT_TH / 2, z0 + PENT_ULH / 2),
                            (PENT_UW, PENT_TH, PENT_ULH)),
                           ("n", (PENT_X, y1 - PENT_TH / 2, z0 + PENT_ULH / 2),
                            (PENT_UW, PENT_TH, PENT_ULH)),
                           ("e", (x1 - PENT_TH / 2, PENT_Y, z0 + PENT_ULH / 2),
                            (PENT_TH, PENT_D - 2 * PENT_TH, PENT_ULH)),
                           ("w", (x0 + PENT_TH / 2, PENT_Y, z0 + PENT_ULH / 2),
                            (PENT_TH, PENT_D - 2 * PENT_TH, PENT_ULH))):
        add(L.box("pent_" + tag, loc, size, MAT["Plaster"], smooth=30), MAT["Plaster"], "Roof")
    add(L.box("pent_dark", (PENT_X, PENT_Y, z0 + 0.46), (PENT_UW - 0.1, PENT_D - 0.1, 0.92),
              MAT["Earth"], smooth=30), MAT["Earth"], "Interior")
    add(L.box("pent_door_dark", (PENT_X + 0.07, y0 + 0.02, z0 + 0.40),
              (0.58, 0.20, 0.78), MAT["Earth"], smooth=30), MAT["Earth"], "Interior")
    add(L.box("pent_lintel", (PENT_X + 0.07, y0 + 0.10, z0 + 0.86), (0.94, 0.20, 0.20),
              MAT["Wood"], smooth=32), MAT["Wood"], "Roof")
    add(L.box("pent_cap", (PENT_X, PENT_Y, zc + 0.05),
              (PENT_W + 0.16, PENT_D + 0.16, 0.10), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], "Roof")
    add(L.box("pent_cope", (PENT_X, PENT_Y, zc + 0.13),
              (PENT_W + 0.28, PENT_D + 0.28, 0.06), MAT["Stone"], smooth=30),
        MAT["Stone"], "Roof")
    add(L.box("pent_cornice", (PENT_X, y0 - 0.10, zc - 0.10),
              (PENT_UW + 0.20, 0.22, 0.20), MAT["Wood"], smooth=32), MAT["Wood"], "Roof")


def canopies(MAT):
    # ---- west gabled bay, authored centred then narrowed + slid west, as LOD0
    for sx in (-1, 1):
        px = sx * 1.80
        objs = [(L.box("cpost%s" % sx, (px, POST_Y, 1.24), (0.17, 0.17, 2.48),
                       MAT["Wood"], smooth=32), "Wood"),
                (L.box("cpad%s" % sx, (px, POST_Y, 0.06), (0.34, 0.34, 0.12),
                       MAT["Stone"], smooth=30), "Stone"),
                (L.strut("cbrace%s" % sx, (px, POST_Y, 2.00),
                         (px - sx * 0.56, POST_Y, 2.80), 0.11, 0.11,
                         MAT["Wood"], smooth=34), "Wood")]
        m = (Matrix.Translation((AWN_AX, 0.0, 0.0))
             @ Matrix.Diagonal((AWN_K, 1.0, 1.0, 1.0)))
        for o, key in objs:
            o.data.transform(m)
            add(o, MAT[key], "Canopy")
    for o in (L.box("cbeam_f", (0, POST_Y, FRONT_BEAM_TOP - 0.10),
                    (2 * SPAN + 0.20, 0.19, 0.20), MAT["Wood"], smooth=32),
              L.box("cbeam_ridge", (0, -2.58, RIDGE_Z - 0.09), (0.24, 0.20, 0.18),
                    MAT["Wood"], smooth=32)):
        o.data.transform(Matrix.Translation((AWN_AX, 0.0, 0.0))
                         @ Matrix.Diagonal((AWN_K, 1.0, 1.0, 1.0)))
        add(o, MAT["Wood"], "Canopy")
    w_half = SPAN * AWN_K
    for j, tf in enumerate((0.0, 0.34, 0.68, 1.0)):
        y = -2.58 + (POST_Y + 2.58) * tf
        for sx2 in (-1, 1):
            r = L.strut("crafter%d%s" % (j, 'p' if sx2 > 0 else 'm'),
                        (AWN_AX, y, RIDGE_Z - 0.07),
                        (AWN_AX + sx2 * w_half, y, FRONT_BEAM_TOP - 0.07),
                        0.09, 0.10, MAT["Wood"], smooth=34)
            add(r, MAT["Wood"], "Canopy")
    for sx2 in (-1, 1):
        r = L.strut("crafter_ridge%s" % ('p' if sx2 > 0 else 'm'),
                    (AWN_AX, -2.58, RIDGE_Z - 0.07),
                    (AWN_AX, POST_Y, RIDGE_Z - 0.07), 0.10, 0.12,
                    MAT["Wood"], smooth=34)
        add(r, MAT["Wood"], "Canopy")

    wA = [(-SPAN + 2 * SPAN * i / 8.0) * AWN_K + AWN_AX for i in range(9)]
    wB = [-2.58 + (POST_Y + 2.58) * (j / 3.0) for j in range(4)]

    def fn_w(i, j):
        a, b = wA[i], wB[j]
        z = (RIDGE_Z - 0.03
             - (RIDGE_Z - FRONT_BEAM_TOP) * (abs(a - AWN_AX) / w_half))
        z -= 0.030 * math.sin(math.pi * (b + 2.58) / (POST_Y + 2.58))
        return (a, b, z)
    cw = L.grid_surface("canvas_w", 8, 3, fn_w, MAT["FabricAwning"],
                        col="Canopy", smooth=60, thick=0.014)
    add(cw, MAT["FabricAwning"], "Canopy")
    vA = [wA[i] for i in range(9)]

    val = L.grid_surface("valance_w", 8, 1,
                         lambda i, j: (vA[i], POST_Y + 0.06,
                                       FRONT_BEAM_TOP + 0.06 - (0.06 + 0.07 * (0.5 + 0.5 * math.cos(vA[i] * 3.0))) * j),
                         MAT["FabricCanvas"], col="Canopy", smooth=60, thick=0.012)
    add(val, MAT["FabricCanvas"], "Canopy")

    # ---- east mono-pitch bay
    eA = [E_X0 + (E_X1 - E_X0) * i / 6.0 for i in range(7)]
    eB = [-2.57 + (E_POST_Y + 2.57) * (j / 2.0) for j in range(3)]
    for i, px in enumerate((1.40, 2.85)):
        add(L.box("epost%d" % i, (px, E_POST_Y, E_BEAM_Z / 2), (0.15, 0.15, E_BEAM_Z),
                  MAT["Wood"], smooth=32), MAT["Wood"], "Canopy")
    add(L.box("ebeam", ((E_X0 + E_X1) / 2, E_POST_Y, E_BEAM_Z),
              (E_X1 - E_X0 + 0.30, 0.16, 0.18), MAT["Wood"], smooth=32), MAT["Wood"], "Canopy")
    add(L.box("eledger", ((E_X0 + E_X1) / 2, -2.57, E_BACK_Z - 0.09),
              (E_X1 - E_X0 + 0.30, 0.14, 0.16), MAT["Wood"], smooth=32), MAT["Wood"], "Canopy")
    for j, tf in enumerate((0.25, 0.6, 1.0)):
        y = -2.57 + (E_POST_Y + 2.57) * tf
        z = E_BACK_Z - (E_BACK_Z - E_FRONT_Z) * tf
        add(L.strut("erafter%d" % j, ((E_X0 + E_X1) / 2, -2.57, E_BACK_Z - 0.05),
                    ((E_X0 + E_X1) / 2, y, z - 0.02), 0.08, 0.10, MAT["Wood"],
                    smooth=34), MAT["Wood"], "Canopy")

    def fn_e(i, j):
        a, b = eA[i], eB[j]
        z = E_BACK_Z - (E_BACK_Z - E_FRONT_Z) * (b + 2.57) / (E_POST_Y + 2.57) - 0.03
        z -= 0.030 * math.sin(math.pi * j / 2.0)
        return (a, b, z)
    add(L.grid_surface("canvas_e", 6, 2, fn_e, MAT["FabricAwning"],
                      col="Canopy", smooth=60, thick=0.014),
        MAT["FabricAwning"], "Canopy")

    def fn_ev(i, j):
        s = 0.05 + 0.06 * (0.5 + 0.5 * math.cos(eA[i] * 3.4))
        return (eA[i], E_POST_Y + 0.06, E_FRONT_Z + 0.02 - s * j)
    add(L.grid_surface("valance_e", 6, 1, fn_ev, MAT["FabricCanvas"],
                      col="Canopy", smooth=60, thick=0.012), MAT["FabricCanvas"], "Canopy")


def props(MAT):
    # exterior stall + two vessels + crates
    sx, sy, sz = -2.30, -3.36, 0.0
    add(L.box("stall_top", (sx, sy, sz + 0.86), (1.24, 0.62, 0.08), MAT["Wood"],
              rot_z=math.radians(-8), smooth=32), MAT["Wood"], "Stall")
    add(L.box("stall_shelf", (sx, sy + 0.14, sz + 0.44), (1.10, 0.26, 0.05),
              MAT["Wood"], rot_z=math.radians(-8), smooth=32), MAT["Wood"], "Stall")
    for ax in (-1, 1):
        for ay in (-1, 1):
            add(L.box("stall_leg%d%d" % (ax, ay),
                      (sx + ax * 0.55, sy + ay * 0.25, sz + 0.42),
                      (0.09, 0.09, 0.84), MAT["Wood"], smooth=32), MAT["Wood"], "Stall")
    add(L.box("stall_apron", (sx, sy - 0.28, sz + 0.62), (1.16, 0.05, 0.42),
              MAT["Wood"], rot_z=math.radians(-8), smooth=32), MAT["Wood"], "Stall")
    for i, (dx, dy, dz, r) in enumerate(((-0.30, 0.06, 0.90, 0.115),
                                         (0.10, -0.02, 0.90, 0.090))):
        j = L.lathe("jar%d" % i,
                    [(0.0, 0.0), (r * 0.72, 0.0), (r, r * 1.1), (r * 0.66, r * 2.4),
                     (r * 0.52, r * 2.9), (r * 0.60, r * 3.05), (0.0, r * 3.05)],
                    MAT["Terracotta"], 8, "Stall", smooth=24)
        j.data.transform(Matrix.Translation((sx + dx, sy + dy, sz + dz))
                         @ Matrix.Rotation(math.radians(-8), 4, 'Z'))
        add(j, MAT["Terracotta"], "Stall")
    add(L.box("crate_a", (1.75, -3.05, 0.26), (0.48, 0.14, 0.52), MAT["Wood"],
              rot_z=math.radians(11), smooth=32), MAT["Wood"], "Stall")
    add(L.box("crate_b", (1.71, -3.02, 0.78), (0.43, 0.09, 0.26), MAT["Wood"],
              rot_z=math.radians(-4), smooth=32), MAT["Wood"], "Stall")
    # roof water jars
    for i, (jx, jy, s) in enumerate(((-3.24, -1.34, 1.0), (-2.40, -1.62, 0.72))):
        j = L.lathe("rjar%d" % i,
                    [(0.0, 0.0), (0.150, 0.0), (0.205, 0.16), (0.196, 0.50),
                     (0.130, 0.74), (0.105, 0.86), (0.122, 0.92), (0.0, 0.92)],
                    MAT["Terracotta"], 7, "Roof", smooth=24)
        j.data.transform(Matrix.Translation((jx, jy, Z_DECK)) @ Matrix.Diagonal(
            (s, s, s, 1.0)))
        add(j, MAT["Terracotta"], "Roof")
    # hanging sign board (reads as a market sign at distance)
    add(L.box("sign", (-2.30, POST_Y + 0.06, 2.40), (0.86, 0.05, 0.30),
              MAT["FabricRust"], smooth=32), MAT["FabricRust"], "Hardware")


# ------------------------------------------------------------------- pipeline
# greebles that gain nothing from a chamfer at 40 m but cost 44 triangles each
NOBEVEL = ("b_plank", "b_dbatten", "quoin_", "viga", "stall_leg", "crate_", "sign", "jambcap", "corbel",
           "pent_cornice", "cpad", "epad", "erafter", "crafter", "eplate",
           "lean_door", "lean_win_dark", "pent_dark", "pent_door_dark")


def merge_and_export(MAT):
    for c in ("Shell", "Facade", "Openings", "Canopy", "Hardware", "Interior",
              "Stall", "Site", "Roof"):
        L.collection(c)
    shell(MAT)
    entrance(MAT)
    cornice(MAT)
    lean_to(MAT)
    upper(MAT)
    canopies(MAT)
    props(MAT)
    name2key = {m.name: k for k, m in MAT.items()}
    by_mat = {}
    for name, ob in PARTS.items():
        mat_name = ob.data.materials[0].name
        bev = BEVEL_TABLE.get(mat_name, 0.0)
        if name.startswith(NOBEVEL):
            bev = 0.0
        # bevel PER PART, before the join: join_meshes drops modifiers, so a
        # single per-group bevel width could not exempt individual greebles.
        L.apply_modifier_types(ob, {"SOLIDIFY"})
        if bev > 0.0:
            L.add_modifiers(ob, bev, 1, SMOOTH_TABLE.get(mat_name, math.radians(30)),
                            False)
            L.apply_all_modifiers(ob)
        by_mat.setdefault(mat_name, []).append(ob)
    root = bpy.data.objects.new("XO_MarketHall", None)
    root.empty_display_type = 'PLAIN_AXES'
    bpy.context.scene.collection.objects.link(root)
    out_meshes = []
    for mat_name in sorted(by_mat):
        key = name2key[mat_name]
        merged = L.join_meshes("XO_" + key, by_mat[mat_name], MAT[key])
        bpy.context.scene.collection.objects.link(merged)
        # angle-based smoothing + weighted normals happen on the MERGED mesh so
        # the joins are smoothed across too
        L.add_modifiers(merged, 0.0, 1,
                        SMOOTH_TABLE.get(mat_name, math.radians(30)), True)
        L.apply_all_modifiers(merged)
        L.box_uv(merged, UV_TABLE.get(mat_name, L.UV_SCALE))
        merged.parent = root
        out_meshes.append(merged)
        for o in merged.data.polygons:
            o.use_smooth = False
        print("LOD2_GROUP %-16s parts=%3d verts=%6d faces=%6d"
              % (merged.name, len(by_mat[mat_name]),
                 len(merged.data.vertices), len(merged.data.polygons)))
    v = sum(len(o.data.vertices) for o in out_meshes)
    f = sum(len(o.data.polygons) for o in out_meshes)
    for o in out_meshes:
        o.data.calc_loop_triangles()
    t = sum(len(o.data.loop_triangles) for o in out_meshes)
    vs = [o.matrix_world @ vv.co for o in out_meshes for vv in o.data.vertices]
    lo = [round(min(q[i] for q in vs), 3) for i in range(3)]
    hi = [round(max(q[i] for q in vs), 3) for i in range(3)]
    root["xo_asset"] = "XO Market Hall"
    root["xo_lod"] = "2"
    root["xo_licence"] = "CC0 1.0 (all geometry authored in Blender)"
    root["xo_scale"] = "1.0 = metres; facade width 8.00 m, height 4.54 m"
    root["xo_faces"] = f
    root["xo_materials"] = len(out_meshes)
    print("LOD2 meshes=%d verts=%d faces=%d tris=%d" % (len(out_meshes), v, f, t))
    print("LOD2 bounds_min %s bounds_max %s" % (lo, hi))
    od = os.path.join(os.path.dirname(HERE), "export")
    os.makedirs(od, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(od, "market_hall_lod2.blend"))
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(od, "market_hall_lod2.glb"),
        export_format='GLB', export_apply=True, export_yup=True,
        export_extras=True, export_cameras=False, export_lights=False)
    print("EXPORTED", os.path.join(od, "market_hall_lod2.glb"),
          os.path.getsize(os.path.join(od, "market_hall_lod2.glb")))


if __name__ == "__main__":
    # reset FIRST, then build materials: a later read_homefile invalidates
    # every Material datablock reference we are holding.
    bpy.ops.wm.read_homefile(use_empty=True)
    merge_and_export(MM.build_all())
