"""Separated PBR material set for the authored desert market hall.

glTF-fidelity notes
-------------------
* Base colour, roughness and tangent normal go straight from Image Texture
  nodes into the Principled BSDF, which is exactly what the glTF exporter maps
  to ``baseColorTexture`` / ``metallicRoughnessTexture`` / ``normalTexture``.
  Roughness is authored in G (Blender packs roughness into G for glTF), and
  all normal maps are OpenGL (+Y up) as glTF requires.
* Verified-CC0 sources: ambientCG Bricks098, ambientCG Fabric023.
  Authored-in-house procedural: plaster and wood normal/roughness pairs.
"""

from __future__ import annotations

import os

import bpy

TEX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "textures")


def _img(name: str, non_color: bool = False) -> bpy.types.Image:
    path = os.path.join(TEX, name)
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    return img


def _tex_node(nt, img, x=-700, y=0, label=""):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = img
    n.interpolation = "Linear"
    n.extension = "REPEAT"
    n.location = (x, y)
    n.label = label
    return n


def make(name, base, rough=0.8, metal=0.0, ior=1.45, spec=0.5,
         base_map=None, rough_map=None, normal_map=None, normal_strength=1.0,
         emission=None, emission_strength=1.0, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (300, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    def setv(key, value):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = value

    setv("Base Color", (*base, 1.0))
    setv("Roughness", rough)
    setv("Metallic", metal)
    setv("IOR", ior)
    setv("Alpha", alpha)
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = spec
    if emission is not None:
        setv("Emission Color", (*emission, 1.0))
        setv("Emission Strength", emission_strength)
    if alpha < 1.0:
        mat.blend_method = 'BLEND'

    if base_map:
        nt.links.new(_tex_node(nt, _img(base_map), -800, 320, "base").outputs["Color"],
                     bsdf.inputs["Base Color"])
    if rough_map:
        nt.links.new(_tex_node(nt, _img(rough_map, True), -800, -60, "rough")
                     .outputs["Color"], bsdf.inputs["Roughness"])
    if normal_map:
        nm = _tex_node(nt, _img(normal_map, True), -800, -440, "normal")
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.location = (-380, -440)
        nmap.inputs["Strength"].default_value = normal_strength
        nt.links.new(nm.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def build_all() -> dict[str, bpy.types.Material]:
    m: dict[str, bpy.types.Material] = {}
    m["Plaster"] = make(
        "XO_Plaster", (0.272, 0.219, 0.152), rough=0.88, spec=0.30,
        base_map="XO_Plaster_Color.png", rough_map="XO_Plaster_Roughness.png", normal_map="XO_Plaster_NormalGL.png",
        normal_strength=1.0)
    m["Mudbrick"] = make(
        "XO_Mudbrick", (0.215, 0.135, 0.070), rough=0.94, spec=0.22,
        base_map="XO_Mudbrick_Color.png", rough_map="XO_Mudbrick_Roughness.png",
        normal_map="XO_Mudbrick_NormalGL.png", normal_strength=0.50)
    m["Wood"] = make(
        "XO_Wood", (0.135, 0.078, 0.038), rough=0.70, spec=0.32,
        normal_map="XO_Wood_NormalGL.png", normal_strength=0.85)
    m["Iron"] = make("XO_WroughtIron", (0.038, 0.036, 0.036), rough=0.44, metal=1.0)
    m["Brass"] = make("XO_Brass", (0.430, 0.278, 0.092), rough=0.30, metal=1.0)
    m["FabricAwning"] = make(
        "XO_Fabric_Awning_Terracotta", (1.0, 1.0, 1.0), rough=0.82, spec=0.25,
        base_map="XO_Awning_Color.png",
        rough_map="XO_Fabric_Roughness.png", normal_map="XO_Fabric_NormalGL.png",
        normal_strength=0.6)
    m["FabricShade"] = make(
        "XO_Fabric_Shade_Cream", (0.268, 0.222, 0.158), rough=0.86, spec=0.25,
        rough_map="XO_Fabric_Roughness.png", normal_map="XO_Fabric_NormalGL.png",
        normal_strength=0.6)
    m["FabricIndigo"] = make(
        "XO_Fabric_Indigo", (0.098, 0.108, 0.152), rough=0.84, spec=0.25,
        rough_map="XO_Fabric_Roughness.png", normal_map="XO_Fabric_NormalGL.png",
        normal_strength=0.6)
    m["FabricCanvas"] = make(
        "XO_Fabric_Canvas", (0.176, 0.140, 0.096), rough=0.87, spec=0.25,
        rough_map="XO_Fabric_Roughness.png", normal_map="XO_Fabric_NormalGL.png",
        normal_strength=0.6)
    m["FabricRust"] = make(
        "XO_Fabric_Rust", (0.186, 0.086, 0.054), rough=0.86, spec=0.25,
        rough_map="XO_Fabric_Roughness.png", normal_map="XO_Fabric_NormalGL.png",
        normal_strength=0.6)
    m["Rope"] = make("XO_Rope", (0.196, 0.148, 0.090), rough=0.95, spec=0.2)
    m["Stone"] = make(
        "XO_Stone_Limestone", (0.238, 0.198, 0.142), rough=0.80, spec=0.30,
        base_map="XO_Stone_Color.png", rough_map="XO_Stone_Roughness.png",
        normal_map="XO_Stone_NormalGL.png", normal_strength=0.16)
    m["Terracotta"] = make("XO_Terracotta", (0.230, 0.088, 0.042), rough=0.62, spec=0.4)
    m["LampGlass"] = make(
        "XO_LampGlass", (0.62, 0.42, 0.22), rough=0.22, spec=0.5,
        emission=(1.0, 0.50, 0.19), emission_strength=0.22)
    m["Earth"] = make("XO_Earth_Floor", (0.205, 0.152, 0.096), rough=0.96, spec=0.2)
    m["Cactus"] = make("XO_Foliage", (0.146, 0.196, 0.106), rough=0.66, spec=0.4)
    return m
