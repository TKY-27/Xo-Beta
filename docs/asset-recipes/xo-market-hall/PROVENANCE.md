# Provenance & Licensing — `XO_MarketHall`

Verdict up front: **every input to this asset is CC0-1.0 or authored from scratch in this
recipe.** No third-party asset with uncertain terms was used. The one asset that
*failed* the CC0 check was deliberately rejected (see "Rejected" below).

Verification date for every figure, URL, hash and API response quoted below:
**2026-09-26.** Geometry figures are read out of the shipped production GLBs
(`public/assets/models/environment/xo-market/market-hall*.glb`) by parsing their glTF
JSON chunks, not copied from build logs.

---

## 1. Third-party source assets that WERE used

### 1.1 Poly Haven — `brass_diya_lantern` (3D mesh + 3 texture maps)

| Field | Value |
|---|---|
| Author | **Bhargav Kubal** — `"authors": {"Bhargav Kubal": "All"}` |
| Licence | **CC0 1.0 Universal (Public Domain Dedication)** |
| Asset page | <https://polyhaven.com/a/brass_diya_lantern> |
| API record | <https://api.polyhaven.com/info/brass_diya_lantern> (also in `https://api.polyhaven.com/assets?t=models`) |
| File manifest | <https://api.polyhaven.com/files/brass_diya_lantern> |
| Used by the recipe at | `docs/asset-recipes/xo-market-hall/donor/brass_diya_lantern/brass_diya_lantern_1k.glb` |
| Committed to this repository? | **No.** The donor binary is not vendored. Fetch it with the command in `README.md` → "Reproduce", and run the pre-flight block there before building: it fails hard when the donor is absent or is a 404 body masquerading as a `.glb`, because the builder itself only checks that the file exists. |

> **Author correction (2026-09-26).** Earlier revisions of this file credited
> *Sergej Majboroda*. That credit is wrong and is withdrawn. The Poly Haven API
> names **Bhargav Kubal** for this asset, the downloaded 1K glTF carries no author
> field at all (`"asset": {"generator": "Khronos glTF Blender I/O v1.6.16",
> "version": "2.0"}`, no `extras`), and no file in this repository names Majboroda.
> `docs/ASSET_MANIFEST.md` and `THIRD_PARTY_NOTICES.md` already carried the correct
> name for the separately shipped `brass-lantern.glb`; this entry now matches it.

Verbatim API record, fields trimmed to the provenance-relevant ones
(`https://api.polyhaven.com/info/brass_diya_lantern`, retrieved 2026-09-26):

```json
{
  "authors": { "Bhargav Kubal": "All" },
  "name": "Brass Diya Lantern",
  "donated": true,
  "type": 2,
  "date_published": 1639526400,
  "polycount": 12742,
  "max_resolution": [8192, 8192],
  "files_hash": "c8a70bbd5dd2708135a561576d895436844aaa25"
}
```

