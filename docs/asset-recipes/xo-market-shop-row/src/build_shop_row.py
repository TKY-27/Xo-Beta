"""Build the pass-3 modular desert shop row: two bays, authored geometry.

Massing
-------
A linear street-front row, 7.80 m of frontage on a 0.78 m thick adobe shell.
West bay is a closed shop entered through a doorway recessed half a metre into
the wall; east bay is an open food stall with a 2.5 m serving hatch, a stone
counter and a slatted timber awning.  A 0.72 m pier divides them and carries the
lantern bracket.  Parapet language changes at the pier: plain coping-capped
parapet over the shop, merloned parapet over the stall.

Run:  blender -b --factory-startup --python src/build_shop_row.py
"""

from __future__ import annotations

import json
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import shop_lib as L          # noqa: E402
import shop_materials as MT   # noqa: E402
import shop_dressing          # noqa: E402

# ------------------------------------------------------------------ dimensions
T = 0.78                                  # adobe wall thickness
XW, XE = -3.90, 3.90                      # main block, outer X
YF, YB = -1.95, 1.95                      # main block, outer Y
YFI, YBI = YF + T, YB - T                 # inner faces  (-1.17 / 1.17)
XWI, XEI = XW + T, XE - T                 # -3.12 / 3.12

PIER_MID = 0.30                           # roof step / bay divider
PIER_W = 0.72
DECK_A, DECK_B = 3.05, 2.82               # roof deck levels (variation)
PARAPET_H, COPE_H = 0.25, 0.07

BAY_A = (XW, PIER_MID)                    # closed shop
BAY_B = (PIER_MID, XE)                    # open food stall
PIER = (PIER_MID - PIER_W, PIER_MID)      # -0.42 .. 0.30

# Bay A openings
WIN_A = (-3.20, -2.66, 1.04, 1.88)                    # front aperture
WIN_A_IN = (-3.34, -2.52, 0.90, 2.02)                 # flared inner aperture
RECESS = (-2.44, -1.06, 0.0, 2.46)                    # recess mouth
RECESS_D = 0.50
DOOR = (-2.28, -1.22, 0.02, 2.08)                     # doorway in the back plate
NICHE = (-0.86, -0.50, 0.96, 1.72)                    # blind niche
NICHE_IN = (-0.76, -0.60, 1.06, 1.62)

# Bay B openings
HATCH = (0.56, 3.04, 0.90, 2.18)                      # serving hatch
COUNTER = (0.44, 3.16, 0.90, 1.02)                    # stone counter slab band
SCUPPER = (2.72, 2.90)                                # notch in the counter

# Rear wall openings
RW_WIN = (-2.20, -1.40, 1.90, 2.50)
RW_WIN_IN = (-2.30, -1.30, 1.80, 2.60)
RW_DOOR = (1.30, 2.24, 0.0, 2.02)
RW_VENT = (0.10, 0.52, 2.22, 2.62)

# Awning
AW_LEDGER_Z = 2.55
AW_OUT_Y = -3.14
AW_OUT_Z = 2.12
AW_RAFTERS = (0.62, 1.81, 3.00)
AW_SLATS = 22
AW_X0, AW_X1 = 0.44, 3.20

PARTS: dict[str, list] = {}
KEYS = ("Plaster", "Mudbrick", "Timber", "Stone", "Clay", "Cloth", "Iron",
        "Rope", "Earth", "Ground", "Leaf", "Fruit", "Grain", "Flame", "Glass")

C = {"XW": XW, "XE": XE, "YF": YF, "YB": YB, "T": T, "RECESS": RECESS,
     "HATCH": HATCH, "RW_DOOR": RW_DOOR, "DECK_A": DECK_A, "DECK_B": DECK_B}


def reg(mat_key, *obs):
    """Register geometry under a material key.  Accepts single objects, lists of
    objects, or a mix, so helpers that fan out into several members (the opening
    flares, for instance) can be handed straight in."""
    flat = []
    for o in obs:
        if o is None:
            continue
        if isinstance(o, (list, tuple)):
            flat.extend([x for x in o if x is not None])
        else:
            flat.append(o)
    PARTS.setdefault(mat_key, []).extend(flat)
    return flat[0] if len(flat) == 1 else flat


# ================================================================= shell
def build_shell(mats):
    P, M, S = mats["Plaster"], mats["Mudbrick"], mats["Stone"]

    reg("Plaster",
        L.wall("front_west_bay", XW, PIER_MID, 0.0, DECK_A, YF, YFI, [
            {"u0": WIN_A_IN[0], "u1": WIN_A_IN[1], "v0": WIN_A_IN[2],
             "v1": WIN_A_IN[3], "depth": T},
            {"u0": RECESS[0], "u1": RECESS[1], "v0": RECESS[2], "v1": RECESS[3],
             "depth": RECESS_D},
            {"u0": DOOR[0], "u1": DOOR[1], "v0": DOOR[2], "v1": DOOR[3],
             "depth": T},
            {"u0": NICHE[0], "u1": NICHE[1], "v0": NICHE[2], "v1": NICHE[3],
             "depth": 0.30},
        ], P),
        L.wall("front_east_bay", PIER_MID, XE, 0.0, DECK_B, YF, YFI, [
            {"u0": HATCH[0], "u1": HATCH[1], "v0": HATCH[2], "v1": HATCH[3],
             "depth": T},
        ], P),
    )
    reg("Plaster",
        L.splay("win_flare_a", WIN_A, WIN_A_IN, YF, YFI, P),
        L.splay("niche_taper_a", NICHE, NICHE_IN, YF, YF + 0.30, P),
    )

    reg("Mudbrick",
        L.wall("rear_west_bay", XW, PIER_MID, 0.0, DECK_A, YBI, YB, [
            {"u0": RW_WIN_IN[0], "u1": RW_WIN_IN[1], "v0": RW_WIN_IN[2],
             "v1": RW_WIN_IN[3], "depth": T},
            {"u0": RW_DOOR[0], "u1": RW_DOOR[1], "v0": RW_DOOR[2], "v1": RW_DOOR[3],
             "depth": T},
        ], M),
        L.wall("rear_east_bay", PIER_MID, XE, 0.0, DECK_B, YBI, YB, [
            {"u0": RW_VENT[0], "u1": RW_VENT[1], "v0": RW_VENT[2], "v1": RW_VENT[3],
             "depth": 0.14},
        ], M),
        L.batter("end_wall_west", ((XW, XWI), (YFI, YB)), (0.0, DECK_A), 0.075, M),
        L.batter("end_wall_east", ((XEI, XE), (YFI, YB)), (0.0, DECK_B), 0.075, M),
        L.batter("buttress_west", ((XW - 0.28, XW), (-0.60, 0.30)), (0.0, 2.10), 0.10, M),
        L.batter("buttress_east", ((XE, XE + 0.28), (0.40, 1.10)), (0.0, 1.95), 0.10, M),
        L.wall("bay_divider", PIER[0] + 0.24, PIER[1] - 0.24, 0.0, DECK_B,
               YFI, YBI, [], M),
    )
    reg("Mudbrick", L.splay("rw_win_flare", RW_WIN, RW_WIN_IN, YBI, YB, M))

    # Floor slabs: the two interiors plus the recess threshold.
    reg("Earth",
        L.hexa("floor_shop", (XWI + 0.02, YFI, 0.0), (PIER[1] - 0.24, YBI, 0.045), mats["Earth"]),
        L.hexa("floor_stall", (PIER[0] + 0.24, YFI, 0.0), (XEI - 0.02, YBI, 0.045), mats["Earth"]),
    )
    reg("Stone",
        L.hexa("door_threshold", (-2.40, YF - 0.06, 0.0), (-1.10, YFI + 0.04, 0.11), S),
    )


