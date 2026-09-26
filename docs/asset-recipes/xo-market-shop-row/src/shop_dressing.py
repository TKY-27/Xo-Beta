"""Dressing passes for the pass-3 desert shop row: pottery, produce, interiors,
the borrowed lantern, and the soft goods that stop the shell reading as a
blockout.

Every profile here is a control list authored for this pass.  Nothing is traced
from the reference market hall.
"""

from __future__ import annotations

import math
import os

import bpy
from mathutils import Matrix, Vector

import shop_lib as L

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


# ------------------------------------------------------------------- pottery
JAR_TALL = [(0.00, 0.000), (0.135, 0.000), (0.150, 0.060), (0.196, 0.230),
            (0.208, 0.360), (0.176, 0.520), (0.118, 0.640), (0.104, 0.700),
            (0.126, 0.730), (0.126, 0.762), (0.096, 0.766), (0.000, 0.766)]
JAR_ROUND = [(0.00, 0.000), (0.118, 0.000), (0.132, 0.048), (0.190, 0.150),
             (0.198, 0.238), (0.150, 0.330), (0.086, 0.380), (0.092, 0.404),
             (0.076, 0.408), (0.000, 0.408)]
JAR_AMPHORA = [(0.00, 0.000), (0.078, 0.000), (0.092, 0.070), (0.150, 0.300),
               (0.158, 0.520), (0.112, 0.720), (0.070, 0.830), (0.082, 0.856),
               (0.062, 0.860), (0.000, 0.860)]
JAR_SQUAT = [(0.00, 0.000), (0.150, 0.000), (0.166, 0.040), (0.214, 0.130),
             (0.206, 0.196), (0.150, 0.244), (0.140, 0.262), (0.000, 0.262)]
BOWL = [(0.00, 0.000), (0.058, 0.000), (0.062, 0.020), (0.104, 0.062),
        (0.126, 0.112), (0.134, 0.140), (0.126, 0.142), (0.112, 0.118),
        (0.090, 0.074), (0.052, 0.032), (0.000, 0.026)]
DISH = [(0.00, 0.000), (0.096, 0.000), (0.104, 0.014), (0.170, 0.044),
        (0.192, 0.066), (0.184, 0.070), (0.160, 0.052), (0.092, 0.026),
        (0.000, 0.020)]


def jar(reg, mats, xy, z, scale=1.0, tag="jar", kind="tall", segs=14, yaw=0.0,
        scallop=0.0):
    prof = {"tall": JAR_TALL, "round": JAR_ROUND, "amphora": JAR_AMPHORA,
            "squat": JAR_SQUAT}[kind]
    p = [(r * scale, zz * scale) for r, zz in prof]
    return reg("Clay", L.lathe(f"{tag}", p, mats["Clay"], grp="Props", segs=segs,
                               angle=44.0, scallop=scallop, oval=(1.0, 0.94),
                               loc=(xy[0], xy[1], z), yaw=yaw))


def bowl_stack(reg, mats, xy, z, count, tag, segs=12, scale=1.0, yaw=0.0):
    out = []
    for i in range(count):
        p = [(r * scale, zz * scale) for r, zz in BOWL]
        out.append(reg("Clay", L.lathe(f"{tag}_{i}", p, mats["Clay"], grp="Props",
                                       segs=segs, angle=44.0,
                                       loc=(xy[0], xy[1], z + i * 0.036 * scale),
                                       yaw=yaw + i * 0.21)))
    return out


def jar_shelf(reg, mats, xy, z, count, tag, spacing=0.19, scale=1.0):
    kinds = ("round", "squat", "tall", "amphora", "round", "squat")
    for i in range(count):
        jar(reg, mats, (xy[0] + i * spacing, xy[1] + 0.02 * (i % 2)), z,
            scale * (0.78 + 0.14 * (i % 3)), f"{tag}_{i}", kinds[i % len(kinds)],
            segs=12, yaw=0.4 * i)


