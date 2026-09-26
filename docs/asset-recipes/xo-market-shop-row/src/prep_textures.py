"""Generate the PBR map set for the pass-3 desert shop row.

Two classes of map:
  * DERIVED  - remapped from a verified CC0 source already on this machine
               (ambientCG Bricks098 for mudbrick, ambientCG Fabric023 for cloth).
  * AUTHORED - synthesised here from numpy value-noise fBm.  No third-party
               pixels, so no provenance obligation beyond this file.

Run:  blender -b --factory-startup --python src/prep_textures.py
"""

from __future__ import annotations

import math
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "textures")
ASSETS = "/var/folders/pt/hwgh5hrj1p909_r6ns6bkggm0000gn/T/opencode"
os.makedirs(OUT, exist_ok=True)

SQRT_HALF = 0.70710678


# --------------------------------------------------------------- image plumbing
def load_rgb(path: str) -> np.ndarray:
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    arr = buf.reshape(h, w, 4)[::-1].copy()
    bpy.data.images.remove(img)
    return np.clip(arr[..., :3], 0.0, 1.0)


def _emit(arr: np.ndarray, path: str, colorspace: str) -> None:
    arr = np.asarray(arr, dtype=np.float32)
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=-1)
    arr = arr[..., :3]
    h, w = arr.shape[:2]
    img = bpy.data.images.new("xo_out", width=w, height=h, alpha=False,
                              float_buffer=False)
    img.colorspace_settings.name = colorspace
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = np.clip(arr[::-1], 0.0, 1.0)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    print("WROTE %-46s %4dx%-4d" % (os.path.basename(path), w, h), flush=True)


def save_color(lin: np.ndarray, name: str) -> None:
    srgb = np.where(lin <= 0.0031308, lin * 12.92,
                    1.055 * np.clip(lin, 1e-8, None) ** (1 / 2.4) - 0.055)
    _emit(srgb, os.path.join(OUT, name), "sRGB")


def save_data(arr: np.ndarray, name: str, half: bool = False) -> None:
    a = arr
    if half:
        h, w = a.shape[0] // 2, a.shape[1] // 2
        a = a.reshape(h, 2, w, 2, -1).mean(axis=(1, 3))
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, axis=-1)
    _emit(a, os.path.join(OUT, name), "Non-Color")