# ============================================================ shop entrance
def build_entrance(mats):
    P, S, Tm, Ir = mats["Plaster"], mats["Stone"], mats["Timber"], mats["Iron"]
    r0, r1, _, rz = RECESS

    # Plaster pilasters flanking the recess mouth, projecting 90 mm proud.
    for tag, x0, x1 in (("l", r0 - 0.19, r0), ("r", r1, r1 + 0.19)):
        reg("Plaster",
            L.batter(f"pilaster_{tag}", ((x0, x1), (YF - 0.09, YF + 0.10)),
                     (0.0, 2.92), 0.022, P),
            L.hexa(f"pilaster_cap_{tag}", (x0 - 0.03, YF - 0.12, 2.92),
                   (x1 + 0.03, YF + 0.10, 3.02), P),
        )
    # Stone reveal linings inside the recess returns: a proper thick-wall read.
    reg("Stone",
        L.hexa("recess_jamb_l", (r0 - 0.035, YF, 0.0), (r0 + 0.075, YF + RECESS_D, rz - 0.06), S),
        L.hexa("recess_jamb_r", (r1 - 0.075, YF, 0.0), (r1 + 0.035, YF + RECESS_D, rz - 0.06), S),
        L.hexa("recess_soffit", (r0, YF, rz - 0.06), (r1, YF + RECESS_D, rz + 0.055), S),
    )
    # Door lintel and jamb linings set back inside the reveal.
    d0, d1, dv0, dv1 = DOOR
    reg("Timber",
        L.hexa("door_lintel", (d0 - 0.05, YF + 0.34, dv1 - 0.02),
               (d1 + 0.05, YF + T, dv1 + 0.20), Tm),
        L.hexa("door_jamb_l", (d0 - 0.045, YF + 0.34, 0.0), (d0 + 0.03, YF + T, dv1), Tm),
        L.hexa("door_jamb_r", (d1 - 0.03, YF + 0.34, 0.0), (d1 + 0.045, YF + T, dv1), Tm),
    )
    reg("Stone",
        L.hexa("door_sill", (d0, YF + RECESS_D - 0.02, 0.03), (d1, YF + T, 0.12), S),
    )
    # A batten door hanging open into the recess on two iron strap hinges.
    ang = math.radians(58.0)
    for i in range(5):
        px = d0 + 0.035 + i * 0.196
        cy = YFI - 0.10
        cz = 1.10
        hx = px + 0.092 * math.cos(ang)
        hy = cy - 0.092 * math.sin(ang)
        reg("Timber",
            L.boxc(f"door_leaf_{i}", (hx, hy, cz), (0.184, 0.038, 2.00),
                   Tm, grp="Props", yaw=-ang),
        )
    for zz in (0.42, 1.62):
        reg("Timber",
            L.boxc("door_ledge_%d" % int(zz * 10),
                   (d0 + 0.10 * 0 + 0.50 * math.cos(ang), YFI - 0.10 - 0.50 * math.sin(ang), zz),
                   (0.96 * math.cos(ang) + 0.05, 0.030, 0.11), Tm, grp="Props", yaw=-ang),
        )
    for zz in (0.42, 1.62):
        reg("Iron",
            L.tube("door_hinge_%d" % int(zz * 10),
                   [(d0 + 0.02, YFI - 0.10, zz - 0.07), (d0 + 0.16 * math.cos(ang),
                    YFI - 0.10 - 0.16 * math.sin(ang), zz - 0.07)], 0.017, Ir,
                   grp="Props", segs=6),
        )
    # Slatted timber hood over the recess mouth.
    hood_x0, hood_x1 = r0 - 0.24, r1 + 0.24
    hy0, hy1 = YF, -2.56
    reg("Timber",
        L.hexa("hood_ledger", (hood_x0, hy0, 2.60), (hood_x1, hy0 + 0.14, 2.76), Tm),
    )
    n_hood = 6
    for i in range(n_hood):
        cx = hood_x0 + 0.10 + i * (hood_x1 - hood_x0 - 0.20) / (n_hood - 1)
        reg("Timber",
            L.beam(f"hood_slat_{i}", (cx, hy0 + 0.04, 2.55), (cx, hy1, 2.32),
                   0.115, 0.034, Tm, grp="Props", up=(0, 0, 1)),
        )
    for cx in (hood_x0 + 0.10, hood_x1 - 0.10):
        reg("Timber",
            L.beam("hood_arm_%0.2f" % cx, (cx, hy0 + 0.05, 2.50), (cx, hy1 + 0.04, 2.30),
                   0.085, 0.115, Tm, grp="Props", up=(0, 0, 1)),
        )
        reg("Iron",
            L.tube("hood_tie_%0.2f" % cx, [(cx, hy1 - 0.02, 2.36), (cx, hy0 - 0.03, 2.86)],
                   0.011, Ir, grp="Props", segs=6),
        )
    reg("Cloth",
        L.skin("hood_cloth", 26, 8,
               lambda i, j: (
                   hood_x0 + 0.16 + i * (hood_x1 - hood_x0 - 0.32) / 26.0,
                   (hy0 + 0.10) + j / 8.0 * (-2.42 - (hy0 + 0.10)),
                   2.545 - j / 8.0 * 0.215
                   - 0.026 * math.sin(math.pi * ((i % 6) / 6.0)) * (j / 8.0),
               ), mats["Cloth"], grp="Props", thick=0.010),
    )


