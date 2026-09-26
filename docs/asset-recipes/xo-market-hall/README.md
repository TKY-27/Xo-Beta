# XO Market Hall — authored desert-market building GLB

Prototype replacement for the low-poly KayKit Ashara market background.
This directory is the **generator**: Python scripts plus the provenance record. The
artefact it produces is committed to the repository under
`public/assets/models/environment/xo-market/` and is loaded from there at runtime.
All counts, bounds and hashes below were re-derived from those committed files on
**2026-09-26** by parsing their glTF JSON chunks, not from build logs; see
`PROVENANCE.md` for sources, licences and the CC0 rejection record.

## Deliverable

Shipped production files (committed, hashed in `docs/ASSET_CHECKSUMS.txt`):

| Path | What it is |
| --- | --- |
| `public/assets/models/environment/xo-market/market-hall.glb` | **LOD0, the asset.** glTF 2.0 binary, 1:1 metres, Y-up as glTF requires, +Z forward, origin at ground level / footprint centre. 19 mesh objects (16 authored + 3 donor) + `XO_MarketHall` root empty carrying metadata extras. |
| `public/assets/models/environment/xo-market/market-hall-lod2.glb` | **LOD2** — hand-authored 5,038-triangle reduction. Same origin, same 1:1 metres, same material names, 6.9 % of the triangles. |
| `public/assets/models/environment/xo-market/market-hall-collision.glb` | **Collision hull** — 12 axis-aligned boxes, outward-wound, parented to the empty `XO_MarketHall_Collision`. |

Build by-products. These are written *beside* this README by the recipe and are
**not committed**; everything that matters is embedded in the three GLBs above.

| Path (relative to this directory) | What it is |
| --- | --- |
| `export/market_hall.blend` | Blender source scene for LOD0. `build_collision.py` re-opens it to measure the authored members. |
| `export/market_hall_lod2.blend`, `export/market_hall_collision.blend` | Blender source scenes for LOD2 and the hull. |
| `textures/*.png` | 13 authored/derived PBR maps (see `PROVENANCE.md`); 4 more arrive inside the donor, for the 17 images embedded in LOD0. |
| `renders/*.png` | 7 gameplay-angle Cycles previews, 2 orthographic previews, 3 Workbench solid previews. `render_market.py` only. |
| `donor/brass_diya_lantern/` | The one borrowed asset — Poly Haven's CC0 brass Diya lantern, by Bhargav Kubal. **Fetched, not vendored** — see "Reproduce". |
| `*.py` | The generator. |

## Size and counts

