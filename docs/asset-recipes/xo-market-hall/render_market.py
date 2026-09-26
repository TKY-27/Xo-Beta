"""Render preview sheets for the XO Market Hall prototype.

Run headless:
  blender -b --factory-startup --python src/render_market.py

Covers >=4 normal gameplay camera angles plus an orthographic elevation and a
solid/workbench topology view.  Renders with Cycles CPU so no GPU/display is
required.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "renders")
BLEND = os.path.join(ROOT, "export", "market_hall.blend")

RES = (1100, 760)
SAMPLES = 96

# name, eye position, aim point, focal length (mm), world strength
# Pass 2: the four angles that matter for the silhouette work -- straight-on
# front, front-west and front-east (the two views the old single west canopy
# fought with), and a raised NE corner that shows the lean-to.  05 is the
# exact camera the pass-1 review flagged as "awning post crosses the arch".
GAMEPLAY = [
    ("01_front_west",      (-6.40, -13.20, 1.60), (-0.40, -3.00, 1.65), 42),
    ("02_front_east",      ( 7.80, -12.40, 1.62), ( 0.60, -3.00, 1.70), 40),
    ("03_front_centre",    ( 0.40, -11.80, 1.60), ( 0.00, -2.60, 1.85), 50),
    ("04_corner_ne",       (12.80,  10.20, 6.20), ( 2.20,  2.60, 2.20), 40),
    ("05_front_west_low",  (-5.00,  -9.40, 1.45), ( 0.10, -2.70, 2.00), 45),
    ("06_entrance_detail", (-1.30,  -5.00, 1.55), (-0.05, -2.55, 2.05), 55),
]


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    for o in list(bpy.data.objects):
        if o.type in {'CAMERA', 'LIGHT'}:
            bpy.data.objects.remove(o, do_unlink=True)


def new_camera(name, loc, aim, lens, ortho=None, shift=(0.0, 0.0)):
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.clip_start = 0.05
    cam.clip_end = 400.0
    if ortho is not None:
        cam.type = 'ORTHO'
        cam.ortho_scale = ortho
    cam.shift_x, cam.shift_y = shift
    ob = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = Vector(loc)
    d = Vector(aim) - Vector(loc)
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return ob


def add_sun(name, elev_deg, azim_deg, energy, angle_deg, color):
    lamp = bpy.data.lights.new(name, 'SUN')
    lamp.energy = energy
    lamp.angle = math.radians(angle_deg)
    lamp.color = color
    ob = bpy.data.objects.new(name, lamp)
    bpy.context.scene.collection.objects.link(ob)
    e = math.radians(elev_deg)
    a = math.radians(azim_deg)
    ob.location = Vector((math.cos(a) * math.cos(e),
                          math.sin(a) * math.cos(e),
                          math.sin(e))) * 30.0
    ob.rotation_euler = (-ob.location).to_track_quat('-Z', 'Y').to_euler()
    return ob


def add_area(name, loc, aim, energy, size, color):
    lamp = bpy.data.lights.new(name, 'AREA')
    lamp.energy = energy
    lamp.size = size
    lamp.color = color
    lamp.shape = 'SQUARE'
    ob = bpy.data.objects.new(name, lamp)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = Vector(loc)
    ob.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return ob


def setup_world(strength=0.55, sky='HOSEK_WILKIE'):
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    out.location = (400, 0)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.location = (200, 0)
    bg.inputs["Strength"].default_value = strength
    if sky == 'HOSEK_WILKIE':
        sky_n = nt.nodes.new("ShaderNodeTexSky")
        sky_n.location = (0, 0)
        sky_n.sky_type = 'HOSEK_WILKIE'
        sky_n.sun_elevation = math.radians(38.0)
        sky_n.sun_rotation = math.radians(215.0)
        sky_n.altitude = 120.0
        sky_n.air_density = 1.5
        sky_n.aerosol_density = 4.2          # desert haze
        sky_n.ozone_density = 1.0
        sky_n.ground_albedo = 0.40
        sky_n.sun_intensity = 0.25        # disc off: the Sun lamp does the work
        nt.links.new(sky_n.outputs[0], bg.inputs["Color"])
    else:
        bg.inputs["Color"].default_value = (0.44, 0.50, 0.62, 1.0)
    nt.links.new(bg.outputs[0], out.inputs[0])


def setup_cycles(samples=SAMPLES):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.012
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 4
    sc.cycles.glossy_bounces = 3
    sc.cycles.transmission_bounces = 4
    sc.cycles.transparent_max_bounces = 6
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    sc.render.resolution_x, sc.render.resolution_y = RES
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.view_settings.exposure = 0.12


def add_ground_pad():
    """Large sand plane so the building is not floating in a void."""
    me = bpy.data.meshes.new("sandpad")
    r = 260.0
    me.from_pydata([(-r, -r, 0), (r, -r, 0), (r, r, 0), (-r, r, 0)], [],
                   [(0, 1, 2, 3)])
    me.update()
    ob = bpy.data.objects.new("sandpad", me)
    bpy.context.scene.collection.objects.link(ob)
    mat = bpy.data.materials.new("Sand_Ground")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.352, 0.268, 0.156, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.94
    ob.data.materials.append(mat)
    return ob


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, loc, aim, lens in GAMEPLAY:
        clear_scene()
        setup_world()
        setup_cycles()
        pad = add_ground_pad()
        # 04_corner_ne documents the back-east lean-to and the upper roof mass,
        # both of which face AWAY from the key sun, so it gets its own key from
        # the north-east.  A massing study, not a lighting study.
        add_sun("key_sun", 38.0, 55.0 if name == "04_corner_ne" else 215.0,
                4.2, 1.6, (1.0, 0.90, 0.74))
        add_area("fill_sky", (-3.0, -12.0, 9.0), (0.0, -1.0, 1.6), 950.0, 16.0,
                 (0.62, 0.74, 1.0))
        add_area("bounce", (0.0, -6.5, 0.4), (0.0, -2.4, 2.4), 260.0, 5.0,
                 (1.0, 0.84, 0.62))
        if name == "04_corner_ne":
            add_area("ne_fill", (16.0, 16.0, 10.0), (2.0, 2.5, 2.0), 1400.0, 16.0,
                     (0.72, 0.80, 1.0))
        # soft interior fill so the market hall reads through the doorway
        # instead of collapsing to a black void
        add_area("interior", (0.0, 0.4, 3.15), (0.0, -2.2, 0.7), 150.0, 3.6,
                 (1.0, 0.86, 0.66))
        cam = new_camera(name, loc, aim, lens)
        bpy.context.scene.camera = cam
        bpy.context.scene.render.filepath = os.path.join(OUT, f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDERED", name, flush=True)

    # ---- orthographic front elevation (architecture check) ----------------
    clear_scene()
    setup_world(strength=0.35, sky='FLAT')
    setup_cycles(samples=48)
    add_ground_pad()
    add_sun("key_sun", 52.0, 200.0, 3.0, 6.0, (1.0, 0.95, 0.88))
    add_area("fill_sky", (-6.0, -18.0, 12.0), (0.0, -1.0, 2.0), 2200.0, 26.0,
             (0.80, 0.86, 1.0))
    cam = new_camera("07_ortho_front", (0.0, -40.0, 2.60), (0.0, 0.0, 2.60), 50,
                     ortho=10.2)
    bpy.context.scene.camera = cam
    bpy.context.scene.render.filepath = os.path.join(OUT, "07_ortho_front.png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED 07_ortho_front", flush=True)

    # ---- orthographic side elevation --------------------------------------
    clear_scene()
    setup_world(strength=0.35, sky='FLAT')
    setup_cycles(samples=48)
    add_ground_pad()
    add_sun("key_sun", 52.0, 250.0, 3.0, 6.0, (1.0, 0.95, 0.88))
    add_area("fill_sky", (20.0, -6.0, 12.0), (0.0, 0.0, 2.0), 2200.0, 26.0,
             (0.80, 0.86, 1.0))
    cam = new_camera("08_ortho_side", (40.0, 0.0, 2.60), (0.0, 0.0, 2.60), 50,
                     ortho=8.4)
    bpy.context.scene.camera = cam
    bpy.context.scene.render.filepath = os.path.join(OUT, "08_ortho_side.png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED 08_ortho_side", flush=True)

    # ---- solid / workbench topology view ----------------------------------
    clear_scene()
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'SINGLE'
    sc.display.shading.single_color = (0.62, 0.60, 0.56)
    sc.display.shading.show_cavity = True
    sc.display.shading.cavity_type = 'BOTH'
    sc.display.shading.curvature_ridge_factor = 1.4
    sc.display.shading.curvature_valley_factor = 1.4
    sc.display.shading.show_object_outline = True
    sc.display.shading.object_outline_color = (0.05, 0.05, 0.05)
    sc.display.shading.show_specular_highlight = True
    sc.render.resolution_x, sc.render.resolution_y = RES
    sc.render.image_settings.file_format = 'PNG'
    sc.view_settings.view_transform = 'Standard'
    for name, loc, aim, lens, ortho in (
            ("09_solid_front", (0.0, -40.0, 2.60), (0.0, 0.0, 2.60), 50, 10.2),
            ("10_solid_threequarter", (14.5, -18.0, 9.5), (0.0, -0.4, 2.3), 50, 12.6),
            ("11_solid_top", (0.01, -0.02, 30.0), (0.0, 0.0, 0.0), 50, 10.6),
            ("12_solid_ne", (26.0, 26.0, 17.0), (0.0, 0.0, 2.2), 50, 15.0),
    ):
        cam = new_camera(name, loc, aim, lens, ortho=ortho)
        sc.camera = cam
        sc.render.filepath = os.path.join(OUT, f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDERED", name, flush=True)

    print("RENDER_OK", flush=True)


if __name__ == "__main__":
    main()