`"donated": true` is Poly Haven's own marker for a community-contributed asset, which
is why the credit is a person's name rather than a studio. The API publishes no
per-file licence field; the licence is the site-wide CC0 1.0
(<https://polyhaven.com/license>, quoted in `THIRD_PARTY_NOTICES.md`).

#### Fetching the donor — exact, verified 2026-09-26

`build_market.py` imports the donor from
`docs/asset-recipes/xo-market-hall/donor/brass_diya_lantern/brass_diya_lantern_1k.glb`,
so the Poly Haven 1K glTF download has to be repacked into a self-contained `.glb`
(Blender's glTF importer accepts either; `.glb` is what the recipe expects and what
produced the shipped LOD0).

| File | Bytes | MD5 | URL |
|---|---|---|---|
| `brass_diya_lantern_1k.gltf` | 10,202 | `b63559d7be74c31db17a87f81b5b0f41` | <https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/brass_diya_lantern/brass_diya_lantern_1k.gltf> |
| `brass_diya_lantern.bin` | 455,708 | `1e09f3575cab311415e85fd76256a067` | <https://dl.polyhaven.org/file/ph-assets/Models/gltf/**8k**/brass_diya_lantern/brass_diya_lantern.bin> |
| `textures/brass_diya_lantern_diff_1k.jpg` | 536,573 | `322aec4839a32604193352a4a55616c6` | <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/brass_diya_lantern/brass_diya_lantern_diff_1k.jpg> |
| `textures/brass_diya_lantern_nor_gl_1k.jpg` | 263,044 | `532e464289bf6788d2f943c3e47c73ab` | <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/brass_diya_lantern/brass_diya_lantern_nor_gl_1k.jpg> |
| `textures/brass_diya_lantern_arm_1k.jpg` | 704,276 | `25c3e0ffce574e9748754354b5e4eed0` | <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/brass_diya_lantern/brass_diya_lantern_arm_1k.jpg> |

**Trap, verified 2026-09-26:** the buffer is **not** served next to the 1K `.gltf`.
`https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/brass_diya_lantern/brass_diya_lantern.bin`
returns HTTP 404 with the JSON body
`{"code": "not_found", "message": "File with such name does not exist.", "status": 404}`.
Poly Haven's own file manifest points the 1K `include` entry at the **8k** glTF
directory, and the 455,708-byte buffer fetched from there matches the manifest MD5
exactly. The 1K `.gltf` references `"uri": "brass_diya_lantern.bin"`, so a naive
"download everything sitting next to the .gltf" run produces a 94-byte JSON error page
saved as `.bin` and a donor with **no geometry at all** — which the builder cannot
detect, because it only checks that the file exists.

MD5s are the values published by the Poly Haven file manifest; the `.gltf` and `.bin`
MD5s were additionally verified by download. The 1K glTF's own geometry is
5 primitives / 10,126 `POSITION` entries / **12,742 triangles**, which matches the API's
`"polycount": 12742`.

**How it is used:** the *only* non-authored geometry in the GLB. In the shipped LOD0 it
is a `donor_brass_diya_root` empty carrying a **uniform scale of 0.95** and a
**24.0° rotation** (exported quaternion `[0, 0.20791173, 0, 0.97814769]`, i.e. a spin
about the vertical axis; 24° about Z in the recipe's Z-up authoring frame), placed at
glTF translation `(-1.34, 0.955, 3.30)` = `(-1.34, -3.30, 0.955)` in the authoring
frame. The lantern's world AABB is 0.154 x 0.362 x 0.154 m, sitting from z 0.955 m to
z 1.317 m as the merchant's hanging stall lamp. *(Earlier revisions of this file said
"scaled to 0.34" and placed it at `(-1.32, -3.32, 0.955)`; the 0.34 scale was simply
wrong — the node scale in the shipped file is 0.95, and the local mesh geometry is
unmodified source geometry, 0.124 x 0.291 x 0.123 m.)* Its three meshes
(`brass_diya_lantern`, `brass_diya_lantern_chain`, `brass_diya_lantern_connection`)
are re-parented under `donor_brass_diya_root` — which is a **sibling scene root** of
`XO_MarketHall`, not a child of it — renamed `donor_diya_*`, box-UV-projected at 1.0
(`L.box_uv(o, 1.0)`) and kept as their own `XO_Donor_*` materials so they can be swapped
or deleted without touching the authored geometry.

**Measured contribution to the shipped LOD0** (parsed from `market-hall.glb`):

| Donor mesh | Exported verts | Triangles |
|---|---|---|
| `donor_diya_brass_diya_lantern` | 7,411 | 7,798 |
| `donor_diya_brass_diya_lantern_chain` | 4,431 | 4,356 |
| `donor_diya_brass_diya_lantern_connection` | 565 | 588 |
| **Donor total (3 meshes, 5 primitives)** | **12,407** | **12,742** |
| **Share of LOD0** | **17.0 %** of 73,158 verts | **17.4 %** of 73,356 tris |

The increase from 10,126 source verts to 12,407 exported verts is glTF triangulation
plus UV seam splits on import; the triangle total is unchanged at 12,742.

**Not redistributed verbatim:** it is rotated, uniformly scaled to 0.95 and re-placed, so
it is a derivative. That is permitted by CC0, but the attribution note in §4 is retained
anyway.

### 1.2 ambientCG — `Bricks098` (source for the mudbrick maps)

| Field | Value |
|---|---|
| Asset page | <https://ambientcg.com/view?id=Bricks098> |
| Download | `https://ambientcg.com/get?file=Bricks098_1K-JPG.zip` |
| Retrieved 2026-09-26 | 4,875,830 bytes, SHA-256 `230ac16e9a105442c605ba1f47d8626dd7b336ec1ea5a922f3c895f31aec91a0` |
| Consumed members | `Bricks098_1K-JPG_Color.jpg`, `Bricks098_1K-JPG_NormalGL.jpg`, `Bricks098_1K-JPG_Roughness.jpg` |
| Licence | **CC0 1.0 Universal** (ambientCG publishes every asset as CC0) |
| Author | ambientCG (CC0 — no attribution required, attribution given voluntarily) |
| Committed to this repository? | **No.** Fetched into the layout described in `README.md` → "Reproduce". |

ambientCG re-issues its archives, so the SHA-256 above is a *retrieval* record for
2026-09-26, not a stable pin. The 1K-JPG archive also ships `AmbientOcclusion`,
`Displacement`, `NormalDX`, a `.usdc`, a `.blend`, `.mtlx` and `.tres`; only the three
members listed above are read.

**How it is used:** post-processed by `docs/asset-recipes/xo-market-hall/prep_textures.py`
into `XO_Mudbrick_{Color,NormalGL,Roughness}.png`:
* the sRGB JPEG is linearised, then collapsed to Rec.709 luma `lum = 0.30*r + 0.59*g + 0.11*b`;
* value range compressed (`lum = 0.55*lum + 0.45*0.150`) to de-cobble the harsh fieldstone;
* hue remapped to a sandy adobe ramp `(lum*0.660+0.030, lum*0.435+0.014, lum*0.240+0.004)`,
  clipped, then re-encoded linear → sRGB on save;
* roughness `rough*0.92 + 0.16` clamped to `0.30..0.99`;
* the normal map is copied through at the 1K source resolution (1024 px, `down=1`) from
  the *glTF* `NormalGL` channel convention, so no green-channel inversion is needed
  here (DirectX maps are channel-inverted on import, and the archive also ships
  `NormalDX`).

*(Earlier revisions of this file quoted the adobe ramp as
`(lum*1.72+0.038, lum*1.30+0.022, lum*0.80+0.010)` and claimed the normal map was
"downsampled to 2048 px wide". Both were wrong: the ramp constants above are what
`prep_textures.py:143-145` computes, and a 1K source cannot be downsampled to 2048 px.)*

### 1.3 ambientCG — `Fabric023` (source for the fabric maps)

| Field | Value |
|---|---|
| Asset page | <https://ambientcg.com/view?id=Fabric023> |
| Download | `https://ambientcg.com/get?file=Fabric023_1K-JPG.zip` |
| Retrieved 2026-09-26 | 7,945,819 bytes, SHA-256 `02504638f975038c51939fa745f11d2c794070d38c16bbff1167fddcf093a6f8` |
| Consumed members | `Fabric023_1K-JPG_NormalDX.jpg`, `Fabric023_1K-JPG_Roughness.jpg` |
| Licence | **CC0 1.0 Universal** |
| Committed to this repository? | **No.** Same layout as §1.2. |

As with Bricks098 the SHA-256 is a 2026-09-26 retrieval record, not a pin. The archive
also ships `Color`, `Displacement`, `NormalGL`, a `.usdc`, a `.blend`, `.mtlx` and
`.tres`.

**How it is used:** `XO_Fabric_{NormalGL,Roughness}.png`. The recipe deliberately reads
the **DirectX** normal map for this asset and writes
`gl[..., 1] = 1.0 - gl[..., 1]` to convert to the **OpenGL (+Y) green-up** convention
that glTF mandates. Without this inversion the awning lighting is wrong. Roughness
`rough*0.35 + 0.55`. Both fabric maps are box-filtered to half resolution
(`down=2`, 512 x 512) because noisy normal maps are the largest contributor to GLB
weight and the least sensitive to texel density.

### 1.4 KayKit / ipoly3d — `LowPoly_Arab_Houses` (REFERENCE ONLY, not shipped)

| Field | Value |
|---|---|
| Local source | an authoring scratch tree outside this repository, `…/ashara-cc0/extracted/{glTF,FBX}/…` and `kaykit-market-red.glb` |
| Licence | **CC0 1.0 Universal** — `ashara-cc0/extracted/README.txt` states verbatim: `License: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication https://creativecommons.org/publicdomain/zero/1.0/` |
| Author | KayKit / Enric — free game assets |
| Committed to this repository? | **No**, and nothing in the recipe reads it. |

**How it is used: NOT USED IN THE ASSET.** `kaykit-market-red.glb` was imported once
only to *measure* the asset being replaced (1 object, 4 165 verts, 3 125 tris, bounds
1.800 × 1.316 × 0.982 at unit scale → ≈ 7.4 × 5.4 × 4.0 m at the in-game scale factor of
4.1), so the new hall could be dimensioned to sit in the same footprint. **No KayKit
geometry, no KayKit texture, and no KayKit vertex is present in the exported GLB.**

**Open provenance limitation:** the pack name and the "KayKit / Enric" credit in this
section were carried over from the authoring session and have **not** been re-verified
against a licence file inside this repository — the `README.txt` quoted above lived in
the scratch tree and is not committed here. The measurement quoted above
(1 object, 4 165 verts, 3 125 tris) comes from the same unre-verified session and is
recorded as an authoring note rather than as a verified figure. This repository separately
ships CC0 KayKit
"Medieval Hexagon Pack 1.0" geometry by Kay Lousberg
(`public/assets/models/environment/kaykit-market.glb`, recorded in
`docs/ASSET_MANIFEST.md` and `THIRD_PARTY_NOTICES.md`), which is a *different* pack from
the one named above. Because nothing from this reference ships, the ambiguity does not
affect the licence of any delivered file; it is recorded here rather than silently
dropped.

---

## 2. Source assets that were REJECTED (kept out on licence grounds)

A set of perfectly usable-looking maps exists in the authoring scratch tree outside this
repository: `T_Plaster_*.png`, `T_UnevenBrick_*.png`, `T_WoodTrim_*.png`.
Tracing them shows they were **extracted from the Mali game `.blend`**
(`convert-mali-market.py` opens a Mali `*_market.blend` and packs its embedded images).
Game-project textures carry the **Mali / Abubakar Salim studio's own terms**, not CC0 —
the words "CC0" only appear because a *separate* freely-licensed asset in the same
scratch tree is CC0. **These maps were therefore excluded from every material and from
every render in this prototype, and they are not in this repository at all.** No recipe
script references them, and none of their pixels reached `market-hall.glb`,
`market-hall-lod2.glb` or `market-hall-collision.glb`.

If a production version wants that look, the correct route is to re-author it (as was done
here for plaster) or to license the maps properly — not to reach for the extracted PNGs.

---

## 3. Textures that are 100% authored in this prototype

Generated procedurally by `docs/asset-recipes/xo-market-hall/prep_textures.py` (NumPy
tileable value-noise fBm, fixed integer seeds, written to the `textures/` directory
beside the recipe). Nothing was downloaded for these. Column "px" is the resolution
actually written: colour maps are authored at 1024 and saved at full size, and the
data maps passed to `save_data(..., down=2)` are box-filtered to 512.

| File | px | How |
|---|---|---|
| `XO_Plaster_Color.png` | 1024 | base linear `(0.272, 0.219, 0.152)` x fBm mottling `0.68+0.66*h1` x vertical rain streaks `1-0.30*streak^1.4` (streak = fBm seed 5501 stretched `0.55*fbm + 0.45*column-mean`) x damp `1-0.34*grit` + `0.080*(trowel-0.5)`, then linear → sRGB |
| `XO_Plaster_NormalGL.png` | 512 | height = `0.55*fbm(101,6 oct,6 cells) + 0.30*grit(733,96 cells) + 0.15*trowel(1409,3 cells)`, normalised, tangent normal, strength **9.0** |
| `XO_Plaster_Roughness.png` | 512 | `clip(0.80 + 0.20*(1-h1) - 0.06*grit, 0.55, 0.99)` |
| `XO_Stone_Color.png` | 1024 | base linear `(0.196, 0.158, 0.108)` x `(0.74 + 0.52*st)` x `(1 - 0.16*pit^2)`, where `st = clip(0.62 + 0.52*(bed-0.5) + 0.30*(pit-0.5) - 0.09*clip(chip-0.72,0,1)*4.0, 0, 1)` from fBm seeds 2609 (bedding), 6151 (pitting), 9001 (edge chipping) |
| `XO_Stone_NormalGL.png` | 512 | height = `0.62*bed + 0.24*pit + 0.14*chip`, tangent normal, strength **0.9** |
| `XO_Stone_Roughness.png` | 512 | `clip(0.62 + 0.30*(1-pit), 0.40, 0.97)` |
| `XO_Wood_NormalGL.png` | 512 | `0.60*(sin((26*xx + 3*yy + 7*warp)*pi)*0.5+0.5) + 0.28*fine(991) + 0.12*warp`, `warp = fbm(4211)-0.5`, tangent normal, strength **2.2** |
| `XO_Awning_Color.png` | 1024 | **3** broad bands per tile along **U** (box-projected UVs put world **X** in **U**): madder red `(0.124, 0.060, 0.026)` vs bleached flax `(0.268, 0.222, 0.156)`, `clip(cos((u-0.5)*2pi*3)*3.2)` for crisp edges with a `0.012*sin(9pi*yy) + 0.010*(weave-0.5)` domain wobble, x weave `0.86+0.28*weave` (fBm 8081), x sun bleaching `1-0.13*soil^1.5` (fBm 313), x seam shadow `0.80+0.20*clip(2*|band|,0,1)` |

*(Earlier revisions of this file listed every map as `1024x512`, quoted the plaster and
fabric ramp constants that the code does not use, gave the stone albedo base as
`(0.150, 0.126, 0.094)` and the stone normal strength as 1.5. All four were stale; the
table above matches `prep_textures.py` line for line.)*

**Why U not V:** the wood and awning runs are `strut` pieces whose local Z is the length
axis, and `box_uv` projects the dominant-face non-axis coordinates — so world/long-axis X
lands in U. The bands had to be generated along U or the awning stripes came out
orthogonal to the gable. This is also why the wood grain must run along U.

**Map counts:** 8 of the 13 files in `textures/` are authored here, 5 are derived from
ambientCG above. 17 images are embedded in LOD0 — these 13 plus **4** donor entries
(`brass_diya_lantern_nor_gl_1k`, `brass_diya_lantern_diff_1k` as JPEG,
`brass_diya_lantern_arm_1k`, and a second `brass_diya_lantern_diff_1k` that the exporter
re-encoded to PNG), against 4 `XO_Donor_*` materials
(`..._lantern`, `..._lantern.001`, `..._lantern_glass`, `..._lantern_flame`) and 16
`XO_*` materials. The awning colour map is also what forced
`UV_TABLE["XO_Fabric_Awning_Terracotta"] = 2.00` (`build_market.py:1297`): at 0.85 a
1.95 m gable sampled a single blotchy band, at 2.00 it gets ~12 narrow 17 cm stripes
running the full length of the slope.

---

## 4. Attribution (not required by CC0, given voluntarily)

* Poly Haven — `brass_diya_lantern` by **Bhargav Kubal** — <https://polyhaven.com/a/brass_diya_lantern> (CC0 1.0)
* ambientCG — `Bricks098`, `Fabric023` — <https://ambientcg.com> (CC0)
* Reference only, not shipped: KayKit "LowPoly Arab Houses" by Enric / KayKit — <https://kaylousberg.itch.io/kaykit-adventure> (CC0; attribution as recorded, see the open limitation in §1.4)

---

## 5. Game-asset terms (applies to the shipped GLBs themselves)

The shipped `public/assets/models/environment/xo-market/market-hall.glb` is composed of:

* **83.0 % authored geometry** — 60,751 of 73,158 exported vertices and 60,614 of
  73,356 triangles, produced by this repository's own Blender scripts from primitives
  and dimension constants; and
* **17.0 % / 17.4 % CC0 Poly Haven donor geometry** — 12,407 vertices and 12,742
  triangles of `brass_diya_lantern`.

Those are the figures parsed out of the shipped file on 2026-09-26. *(An earlier
revision of this file claimed "~99 % authored / ~1 % Poly Haven (10 158 of 37 112
vertices, 12 734 of 65 336 triangles)"; those denominators were pre-merge build-log
figures and are withdrawn. The correct donor triangle total is 12 742, not 12 734.)*

