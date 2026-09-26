"""Flag any authored member that sits outside the intended asset envelope."""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import market_lib as L
import market_materials as MM
import build_market as B

BOUND = dict(x=(-4.75, 4.75), y=(-4.75, 2.95), z=(-0.06, 5.45))


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MAT = MM.build_all()
    objs = {}
    for part in (B.build_shell(MAT), B.build_roof(MAT), B.build_facade(MAT),
                 B.build_openings(MAT), B.build_canopy(MAT), B.build_hardware(MAT),
                 B.build_stall(MAT)):
        objs.update(part if isinstance(part, dict) else {})
        if not isinstance(part, dict):
            for o in part:
                objs[o.name] = o
    bpy.context.view_layer.update()

    bad = 0
    for name, ob in sorted(objs.items()):
        pts = [ob.matrix_world @ v.co for v in ob.data.vertices]
        lo = [min(p[i] for p in pts) for i in range(3)]
        hi = [max(p[i] for p in pts) for i in range(3)]
        why = []
        for i, ax in enumerate("xyz"):
            if lo[i] < BOUND[ax][0] or hi[i] > BOUND[ax][1]:
                why.append(f"{ax}[{lo[i]:.2f},{hi[i]:.2f}]")
        if why:
            bad += 1
            print(f"OUT {name:34s} {' '.join(why)}")
    print("DIAG members", len(objs), "out_of_range", bad)


main()
