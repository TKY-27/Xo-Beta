"""Author the XO desert market hall (7-9 m modular market building).

Run:  blender -b --factory-startup --python src/build_market.py

Everything below is authored from scratch in metric world space: thick
plaster/mudbrick wall panels with true cut openings, a real arched entrance
with plaster spandrels and a projecting voussoir ring, a timber lintel/jamb
frame, parapet + coping + projected beam-ends, recessed windows with frames,
mullions and hinged shutters, a gabled canvas canopy on posts, hanging
lanterns on wrought-iron brackets, a hanging sign, thresholds, steps, and two
market stalls with authored ceramic vessels, crates and a leaning ladder.

Set XO_KEEP_MODULAR=1 to keep every member as a separate object with live
modifiers (saved as market_hall_modular.blend) instead of joining by material.
"""

from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import market_lib as L  # noqa: E402
import market_materials as MM  # noqa: E402

# ---------------------------------------------------------------- dimensions
W_OUT = 8.00            # outer wall face to wall face, X (-4.00 .. 4.00)
D_OUT = 5.00            # outer wall face to wall face, Y (-2.50 .. 2.50)
T = 0.42                # wall thickness
W_IN = W_OUT - 2 * T    # 7.16
D_IN = D_OUT - 2 * T    # 4.16
PLINTH_H = 0.30
PLINTH_OVER = 0.35      # plinth oversail beyond the wall face
PLINTH_Y = 2.50 + PLINTH_OVER
PLINTH_X = 4.00 + PLINTH_OVER
Z_DECK = 3.70           # top of wall / roof deck level
WALL_H = Z_DECK - PLINTH_H   # 3.40

FRONT_Y = -2.50
BACK_Y = 2.50
LEFT_X = -4.00
RIGHT_X = 4.00

DOOR_W = 1.80
DOOR_SPRING = 1.95      # world z of the arch springing
DOOR_CROWN = 2.85       # world z of the arch crown (== rect cut top)
DOOR_TOP = DOOR_CROWN - PLINTH_H   # 2.55 in wall-local v

# Pass 2 (silhouette): the parapet stack was reading as four horizontal bands
# in 0.6 m of wall.  The rule now is ONE dominant element per elevation -- a
# deep timber fascia on the long walls, a thin coping above a low parapet, and
# nothing else.  Discrete beam-ends are kept only on the two short walls, where
# they are seen in profile and read correctly.
VIGA_Z = 3.40           # beam-end centre
VIGA_H = 0.30
VIGA_OUT = 0.40
PARA_H = 0.30
PARA_T = 0.28
COPE_H = 0.06
COPE_OVER = 0.07       # coping oversail per side (was 0.12)

COLLECTIONS = ("Shell", "Facade", "Openings", "Canopy", "Hardware",
               "Interior", "Stall", "Site", "Donor")

# ------------------------------------------------------------------ helpers
def place(ob, matrix: Matrix):
    ob.data.transform(matrix)
    ob.data.update()
    return ob


def M(loc, rot_z=0.0):
    return Matrix.Translation(loc) @ Matrix.Rotation(rot_z, 4, 'Z')


def member(ob, mat, bevel=0.02, segments=2, smooth=None, uv_scale=L.UV_SCALE,
           col=None):
    """Tag a member for the final material-grouped pass."""
    ob["xo_mat"] = mat
    ob["xo_bevel"] = bevel
    ob["xo_seg"] = segments
    ob["xo_uv"] = uv_scale
    if smooth is not None:
        ob["xo_smooth"] = math.radians(smooth)
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    if col:
        for c in list(ob.users_collection):
            c.objects.unlink(ob)
        L.collection(col).objects.link(ob)
    return ob



def door_u(x):
    """World x -> front-wall local u."""
    return x - LEFT_X - T


def back_u(x):
    """World x -> BACK-wall local u.

    The back panel is placed with a 180 deg Z rotation, so its local u runs the
    other way.  Using door_u() here put every back-wall opening outside the
    panel: the windows and vents never cut, and the "service door" hole punched
    a notch in the back-left corner instead of opening a doorway.
    """
    return (RIGHT_X - T) - x


def back_hole(x0, x1, v0, v1):
    """World-x span -> an ascending (u0, u1, v0, v1) hole for the back panel.

    back_u() DECREASES as world x increases, so passing x0 < x1 straight through
    would hand L.panel an inverted (u0 > u1) rectangle, which it silently
    ignores -- that is why the back windows and vents were solid for several
    iterations while every other wall was correct.
    """
    return (back_u(x1), back_u(x0), v0, v1)


# ============================================================== 1. the shell
def build_shell(MAT):
    objs = {}

    # --- battered plinth: two stacked courses --------------------------------
    objs["plinth_lower"] = member(
        L.box("plinth_lower", (0, 0, 0.07), (2 * PLINTH_X + 0.20, 2 * PLINTH_Y + 0.20, 0.14),
              MAT["Mudbrick"], smooth=30), MAT["Mudbrick"], 0.035, 2)
    objs["plinth_upper"] = member(
        L.box("plinth_upper", (0, 0, 0.22), (2 * PLINTH_X, 2 * PLINTH_Y, 0.16),
              MAT["Mudbrick"], smooth=30), MAT["Mudbrick"], 0.03, 2)

    # --- four wall panels, butted so no faces are coplanar -------------------
    # front (-Y) with the hero arched entrance
    front_holes = [
        # Rect cut to the arch CROWN with no soffit; arch_spandrel() then closes
        # the two corners left by the semicircle, so the void is a true
        # round-headed opening: rectangle to the springing, half-circle above.
        (door_u(-DOOR_W / 2), door_u(DOOR_W / 2), 0.0, DOOR_TOP),           # 0
        (door_u(-3.08), door_u(-1.98), 1.05, 2.05),                          # 1
        (door_u(1.98), door_u(3.08), 1.05, 2.05),                            # 2
        (door_u(-2.78), door_u(-2.28), 2.42, 2.62),                          # 3
        (door_u(2.28), door_u(2.78), 2.42, 2.62),                            # 4
    ]
    w = L.panel("wall_front", W_IN, WALL_H, T, front_holes, MAT["Plaster"],
                omit_soffit=(0,))
    place(w, M((LEFT_X + T, FRONT_Y, PLINTH_H)))
    objs["wall_front"] = member(w, MAT["Plaster"], 0.028, 2)

    # back (+Y).  No doorway is cut here on purpose: the rear service door is
    # BOARDED shut (see build_openings), which is both believable for a market
    # hall after trading hours and stops a bar of daylight appearing dead
    # centre in the arched entrance sightline.
    back_holes = [
        back_hole(-2.48, -1.58, 1.15, 2.10),                                 # 0 window
        back_hole(1.58, 2.48, 1.15, 2.10),                                   # 1 window
        back_hole(-3.18, -2.68, 2.55, 2.75),                                  # 2 vent
        back_hole(2.68, 3.18, 2.55, 2.75),                                    # 3 vent
    ]
    b = L.panel("wall_back", W_IN, WALL_H, T, back_holes, MAT["Plaster"])
    place(b, M((RIGHT_X - T, BACK_Y, PLINTH_H), math.pi))
    objs["wall_back"] = member(b, MAT["Plaster"], 0.028, 2)

    # left (-X): a window, a shallow recessed niche, a vent
    left_holes = [
        (0.90, 2.00, 1.10, 2.10),                                           # 0
        (2.40, 3.20, 0.85, 1.70, 0.18),                                     # 1 niche
        (0.30, 0.80, 2.45, 2.65),                                           # 2
    ]
    lf = L.panel("wall_left", D_OUT, WALL_H, T, left_holes, MAT["Plaster"],
                 omit_soffit=())
    place(lf, M((LEFT_X + T, FRONT_Y, PLINTH_H), math.radians(90)))
    objs["wall_left"] = member(lf, MAT["Plaster"], 0.028, 2)

    # right (+X)
    right_holes = [
        (1.30, 2.40, 1.10, 2.10),                                           # 0
        (3.40, 4.20, 1.55, 2.25),                                           # 1
        (0.40, 0.90, 2.45, 2.65),                                           # 2
    ]
    rt = L.panel("wall_right", D_OUT, WALL_H, T, right_holes, MAT["Plaster"])
    place(rt, M((RIGHT_X - T, BACK_Y, PLINTH_H), math.radians(-90)))
    objs["wall_right"] = member(rt, MAT["Plaster"], 0.028, 2)

    # --- arched entrance: plaster spandrels + projecting voussoir ring --------
    sp = L.arch_spandrel("arch_spandrel", door_u(-DOOR_W / 2), door_u(DOOR_W / 2),
                         DOOR_SPRING - PLINTH_H, DOOR_TOP, T, MAT["Plaster"],
                         segments=10)
    place(sp, M((LEFT_X + T, FRONT_Y, PLINTH_H)))
    objs["arch_spandrel"] = member(sp, MAT["Plaster"], 0.028, 2)

    # a pale limestone voussoir ring so the round head reads against the plaster
    vb = L.arch_band("arch_voussoirs", door_u(-DOOR_W / 2), door_u(DOOR_W / 2),
                     DOOR_SPRING - PLINTH_H, T, 0.24, MAT["Stone"],
                     depth=0.17, y_face=-0.17, segments=20, offset=-0.02)
    place(vb, M((LEFT_X + T, FRONT_Y, PLINTH_H)))
    objs["arch_voussoirs"] = member(vb, MAT["Stone"], 0.020, 2, smooth=26)

    # --- recessed niche on the left wall -------------------------------------
    # panel-local v: hole 0.85..1.70, arch springs at 1.30, apex 1.70 = hole top.
    # left panel mapping: local (u, t) -> world (LEFT_X - t, FRONT_Y + u), so
    # u 0.90..1.70 is world y -1.60..-0.80 and the 0.18 recess is world
    # x -4.00..-3.82.  The niche was previously mirrored onto the front face,
    # which left the jar floating 2.5 m outside the building.
    nsp = L.arch_spandrel("niche_spandrel", 2.40, 3.20, 1.30, 1.70, 0.18,
                          MAT["Plaster"], segments=7)
    place(nsp, M((LEFT_X + T, FRONT_Y, PLINTH_H), math.radians(90)))
    objs["niche_spandrel"] = member(nsp, MAT["Plaster"], 0.022, 2)
    objs["niche_back"] = member(
        L.panel_backplate("niche_back", 2.40, 3.20, 0.85, 1.70,
                          0.18, T, MAT["Plaster"]), MAT["Plaster"], 0.015, 1)
    place(objs["niche_back"], M((LEFT_X + T, FRONT_Y, PLINTH_H), math.radians(90)))
    objs["niche_tray"] = member(
        L.box("niche_tray", (0, 0, 0), (0.86, 0.24, 0.09), MAT["Stone"]),
        MAT["Stone"], 0.012, 1)
    place(objs["niche_tray"], M((-3.88, 0.30, PLINTH_H + 0.895),
                                math.radians(90)))
    jar = L.lathe("niche_jar", [(0.0, 0.0), (0.075, 0.0), (0.105, 0.05), (0.115, 0.13),
                                (0.082, 0.21), (0.058, 0.235), (0.070, 0.255),
                                (0.066, 0.268), (0.0, 0.268)], MAT["Terracotta"],
                 segments=14, col="Stall")
    place(jar, M((-3.88, 0.30, PLINTH_H + 0.94), math.radians(90)))
    objs["niche_jar"] = member(jar, MAT["Terracotta"], 0.006, 1, smooth=45)

    # --- interior floor, ceiling, ring beam, column / beam frame -------------
    objs["floor"] = member(
        L.box("floor", (0, 0, PLINTH_H - 0.03), (W_IN + 0.16, D_IN + 0.16, 0.06),
              MAT["Earth"]),
        MAT["Earth"], 0.01, 1, smooth=25)
    objs["ceiling"] = member(
        L.box("ceiling", (0, 0, Z_DECK - 0.05), (W_IN + 0.16, D_IN + 0.16, 0.10),
              MAT["Earth"]),
        MAT["Earth"], 0.01, 1, smooth=25)

    for i, x in enumerate((-2.60, 2.60)):
        objs[f"col{i}"] = member(
            L.box(f"col{i}", (x, 0.0, (PLINTH_H + Z_DECK) / 2),
                  (0.22, 0.22, Z_DECK - PLINTH_H), MAT["Wood"], smooth=34),
            MAT["Wood"], 0.018, 2)
        objs[f"colbase{i}"] = member(
            L.box(f"colbase{i}", (x, 0.0, PLINTH_H + 0.07), (0.36, 0.36, 0.14),
                  MAT["Stone"], smooth=30), MAT["Stone"], 0.014, 1)
        objs[f"colcap{i}"] = member(
            L.box(f"colcap{i}", (x, 0.0, Z_DECK - 0.18), (0.40, 0.40, 0.16),
                  MAT["Wood"], smooth=30), MAT["Wood"], 0.016, 1)
    for i, y in enumerate((-1.30, 0.0, 1.30)):
        objs[f"beam{i}"] = member(
            L.box(f"beam{i}", (0.0, y, Z_DECK - 0.21), (W_IN, 0.17, 0.22),
                  MAT["Wood"], smooth=34), MAT["Wood"], 0.016, 2)
    return objs


