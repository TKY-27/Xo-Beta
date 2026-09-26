"""Material set for the pass-3 desert shop row.

glTF fidelity: base colour / roughness / tangent normal go straight from Image
Texture nodes into the Principled BSDF, which is what the exporter writes to
``baseColorTexture`` / ``metallicRoughnessTexture`` / ``normalTexture``.
Roughness is authored across RGB (Blender packs roughness into G on export) and
every normal map is OpenGL +Y up, as glTF requires.

Provenance: the six mapped materials are built from either a verified CC0
source (ambientCG Bricks098, ambientCG Fabric023) or a map synthesised in
``prep_textures.py``.  See PROVENANCE.md.
"""

from __future__ import annotations

import os

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(os.path.dirname(HERE), "textures")


def _img(name, non_color=False):
    img = bpy.data.images.load(os.path.join(TEX, name), check_existing=True)
    img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    return img


def make(name, base, rough=0.8, metal=0.0, spec=0.5, maps=None, nrm_strength=1.0,
         emission=None, emission_strength=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (320, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    def setv(k, v):
        if k in bsdf.inputs:
            bsdf.inputs[k].default_value = v

    setv("Base Color", (*base, 1.0))
    setv("Roughness", rough)
    setv("Metallic", metal)
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = spec
    if emission is not None:
        setv("Emission Color", (*emission, 1.0))
        setv("Emission Strength", emission_strength)

    if maps:
        for i, (slot, fname, noncol) in enumerate((
                ("Base Color", maps.get("base"), False),
                ("Roughness", maps.get("rough"), True),
                ("Normal", maps.get("normal"), True))):
            if not fname:
                continue
            n = nt.nodes.new("ShaderNodeTexImage")
            n.image = _img(fname, noncol)
            n.interpolation = "Linear"
            n.extension = "REPEAT"
            n.location = (-820, 340 - i * 400)
            n.label = fname
            if slot == "Normal":
                nm = nt.nodes.new("ShaderNodeNormalMap")
                nm.location = (-380, -460)
                nm.inputs["Strength"].default_value = nrm_strength
                nt.links.new(n.outputs["Color"], nm.inputs["Color"])
                nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
            else:
                nt.links.new(n.outputs["Color"], bsdf.inputs[slot])
    return mat


M = "XO3_Mudbrick"
P = "XO3_Plaster"
T = "XO3_Timber"
S = "XO3_Stone"
C = "XO3_Clay"
K = "XO3_Cloth"


def build_all():
    m = {}
    m["Plaster"] = make(P, (0.298, 0.212, 0.126), rough=0.90, spec=0.26, nrm_strength=0.85,
                        maps={"base": "XO3_Plaster_Color.png",
                              "rough": "XO3_Plaster_Roughness.png",
                              "normal": "XO3_Plaster_NormalGL.png"})
    m["Mudbrick"] = make(M, (0.190, 0.118, 0.064), rough=0.95, spec=0.20, nrm_strength=0.62,
                         maps={"base": "XO3_Mudbrick_Color.png",
                               "rough": "XO3_Mudbrick_Roughness.png",
                               "normal": "XO3_Mudbrick_NormalGL.png"})
    m["Timber"] = make(T, (0.128, 0.076, 0.038), rough=0.74, spec=0.30, nrm_strength=0.70,
                       maps={"base": "XO3_Timber_Color.png",
                             "rough": "XO3_Timber_Roughness.png",
                             "normal": "XO3_Timber_NormalGL.png"})
    m["Stone"] = make(S, (0.128, 0.106, 0.082), rough=0.82, spec=0.16, nrm_strength=0.55,
                      maps={"base": "XO3_Stone_Color.png",
                            "rough": "XO3_Stone_Roughness.png",
                            "normal": "XO3_Stone_NormalGL.png"})
    m["Clay"] = make(C, (0.212, 0.082, 0.040), rough=0.66, spec=0.36, nrm_strength=0.80,
                     maps={"base": "XO3_Terracotta_Color.png",
                           "rough": "XO3_Terracotta_Roughness.png",
                           "normal": "XO3_Terracotta_NormalGL.png"})
    m["Cloth"] = make(K, (1.0, 1.0, 1.0), rough=0.84, spec=0.22, nrm_strength=0.55,
                      maps={"base": "XO3_Cloth_Color.png",
                            "rough": "XO3_Cloth_Roughness.png",
                            "normal": "XO3_Cloth_NormalGL.png"})
    m["Iron"] = make("XO3_WroughtIron", (0.031, 0.029, 0.030), rough=0.42, metal=1.0, spec=0.5)
    m["Rope"] = make("XO3_Rope", (0.176, 0.136, 0.082), rough=0.94, spec=0.18)
    m["Earth"] = make("XO3_MudScreed", (0.238, 0.186, 0.124), rough=0.88, spec=0.22,
                      nrm_strength=0.70,
                      maps={"base": "XO3_Earth_Color.png",
                            "rough": "XO3_Earth_Roughness.png",
                            "normal": "XO3_Earth_NormalGL.png"})
    m["Ground"] = make("XO3_TroddenGround", (0.312, 0.236, 0.146), rough=0.94, spec=0.18,
                       nrm_strength=0.55,
                       maps={"base": "XO3_Ground_Color.png",
                             "rough": "XO3_Ground_Roughness.png",
                             "normal": "XO3_Ground_NormalGL.png"})
    # produce is waxy, not plastic: high roughness kills the toy read
    m["Leaf"] = make("XO3_Produce_Green", (0.058, 0.096, 0.030), rough=0.68, spec=0.26)
    m["Fruit"] = make("XO3_Produce_Red", (0.184, 0.044, 0.026), rough=0.62, spec=0.28)
    m["Grain"] = make("XO3_Produce_Straw", (0.286, 0.216, 0.098), rough=0.84, spec=0.18)
    m["Flame"] = make("XO3_LampFlame", (1.0, 0.62, 0.26), rough=0.30, spec=0.5,
                      emission=(1.0, 0.46, 0.14), emission_strength=9.0)
    m["Glass"] = make("XO3_LanternGlass", (0.72, 0.52, 0.30), rough=0.14, spec=0.5,
                      emission=(1.0, 0.58, 0.24), emission_strength=1.6)
    return m
