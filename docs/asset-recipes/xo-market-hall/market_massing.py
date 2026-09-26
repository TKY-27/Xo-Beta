"""Second-storey / secondary-mass authoring for the XO market hall.

Two additions that break the pass-1 single-rectangle silhouette:

*  build_leanto()  -- a lower asymmetric ancillary range on the back-east corner
                      (storeroom / workroom wing). Mono-pitch roof draining
                      north, gable triangles on the two open ends, its own
                      mudbrick base course, its own lintel-and-jamb door, two
                      beam-ends and a single thin upstand.
*  build_upper()   -- a small plastered upper chamber on the roof deck, placed
                      DIAGONALLY OPPOSITE the lean-to (west-front) so the two
                      secondary masses never stack on the same side. Same
                      construction language as the hall below it: brick base
                      band, rendered upper, timber lintel on a real opening,
                      one projecting timber cornice, thin stone coping.

Every dimension is imported from build_market so the LOD2 builder can share it.
"""

from __future__ import annotations

import math

from mathutils import Matrix

import build_market as B
import market_lib as L

member = B.member
place = B.place
M = B.M
PLINTH_H = B.PLINTH_H
Z_DECK = B.Z_DECK
FRONT_Y = B.FRONT_Y
BACK_Y = B.BACK_Y
LEFT_X = B.LEFT_X
RIGHT_X = B.RIGHT_X

# ------------------------------------------------------------------ lean-to
# Attached range on the back-east.  Its high side butts the hall's back wall,
# its roof falls away to the north, so it reads as a store/workroom wing rather
# than a shed: it shares the plinth, the base course, the wall thickness logic
# and the beam-end idiom of the main block, and it steps 1.08 m below the
# parapet so the step is unambiguous in profile.
LEAN_X0, LEAN_X1 = 0.90, 4.38
LEAN_Y0, LEAN_Y1 = 2.50, 4.86
LEAN_TH = 0.34                                   # leaner than the hall's 0.42
LEAN_LOW = 2.16                                  # top of the low (north) wall
LEAN_RISE = 0.46                                 # mono-pitch rise to the hall
LEAN_WALL_H = LEAN_LOW - PLINTH_H
LEAN_W = LEAN_X1 - LEAN_X0                       # 3.48
LEAN_D = LEAN_Y1 - LEAN_Y0                       # 2.36
LEAN_PITCH = math.atan2(LEAN_RISE, LEAN_D)       # 0.1935 rad = 11.0 deg
LEAN_BASE = 0.66                                 # mudbrick base course height
LEAN_OS_X = 0.16                                 # roof oversail, each side
LEAN_OS_N = 0.30                                 # roof oversail at the eave


def _gable(name, x0, x1, y0, y1, z_flat, z_high, mat, col="Shell"):
    """Triangular prism closing the wall between the flat wall top and the
    sloping roof line.  6 verts / 5 faces: cheaper and more robust than a
    bevelled trapezoid, and the slope matches lean_roof exactly."""
    v = [(x0, y0, z_flat), (x0, y1, z_flat), (x0, y0, z_high),
         (x1, y0, z_flat), (x1, y1, z_flat), (x1, y0, z_high)]
    f = [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (0, 2, 5, 3), (1, 4, 5, 2)]
    return L.new_object(name, v, f, mat, col=col, smooth_angle=math.radians(30))