# ================================================== 2. parapet / roof silhouette
def build_roof(MAT):
    objs = {}

    # continuous timber ring plate under the parapet
    for tag, cx, cy, sx, sy in (
            ("plate_f", 0.0, FRONT_Y - 0.05, 2 * RIGHT_X + 0.10, 0.10),
            ("plate_b", 0.0, BACK_Y + 0.05, 2 * RIGHT_X + 0.10, 0.10),
            ("plate_l", LEFT_X - 0.05, 0.0, 0.10, 2 * BACK_Y, ),
            ("plate_r", RIGHT_X + 0.05, 0.0, 0.10, 2 * BACK_Y)):
        objs[tag] = member(L.box(tag, (cx, cy, VIGA_Z + 0.10), (sx, sy, 0.10),
                                 MAT["Wood"], smooth=30), MAT["Wood"], 0.012, 1)

    # projected beam-ends (viga) along three facades
    # The front gets ONE continuous timber cornice band: nine discrete blocks
    # read as a picket fence across the facade. Back and left keep discrete
    # joist ends, where they read correctly in profile from the side.
    objs["viga_front"] = member(
        L.box("viga_front", (0.0, FRONT_Y - VIGA_OUT / 2 + 0.02, VIGA_Z),
              (2 * RIGHT_X + 0.34, VIGA_OUT + 0.06, VIGA_H), MAT["Wood"],
              smooth=30), MAT["Wood"], 0.018, 1)
    # back is a long wall seen head-on: one continuous band, same as the front
    objs["viga_back"] = member(
        L.box("viga_back", (0.0, BACK_Y + VIGA_OUT / 2 - 0.02, VIGA_Z),
              (2 * RIGHT_X + 0.34, VIGA_OUT + 0.06, VIGA_H), MAT["Wood"],
              smooth=30), MAT["Wood"], 0.018, 1)
    # the two short walls keep discrete joist ends, where they read in profile
    step = 0.94
    m = int((2 * BACK_Y - 0.7) / step)
    for i in range(m + 1):
        y = -BACK_Y + 0.35 + i * step
        for tag, xc, sx, sy in (("l", LEFT_X - VIGA_OUT / 2 + 0.02,
                                  VIGA_OUT + 0.06, 0.19),
                                 ("r", RIGHT_X + VIGA_OUT / 2 - 0.02,
                                  VIGA_OUT + 0.06, 0.19)):
            objs[f"viga_{tag}{i}"] = member(
                L.box(f"viga_{tag}", (xc, y, VIGA_Z), (sx, sy, VIGA_H),
                      MAT["Wood"], smooth=30), MAT["Wood"], 0.016, 1)

    # parapets: tall on three sides, low on the entrance side
    def parapet(tag, cx, cy, sx, sy, h, z0=Z_DECK):
        o = L.box(tag, (cx, cy, z0 + h / 2), (sx, sy, h), MAT["Mudbrick"], smooth=30)
        c = L.box(tag + "_cope", (cx, cy, z0 + h + COPE_H / 2),
                  (sx + 2 * COPE_OVER, sy + 2 * COPE_OVER, COPE_H),
                  MAT["Stone"], smooth=30)
        o["xo_mat"] = MAT["Mudbrick"]
        c["xo_mat"] = MAT["Stone"]
        o["xo_bevel"] = 0.022
        o["xo_seg"] = 2
        o["xo_uv"] = L.UV_SCALE
        c["xo_bevel"] = 0.012
        c["xo_seg"] = 1
        c["xo_uv"] = L.UV_SCALE
        c.data.materials.clear()
        c.data.materials.append(MAT["Stone"])
        return o, c

    o, c = parapet("para_b", 0.0, BACK_Y - PARA_T / 2, 2 * RIGHT_X, PARA_T, PARA_H)
    objs["para_b"], objs["cope_b"] = o, c
    o, c = parapet("para_l", LEFT_X + PARA_T / 2, 0.0, PARA_T, 2 * BACK_Y - 2 * PARA_T, PARA_H)
    objs["para_l"], objs["cope_l"] = o, c
    o, c = parapet("para_r", RIGHT_X - PARA_T / 2, 0.0, PARA_T, 2 * BACK_Y - 2 * PARA_T, PARA_H)
    objs["para_r"], objs["cope_r"] = o, c
    para_f_h = 0.14   # front: a low upstand tucked behind the fascia
    o, c = parapet("para_f", 0.0, FRONT_Y + PARA_T / 2, 2 * RIGHT_X, PARA_T, para_f_h)
    objs["para_f"], objs["cope_f"] = o, c

    # Rooftop: a lived-in flat deck rather than battlements. The water jar and
    # stacked grain sacks give the silhouette something to say.
    JAR_TALL = [(0.00, 0.00), (0.20, 0.00), (0.26, 0.06), (0.33, 0.26), (0.355, 0.52),
                (0.315, 0.76), (0.235, 0.92), (0.165, 0.99), (0.175, 1.04), (0.150, 1.06),
                (0.00, 1.06)]
    # the upper chamber now owns x -3.30..-1.60, y 0.20..1.70, so the water
    # jars live in the free south-west corner of the deck instead
    for i, (rx, ry, rz, rs) in enumerate(((-3.00, -1.60, 0.0, 1.0),
                                          (-2.20, -1.80, 0.5, 0.72),
                                          (-3.10, -0.60, 2.1, 0.58))):
        objs[f"roof_jar{i}"] = member(
            L.lathe(f"roof_jar{i}", JAR_TALL, MAT["Terracotta"], 20, col="Roof",
                    smooth=30, rot_z=rz, loc=(rx, ry, Z_DECK + 0.02), scale=(rs, rs, rs)),
            MAT["Terracotta"], 0.006, 1, smooth=30)
    for i, (mx, my, ma) in enumerate(((0.62, 1.62, 0.10), (0.62, 1.62, -0.07))):
        objs[f"roof_mat{i}"] = member(
            L.cylinder(f"roof_mat{i}", (0, 0, 0), 0.105, 1.72, MAT["FabricCanvas"],
                       20, col="Roof", smooth=34),
            MAT["FabricCanvas"], 0.010, 1, smooth=34)
        # lay the roll flat: Rx tips the cylinder axis from Z to Y, then Rz
        # spins it in plan. Standing upright it read as a length of pipe.
        place(objs[f"roof_mat{i}"],
              M((mx, my, Z_DECK + 0.115 + i * 0.20))
              @ Matrix.Rotation(ma, 4, 'Z')
              @ Matrix.Rotation(math.radians(90), 4, 'X'))

    return objs