Because every input is CC0-1.0, the result is **CC0-1.0 / public domain** and can be
shipped inside a proprietary or closed-source game without restriction. The
`XO_MarketHall` root empty carries
`"xo_licence": "CC0 1.0 (authored geometry) / CC0 1.0 (donor + ambientCG maps)"` and
`"xo_donor": "1 CC0 PolyHaven brass_diya_lantern prop (CC0-1.0, polyhaven.com/a/brass_diya_lantern)"`
for downstream tooling. The binary extras name the asset page but do **not** name an
author, so no author claim in this asset is baked into the shipped files.

**Embedded metadata vs. measured geometry.** Two extras in the shipped files do not
describe triangles and boxes correctly, and downstream tooling should not trust them:

| File | Extra | Value in file | Measured truth |
|---|---|---|---|
| `market-hall-lod2.glb` | `xo_faces` | `2721` | **5,038 triangles.** `xo_faces` is a pre-export *source face* count (quads + tris) written by the builder before export triangulation. |
| `market-hall-collision.glb` | `xo_authored` | `"10 axis-aligned boxes, authored in Blender"` | **12 boxes** (288 verts / 144 tris). The string was never updated when the leanto, two canopy posts and the two stall proxies were added. |
| `market-hall.glb` | `xo_faces` | `73356` | 73,356 triangles — correct. |
| `market-hall.glb` | `xo_materials` | `20` | Correct: 16 `XO_*` + 4 `XO_Donor_*`. |

