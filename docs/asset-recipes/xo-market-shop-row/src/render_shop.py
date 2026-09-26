#!/usr/bin/env python3
"""Inspection renders for the authored 2-bay desert shop row.

Six PNGs at 1280x720: a first-person close gameplay view, a medium facade view,
an aerial, an orthographic front elevation, a solid-clay workbench read, and a
rear service-yard view.  Cycles for the shaded shots, Workbench for the clay one.

Run:  blender -b --factory-startup export/shop_row.blend \
           --python src/render_shop.py
"""
import math
import os

import bpy
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "renders")
RES = (1280, 720)

# name, camera location, aim point, lens, workbench?
SHOTS = [
    ("01_close_stall",  (0.06, -4.62, 1.63), (1.86, -1.42, 1.12), 30, False),
    ("02_medium_front", (0.10, -12.0, 3.05), (0.05, -0.20, 1.85), 32, False),
    ("03_aerial",       (8.60, -9.00, 9.20), (0.10, 0.10, 1.80), 40, False),
    ("04_ortho_front",  (0.05, -24.0, 2.20), (0.05, 0.00, 2.20), 50, False),
    ("05_solid_clay",   (9.80, -8.00, 5.40), (0.20, -0.30, 1.60), 40, True),
    ("06_rear_yard",    (-4.30, 6.10, 2.05), (0.90, 2.10, 1.45), 30, False),
]
ORTHO_SCALE = 10.6
SUN_DIR = Vector((-0.44, 0.64, -0.63)).normalized()  # travels +Y: lights -Y front
SAMPLES = 72


def look_at(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def sun_elevation_rotation():
    """A Sun lamp's -Z axis is the light direction; aim it along SUN_DIR."""
    return SUN_DIR.to_track_quat('-Z', 'Y').to_euler()


def build_world(scene):
    world = bpy.data.worlds.new("XO_Render_Sky")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.85
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = 'HOSEK_WILKIE'
    sky.sun_elevation = math.asin(-SUN_DIR.z)
    sky.sun_rotation = math.atan2(SUN_DIR.y, -SUN_DIR.x)
    sky.altitude = 220.0
    sky.air_density = 1.35
    sky.aerosol_density = 2.40
    sky.ozone_density = 1.10
    sky.ground_albedo = 0.34
    nt.links.new(sky.outputs[0], bg.inputs[0])
    nt.links.new(bg.outputs[0], out.inputs[0])

    data = bpy.data.lights.new("XO_Sun", 'SUN')
    data.energy = 5.2
    data.angle = 0.026
    data.color = (1.0, 0.955, 0.885)
    sun = bpy.data.objects.new("XO_Sun", data)
    scene.collection.objects.link(sun)
    sun.location = SUN_DIR * 40.0
    sun.rotation_euler = sun_elevation_rotation()

    fill = bpy.data.lights.new("XO_Fill", 'AREA')
    fill.energy = 320.0
    fill.size = 7.0
    fill.color = (0.80, 0.86, 1.0)
    fob = bpy.data.objects.new("XO_Fill", fill)
    scene.collection.objects.link(fob)
    fob.location = (2.2, -9.0, 5.4)
    look_at(fob, (0.2, -0.6, 1.8))

    # Render-only practicals.  The hatch and the shop window are deep reveals in a
    # 780 mm wall, so neither sky nor sun reaches the interiors.  These stand in
    # for the daylight a real room would get through its own openings; they are
    # NOT part of the exported asset and are documented as such in README.md.
    back = bpy.data.lights.new("XO_RearBounce", 'AREA')
    back.energy = 900.0
    back.size = 9.0
    back.color = (0.92, 0.90, 0.86)
    bob = bpy.data.objects.new("XO_RearBounce", back)
    scene.collection.objects.link(bob)
    bob.location = (-1.0, 9.5, 4.2)
    look_at(bob, (0.2, 1.4, 1.4))

    for name, loc, tgt, watt, size in (
            ("XO_Practical_Stall", (1.55, -0.60, 1.68), (1.75, -1.80, 0.95), 120.0, 1.35),
            ("XO_Practical_Shop", (-2.40, -0.70, 1.52), (-2.45, -1.55, 1.15), 62.0, 1.05),
            ("XO_Practical_Yard", (0.10, 2.10, 1.45), (0.10, 1.10, 1.10), 26.0, 1.40)):
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy = watt
        ld.size = size
        ld.color = (1.0, 0.88, 0.70)
        ob = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(ob)
        ob.location = loc
        look_at(ob, tgt)


def render(scene, cam):
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.film_transparent = False
    scene.render.filepath = os.path.join(OUT, cam.name + ".png")
    bpy.ops.render.render(write_still=True)
    print("RENDER %-18s %s" % (cam.name, scene.render.filepath), flush=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = SAMPLES
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.012
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 3
    scene.cycles.glossy_bounces = 2
    scene.cycles.transmission_bounces = 2
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.render.use_persistent_data = True
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    scene.view_settings.exposure = 0.0
    build_world(scene)

    for name, loc, aim, lens, clay in SHOTS:
        cam_data = bpy.data.cameras.new(name)
        cam_data.lens = lens
        cam_data.clip_start = 0.05
        cam_data.clip_end = 220.0
        cam_data.sensor_width = 36.0
        if name.startswith("04_ortho"):
            cam_data.type = 'ORTHO'
            cam_data.ortho_scale = ORTHO_SCALE
        cam = bpy.data.objects.new(name, cam_data)
        scene.collection.objects.link(cam)
        cam.location = loc
        look_at(cam, aim)

        if clay:
            # solid clay read: no textures, no sky, cavity shading for the
            # silhouette and the small props
            scene.render.engine = 'BLENDER_WORKBENCH'
            sh = scene.display.shading
            sh.light = 'STUDIO'
            sh.studio_light = 'Default'
            sh.color_type = 'SINGLE'
            sh.single_color = (0.62, 0.55, 0.47)
            sh.show_cavity = True
            sh.cavity_type = 'BOTH'
            sh.curvature_ridge_factor = 1.0
            sh.curvature_valley_factor = 1.0
            sh.show_shadows = True
            sh.shadow_intensity = 0.28
            sh.show_specular_highlight = False
            sh.show_object_outline = True
            sh.object_outline_color = (0.06, 0.05, 0.04)
        else:
            scene.render.engine = 'CYCLES'

        render(scene, cam)
        scene.camera = None
        bpy.data.objects.remove(cam, do_unlink=True)

    print("RENDER_OK %d shots" % len(SHOTS), flush=True)


if __name__ == "__main__":
    main()