# ==================================================== 3. facade articulation
def build_facade(MAT):
    objs = {}

    # exposed mudbrick pilasters flanking the entrance, standing 0.14 proud of
    # the lime-plastered wall.  Doing the vertical members in brick while the
    # panels stay plastered is the authentic construction AND it is what stops
    # the whole facade collapsing into one undifferentiated beige value.
    for i, sx in enumerate((-1.45, 1.45)):
        objs[f"pilaster{i}"] = member(
            L.box(f"pilaster{i}", (sx, FRONT_Y - 0.02, PLINTH_H + WALL_H / 2),
                  (0.55, 0.32, WALL_H), MAT["Mudbrick"], smooth=30),
            MAT["Mudbrick"], 0.024, 3)
        objs[f"pilaster_cap{i}"] = member(
            L.box(f"pilaster_cap{i}", (sx, FRONT_Y - 0.045, PLINTH_H + WALL_H - 0.14),
                  (0.66, 0.37, 0.16), MAT["Mudbrick"], smooth=30),
            MAT["Mudbrick"], 0.018, 2)

    # mudbrick base course: a 0.86 m band of exposed brick around the whole
    # building, stopping just short of the entrance threshold
    BC_H, BC_P = 0.86, 0.032
    bc_z = PLINTH_H + BC_H / 2 - 0.01
    # the front run is SPLIT either side of the entrance: a single 8 m band
    # walled the arched doorway in from z 0.30 to 1.16
    _hw = DOOR_W / 2
    for tag, (ln, cxx, cyy, rz) in {
        "bc_f_w": (RIGHT_X - _hw, -(RIGHT_X + _hw) / 2, FRONT_Y - BC_P / 2, 0.0),
        "bc_f_e": (RIGHT_X - _hw, (RIGHT_X + _hw) / 2, FRONT_Y - BC_P / 2, 0.0),
        "bc_b": (8.00, 0.0, BACK_Y + BC_P / 2, 0.0),
        "bc_l": (5.00, -RIGHT_X - BC_P / 2, 0.0, math.pi / 2),
        "bc_r": (5.00, RIGHT_X + BC_P / 2, 0.0, math.pi / 2),
    }.items():
        objs[tag] = member(
            L.box(tag, (cxx, cyy, bc_z), (ln, BC_P, BC_H), MAT["Mudbrick"],
                  rot_z=rz, smooth=30), MAT["Mudbrick"], 0.016, 2)
        objs[tag + "_cap"] = member(
            L.box(tag + "_cap", (cxx, cyy, PLINTH_H + BC_H - 0.01),
                  (ln, BC_P + 0.026, 0.055), MAT["Mudbrick"], rot_z=rz, smooth=30),
            MAT["Mudbrick"], 0.012, 1)

    # mudbrick string course just under the ring plate, three facades
    for tag, cx, cy, sx, sy in (
            ("band_f", 0.0, FRONT_Y - 0.065, 2 * RIGHT_X, 0.13),
            ("band_b", 0.0, BACK_Y + 0.065, 2 * RIGHT_X, 0.13),
            ("band_l", LEFT_X - 0.065, 0.0, 0.13, 2 * BACK_Y),
            ("band_r", RIGHT_X + 0.065, 0.0, 0.13, 2 * BACK_Y)):
        objs[tag] = member(L.box(tag, (cx, cy, 3.22), (sx, sy, 0.20), MAT["Mudbrick"],
                                 smooth=30), MAT["Mudbrick"], 0.016, 2)

    # alternating mudbrick corner quoins
    courses, QH = 8, 0.235
    for ci, (cx, cy) in enumerate(((-RIGHT_X, FRONT_Y), (RIGHT_X, FRONT_Y),
                                   (-RIGHT_X, BACK_Y), (RIGHT_X, BACK_Y))):
        for k in range(courses):
            z = PLINTH_H + 0.14 + k * 0.235
            # every course is exactly one step tall so the blocks touch
            # vertically; the old 0.03 gap read as a stack of loose bricks
            if k % 2 == 0:
                objs[f"quoin{ci}_{k}a"] = member(
                    L.box(f"quoin{ci}_{k}a", (cx, cy - 0.030, z), (0.46, 0.075, QH),
                          MAT["Mudbrick"], smooth=30), MAT["Mudbrick"], 0.010, 1)
                objs[f"quoin{ci}_{k}b"] = member(
                    L.box(f"quoin{ci}_{k}b", (cx - 0.030, cy, z), (0.075, 0.46, QH),
                          MAT["Mudbrick"], smooth=30), MAT["Mudbrick"], 0.010, 1)
            else:
                for s in (-1, 1):
                    objs[f"quoin{ci}_{k}q{'p' if s > 0 else 'm'}"] = member(
                        L.box(f"quoin{ci}_{k}q", (cx + s * 0.115, cy - 0.030, z),
                              (0.23, 0.075, QH), MAT["Mudbrick"], smooth=30),
                        MAT["Mudbrick"], 0.010, 1)
                    objs[f"quoin{ci}_{k}y{'p' if s > 0 else 'm'}"] = member(
                        L.box(f"quoin{ci}_{k}y", (cx - 0.030, cy + s * 0.115, z),
                              (0.075, 0.23, QH), MAT["Mudbrick"], smooth=30),
                        MAT["Mudbrick"], 0.010, 1)

    # --- timber lintel / jamb frame at the entrance -------------------------
    objs["lintel"] = member(
        L.box("lintel", (0.0, FRONT_Y - 0.13, DOOR_SPRING - 0.15), (2.60, 0.24, 0.28),
              MAT["Wood"], smooth=32), MAT["Wood"], 0.022, 2)
    for sx in (-1, 1):
        peg = L.cylinder(f"lintel_peg{'r' if sx > 0 else 'l'}", (0, 0, 0), 0.026, 0.10,
                         MAT["Iron"], verts_n=12, smooth=30,
                         rot=(math.radians(90), 0, 0))
        peg.data.transform(Matrix.Translation(
            (sx * 1.16, FRONT_Y - 0.245, DOOR_SPRING - 0.15)))
        objs[peg.name] = member(peg, MAT["Iron"], 0.0, 1, smooth=40)
    for i, sx in enumerate((-1.16, 1.16)):
        objs[f"corbel{i}"] = member(
            L.box(f"corbel{i}", (sx, FRONT_Y - 0.17, DOOR_SPRING - 0.49),
                  (0.24, 0.34, 0.34), MAT["Wood"], smooth=32), MAT["Wood"], 0.018, 2)
    for i, sx in enumerate((-1, 1)):
        objs[f"jamb{i}"] = member(
            L.box(f"jamb{i}", (sx * (DOOR_W / 2 + 0.13), FRONT_Y - 0.12,
                               PLINTH_H + 0.68), (0.26, 0.24, 1.36), MAT["Wood"],
                  smooth=32), MAT["Wood"], 0.018, 2)
        objs[f"jambcap{i}"] = member(
            L.box(f"jambcap{i}", (sx * (DOOR_W / 2 + 0.13), FRONT_Y - 0.12,
                                  PLINTH_H + 1.40), (0.32, 0.30, 0.10), MAT["Wood"],
                  smooth=32), MAT["Wood"], 0.014, 1)

    # stone threshold + two steps
    objs["threshold"] = member(
        L.box("threshold", (0.0, -2.68, PLINTH_H + 0.05), (2.34, 0.54, 0.12),
              MAT["Stone"], smooth=30), MAT["Stone"], 0.018, 2)
    objs["step_up"] = member(
        L.box("step_up", (0.0, -3.02, 0.225), (2.94, 0.34, 0.15), MAT["Stone"],
              smooth=30), MAT["Stone"], 0.02, 2)
    objs["step_lo"] = member(
        L.box("step_lo", (0.0, -3.37, 0.075), (3.24, 0.36, 0.15), MAT["Stone"],
              smooth=30), MAT["Stone"], 0.02, 2)
    return objs



# ==================================== 4. window frames, mullions, shutters
def window_unit(name, anchor, z0, width, height, normal, MAT,
                shutters=True, open_deg=32.0, sill=True, col="Openings"):
    """Frame + mullion + two shutter leaves for one opening.

    ``anchor`` is a world (x, y) point ON the outer wall face, at the centre of
    the opening horizontally.  ``normal`` is the outward direction of the wall:
    (0,-1,0) front, (0,1,0) back, (-1,0,0) left, (1,0,0) right.

    Local frame: +X runs along the wall, +Y points OUT of the wall, so the
    placement depth ``d`` is a signed outward offset from the wall face and
    negative values sit inside the reveal.
    """
    objs = []
    nx, ny = normal[0], normal[1]
    yaw = math.atan2(-nx, ny)          # local +Y == outward normal
    half = width / 2
    base = Matrix.Translation((anchor[0], anchor[1], 0.0)) @ Matrix.Rotation(yaw, 4, 'Z')

    def mk(tag, u, v, d, su, sv, sd, rz=0.0, bevel=0.012, seg=2, mat=None,
           smooth=34.0):
        mat = mat or MAT["Wood"]
        ob = L.box(tag, (0, 0, 0), (su, sd, sv), mat, smooth=smooth)
        ob.data.transform(base @ Matrix.Translation((u, d, z0 + v))
                          @ Matrix.Rotation(rz, 4, 'Z'))
        member(ob, mat, bevel, seg, smooth=smooth, col=col)
        objs.append(ob)
        return ob

    out = {}
    out["head"] = mk("head", 0.0, height + 0.055, -0.05, width + 0.20, 0.11, 0.22,
                     mat=MAT["Wood"], bevel=0.014)
    out["jamb_l"] = mk("jamb_l", -half - 0.055, height / 2, -0.05, 0.11, height, 0.22,
                       mat=MAT["Wood"])
    out["jamb_r"] = mk("jamb_r", half + 0.055, height / 2, -0.05, 0.11, height, 0.22,
                       mat=MAT["Wood"])
    out["mull_v"] = mk("mull_v", 0.0, height / 2, -0.07, 0.055, height, 0.12,
                       mat=MAT["Wood"], bevel=0.008, seg=1)
    out["mull_h"] = mk("mull_h", 0.0, height * 0.58, -0.07, width, 0.05, 0.12,
                       mat=MAT["Wood"], bevel=0.008, seg=1)
    if sill:
        out["sill"] = mk("sill", 0.0, -0.05, 0.02, width + 0.30, 0.10, 0.38,
                         mat=MAT["Stone"], bevel=0.014)
    if shutters:
        for side in (-1, 1):
            ang2 = math.radians(open_deg) * side
            hinge_u = side * (half + 0.02)
            hinge_base = base @ Matrix.Translation((hinge_u, 0.11, z0 + height / 2))
            leaf = L.box(f"shutter_{'l' if side < 0 else 'r'}", (0, 0, 0),
                         (width * 0.5, 0.045, height * 0.96), MAT["Wood"], smooth=34)
            leaf.data.transform(hinge_base @ Matrix.Rotation(ang2, 4, 'Z')
                                @ Matrix.Translation((-side * width * 0.25, 0.0, 0.0)))
            for s in (-1, 1):
                batten = L.box("batten", (0, 0, 0), (0.07, 0.03, height * 0.9),
                               MAT["Wood"], smooth=34)
                batten.data.transform(
                    hinge_base @ Matrix.Rotation(ang2, 4, 'Z')
                    @ Matrix.Translation((-side * width * 0.12 + s * width * 0.18,
                                          -0.032, 0.0)))
                member(batten, MAT["Wood"], 0.006, 1, smooth=34, col=col)
                objs.append(batten)
            member(leaf, MAT["Wood"], 0.010, 2, smooth=34, col=col)
            objs.append(leaf)
            out[f"shutter_{side}"] = leaf
            for hz in (0.22, 0.78):
                hinge = L.cylinder(f"hinge", (0, 0, 0), 0.018, 0.10, MAT["Iron"],
                                   verts_n=8, smooth=40)
                hinge.data.transform(hinge_base
                                     @ Matrix.Translation((0, 0, (hz - 0.5) * height)))
                member(hinge, MAT["Iron"], 0.004, 1, smooth=40, col=col)
                objs.append(hinge)
    return objs