## Files shipped, and where they live

Production files, all committed in this repository:

| File | Origin | Licence |
| --- | --- | --- |
| `public/assets/models/environment/xo-market/market-hall.glb` | 12,069,956 bytes, SHA-256 `a91888bbdd640ccb1afd8e6a88f957f8d8d92a2d70b2416ec4953c486531f2c5`. Authored in Blender 5.2.0 by `docs/asset-recipes/xo-market-hall/build_market.py` + `market_massing.py` (19 meshes, 73,356 tris, 20 materials, 17 embedded images), except the single donor prop in §1.1. | CC0 1.0 |
| `public/assets/models/environment/xo-market/market-hall-lod2.glb` | 6,836,372 bytes, SHA-256 `31ade36ccab5601d86d02aad45343093efb8d2d1d50729b087f482d0f46065e5`. 100 % authored by `docs/asset-recipes/xo-market-hall/build_lod2.py` (9 meshes, 5,038 tris, 9 materials). No donor geometry at all. | CC0 1.0 |
| `public/assets/models/environment/xo-market/market-hall-collision.glb` | 14,556 bytes, SHA-256 `3fd5277fbaf11d78fa649f90e7a51c051a95e721a746c0a3881bff6578fb858c`. 100 % authored by `docs/asset-recipes/xo-market-hall/build_collision.py`. **12** axis-aligned boxes (288 verts / 144 tris), no donor geometry. | CC0 1.0 |
| `docs/asset-recipes/xo-market-hall/*.py` | The generator: `market_lib.py`, `market_massing.py`, `market_materials.py`, `prep_textures.py`, `build_market.py`, `build_collision.py`, `build_lod2.py`, `render_market.py`, plus the `diag_bounds.py` / `diag_members.py` validators. | Repository MIT (scripts), CC0 1.0 (output geometry) |
| `docs/asset-recipes/xo-market-hall/README.md`, `PROVENANCE.md` | This record. | — |

