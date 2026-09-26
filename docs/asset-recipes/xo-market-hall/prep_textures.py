"""Prepare verified-CC0 texture maps for the authored desert market hall.

Sources (all CC0 1.0):
  - ambientCG Bricks098  (rubble/fieldstone masonry + sandy mortar)  -> mudbrick
  - ambientCG Fabric023  (woven cloth)                               -> awning fabric
Plus one *authored* (procedurally generated, no provenance needed) tileable
plaster normal + roughness pair.

All derivatives are written to ../textures/ and documented in PROVENANCE.md.
Run:  blender -b --factory-startup --python src/prep_textures.py
"""

from __future__ import annotations

import math
import os
import sys

import numpy as np
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_ROOT = "/var/folders/pt/hwgh5hrj1p909_r6ns6bkggm0000gn/T/opencode"
OUT = os.path.join(ROOT, "textures")
os.makedirs(OUT, exist_ok=True)


# --------------------------------------------------------------------------
# image io
# --------------------------------------------------------------------------
def load_rgb(path: str) -> np.ndarray:
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    arr = buf.reshape(h, w, 4)[::-1]  # flip to top-down
    bpy.data.images.remove(img)
    return np.clip(arr[..., :3], 0.0, 1.0)


def save_rgb(arr: np.ndarray, path: str) -> None:
    h, w = arr.shape[:2]
    img = bpy.data.images.new("out", width=w, height=h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "sRGB"
    flipped = np.clip(arr[::-1], 0.0, 1.0)
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = flipped
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    print("WROTE", path, w, "x", h)


def save_data(arr: np.ndarray, path: str, name: str = "Non-Color",
              down: int = 1) -> None:
    """Save a linear data map (normal / roughness).

    `down` box-filters by an integer factor.  Noisy normal maps are the single
    biggest contributor to GLB weight and are the least sensitive to texel
    density, so the plaster / wood / fabric ones are written at half res.
    """
    if down > 1:
        arr = arr.reshape(arr.shape[0] // down, down,
                          arr.shape[1] // down, down,
                          arr.shape[2]).mean(axis=(1, 3))
    h, w = arr.shape[:2]
    img = bpy.data.images.new("out", width=w, height=h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = name
    flipped = np.clip(arr[::-1], 0.0, 1.0)
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = flipped
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    print("WROTE", path, w, "x", h)


# --------------------------------------------------------------------------
# authored tileable value-noise fBm (numpy only, no provenance needed)
# --------------------------------------------------------------------------
def _grid_noise(size: int, cells: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    g = rng.random((cells + 1, cells + 1))
    g[-1, :] = g[0, :]
    g[:, -1] = g[:, 0]  # wrap for tileability
    t = np.linspace(0.0, cells, size, endpoint=False)
    i0 = np.floor(t).astype(int)
    f = t - i0
    f = f * f * (3.0 - 2.0 * f)  # smoothstep
    i1 = (i0 + 1) % cells
    a = g[np.ix_(i0, i0)]
    b = g[np.ix_(i0, i1)]
    c = g[np.ix_(i1, i0)]
    d = g[np.ix_(i1, i1)]
    fx = f[None, :]
    fy = f[:, None]
    return (a * (1 - fx) * (1 - fy) + b * (1 - fx) * fy
            + c * fx * (1 - fy) + d * fx * fy)


def fbm(size: int, seed: int, octaves=5, base_cells=4, gain=0.5, lac=2) -> np.ndarray:
    out = np.zeros((size, size), dtype=np.float32)
    amp, tot, cells = 1.0, 0.0, base_cells
    for o in range(octaves):
        out += amp * _grid_noise(size, cells, seed + o * 977)
        tot += amp
        amp *= gain
        cells *= lac
    out /= tot
    return (out - out.min()) / max(1e-6, float(np.ptp(out)))


def height_to_normal(height: np.ndarray, strength: float) -> np.ndarray:
    gy, gx = np.gradient(height.astype(np.float32))
    n = np.stack((-gx * strength, -gy * strength, np.ones_like(gx)), axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main() -> None:
    # ---- mudbrick from ambientCG Bricks098 -------------------------------
    br = os.path.join(SRC_ROOT, "ambientcg-bricks098", "extracted")
    col = load_rgb(os.path.join(br, "Bricks098_1K-JPG_Color.jpg"))
    print("Bricks098 color shape", col.shape)
    # linear-ish working space
    lin = np.where(col <= 0.04045, col / 12.92, ((col + 0.055) / 1.055) ** 2.4)
    # hue-rotate toward warm sandy adobe: push R up, G mid, B down
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    lum = 0.30 * r + 0.59 * g + 0.11 * b
    # Compress the source's value range. Bricks098 is bright-mortar/dark-stone
    # river rubble; mixed 55% back toward a flat adobe it reads as mudbrick
    # courses instead of a cobblestone wall.
    lum = 0.55 * lum + 0.45 * 0.150
    adobe = np.stack([
        np.clip(lum * 0.660 + 0.030, 0, 1),
        np.clip(lum * 0.435 + 0.014, 0, 1),
        np.clip(lum * 0.240 + 0.004, 0, 1),
    ], axis=-1)
    srgb = np.where(adobe <= 0.0031308, adobe * 12.92, 1.055 * adobe ** (1 / 2.4) - 0.055)
    save_rgb(srgb, os.path.join(OUT, "XO_Mudbrick_Color.png"))

    nrm = load_rgb(os.path.join(br, "Bricks098_1K-JPG_NormalGL.jpg"))
    save_data(nrm, os.path.join(OUT, "XO_Mudbrick_NormalGL.png"))

    rgh = load_rgb(os.path.join(br, "Bricks098_1K-JPG_Roughness.jpg"))[..., 0]
    rgh = np.clip(rgh * 0.92 + 0.16, 0.30, 0.99)
    save_data(np.repeat(rgh[..., None], 3, axis=-1), os.path.join(OUT, "XO_Mudbrick_Roughness.png"))

    # ---- awning fabric from ambientCG Fabric023 --------------------------
    fb = os.path.join(SRC_ROOT, "fabric023")
    ndx = load_rgb(os.path.join(fb, "Fabric023_1K-JPG_NormalDX.jpg"))
    gl = ndx.copy()
    gl[..., 1] = 1.0 - gl[..., 1]  # DirectX -> OpenGL (green flip)
    save_data(gl, os.path.join(OUT, "XO_Fabric_NormalGL.png"), down=2)
    frgh = load_rgb(os.path.join(fb, "Fabric023_1K-JPG_Roughness.jpg"))[..., 0]
    save_data(np.repeat(np.clip(frgh * 0.35 + 0.55, 0, 1)[..., None], 3, axis=-1),
              os.path.join(OUT, "XO_Fabric_Roughness.png"), down=2)

    # ---- authored plaster -------------------------------------------------
    size = 1024
    h1 = fbm(size, seed=101, octaves=6, base_cells=6, gain=0.55)
    grit = fbm(size, seed=733, octaves=2, base_cells=96, gain=0.5)
    trowel = fbm(size, seed=1409, octaves=3, base_cells=3, gain=0.6)
    height = 0.55 * h1 + 0.30 * grit + 0.15 * trowel
    height = (height - height.min()) / np.ptp(height)
    plaster_n = height_to_normal(height, 9.0)
    save_data(plaster_n, os.path.join(OUT, "XO_Plaster_NormalGL.png"), down=2)
    plaster_r = np.clip(0.80 + 0.20 * (1.0 - h1) - 0.06 * grit, 0.55, 0.99)
    save_data(np.repeat(plaster_r[..., None], 3, axis=-1),
              os.path.join(OUT, "XO_Plaster_Roughness.png"), down=2)

    # plaster ALBEDO: warm adobe tan, mottled by the same fBm, with vertical
    # rain streaks and a darker damp band at the bottom of every tile.
    streak = fbm(size, seed=5501, octaves=3, base_cells=20)
    streak = 0.55 * streak + 0.45 * streak.mean(axis=0, keepdims=True)  # stretch
    streak = (streak - streak.min()) / max(1e-6, float(np.ptp(streak)))
    base_lin = np.array([0.272, 0.219, 0.152], dtype=np.float32)   # lime plaster, linear
    mott = (0.68 + 0.66 * h1)[..., None]
    streak_mul = (1.0 - 0.30 * streak**1.4)[..., None]
    damp = np.clip(1.0 - 0.34 * grit, 0.0, 1.0)[..., None]
    pl_col = base_lin[None, None, :] * mott * streak_mul * damp
    pl_col += (0.080 * (trowel - 0.5))[..., None]          # trowel patchiness
    pl_col = np.clip(pl_col, 0.0, 1.0)
    pl_srgb = np.where(pl_col <= 0.0031308, pl_col * 12.92,
                       1.055 * pl_col ** (1 / 2.4) - 0.055)
    save_rgb(pl_srgb, os.path.join(OUT, "XO_Plaster_Color.png"))

    # ---- AUTHORED market awning: broad terracotta/cream stripe bands -----
    # Box-projected UVs put world X in U, so bands that vary along U read as
    # stripes running front-to-back down the canopy slope.
    size = 1024
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    weave = fbm(size, seed=8081, octaves=3, base_cells=64)
    soil = fbm(size, seed=313, octaves=4, base_cells=7)
    wob = 0.012 * np.sin(yy * 9.0 * math.pi) + 0.010 * (weave - 0.5)
    u = (xx + wob) % 1.0
    band = np.clip(np.cos((u - 0.5) * 2 * math.pi * 3.0) * 3.2, -1.0, 1.0)
    stripe_mix = 0.5 + 0.5 * band                       # 1 = pale, 0 = ochre
    edge = np.abs(band)
    # A 20% value gap between the two bands was invisible under a 38 deg sun:
    # the canopy read as one flat field.  A 2x value ratio plus a real hue
    # shift is what makes it read as striped market canvas.
    terracotta = np.array([0.124, 0.060, 0.026], dtype=np.float32)   # madder red
    cream = np.array([0.268, 0.222, 0.156], dtype=np.float32)       # bleached flax
    aw = (terracotta[None, None, :] * (1.0 - stripe_mix[..., None])
          + cream[None, None, :] * stripe_mix[..., None])
    aw *= (0.86 + 0.28 * weave)[..., None]               # woven unevenness
    aw *= (1.0 - 0.13 * soil**1.5)[..., None]            # sun bleaching / grime
    aw *= (0.80 + 0.20 * np.clip(edge * 2.0, 0, 1))[..., None]   # seam shadow
    aw = np.clip(aw, 0.0, 1.0)
    aw_srgb = np.where(aw <= 0.0031308, aw * 12.92,
                       1.055 * aw ** (1 / 2.4) - 0.055)
    save_rgb(aw_srgb, os.path.join(OUT, "XO_Awning_Color.png"))

    # ---- authored weathered wood -----------------------------------------
    size = 1024
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    warp = fbm(size, seed=4211, octaves=4, base_cells=3) - 0.5
    rings = np.sin((xx * 26.0 + yy * 3.0 + warp * 7.0) * math.pi) * 0.5 + 0.5
    fine = fbm(size, seed=991, octaves=2, base_cells=128)
    wh = np.clip(0.60 * rings + 0.28 * fine + 0.12 * warp, 0, 1)
    save_data(height_to_normal(wh, 2.2), os.path.join(OUT, "XO_Wood_NormalGL.png"), down=2)

    # ---- AUTHORED weathered limestone (plinth, coping, steps, voussoirs) ---
    # The stone had no map at all, so it rendered as a flat blown-out white and
    # the whole building collapsed to one beige value.  This gives it mottling,
    # bedding planes and pitting.
    size = 1024
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    bed = fbm(size, seed=2609, octaves=4, base_cells=2)
    pit = fbm(size, seed=6151, octaves=2, base_cells=40, gain=0.5)
    chip = fbm(size, seed=9001, octaves=1, base_cells=7, gain=0.5)
    st = np.clip(0.62 + 0.52 * (bed - 0.5) + 0.30 * (pit - 0.5)
                 - 0.09 * np.clip(chip - 0.72, 0, 1) * 4.0, 0.0, 1.0)
    st_h = np.clip(0.62 * bed + 0.24 * pit + 0.14 * chip, 0, 1)
    save_data(height_to_normal(st_h, 0.9),
              os.path.join(OUT, "XO_Stone_NormalGL.png"), down=2)
    save_data(np.repeat(np.clip(0.62 + 0.30 * (1.0 - pit), 0.40, 0.97)[..., None],
                        3, axis=-1),
              os.path.join(OUT, "XO_Stone_Roughness.png"), down=2)
    stone_lin = np.array([0.196, 0.158, 0.108], dtype=np.float32)   # warm lime
    st_col = stone_lin[None, None, :] * (0.74 + 0.52 * st)[..., None]
    st_col *= (1.0 - 0.16 * pit**2)[..., None]
    st_col = np.clip(st_col, 0.0, 1.0)
    st_srgb = np.where(st_col <= 0.0031308, st_col * 12.92,
                       1.055 * st_col ** (1 / 2.4) - 0.055)
    save_rgb(st_srgb, os.path.join(OUT, "XO_Stone_Color.png"))

    print("PREP_TEXTURES_OK")


if __name__ == "__main__":
    main()
    sys.exit(0)