def build_openings(MAT):
    objs = []
    # front facade
    objs += window_unit("win_front_w", (-2.53, FRONT_Y), 1.35, 1.10, 1.00, (0, -1, 0), MAT)
    objs += window_unit("win_front_e", (2.53, FRONT_Y), 1.35, 1.10, 1.00, (0, -1, 0), MAT)
    # back facade
    objs += window_unit("win_back_w", (2.03, BACK_Y), 1.45, 0.90, 0.95, (0, 1, 0), MAT,
                        open_deg=18.0)
    objs += window_unit("win_back_e", (-2.03, BACK_Y), 1.45, 0.90, 0.95, (0, 1, 0), MAT,
                        open_deg=0.0, shutters=False)
    # side facades: anchor x is the wall face, y runs along the wall
    objs += window_unit("win_left", (LEFT_X, -1.05), 1.40, 1.10, 1.00, (-1, 0, 0),
                        MAT, open_deg=40.0)
    objs += window_unit("win_right_a", (RIGHT_X, -0.60), 1.40, 1.10, 1.00, (1, 0, 0),
                        MAT, open_deg=26.0)
    objs += window_unit("win_right_b", (RIGHT_X, 1.80), 1.85, 0.80, 0.70, (1, 0, 0),
                        MAT, open_deg=0.0, shutters=False, sill=True)

    # iron vent grilles (3 bars per vent), recessed inside the reveal
    def grille(tag, anchor, z0, w, h, normal):
        yaw = math.atan2(-normal[0], normal[1])
        base = Matrix.Translation((anchor[0], anchor[1], 0.0)) @ Matrix.Rotation(yaw, 4, 'Z')
        out = []
        for k in range(3):
            z = z0 + h * (0.20 + 0.30 * k)
            b = L.box(tag, (0, 0, 0), (w, 0.03, 0.032), MAT["Iron"], smooth=40)
            b.data.transform(base @ Matrix.Translation((0.0, -0.12, z)))
            member(b, MAT["Iron"], 0.004, 1, smooth=40, col="Openings")
            out.append(b)
        return out

    for x in (-2.53, 2.53):
        objs += grille("grille_f", (x, FRONT_Y), 2.72, 0.44, 0.20, (0, -1, 0))
    objs += grille("grille_b_l", (-2.93, BACK_Y), 2.85, 0.44, 0.20, (0, 1, 0))
    objs += grille("grille_b_r", (2.93, BACK_Y), 2.85, 0.44, 0.20, (0, 1, 0))
    objs += grille("grille_l", (LEFT_X, -1.85), 2.75, 0.44, 0.20, (-1, 0, 0))
    objs += grille("grille_r", (RIGHT_X, -2.05), 2.75, 0.44, 0.20, (1, 0, 0))

    # back service door, BOARDED shut: timber lintel, jambs, two leaves,
    # ledges and a ring handle, all applied to a solid wall face
    objs.append(member(
        L.box("svc_lintel", (0.0, BACK_Y + 0.11, PLINTH_H + 2.20), (1.30, 0.22, 0.18),
              MAT["Wood"], smooth=32), MAT["Wood"], 0.016, 2))
    for i, sx in enumerate((-1, 1)):
        objs.append(member(
            L.box(f"svc_jamb{i}", (sx * 0.545, BACK_Y + 0.10, PLINTH_H + 1.03),
                  (0.14, 0.20, 2.06), MAT["Wood"], smooth=32), MAT["Wood"], 0.014, 2))
        leaf = L.box(f"svc_leaf{i}", (sx * 0.225, BACK_Y + 0.09, PLINTH_H + 1.00),
                     (0.44, 0.05, 1.98), MAT["Wood"], smooth=34)
        objs.append(member(leaf, MAT["Wood"], 0.010, 2, smooth=34))
        for k in range(3):
            b = L.box("svc_batten", (0, 0, 0), (0.44, 0.03, 0.06), MAT["Wood"],
                      smooth=34)
            b.data.transform(Matrix.Translation((sx * 0.225, BACK_Y + 0.065,
                                                 PLINTH_H + 0.28 + k * 0.72)))
            objs.append(member(b, MAT["Wood"], 0.005, 1, smooth=34))
        ring = L.torus("svc_ring", (sx * 0.06, BACK_Y + 0.04, PLINTH_H + 1.05),
                       0.055, 0.012, MAT["Iron"], major=12, minor=6,
                       rot=(math.radians(90), 0, 0))
        objs.append(member(ring, MAT["Iron"], 0.0, 1, smooth=40))
    return objs



