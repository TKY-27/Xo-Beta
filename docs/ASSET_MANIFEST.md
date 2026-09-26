# Asset Manifest

**Policy:** Xo Beta combines original code-generated assets (repository MIT
license) with redistributed third-party assets under permissive licenses —
CC0 / Public Domain or CC BY 3.0/4.0 for art and audio, and SIL OFL 1.1 for fonts. All
redistributed files live under `public/assets/`; nothing loads from runtime
CDNs. SHA-256 checksums for every redistributed production file are listed in
`ASSET_CHECKSUMS.txt`.

| Asset class | Local path | Source / author | License | Acquired | Modifications |
| --- | --- | --- | --- | --- | --- |
| HDRI skies (kloofendal_overcast_puresky, qwantani_puresky) | public/assets/sky/*.hdr | polyhaven.com — Poly Haven team | CC0 1.0 | 2026-08-22 | none. (dikhololo_night removed 2026-08-24 — NEO CITY now uses a procedural blue-hour sky rendered at runtime, original code) |
| PBR texture sets x21 (asphalt, bricksOld, concrete, concreteDark, corrugated, dirt, facadeA, facilityFloor, grass, marble, metal, metalDark, plaster, plasterOld, rock, roofTile, rust, sidewalk, stoneBrick, wood, woodDark) | public/assets/textures/<set>/{color,normal,rough}.jpg | ambientcg.com — Lennart Demets / ambientCG contributors | CC0 1.0 | 2026-08-22 | renamed + re-encoded Color/NormalGL/Roughness maps to color.jpg/normal.jpg/rough.jpg; no pixel edits |
| Derived packed-earth lane set | public/assets/textures/packedEarth/{color,normal,rough}.jpg | Derived in-repo from the CC0 ambientCG `dirt` set (Lennart Demets / ambientCG contributors) | CC0 1.0 (derivative of a CC0 set; repository MIT for the generator) | 2026-09-26 | `normal.jpg`/`rough.jpg` are the verified `dirt` files byte-for-byte; only `color.jpg` is re-authored, with albedo value driven by the source normal map so colour tracks surface compaction, mapped to a low-chroma sandy ramp (avg RGB(150,143,129), chroma r-g 7.2 / g-b 14.7, luma 39/144/210, std 21.3) with two scales of low-frequency patchiness and gravel speckle. Reason: the stock `dirt` albedo averages RGB(80,66,36) and tinting is a channel-wise multiply that can only darken, so no tint could desaturate it and every desert lane read as saturated red-brown. Generator recipe: `make-packed-earth.py` (campaign scratch record). |
| Derived desert-road set | public/assets/textures/desertRoad/{color,normal,rough}.jpg | Derived in-repo from the CC0 ambientCG `asphalt` set (ambientCG contributors) | CC0 1.0 (derivative of a CC0 set; repository MIT for the generator) | 2026-09-26 | `normal.jpg`/`rough.jpg` are the verified `asphalt` files byte-for-byte; only `color.jpg` is re-authored as faded asphalt with windblown sand accumulated on flat micro-facets and the aggregate still showing through the wheel paths (avg RGB(115,110,102), chroma r-g 5.0 / g-b 7.7, luma 72/111/168, std 11.5). Reason: the stock `asphalt` albedo averages RGB(69,68,67) and tinting is a channel-wise multiply that can only darken, so the Ashara logistics highway was a deliberately untextured flat fill that read as a near-black ribbon across the dunes. Generator recipe: `make-desert-road.py` (campaign scratch record). |
| Combat rig animations (43 clips) | public/assets/models/characters/ual_standard.glb | quaternius.com Universal Animation Library — Quaternius | CC0 1.0 | 2026-08-22 | none |
| Character bodies (Superhero male/female) + hair/skin textures | public/assets/models/characters/hero_*.{gltf,bin}, T_*.png | quaternius.com Universal Base Characters (Standard) — Quaternius | CC0 1.0 | 2026-08-22 | retained as compatibility/fallback body assets; production presentation now uses the authored SWAT body below |
| Authored modular combatant body: SWAT | public/assets/models/characters/swat-modular.glb | quaternius.com/packs/ultimatemodularcharacters.html — Quaternius | CC0 1.0 | 2026-09-24 | canonical `Swat.gltf` source SHA-256 `622b3f36fcac90539ef8f7121ec1f11b5e1ae603a085019b3fa96eba20dddfd3`; glTF→GLB copy SHA-256 `0cd2b3876e5f20f3c85ffc5dcccd05dccb7aaec86235434f7f449f3b44417b7c`; 5 meshes, 1 skin, 24 authored clips, no textures; runtime recolors source materials and bypasses procedural costume attachments |
| Runtime nature subset: 5 broadleaf trees, 4 pines, 3 dead trees, 2 bushes, fern, clover, flower group and 2 rocks, including referenced buffers/textures | public/assets/models/nature/* | quaternius.com Stylized Nature MegaKit (Standard subset) — Quaternius | CC0 1.0 | 2026-08-22 | instance transforms applied at runtime; unused pack members excluded from the repository |
| Authored first-person pistol vertical slice: glock.glb | public/assets/models/weapons/authored-pistol.glb | vladqc.itch.io/glock — VladQc | CC0 1.0 | 2026-09-24 | downloaded from the author’s canonical free-download page; no mesh edits; local SHA-256 recorded in `docs/ASSET_CHECKSUMS.txt`; runtime node binding and scale normalization are code-side integration |
| Authored first-person AR: AK-47 | public/assets/models/weapons/authored-ar-ak47.glb | 3dmodelscc0.itch.io/free-cc0-guns-explosives-pack — 3DModelsCC0 | CC0 1.0 | 2026-09-24 | canonical itch pack; Blender/GLB conversion; source SHA-256 `d73bbbaa153d49f67a8180d0197c14aaab925540db231db00e3461d74a56246e`; production SHA-256 `5216b57abf81b71c4f583585e7e8542844a6ef2c0a94de03f6090787f87d9278`; source nodes `Magazine`, `Trigger`, `Selector_Switch`, `Ejection_Port` retained for runtime bindings |
| Authored first-person SMG: Suomi KP | public/assets/models/weapons/authored-smg-suomi.glb | 3dmodelscc0.itch.io/free-cc0-guns-explosives-pack — 3DModelsCC0 | CC0 1.0 | 2026-09-24 | canonical itch pack; Blender/GLB conversion; source SHA-256 `e382e3e0a69338bc7080f2fd46fcf478f4df172736d8bd03323e4743ba85e683`; production SHA-256 `892105ee1c324ed2238f261c6f34054189845aedd0e47f2c6fa249767ae97409`; source nodes `Body`, `Bolt`, `Ejector`, `Magazine`, `MagazineRelease`, `Trigger` retained for runtime bindings |
| Authored first-person sniper: M700 | public/assets/models/weapons/authored-sniper-m700.glb | stein-indie.itch.io/m700 — Stein Games | CC0 1.0 | 2026-09-25 | canonical itch archive `Sniper_R700_Free_CC0.zip` SHA-256 `67e960d12c1fe7570469ccb295b92f27f11fa26aa9a63bda4fe1de807d22f319`; source FBX SHA-256 `b7e003e01be8441e452730bc06c38c5e9752e523ae1b401ed2a6cc6cdca16840`; source color `fd17964b05e7349fda35df13debbb89bc0e7e600c0bb9d69b6d6f93e25f46549`, normal `08861e90d493c5c1a3d4df46b332b17cf7327757866f3c177386811c2745ba9a`, MAOR `0b751a4a050c7886d7d4d073a71010b6953dee1a43a696f45a6083e8aac6f298`, license `e951f2b0020950145353d5d30354625ff2b1de12337c4695c2aaf1f8d30cef98`; converted to GLB and baked in Blender 5.2 to a static two-mesh production asset to avoid a runtime Three.js skinned-LOD transform collapse; production SHA-256 `2daf819e92c99a6621014e8e80ba507efe2be0420c7897613bd1f10d3b09d8d0`; runtime derives muzzle/sight/grip anchors and creates a semantic bolt socket from the baked receiver bounds because source armature nodes are not retained in the static export |
| Authored first-person shotgun: Remington 870 pump | public/assets/models/weapons/authored-shotgun-pump.glb | opengameart.org/content/shotgun-1 — MikeMoon | CC0 1.0 | 2026-09-24 | canonical `Shotgun_2.zip` source SHA-256 `577d8a317c971e9ea1fe7038800111fa5ca6ca1437c299c66a7e749f994b1d75`; source `Shotgun.blend` was separated into named stock/receiver, pump, barrel, magazine-tube, trigger and sight meshes, then converted to GLB; production SHA-256 `d663a2adf580fb54d3ac36af9a9a92151387cb4f0b4f545c53bde60297ee9fc2`; source `Shotgun.png` omitted because its embedded Textures.com provenance was not independently verified; 10 mesh parts, no textures; pump is the runtime action object |
| Authored hand rig and skin | public/assets/models/hands/libhand-hand.glb | github.com/libhand/libhand — Marin Saric | CC BY 3.0 Unported | 2026-09-24 | primary production hand base; source blend exported to GLB, texture embedded, bone names retained for runtime retargeting; runtime replaces the source skin response with the project’s dark tactical PBR palette; no mesh topology edits; local SHA-256 recorded in `docs/ASSET_CHECKSUMS.txt` |
| Authored tactical glove hand | public/assets/models/hands/authored-tactical-hand.glb | poly.pizza/m/MTB4egc4Vh — J-Toastie | CC BY 3.0 | 2026-09-25 | fallback hand base; direct source GLB `https://static.poly.pizza/88d0bead-a488-4fb8-bd8e-242813383b78.glb`; 30-node source with 22 skin joints, one skinned glove/arm mesh pair, no source textures or clips; production SHA-256 `6606690b23c6f7239904c24747f861032898a69e230a252f107daf7176e7f9a2`; runtime remaps finger chains, applies tactical PBR materials and normalizes wrist origin when LibHand is unavailable |
| Authored tactical sleeve shell | public/assets/models/hands/authored-sleeve.glb | original Xo Beta mesh generated with Blender; normal/roughness source: ambientcg.com/view?id=Fabric023 — ambientCG contributors | original MIT mesh + CC0 1.0 texture source | 2026-09-25 | original capped 32-segment/16-ring sleeve geometry with folds, UVs and material bands; ambientCG normal/roughness maps embedded; source recipe retained in the campaign work record; runtime applies a dark tactical material and does not use the source base-color map |
| Eden modular facility district geometry | public/assets/models/environment/eden/*.glb | github.com/JaronKBragg7337/asset-pack-ue-threejs-blender-unity — Jaron Bragg | CC0 1.0 | 2026-09-24 | 25 selected service-bay, greenhouse, dock and generator modules copied from official ModKit v1.2 release (archive SHA-256 `3393f2d34f046daa0f5a670f89704d274ffeb86674568ae0eb402f773dcec1fb`); runtime assigns existing projected Xo Beta PBR materials and uses visual-only placement while deterministic collision/nav/cover remain in map data |
| Authored settlement fort | public/assets/models/environment/polyhaven/modular-fort-01.glb | polyhaven.com/a/modular_fort_01 — Rico Cilliers | CC0 1.0 | 2026-09-25 | authored fort landmark currently used by the OldFront plan; the temporary Ashara collision-ring instance was removed; not a final desert market kit |
| Authored Ashara market cargo and counter set | public/assets/models/environment/polyhaven/{plastic-crate-03,wooden-crate-01,wicker-basket-01,wooden-table-02}.glb | Poly Haven — Pacific Penguin, James Ray Cock, Kuutti Siitonen, Serhii Khromov | CC0 1.0 | 2026-09-25 | official 1K glTF sources converted to self-contained GLBs with embedded PBR textures; deterministic Ashara market cluster; source URLs, authors, conversion details and hashes are recorded below and in `docs/ASSET_CHECKSUMS.txt` |
| Authored Ashara market goods props | public/assets/models/environment/polyhaven/{ceramic-pot,ceramic-vase,brass-lantern}.glb | Poly Haven — Aron Łyczek (`ceramic_pot`), James Ray Cock (`ceramic_vase_04`), Bhargav Kubal (`brass_diya_lantern`) | CC0 1.0 | 2026-09-26 | official 1K glTF sources downloaded via the Poly Haven API and converted with Blender 5.2.0/Khronos glTF Blender I/O v5.2.39; embedded PBR textures, no geometry edits; ceramic pot/vase are grounded market goods and brass lantern is a small table-top market dressing prop; production hashes and exact source endpoints are recorded below and in `docs/ASSET_CHECKSUMS.txt` |
| Authored Ashara market building | public/assets/models/environment/kaykit-market.glb | Kay Lousberg, KayKit Medieval Hexagon Pack 1.0 — official GitHub FBX `addons/kaykit_medieval_hexagon_pack/Assets/fbx(unity)/buildings/red/building_market_red.fbx` at commit `84fa4e91af6a88989be7c99e0891cede11f2ca38` | CC0 1.0 | 2026-09-25 | official FBX source SHA-256 `81cd01e98a13423c4eb874ad3a7766efd2488005a6a4a69c4cfed8b9ecfe04a5`; Blender 5.2.0 with Khronos glTF Blender I/O v5.2.39 imported the FBX with `export_yup=True`, `export_texcoords=True`, `export_normals=True`, `export_materials='EXPORT'`, and no cameras/lights/animations; rigid footprint was recentered X/Z at the origin with minimum Y at zero, source texture pixels were preserved while PNG bytes were recompressed, and only glTF hierarchy/material names were normalized (no mesh geometry, winding, or UV edits); embedded `hexagons_medieval.png` atlas; production SHA-256 `0816c82c10baa429f29937384c42b2a010e6cc8900eb7d37fd011fdb22c1b006`; runtime fallback asset retained in the kit but no longer selected by the Ashara plan; this is a bounded authored district pilot, not a final AAA material pass |
| Authored Ashara market background buildings | public/assets/models/environment/kaykit/kaykit-{home-a,home-b,tower-a,tavern}.glb | Kay Lousberg, KayKit Medieval Hexagon Pack 1.0 — official pinned FBX members `building_home_A_red.fbx`, `building_home_B_red.fbx`, `building_tower_A_red.fbx`, `building_tavern_red.fbx` at commit `84fa4e91af6a88989be7c99e0891cede11f2ca38` | CC0 1.0 | 2026-09-26 | official source FBX hashes: home A `31c681427c20ef13a734ca96e5edaccf3e89ce084c4f8f64e651de8f51ddd067`, home B `ad52016722466b266981c86d16c0d53a3f6520f7c08e63e5820deed4c8848bd4`, tower A `b47eeabdb2a124e4889cbb88478df6666d3f756efc21ac785c78938ca6b4c598`, tavern `bb87684519b25176f0ca55181844367a166f9d995d7e79e692fdb17ffa4b6f32`; atlas source `5301a06866ba3be68dcc14cc429bd6d0f69004b72884283715d7e233f2e9782e`; Blender 5.2.0/Khronos glTF Blender I/O v5.2.39 FBX conversion, geometry preserved, embedded atlas; production hashes are in `docs/ASSET_CHECKSUMS.txt`; runtime uses node-standard desert materials and deterministic placement/collision |
| Authored Ashara market hall (LOD0/LOD2/collision) | public/assets/models/environment/xo-market/market-hall{,-lod2,-collision}.glb | Original XO Beta authoring pipeline; CC0 ambientCG Bricks098/Fabric023 maps; rescaled CC0 Poly Haven `brass_diya_lantern` donor | CC0 1.0 for composition; repository MIT for original generator | 2026-09-26 | LOD0 SHA-256 `a91888bbdd640ccb1afd8e6a88f957f8d8d92a2d70b2416ec4953c486531f2c5` (19 meshes, 73,356 tris, 20 materials, 17 embedded images); LOD2 SHA-256 `31ade36ccab5601d86d02aad45343093efb8d2d1d50729b087f482d0f46065e5` (5,038 tris); collision SHA-256 `3fd5277fbaf11d78fa649f90e7a51c051a95e721a746c0a3881bff6578fb858c` (12 AABB proxies); Blender 5.2.0/Khronos glTF Blender I/O v5.2.39, original scripts and full recipe in `docs/asset-recipes/xo-market-hall/`; Poly Haven source `https://polyhaven.com/a/brass_diya_lantern`, ambientCG `https://ambientcg.com/view?id=Bricks098` and `https://ambientcg.com/view?id=Fabric023`; no Mali game textures; runtime uses LOD0 with deterministic plan placement and collision metadata; this materially improves the hero market building but is not a final photoreal district |
| Authored Ashara market shop row (LOD0/collision) | public/assets/models/environment/xo-market/shop-row{,-collision}.glb | Original XO Beta authoring pipeline, pass 3; CC0 ambientCG Bricks098/Fabric023 maps; CC0 Poly Haven `brass_diya_lantern` donor | CC0 1.0 for composition; repository MIT for original generator | 2026-09-26 | LOD0 SHA-256 `a70d1edbbbcb31c85270fd1494a65ce799a624622dd2812b5c123987924fa0a4` (30,850 verts / 32,488 faces / 55,890 tris, 16 objects, 17 materials, 27 embedded images); collision SHA-256 `d4f779dc50bab73917ef72511db5f94aec1dea0e64f1ddee9e044024c2db977d` (12 AABB proxies); Blender 5.2.0 authored scripts/recipe in `docs/asset-recipes/xo-market-shop-row/`; Poly Haven source `https://polyhaven.com/a/brass_diya_lantern`, ambientCG `https://ambientcg.com/view?id=Bricks098` and `https://ambientcg.com/view?id=Fabric023`; no Mali game textures; runtime uses the source-preserved LOD0 at the market edge with deterministic collision; not a final photoreal district |
| Authored Ashara market stall set | public/assets/models/environment/quaternius/medieval-market-stand-{1,2}.glb | quaternius.com/packs/medievalvillage.html and opengameart.org/content/lowpoly-medieval-village-pack — Quaternius | CC0 1.0 | 2026-09-25 | selected `MarketStand_1` and `MarketStand_2` from the December 2020 Medieval Village Pack; Blender 5.2 GLB export; 1,548/1,132 triangle authored stands, four/three source materials, no runtime textures; production hashes are recorded in `docs/ASSET_CHECKSUMS.txt` |
| Authored Ashara market enclosure modules | public/assets/models/environment/quaternius/wall-{arch,plaster-straight,uneven-brick-straight,uneven-brick-door-round}.glb | quaternius.com/packs/medievalvillagemegakit.html and github.com/J-Ponzo/gltf-medieval-village-megakit — Quaternius (distribution mirror) | CC0 1.0 | 2026-09-25 | the retained market plan uses only `wall-arch` and two threshold wall modules; former side-shoulder instances were removed after live review because their node-standard cards read as flat cardboard and blocked the authored hall. The round-door module remains a documented fallback asset and is not selected by the Ashara plan. It was also texture-stripped: it is a 142-vertex prefab that carried 25.7 MB of embedded image payloads (9 texture nodes) which are never sampled because `materialMode: 'node-standard'` replaces every source material with a shared `MaterialLibrary` PBR material at runtime. The stripped build is 8,160 bytes with identical mesh count, vertex count and UV layers. Blender 5.2 exports; the geometry-only wall variants retain mesh/accessor/UV/material factors and omit unused source image references; production hashes are in `docs/ASSET_CHECKSUMS.txt` |
| Runtime vehicle subset: sedan, SUV, van, truck, taxi, police, delivery-flat, hatchback-sports, race-future + shared colormap | public/assets/models/vehicles/* | kenney.nl Car Kit — Kenney NL | CC0 1.0 | 2026-08-22 | per-instance tint materials; unused variants and standalone wheel models excluded |
| Runtime footsteps + material impacts + UI/mech/explosion/laser SFX subset | public/assets/audio/{steps,impacts,ui,mech,explosions,lasers}/*.wav | kenney.nl Impact Sounds, Interface Sounds, UI Audio, Sci-Fi Sounds — Kenney NL | CC0 1.0 | 2026-08-22 | selected OGG sources decoded to WAV PCM 16-bit 44.1 kHz (no DSP); only samples referenced by the audio manifest are retained |
| Pistol / SMG / AR / shotgun / sniper gunshots (9 files) | public/assets/audio/guns/{pistol_a,pistol_b,pistol_c,smg_a,smg_b,ar_a,ar_b,shotgun_a,sniper_a}.wav | opengameart.org/content/the-free-firearm-sound-library — The Free Firearm Sound Library team (Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney) | CC0 1.0 | 2026-08-23 | trimmed from near-distance single-shot recordings (Walther PPQ / Colt 1911 / Bersa .380 / Carl Gustav M45 / PPSh / AR-15 / AK-47 / Benelli Nova / Mosin Nagant), resampled 96 kHz/24-bit -> 44.1 kHz/16-bit PCM, peak-normalized to -6 dBFS, short fades applied |
| Water splashes (2) | public/assets/audio/water/{splash_05,splash_11}.wav | opengameart.org "40 CC0 water / splash / slime SFX" — rubberduck | CC0 1.0 | 2026-08-22 | OGG -> WAV; unused variants excluded |
| Chest opening | public/assets/audio/chest/openchest.wav | opengameart.org/content/open-chest-sfx — Oiboo | CC0 1.0 | 2026-08-22 | loudness-normalized |
| Ambience beds: birds_loop, wind_loop, river_loop | public/assets/audio/ambience/*.wav | opengameart.org/content/park-ambiences + ambient-bird-sounds — Thimras (wind/river), isaiah658 (birds) | CC0 1.0 | 2026-08-22 | excerpted into loopable segments, mono 32 kHz WAV |
| City ambience bed: city_loop | public/assets/audio/ambience/city_loop.wav | opengameart.org "Scifi City - Ambient Loop" — TinyWorlds | CC0 1.0 | 2026-08-22 | mono 32 kHz WAV |
| UI fonts: Saira Condensed, Inter Tight, Noto Sans JP | public/assets/fonts/*.{woff2,txt} | Saira Project Authors; Inter Project Authors; Adobe/Source Han Sans contributors | SIL Open Font License 1.1 | 2026-08-24 | web subsets/WOFF2 files are shipped with each font's original OFL notice |

## Source URLs

These are the exact upstream pages used to verify the retained production
assets. ambientCG directory names are local aliases; the source asset ID for
each alias is recorded here so the files can be independently re-audited.

- Poly Haven HDRIs:
  [kloofendal_overcast_puresky](https://polyhaven.com/a/kloofendal_overcast_puresky),
  [qwantani_puresky](https://polyhaven.com/a/qwantani_puresky)
- Poly Haven environment models (CC0 1.0; self-contained GLB exports with embedded PBR textures):
  [modular_fire_escape](https://polyhaven.com/a/modular_fire_escape),
  [modular_urban_apartments_facade](https://polyhaven.com/a/modular_urban_apartments_facade),
  [modular_factory_facade](https://polyhaven.com/a/modular_factory_facade),
  [modular_fort_01](https://polyhaven.com/a/modular_fort_01),
  [plastic_crate_03](https://polyhaven.com/a/plastic_crate_03),
  [wooden_crate_01](https://polyhaven.com/a/wooden_crate_01),
  [wicker_basket_01](https://polyhaven.com/a/wicker_basket_01),
  [wooden_table_02](https://polyhaven.com/a/wooden_table_02),
  [ceramic_pot](https://polyhaven.com/a/ceramic_pot),
  [ceramic_vase_04](https://polyhaven.com/a/ceramic_vase_04), and
  [brass_diya_lantern](https://polyhaven.com/a/brass_diya_lantern).
  The 1K source glTF endpoints were
  `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/modular_fire_escape/modular_fire_escape_1k.gltf`,
  `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/modular_urban_apartments_facade/modular_urban_apartments_facade_1k.gltf`,
  `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/modular_factory_facade/modular_factory_facade_1k.gltf`,
  `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/modular_fort_01/modular_fort_01_1k.gltf`,
  `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/plastic_crate_03/plastic_crate_03_1k.gltf`,
  `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/wooden_crate_01/wooden_crate_01_1k.gltf`,
    `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/wicker_basket_01/wicker_basket_01_1k.gltf`,
    `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/wooden_table_02/wooden_table_02_1k.gltf`,
    `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/ceramic_pot/ceramic_pot_1k.gltf`,
    `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/ceramic_vase_04/ceramic_vase_04_1k.gltf`, and
    `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/brass_diya_lantern/brass_diya_lantern_1k.gltf`; exact production hashes are in `ASSET_CHECKSUMS.txt`.
- Quaternius Medieval Village Pack:
  [official pack page](https://quaternius.com/packs/medievalvillage.html),
  [OpenGameArt source archive](https://opengameart.org/content/lowpoly-medieval-village-pack),
  [CC0 1.0 deed](https://creativecommons.org/publicdomain/zero/1.0/).
  Production files were exported from `Props/Blends/MarketStand_1.blend` and
  `MarketStand_2.blend` in the canonical archive; archive SHA-256 is
   `c38d8632c3c883043809a5db9b2f47b7033e298ab4bd073bb5c29ad323df60fc`.
- Quaternius Medieval Village MegaKit:
  [official pack page](https://quaternius.com/packs/medievalvillagemegakit.html),
  [GitHub distribution mirror](https://github.com/J-Ponzo/gltf-medieval-village-megakit),
  and [CC0 1.0 deed](https://creativecommons.org/publicdomain/zero/1.0/).
  The GitHub repository identifies Quaternius as the original author and is used
  only as a glTF distribution mirror. Production wall files were converted from
  the selected modules with Blender 5.2; the three node-standard wall variants
  retain mesh/accessor/UV/material-factor data but omit unused image references
  because runtime assigns the shared project PBR material library. The round-door
  module retains its source texture.

- KayKit Medieval Hexagon Pack 1.0:
  [official GitHub repository](https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0) pinned at commit [`84fa4e91af6a88989be7c99e0891cede11f2ca38`](https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0/tree/84fa4e91af6a88989be7c99e0891cede11f2ca38), [pinned LICENSE.txt](https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0/84fa4e91af6a88989be7c99e0891cede11f2ca38/LICENSE.txt), [canonical CC0 1.0 deed](https://creativecommons.org/publicdomain/zero/1.0/), and source member `addons/kaykit_medieval_hexagon_pack/Assets/fbx(unity)/buildings/red/building_market_red.fbx` ([pinned source](https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0/blob/84fa4e91af6a88989be7c99e0891cede11f2ca38/addons/kaykit_medieval_hexagon_pack/Assets/fbx(unity)/buildings/red/building_market_red.fbx)). The production GLB was converted with Blender 5.2.0 and Khronos glTF Blender I/O v5.2.39 using the recipe recorded in the manifest row: FBX import, rigid-footprint recentering, embedded atlas, `export_yup`, texcoords, normals, and material export with no geometry/winding/UV edits. The four background buildings use the same pinned pack and conversion recipe from `building_home_A_red.fbx`, `building_home_B_red.fbx`, `building_tower_A_red.fbx`, and `building_tavern_red.fbx`. No runtime CDN or source archive is used.

- **XO Authored Market Hall** — original generator and recipe:
  [`docs/asset-recipes/xo-market-hall/README.md`](asset-recipes/xo-market-hall/README.md)
  and [`PROVENANCE.md`](asset-recipes/xo-market-hall/PROVENANCE.md). The
  production GLBs are `public/assets/models/environment/xo-market/market-hall.glb`
  (LOD0), `market-hall-lod2.glb` (5,038-triangle hand-authored reduction), and
  `market-hall-collision.glb` (12 authored AABB proxies). The generator uses
  Blender 5.2.0 with Khronos glTF Blender I/O v5.2.39; the only borrowed
  geometry is a rescaled CC0 Poly Haven `brass_diya_lantern` by Bhargav Kubal
  ([asset page](https://polyhaven.com/a/brass_diya_lantern)), 12,407 vertices /
  12,742 triangles of the LOD0's 73,158 / 73,356 (17.0 % / 17.4 %; author
  confirmed by the Poly Haven API, `https://api.polyhaven.com/info/brass_diya_lantern`),
  and the texture
  inputs are CC0 ambientCG [Bricks098](https://ambientcg.com/view?id=Bricks098)
  and [Fabric023](https://ambientcg.com/view?id=Fabric023). The Mali game-derived
  plaster/brick/wood maps found in the scratch tree were explicitly rejected and
  are not present in the recipe or production GLB. Exact production hashes are in
  `docs/ASSET_CHECKSUMS.txt`; no source archive or runtime CDN is used. The recipe
  is *reconstructable* rather than bit-reproducible: it depends on three external
  CC0 downloads (the Poly Haven lantern and two ambientCG archives) that are not
  committed, and `prep_textures.py` still carries a hard-coded authoring scratch
  path. See the "Reproduce" section of the recipe README for the preparation step
  and the exact per-file source URLs and MD5s.

- **XO Authored Market Shop Row (pass 3)** — original generator and recipe:
  [`docs/asset-recipes/xo-market-shop-row/README.md`](asset-recipes/xo-market-shop-row/README.md),
  [`PROVENANCE.md`](asset-recipes/xo-market-shop-row/PROVENANCE.md), and
  [`RECIPE_NOTES.md`](asset-recipes/xo-market-shop-row/RECIPE_NOTES.md).
  Production files are `public/assets/models/environment/xo-market/shop-row.glb`
  (LOD0, SHA-256 `a70d1edbbbcb31c85270fd1494a65ce799a624622dd2812b5c123987924fa0a4`)
  and `shop-row-collision.glb` (12 AABB proxies, SHA-256
  `d4f779dc50bab73917ef72511db5f94aec1dea0e64f1ddee9e044024c2db977d`).
  The row was authored in Blender 5.2.0 with Khronos glTF Blender I/O v5.2.39
  from original geometry; it uses reshaped CC0 ambientCG Bricks098/Fabric023
  maps and a decimated CC0 Poly Haven `brass_diya_lantern` donor by Bhargav
  Kubal ([asset page](https://polyhaven.com/a/brass_diya_lantern)). No Mali
  textures or source archives are shipped. The 27-image/55,890-triangle asset is
  deliberately a bounded hero pilot; its documented non-manifold edges,
  render-only practical lights and lack of runtime LOD remain open limitations.

- ambientCG PBR sets:
  `asphalt` = [Asphalt012](https://ambientcg.com/view?id=Asphalt012),
  `bricksOld` = [Bricks054](https://ambientcg.com/view?id=Bricks054),
  `concrete` = [Concrete034](https://ambientcg.com/view?id=Concrete034),
  `concreteDark` = [Concrete016](https://ambientcg.com/view?id=Concrete016),
  `corrugated` = [CorrugatedSteel009](https://ambientcg.com/view?id=CorrugatedSteel009),
  `dirt` = [Ground047](https://ambientcg.com/view?id=Ground047),
  `facadeA` = [Concrete030](https://ambientcg.com/view?id=Concrete030),
  `facilityFloor` = [Tiles053](https://ambientcg.com/view?id=Tiles053),
  `grass` = [Grass001](https://ambientcg.com/view?id=Grass001),
  `marble` = [Marble014](https://ambientcg.com/view?id=Marble014),
  `metal` = [Metal052B](https://ambientcg.com/view?id=Metal052B),
  `metalDark` = [Metal049A](https://ambientcg.com/view?id=Metal049A),
  `plaster` = [Plaster001](https://ambientcg.com/view?id=Plaster001),
  `plasterOld` = [Plaster007](https://ambientcg.com/view?id=Plaster007),
  `rock` = [Rock034](https://ambientcg.com/view?id=Rock034),
  `roofTile` = [RoofingTiles009](https://ambientcg.com/view?id=RoofingTiles009),
  `rust` = [Rust005](https://ambientcg.com/view?id=Rust005),
  `sidewalk` = [PavingStones070](https://ambientcg.com/view?id=PavingStones070),
  `stoneBrick` = [Bricks063](https://ambientcg.com/view?id=Bricks063),
  `wood` = [Planks009](https://ambientcg.com/view?id=Planks009),
  `woodDark` = [Wood052](https://ambientcg.com/view?id=Wood052)
- Quaternius:
  [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html),
  [Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html),
  [Stylized Nature MegaKit](https://quaternius.com/packs/stylizednaturemegakit.html),
  [Medieval Village Pack](https://quaternius.com/packs/medievalvillage.html),
  [Ultimate Modular Men Pack](https://quaternius.com/packs/ultimatemodularcharacters.html)
- Kenney:
  [Car Kit](https://kenney.nl/assets/car-kit),
  [Impact Sounds](https://kenney.nl/assets/impact-sounds),
  [Interface Sounds](https://kenney.nl/assets/interface-sounds),
  [UI Audio](https://kenney.nl/assets/ui-audio),
  [Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds)
- OpenGameArt audio:
  [Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library),
  [water splashes](https://opengameart.org/content/40-cc0-water-splash-slime-sfx),
  [chest](https://opengameart.org/content/open-chest-sfx),
  [park ambience](https://opengameart.org/content/park-ambiences),
  [birds](https://opengameart.org/content/ambient-bird-sounds),
  [city ambience](https://opengameart.org/content/scifi-city-ambient-loop)
- Google Fonts source repositories:
  [Saira Condensed](https://github.com/google/fonts/tree/main/ofl/sairacondensed),
  [Inter Tight](https://github.com/google/fonts/tree/main/ofl/intertight),
  [Noto Sans JP](https://github.com/google/fonts/tree/main/ofl/notosansjp)
- Authored pistol:
  [VladQc Glock](https://vladqc.itch.io/glock) (CC0 1.0; author page and free-download source)
- Authored AR/SMG:
  [3DModelsCC0 Guns & Explosives Pack](https://3dmodelscc0.itch.io/free-cc0-guns-explosives-pack) (CC0 1.0; AK-47 and Suomi KP source files)
- Authored sniper:
  [Stein Games M700](https://stein-indie.itch.io/m700) (CC0 1.0; source archive `Sniper_R700_Free_CC0.zip`; converted/baked production asset)
- Authored shotgun:
  [MikeMoon Remington 870](https://opengameart.org/content/shotgun-1) (CC0 1.0; source ZIP `https://opengameart.org/sites/default/files/Shotgun_2.zip`; named-part Blender/GLB conversion)
- Authored hand:
  [LibHand](https://github.com/libhand/libhand) (CC BY 3.0 Unported; `hand_model/hand_model_license.txt`)
- Authored tactical glove:
  [J-Toastie Gloved Hand](https://poly.pizza/m/MTB4egc4Vh) (CC BY 3.0; direct source GLB `https://static.poly.pizza/88d0bead-a488-4fb8-bd8e-242813383b78.glb`)
- Authored sleeve material source:
  [ambientCG Fabric023](https://ambientcg.com/view?id=Fabric023) (CC0 1.0)
- Eden modular kit:
  [JaronKBragg asset-pack-ue-threejs-blender-unity](https://github.com/JaronKBragg7337/asset-pack-ue-threejs-blender-unity), [ModKit v1.2 release](https://github.com/JaronKBragg7337/asset-pack-ue-threejs-blender-unity/releases/tag/v1.2), and [official ZIP](https://github.com/JaronKBragg7337/asset-pack-ue-threejs-blender-unity/releases/download/v1.2/ModKit-v1.2.zip) (CC0 1.0; archive SHA-256 `3393f2d34f046daa0f5a670f89704d274ffeb86674568ae0eb402f773dcec1fb`)

## Self-generated branding & map art (original work, repository MIT license)

| Asset | Local path | Generated by |
| --- | --- | --- |
| Favicon mark (X/O geometric) | public/assets/branding/favicon.svg | hand-authored SVG, 2026-08-24 |
| Apple touch icon | public/assets/branding/apple-touch-icon.png | tests/browser/gen-branding.ts (headless render of the mark), 2026-08-24 |
| Social share card 1200x630 | public/assets/branding/og-card.jpg | tests/browser/gen-branding.ts over a NEO CITY in-engine capture, 2026-08-24 |
| Map browser hero cards 1600x900 | public/assets/maps/{neocity,oldfront,eden,ashara}.jpg | tests/browser/qa-heroes.ts in-engine captures (HUD/viewmodel hidden), 2026-08-24 through 2026-08-29 |

## Verification

1. Every retained file under `public/assets/{sky,textures,models,audio,fonts}` that is
   not generated by this repo's build appears in ASSET_CHECKSUMS.txt.
   `npm run audit:assets` verifies both file-set completeness and SHA-256.
2. To re-verify a provenance claim, compare the recorded SHA-256 against the
   source project's published archive.
3. Runtime VFX, water, storm shaders and all UI remain original work licensed
   under the repository MIT license. Authored production weapon, hand, sleeve, character,
   and environment assets are tracked separately above; procedural fallbacks are retained
   only for development or isolated fallback behavior and are not accepted as production
   visual evidence.