def build_leanto(MAT):
    objs = {}

    # --- plinth continuation -------------------------------------------------
    objs["lean_plinth"] = member(
        L.box("lean_plinth",
              ((LEAN_X0 + LEAN_X1) / 2, (LEAN_Y0 + LEAN_Y1) / 2, 0.10),
              (LEAN_W + 0.24, LEAN_D + 0.24, 0.20), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], 0.030, 2)
    objs["lean_floor"] = member(
        L.box("lean_floor",
              ((LEAN_X0 + LEAN_X1) / 2, (LEAN_Y0 + LEAN_Y1) / 2, PLINTH_H - 0.03),
              (LEAN_W, LEAN_D, 0.06), MAT["Earth"], smooth=25),
        MAT["Earth"], 0.010, 1, smooth=25)

    # --- three walls; the south side is closed by the hall's back wall -------
    # north (outer face y = LEAN_Y1).  Following the hall's back-wall convention:
    # local u=0 sits at x = LEAN_X1 - LEAN_TH and increases toward -X.
    # local u -> world x = LEAN_X1 - u  (rot 180), so every hole is authored by
    # its WORLD x and converted here, which is the only way to keep them apart
    north_holes = [
        (1.86, 2.76, 0.0, 1.95),     # 0 store door, world x 1.62..2.52
        (0.36, 1.06, 1.02, 1.62),     # 1 small window, world x 3.32..4.02
        (2.90, 3.30, 0.32, 0.52),     # 2 air brick, world x 1.08..1.48
    ]
    n = L.panel("lean_wall_n", LEAN_W, LEAN_WALL_H, LEAN_TH, north_holes,
                MAT["Plaster"])
    place(n, M((LEAN_X1, LEAN_Y1, PLINTH_H), math.pi))
    objs["lean_wall_n"] = member(n, MAT["Plaster"], 0.026, 2)

    # east (outer face x = LEAN_X1).  Local u=0 at y = LEAN_Y1, increasing -Y.
    # local u -> world y = LEAN_Y1 - u
    east_holes = [
        (0.60, 1.50, 0.0, 1.95),     # 0 side door, world y 3.36..4.26
        (1.75, 2.45, 1.05, 1.65),    # 1 small window, world y 2.41..3.11
    ]
    e = L.panel("lean_wall_e", LEAN_D, LEAN_WALL_H, LEAN_TH, east_holes,
                MAT["Plaster"])
    place(e, M((LEAN_X1 - LEAN_TH, LEAN_Y1, PLINTH_H), math.radians(-90)))
    objs["lean_wall_e"] = member(e, MAT["Plaster"], 0.026, 2)

    # west return (outer face x = LEAN_X0).  Local u=0 at y = LEAN_Y0, +Y.
    west_holes = [
        (0.55, 1.25, 1.05, 1.65),                       # 0 small window
        (1.70, 2.16, 1.20, 1.50),                       # 1 slit vent
    ]
    w = L.panel("lean_wall_w", LEAN_D, LEAN_WALL_H, LEAN_TH, west_holes,
                MAT["Plaster"])
    place(w, M((LEAN_X0 + LEAN_TH, LEAN_Y0, PLINTH_H), math.radians(90)))
    objs["lean_wall_w"] = member(w, MAT["Plaster"], 0.026, 2)

    # --- gable triangles + mono-pitch roof slab -----------------------------
    objs["lean_gable_e"] = member(
        _gable("lean_gable_e", LEAN_X1 - LEAN_TH, LEAN_X1, LEAN_Y0, LEAN_Y1,
               LEAN_LOW, LEAN_LOW + LEAN_RISE, MAT["Plaster"]),
        MAT["Plaster"], 0.022, 2)
    objs["lean_gable_w"] = member(
        _gable("lean_gable_w", LEAN_X0, LEAN_X0 + LEAN_TH, LEAN_Y0, LEAN_Y1,
               LEAN_LOW, LEAN_LOW + LEAN_RISE, MAT["Plaster"]),
        MAT["Plaster"], 0.022, 2)

    # roof: a box tipped about X so its top face passes exactly through
    # (LEAN_Y0, LEAN_LOW + LEAN_RISE) and (LEAN_Y1, LEAN_LOW).
    roof_y0, roof_y1 = LEAN_Y0 - 0.06, LEAN_Y1 + LEAN_OS_N
    roof_len = (roof_y1 - roof_y0) / math.cos(LEAN_PITCH)
    roof_ymid = (roof_y0 + roof_y1) / 2
    roof_top = LEAN_LOW + LEAN_RISE - LEAN_RISE * (roof_ymid - LEAN_Y0) / LEAN_D
    roof_c = ((LEAN_X0 + LEAN_X1) / 2, roof_ymid, roof_top - 0.07 / math.cos(LEAN_PITCH))
    objs["lean_roof"] = member(
        L.box("lean_roof", (0, 0, 0),
              (LEAN_W + 2 * LEAN_OS_X, roof_len, 0.14), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], 0.026, 2)
    # author at the origin, then tip about the box centre, never about the
    # world origin (that would fling the slab metres away)
    objs["lean_roof"].data.transform(
        Matrix.Translation(roof_c) @ Matrix.Rotation(-LEAN_PITCH, 4, 'X'))

    # battens + a single thin upstand at the eave: one horizontal element, not a
    # stack.  The upstand is carried on the same pitch as the roof.
    # battens run across the slope, spaced up it.  The first cut sampled the
    # slope line at y values SOUTH of the range, where the line keeps climbing
    # and flung three 3.8 m battens out over the front of the site.
    # Six closer-spaced, shallower battens half-bedded into the roof.  Four
    # 0.10 x 0.09 battens on a 0.65 m pitch left 0.55 m of bare roof between
    # them and read as loose planks rather than purlins.
    for i in range(6):
        by = 2.86 + i * 0.39
        bz = LEAN_LOW + LEAN_RISE - LEAN_RISE * (by - LEAN_Y0) / LEAN_D + 0.026
        bt = L.box(f"lean_batten{i}", (0, 0, 0), (LEAN_W + 2 * LEAN_OS_X, 0.085, 0.07),
                   MAT["Wood"], smooth=32)
        bt.data.transform(
            Matrix.Translation(((LEAN_X0 + LEAN_X1) / 2, by, bz))
            @ Matrix.Rotation(-LEAN_PITCH, 4, 'X'))
        objs[f"lean_batten{i}"] = member(bt, MAT["Wood"], 0.010, 1, smooth=32)
    up_y = LEAN_Y1 + LEAN_OS_N - 0.11
    up_z = LEAN_LOW + LEAN_RISE - LEAN_RISE * (up_y - LEAN_Y0) / LEAN_D + 0.10
    up = L.box("lean_upstand", (0, 0, 0), (LEAN_W + 2 * LEAN_OS_X, 0.22, 0.22),
               MAT["Mudbrick"], smooth=30)
    up.data.transform(Matrix.Translation(((LEAN_X0 + LEAN_X1) / 2, up_y, up_z))
                      @ Matrix.Rotation(-LEAN_PITCH, 4, 'X'))
    objs["lean_upstand"] = member(up, MAT["Mudbrick"], 0.022, 2)
    cp = L.box("lean_cope", (0, 0, 0), (LEAN_W + 2 * LEAN_OS_X + 0.10, 0.29, 0.06),
               MAT["Stone"], smooth=30)
    cp.data.transform(Matrix.Translation(((LEAN_X0 + LEAN_X1) / 2, up_y, up_z + 0.14))
                      @ Matrix.Rotation(-LEAN_PITCH, 4, 'X'))
    objs["lean_cope"] = member(cp, MAT["Stone"], 0.014, 1)

    # two beam-ends under the eave, horizontal
    for i, vx in enumerate((1.72, 3.58)):
        objs[f"lean_viga{i}"] = member(
            L.box(f"lean_viga{i}", (vx, LEAN_Y1 + 0.15, LEAN_LOW - 0.15),
                  (0.17, 0.32, 0.22), MAT["Wood"], smooth=32),
            MAT["Wood"], 0.014, 1, smooth=32)

    # --- mudbrick base course, matching the hall's but shorter --------------
    BC_P = 0.032
    objs["lean_bc_n"] = member(
        L.box("lean_bc_n", ((LEAN_X0 + LEAN_X1) / 2, LEAN_Y1 + BC_P / 2 - 0.02,
                            PLINTH_H + LEAN_BASE / 2),
              (LEAN_W, 0.07, LEAN_BASE), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], 0.022, 2)
    objs["lean_bc_e"] = member(
        L.box("lean_bc_e", (LEAN_X1 + BC_P / 2 - 0.02, (LEAN_Y0 + LEAN_Y1) / 2,
                            PLINTH_H + LEAN_BASE / 2),
              (0.07, LEAN_D, LEAN_BASE), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], 0.022, 2)
    objs["lean_bc_w"] = member(
        L.box("lean_bc_w", (LEAN_X0 - BC_P / 2 + 0.02, (LEAN_Y0 + LEAN_Y1) / 2,
                            PLINTH_H + LEAN_BASE / 2),
              (0.07, LEAN_D, LEAN_BASE), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], 0.022, 2)

    # --- door + window furniture --------------------------------------------
    # store door on the north face
    dx = 2.07          # centre of the north store door
    objs["lean_door_dark"] = member(
        L.box("lean_door_dark", (dx, LEAN_Y1 - LEAN_TH + 0.05, PLINTH_H + 0.97),
              (0.86, 0.05, 1.92), MAT["Earth"], smooth=30),
        MAT["Earth"], 0.0, 1)
    objs["lean_door_leaf"] = member(
        L.box("lean_door_leaf", (dx, LEAN_Y1 - 0.03, PLINTH_H + 0.94),
              (0.80, 0.06, 1.86), MAT["Wood"], smooth=32),
        MAT["Wood"], 0.014, 1, smooth=32)
    for i, dz in enumerate((PLINTH_H + 0.28, PLINTH_H + 0.94, PLINTH_H + 1.60)):
        objs[f"lean_door_rail{i}"] = member(
            L.box(f"lean_door_rail", (0, 0, 0), (0.80, 0.10, 0.09), MAT["Wood"],
                  smooth=32),
            MAT["Wood"], 0.006, 1, smooth=32)
        objs[f"lean_door_rail{i}"].data.transform(
            Matrix.Translation((dx, LEAN_Y1 - 0.03, dz)))
    objs["lean_door_lintel"] = member(
        L.box("lean_door_lintel", (dx, LEAN_Y1 - 0.09, PLINTH_H + 2.02),
              (1.06, 0.18, 0.16), MAT["Wood"], smooth=32),
        MAT["Wood"], 0.014, 1, smooth=32)
    for sx in (-1, 1):
        objs[f"lean_door_jamb{'p' if sx > 0 else 'm'}"] = member(
            L.box(f"lean_door_jamb", (0, 0, 0), (0.14, 0.15, 2.06), MAT["Wood"],
                  smooth=32),
            MAT["Wood"], 0.010, 1, smooth=32)
        objs[f"lean_door_jamb{'p' if sx > 0 else 'm'}"].data.transform(
            Matrix.Translation((dx + sx * 0.46, LEAN_Y1 - 0.09, PLINTH_H + 1.03)))
    objs["lean_door_ring"] = member(
        L.torus("lean_door_ring", (dx + 0.28, LEAN_Y1 - 0.08, PLINTH_H + 1.02),
                0.052, 0.011, MAT["Iron"], major=10, minor=5,
                rot=(math.radians(90), 0, 0)),
        MAT["Iron"], 0.0, 1, smooth=40)

    # sill + 3-bar grille on the north window, a lintel on the east window
    wx = 3.67          # centre of the north window
    objs["lean_win_sill_n"] = member(
        L.box("lean_win_sill_n", (wx, LEAN_Y1 + 0.02, PLINTH_H + 1.00),
              (0.82, 0.20, 0.08), MAT["Stone"], smooth=30),
        MAT["Stone"], 0.012, 1)
    objs["lean_win_lintel_n"] = member(
        L.box("lean_win_lintel_n", (wx, LEAN_Y1 - 0.07, PLINTH_H + 1.70),
              (0.88, 0.14, 0.12), MAT["Wood"], smooth=32),
        MAT["Wood"], 0.010, 1, smooth=32)
    for i, gz in enumerate((PLINTH_H + 1.20, PLINTH_H + 1.40, PLINTH_H + 1.58)):
        objs[f"lean_grille_n{i}"] = member(
            L.box(f"lean_grille_n", (0, 0, 0), (0.60, 0.035, 0.035), MAT["Iron"],
                  smooth=40),
            MAT["Iron"], 0.0, 1, smooth=40)
        objs[f"lean_grille_n{i}"].data.transform(
            Matrix.Translation((wx, LEAN_Y1 - 0.14, gz)))
    ey = 2.76          # centre of the east window
    objs["lean_win_sill_e"] = member(
        L.box("lean_win_sill_e", (LEAN_X1 + 0.02, ey, PLINTH_H + 1.03),
              (0.20, 0.82, 0.08), MAT["Stone"], smooth=30),
        MAT["Stone"], 0.012, 1)
    objs["lean_win_lintel_e"] = member(
        L.box("lean_win_lintel_e", (LEAN_X1 - 0.07, ey, PLINTH_H + 1.73),
              (0.14, 0.88, 0.12), MAT["Wood"], smooth=32),
        MAT["Wood"], 0.010, 1, smooth=32)

    # corner quoins on the exposed north-east arris, tying it to the hall
    for i in range(3):
        qz = PLINTH_H + 0.14 + i * 0.24
        objs[f"lean_quoin{i}a"] = member(
            L.box(f"lean_quoin", (0, 0, 0), (0.44, 0.075, 0.24), MAT["Mudbrick"],
                  smooth=30),
            MAT["Mudbrick"], 0.018, 1)
        objs[f"lean_quoin{i}a"].data.transform(
            Matrix.Translation((LEAN_X1 - 0.22, LEAN_Y1 - 0.030, qz)))
        objs[f"lean_quoin{i}b"] = member(
            L.box(f"lean_quoin", (0, 0, 0), (0.075, 0.44, 0.24), MAT["Mudbrick"],
                  smooth=30),
            MAT["Mudbrick"], 0.018, 1)
        objs[f"lean_quoin{i}b"].data.transform(
            Matrix.Translation((LEAN_X1 - 0.030, LEAN_Y1 - 0.22, qz)))
    return objs


