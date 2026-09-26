# PROVENANCE — XO authored desert shop row (pass 3)

All geometry, all textures and all layout decisions in this directory are original work produced
for this task. No asset was copied, traced, retopologised or derived from the reference
`xo_market_authored` market hall, and no Mali-derived texture is used anywhere.

---

## 1. Third-party inputs (the complete list)

### 1.1 CC0 source photographs used as *structure* only

| Local source | Licence | How it was used |
|---|---|---|
| `/var/folders/.../opencode/ambientcg-bricks098/extracted/Bricks098_1K-JPG_Color.jpg` | ambientCG, **CC0 1.0** | Squashed 1024x384 → 1024x1024, periodic-blurred, overpainted with 6 authored mudbrick bed lines, then re-blurred. The *cobble* shapes are gone; only a low-frequency tonal field survives. |
| `Bricks098_1K-JPG_Roughness.jpg` | ambientCG, **CC0 1.0** | Resampled to 512², contrast compressed, low-frequency blended. |
| `Bricks098_1K-JPG_NormalGL.jpg` | ambientCG, **CC0 1.0** | Read **only** for its noise character; the delivered normal map is generated from a procedural height field. |
| `/var/folders/.../opencode/fabric023/Fabric023_1K-JPG_NormalDX.jpg` | ambientCG, **CC0 1.0** | Y channel inverted to convert DirectX → OpenGL (+Y up), saved as `XO3_Cloth_NormalGL.png`. This is the one map delivered essentially as-supplied. |
| `Fabric023_1K-JPG_Roughness.jpg` | ambientCG, **CC0 1.0** | Remapped `r*0.30 + 0.58` and saved as `XO3_Cloth_Roughness.png`. |

ambientCG publishes every map under CC0 1.0 (public domain dedication, no attribution required,
attribution appreciated). <https://ambientcg.com/view?id=Bricks098> and
<https://ambientcg.com/view?id=Fabric023>.

### 1.2 The one third-party *mesh*

| Local source | Licence | How it was used |
|---|---|---|
| `donor/brass_diya_lantern_1k.glb` (copied from `/var/folders/.../opencode/polyhaven-market-props/brass_diya_lantern/`) | Poly Haven, **CC0 1.0** (`donor/source.json`) | Imported by `import_lantern()` in `src/shop_dressing.py`, uniformly scaled to 0.135, decimated (0.22 body, 0.22 chain, 0.40 link), joined to one object `donor_lantern_body`, re-parented under an empty `donor_brass_diya_lantern`, materials remapped to `XO3_DonorBrass` / `XO3_DonorBrassGlass`, and hung from a hand-authored iron stay at the stall head. |

`donor/source.json` records the upstream URL <https://polyhaven.com/a/brass_diya_lantern>.
Poly Haven releases all assets under CC0 1.0. The upstream GLB is self-contained (no `.bin`),
which is why the `donor/` directory has no `.bin`.

The export GLB embeds 27 images: 24 authored PNGs and 3 donor JPEGs
(`brass_diya_lantern_{diff,nor_gl,arm}_1k`)
untouched, because the decimation does not change UVs.

### 1.3 What is *not* in this asset

- No Mali-derived texture. Nothing in `textures/` derives from any Mali scan.
- No geometry copied from `xo_market_authored`. The two assets share only the architectural
  *subject* (a desert market structure) and the general technique of procedural generation.
  Dimensions, layout, opening positions, member naming and every generator function differ.
- No photogrammetry, no purchased kit, no generated-by-a-model meshes. Every vertex in
  `src/shop_lib.py`, `src/build_shop_row.py` and `src/shop_dressing.py` is placed by explicit
  arithmetic in this repository's own code.

---

## 2. Original work

| Component | File | What it is |
|---|---|---|
| Texture synthesis | `src/prep_textures.py` | 24 PBR maps, 1K colour + 512 data. Domain-warped fBm, ridged noise, periodic bilinear gather, and a height→normal converter, all written for this task. |
| Geometry kernel | `src/shop_lib.py` | `hexa`, `prism`, `boxc`, `beam`, `batter`, `wall`, `splay`, `lathe`, `tube`, `skin`, `grid_block`, `merge`, `project_uv`, `finish`. |
| Massing | `src/build_shop_row.py` | 11 builder functions. 466 of the 642 authored members. |
| Dressing | `src/shop_dressing.py` | Pottery, produce, crates, baskets, shelving, hearth, rugs, signage, rope lashings, the lantern import. The other 176 members. |
| Materials | `src/shop_materials.py` | 15 `XO3_*` materials + 2 donor remaps. |
| Collision | `src/build_collision.py` | 12 explicit AABB proxies plus a verify pass that re-opens the model and asserts each box overlaps real triangles. |
| Renders | `src/render_shop.py` | 6 inspection shots, Cycles CPU + Workbench. |
| Audit | `src/diag.py` | Counts, world bounds, non-manifold edge count, embedded image inventory. |
| Member record | `MEMBERS.txt` | 642 authored members dumped in build order: material, name, verts, faces, z-range. |

Every member is authored in **metres** against the constant `T = 0.78` (the wall thickness that
drives the whole massing), and the wall/roof positions derive from named constants
(`XW/XE`, `YF/YB`, `YFI/YBI`, `DECK_A/DECK_B`, `RECESS`, `HATCH`, `AW_OUT_Y`, …) rather than from
typed-in coordinates, so the building can be re-proportioned by editing one table.

---

## 3. Licence of this deliverable

The generated geometry, the generated textures and the scripts in `src/` are original work
created for this task and are released under **CC0 1.0** alongside the CC0 inputs they consume.
A downstream project may use the exported GLBs without attribution, exactly as ambientCG and
Poly Haven intend.

## 4. Reproduction

```sh
cd /var/folders/pt/hwgh5hrj1p909_r6ns6bkggm0000gn/T/opencode/xo_market_authored_pass3
B=/Applications/Blender.app/Contents/MacOS/blender          # Blender 5.2.0 LTS
$B -b --factory-startup --python src/prep_textures.py      # -> textures/*.png
$B -b --factory-startup --python src/build_shop_row.py     # -> export/shop_row.{blend,glb}
$B -b --factory-startup --python src/build_collision.py    # -> export/shop_row_collision.{blend,glb}
$B -b --factory-startup export/shop_row.blend --python src/render_shop.py   # -> renders/*.png
$B -b --factory-startup export/shop_row.blend --python src/diag.py
```

`prep_textures.py` reads the CC0 JPEGs from
`/var/folders/pt/hwgh5hrj1p909_r6ns6bkggm0000gn/T/opencode/ambientcg-bricks098/extracted/` and
`/var/folders/pt/hwgh5hrj1p909_r6ns6bkggm0000gn/T/opencode/fabric023/`;
`shop_dressing.import_lantern` reads `donor/brass_diya_lantern_1k.glb`. Point those two paths at
your own copies of the same CC0 files to rebuild elsewhere.