# ================================================================== window
def build_window(mats):
    Tm, Ir, S = mats["Timber"], mats["Iron"], mats["Stone"]
    f0, f1, v0, v1 = WIN_A
    i0, i1, w0, w1 = WIN_A_IN

    reg("Stone",
        L.hexa("win_sill", (f0 - 0.10, YF - 0.09, v0 - 0.10), (f1 + 0.10, YF + 0.16, v0), S),
        L.hexa("win_head", (f0 - 0.05, YF + 0.02, v1), (f1 + 0.05, YF + 0.22, v1 + 0.08), S),
    )
    # Reveal lining boards inside the flare.
    for tag, a, b, c, d in (("l", i0, f0, w0, v0), ("r", f1, i1, v1, w1)):
        reg("Timber",
            L.hexa(f"win_jamb_{tag}", (a + 0.012, YF + 0.02, c), (b - 0.012, YF + T, d), Tm),
        )
    reg("Timber",
        L.hexa("win_reveal_sill", (i0 + 0.02, YF + 0.02, w0 + 0.012),
               (i1 - 0.02, YF + T, v0 - 0.012), Tm),
        L.hexa("win_reveal_head", (i0 + 0.02, YF + 0.02, v1 + 0.012),
               (i1 - 0.02, YF + T, w1 - 0.012), Tm),
    )
    # Shutter: four boards plus two ledges, hinged on the left jamb, standing
    # open against the facade so the aperture reads as a working opening.
    ang = math.radians(104.0)
    hinge = (f0, YF - 0.03)
    for i in range(4):
        zz = v0 + 0.03 + i * ((v1 - v0 - 0.06) / 4.0)
        cx = hinge[0] + 0.44 * math.cos(ang)
        cy = hinge[1] - 0.44 * math.sin(ang)
        reg("Timber",
            L.boxc(f"shutter_board_{i}", (cx, cy, zz + (v1 - v0) / 8.0),
                   (0.86, 0.032, (v1 - v0) / 4.0 - 0.018), Tm, grp="Props", yaw=-ang),
        )
    for k in (0.18, 0.70):
        reg("Timber",
            L.boxc(f"shutter_ledge_{int(k*10)}",
                   (hinge[0] + (0.44 + k * 0.5) * math.cos(ang),
                    hinge[1] - (0.44 + k * 0.5) * math.sin(ang), (v0 + v1) * 0.5),
                   (0.30, 0.030, v1 - v0 + 0.10), Tm, grp="Props", yaw=-ang),
        )
    reg("Iron",
        L.tube("shutter_hinge", [(f0 + 0.02, YF - 0.03, v0 + 0.05),
                                 (f0 + 0.02, YF - 0.03, v1 - 0.05)], 0.014, Ir,
               grp="Props", segs=6),
        L.tube("shutter_stay", [(hinge[0] + 0.80 * math.cos(ang),
                                 hinge[1] - 0.80 * math.sin(ang), v1 - 0.06),
                                (hinge[0] + 0.86 * math.cos(ang),
                                 hinge[1] - 0.86 * math.sin(ang), v0 + 0.10)],
               0.010, Ir, grp="Props", segs=6),
    )
    # Interior shelf visible through the aperture.
    reg("Timber",
        L.hexa("win_shelf", (f0 - 0.06, YF + 0.30, 1.18), (f1 + 0.30, YF + 1.10, 1.23), Tm),
    )
    shop_dressing.jar_shelf(reg, mats, (f0 + 0.02, YF + 0.40), 1.23, 3, "win")


# =================================================================== niche
def build_niche(mats):
    P, S, Ir = mats["Plaster"], mats["Stone"], mats["Iron"]
    n0, n1, v0, v1 = NICHE
    i0, i1, w0, w1 = NICHE_IN
    reg("Stone",
        L.hexa("niche_sill", (n0 - 0.04, YF - 0.05, v0 - 0.055), (n1 + 0.04, YF + 0.30, v0), S),
    )
    reg("Timber",
        L.hexa("niche_ledge", (n0 + 0.02, YF + 0.06, 1.12), (n1 - 0.02, YF + 0.27, 1.16),
               mats["Timber"]),
    )
    reg("Iron",
        L.tube("niche_oil_lamp_hook", [(0.5 * (n0 + n1), YF + 0.16, 1.10),
                                       (0.5 * (n0 + n1), YF + 0.16, 1.04)], 0.008, Ir,
               grp="Props", segs=6),
    )
    shop_dressing.bowl_stack(reg, mats, (0.5 * (n0 + n1) - 0.02, YF + 0.16), 1.16, 4, "niche")


# ================================================================ food stall
def build_stall(mats):
    P, Tm, S, Ir, Cl = (mats["Plaster"], mats["Timber"], mats["Stone"],
                        mats["Iron"], mats["Cloth"])
    h0, h1, hv0, hv1 = HATCH

    # Timber lining frame inside the 780 mm reveal, then a head beam set back.
    for tag, a, b, c, d in (("l", h0, h0 + 0.055, hv0, hv1), ("r", h1 - 0.055, h1, hv0, hv1)):
        reg("Timber", L.hexa(f"hatch_jamb_{tag}", (a, YF + 0.03, c), (b, YFI - 0.02, d), Tm))
    reg("Timber",
        L.hexa("hatch_sill_lining", (h0, YF + 0.03, hv0), (h1, YFI - 0.02, hv0 + 0.05), Tm),
        L.hexa("hatch_head_lining", (h0, YF + 0.03, hv1 - 0.05), (h1, YFI - 0.02, hv1), Tm),
        L.beam("hatch_head_beam", (h0 - 0.12, YFI - 0.20, hv1 - 0.02),
               (h1 + 0.12, YFI - 0.20, hv1 + 0.19), 0.19, 0.20, Tm, grp="Props", up=(0, 1, 0)),
    )
    for cx in (h0 + 0.22, 1.60, 2.60, h1 - 0.22):
        reg("Timber",
            L.beam("hatch_spur_%0.2f" % cx, (cx, YFI - 0.10, hv1 - 0.01),
                   (cx, YF + 0.05, hv1 + 0.13), 0.075, 0.10, Tm, grp="Props", up=(0, 1, 0)),
        )
    # Dwarf wall render: a proud plaster band under the counter.
    reg("Plaster",
        L.hexa("counter_apron", (h0 - 0.08, YF - 0.055, 0.0), (h1 + 0.08, YF + 0.02, hv0 - 0.02), P),
    )
    for i in range(3):
        bx = 0.98 + i * 0.84
        reg("Timber",
            L.hexa(f"apron_batten_{i}", (bx - 0.045, YF - 0.085, 0.16),
                   (bx + 0.045, YF - 0.045, hv0 - 0.10), Tm))
    reg("Stone",
        L.hexa("apron_plinth", (h0 - 0.10, YF - 0.075, 0.0), (h1 + 0.10, YF - 0.02, 0.17), S))
    # Counter slab in two pieces so a scupper notch survives in the middle.
    c0, c1, _, ctop = COUNTER
    sa, sb = SCUPPER
    reg("Stone",
        L.hexa("counter_slab_a", (c0, YF - 0.13, hv0 - 0.02), (sa, YFI + 0.02, ctop), S),
        L.hexa("counter_slab_b", (sb, YF - 0.13, hv0 - 0.02), (c1, YFI + 0.02, ctop), S),
    )
    for cx in (c0 + 0.34, c1 - 0.34):
        reg("Timber",
            L.beam("counter_bracket_%0.2f" % cx, (cx, YF - 0.10, hv0 - 0.34),
                   (cx, YF + 0.30, hv0 - 0.03), 0.085, 0.13, Tm, grp="Props", up=(0, 1, 0)),
        )
    # Propped shutter panel leaning at the east end of the hatch.
    ang = math.radians(16.0)
    cx0, cz0 = h1 - 0.16, 1.02
    reg("Timber",
        L.boxc("stall_shutter", (cx0, YF - 0.30, cz0), (0.60, 0.040, 1.10), Tm,
               grp="Props", yaw=ang),
    )
    # stile-and-rail frame + a diagonal brace: three boards alone read as a slab
    for dz in (-0.50, 0.0, 0.50):
        reg("Timber",
            L.boxc("stall_shutter_rail_%0.2f" % dz, (cx0, YF - 0.325, cz0 + dz),
                   (0.64, 0.036, 0.095), Tm, grp="Props", yaw=ang))
    for dx in (-0.265, 0.265):
        reg("Timber",
            L.boxc("stall_shutter_stile_%0.2f" % dx, (cx0 + dx, YF - 0.325, cz0),
                   (0.075, 0.036, 1.14), Tm, grp="Props", yaw=ang))
    reg("Timber",
        L.beam("stall_shutter_brace", (cx0 - 0.24, YF - 0.332, cz0 - 0.47),
               (cx0 + 0.24, YF - 0.332, cz0 + 0.47), 0.075, 0.030, Tm,
               grp="Props", up=(0, 1, 0), roll=ang))
    # Hanging signboard on two iron chains.
    sx, sz = 1.62, 1.62
    reg("Timber",
        L.hexa("sign_board", (sx - 0.58, YF - 0.30, sz - 0.02), (sx + 0.58, YF - 0.25, sz + 0.40), Tm),
        L.hexa("sign_board_batten", (sx - 0.60, YF - 0.32, sz - 0.04),
               (sx + 0.60, YF - 0.23, sz + 0.42), Tm),
    )
    reg("Timber", L.hexa("sign_batten", (sx - 0.54, YF - 0.07, 2.24),
                         (sx + 0.54, YF - 0.01, 2.33), Tm))
    for dx in (-0.42, 0.42):
        reg("Iron",
            L.tube("sign_chain_%0.2f" % dx,
                   [(sx + dx, YF - 0.04, 2.28), (sx + dx * 0.92, YF - 0.275, sz + 0.40)],
                   0.011, Ir, grp="Props", segs=6),
        )