# ================================================== 5. gabled canvas canopy
def build_canopy(MAT):
    objs = {}
    SPAN = 1.95          # half span at the front beam
    RIDGE_Z = 3.46
    FRONT_BEAM_TOP = 2.90
    RISE = RIDGE_Z - FRONT_BEAM_TOP
    Y_BACK = -2.50
    POST_Y = -4.02
    Y_FRONT = POST_Y

    # posts + stone pads + knee braces
    for i, sx in enumerate((-1, 1)):
        px = sx * 1.80
        objs[f"cpost{i}"] = member(
            L.box(f"cpost{i}", (px, POST_Y, 1.24), (0.17, 0.17, 2.48),
                  MAT["Wood"], smooth=34), MAT["Wood"], 0.016, 2)
        objs[f"cpad{i}"] = member(
            L.box(f"cpad{i}", (px, POST_Y, 0.06), (0.34, 0.34, 0.12), MAT["Stone"],
                  smooth=30), MAT["Stone"], 0.014, 1)
        objs[f"cbrace{i}"] = member(
            L.strut(f"cbrace{i}", (px, POST_Y, 2.00), (px - sx * 0.56, POST_Y, 2.80),
                    0.11, 0.11, MAT["Wood"], smooth=34), MAT["Wood"], 0.012, 1)
        objs[f"ctie{i}"] = member(
            L.strut(f"ctie{i}", (px, POST_Y, 2.40), (px - sx * 0.30, POST_Y, 2.80),
                    0.07, 0.10, MAT["Wood"], smooth=34), MAT["Wood"], 0.008, 1)

    # front beam + ridge plate on the wall
    objs["cbeam_f"] = member(
        L.box("cbeam_f", (0.0, POST_Y, FRONT_BEAM_TOP - 0.10), (2 * SPAN + 0.20, 0.19, 0.20),
              MAT["Wood"], smooth=34), MAT["Wood"], 0.016, 2)
    objs["cbeam_ridge"] = member(
        L.box("cbeam_ridge", (0.0, -2.58, RIDGE_Z - 0.09), (0.24, 0.20, 0.18),
              MAT["Wood"], smooth=34), MAT["Wood"], 0.014, 1)

    # rafters: ridge -> front beam, four lines
    for j, tf in enumerate((0.0, 1 / 3, 2 / 3, 1.0)):
        y = Y_BACK + (Y_FRONT - Y_BACK) * tf
        if j == 0:
            y = -2.58
        for i, sx in enumerate((-1, 1)):
            objs[f"rafter{j}{i}"] = member(
                L.strut(f"rafter{j}{i}", (0.0, y, RIDGE_Z - 0.03),
                        (sx * SPAN, y, FRONT_BEAM_TOP - 0.03), 0.11, 0.15,
                        MAT["Wood"], smooth=34), MAT["Wood"], 0.012, 1)

    # purlin ties
    for i, sx in enumerate((-1, 1)):
        px = sx * SPAN * 0.5
        pz = RIDGE_Z - RISE * 0.5 - 0.16
        objs[f"purlin{i}"] = member(
            L.box(f"purlin{i}", (px, (Y_BACK + POST_Y) / 2, pz),
                  (0.10, abs(POST_Y - Y_BACK) + 0.34, 0.12), MAT["Wood"], smooth=34),
            MAT["Wood"], 0.012, 1)

    # --- canvas with real sag between rafters and purlins -------------------
    A = [-1.0, -0.94, -0.88, -0.82, -0.75, -0.68, -0.62, -0.56, -0.50, -0.44,
         -0.38, -0.32, -0.26, -0.20, -0.14, -0.08, -0.03, 0.0,
         0.03, 0.08, 0.14, 0.20, 0.26, 0.32, 0.38, 0.44, 0.50, 0.56, 0.62,
         0.68, 0.75, 0.82, 0.88, 0.94, 1.0]
    B = [0.0, 1 / 9, 2 / 9, 1 / 3, 4 / 9, 5 / 9, 2 / 3, 7 / 9, 8 / 9, 1.0]
    SAGA = 0.042
    SAGB = 0.026
    HALF = SPAN + 0.05

    def fn(i, j):
        a = A[i]
        b = B[j]
        x = a * HALF
        y = Y_BACK + (Y_FRONT - Y_BACK) * b
        z = RIDGE_Z - abs(a) * RISE
        t = min(abs(a) / 0.5, 1.0) if abs(a) <= 0.5 else (abs(a) - 0.5) / 0.5
        z -= SAGA * math.sin(math.pi * t)
        tb = 0.0 if b >= 1.0 else (b * 3.0) % 1.0
        z -= SAGB * math.sin(math.pi * tb)
        z -= 0.10 * b * b
        return (x, y, z)

    canvas = L.grid_surface("canopy_canvas", len(A) - 1, len(B) - 1, fn,
                            MAT["FabricAwning"], col="Canopy", thick=0.014)
    objs["canopy_canvas"] = member(canvas, MAT["FabricAwning"], 0.0, 1, smooth=70,
                                   col="Canopy")

    # scalloped valance hanging off the leading edge
    NU = 34

    def vfn(i, j):
        a = -1.0 + 2.0 * i / NU
        x = a * HALF
        top = RIDGE_Z - abs(a) * RISE - 0.10
        scallop = 0.5 - 0.5 * math.cos(2 * math.pi * 5 * (i / NU))
        drop = 0.06 + 0.07 * scallop
        return (x, Y_FRONT - 0.02 + 0.008 * math.sin(i * 2.1), top - drop * j)

    # its own plain canvas material: the striped awning map put a sawtooth of
    # high-frequency bands across a 0.13 m tall strip
    val = L.grid_surface("canopy_valance", NU, 2, vfn, MAT["FabricCanvas"],
                         col="Canopy", thick=0.012)
    objs["canopy_valance"] = member(val, MAT["FabricCanvas"], 0.0, 1, smooth=70,
                                    col="Canopy")

    # rope ties + guy lines
    for i, sx in enumerate((-1, 1)):
        r = L.sweep("canopy_tie", [(sx * SPAN, Y_FRONT - 0.02, RIDGE_Z - RISE - 0.14),
                                   (sx * (SPAN - 0.06), Y_FRONT - 0.10, 2.58),
                                   (sx * 1.80, POST_Y - 0.09, 2.02)],
                    0.018, MAT["Rope"], segments=7, col="Canopy")
        objs[f"canopy_tie{i}"] = member(r, MAT["Rope"], 0.0, 1, smooth=60,
                                        col="Canopy")
        r2 = L.sweep("canopy_guy", [(sx * (SPAN - 0.02), Y_FRONT, RIDGE_Z - RISE - 0.04),
                                    (sx * 1.86, POST_Y - 0.10, 2.10)],
                     0.014, MAT["Rope"], segments=6, col="Canopy")
        objs[f"canopy_guy{i}"] = member(r2, MAT["Rope"], 0.0, 1, smooth=60,
                                        col="Canopy")

    # --- hanging sign board --------------------------------------------------
    # Offset to the left post so it does not hide the arch head from the front.
    # NOTE: build_hardware runs AFTER build_canopy, so the sign does NOT get the
    # AWN_K/AWN_AX canopy transform.  It used to carry a "pre-shift" value tuned
    # for that transform and ended up at x=-1.72 -- hard against the arch's left
    # jamb instead of under the gable.  World coordinates, no pre-shift.
    # Framed plank sign, not a bare painted slab: a painted field inside a
    # timber frame with two battens.  At 1.10 x 0.56 with no internal detail
    # it read as a flat salmon billboard parked over the west window.
    SX, sign_z = -2.30, 2.40
    SIGN_Y = POST_Y - 0.14
    objs["sign_field"] = member(
        L.box("sign_field", (SX, SIGN_Y, sign_z), (0.86, 0.05, 0.30),
              MAT["FabricRust"], smooth=34), MAT["FabricRust"], 0.012, 2,
        smooth=34, col="Canopy")
    for tg, dz in (("sign_rail_t", 0.1925), ("sign_rail_b", -0.1925)):
        objs[tg] = member(
            L.box(tg, (SX, SIGN_Y, sign_z + dz), (0.94, 0.06, 0.085),
                  MAT["Wood"], smooth=34), MAT["Wood"], 0.008, 1, smooth=34,
            col="Canopy")
    for tg, dx in (("sign_stile_l", -0.4275), ("sign_stile_r", 0.4275)):
        objs[tg] = member(
            L.box(tg, (SX + dx, SIGN_Y, sign_z), (0.085, 0.06, 0.30),
                  MAT["Wood"], smooth=34), MAT["Wood"], 0.008, 1, smooth=34,
            col="Canopy")
    for i, dx in enumerate((-0.15, 0.15)):
        bt = L.box(f"sign_seam{i}", (SX + dx, SIGN_Y, sign_z), (0.030, 0.075, 0.30),
                   MAT["Wood"], smooth=34)
        objs[f"sign_seam{i}"] = member(bt, MAT["Wood"], 0.005, 1, smooth=34,
                                       col="Canopy")
    for i, dx in enumerate((-0.42, 0.42)):
        r = L.sweep("sign_rope", [(SX + dx, SIGN_Y, sign_z + 0.24),
                                  (SX + dx * 0.94, SIGN_Y, sign_z + 0.44),
                                  (SX + dx * 0.84, POST_Y + 0.02, 2.86)],
                    0.014, MAT["Rope"], segments=6, col="Canopy")
        objs[f"sign_rope{i}"] = member(r, MAT["Rope"], 0.0, 1, smooth=60,
                                       col="Canopy")
        for k, zz in enumerate((sign_z + 0.24, 2.88)):
            ring = L.torus("sign_ring", (SX + dx * 0.9, SIGN_Y, zz), 0.028,
                           0.007, MAT["Iron"], major=10, minor=5,
                           rot=(math.radians(90), 0, 0))
            objs[f"sign_ring{i}{k}"] = member(ring, MAT["Iron"], 0.0, 1, smooth=40,
                                              col="Canopy")
    # The canopy was authored centred on x=0, which put its gable, valance and
    # sign straight across the arched entrance.  Pass 2: shrink to 56% and slide
    # it further west.  The sight line from a front-WEST camera at eye height to
    # the arch crown (0, -2.50, 2.85) passes through x = -1.09 at the canopy
    # plane; the east edge of the beam is now at -1.292, giving 0.20 m of
    # clearance, and the east post at -1.432 gives 0.26 m.
    AWN_K, AWN_AX = 0.56, -2.44
    awn_m = (Matrix.Translation((AWN_AX, 0.0, 0.0))
             @ Matrix.Diagonal((AWN_K, 1.0, 1.0, 1.0)))
    for ob in objs.values():
        ob.data.transform(awn_m)
    return objs



# ------------------------------------------- 5b. secondary east canopy bay
# A deliberately SMALLER, MONO-PITCH bay on the east side of the entrance.
# Two jobs: (1) it keeps the arched entrance readable from every gameplay angle
# because nothing now sits in front of the door at all, and (2) the pitch
# contrasts with the west bay's gable, so the frontage stops being mirror
# symmetric without a single mirrored prop.  It spans x 0.99..3.41; the door
# jamb is at 0.77, so there is 0.09 m of clear air between them.
# Pass-2 review rejected the first east bay: at 2.30 m wide x 1.05 m deep x
# 2.42 m tall it read as a SECOND full gabled bay, so the front elevation became
# a symmetric twin-bay veranda and the asymmetry was lost.  It is now a small
# mono-pitch entrance hood: 1.65 m wide, 0.95 m deep, 2.24 m to the beam, and
# wholly east of the door jamb at x=0.77.  Hierarchy against the west gable
# (2.74 x 1.52 x 2.90) is now unambiguous.
E_X0, E_X1 = 1.30, 2.95
E_POST_Y = -3.52
E_BACK_Z = 2.66          # high edge, ledgered against the wall
E_FRONT_Z = 2.30         # low edge, on the front beam
E_BEAM_Z = 2.24


def build_canopy_east(MAT):
    objs = {}
    xc = (E_X0 + E_X1) / 2

    for i, px in enumerate((1.40, 2.85)):
        objs[f"epost{i}"] = member(
            L.box(f"epost{i}", (px, E_POST_Y, E_BEAM_Z / 2), (0.15, 0.15, E_BEAM_Z),
                  MAT["Wood"], smooth=34), MAT["Wood"], 0.015, 2)
        objs[f"epad{i}"] = member(
            L.box(f"epad{i}", (px, E_POST_Y, 0.06), (0.30, 0.30, 0.12), MAT["Stone"],
                  smooth=30), MAT["Stone"], 0.014, 1)
        # knee in the XZ plane, post head to the adjacent beam end. A brace
        # in the YZ plane at a post that carries the beam directly is not
        # structural and read as a loose stick in front of the opening.
        d = 1 if i == 0 else -1
        objs[f"ebrace{i}"] = member(
            L.strut(f"ebrace{i}", (px, E_POST_Y, E_BEAM_Z - 0.40),
                    (px + d * 0.34, E_POST_Y, E_BEAM_Z - 0.02), 0.10, 0.10,
                    MAT["Wood"], smooth=34), MAT["Wood"], 0.011, 1)

    objs["ebeam"] = member(
        L.box("ebeam", (xc, E_POST_Y, E_BEAM_Z), (E_X1 - E_X0 + 0.30, 0.16, 0.18),
              MAT["Wood"], smooth=34), MAT["Wood"], 0.015, 2)
    objs["eledger"] = member(
        L.box("eledger", (xc, -2.57, E_BACK_Z - 0.09), (E_X1 - E_X0 + 0.30, 0.14, 0.16),
              MAT["Wood"], smooth=34), MAT["Wood"], 0.013, 1)

    # Rafters run DOWN THE SLOPE (in Y), purlins run ACROSS it (in X). They
    # were originally authored the other way round, which laid 1.8 m beams
    # sideways through the opening and read as a collapsed frame.
    _drop = E_BACK_Z - E_FRONT_Z
    _span = abs(E_POST_Y + 2.50)
    for j, t in enumerate((0.05, 0.30, 0.55, 0.80, 0.95)):
        px = E_X0 + (E_X1 - E_X0) * t
        py = -2.50 - _span * t
        objs[f"erafter{j}"] = member(
            L.strut(f"erafter{j}", (px, -2.50, E_BACK_Z - 0.13),
                    (px, E_POST_Y, E_FRONT_Z - 0.13), 0.09, 0.12, MAT["Wood"],
                    smooth=34), MAT["Wood"], 0.010, 1)
    for i, t in enumerate((0.22, 0.58, 0.88)):
        py = -2.50 - _span * t
        objs[f"epurlin{i}"] = member(
            L.box(f"epurlin{i}", (xc, py, E_BACK_Z - _drop * t - 0.20),
                  (E_X1 - E_X0 + 0.30, 0.09, 0.11), MAT["Wood"],
                  smooth=34), MAT["Wood"], 0.010, 1)

    # --- canvas, mono-pitch with sag between purlins -------------------------
    AU = [-1.0 + 2.0 * i / 16 for i in range(17)]
    BU = [0.0, 0.25, 0.5, 0.75, 1.0]
    HALF = (E_X1 - E_X0) / 2 + 0.15
    DROP = E_BACK_Z - E_FRONT_Z

    def fn(i, j):
        a = AU[i]
        b = BU[j]
        z = E_BACK_Z - DROP * b
        ta = min(abs(a) / 0.5, 1.0) if abs(a) <= 0.5 else (abs(a) - 0.5) / 0.5
        z -= 0.030 * math.sin(math.pi * ta)
        tb = 0.0 if b >= 1.0 else (b * 2.0) % 1.0
        z -= 0.020 * math.sin(math.pi * tb)
        return (xc + a * HALF, -2.50 + (E_POST_Y + 2.50) * b, z)

    canvas = L.grid_surface("e_canvas", len(AU) - 1, len(BU) - 1, fn,
                            MAT["FabricAwning"], col="Canopy", thick=0.014)
    objs["e_canvas"] = member(canvas, MAT["FabricAwning"], 0.0, 1, smooth=70,
                              col="Canopy")

    NU = 20

    def vfn(i, j):
        a = -1.0 + 2.0 * i / NU
        scallop = 0.5 - 0.5 * math.cos(2 * math.pi * 4 * (i / NU))
        return (xc + a * HALF, E_POST_Y - 0.02 + 0.008 * math.sin(i * 2.1),
                E_FRONT_Z - 0.10 - (0.05 + 0.06 * scallop) * j)

    val = L.grid_surface("e_valance", NU, 2, vfn, MAT["FabricCanvas"],
                         col="Canopy", thick=0.012)
    objs["e_valance"] = member(val, MAT["FabricCanvas"], 0.0, 1, smooth=70,
                               col="Canopy")

    # No rope stays on this hood: at 1.65 m wide the posts are already
    # braced to the beam and the lashings only read as stray vertical lines.
    return objs