Hall footprint **8.00 m (X) x 5.00 m (Y)**, eaves at **3.70 m**, roof deck at
**3.70 m**, parapet coping to **4.06 m**, upper chamber coping to **5.39 m**
(the same figures the GLB root extra `xo_scale` records as "facade width 8.00 m,
height 4.54 m", the hall proper excluding the lean-to and the cactus).

**Frames.** The recipe authors in Blender's Z-up, +Y forward; the glTF exporter
writes Y-up, so a point `(x, y_depth, z_height)` in the authoring frame lands at
`(x, z_height, -y_depth)` in the file. Bounds are given below in the authoring
frame, with the exported Y-up values in brackets.

LOD0 world bounds, authoring frame: **9.186 (X) x 9.392 (Y) x 5.398 (Z) m** —
`min (-4.450, -4.197, -0.008)`, `max (4.736, 5.195, 5.390)`; as exported (Y-up):
`min (-4.450, -0.008, -5.195)`, `max (4.736, 5.390, 4.197)`. The asymmetric lean-to
reaches 5.195 m to the north and 4.197 m to the south; the cactus reaches x 4.736 m;
0.218 m of earth-floor geometry sits below the z = 0 ground plane.

### LOD0 — `market-hall.glb` (the asset)

| Metric | Value |
| --- | --- |
| Mesh objects in GLB | 19 (16 authored + 3 donor), 21 primitives |
| Authored members merged | 567 |
| Vertices (`.blend`, pre-merge) | 25,693 across the 16 authored material groups (sum of the table below) |
| **Vertices (GLB, exported)** | **73,158** — after triangulation and UV seam splits |
| **Triangles (GLB, exported)** | **73,356** |
| Materials | **20** (16 `XO_*` + 4 `XO_Donor_*`) |
| Embedded images | 17 |
| GLB size | 12,069,956 bytes (11.5 MB) |
| Authored share | **60,751 verts / 60,614 tris = 83.0 % / 82.6 %** |
| Donor share | **12,407 verts / 12,742 tris = 17.0 % / 17.4 %** |

The exported figures are the authoritative ones and are what the shipped SHA-256
covers. A separate post-merge, pre-modifier tally of "40,550 verts / 28,373 quads /
13,812 n-gons and triangles" was reported by an earlier build of `build_market.py`;
it cannot be reconciled with the per-material table below and is not re-derivable
from the all-triangle export, so it is recorded here as a historical build-log
figure rather than as a shipped property. **An earlier revision of this file claimed
"~64,000 vertices"; the exported file has 73,158.**

### LOD2 — `market-hall-lod2.glb`

| Metric | Value |
| --- | --- |
| Mesh objects | 9 (one per material) |
| Vertices (exported) | 10,186 |
| Source faces (pre-export) | 2,721 (a mix of quads and triangles) |
| **Triangles (exported)** | **5,038** (6.9 % of LOD0) |
| Materials | 9 |
| GLB size | 6,836,372 bytes |
| Bounds | authoring frame `min (-4.410, -4.190, 0.000)`, `max (4.580, 5.176, 5.360)`; as exported `min (-4.410, 0.000, -5.176)`, `max (4.580, 5.360, 4.190)` |

**`xo_faces: 2721` in the GLB root extra is a source *face* count, not a triangle
count.** LOD2 is exported as 5,038 triangles; 2,721 x 2 = 5,442 does not hold because
the pre-export source mixes quads and triangles. The pre-export per-material vertex
tallies (Plaster 844, Wood 728, Stone 476, Mudbrick 320, Terracotta 172,
FabricAwning 114, FabricCanvas 64, Earth 48, FabricRust 8 — 2,774 in total) are
builder-log figures; the 10,186 exported `POSITION` entries are what the shipped
file actually contains, the difference being triangulation and UV seam splits.

LOD2 is **hand-authored, not decimated.** A Decimate modifier collapses the round
arch into a rectangle and dissolves the limestone voussoir ring, which is exactly
the silhouette LOD2 exists to preserve.

### Collision — `market-hall-collision.glb`

| Metric | Value |
| --- | --- |
| Boxes | **12** (`canopy_post_e0/e1`, `canopy_post_w0/w1`, `entry_steps`, `hall_cap`, `hall_mass`, `hall_plinth`, `leanto`, `stall_ext`, `stall_int`, `upper_room`) — 288 verts / 144 tris in total |
| Object | 12 child meshes, parented to empty `XO_MarketHall_Collision` |
| Bounds (as exported, Y-up) | `min (-4.350, 0.000, -4.860)`, `max (4.380, 5.390, 4.105)` — 8.730 x 5.390 x 8.965 m |
| Bounds vs LOD0 | Ground plane and height match LOD0 to within 0.008 m. X and Y are **inset** by design: the hull stops 0.10 m short of the west wall, 0.35 m short of the cactus at x 4.736, 0.34 m short of the lean-to at y -5.195, and 0.09 m short of the awning posts. *(An earlier revision claimed "identical to LOD0 within 0.05 m"; that is true for the ground plane and height only.)* |
| GLB size | 14,556 bytes |
| Verification | `build_collision.py` re-opens the LOD0 `.blend` and prints which material groups each box overlaps — `COLLISION_VERIFY boxes=12 empty=0` |

**Embedded-metadata discrepancy (binary, not fixable from documentation):** the hull's
`XO_MarketHall_Collision` extra still reads `"xo_authored": "10 axis-aligned boxes,
authored in Blender"`. The file contains **12** boxes, as listed above. The extra is
stale; the geometry is not. Regenerating the hull from the current
`docs/asset-recipes/xo-market-hall/build_collision.py` is what would correct it, and
that is out of scope for a documentation change.

### Per-material breakdown (authored, pre-merge)

| Material | Members | Verts | Faces |
| --- | --- | --- | --- |
| `XO_Wood` | 187 | 10,472 | 10,098 |
| `XO_Mudbrick` | 125 | 4,400 | 4,477 |
| `XO_Terracotta` | 12 | 3,022 | 3,196 |
| `XO_Plaster` | 8 | 2,130 | 1,995 |
| `XO_WroughtIron` | 89 | 1,414 | 1,132 |
| `XO_Stone_Limestone` | 16 | 1,132 | 1,096 |
| `XO_Fabric_Awning_Terracotta` | 1 | 700 | 698 |
| `XO_Rope` | 12 | 675 | 670 |
| `XO_Foliage` | 3 | 674 | 690 |
| `XO_Fabric_Canvas` | 3 | 290 | 252 |
| `XO_Fabric_Indigo` | 2 | 192 | 188 |
| `XO_Earth_Floor` | 3 | 168 | 162 |
| `XO_LampGlass` | 24 | 136 | 102 |
| `XO_Fabric_Shade_Cream` | 1 | 96 | 94 |
| `XO_Fabric_Rust` | 1 | 96 | 94 |
| `XO_Brass` | 6 | 96 | 60 |
| **Total** | **567** | **25,693** | **25,004** |

Donor: 3 meshes, 10,126 verts in the source 1K glTF / 12,407 after glTF
triangulation and UV seam splits (7,798 + 4,356 + 588 = 12,742 triangles).

## Reproduce

Run everything from the repository root. The recipe is self-contained apart from
three **external** inputs that are deliberately *not* committed (the donor GLB is a
third-party download and the two ambientCG archives are ~12 MB between them):

| External input | Fetches into | Needed by | Licence |
| --- | --- | --- | --- |
| `brass_diya_lantern` 1K glTF + `.bin` + 3 JPEGs, from Poly Haven (exact URLs, byte counts and MD5s in `PROVENANCE.md` §1.1), then repacked to a self-contained `.glb` | `docs/asset-recipes/xo-market-hall/donor/brass_diya_lantern/` | `build_market.py` (imports the `.glb`) | CC0 1.0 |
| `Bricks098_1K-JPG.zip` from ambientCG | `docs/asset-recipes/xo-market-hall/ambientcg-bricks098/`, unzipped to `./extracted/` | `prep_textures.py` | CC0 1.0 |
| `Fabric023_1K-JPG.zip` from ambientCG | `docs/asset-recipes/xo-market-hall/fabric023/` | `prep_textures.py` | CC0 1.0 |

`prep_textures.py:24` reads those two ambientCG directories through a constant that
is still hard-coded to an authoring scratch path:

```python
SRC_ROOT = "/var/folders/pt/hwgh5hrj1p909_r6ns6bkggm0000gn/T/opencode"
```

That path is an artefact of the machine the asset was authored on, it is not part
of the repository, and **it has to be repointed before the recipe can run
anywhere else** — as shipped, `prep_textures.py` is *not* runnable from a clean
checkout. A documented preparation step is the only fix; changing the script is
out of scope for this documentation pass and is tracked as recipe debt. The
required layout is exactly what the constant expects:

```
docs/asset-recipes/xo-market-hall/
  ambientcg-bricks098/
    Bricks098_1K-JPG.zip            # download
    extracted/                      # unzip here
      Bricks098_1K-JPG_Color.jpg
      Bricks098_1K-JPG_NormalGL.jpg
      Bricks098_1K-JPG_Roughness.jpg
  fabric023/
    Fabric023_1K-JPG.zip            # download
    Fabric023_1K-JPG_NormalDX.jpg   # unzip here
    Fabric023_1K-JPG_Roughness.jpg
  donor/
    brass_diya_lantern/
      brass_diya_lantern_1k.gltf    # download
      brass_diya_lantern.bin        # download — from the 8k/ URL, see PROVENANCE 1.1
      textures/brass_diya_lantern_{diff,nor_gl,arm}_1k.jpg   # download
      brass_diya_lantern_1k.glb     # repack the .gltf + .bin above into one GLB
  *.py
```

`build_market.py` imports the repacked `brass_diya_lantern_1k.glb`, not the `.gltf`
(`build_market.py:1252-1254`), so the repack is a required preparation step, not an
optimisation. Blender's glTF importer accepts either form, so any faithful repack of
those exact four files works; `PROVENANCE.md` §1.1 lists the byte counts and MD5s to
verify the download before repacking. The donor's 4 JPEGs travel inside the `.glb` and
end up as the 4 `XO_Donor_*` material images in the shipped LOD0, which is why the
recipe needs no separate texture step for them.

`build_market.py` and the two downlevel builders do **not** have that problem: all
of their inputs are inside the recipe directory (`textures/`, `donor/`), which is
what they write too (`export/`). After a `prep_textures.py` run and a fresh
donor download, no other external input is required.

**Pre-flight — make the donor a hard failure yourself.** The builder will not do it
for you (see below), so gate the build on these four checks before it runs:

```sh
R=docs/asset-recipes/xo-market-hall
D=$R/donor/brass_diya_lantern/brass_diya_lantern_1k.glb
# 1. the donor is present
test -f "$D" || { echo "MISSING DONOR: see PROVENANCE.md 1.1"; exit 1; }
# 2. it is the real file, not a 94-byte 404 body saved as .glb
test "$(wc -c <"$D")" -gt 100000 || { echo "DONOR IS AN ERROR PAGE, not a GLB"; exit 1; }
# 3. the ambientCG inputs the textures came from
test -f "$R/ambientcg-bricks098/extracted/Bricks098_1K-JPG_Color.jpg" || exit 1
test -f "$R/fabric023/Fabric023_1K-JPG_NormalDX.jpg" || exit 1
# 4. after building, the GLB really has the donor in it
grep -c XO_Donor_ public/assets/models/environment/xo-market/market-hall.glb >/dev/null
```

Step 4 is a crude byte grep for the `XO_Donor_` material names, which are present in
the JSON chunk exactly when the donor made it into the export. The authoritative
post-build check is the build log plus the LOD0 figures in "Size and counts".

Once the inputs are in place:

```sh
cd <repo-root>            # e.g. the directory containing docs/ and public/
R=docs/asset-recipes/xo-market-hall
BL=/Applications/Blender.app/Contents/MacOS/blender      # Blender 5.2.0 LTS

$BL -b --factory-startup --python $R/prep_textures.py   # -> $R/textures/*.png
$BL -b --factory-startup --python $R/build_market.py     # -> $R/export/market_hall.{blend,glb}
$BL -b --factory-startup --python $R/build_collision.py  # -> $R/export/market_hall_collision.{blend,glb}
$BL -b --factory-startup --python $R/build_lod2.py       # -> $R/export/market_hall_lod2.{blend,glb}
$BL -b --factory-startup --python $R/render_market.py    # -> $R/renders/01..12_*.png
```

Then copy the three GLBs to their committed locations and re-hash them
(`shasum -a 256`, compare with the table under "Integrity"). **Do not commit the
`.blend`, render or texture by-products** — the shipped deliverable is the GLB set
plus these docs.

### The donor is not optional

`build_market.py:1251-1256` treats a missing donor GLB as a soft condition:

```python
    donor = os.path.join(os.path.dirname(HERE), "donor", "brass_diya_lantern",
                         "brass_diya_lantern_1k.glb")
    if os.path.exists(donor):
        donor_root = import_donor(donor)
```

If the file is absent the build still runs to `EXPORTED` and `BUILD_OK` and
produces a **LOD0 with 60,751 verts / 60,614 tris and 16 mesh objects** — a
"hall-only" asset that no hash in this repository matches, with no warning that
anything was dropped. Check the build log for `BUILD donor imported <root>` and
the `DONOR <mesh> verts=...` lines, and assert the GLB reports 19 meshes /
73,356 triangles / 17 images, before accepting any regenerated LOD0. Treating
`donor_root is None` as a hard failure is a one-line change in `import_donor`'s
caller; it has not been made here because the scripts are out of scope for this
documentation pass.

`build_market.py` must run before the other two builders — `build_collision.py`
re-opens `export/market_hall.blend` to measure the authored members'
bounding boxes, and `build_lod2.py` imports the shared dimension constants from
`build_market`. `prep_textures.py` only needs re-running when a texture recipe
changes.

**Run each script as its own `blender` invocation.** Passing two `--python`
flags to one `blender` call silently executes only the first.

`diag_bounds.py` and `diag_members.py` are the placement validators used
during authoring: `diag_members` re-imports the builder and flags any of the 567
members outside the expected bounding envelope.

`build_market.py` also self-checks. For every material group it compares the
merged object's bounding box against the union of its members' boxes and prints
`PLACEMENT_DRIFT <material> <drift> pre= post=` if they disagree by more than
**0.02 m**. A few millimetres is just the Bevel modifier chamfering corners. This
guard exists because it caught 21 orphaned lantern-glass panels that were
silently piling up at the world origin, hidden inside the building behind the
plinth and therefore invisible in every render.

## Integrity — SHA-256

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `public/assets/models/environment/xo-market/market-hall.glb` | 12,069,956 | `a91888bbdd640ccb1afd8e6a88f957f8d8d92a2d70b2416ec4953c486531f2c5` |
| `public/assets/models/environment/xo-market/market-hall-lod2.glb` | 6,836,372 | `31ade36ccab5601d86d02aad45343093efb8d2d1d50729b087f482d0f46065e5` |
| `public/assets/models/environment/xo-market/market-hall-collision.glb` | 14,556 | `3fd5277fbaf11d78fa649f90e7a51c051a95e721a746c0a3881bff6578fb858c` |

All three hashes were re-verified against the committed files on 2026-09-26.

**Do not expect a byte-identical rebuild.** An earlier revision of this file
claimed the recipe "regenerates bit-for-bit on any machine with Blender 5.2.0".
That was never demonstrated and is not a claim this repository can support. What
is true, and what was actually checked:

- The builders are **seed-deterministic by construction** — every noise texture
  comes from a fixed integer seed in `prep_textures.py`, and the placement
  geometry is literal vertex data, not randomised. Nothing samples a clock or
  `random` without a seed.
- glTF export still embeds a generator version string — the shipped files all
  record `"generator": "Khronos glTF Blender I/O v5.2.39"` — and the container's
  `asset.version` and the mesh payload differ between Blender/exporter releases.
  A different Blender or glTF-I/O build is therefore expected to produce a
  *geometrically* identical file with a different hash.
- Bit-identical output additionally requires that exact Blender / glTF-I/O
  version pair, the same texture codec settings, and the external inputs pinned by
  MD5 in `PROVENANCE.md` — all three of which are *retrievals* rather than
  immutable pins (Poly Haven and ambientCG both re-publish archives).
- The honest, checkable claim: a rebuild on a matching toolchain reproduces the
  same **geometry, materials and UVs** (73,158 verts / 73,356 tris / 20 materials
  / 17 images for LOD0, 5,038 tris for LOD2, 12 boxes for the hull) and the same
  member-level counts; hash equality is verified per build, not assumed.
- If a regenerated hash differs, compare the glTF JSON chunks first. A structural
  difference means the recipe changed; a byte difference confined to the buffer
  and the generator string means the toolchain did.

## LODs, collision, and how to bind them

All three files share the **same origin and the same 1:1 metre scale**, and are all
written in the same exported frame (Y-up, so the engine's own up axis is +Y and
the hall faces -Z). The recipe authors in Blender's Z-up / +Y-forward, which is
where every Z height quoted earlier in this file comes from; a loader reading
these GLBs sees the Y-up form of the same bounds. A three-level bind would look
like this (the shipped runtime does something narrower — see "What the runtime
actually loads" below):

```js
// three.js-style binding (illustrative filenames, not the committed ones)
const HALL = 'environment/xo-market/market-hall';
const lod = new LOD();
lod.addLevel(loader(HALL + '-collision.glb'),  0);   // physics: never LOD0
lod.addLevel(loader(HALL + '.glb'),           28);   // hero, 0-28 m
lod.addLevel(loader(HALL + '-lod2.glb'),      95);   // 95 m to the far plane
```

| File | Node | Render distance | Use |
| --- | --- | --- | --- |
| `market-hall-collision.glb` | `XO_MarketHall_Collision` | never rendered | Rigid-body / character collision, NavMesh obstacle, camera occluder. 12 boxes, closed, outward normals. |
| `market-hall.glb` | `XO_MarketHall` | 0 - 28 m | The shipping visual. |
| `market-hall-lod2.glb` | `XO_MarketHall` | 95 m - far | Same material names and UV scale, 6.9 % of the triangles. |

Practical notes:

- **Material names are identical across LOD0 and LOD2** (both use the `XO_*` set
  from `market_materials.py`) and both use the same `UV_TABLE`, so a single shared
  material library binds to either level with no duplication.
- **The hull is deliberately conservative**: no doorway, no window recesses and no
  plinth overhang, and the interior is a solid volume. That is right for a
  backdrop you never walk into. If you want walkable interiors, delete
  `hall_mass` and author room colliders instead.
- The hull is 12 boxes rather than one because a single box would seal the
  arched entrance and block the player. The boxes are: `hall_plinth`,
  `hall_mass`, `hall_cap`, `leanto`, `upper_room`, `canopy_post_w0/w1`,
  `canopy_post_e0/e1`, `stall_ext`, `stall_int`, `entry_steps`.
- Collision boxes are axis-aligned and match the authored geometry, so they need
  no rotation. If an engine requires inward-facing normals (Unity's non-convex
  `MeshCollider` is the usual offender) flip them at import with
  `mesh.flip_normals()` / the importer's "Flip Normals" toggle — the geometry is
  closed, so that is safe.
- Nothing about the hull or LOD2 is required for the asset to work. If you only
  ever place the building as a background prop, `market-hall.glb` alone is
  self-contained.

### What the runtime actually loads

The committed binding is deliberately narrow, and it is **not** the three-level
scheme the tables above imply:

- `src/world/environmentPlans.ts:74-76` declares exactly one prefab path,
  `marketHall: 'environment/xo-market/market-hall.glb'`, resolved against
  `public/`. Only **LOD0** is loaded.
- **LOD2 is not wired up.** `market-hall-lod2.glb` is committed and hashed, but no
  distance swap exists in the runtime; it is available for a future far-LOD pass.
- **The collision hull GLB is not loaded either.** Runtime collision for
  `marketHall` comes from 8 hand-authored boxes in
  `src/world/environmentPlans.ts:175-189` (`xoMarketCollision`), not from
  `market-hall-collision.glb`'s 12 boxes. The two sets are independent; do not treat
  the runtime boxes as a subset that is derived from the hull. Navigation and cover
  metadata come from `xoMarketNavigation` / `xoMarketCover` in the same file.

A three-level bind, if one is ever wanted, is the snippet above; the point of this
section is what ships *today*: one loaded file, code-authored collision.

### Module layout

All modules live flat in `docs/asset-recipes/xo-market-hall/` (there is no `src/`
subdirectory — older revisions of this file referred to one).

| File | Responsibility |
| --- | --- |
| `market_lib.py` | Geometry kernel. `box`, `strut`, `panel` (window/reveal cut-outs on a shared global grid — no T-junctions), `panel_backplate`, `arch_spandrel`, `arch_band`, `lathe` (surface of revolution, optional `rib` fluting), `sweep`, `grid_surface`, `torus`/`cylinder`/`cone`, `join_meshes`, `box_uv`, `add_modifiers`, `apply_modifiers`, `finish`. |
| `market_materials.py` | 16 PBR materials. Single shared `Principled BSDF` per material with `Base Color` / `Metallic-Roughness` / `Normal` fed by direct `Image Texture` nodes so the glTF exporter emits a clean ORM + normal set. |
| `build_market.py` | The asset (LOD0). `build_shell`, `build_roof`, `build_facade`, `build_openings`, `build_canopy`, `build_canopy_east`, `build_hardware`, `build_stall`, `import_donor`. Also owns the `BEVEL_TABLE`, `SMOOTH_TABLE` and `UV_TABLE` constants. |
| `market_massing.py` | Pass-2 secondary masses: `build_leanto` (asymmetric back-east ancillary range, mono-pitch roof) and `build_upper` (small plastered upper roof chamber). Imported from inside `build_market.main()` — a module-level import would be circular. |
| `build_collision.py` | The collision hull. 12 measured AABBs + a `verify()` that re-opens LOD0 and reports which material groups each box covers. |
| `build_lod2.py` | LOD2. A separate hand-authored reduction that keeps the arch + voussoir ring, both canopies, the fascia/parapet/coping, the lean-to and the upper chamber, and drops mullions, shutters, sills, grilles, all ironwork, lantern glass, cloths, sacks, stool, ladder, cactus and the donor lantern. |
| `prep_textures.py` | Texture generation. Derives 5 maps from the two CC0 ambientCG sources (`Mudbrick` colour/normal/roughness, `Fabric` normal/roughness) and *authors* 8 (`Plaster` colour/normal/roughness, `Stone` colour/normal/roughness, `Awning` colour, `Wood` normal) from tileable numpy fBm. |
| `render_market.py` | Cycles previews + orthographic + Workbench solid. Hosek-Wilkie sky, 3-light rig, 96 samples, denoise, AgX. 12 shots: `01_front_west`, `02_front_east`, `03_front_centre`, `04_corner_ne`, `05_front_west_low`, `06_entrance_detail`, `07/08_ortho_front|side`, `09..12_solid_front|threequarter|top|ne`. |
| `diag_bounds.py`, `diag_members.py` | Placement validators used during authoring. |

### Modding rules baked into the code

- **Bevel width is a per-material table** (`BEVEL_TABLE` in `build_market.py`), not
  one global value: plaster 0.030, mudbrick 0.024, limestone 0.018, wood 0.016,
  earth 0.010, foliage 0.008, terracotta 0.005, and **0.0** for iron, brass, rope,
  lamp glass and all fabrics (a bevel on a 3 mm rope or a lantern pane is a geometry
  error).
- **Smooth angle is a per-material table** (`SMOOTH_TABLE`): plaster 30, mudbrick 30,
  limestone 32, earth 32, lamp glass 30 deg; wood 34, wrought iron 40, brass 40,
  terracotta 40 deg; foliage 46 deg; rope 60 deg; all fabrics 70 deg.
- Modifier order is enforced to **Bevel -> Smooth by Angle -> Weighted Normal**
  via `modifier_move_to_index`, because `bpy.ops.object.shade_auto_smooth()`
  *appends* and Blender 5.2 has no `use_auto_smooth` on the mesh.
- UVs are box-projected in metres and then scaled per material (`UV_TABLE`, metres
  per UV unit) so a 1024 px mudbrick map tiles at **1.15 m** rather than across a
  whole wall; plaster 0.55, limestone 1.50, earth 0.90, wood 0.85, terracotta 0.45,
  rope 0.30, awning 2.00, and 0.40-0.45 for the cloths.
- `Solidify` is applied *before* the per-material merge, because the merge is a
  raw verts/faces weld that would otherwise discard the modifier.

## Architecture — what is actually modelled

- **Thick walls.** 420 mm cavity between an outer mudbrick leaf and an inner
  plastered leaf. Outer face is 1:1 mudbrick; the inner faces are plaster. Vertical
  members (pilasters, quoins, the base course) are mudbrick, horizontal members
  (string course, sills, coping, door head) are limestone or timber — the classic
  adobe structural logic, and it also breaks up the facade so it does not read as
  one beige box.
- **Real recessed arched entrance.** The front wall is a single 7.16 x 3.40 m
  panel cut by a global (u,v) grid. The door is a *rectangle* to the arch crown
  with the soffit omitted, and `arch_spandrel` closes the two corners above a true
  semicircle — so the void is a genuine round-headed arch, not a painted-on arch.
  Verified by `scene.ray_cast`: a ray at the door centre passes straight through to
  the interior; a ray above the crown hits the limestone voussoir ring. The arch
  carries a 17 cm-deep projecting voussoir band, a timber lintel **seated on the
  springing** (not floating above the arch), two corbel brackets, two timber jambs
  with caps, a limestone threshold and two steps.
- **Window recesses** on all four elevations: reveal, stone sill, timber head /
  jambs / mullions, hinged shutter leaves with battens that stand open at authored
  angles (40 deg / 26 deg / 0 deg), and wrought-iron bar grilles in the vents.
- **Silhouette.** Below a 420 mm mudbrick parapet with limestone coping (200 mm on
  the entrance side so the roof deck still reads), timber viga beam-ends project
  400 mm. The front gets **one continuous 270 mm timber cornice band** — nine
  discrete blocks read as a picket fence; the back and left keep discrete joist
  ends, where they read correctly in profile. Plus a stair penthouse with a
  coping cap, a recessed door head and its own vigas. Roof deck props: three
  turned water jars and two rolled mats laid flat.
- **Gabled canvas awning** on a post-and-beam frame: knee braces, tie beams, eight
  rafters, two purlins, a ridge plate, a 35x10 sagging canvas surface, a scalloped
  valance, rope ties and guy lines, and a hanging sign board on rope hangers with
  iron rings. The awning is authored centred, then scaled to 70 % and slid 2.20 m
  west, so it shelters the market-stall bay and the four hanging cloth bolts
  instead of masking the arch; the entrance bay is left open.
- **Hardware.** Two wall lanterns on scrolled wrought-iron brackets, one interior
  lantern on a chain, plus the borrowed brass Diya hanging under the stall.
- **Stall / counter** under the canopy with turned vessels, bowls and a tray, and a
  second counter inside; crates, a stool, grain sacks, a leaning ladder, a fluted
  cactus.
- **Left elevation** carries an arched display niche with a stone tray and a turned
  jar, plus a window and a grilled vent.

## Known weaknesses

Pass 2 closed weaknesses 1, 5, 7 and 8 of pass 1 (no box massing, no LODs/collision,
four stacked cornice bands, awning over the arch). What remains:

1. **The hall itself is still a rectangular box.** The lean-to and the upper
   chamber break the silhouette, but the main volume is still an 8 x 5 m
   rectangle with no setback, no buttress and no re-entrant. A real souk range
   would step. This is the single biggest remaining gap.
2. **The facade is still close to bilaterally symmetric in its masonry.** The two
   canopies, the stall and the sign all sit west of the door, which breaks the
   symmetry in plan and silhouette, but the window sizes, vent positions, base
   course and string course are mirrored front-to-back. The side and back
   elevations are much more varied than the front.
3. **The upper chamber reads as a blank box from the north-east.** Its opening is
   on the south and west faces only, so from the rear corner it is four blank
   walls. A vent or a light on the north face would fix it.
4. **The cactus reads as a stack of discs** in Workbench/solid shading and as a
   flat green blob in Cycles. The `lathe(rib=...)` fluting is too coarse at
   16 segments and `XO_Foliage` is desaturated. It is a small background prop and
   was left alone rather than re-render the whole set.
5. **Plaster relief is subtle at gameplay distance.** The authored trowel/grit
   normal is present and correct, but the data map is 512 px (authored at 1024,
   box-filtered on save) at 0.55 m/tile over an 8 m wall
   gives ~14 tiles, so the fine grain does not survive a 32 mm lens at 12 m. It
   wants a detail normal or a second UV set to be convincing up close.
6. **The mudbrick map is derived, not tileable-architectural.** It is a
   value-compressed, hue-shifted, de-normalised ambientCG rubble field. It reads
   correctly at gameplay range and is genuinely CC0, but a hand-laid mudbrick
   pattern would be better.
7. **Awning sag is authored per-vertex, not simulated**, so it will not respond
   to wind or to a player walking under it.
8. **The lean-to's mono-pitch roof battens overhang the eave as bare rafter
   tails.** Plausible, but they read as a comb from the north-east.
9. **The hanging cloth bolts are stiff rectangles**, not cloth. They need a
   catenary in the top edge to read as fabric.
10. **The Workbench solid elevation does not read the arch as an opening**,
    because Workbench shades the interior and the exterior identically. The arch
    is a genuine void — `renders/05_front_west_low.png` and the ray-cast probes
    both confirm it. Do not use `09_solid_front.png` to judge the openings.
11. **LOD2 is 5,038 triangles, marginally over the 3-5 k target** (0.8 % over).
    The arch band alone costs ~200 of them. Cutting further would mean dropping
    the voussoir ring, which is the thing the silhouette depends on.
12. **The collision hull has no doorway.** The player cannot walk in. Correct for
    a backdrop, wrong if you want the hall enterable — see the binding notes.
13. **The renders use a flat sand plane and a Hosek-Wilkie sky.** The hard horizon
    line is a render-setup artefact, not the asset; do not read it as a fault.
