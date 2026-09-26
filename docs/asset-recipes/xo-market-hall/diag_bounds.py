import os
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
bpy.ops.wm.open_mainfile(filepath=os.path.join(os.path.dirname(HERE), "export", "market_hall.blend"))
bpy.context.view_layer.update()

rows = []
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    pts = [o.matrix_world @ v.co for v in o.data.vertices]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    rows.append((o.name, lo, hi))

rows.sort(key=lambda r: r[1][2])
for name, lo, hi in rows:
    print(f"{name:34s} lo=({lo[0]:7.3f},{lo[1]:7.3f},{lo[2]:7.3f}) "
          f"hi=({hi[0]:7.3f},{hi[1]:7.3f},{hi[2]:7.3f})")