def water_butt(reg, mats, xy, z, height, tag, segs=16):
    r = height * 0.34
    prof = [(0.00, 0.0), (r * 0.86, 0.0), (r, height * 0.10), (r * 1.03, height * 0.52),
            (r * 0.96, height * 0.88), (r * 1.05, height * 0.94),
            (r * 1.05, height), (r * 0.86, height), (0.0, height * 0.86)]
    return reg("Clay", L.lathe(tag, prof, mats["Clay"], grp="Props", segs=segs,
                               angle=44.0, scallop=0.035,
                               loc=(xy[0], xy[1], z)))


# ------------------------------------------------------------------- interiors
def interiors(reg, mats, C):
    """Shelves, hearth, prep table, hanging goods, storage bench."""
    Tm, S, Ir = mats["Timber"], mats["Stone"], mats["Iron"]
    yfi, ybi = -1.17, 1.17

    # --- shop interior (west bay): storage bench, shelf rack, sacks, hanging pot
    reg("Mudbrick", L.hexa("bench_base", (-3.10, 0.62, 0.045), (-0.60, 1.16, 0.56),
                           mats["Mudbrick"]))
    reg("Timber", L.hexa("bench_top", (-3.16, 0.56, 0.56), (-0.54, 1.17, 0.63), Tm))
    for zz in (0.86, 1.36, 1.86):
        reg("Timber", L.hexa(f"rack_shelf_{int(zz*100)}", (-3.12, 0.80, zz),
                             (-0.62, 1.16, zz + 0.045), Tm))
        for cx in (-3.02, -1.90, -0.74):
            reg("Timber", L.beam(f"rack_bracket_{int(zz*100)}_{int((cx+3.2)*10)}",
                                 (cx, 1.14, zz - 0.30), (cx, 0.84, zz - 0.01),
                                 0.055, 0.055, Tm, grp="Props", up=(0, 0, 1)))
    jar_shelf(reg, mats, (-2.94, 0.92), 0.905, 5, "rack_jar0", 0.24, 0.86)
    jar_shelf(reg, mats, (-2.30, 0.90), 1.405, 4, "rack_jar1", 0.22, 0.78)
    jar_shelf(reg, mats, (-1.50, 0.92), 1.905, 4, "rack_jar2", 0.20, 0.70)
    for i in range(4):
        reg("Grain", L.grid_block(f"sack_{i}", (-3.02 + i * 0.42, 0.66, 0.63),
                                  (-2.68 + i * 0.42, 1.02, 0.63 + 0.30 - 0.05 * (i % 2)),
                                  (2, 2, 1), mats["Grain"], grp="Props", jitter=0.045,
                                  seed=7 + i))
    reg("Iron", L.tube("hook_shop", [(-1.90, 0.98, 2.28), (-1.90, 0.98, 2.14)], 0.011, Ir,
                       grp="Props", segs=6))
    jar(reg, mats, (-1.90, 0.98), 1.86, 0.92, "shop_hang_pot", "squat", 12)

    # --- stall interior (east bay): hearth, prep table, shelving
    reg("Mudbrick",
        L.wall("hearth", 0.44, 1.44, 0.045, 0.86, 0.30, 1.10, [
            {"u0": 0.62, "u1": 1.26, "v0": 0.10, "v1": 0.54, "depth": 0.46}],
            mats["Mudbrick"]),
        L.hexa("hearth_backfill", (0.62, 0.86, 0.10), (1.26, 1.10, 0.54), mats["Mudbrick"]),
    )
    reg("Stone", L.hexa("hearth_top", (0.36, 0.22, 0.86), (1.52, 1.18, 0.95), S))
    reg("Iron",
        L.hexa("hearth_grate", (0.66, 0.30, 0.20), (1.22, 0.36, 0.235), Ir),
        L.hexa("hearth_grate2", (0.66, 0.30, 0.42), (1.22, 0.36, 0.455), Ir),
    )
    for i in range(3):
        reg("Timber", L.hexa(f"hearth_log_{i}", (0.70 + i * 0.02, 0.44 + i * 0.05, 0.24),
                             (1.18, 0.52 + i * 0.05, 0.28), Tm))
    reg("Flame", L.hexa("hearth_embers", (0.68, 0.38, 0.235), (1.20, 0.80, 0.30),
                        mats["Flame"]))
    for zz in (1.28, 1.78, 2.28):
        reg("Timber", L.hexa(f"stall_shelf_{int(zz*100)}", (1.70, 0.86, zz),
                             (3.14, ybi, zz + 0.045), Tm))
        for cx in (1.80, 2.44, 3.06):
            reg("Timber", L.beam(f"stall_bracket_{int(zz*100)}_{int(cx*10)}",
                                 (cx, 1.14, zz - 0.28), (cx, 0.90, zz - 0.01),
                                 0.05, 0.05, Tm, grp="Props", up=(0, 0, 1)))
    jar_shelf(reg, mats, (1.80, 0.98), 1.325, 4, "stall_jar0", 0.22, 0.80)
    bowl_stack(reg, mats, (2.90, 0.98), 1.325, 5, "stall_bowls0", 12, 0.92)
    for i in range(3):
        reg("Grain", L.grid_block(f"stall_sack_{i}", (1.80 + i * 0.40, 0.92, 1.825),
                                  (2.10 + i * 0.40, 1.14, 1.825 + 0.24),
                                  (2, 2, 1), mats["Grain"], grp="Props", jitter=0.035,
                                  seed=21 + i))
    jar_shelf(reg, mats, (1.86, 0.98), 2.325, 3, "stall_jar1", 0.20, 0.68)
    # Prep table.
    reg("Timber",
        L.hexa("prep_top", (1.62, 0.18, 0.90), (2.92, 0.80, 0.96), Tm),
        L.hexa("prep_shelf", (1.68, 0.22, 0.34), (2.86, 0.76, 0.38), Tm),
    )
    for cx in (1.70, 2.84):
        for cy in (0.26, 0.72):
            reg("Timber", L.hexa("prep_leg_%0.2f_%0.2f" % (cx, cy), (cx - 0.035, cy - 0.035, 0.045),
                                 (cx + 0.035, cy + 0.035, 0.90), Tm))
    bowl_stack(reg, mats, (1.86, 0.50), 0.96, 4, "prep_bowls", 12, 0.88, yaw=0.3)
    reg("Timber", L.hexa("rolling_pin", (2.14, 0.30, 0.96), (2.46, 0.40, 1.00), Tm),
        L.hexa("pin_handle", (2.46, 0.33, 0.975), (2.62, 0.37, 0.99), Tm))
    for i in range(4):
        reg("Iron", L.hexa(f"knife_blade_{i}", (2.66 + i * 0.035, 0.34, 0.96),
                           (2.70 + i * 0.035, 0.38, 1.18 - i * 0.02), Ir))
    reg("Timber", L.hexa("knife_block", (2.62, 0.28, 0.96), (2.86, 0.44, 1.06), Tm))

    # Hanging goods off the hatch head beam.
    for i, (hx, depth) in enumerate(((0.86, 7), (1.20, 6), (2.44, 8), (2.80, 5))):
        top = 2.16
        bot = top - depth * 0.085
        reg("Rope", L.tube(f"hang_rope_{i}", [(hx, -1.36, top), (hx, -1.36, bot + 0.05)],
                           0.007, mats["Rope"], grp="Props", segs=5))
        for k in range(depth):
            f = k / max(1, depth - 1.0)
            ang = 1.1 * k
            reg("Fruit",
                L.lathe(f"chilli_{i}_{k}",
                        [(0.0, 0.0), (0.012, 0.02), (0.016, 0.06), (0.010, 0.10), (0.0, 0.12)],
                        mats["Fruit"], grp="Props", segs=6, angle=60.0,
                        loc=(hx + 0.020 * math.sin(ang) * (0.3 + f),
                             -1.36 - 0.022 * f - 0.014 * (k % 2),
                             bot - 0.05 - k * 0.062),
                        yaw=0.4 * k))
    for i, hx in enumerate((1.62, 3.00)):
        reg("Rope", L.tube(f"onion_string_{i}", [(hx, -1.36, 2.16), (hx, -1.36, 1.86)],
                           0.007, mats["Rope"], grp="Props", segs=5))
        for k in range(6):
            reg("Grain", L.lathe(f"onion_{i}_{k}",
                                 [(0.0, 0.0), (0.022, 0.014), (0.036, 0.044), (0.030, 0.072),
                                  (0.012, 0.086), (0.0, 0.088)], mats["Grain"],
                                 grp="Props", segs=7, angle=60.0,
                                 loc=(hx + 0.034 * math.cos(k * 2.1) * 0.4,
                                      -1.36 - 0.030 * math.sin(k * 2.1) * 0.4,
                                      1.86 - 0.03 - k * 0.055)))
    reg("Iron", L.tube("hang_pan_hook", [(1.94, -1.36, 2.16), (1.94, -1.36, 2.02)], 0.008,
                       Ir, grp="Props", segs=5))
    reg("Iron", L.lathe("hang_pan", [(0.0, 0.0), (0.075, 0.005), (0.115, 0.030),
                                     (0.150, 0.075), (0.156, 0.090), (0.140, 0.092),
                                     (0.128, 0.078), (0.096, 0.040), (0.060, 0.018),
                                     (0.0, 0.014)], Ir, grp="Props", segs=14, angle=48.0,
                        loc=(1.94, -1.36, 1.82)))
    reg("Iron", L.tube("strainer_hook", [(2.14, -1.36, 2.16), (2.14, -1.36, 2.00)], 0.008,
                       Ir, grp="Props", segs=5))
    reg("Rope", L.lathe("strainer", [(0.0, 0.0), (0.070, 0.010), (0.092, 0.050),
                                     (0.096, 0.090), (0.082, 0.092), (0.078, 0.052),
                                     (0.058, 0.016), (0.0, 0.010)], mats["Rope"],
                       grp="Props", segs=12, angle=48.0, loc=(2.14, -1.36, 1.78)))

    # Rear storage door ajar on strap hinges, plus its threshold.
    d0, d1, _, dtop = C["RW_DOOR"]
    reg("Stone", L.hexa("rw_threshold", (d0 - 0.06, 1.11, 0.0), (d1 + 0.06, 1.24, 0.10),
                        mats["Stone"]))
    ang = math.radians(-22.0)
    hinge = (d0 + 0.02, 1.20)
    for i in range(5):
        px = 0.10 + i * 0.176
        reg("Timber",
            L.boxc(f"rw_leaf_{i}",
                   (hinge[0] + px * math.cos(ang), hinge[1] - px * math.sin(ang),
                    dtop * 0.5), (0.168, 0.042, dtop - 0.06), Tm, grp="Props", yaw=-ang))
    for zz in (0.34, 1.02, 1.72):
        reg("Timber",
            L.boxc("rw_ledge_%d" % int(zz * 10),
                   (hinge[0] + 0.44 * math.cos(ang), hinge[1] - 0.44 * math.sin(ang), zz),
                   (0.88 * math.cos(ang) + 0.06, 0.032, 0.10), Tm, grp="Props", yaw=-ang))
    for zz in (0.34, 1.72):
        reg("Iron", L.tube("rw_hinge_%d" % int(zz * 10),
                           [(hinge[0] - 0.06, hinge[1], zz - 0.05),
                            (hinge[0] + 0.16 * math.cos(ang),
                             hinge[1] - 0.16 * math.sin(ang), zz - 0.05)], 0.015, Ir,
                           grp="Props", segs=6))
    reg("Iron", L.hexa("rw_padlock", (1.02, 1.16, 0.98), (1.10, 1.24, 1.10), Ir))