# =================================================================== awning
def build_awning(mats):
    Tm, Ir, Cl = mats["Timber"], mats["Iron"], mats["Cloth"]
    y_in, z_in = YF + 0.01, AW_LEDGER_Z - 0.05

    reg("Timber", L.hexa("awn_ledger", (AW_X0 - 0.04, YF - 0.16, AW_LEDGER_Z - 0.09),
                         (AW_X1 + 0.04, YF + 0.02, AW_LEDGER_Z + 0.09), Tm))
    for i, cx in enumerate(AW_RAFTERS):
        reg("Timber",
            L.beam("awn_rafter_%d" % i, (cx, y_in, z_in), (cx, AW_OUT_Y, AW_OUT_Z),
                   0.095, 0.145, Tm, grp="Props", up=(0, 0, 1)),
        )
    for j, yy in enumerate((-2.70, -2.32)):
        t = (y_in - yy) / (y_in - AW_OUT_Y)
        reg("Timber",
            L.hexa("awn_purlin_%d" % j, (AW_X0, yy - 0.045, z_in - t * (z_in - AW_OUT_Z) - 0.10),
                   (AW_X1, yy + 0.045, z_in - t * (z_in - AW_OUT_Z)), Tm),
        )
    reg("Timber",
        L.hexa("awn_outer_rail", (AW_X0 - 0.05, AW_OUT_Y - 0.06, AW_OUT_Z - 0.07),
               (AW_X1 + 0.05, AW_OUT_Y + 0.06, AW_OUT_Z + 0.07), Tm),
    )
    # Slats: two spans each with a 15 mm droop, so the canopy is not a flat grid.
    span = (AW_X1 - AW_X0) / (AW_SLATS - 1)
    for i in range(AW_SLATS):
        cx = AW_X0 + i * span
        mid = (y_in + AW_OUT_Y) * 0.5
        zm = (z_in + AW_OUT_Z) * 0.5 - 0.015
        reg("Timber",
            L.beam(f"awn_slat_{i}a", (cx, y_in, z_in), (cx, mid, zm), 0.078, 0.027, Tm,
                   grp="Props", up=(0, 0, 1)),
            L.beam(f"awn_slat_{i}b", (cx, mid, zm), (cx, AW_OUT_Y, AW_OUT_Z), 0.078, 0.027,
                   Tm, grp="Props", up=(0, 0, 1)),
        )
    # Posts, footings, knee braces, iron tie rods back to the parapet.
    for i, cx in enumerate((AW_RAFTERS[0], AW_RAFTERS[2])):
        reg("Stone", L.hexa(f"awn_footing_{i}", (cx - 0.17, AW_OUT_Y - 0.16, 0.0),
                            (cx + 0.17, AW_OUT_Y + 0.16, 0.08), mats["Stone"]))
        reg("Timber", L.hexa(f"awn_post_{i}", (cx - 0.058, AW_OUT_Y - 0.058, 0.08),
                             (cx + 0.058, AW_OUT_Y + 0.058, AW_OUT_Z + 0.05), Tm))
        reg("Timber",
            L.beam(f"awn_knee_{i}", (cx, AW_OUT_Y + 0.04, AW_OUT_Z - 0.50),
                   (cx, AW_OUT_Y + 0.78, z_in - 0.10), 0.062, 0.085, Tm, grp="Props",
                   up=(0, 0, 1)),
        )
        reg("Iron",
            L.tube(f"awn_tie_{i}", [(cx, AW_OUT_Y + 0.02, AW_OUT_Z + 0.04),
                                    (cx, y_in + 0.10, AW_LEDGER_Z + 0.34)], 0.013, Ir,
                   grp="Props", segs=6),
        )
    reg("Timber",
        L.hexa("awn_drip_strip", (AW_X0 - 0.07, AW_OUT_Y - 0.15, AW_OUT_Z - 0.15),
               (AW_X1 + 0.07, AW_OUT_Y - 0.05, AW_OUT_Z - 0.07), Tm),
    )
    # Cloth over the eastern bays only, sagging between rafters.
    c0, c1 = 1.86, AW_X1 + 0.02
    bay = (AW_RAFTERS[1] - AW_RAFTERS[0]) / 2.0

    def cloth_pt(i, j):
        fy = j / 20.0
        y = y_in + fy * (AW_OUT_Y - y_in)
        z = z_in + fy * (AW_OUT_Z - z_in) + 0.045
        x = c0 + i * (c1 - c0) / 40.0
        local = ((x - AW_RAFTERS[0]) % (bay * 2.0)) / (bay * 2.0)
        # catenary between rafters, deepest at mid-bay and growing toward the
        # drip edge, plus a slack crease running down the slope
        sag = 0.105 * math.sin(math.pi * local) ** 0.72 * (0.28 + 0.72 * fy)
        crease = 0.020 * math.sin(fy * 6.4 + x * 2.3) * math.sin(math.pi * local)
        lift = 0.055 * fy ** 3.0 * math.sin(math.pi * local)
        return (x, y, z - sag - crease + lift)

    reg("Cloth", L.skin("awn_cloth", 40, 20, cloth_pt, Cl, grp="Props", thick=0.013))
    for cx in AW_RAFTERS:
        fy = 0.06
        y = y_in + fy * (AW_OUT_Y - y_in)
        z = z_in + fy * (AW_OUT_Z - z_in) + 0.045
        reg("Rope", L.tube("awn_lash_%0.2f" % cx,
                           [(cx - 0.10, y, z), (cx + 0.10, y, z + 0.02)], 0.011,
                           mats["Rope"], grp="Props", segs=6))