# ------------------------------------------------------- upper roof chamber
# Placed WEST-FRONT on the deck, diagonally opposite the lean-to on the
# back-east, so the two secondary masses never read as one lopsided corner.
PENT_X, PENT_Y = -2.45, 0.95
PENT_W, PENT_D = 1.70, 1.50
PENT_H = 1.50
PENT_BASE = 0.58                      # mudbrick base band
PENT_TH = 0.26                        # upper storey wall thickness
PENT_UW = PENT_D + 0.06               # front/back panel width
PENT_ULH = PENT_H - PENT_BASE         # upper storey height, 0.92


def build_upper(MAT):
    objs = {}
    x0, x1 = PENT_X - PENT_W / 2, PENT_X + PENT_W / 2
    y0, y1 = PENT_Y - PENT_D / 2, PENT_Y + PENT_D / 2

    # brick base band, very slightly battered so the upper storey oversails it
    objs["pent_base"] = member(
        L.box("pent_base", (PENT_X, PENT_Y, Z_DECK + PENT_BASE / 2),
              (PENT_W, PENT_D, PENT_BASE), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], 0.026, 2)
    objs["pent_band"] = member(
        L.box("pent_band", (PENT_X, PENT_Y, Z_DECK + PENT_BASE - 0.05),
              (PENT_W + 0.14, PENT_D + 0.14, 0.10), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], 0.018, 1)
    objs["pent_foot"] = member(
        L.box("pent_foot", (PENT_X, PENT_Y, Z_DECK + 0.06),
              (PENT_W + 0.26, PENT_D + 0.26, 0.12), MAT["Stone"], smooth=30),
        MAT["Stone"], 0.020, 1)

    # plastered upper storey: four panel walls so the opening is a real cut
    up_z0 = Z_DECK + PENT_BASE
    ox = PENT_X - PENT_UW / 2 + 1.07   # centre of the south opening
    ou0, ou1 = 0.78, 1.36   # 0.58 wide, inside PENT_UW=1.56
    ov0, ov1 = 0.26, 0.78
    # panel() places local (u, t) -> world, so each matrix is the u=0 / t=0
    # CORNER of the panel, not its centre.  Front: u runs +X from the west edge.
    f = L.panel("pent_wall_s", PENT_UW, PENT_ULH, PENT_TH,
                [(ou0, ou1, ov0, ov1)], MAT["Plaster"])
    place(f, M((PENT_X - PENT_UW / 2, y0, up_z0)))
    objs["pent_wall_s"] = member(f, MAT["Plaster"], 0.022, 2)
    # back: rot 180, so u runs -X from the EAST edge
    b = L.panel("pent_wall_n", PENT_UW, PENT_ULH, PENT_TH, [], MAT["Plaster"])
    place(b, M((PENT_X + PENT_UW / 2, y1, up_z0), math.pi))
    objs["pent_wall_n"] = member(b, MAT["Plaster"], 0.022, 2)
    # east: rot -90, local t is +X outward, so the matrix x is the INNER face
    r = L.panel("pent_wall_e", PENT_D, PENT_ULH, PENT_TH, [], MAT["Plaster"])
    place(r, M((x1 - PENT_TH, PENT_Y + PENT_D / 2, up_z0), math.radians(-90)))
    objs["pent_wall_e"] = member(r, MAT["Plaster"], 0.022, 2)
    # west: rot +90, local t is -X outward, so the matrix x is the INNER face
    lf = L.panel("pent_wall_w", PENT_D, PENT_ULH, PENT_TH,
                 [(0.52, 0.98, 0.36, 0.80)], MAT["Plaster"])
    place(lf, M((x0 + PENT_TH, PENT_Y - PENT_D / 2, up_z0), math.radians(90)))
    objs["pent_wall_w"] = member(lf, MAT["Plaster"], 0.022, 2)
    objs["pent_ceil"] = member(
        L.box("pent_ceil", (PENT_X, PENT_Y, up_z0 + PENT_ULH - 0.05),
              (PENT_W, PENT_D, 0.10), MAT["Earth"], smooth=30),
        MAT["Earth"], 0.010, 1, smooth=25)
    objs["pent_dark"] = member(
        L.box("pent_dark", (ox, PENT_Y + 0.12, up_z0 + 0.50),
              (0.88, 0.06, 0.60), MAT["Wood"], smooth=30),
        MAT["Wood"], 0.0, 1)
    # the door leaf standing ajar, so the stair head reads as an open doorway
    # rather than an unfinished hole in the shell
    for i, (dr, dx) in enumerate(((0.62, 0.0), (0.46, 0.30), (0.28, 0.60))):
        objs[f"pent_doorplank{i}"] = member(
            L.box(f"pent_doorplank{i}", (0, 0, 0), (0.19, 0.055, 1.02),
                  MAT["Wood"], smooth=32),
            MAT["Wood"], 0.006, 1, smooth=32)
        place(objs[f"pent_doorplank{i}"],
              M((ox + 0.30, y0 - 0.02 - dr * 0.5, up_z0 + 0.30))
              @ Matrix.Rotation(math.radians(58.0), 4, 'Z')
              @ Matrix.Rotation(math.radians(dx), 4, 'Y'))

    # lintel + jambs on the south opening, a small sill + grille on the west
    objs["pent_lintel"] = member(
        L.box("pent_lintel", (ox, y0 - 0.05, up_z0 + 0.71),
              (0.94, 0.16, 0.14), MAT["Wood"], smooth=32),
        MAT["Wood"], 0.012, 1, smooth=32)
    for sx in (-1, 1):
        objs[f"pent_jamb{'p' if sx > 0 else 'm'}"] = member(
            L.box(f"pent_jamb", (0, 0, 0), (0.12, 0.15, 0.68), MAT["Wood"], smooth=32),
            MAT["Wood"], 0.010, 1, smooth=32)
        objs[f"pent_jamb{'p' if sx > 0 else 'm'}"].data.transform(
            Matrix.Translation((ox + sx * 0.40, y0 - 0.05, up_z0 + 0.44)))
    wy = PENT_Y - PENT_D / 2 + 0.75
    objs["pent_sill_w"] = member(
        L.box("pent_sill_w", (x0 - 0.02, wy, up_z0 + 0.34),
              (0.18, 0.58, 0.07), MAT["Stone"], smooth=30),
        MAT["Stone"], 0.012, 1)
    for i, gz in enumerate((up_z0 + 0.48, up_z0 + 0.66)):
        objs[f"pent_grille{i}"] = member(
            L.box(f"pent_grille", (0, 0, 0), (0.035, 0.44, 0.035), MAT["Iron"],
                  smooth=40),
            MAT["Iron"], 0.0, 1, smooth=40)
        objs[f"pent_grille{i}"].data.transform(
            Matrix.Translation((x0 + PENT_TH / 2, wy, gz)))

    # Cap + thin coping only.  The chamber used to carry a timber cornice as
    # well, which from the front elevation read as a stack of three plates on
    # a box -- the same stacked-band problem the hall fascia was fixed for.
    objs["pent_cap"] = member(
        L.box("pent_cap", (PENT_X, PENT_Y, up_z0 + PENT_ULH + 0.07),
              (PENT_W + 0.10, PENT_D + 0.10, 0.12), MAT["Mudbrick"], smooth=30),
        MAT["Mudbrick"], 0.020, 2)
    objs["pent_cope"] = member(
        L.box("pent_cope", (PENT_X, PENT_Y, up_z0 + PENT_ULH + 0.16),
              (PENT_W + 0.18, PENT_D + 0.18, 0.06), MAT["Stone"], smooth=30),
        MAT["Stone"], 0.014, 1)
    return objs