Build by-products that are **not** committed, and are reproduced by the recipe rather
than shipped:

| By-product | Where the recipe writes it | Note |
| --- | --- | --- |
| `textures/XO_*.png` (13 files) | `docs/asset-recipes/xo-market-hall/textures/` | 5 derived from CC0 ambientCG (§1.2, §1.3) with the recipes tabulated above; 8 authored from scratch as tileable numpy fBm. All 13 are embedded in the shipped LOD0. |
| `export/market_hall{,_lod2,_collision}.blend` | `docs/asset-recipes/xo-market-hall/export/` | Blender source scenes. `build_collision.py:61` re-opens `export/market_hall.blend` to measure the authored members and `render_market.py:20` renders it, so LOD0 must be built first; `build_lod2.py` does **not** read the `.blend` — it imports the dimension constants from `build_market` and authors LOD2 from scratch. |
| `renders/01..12_*.png` | `docs/asset-recipes/xo-market-hall/renders/` | Cycles / orthographic / Workbench previews, `render_market.py` only. |
| `donor/brass_diya_lantern/` | `docs/asset-recipes/xo-market-hall/donor/brass_diya_lantern/` | PolyHaven, 3 meshes, 12,742 triangles of LOD0. Fetched, not vendored — see §1.1. |
| `donor/kaykit-market-red.glb` | — | **Reference only. NOT shipped inside any of the three GLBs, and not committed here.** It was measured (1 object / 4,165 verts / 3,125 tris) to size the replacement and nothing was copied from it. | CC0 1.0 |

No texture, mesh or material from any non-CC0 source appears in any shipped file.
The `T_Plaster_*`, `T_UnevenBrick_*` and `T_WoodTrim_*` PNGs that sit in the authoring
scratch tree are **deliberately unused**: they were extracted from the Mali *game*
`.blend` by `convert-mali-market.py`, so their licence cannot be verified.