# ================================================= 6. lanterns + iron brackets
def lantern(name, pos, MAT, scale=1.0, glass=True, col="Hardware"):
    """Authored octagonal hanging lantern: iron frame, brass cap, glass body."""
    s = scale
    px, py, pz = pos
    parts = []

    def place(ob):
        ob.data.transform(Matrix.Translation((px, py, pz)) @ Matrix.Rotation(
            math.radians(28), 4, 'Z'))
        ob["xo_uv"] = L.UV_SCALE
        return ob

    body_h = 0.30 * s
    half = 0.115 * s
    base_z = 0.02 * s
    # bottom plate + finial
    parts.append(place(L.cylinder(f"{name}_plate", (0, 0, 0), 0.135 * s, 0.022 * s,
                                  MAT["Iron"], verts_n=8, smooth=40)))
    parts.append(place(L.cone(f"{name}_fin", (0, 0, -0.045 * s), 0.055 * s, 0.008 * s,
                              0.09 * s, MAT["Brass"], verts_n=8, smooth=40)))
    # 8 corner posts
    for k in range(8):
        a = 2 * math.pi * k / 8
        r = half * 1.42
        parts.append(place(L.box(f"{name}_post", (r * math.cos(a), r * math.sin(a),
                                                  base_z + body_h / 2),
                                 (0.022 * s, 0.022 * s, body_h), MAT["Iron"],
                                 rot_z=a, smooth=40)))
    # glass panels
    if glass:
        for k in range(8):
            a = 2 * math.pi * (k + 0.5) / 8
            r = half * 1.30
            g = L.box(f"{name}_glass", (r * math.cos(a), r * math.sin(a),
                                        base_z + body_h / 2),
                      (2 * r * math.tan(math.pi / 8) * 0.92, 0.012 * s, body_h * 0.92),
                      MAT["LampGlass"], rot_z=a, smooth=30)
            g["xo_mat"] = MAT["LampGlass"]
            g["xo_bevel"] = 0.0
            g["xo_seg"] = 1
            g["xo_smooth"] = math.radians(30)
            parts.append(place(g))
    # top cap + ring + hook
    parts.append(place(L.cone(f"{name}_cap", (0, 0, base_z + body_h + 0.055 * s),
                              0.145 * s, 0.055 * s, 0.13 * s, MAT["Brass"],
                              verts_n=8, smooth=40)))
    parts.append(place(L.torus(f"{name}_ring", (0, 0, base_z + body_h + 0.15 * s),
                               0.030 * s, 0.008 * s, MAT["Iron"], major=10, minor=5,
                               rot=(math.radians(90), 0, 0), smooth=40)))
    out = []
    for p in parts:
        mat = MAT["LampGlass"] if "_glass" in p.name else (
            MAT["Brass"] if ("_cap" in p.name or "_fin" in p.name) else MAT["Iron"])
        out.append(member(p, mat, 0.0, 1, smooth=40, col=col))
    return out


def build_hardware(MAT):
    objs = []

    def wall_lantern(tag, x, z_arm):
        arm_len = 0.46
        objs.append(member(
            L.box(f"{tag}_plate", (x, FRONT_Y - 0.02, z_arm - 0.10),
                  (0.075, 0.05, 0.40), MAT["Iron"], smooth=40),
            MAT["Iron"], 0.006, 1, smooth=40, col="Hardware"))
        objs.append(member(
            L.box(f"{tag}_arm", (x, FRONT_Y - arm_len / 2 - 0.02, z_arm),
                  (0.045, arm_len, 0.045), MAT["Iron"], smooth=40),
            MAT["Iron"], 0.006, 1, smooth=40, col="Hardware"))
        objs.append(member(
            L.strut(f"{tag}_brace", (x, FRONT_Y - 0.04, z_arm - 0.26),
                    (x, FRONT_Y - arm_len, z_arm - 0.02), 0.038, 0.038, MAT["Iron"],
                    smooth=40), MAT["Iron"], 0.005, 1, smooth=40, col="Hardware"))
        objs.append(member(
            L.sweep(f"{tag}_scroll",
                    [(x + 0.02, FRONT_Y - 0.05, z_arm - 0.18),
                     (x + 0.11, FRONT_Y - 0.05, z_arm - 0.25),
                     (x + 0.05, FRONT_Y - 0.05, z_arm - 0.31),
                     (x - 0.03, FRONT_Y - 0.05, z_arm - 0.27)],
                    0.011, MAT["Iron"], segments=6, col="Hardware"),
            MAT["Iron"], 0.0, 1, smooth=40, col="Hardware"))
        objs.append(member(
            L.sweep(f"{tag}_hook",
                    [(x, FRONT_Y - arm_len - 0.02, z_arm + 0.01),
                     (x, FRONT_Y - arm_len - 0.02, z_arm - 0.05),
                     (x, FRONT_Y - arm_len + 0.03, z_arm - 0.08)],
                    0.010, MAT["Iron"], segments=6, col="Hardware"),
            MAT["Iron"], 0.0, 1, smooth=40, col="Hardware"))
        lx = x
        ly = FRONT_Y - arm_len - 0.02
        lz = z_arm - 0.09
        objs.append(member(
            L.sweep(f"{tag}_chain", [(lx, ly, lz + 0.36), (lx, ly, lz + 0.20)],
                    0.010, MAT["Iron"], segments=6, col="Hardware"),
            MAT["Iron"], 0.0, 1, smooth=40, col="Hardware"))
        for p in lantern(tag, (lx, ly, lz - 0.36), MAT):
            objs.append(p)

    # x = +-3.70 is the only clear slot: the west canopy reaches to -3.56, the
    # east bay starts at 0.99, and the door occupies -0.90..0.90.
    wall_lantern("lantern_a", -3.70, 2.12)
    wall_lantern("lantern_b", 3.70, 2.86)

    # interior lantern hung from the centre roof beam
    objs.append(member(
        L.sweep("lantern_in_chain", [(0.0, 0.0, 3.30), (0.0, 0.0, 2.94)],
                0.010, MAT["Iron"], segments=6, col="Hardware"),
        MAT["Iron"], 0.0, 1, smooth=40, col="Hardware"))
    for p in lantern("lantern_in", (0.0, 1.05, 2.56), MAT, scale=1.15):
        objs.append(p)

    # hanging cloth bolts on a rail under the (west-shifted) canopy
    CRX = -2.44
    objs.append(member(
        L.box("cloth_rail", (CRX, -3.42, 2.62), (1.60, 0.07, 0.07), MAT["Wood"],
              smooth=34), MAT["Wood"], 0.008, 1, smooth=34, col="Hardware"))
    # NOTE: the hanging bolts deliberately avoid FabricAwning -- that material
    # carries XO_Awning_Color.png, whose stripe banding was showing up as pink
    # blotches on 0.3 m cloth.
    cloths = ((-0.80, 0.42, 0.30, MAT["FabricIndigo"]),
              (-0.28, 0.52, 0.34, MAT["FabricShade"]),
              (0.30, 0.46, 0.28, MAT["FabricRust"]),
              (0.82, 0.38, 0.26, MAT["FabricIndigo"]))
    cloths = tuple((cx + CRX, h, w, m) for cx, h, w, m in cloths)
    for i, (cx, h, w, m) in enumerate(cloths):
        # grid_surface hands fn integer indices, so normalise before use
        cl = L.grid_surface(
            f"cloth_{i}", 5, 7,
            lambda ii, jj, cx=cx, h=h, w=w: (
                cx + (ii / 5 - 0.5) * w + 0.022 * math.sin(jj / 7 * 3.4 + ii / 5 * 2.0),
                -3.42 + 0.045 * math.sin(ii / 5 * 5.0)
                + 0.02 * math.sin(jj / 7 * 5.0 + ii / 5 * 3.0),
                2.58 - (jj / 7) * h + 0.03 * math.sin(ii / 5 * 6.0) * (jj / 7)),
            m, col="Hardware", thick=0.008)
        objs.append(member(cl, m, 0.0, 1, smooth=70, col="Hardware"))
    return objs



# ============================================== 7. stalls, vessels, site props
JAR_SMALL = [(0.0, 0.0), (0.055, 0.0), (0.072, 0.035), (0.078, 0.10), (0.062, 0.17),
             (0.040, 0.205), (0.048, 0.225), (0.044, 0.235), (0.0, 0.235)]
JAR_LARGE = [(0.0, 0.0), (0.085, 0.0), (0.115, 0.05), (0.128, 0.16), (0.108, 0.30),
             (0.072, 0.40), (0.062, 0.44), (0.078, 0.47), (0.070, 0.49), (0.0, 0.49)]
JAR_AMPHORA = [(0.0, 0.0), (0.060, 0.02), (0.115, 0.10), (0.140, 0.22), (0.120, 0.34),
               (0.070, 0.42), (0.050, 0.50), (0.056, 0.62), (0.052, 0.64), (0.0, 0.64)]
BOWL = [(0.0, 0.0), (0.055, 0.0), (0.085, 0.035), (0.105, 0.085), (0.100, 0.088),
        (0.078, 0.040), (0.050, 0.012), (0.0, 0.010)]