def resample(arr: np.ndarray, ny: int, nx: int) -> np.ndarray:
    """Nearest-neighbour resample, used to squash CC0 sources anisotropically."""
    h, w = arr.shape[:2]
    yi = (np.arange(ny) * h // ny).clip(0, h - 1)
    xi = (np.arange(nx) * w // nx).clip(0, w - 1)
    return arr[yi][:, xi]


def blur_periodic(a: np.ndarray, ry: int, rx: int) -> np.ndarray:
    """Circular box blur. The 384->1024 re-tiling of a CC0 square tile leaves a
    one-texel step at the axis where the resample rate changes; blurring it out
    keeps the wrap seamless and softens the cobble edges toward adobe."""
    out = a.astype(np.float32)
    h, w = out.shape[0], out.shape[1]
    if rx:
        k = 2 * rx + 1
        pad = np.concatenate([out[..., -rx:], out, out[..., :rx]], axis=-1)
        out = sum(np.roll(pad, s, axis=-1) for s in range(-rx, rx + 1)) / k
        out = out[..., rx:rx + w]
    if ry:
        k = 2 * ry + 1
        pad = np.concatenate([out[-ry:], out, out[:ry]], axis=0)
        out = sum(np.roll(pad, s, axis=0) for s in range(-ry, ry + 1)) / k
        out = out[ry:ry + h]
    return out


# ------------------------------------------------------------------ noise field
def _lattice(cells: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    g = rng.random((cells + 1, cells + 1))
    g[-1, :] = g[0, :]
    g[:, -1] = g[:, 0]
    return g


def _bilinear_tiled(sx: np.ndarray, sy: np.ndarray, g: np.ndarray) -> np.ndarray:
    """Periodic bilinear gather at fractional tile coordinates, so a warped
    domain still tiles seamlessly."""
    cells = g.shape[0] - 1
    x0 = np.floor(sx * cells).astype(np.int64) % cells
    y0 = np.floor(sy * cells).astype(np.int64) % cells
    x1 = (x0 + 1) % cells
    y1 = (y0 + 1) % cells
    fx = sx * cells - np.floor(sx * cells)
    fy = sy * cells - np.floor(sy * cells)
    fx = fx * fx * (3.0 - 2.0 * fx)
    fy = fy * fy * (3.0 - 2.0 * fy)
    return (g[y0, x0] * (1 - fx) * (1 - fy) + g[y0, x1] * fx * (1 - fy)
            + g[y1, x0] * (1 - fx) * fy + g[y1, x1] * fx * fy)


def value_noise(size: int, cells: int, seed: int, warp: float = 0.0) -> np.ndarray:
    g = _lattice(cells, seed)
    if warp <= 0.0:
        t = np.linspace(0.0, 1.0, size, endpoint=False, dtype=np.float32)
        return _bilinear_tiled(t[None, :] * np.ones((size, 1), np.float32),
                               t[:, None] * np.ones((1, size), np.float32), g)
    # Domain warp with an independent low-frequency field.  A plain value-noise
    # lattice reads as axis-aligned masonry; the warp is what makes mud render
    # as mud rather than as blocks, and it stays periodic.
    wc = max(2, cells // 2)
    wx = fbm(size, seed + 9001, 3, wc, warp=0.0)   # no nested warp
    wy = fbm(size, seed + 9401, 3, wc, warp=0.0)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    sx = (xx + (wx - 0.5) * warp) % 1.0
    sy = (yy + (wy - 0.5) * warp) % 1.0
    return _bilinear_tiled(sx, sy, g)


def fbm(size: int, seed: int, octaves=5, cells=4, gain=0.5, lac=2,
        warp=0.10) -> np.ndarray:
    acc = np.zeros((size, size), dtype=np.float32)
    amp, tot, c = 1.0, 0.0, cells
    for o in range(octaves):
        acc += amp * value_noise(size, int(c), seed + o * 613,
                                 warp if o else 0.0)
        tot += amp
        amp *= gain
        c *= lac
    return unit(acc)


def ridged(size: int, seed: int, octaves=4, cells=4) -> np.ndarray:
    return unit(1.0 - np.abs(fbm(size, seed, octaves, cells) - 0.5) * 2.0)


def warp_field(size: int, seed: int, cells: int, amount: float) -> np.ndarray:
    dx = fbm(size, seed, 3, cells) - 0.5
    dy = fbm(size, seed + 77, 3, cells) - 0.5
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    sx = (xx + dx * amount) % 1.0
    sy = (yy + dy * amount) % 1.0
    x0 = np.floor(sx * cells).astype(int) % cells
    y0 = np.floor(sy * cells).astype(int) % cells
    fx = (sx * cells) % 1.0
    fy = (sy * cells) % 1.0
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    g = value_noise(size, cells, seed)
    x1 = (x0 + 1) % cells
    y1 = (y0 + 1) % cells
    return (g[y0, x0] * (1 - fx) * (1 - fy) + g[y0, x1] * fx * (1 - fy)
            + g[y1, x0] * (1 - fx) * fy + g[y1, x1] * fx * fy)


def unit(a: np.ndarray) -> np.ndarray:
    a = a.astype(np.float32)
    span = float(a.max() - a.min())
    return (a - a.min()) / max(1e-6, span)


def normal_from(height: np.ndarray, strength: float) -> np.ndarray:
    gy, gx = np.gradient(height.astype(np.float32))
    n = np.stack((-gx * strength, -gy * strength, np.ones_like(gx)), axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


# --------------------------------------------------------------------- mudbrick
def mudbrick() -> None:
    src = os.path.join(ASSETS, "ambientcg-bricks098", "extracted")
    col = load_rgb(os.path.join(src, "Bricks098_1K-JPG_Color.jpg"))
    nrm = load_rgb(os.path.join(src, "Bricks098_1K-JPG_NormalGL.jpg"))
    rgh = load_rgb(os.path.join(src, "Bricks098_1K-JPG_Roughness.jpg"))[..., 0]

    # Bricks098 is river cobble: near-square stones, high mortar/stone contrast.
    # Adobe block courses are 3:1 to 4:1 wide, so the tile is squashed to 1024x384
    # and resampled back to 1024x1024 -- the stones read as laid mudbricks
    # instead of a cobblestone retaining wall.
    col_s = resample(col, 384, 1024)
    nrm_s = resample(nrm, 384, 1024)
    rgh_s = resample(rgh[..., None], 384, 1024)[..., 0]
    col = resample(col_s, 1024, 1024)
    nrm = resample(nrm_s, 1024, 1024)
    rgh = resample(rgh_s, 1024, 1024)
    col = blur_periodic(col, 3, 2)
    nrm = blur_periodic(nrm, 1, 1)
    rgh = blur_periodic(rgh, 3, 2)

    lin = np.where(col <= 0.04045, col / 12.92, ((col + 0.055) / 1.055) ** 2.4)
    lum = 0.26 * lin[..., 0] + 0.62 * lin[..., 1] + 0.12 * lin[..., 2]
    lum = 0.46 * lum + 0.54 * 0.196
    grit = fbm(1024, 4711, 3, 128)
    # Authored course lines: six mudbrick courses per tile with a jittered
    # mortar shadow, so the wall reads as laid blockwork rather than a rubble
    # pile.  The jitter is periodic, so the wrap stays invisible.
    yy = np.mgrid[0:1024, 0:1024][0].astype(np.float32) / 1024.0
    jitter = (fbm(1024, 4713, 2, 3) - 0.5) * 0.010
    v = (yy * 6.0 + jitter) % 1.0
    bed_line = np.clip(1.0 - np.abs(v - 0.5) * 11.0, 0.0, 1.0) ** 1.4
    perp_stagger = np.clip(1.0 - np.abs(((yy * 12.0) % 1.0) - 0.5) * 15.0, 0, 1)
    bed_line = np.maximum(bed_line, 0.55 * perp_stagger * bed_line)
    course = (0.90 + 0.20 * fbm(1024, 4712, 2, 3)) * (1.0 - 0.26 * bed_line)
    brick = np.stack([
        np.clip(lum * 0.900 + 0.052, 0, 1),
        np.clip(lum * 0.680 + 0.034, 0, 1),
        np.clip(lum * 0.470 + 0.020, 0, 1),
    ], axis=-1)
    brick *= (0.90 + 0.22 * grit)[..., None]
    brick *= course[..., None]
    brick *= (1.0 - 0.22 * bed_line)[..., None]
    save_color(np.clip(brick, 0, 1), "XO3_Mudbrick_Color.png")

    save_data(np.clip(nrm, 0, 1), "XO3_Mudbrick_NormalGL.png")
    rr = np.clip(rgh * 0.84 + 0.20 + 0.10 * grit, 0.42, 0.99)
    save_data(rr, "XO3_Mudbrick_Roughness.png", half=True)


# ---------------------------------------------------------------------- plaster
def plaster() -> None:
    size = 1024
    body = fbm(size, 2207, 7, 6, gain=0.52, warp=0.16)
    patch = fbm(size, 2263, 3, 3, warp=0.22)     # broad re-render patches
    float_lines = ridged(size, 3311, 2, 5)          # trowel float banding
    salt = fbm(size, 9021, 2, 22)                   # efflorescence blooms
    bloom = np.clip((salt - 0.70) * 4.0, 0.0, 1.0)
    sand = fbm(size, 5507, 2, 150)                  # aggregate in the render
    crack = ridged(size, 7001, 3, 7)
    crackle = np.clip((0.30 - crack) * 6.0, 0.0, 1.0) ** 1.6

    tooth = fbm(size, 2309, 4, 20, warp=0.10)
    h = (0.30 * body + 0.18 * float_lines + 0.16 * sand + 0.22 * tooth
         + 0.08 * np.clip(1.0 - crack * 1.4, 0, 1) + 0.06 * patch)
    save_data(normal_from(h, 7.2), "XO3_Plaster_NormalGL.png", half=True)
    save_data(np.clip(0.86 + 0.14 * (1.0 - body) - 0.05 * sand, 0.60, 0.99),
              "XO3_Plaster_Roughness.png", half=True)

    base = np.array([0.268, 0.183, 0.104], dtype=np.float32)   # ochre lime
    pale = np.array([0.330, 0.258, 0.170], dtype=np.float32)   # sun-bleached
    c = base[None, None, :] * (0.84 + 0.28 * body)[..., None]
    c = c * (0.93 + 0.14 * patch)[..., None]
    c += (0.030 * (float_lines - 0.5))[..., None]
    c = c * (1.0 - 0.22 * crackle)[..., None]
    c = c * (1.0 - 0.10 * sand)[..., None]
    c = c * (1.0 - bloom[..., None] * 0.55) + pale[None, None, :] * bloom[..., None] * 0.55
    save_color(np.clip(c, 0, 1), "XO3_Plaster_Color.png")


# ----------------------------------------------------------------------- timber
def timber() -> None:
    size = 1024
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    knots = np.array([[0.28, 0.62], [0.74, 0.24]], dtype=np.float32)
    dx = xx - knots[0, 0]
    dy = yy - knots[0, 1]
    dx = (dx + 0.5) % 1.0 - 0.5
    dy = (dy + 0.5) % 1.0 - 0.5
    d0 = np.sqrt(dx * dx + dy * dy)
    dx = xx - knots[1, 0]
    dy = yy - knots[1, 1]
    dx = (dx + 0.5) % 1.0 - 0.5
    dy = (dy + 0.5) % 1.0 - 0.5
    d1 = np.sqrt(dx * dx + dy * dy)
    knot = np.clip(1.0 - d0 * 9.0, 0, 1) ** 2 + np.clip(1.0 - d1 * 13.0, 0, 1) ** 2
    flow = warp_field(size, 6120, 4, 0.05) - 0.5
    grain = np.sin((xx * 21.0 + yy * 1.4 + flow * 5.0 + knot * 4.0) * math.pi) * 0.5 + 0.5
    fibre = np.sin((xx * 128.0 + yy * 6.0 + flow * 26.0) * math.pi) * 0.5 + 0.5
    fine = fbm(size, 881, 2, 160)
    weather = fbm(size, 6203, 4, 6)

    h = np.clip(0.34 * grain + 0.16 * fibre + 0.20 * fine + 0.22 * weather
                - 0.30 * knot, 0, 1)
    save_data(normal_from(h, 2.0), "XO3_Timber_NormalGL.png", half=True)
    save_data(np.clip(0.76 - 0.12 * grain + 0.20 * weather, 0.44, 0.95),
              "XO3_Timber_Roughness.png", half=True)

    bark = np.array([0.118, 0.070, 0.036], dtype=np.float32)
    silvered = np.array([0.226, 0.190, 0.152], dtype=np.float32)  # sun-silvered
    c = bark[None, None, :] * (0.82 + 0.30 * grain)[..., None]
    c *= (0.93 + 0.10 * fibre)[..., None]
    c *= (0.84 + 0.30 * weather)[..., None]
    silver = np.clip((weather - 0.42) * 1.9, 0, 1) * (0.35 + 0.65 * fine)
    c = c * (1.0 - silver[..., None]) + silvered[None, None, :] * silver[..., None]
    c *= (1.0 - 0.38 * knot)[..., None]
    save_color(np.clip(c, 0, 1), "XO3_Timber_Color.png")


# ----------------------------------------------------------------------- stone
def stone() -> None:
    size = 1024
    ves = fbm(size, 4409, 2, 26)                    # vesicular pitting
    pits = np.clip((ves - 0.66) * 5.0, 0, 1)
    bed = ridged(size, 8801, 4, 3)                  # bedding / saw marks
    chip = fbm(size, 1201, 1, 9)
    h = np.clip(0.40 * bed + 0.30 * (1.0 - pits) + 0.30 * chip, 0, 1)
    save_data(normal_from(h, 2.0), "XO3_Stone_NormalGL.png", half=True)
    save_data(np.clip(0.76 + 0.18 * (1.0 - pits) + 0.06 * chip, 0.64, 0.97),
              "XO3_Stone_Roughness.png", half=True)
    base = np.array([0.128, 0.106, 0.082], dtype=np.float32)   # warm sandstone
    c = base[None, None, :] * (0.84 + 0.34 * bed)[..., None]
    c = c * (1.0 - 0.34 * pits)[..., None]
    c += (0.030 * (chip - 0.5))[..., None]
    save_color(np.clip(c, 0, 1), "XO3_Stone_Color.png")


# ------------------------------------------------------------------ clay / pots
def terracotta() -> None:
    size = 1024
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    throw = np.sin((yy * 150.0 + fbm(size, 331, 2, 4) * 5.0) * math.pi) * 0.5 + 0.5
    grit = fbm(size, 9917, 2, 120)
    lime = fbm(size, 5501, 3, 5)                    # lime bloom / efflorescence
    scale = np.clip((lime - 0.62) * 3.2, 0, 1)
    h = np.clip(0.24 * throw + 0.34 * grit + 0.30 * scale, 0, 1)
    save_data(normal_from(h, 2.2), "XO3_Terracotta_NormalGL.png", half=True)
    save_data(np.clip(0.70 - 0.22 * throw + 0.26 * scale, 0.36, 0.96),
              "XO3_Terracotta_Roughness.png", half=True)
    body = np.array([0.206, 0.079, 0.038], dtype=np.float32)
    pale = np.array([0.320, 0.256, 0.196], dtype=np.float32)
    c = body[None, None, :] * (0.86 + 0.28 * throw)[..., None]
    c *= (0.90 + 0.20 * grit)[..., None]
    c = c * (1.0 - scale[..., None] * 0.6) + pale[None, None, :] * scale[..., None] * 0.6
    save_color(np.clip(c, 0, 1), "XO3_Terracotta_Color.png")


# ------------------------------------------------------------------- awning cloth
def cloth() -> None:
    src = os.path.join(ASSETS, "fabric023")
    ndx = load_rgb(os.path.join(src, "Fabric023_1K-JPG_NormalDX.jpg"))
    gl = ndx.copy()
    gl[..., 1] = 1.0 - gl[..., 1]
    save_data(gl, "XO3_Cloth_NormalGL.png", half=True)
    frgh = load_rgb(os.path.join(src, "Fabric023_1K-JPG_Roughness.jpg"))[..., 0]
    save_data(np.clip(frgh * 0.30 + 0.58, 0, 1), "XO3_Cloth_Roughness.png", half=True)

    size = 1024
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    twill = np.sin((xx * 3.0 + yy * 3.0) * 2.0 * math.pi * 22.0) * 0.5 + 0.5
    weft = np.sin((xx - yy) * 2.0 * math.pi * 26.0) * 0.5 + 0.5
    drape = fbm(size, 1777, 3, 6)
    u = (xx + 0.014 * (drape - 0.5)) % 1.0
    stripe = np.clip(np.cos((u - 0.5) * 2 * math.pi * 2.0) * 2.6, -1, 1)
    mix = 0.5 + 0.5 * stripe
    bone = np.array([0.412, 0.372, 0.302], dtype=np.float32)
    ochre = np.array([0.300, 0.168, 0.058], dtype=np.float32)
    madder = np.array([0.196, 0.048, 0.036], dtype=np.float32)
    band = np.clip(np.cos((u - 0.5) * 2 * math.pi * 8.0) * 3.4, -1, 1) * 0.5 + 0.5
    cloth = (madder[None, None, :] * (1 - mix[..., None])
             + bone[None, None, :] * mix[..., None])
    cloth = cloth * (1 - 0.50 * band[..., None]) + ochre[None, None, :] * (0.50 * band[..., None])
    cloth *= (0.80 + 0.26 * weft)[..., None]
    cloth *= (0.88 + 0.24 * twill)[..., None]
    cloth *= (0.84 + 0.28 * drape)[..., None]
    edge = np.clip(1.0 - np.abs(yy - 0.5) * 7.0, 0, 1)
    cloth *= (0.66 + 0.34 * edge)[..., None]
    save_color(np.clip(cloth, 0, 1), "XO3_Cloth_Color.png")


# ---------------------------------------------------------- mud roof deck
def earth() -> None:
    """Lime-and-mud roof screed with chopped straw, straw showing as paler flecks."""
    size = 1024
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    body = fbm(size, 5309, 6, 7, warp=0.18)
    tooth = fbm(size, 5401, 4, 26)
    straw = np.clip(ridged(size, 5501, 2, 22) * 1.5 - 0.62, 0, 1)
    crack = fbm(size, 5603, 4, 5, warp=0.30)
    hair = np.clip(1.0 - np.abs(crack - 0.5) * 16.0, 0, 1) ** 2
    h = np.clip(0.34 * body + 0.30 * tooth + 0.20 * straw - 0.34 * hair, 0, 1)
    save_data(normal_from(h, 2.2), "XO3_Earth_NormalGL.png", half=True)
    save_data(np.clip(0.80 - 0.10 * straw + 0.14 * tooth, 0.55, 0.97),
              "XO3_Earth_Roughness.png", half=True)
    base = np.array([0.186, 0.138, 0.084], dtype=np.float32)
    straw_c = np.array([0.352, 0.288, 0.168], dtype=np.float32)
    c = base[None, None, :] * (0.84 + 0.30 * body)[..., None]
    c = c * (0.92 + 0.14 * tooth)[..., None]
    c = c * (1.0 - 0.45 * straw[..., None] * 0.5) + straw_c[None, None, :] * (straw[..., None] * 0.44)
    c *= (1.0 - 0.40 * hair)[..., None]
    save_color(np.clip(c, 0, 1), "XO3_Earth_Color.png")


# ------------------------------------------------------------------ sand ground
def ground() -> None:
    size = 1024
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    dune = fbm(size, 7701, 5, 4, warp=0.24)
    ripple = ridged(size, 7803, 3, 14)
    grit = fbm(size, 7907, 3, 90)
    pebble = np.clip((fbm(size, 8009, 2, 40) - 0.70) * 6.0, 0, 1)
    h = np.clip(0.34 * dune + 0.30 * ripple + 0.24 * grit + 0.30 * pebble, 0, 1)
    save_data(normal_from(h, 1.7), "XO3_Ground_NormalGL.png", half=True)
    save_data(np.clip(0.88 - 0.06 * grit + 0.10 * pebble, 0.70, 0.99),
              "XO3_Ground_Roughness.png", half=True)
    base = np.array([0.312, 0.236, 0.146], dtype=np.float32)
    pale = np.array([0.404, 0.324, 0.208], dtype=np.float32)
    c = base[None, None, :] * (0.82 + 0.34 * dune)[..., None]
    c *= (0.90 + 0.18 * ripple)[..., None]
    c *= (0.93 + 0.12 * grit)[..., None]
    c = c * (1.0 - pebble[..., None] * 0.45) + pale[None, None, :] * (pebble[..., None] * 0.45)
    save_color(np.clip(c, 0, 1), "XO3_Ground_Color.png")


def main() -> None:
    mudbrick()
    plaster()
    timber()
    stone()
    terracotta()
    cloth()
    earth()
    ground()
    print("PREP_TEXTURES_OK", flush=True)


if __name__ == "__main__":
    main()
    sys.exit(0)