# ================================================================ roof + top
def build_roof(mats):
    M, S, Tm, Ir = mats["Mudbrick"], mats["Stone"], mats["Timber"], mats["Iron"]

    def deck(tag, x0, x1, z, thick=0.17):     # mud screed over packed earth
        pts_b = [(x0, YF, z - thick), (x1, YF, z - thick),
                 (x1, YB, z - thick - 0.07), (x0, YB, z - thick - 0.07)]
        pts_t = [(x0, YF, z), (x1, YF, z), (x1, YB, z - 0.07), (x0, YB, z - 0.07)]
        reg("Earth", L.prism(f"roof_deck_{tag}", pts_b, pts_t, mats["Earth"]))

    deck("a", XW, PIER_MID, DECK_A)
    deck("b", PIER_MID, XE, DECK_B)

    def parapet(tag, x0, x1, z):
        reg("Mudbrick",
            L.hexa(f"parapet_{tag}_front", (x0, YF, z), (x1, YF + 0.30, z + PARAPET_H), M),
            L.hexa(f"parapet_{tag}_rear", (x0, YB - 0.30, z - 0.07), (x1, YB, z + PARAPET_H - 0.07), M),
        )
        reg("Stone",
            L.hexa(f"cope_{tag}_front", (x0 - 0.03, YF - 0.035, z + PARAPET_H),
                   (x1 + 0.03, YF + 0.335, z + PARAPET_H + COPE_H), S),
            L.hexa(f"cope_{tag}_rear", (x0 - 0.03, YB - 0.335, z + PARAPET_H - 0.07),
                   (x1 + 0.03, YB + 0.035, z + PARAPET_H + COPE_H), S),
        )

    parapet("a", XW, PIER_MID, DECK_A)
    parapet("b", PIER_MID, XE, DECK_B)
    for tag, x0, x1, top in (("w", XW, XWI, DECK_A), ("e", XEI, XE, DECK_B)):
        reg("Mudbrick", L.hexa(f"parapet_{tag}_end", (x0, YF, DECK_A - 0.035),
                               (x1, YB, top + PARAPET_H), M))

    # Merlons: the stall parapet is crenellated, the shop parapet is not.
    for i in range(4):
        cx = 0.72 + i * 0.70
        reg("Mudbrick", L.hexa(f"merlon_{i}", (cx - 0.17, YF - 0.02, DECK_B + PARAPET_H),
                               (cx + 0.17, YF + 0.32, DECK_B + PARAPET_H + 0.22), M))
    # Corbelled joist ends front and back.
    for i, cx in enumerate((-3.40, -2.72, -1.62, -0.62)):
        reg("Timber", L.hexa(f"corbel_a_f{i}", (cx - 0.075, YF - 0.22, DECK_A - 0.19),
                             (cx + 0.075, YF, DECK_A), Tm))
        reg("Timber", L.hexa(f"corbel_a_b{i}", (cx - 0.075, YB, DECK_A - 0.26),
                             (cx + 0.075, YB + 0.20, DECK_A - 0.07), Tm))
    for i, cx in enumerate((0.74, 1.58, 2.42, 3.26)):
        reg("Timber", L.hexa(f"corbel_b_f{i}", (cx - 0.075, YF - 0.22, DECK_B - 0.19),
                             (cx + 0.075, YF, DECK_B), Tm))
        reg("Timber", L.hexa(f"corbel_b_b{i}", (cx - 0.075, YB, DECK_B - 0.26),
                             (cx + 0.075, YB + 0.20, DECK_B - 0.07), Tm))
    reg("Timber",
        L.hexa("fascia_a", (XW, YF - 0.05, DECK_A - 0.20), (PIER_MID, YF, DECK_A - 0.04), Tm),
        L.hexa("fascia_b", (PIER_MID, YF - 0.05, DECK_B - 0.20), (XE, YF, DECK_B - 0.04), Tm),
    )
    # Roof hatch with a propped cover.
    reg("Mudbrick",
        L.hexa("hatch_curb_l", (-2.66, 0.16, DECK_A - 0.07), (-2.52, 1.02, DECK_A + 0.30), M),
        L.hexa("hatch_curb_r", (-1.72, 0.16, DECK_A - 0.07), (-1.58, 1.02, DECK_A + 0.30), M),
        L.hexa("hatch_curb_b", (-2.66, 0.88, DECK_A - 0.07), (-1.58, 1.02, DECK_A + 0.30), M),
    )
    reg("Timber",
        L.boxc("hatch_cover", (-2.10, 0.40, DECK_A + 0.46), (0.92, 0.045, 0.74), Tm,
               grp="Props", tilt=math.radians(33.0)),
    )
    for dx in (-0.46, 0.46):
        reg("Iron", L.tube("hatch_stay_%0.2f" % dx,
                           [(-2.10 + dx, 0.52, DECK_A + 0.86),
                            (-2.10 + dx, 0.80, DECK_A + 0.20)], 0.012, Ir,
                           grp="Props", segs=6))
    # Pigeon loft on the stall roof.
    reg("Mudbrick",
        L.wall("loft_front", 2.18, 2.98, DECK_B - 0.07, DECK_B + 0.62, 0.30, 0.46,
               [{"u0": 2.40, "u1": 2.76, "v0": DECK_B + 0.14, "v1": DECK_B + 0.50,
                 "depth": 0.16}], M),
        L.hexa("loft_back", (2.18, 0.86, DECK_B - 0.07), (2.98, 1.02, DECK_B + 0.62), M),
        L.hexa("loft_west", (2.18, 0.30, DECK_B - 0.07), (2.32, 1.02, DECK_B + 0.62), M),
        L.hexa("loft_east", (2.84, 0.30, DECK_B - 0.07), (2.98, 1.02, DECK_B + 0.62), M),
        L.hexa("loft_cap", (2.12, 0.24, DECK_B + 0.62), (3.04, 1.08, DECK_B + 0.72), M),
    )
    reg("Timber", L.hexa("loft_landing", (2.36, 0.08, DECK_B + 0.10), (2.80, 0.32, DECK_B + 0.14), Tm),
        L.hexa("loft_perch", (2.50, 0.20, DECK_B + 0.14), (2.66, 0.34, DECK_B + 0.17), Tm),
        L.hexa("loft_ledge", (2.22, 0.26, DECK_B + 0.44), (2.94, 0.34, DECK_B + 0.48), Tm))
    # entry hole: a short sleeve plus a dark void behind it
    reg("Timber", L.tube("loft_hole_sleeve", [(2.55, 0.30, DECK_B + 0.50),
                                              (2.55, 0.47, DECK_B + 0.50)], 0.115, mats["Clay"],
                          grp="Props", segs=12))
    reg("Clay", L.hexa("loft_hole_void", (2.44, 0.44, DECK_B + 0.40),
                       (2.66, 0.47, DECK_B + 0.60), mats["Clay"]))
    # Roof clutter: spare joists, spare blocks, a water jar, a rope coil.
    for i in range(4):
        reg("Timber", L.hexa(f"roof_joist_{i}", (-2.30 + i * 0.02, 0.92, DECK_A + i * 0.115),
                             (-1.24 + i * 0.02, 2.14, DECK_A + 0.10 + i * 0.115), Tm))
    for i in range(6):
        reg("Mudbrick", L.hexa(f"roof_brick_{i}", (0.66 + (i % 3) * 0.30, 1.16 + (i // 3) * 0.20,
                                                  DECK_B + (i // 3) * 0.11),
                               (0.90 + (i % 3) * 0.30, 1.32 + (i // 3) * 0.20,
                                DECK_B + 0.10 + (i // 3) * 0.11), M))
    shop_dressing.jar(reg, mats, (1.20, 1.44), DECK_B, 0.30, "roof_jar_a")
    shop_dressing.jar(reg, mats, (1.78, 1.30), DECK_B, 0.24, "roof_jar_b")
    reg("Rope", L.tube("roof_coil", [(2.30 + 0.30 * math.cos(a * 0.9),
                                      1.70 + 0.30 * math.sin(a * 0.9),
                                      DECK_B + 0.03 + 0.012 * (i // 6))
                                     for i, a in enumerate([i * 0.55 for i in range(12)])],
                       0.012, mats["Rope"], grp="Props", segs=6))


# ================================================================== boundary
def build_boundary(mats):
    M, S, Tm = mats["Mudbrick"], mats["Stone"], mats["Timber"]
    for tag, x0, x1 in (("w", XW - 0.44, XW), ("e", XE, XE + 0.44)):
        reg("Mudbrick", L.batter(f"bound_front_{tag}", ((x0, x1), (-2.62, YF)),
                                 (0.0, 0.98), 0.06, M))
        reg("Stone", L.hexa(f"bound_cope_{tag}", (x0 - 0.05, -2.68, 0.98),
                            (x1 + 0.05, YF + 0.02, 1.07), S))
    YRG = YB + 0.68
    for tag, x0, x1 in (("w", XW + 0.10, -2.30), ("e", 2.30, XE - 0.10)):
        reg("Mudbrick", L.batter(f"bound_rear_{tag}", ((x0, x1), (YRG, YRG + 0.36)),
                                 (0.0, 0.86), 0.05, M))
        reg("Stone", L.hexa(f"bound_rear_cope_{tag}", (x0 - 0.04, YRG - 0.05, 0.86),
                            (x1 + 0.04, YRG + 0.42, 0.94), S))
    reg("Timber",
        L.hexa("bound_gate_post_w", (-2.42, YRG, 0.0), (-2.20, YRG + 0.32, 1.28), Tm),
        L.hexa("bound_gate_post_e", (2.20, YRG, 0.0), (2.42, YRG + 0.32, 1.28), Tm),
        L.beam("bound_gate_head", (-2.30, YRG + 0.16, 1.30), (2.30, YRG + 0.16, 1.30),
               0.10, 0.14, Tm, grp="Props"),
    )
    # Ground: front apron split around the channel drain, plus the service yard.
    yA, yB2, yC, yD = -2.74, -2.52, -2.30, YF
    reg("Ground",
        L.hexa("apron_front_lip", (XW - 0.50, yA, -0.30), (XE + 0.50, yB2, 0.02), mats["Ground"]),
        L.hexa("apron_back_lip", (XW - 0.50, yC, -0.30), (XE + 0.50, yD, 0.02), mats["Ground"]),
        L.hexa("drain_floor", (XW - 0.50, yB2, -0.30), (XE + 0.50, yC, -0.105), mats["Stone"]),
        L.hexa("apron_kerb_l", (XW - 0.50, yB2, -0.30), (XW - 0.42, yC, 0.02), mats["Stone"]),
        L.hexa("apron_kerb_r", (XE + 0.42, yB2, -0.30), (XE + 0.50, yC, 0.02), mats["Stone"]),
        L.hexa("yard_slab", (XW - 0.50, YB, -0.30), (XE + 0.50, YRG + 0.36, 0.03),
               mats["Ground"]),
    )
    bars = 34
    for i in range(bars):
        cx = XW - 0.42 + i * ((XE - XW + 0.84) / (bars - 1))
        reg("Iron", L.hexa(f"drain_bar_{i}", (cx - 0.011, yB2 + 0.012, -0.028),
                           (cx + 0.011, yC - 0.012, 0.012), mats["Iron"]))
    for yy in (yB2 + 0.02, (yB2 + yC) * 0.5, yC - 0.02):
        reg("Iron", L.hexa("drain_rail_%0.2f" % yy, (XW - 0.44, yy - 0.011, -0.030),
                           (XE + 0.44, yy + 0.011, -0.012), mats["Iron"]))


# ================================================================= utilities
def build_utilities(mats):
    M, S, Tm, Ir, C = (mats["Mudbrick"], mats["Stone"], mats["Timber"],
                       mats["Iron"], mats["Clay"])
    # Terracotta downspout on the east return, discharging into a stone soak box.
    path = [(XE + 0.055, -0.10, DECK_B + 0.28), (XE + 0.055, -0.10, 0.46),
            (XE + 0.14, -0.10, 0.32), (XE + 0.27, -0.10, 0.36)]
    reg("Clay", L.tube("downspout", path, 0.076, C, grp="Props", segs=10))
    for zz in (0.72, 1.52, 2.28):
        reg("Iron", L.hexa(f"spout_strap_{int(zz*10)}", (XE - 0.01, -0.18, zz - 0.026),
                           (XE + 0.13, -0.02, zz + 0.026), Ir))
    reg("Clay", L.hexa("spout_hopper_l", (XE - 0.01, -0.33, DECK_B + 0.26),
                       (XE + 0.17, -0.14, DECK_B + 0.52), C),
        L.hexa("spout_hopper_b", (XE - 0.01, -0.06, DECK_B + 0.26),
               (XE + 0.17, 0.13, DECK_B + 0.52), C),
        L.hexa("spout_hopper_base", (XE - 0.01, -0.33, DECK_B + 0.20),
               (XE + 0.17, 0.13, DECK_B + 0.26), C))
    reg("Stone",
        L.wall("soak_box", XE + 0.16, XE + 0.62, 0.0, 0.30, -0.42, 0.22, [
            {"u0": XE + 0.24, "u1": XE + 0.54, "v0": 0.07, "v1": 0.30, "depth": 0.40}],
            S),
    )
    reg("Stone", L.hexa("soak_lintel", (XE + 0.16, -0.44, 0.30), (XE + 0.62, 0.24, 0.38), S))
    # Hose bib and a coiled hose on the east return.
    reg("Iron",
        L.tube("hose_bib", [(XE, -0.62, 0.92), (XE + 0.13, -0.62, 0.92),
                            (XE + 0.13, -0.62, 0.86)], 0.017, Ir, grp="Props", segs=7),
        L.hexa("bib_bracket", (XE - 0.01, -0.68, 0.86), (XE + 0.06, -0.56, 0.98), Ir),
    )
    coil = []
    for i in range(46):
        a = i * 0.30
        r = 0.20 - 0.055 * (i / 46.0)
        coil.append((XE + 0.10 + 0.02 * math.sin(a * 2.0),
                     -0.62 + r * math.cos(a) * 0.75,
                     0.80 - r * math.sin(a) * 1.05))
    reg("Iron", L.tube("hose_coil", coil, 0.013, Ir, grp="Props", segs=6))
    # Rear-wall utility: vent grille, iron service box, water butt and tap.
    for i in range(4):
        zz = RW_VENT[2] + 0.05 + i * 0.09
        reg("Iron", L.hexa(f"vent_bar_{i}", (RW_VENT[0] + 0.03, YB - 0.16, zz),
                           (RW_VENT[1] - 0.03, YB - 0.10, zz + 0.045), Ir))
    reg("Iron",
        L.hexa("utility_box", (0.82, YB - 0.13, 1.24), (1.12, YB - 0.01, 1.58), Ir),
        L.hexa("utility_lid", (0.79, YB - 0.16, 1.24), (1.15, YB - 0.11, 1.60), Ir),
        L.hexa("utility_latch", (0.94, YB - 0.19, 1.36), (1.00, YB - 0.13, 1.46), Ir),
    )
    reg("Timber",
        L.tube("yard_tap_stand", [(3.02, 2.36, 0.0), (3.02, 2.36, 0.62),
                                  (2.90, 2.36, 0.68)], 0.022, Tm, grp="Props", segs=7),
    )
    shop_dressing.water_butt(reg, mats, (2.62, 2.36), 0.03, 0.60, "butt")
    # Iron grille in the rear window.
    for i in range(5):
        cx = RW_WIN[0] + 0.09 + i * ((RW_WIN[1] - RW_WIN[0] - 0.18) / 4.0)
        reg("Iron", L.hexa(f"rw_bar_{i}", (cx - 0.014, YBI + 0.10, RW_WIN[2]),
                           (cx + 0.014, YBI + 0.16, RW_WIN[3]), Ir))
    for zz in (RW_WIN[2] + 0.06, RW_WIN[3] - 0.06):
        reg("Iron", L.hexa("rw_rail_%0.2f" % zz, (RW_WIN[0] + 0.04, YBI + 0.10, zz),
                           (RW_WIN[1] - 0.04, YBI + 0.16, zz + 0.035), Ir))
    # Rear yard lean-to: posts, rafters, purlins, a water jar and a wood pile.
    lx0, lx1, ly0, ly1 = -0.72, 1.02, YB, 2.92
    for cx in (lx0 + 0.10, lx1 - 0.10):
        reg("Timber", L.hexa("lean_post_%0.2f" % cx, (cx - 0.07, ly1 - 0.07, 0.03),
                             (cx + 0.07, ly1 + 0.07, 2.06), Tm))
    for i in range(6):
        cx = lx0 + 0.06 + i * (lx1 - lx0 - 0.12) / 5.0
        reg("Timber", L.beam("lean_rafter_%d" % i, (cx, ly0 + 0.02, 2.34),
                             (cx, ly1 + 0.10, 1.98), 0.075, 0.10, Tm, grp="Props",
                             up=(0, 0, 1)))
    for j in range(7):
        yy = ly0 + 0.12 + j * (ly1 - ly0 - 0.16) / 7.0
        t = (yy - ly0 - 0.02) / (ly1 - ly0 + 0.08)
        zt = 2.33 - t * 0.36
        reg("Timber", L.hexa("lean_slat_%d" % j, (lx0, yy - 0.085, zt + 0.052),
                             (lx1, yy + 0.085, zt + 0.104), Tm))
    shop_dressing.jar(reg, mats, (0.30, 2.48), 0.03, 0.34, "lean_jar")
    for i in range(9):
        reg("Timber", L.hexa("woodpile_log_%d" % i, (1.30 + (i % 3) * 0.20,
                                                    2.28 + (i // 3) * 0.19, 0.03),
                             (1.48 + (i % 3) * 0.20, 2.46 + (i // 3) * 0.19,
                              0.03 + (1.0 - (i % 3) * 0.18) * 0.11), Tm))
    # Ladder from the yard to the shop roof.
    for dx in (-0.20, 0.20):
        reg("Timber", L.beam("ladder_rail_%0.2f" % dx, (-2.62 + dx, 2.86, 0.0),
                             (-2.62 + dx, 1.86, DECK_A + 0.02), 0.055, 0.045, Tm,
                             grp="Props", up=(0, 1, 0)))
    for i in range(6):
        t = 0.06 + i * 0.16
        reg("Timber", L.hexa("ladder_rung_%d" % i,
                             (-2.86, 2.86 - t * 1.00 - 0.03, t * (DECK_A + 0.02)),
                             (-2.38, 2.86 - t * 1.00 + 0.03, t * (DECK_A + 0.02) + 0.035), Tm))
    # A wood stack and a lamp bracket on the west return.
    for i in range(8):
        reg("Timber", L.hexa("west_log_%d" % i,
                             (XW - 0.28 + (i % 2) * 0.19, -0.52 + (i // 2) * 0.20, 0.0),
                             (XW - 0.09 + (i % 2) * 0.19, -0.34 + (i // 2) * 0.20,
                              0.14 - (i % 2) * 0.05), Tm))


# ================================================================== lantern
def build_lantern(mats):
    Tm, Ir, Gl = mats["Timber"], mats["Iron"], mats["Glass"]
    bx = 0.05
    by = YF - 0.02
    reg("Iron",
        L.tube("lantern_stay", [(bx, by, 2.86), (bx, by, 2.30)], 0.016, Ir,
               grp="Props", segs=7),
        L.tube("lantern_bracket", [(bx, by, 2.60), (bx, by - 0.34, 2.60)], 0.014, Ir,
               grp="Props", segs=7),
        L.tube("lantern_hook", [(bx, by - 0.32, 2.62), (bx, by - 0.32, 2.50),
                                (bx, by - 0.26, 2.47)], 0.010, Ir, grp="Props", segs=6),
        L.tube("lantern_scroll_a", [(bx, by - 0.10, 2.36), (bx, by - 0.30, 2.40),
                                    (bx, by - 0.30, 2.52)], 0.009, Ir, grp="Props", segs=6),
    )
    reg("Timber",
        L.hexa("lantern_board", (bx - 0.20, by - 0.30, 2.78), (bx + 0.20, by - 0.26, 2.90), Tm),
    )
    L.tube("lantern_chain", [(bx, by - 0.30, 2.50), (bx, by - 0.30, 2.36)], 0.008, Ir,
           grp="Props", segs=6)

    donor = os.path.join(ROOT, "donor", "brass_diya_lantern_1k.glb")
    placed = shop_dressing.import_lantern(bx, by - 0.30, 2.36)
    print("LANTERN donor import:", "ok" if placed else "FAILED (fallback used)", donor, flush=True)


# ==================================================================== finish
# one texture tile per 1/scale metres of surface
UV_SCALE = {"Mudbrick": 1.70, "Plaster": 0.62, "Timber": 0.55, "Stone": 0.80,
            "Clay": 0.40, "Cloth": 0.75, "Earth": 0.45, "Ground": 0.30,
            "Iron": 1.0, "Rope": 1.0, "Leaf": 1.0, "Fruit": 1.0, "Grain": 1.0,
            "Flame": 1.0}

BEVEL = {"Timber": 0.008, "Stone": 0.008, "Iron": 0.006, "Clay": 0.006,
         "Ground": 0.0, "Leaf": 0.0, "Fruit": 0.0, "Grain": 0.0, "Flame": 0.0,
         "Rope": 0.0, "Earth": 0.0}


def dump_members(path):
    """Authored-member inventory: one line per generator output, in build order.
    This is the record of what was placed, not what survived the weld."""
    rows = []
    for key in KEYS:
        members = PARTS.get(key) or []
        for m in members:
            zs = [v.co.z for v in m.data.vertices]
            rows.append((key, m.name, len(m.data.vertices), len(m.data.polygons),
                         min(zs) if zs else 0.0, max(zs) if zs else 0.0))
    with open(path, "w") as fh:
        fh.write("# XO3 authored member inventory -- %d members\n" % len(rows))
        fh.write("# key\tname\tverts\tfaces\tzmin\tzmax\n")
        for r in rows:
            fh.write("%s\t%s\t%d\t%d\t%.3f\t%.3f\n" % r)
    print("MEMBERS %d" % len(rows), flush=True)


def merge_all(mats):
    out = {}
    dump_members(os.path.join(ROOT, "MEMBERS.txt"))
    for key in KEYS:
        members = PARTS.get(key) or []
        if not members:
            continue
        for m in members:
            zs = [v.co.z for v in m.data.vertices]
            if zs and min(zs) < -0.12:
                print("UNDERGRADE %s / %s  min z=%.3f" % (key, m.name, min(zs)))
        # Bevel each authored member on its own, then join.  Running the Bevel
        # solver once on the whole merged object is not reproducible: on some
        # runs the solver divides by an edge length that a weld of neighbouring
        # panels left behind and throws a vertex out to a billion metres, and
        # the guarded fallback then silently drops the bevel from one member of
        # the row and not the next.  Per-member bevels are deterministic and the
        # fallback is confined to a single part.
        for m in members:
            L.finish(m, bevel=BEVEL.get(key, 0.013), segs=1, angle=32.0, smooth=0.0)
        ob = L.merge(f"XO3_{key}", members, mats[key], grp="Merged")
        L.project_uv(ob, UV_SCALE.get(key, 0.62))   # merge() drops loop UVs
        L.weld(ob, 1.0e-5)
        L.auto_smooth(ob, 32.0)
        out[key] = ob
    return out


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.length_unit = 'METERS'

    mats = MT.build_all()
    build_shell(mats)
    build_entrance(mats)
    build_window(mats)
    build_niche(mats)
    build_stall(mats)
    build_awning(mats)
    build_roof(mats)
    build_boundary(mats)
    build_utilities(mats)
    build_lantern(mats)
    shop_dressing.interiors(reg, mats, C)
    shop_dressing.counter_dressing(reg, mats, C)
    shop_dressing.exterior_dressing(reg, mats, C)
    merged = merge_all(mats)

    # --- measure before anything is exported so the extras carry real numbers
    stats, tv, tf = {}, 0, 0
    lo, hi = [1e9] * 3, [-1e9] * 3
    for key, ob in merged.items():
        v, f = len(ob.data.vertices), len(ob.data.polygons)
        tv += v
        tf += f
        stats[key] = {"verts": v, "faces": f}
        for vert in ob.data.vertices:
            for i in range(3):
                lo[i] = min(lo[i], vert.co[i])
                hi[i] = max(hi[i], vert.co[i])
    span = [round(hi[i] - lo[i], 3) for i in range(3)]

    root = bpy.data.objects.new("XO_ShopRow", None)
    root.empty_display_type = 'ARROWS'
    root.empty_display_size = 0.8
    L.group("Merged").objects.link(root)
    for ob in merged.values():
        ob.parent = root
    root["xo_asset"] = "XO desert shop row -- authored pass 3, 2-bay"
    root["xo_front"] = "-Y"
    root["xo_units"] = "metres, Z-up in Blender / Y-up in glTF"
    root["xo_bounds_min"] = [round(x, 4) for x in lo]
    root["xo_bounds_max"] = [round(x, 4) for x in hi]
    root["xo_footprint_m"] = "%.2f wide x %.2f deep x %.2f tall" % tuple(span)
    root["xo_footprint_measured_m"] = span
    root["xo_wall_thickness_m"] = T
    root["xo_tris"] = tf
    root["xo_licence"] = "CC0 1.0 (see PROVENANCE.md)"
    root["xo_borrowed"] = "Poly Haven brass Diya lantern only (CC0)"

    os.makedirs(os.path.join(ROOT, "export"), exist_ok=True)
    shop_dressing.tidy_donor_images()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, "export", "shop_row.blend"))
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(ROOT, "export", "shop_row.glb"),
        export_format='GLB', export_apply=True, export_yup=True, export_extras=True,
        export_cameras=False, export_lights=False, export_materials='EXPORT')

    glb = os.path.join(ROOT, "export", "shop_row.glb")
    print("STATS %s" % json.dumps({"per_material": stats, "verts": tv, "faces": tf,
                                   "bounds_min": [round(x, 4) for x in lo],
                                   "bounds_max": [round(x, 4) for x in hi],
                                   "objects": len(merged),
                                   "glb_bytes": os.path.getsize(glb)}, sort_keys=True),
          flush=True)
    print("BUILD_OK", flush=True)


if __name__ == "__main__":
    main()