def build_stall(MAT):
    objs = {}

    def counter(tag, cx, cy, w, d, h, rot_z, MAT=MAT):
        o = []
        o.append(member(L.box(f"{tag}_top", (cx, cy, h + 0.035), (w + 0.12, d + 0.12, 0.07),
                              MAT["Wood"], rot_z=rot_z, smooth=32),
                        MAT["Wood"], 0.014, 2))
        o.append(member(L.box(f"{tag}_shelf", (cx, cy, 0.30), (w - 0.10, d - 0.14, 0.05),
                              MAT["Wood"], rot_z=rot_z, smooth=32),
                        MAT["Wood"], 0.010, 1))
        for sx in (-1, 1):
            for sy in (-1, 1):
                lx = sx * (w / 2 - 0.06)
                ly = sy * (d / 2 - 0.06)
                rx = cx + lx * math.cos(rot_z) - ly * math.sin(rot_z)
                ry = cy + lx * math.sin(rot_z) + ly * math.cos(rot_z)
                o.append(member(L.box(f"{tag}_leg", (rx, ry, h / 2), (0.085, 0.085, h),
                                      MAT["Wood"], rot_z=rot_z, smooth=32),
                                MAT["Wood"], 0.010, 1))
        o.append(member(L.box(f"{tag}_apron", (cx, cy, h - 0.12), (w, 0.05, 0.18),
                              MAT["Wood"], rot_z=rot_z, smooth=32),
                        MAT["Wood"], 0.010, 1))
        for o2 in o:
            o2["xo_col"] = "Stall"
        return o

    def crate(tag, cx, cy, cz, s, rot_z):
        parts = [member(L.box(tag, (cx, cy, cz + s / 2), (s, s * 0.9, s),
                              MAT["Wood"], rot_z=rot_z, smooth=34),
                        MAT["Wood"], 0.014, 2, col="Stall")]
        for ax in range(3):
            for sy in (-1, 1):
                b = L.box(f"{tag}_b", (0, 0, 0), (s * 0.92, 0.03, 0.05), MAT["Wood"],
                          smooth=34)
                off = (0, sy * s * 0.45, 0)
                b.data.transform(
                    Matrix.Translation((cx, cy, cz + s / 2)) @ Matrix.Rotation(rot_z, 4, 'Z')
                    @ Matrix.Translation(off)
                    @ (Matrix.Rotation(math.radians(90), 4, 'X') if ax == 0 else
                       Matrix.Rotation(math.radians(90), 4, 'Y') if ax == 1 else
                       Matrix.Translation((0, 0, 0)))
                    @ Matrix.Translation((0, 0, s * (0.28 - 0.28 * ax))))
                b["xo_mat"] = MAT["Wood"]
                b["xo_bevel"] = 0.005
                b["xo_seg"] = 1
                b["xo_uv"] = L.UV_SCALE
                b["xo_smooth"] = math.radians(34)
                for c in b.users_collection:
                    c.objects.unlink(b)
                L.collection("Stall").objects.link(b)
                parts.append(b)
        return parts

    def vessel(tag, profile, pos, segments=16, mat=None, rz=0.0):
        m = mat or MAT["Terracotta"]
        j = L.lathe(tag, profile, m, segments=segments, col="Stall", smooth=48)
        j.data.transform(Matrix.Translation(pos) @ Matrix.Rotation(rz, 4, 'Z'))
        j["xo_mat"] = m
        j["xo_bevel"] = 0.006
        j["xo_seg"] = 1
        j["xo_uv"] = L.UV_SCALE
        j["xo_smooth"] = math.radians(48)
        return j

    # exterior stall under the canopy, offset so the doorway stays clear
    ex = (-2.30, -3.36, 0.0)
    for o in counter("stall_ex", ex[0], ex[1], 1.24, 0.62, 0.86, math.radians(-8)):
        objs[o.name] = o
    top = 0.86 + 0.07
    for i, (dx, dy, prof) in enumerate((
            (-0.36, 0.02, JAR_LARGE), (-0.02, -0.06, JAR_AMPHORA),
            (0.34, 0.04, JAR_SMALL))):
        v = vessel(f"ex_jar{i}", prof, (ex[0] + dx, ex[1] + dy, top))
        objs[v.name] = v
    for k in range(2):
        v = vessel(f"ex_bowl{k}", BOWL, (ex[0] - 0.40 + k * 0.26, ex[1] - 0.18, top),
                   segments=14)
        objs[v.name] = v
    tray = L.box("ex_tray", (ex[0] + 0.30, ex[1] - 0.20, top + 0.015),
                 (0.30, 0.22, 0.03), MAT["Wood"], rot_z=math.radians(6), smooth=32)
    objs[tray.name] = member(tray, MAT["Wood"], 0.008, 1, col="Stall", smooth=32)

    # interior stall against the west wall
    ix = (-2.45, 0.55)
    for o in counter("stall_in", ix[0], ix[1], 1.70, 0.64, 0.88, math.radians(90)):
        objs[o.name] = o
    top = 0.88 + 0.07
    for i, (dy, prof) in enumerate(((-0.42, JAR_AMPHORA), (0.0, JAR_LARGE),
                                    (0.40, JAR_SMALL))):
        v = vessel(f"in_jar{i}", prof, (ix[0], ix[1] + dy, top))
        objs[v.name] = v

    # crate stack + stool + sacks by the entrance
    for o in crate("crate_a", 1.75, -3.05, 0.0, 0.52, math.radians(11)):
        objs[o.name] = o
    for o in crate("crate_b", 1.79, -3.02, 0.52, 0.46, math.radians(-6)):
        objs[o.name] = o
    for o in crate("crate_c", -2.35, 1.55, PLINTH_H, 0.58, math.radians(-14)):
        objs[o.name] = o

    stool = L.box("stool_seat", (2.85, -2.92, 0.44), (0.36, 0.30, 0.055), MAT["Wood"],
                  rot_z=math.radians(16), smooth=32)
    objs[stool.name] = member(stool, MAT["Wood"], 0.012, 2, col="Stall", smooth=32)
    for sx in (-1, 1):
        for sy in (-1, 1):
            lg = L.strut("stool_leg", (1.72 + sx * 0.145, -2.15 + sy * 0.115, 0.0),
                         (1.72 + sx * 0.105, -2.15 + sy * 0.085, 0.42),
                         0.042, 0.042, MAT["Wood"], col="Stall", smooth=32)
            objs[lg.name] = member(lg, MAT["Wood"], 0.005, 1, col="Stall", smooth=32)

    for i, (sx, sy, rz) in enumerate(((2.15, -3.60, 0.4), (2.55, -3.42, -0.8),
                                      (-2.30, -3.70, 1.9))):
        sack = L.lathe(f"sack{i}",
                       [(0.0, 0.0), (0.17, 0.015), (0.205, 0.10), (0.20, 0.24),
                        (0.155, 0.34), (0.085, 0.40), (0.055, 0.44),
                        (0.075, 0.47), (0.0, 0.47)],
                       MAT["Rope"], segments=9, col="Stall", smooth=24)
        sack.data.transform(Matrix.Translation((sx, sy, 0.0))
                            @ Matrix.Rotation(rz, 4, 'Z'))
        sack.data.transform(Matrix.Diagonal((1.0, 0.82, 0.74, 1.0)))
        objs[sack.name] = member(sack, MAT["Rope"], 0.012, 1, col="Stall",
                                 smooth=24)

    # coiled rope by the threshold
    for i, (rr, zz) in enumerate(((0.22, 0.03), (0.165, 0.085), (0.105, 0.135))):
        coil = L.torus(f"coil{i}", (-1.05, -3.10, zz), rr, 0.032, MAT["Rope"],
                       major=18, minor=7, col="Site", smooth=60)
        objs[coil.name] = member(coil, MAT["Rope"], 0.0, 1, col="Site", smooth=60)

    # leaning ladder against the left wall (top touches the plaster face)
    # on the BACK facade: leaning against the front-west corner it overlapped the
    # base course and quoins and read as a jumble of boards
    for i, rx in enumerate((-3.30, -2.72)):
        r = L.strut(f"ladder_rail{i}", (rx, 2.94, 0.0), (rx - 0.42, 2.54, 2.44),
                    0.055, 0.075, MAT["Wood"], col="Site", smooth=34)
        objs[r.name] = member(r, MAT["Wood"], 0.008, 1, col="Site", smooth=34)
    for k in range(8):
        z = 0.24 + k * 0.28
        y = 2.94 - (z / 2.44) * 0.40
        rung = L.strut(f"ladder_rung{k}", (-3.30, y, z), (-2.72, y, z),
                       0.05, 0.042, MAT["Wood"], col="Site", smooth=34)
        objs[rung.name] = member(rung, MAT["Wood"], 0.006, 1, col="Site", smooth=34)

    # desert cactus beside the right wall
    cact = L.lathe("cactus", [(0.0, 0.0), (0.150, 0.0), (0.158, 0.16), (0.150, 0.62),
                               (0.132, 1.02), (0.104, 1.28), (0.062, 1.42), (0.0, 1.45)],
                   MAT["Cactus"], segments=16, col="Site", smooth=60, rib=0.10)
    cact.data.transform(Matrix.Translation((4.58, 1.15, 0.0)))
    objs[cact.name] = member(cact, MAT["Cactus"], 0.01, 1, col="Site", smooth=60)
    for i, (az, el, ln) in enumerate(((math.radians(163), 0.45, 0.52),
                                      (math.radians(217), 0.62, 0.42))):
        arm = L.lathe(f"cactus_arm{i}", [(0.0, 0.0), (0.082, 0.0), (0.078, 0.26),
                                         (0.066, 0.42), (0.0, 0.46)],
                      MAT["Cactus"], segments=14, col="Site", smooth=60, rib=0.10)
        arm.data.transform(
            Matrix.Translation((4.58, 1.15, 0.0))
            @ Matrix.Rotation(az, 4, 'Z')
            @ Matrix.Translation((0.0, 0.0, 0.55 + i * 0.42))
            @ Matrix.Rotation(math.radians(74), 4, 'Y')
            @ Matrix.Translation((0.0, 0.0, 0.0)))
        objs[arm.name] = member(arm, MAT["Cactus"], 0.008, 1, col="Site", smooth=60)
    return objs