# ---------------------------------------------------------------- counter wear
def counter_dressing(reg, mats, C):
    """Everything a working food stall leaves on and under its counter."""
    S, Tm, R = mats["Stone"], mats["Timber"], mats["Rope"]
    hy0, hy1, hv0, hv1 = C["HATCH"]

    # Bread tray: a stone slab with four flat loaves.
    reg("Stone", L.hexa("bread_tray", (0.66, -1.42, hv0 + 0.12), (1.20, -1.02, hv0 + 0.17),
                        S))
    for i in range(4):
        reg("Grain", L.lathe(f"flatbread_{i}",
                             [(0.0, 0.0), (0.098, 0.006), (0.122, 0.026), (0.124, 0.040),
                              (0.104, 0.050), (0.070, 0.056), (0.0, 0.058)],
                             mats["Grain"], grp="Props", segs=12, angle=48.0,
                             loc=(0.78 + (i % 2) * 0.28, -1.34 + (i // 2) * 0.24,
                                  hv0 + 0.17),
                             yaw=0.3 * i, oval=(1.0, 0.86)))
    bowl_stack(reg, mats, (1.42, -1.22), hv0 + 0.12, 5, "counter_bowls", 12, 0.94)
    # Produce crates under the counter, and a woven basket of greens.
    for i, cx in enumerate((1.72, 2.34)):
        crate(reg, mats, cx, -1.48, 0.0, "crate_%d" % i, seed=3 + i)
    basket(reg, mats, (2.62, -1.34), hv0 + 0.12, "basket", 0.20, 0.16)
    for i in range(11):
        a = i * 2.399
        rr = 0.135 * math.sqrt((i % 5) / 4.0)
        key = "Leaf" if i % 3 else "Fruit"
        reg(key, L.lathe(f"produce_counter_{i}",
                         [(0.0, 0.0), (0.036, 0.022), (0.048, 0.052), (0.040, 0.080),
                          (0.018, 0.096), (0.0, 0.100)], mats[key], grp="Props", segs=8,
                         angle=60.0,
                         loc=(2.62 + rr * math.cos(a), -1.34 + rr * math.sin(a) * 0.8,
                              hv0 + 0.20 + 0.02 * (i % 2))))
    # Water churn and a ladle on the counter.
    water_butt(reg, mats, (2.98, -1.26), hv0 + 0.12, 0.30, "counter_churn", 12)
    reg("Iron", L.tube("ladle_stem", [(1.60, -1.16, hv0 + 0.14), (1.86, -1.30, hv0 + 0.16),
                                     (1.94, -1.34, hv0 + 0.15)], 0.010, mats["Iron"],
                       grp="Props", segs=6))
    reg("Iron", L.lathe("ladle_bowl", [(0.0, 0.0), (0.030, 0.004), (0.050, 0.022),
                                       (0.052, 0.036), (0.044, 0.036), (0.040, 0.022),
                                       (0.024, 0.008), (0.0, 0.006)], mats["Iron"],
                        grp="Props", segs=10, angle=50.0, loc=(1.58, -1.14, hv0 + 0.12)))
    # Rope-tied bundle of herbs hung off the counter edge.
    reg("Rope", L.tube("herb_tie", [(1.24, -1.14, hv0 + 0.10), (1.24, -1.14, hv0 - 0.06)],
                       0.008, R, grp="Props", segs=5))
    for k in range(9):
        ang2 = k * 2.1
        reg("Leaf", L.lathe(f"herb_{k}",
                            [(0.0, 0.0), (0.014, 0.03), (0.020, 0.08), (0.012, 0.14),
                             (0.0, 0.17)], mats["Leaf"], grp="Props", segs=6, angle=60.0,
                            loc=(1.24 + 0.030 * math.cos(ang2), -1.14 + 0.030 * math.sin(ang2),
                                 hv0 - 0.06 - 0.012 * (k % 3))))


def crate(reg, mats, cx, cy, z, tag, seed=1, w=0.52, d=0.40, h=0.30):
    Tm = mats["Timber"]
    t = 0.022
    for i in range(2):
        zz = z + 0.05 + i * 0.11
        for cy2 in (cy - d * .5 + 0.012, cy + d * .5 - 0.012):
            reg("Timber", L.hexa(f"{tag}_side_{i}_{cy2:.2f}", (cx - w * .5, cy2 - t, zz),
                                 (cx + w * .5, cy2 + t, zz + 0.08), Tm))
        for cx2 in (cx - w * .5 + 0.012, cx + w * .5 - 0.012):
            reg("Timber", L.hexa(f"{tag}_end_{i}_{cx2:.2f}", (cx2 - t, cy - d * .5, zz),
                                 (cx2 + t, cy + d * .5, zz + 0.08), Tm))
    for (a, b) in (((cx - w * .5, cy - d * .5), (cx + w * .5, cy - d * .5)),
                   ((cx - w * .5, cy + d * .5), (cx + w * .5, cy + d * .5)),
                   ((cx - w * .5, cy - d * .5), (cx - w * .5, cy + d * .5)),
                   ((cx + w * .5, cy - d * .5), (cx + w * .5, cy + d * .5))):
        reg("Timber", L.hexa(f"{tag}_post_{a[0]:.2f}_{b[1]:.2f}",
                             (a[0] - 0.028, a[1] - 0.028, z),
                             (a[0] + 0.028, b[1] + 0.028, z + h), Tm))
    reg("Timber", L.hexa(f"{tag}_floor", (cx - w * .5, cy - d * .5, z),
                         (cx + w * .5, cy + d * .5, z + 0.035), Tm))
    for i in range(7):
        a = i * 2.399
        rr = 0.16 * math.sqrt(i / 6.0)
        key = "Leaf" if i % 3 else "Fruit"
        reg(key, L.lathe(f"{tag}_prod_{i}",
                         [(0.0, 0.0), (0.042, 0.026), (0.056, 0.062), (0.046, 0.096),
                          (0.020, 0.116), (0.0, 0.120)], mats[key], grp="Props", segs=8,
                         angle=60.0,
                         loc=(cx + rr * math.cos(a), cy + rr * math.sin(a) * 0.8,
                              z + 0.05 + 0.015 * (i % 2))))


def basket(reg, mats, xy, z, tag, r=0.20, h=0.16):
    R, Tm = mats["Rope"], mats["Timber"]
    prof = [(r * 0.62, 0.0), (r * 0.70, 0.012), (r * 0.86, h * 0.5), (r, h),
            (r * 0.94, h + 0.012), (r * 0.80, h * 0.5), (r * 0.64, 0.016)]
    reg("Rope", L.lathe(tag, prof, R, grp="Props", segs=14, angle=52.0,
                        loc=(xy[0], xy[1], z), scallop=0.02))
    for i in range(7):
        a = i * 0.897
        reg("Rope", L.tube(f"{tag}_weave_{i}",
                           [(xy[0] + r * 0.66 * math.cos(a), xy[1] + r * 0.66 * math.sin(a),
                             z + 0.012),
                            (xy[0] + r * 0.99 * math.cos(a), xy[1] + r * 0.99 * math.sin(a),
                             z + h + 0.006)], 0.008, R, grp="Props", segs=5))
    reg("Timber", L.hexa(f"{tag}_handle_l", (xy[0] - 0.012, xy[1] - r * 0.5, z + h),
                         (xy[0] + 0.012, xy[1] + r * 0.5, z + h + 0.014), Tm))
    reg("Timber", L.hexa(f"{tag}_handle_r", (xy[0] - r * 0.5, xy[1] - 0.012, z + h),
                         (xy[0] + r * 0.5, xy[1] + 0.012, z + h + 0.014), Tm))


def exterior_dressing(reg, mats, C):
    """Pottery, produce and soft goods on the street side of the row."""
    S, Tm, R = mats["Stone"], mats["Timber"], mats["Rope"]
    r0, r1, _, _ = C["RECESS"]
    jar(reg, mats, (r0 - 0.42, -2.22), 0.0, 1.0, "entry_jar_l", "tall", 16, yaw=0.5)
    jar(reg, mats, (r1 + 0.46, -2.16), 0.0, 0.86, "entry_jar_r", "amphora", 14, yaw=1.9)
    bowl_stack(reg, mats, (r1 + 0.42, -2.20), 0.0, 6, "entry_bowls", 12, 1.0, yaw=0.7)
    # A stone kerb ramp and a swept pile of sand at the entrance.
    reg("Stone", L.hexa("entry_step", (r0 - 0.30, -2.32, 0.0), (r1 + 0.30, -1.94, 0.05), S))
    reg("Ground", L.hexa("entry_sweep", (-1.80, -2.74, 0.02), (-0.60, -2.32, 0.075),
                         mats["Ground"]))
    # Eastern end: a stack of pots and a covered water jar on a stone plinth.
    reg("Stone", L.hexa("east_plinth", (3.16, -1.86, 0.0), (3.52, -1.34, 0.16), S))
    jar(reg, mats, (3.34, -1.60), 0.16, 0.78, "east_jar_a", "round", 14, yaw=0.9)
    jar(reg, mats, (3.34, -1.60), 0.16 + 0.35, 0.62, "east_jar_b", "squat", 12, yaw=2.4)
    crate(reg, mats, 3.06, -2.34, 0.0, "east_crate", seed=11)
    # Firewood and a water skin against the west return.
    for i in range(6):
        reg("Timber", L.hexa("west_stack_%d" % i,
                             (C["XW"] - 0.26 + (i % 2) * 0.20, -1.78 + (i // 2) * 0.19, 0.0),
                             (C["XW"] - 0.06 + (i % 2) * 0.20, -1.60 + (i // 2) * 0.19,
                              0.15 - (i % 2) * 0.05), Tm))
    # A rug thrown over the counter edge, and a rolled second rug on the parapet.
    reg("Cloth",
        L.skin("counter_rug", 14, 8,
               lambda i, j: (0.90 + i * 0.20,
                             -1.16 - j * 0.016 - 0.012 * math.sin(i * 0.9),
                             1.02 - j * 0.115 - 0.02 * math.sin(i * 1.7)),
               mats["Cloth"], grp="Props", thick=0.010),
    )
    reg("Cloth",
        L.skin("door_rug", 12, 8,
               lambda i, j: (C["RECESS"][0] + 0.16 + i * 0.075,
                             -2.44 + j * 0.020,
                             0.02 + 0.014 * math.sin(i * 0.8 + j * 0.5)),
               mats["Cloth"], grp="Props", thick=0.009),
    )
    # Awning-hung price board and a bell on an iron hook.
    reg("Timber", L.hexa("awn_price_board", (2.06, -3.62, 1.46), (2.72, -3.58, 1.74), Tm))
    reg("Iron",
        L.tube("awn_price_chain_a", [(2.14, -3.60, 1.90), (2.14, -3.60, 1.74)], 0.008, R,
               grp="Props", segs=5),
        L.tube("awn_price_chain_b", [(2.64, -3.60, 1.90), (2.64, -3.60, 1.74)], 0.008, R,
               grp="Props", segs=5),
        L.lathe("stall_bell", [(0.0, 0.0), (0.052, 0.010), (0.070, 0.052), (0.076, 0.090),
                               (0.084, 0.096), (0.076, 0.100), (0.062, 0.056),
                               (0.044, 0.016), (0.0, 0.010)], mats["Iron"], grp="Props",
                    segs=12, angle=50.0, loc=(1.44, -3.44, 1.62)),
        L.tube("bell_hook", [(1.44, -3.44, 1.99), (1.44, -3.44, 1.72)], 0.008,
               mats["Iron"], grp="Props", segs=5),
    )


# ------------------------------------------------------------------- donor
def import_lantern(x, y, z, scale=0.135):
    """Place the one borrowed asset: the Poly Haven brass Diya lantern.

    The donor arrives as three separate meshes at 12.7k triangles, which is a
    fifth of this whole row, so it is decimated and joined before it is placed.
    The ratios are printed and recorded in PROVENANCE.md; the silhouette is
    kept, the tiny filigree is not.  Returns True on success.  The caller has
    already authored a fallback bracket, so a missing donor is a cosmetic loss
    rather than a build break."""
    src = os.path.join(ROOT, "donor", "brass_diya_lantern_1k.glb")
    if not os.path.exists(src):
        return False
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=src)
    except Exception as exc:                                # pragma: no cover
        print("LANTERN_IMPORT_ERROR", exc, flush=True)
        return False
    new = [o for o in bpy.data.objects if o not in before]
    if not new:
        return False

    meshes = [o for o in new if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    for o in meshes:
        n = len(o.data.polygons)
        ratio = 0.40 if "connection" in o.name else 0.22
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        m = o.modifiers.new("lancut", 'DECIMATE')
        m.ratio = ratio
        bpy.ops.object.modifier_apply(modifier=m.name)
        print("LANTERN_DECIMATE %-28s %6d -> %6d faces (ratio %.2f)"
              % (o.name, n, len(o.data.polygons), ratio), flush=True)
    bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    bpy.ops.object.shade_auto_smooth(angle=math.radians(52.0))

    src_root = bpy.data.objects.new("donor_lantern", None)
    src_root.empty_display_type = 'PLAIN_AXES'
    src_root.empty_display_size = 0.15
    L.group("Donor").objects.link(src_root)
    body.parent = src_root
    bpy.context.view_layer.update()
    src_root.matrix_world = (Matrix.Translation((x, y, z))
                             @ Matrix.Diagonal((scale, scale, scale, 1.0)))

    # The donor ships two brass materials (arm and body) built from the same
    # JPEG.  Fold them into one slot so the GLB does not carry the map twice.
    brass = None
    for m in list(bpy.data.materials):
        nm = m.name
        if not nm.startswith("brass_diya_lantern"):
            continue
        if "glass" in nm or "flame" in nm:
            m.name = "XO3_DonorGlass" if "glass" in nm else "XO3_DonorFlame"
            continue
        if brass is None:
            m.name = "XO3_DonorBrass"
            brass = m
        else:
            for i, slot in enumerate(body.data.materials):
                if slot is m:
                    body.data.materials[i] = brass
            bpy.data.materials.remove(m)
    seen = []
    while True:                       # drop slots that repeat a material
        slots = list(body.data.materials)
        dupe = next((i for i, m in enumerate(slots) if m in seen), None)
        if dupe is None:
            break
        seen = [m for i, m in enumerate(slots) if i != dupe]
        body.data.materials.pop(index=dupe)
    # The importer gave the surviving brass material a second copy of the same
    # JPEG under a .001 name; point it back at the original so the GLB carries
    # the map once.
    for img in list(bpy.data.images):
        if img.name.endswith(".001") and img.name[:-4] in bpy.data.images:
            for m in bpy.data.materials:
                if not m.use_nodes:
                    continue
                for n in m.node_tree.nodes:
                    if n.type == 'TEX_IMAGE' and n.image is img:
                        n.image = bpy.data.images[img.name[:-4]]
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.delete_loose()
    bpy.ops.object.mode_set(mode='OBJECT')
    body.name = "donor_lantern_body"
    body.data.name = "donor_lantern_body"
    src_root["xo_asset"] = "Poly Haven brass Diya lantern, decimated"
    src_root["xo_licence"] = "CC0-1.0 (see PROVENANCE.md)"
    src_root["xo_note"] = "the only borrowed mesh in this asset"
    print("LANTERN_PLACED tris=%d mats=%s" % (len(body.data.polygons),
          [m.name for m in body.data.materials]), flush=True)
    return True


def tidy_donor_images():
    """The glTF importer can load the same donor JPEG once per material.  Drop
    the copies no node references so the GLB carries one of each."""
    used = set()
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image is not None:
                used.add(n.image.name)
    dropped = 0
    for img in list(bpy.data.images):
        if img.name not in used:
            bpy.data.images.remove(img)
            dropped += 1
    bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True,
                                   do_recursive=True)
    print("IMAGES_TIDY kept=%d dropped=%d" % (len(bpy.data.images), dropped),
          flush=True)