# ==================================================================== 8. main
def import_donor(path: str):
    """PolyHaven CC0 brass diya lantern: the only non-authored mesh used."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [o for o in bpy.data.objects
                if o.type == 'MESH' and o not in before]
    if not imported:
        return None
    root = bpy.data.objects.new("donor_brass_diya_root", None)
    L.collection("Donor").objects.link(root)
    for o in imported:
        o.name = o.name.replace(".", "_")
        for c in list(o.users_collection):
            c.objects.unlink(o)
        L.collection("Donor").objects.link(o)
        o.parent = root
        o.matrix_parent_inverse = root.matrix_world.inverted()
    root.location = (-1.34, -3.30, 0.955)
    root.rotation_euler = (0.0, 0.0, math.radians(24))
    root.scale = (0.95, 0.95, 0.95)
    # tag donor objects so the material-grouped pass leaves them alone
    for o in imported:
        o["xo_donor"] = True
        o["xo_uv"] = 1.0
        o["xo_smooth"] = math.radians(40)
    return root


def main():
    # deferred: market_massing imports this module for the shared dimensions
    import market_massing as MS  # noqa: E402
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    MAT = MM.build_all()
    print("BUILD materials", len(MAT))

    objs = {}
    for part in (build_shell(MAT), MS.build_leanto(MAT), build_roof(MAT),
                 MS.build_upper(MAT), build_facade(MAT),
                 build_openings(MAT), build_canopy(MAT), build_canopy_east(MAT),
                 build_hardware(MAT), build_stall(MAT)):
        objs.update(part if isinstance(part, dict) else {})
        if not isinstance(part, dict):
            for o in part:
                objs[o.name] = o
    print("BUILD members", len(objs))

    donor_root = None
    donor = os.path.join(os.path.dirname(HERE), "donor", "brass_diya_lantern",
                         "brass_diya_lantern_1k.glb")
    if os.path.exists(donor):
        donor_root = import_donor(donor)
        print("BUILD donor imported", donor_root.name if donor_root else "none")

    # ---------------- merge by material group -------------------------------
    # Per-group finish settings, chosen so bevelled edges read at gameplay
    # distance without turning the rounded organic props into blobs.
    BEVEL_TABLE = {
        "XO_Plaster": 0.030, "XO_Mudbrick": 0.024, "XO_Wood": 0.016,
        "XO_Stone_Limestone": 0.018, "XO_Terracotta": 0.005,
        "XO_Earth_Floor": 0.010, "XO_Foliage": 0.008,
        "XO_WroughtIron": 0.0, "XO_Brass": 0.0, "XO_Rope": 0.0,
        "XO_Fabric_Awning_Terracotta": 0.0, "XO_Fabric_Shade_Cream": 0.0,
        "XO_Fabric_Indigo": 0.0, "XO_LampGlass": 0.0,
        "XO_Fabric_Rust": 0.0, "XO_Fabric_Canvas": 0.0,
    }
    SMOOTH_TABLE = {
        "XO_Plaster": 30.0, "XO_Mudbrick": 30.0, "XO_Wood": 34.0,
        "XO_Stone_Limestone": 32.0, "XO_Terracotta": 40.0,
        "XO_Earth_Floor": 32.0, "XO_Foliage": 46.0,
        "XO_WroughtIron": 40.0, "XO_Brass": 40.0, "XO_Rope": 60.0,
        "XO_Fabric_Awning_Terracotta": 70.0, "XO_Fabric_Shade_Cream": 70.0,
        "XO_Fabric_Indigo": 70.0, "XO_LampGlass": 30.0,
        "XO_Fabric_Rust": 70.0, "XO_Fabric_Canvas": 70.0,
    }

    groups: dict[str, list] = {}
    for ob in bpy.data.objects:
        if ob.type != 'MESH' or ob.get("xo_donor"):
            continue
        # Solidify must be baked before the merge (join_meshes copies geometry
        # only) or the canvas/valance/cloths lose their thickness.
        L.apply_modifier_types(ob, {'SOLIDIFY'})
        mat = ob.get("xo_mat")
        if mat is None:
            mat = ob.data.materials[0] if ob.data.materials else MAT["Plaster"]
        groups.setdefault(mat.name, []).append(ob)

    # Texture world size in metres per UV unit.  Masonry needs a much tighter
    # repeat than the 2 m default or the rubble stones read at metre scale.
    UV_TABLE = {
        "XO_Mudbrick": 1.15, "XO_Plaster": 0.55, "XO_Stone_Limestone": 1.50,
        "XO_Earth_Floor": 0.90, "XO_Wood": 0.85, "XO_Terracotta": 0.45,
        "XO_Rope": 0.30, "XO_Fabric_Awning_Terracotta": 2.00,
        "XO_Fabric_Shade_Cream": 0.45, "XO_Fabric_Indigo": 0.40,
        "XO_Fabric_Rust": 0.40, "XO_Fabric_Canvas": 0.40,
    }

    total_v = total_p = 0
    for name, members in sorted(groups.items()):
        # union bbox of the members, to verify nothing is lost or displaced
        pre = [o.matrix_world @ v.co for o in members for v in o.data.vertices]
        pre_lo = [min(p[i] for p in pre) for i in range(3)]
        pre_hi = [max(p[i] for p in pre) for i in range(3)]
        merged_ob = L.join_meshes(f"XO_{name}", members, bpy.data.materials[name])
        L.finish(merged_ob,
                 bevel=BEVEL_TABLE.get(name, 0.015),
                 segments=2,
                 smooth_angle=SMOOTH_TABLE.get(name, 34.0),
                 uv_scale=UV_TABLE.get(name, L.UV_SCALE), apply=True)
        merged_ob.data.materials.clear()
        merged_ob.data.materials.append(bpy.data.materials[name])
        post_lo = [min(v.co[i] for v in merged_ob.data.vertices) for i in range(3)]
        post_hi = [max(v.co[i] for v in merged_ob.data.vertices) for i in range(3)]
        drift = max(abs(post_lo[i] - pre_lo[i]) for i in range(3)) + \
            max(abs(post_hi[i] - pre_hi[i]) for i in range(3))
        # a few mm of drift is just the Bevel chamfering its corners; anything
        # larger means a member was placed wrong
        if drift > 0.02:
            print(f"PLACEMENT_DRIFT {name} {drift:.4f} "
                  f"pre={[round(q, 3) for q in pre_lo]}/{[round(q, 3) for q in pre_hi]} "
                  f"post={[round(q, 3) for q in post_lo]}/"
                  f"{[round(q, 3) for q in post_hi]}")
        total_v += len(merged_ob.data.vertices)
        total_p += len(merged_ob.data.polygons)
        print(f"GROUP {name:28s} members={len(members):4d} "
              f"verts={len(merged_ob.data.vertices):7d} "
              f"faces={len(merged_ob.data.polygons):7d}")

    # donor pass: its own PBR materials, own UVs, modifiers applied
    if donor_root:
        for o in list(bpy.data.objects):
            if o.type == 'MESH' and o.get("xo_donor"):
                bpy.ops.object.select_all(action='DESELECT')
                o.select_set(True)
                bpy.context.view_layer.objects.active = o
                for m in [mm.name for mm in o.modifiers]:
                    try:
                        bpy.ops.object.modifier_apply(modifier=m)
                    except RuntimeError:
                        pass
                L.box_uv(o, 1.0)
                o.data.name = o.name = "donor_diya_" + o.name
                for sl in o.data.materials:
                    # the chain/connection meshes share the lantern's material,
                    # so guard against stacking the prefix
                    if sl and not sl.name.startswith("XO_Donor_"):
                        sl.name = "XO_Donor_" + sl.name
                total_v += len(o.data.vertices)
                total_p += len(o.data.polygons)
                print(f"DONOR {o.name:34s} verts={len(o.data.vertices):6d} "
                      f"faces={len(o.data.polygons):6d} "
                      f"mats={[m.name for m in o.data.materials if m]}")

    all_mesh = [o for o in bpy.data.objects if o.type == 'MESH']
    tris = quads = ngons = 0
    for o in all_mesh:
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
        for p in o.data.polygons:
            if len(p.vertices) == 4:
                quads += 1
            else:
                ngons += 1
    print(f"BUILD objects={len(all_mesh)} verts={total_v} faces={total_p} "
          f"tris={tris} quads={quads} nonquads={ngons}")
    mats_used = sorted({m.name for o in all_mesh for m in o.data.materials if m})
    print("BUILD materials_used", len(mats_used), mats_used)

    # bounds
    xs = [o.matrix_world @ v.co for o in all_mesh for v in o.data.vertices]
    lo = [round(min(p[i] for p in xs), 3) for i in range(3)]
    hi = [round(max(p[i] for p in xs), 3) for i in range(3)]
    print("BUILD bounds_min", lo, "bounds_max", hi,
          "size", [round(hi[i] - lo[i], 3) for i in range(3)])

    # cleanup authoring metadata, add clean integration extras
    for o in bpy.data.objects:
        for k in list(o.keys()):
            del o[k]
    root = bpy.data.objects.get("XO_MarketHall")
    if root is None:
        root = bpy.data.objects.new("XO_MarketHall", None)
        bpy.context.scene.collection.objects.link(root)
    for o in all_mesh:
        if o.parent is None:
            o.parent = root
            o.matrix_parent_inverse = root.matrix_world.inverted()
    root["xo_asset"] = "XO Market Hall"
    root["xo_authored"] = "All geometry authored in Blender by build_market.py"
    root["xo_donor"] = ("1 CC0 PolyHaven brass_diya_lantern prop "
                        "(CC0-1.0, polyhaven.com/a/brass_diya_lantern)")
    root["xo_licence"] = ("CC0 1.0 (authored geometry) / CC0 1.0 (donor + "
                         "ambientCG maps)")
    root["xo_scale"] = "1.0 = metres; facade width 8.00 m, height 4.54 m"
    root["xo_faces"] = tris
    root["xo_materials"] = len(mats_used)

    # ------------------------------------------------------------- save + glb
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(
        os.path.dirname(HERE), "export", "market_hall.blend"))

    glb = os.path.join(os.path.dirname(HERE), "export", "market_hall.glb")
    bpy.ops.export_scene.gltf(
        filepath=glb, export_format='GLB', export_apply=True,
        export_materials='EXPORT', export_yup=True, export_normals=True,
        export_texcoords=True, export_extras=True)
    print("EXPORTED", glb, os.path.getsize(glb))
    print("BUILD_OK")


if __name__ == "__main__":
    main()
