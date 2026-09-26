# Rebuild root-cause matrix

This matrix is the active campaign record. Historical scores and checkmarks are
context only. Each row requires fresh evidence before it can be closed.

| Observed defect | Underlying cause | Decision | Chosen solution | Validation evidence |
| --- | --- | --- | --- | --- |
| All five first-person guns read as narrow boxes, tubes, and primitive parts at normal FOV | `src/render/weaponGeometry.ts:250-768` builds visible anatomy from primitives; `weaponModels.ts:237-310` always calls it | Replace visible hero geometry; retain gameplay IDs and socket contract | Load authored GLB through the local asset cache, normalize it, bind named moving parts, and migrate the pistol first | `qa/rebuild-baseline/*/{01-grounded,10-ar-hip,11-ar-ads,12-ar-fire,13-ar-reload-mid,14-ar-sprint}.png`; new matched pistol captures after integration |
| Reload and bolt events disappear for hidden/scoped or guest viewmodels | `viewmodel.ts:355-375` rejects authoritative events based on visibility; remote replicas have no reload timeline | Keep state machine, fix ownership and delivery | Queue presentation events independently of visibility and share local/remote/camera presentation state; add regression tests | Unit test for hidden reload, online event sequence, fresh reload/bolt captures |
| The old facility is a dark facade with pasted slab windows and empty rooms | `world/maps/common.ts:294-1172` and `maps/eden.ts` share a primitive `addBuilding` chain; render and collision are coupled through `GeoSpec` | Add a parallel authored visual-kit layer; keep simulation data | Build an Eden lab/atrium/dock/greenhouse vertical slice with real frames, wall thickness, stairs, railings, machinery, and grounded props; retain collision/nav | Eden close/medium/aerial captures, contact trace, independent technical-art review |
| The old 4096 grid and unculled vista/static batches undermine culling and frame pacing | `worldView.ts:899-906,1118-1135`, `vista.ts` static presentation | Rework culling, not renderer | Fix grid subdivision and distance/instance bounds, then measure draw calls and frame time on all maps | 1920x1080 telemetry and before/after map captures |
| Vehicle shadow passes dominate NeoCity frame pacing even though every vehicle already has a contact-grounding disc | `worldView.ts:1925-2001` clones one multi-mesh vehicle per placement; the old “≤9 vehicles” assumption is false for dense maps, and all vehicle meshes cast redundant shadows | Keep individual vehicle meshes because of the prior WebGPU instanced-binding silhouette defect; remove only redundant vehicle shadow casting while retaining contact blobs and receive-shadow | Set vehicle mesh `castShadow=false`; keep contact discs, body materials, and collision unchanged; validate normal-FOV captures and 1920x1080 ultra profile | Headed 1920x1080 ultra: NeoCity 1% low 52 FPS, OldFront 56, Eden 53, Ashara 51; zero browser errors; `qa/poi-neocity-*.png` captures show grounded street/market views; draw-call attribution showed vehicle shadow passes were a major source |
| Hand/arm anatomy is generated and remains blocky at the closest view | `hands.ts:259-832` owns visible procedural anatomy and the available external full-arm pilots lack a credible connected sleeve/hand solution | Keep the solver and LibHand articulation; replace the visible arm foundation only with a verified authored asset | LibHand remains the production hand base with authored sleeve fallback; the CC0 Drillimpact arm pilot was tested, rejected for detached/low-poly arms, and fully removed. Do not add more finger/scale constants or claim a procedural fallback | `qa/hands-isolate/ar.png` after rollback; hands/arms gate remains failed |
| Reload/pump captures show a detached magazine/cuff cluster, but isolated captures prove the authored action path is moving | The hand rig/cuff is a low-poly disconnected presentation layer; the named AR magazine and shotgun pump sockets/timelines are functioning | Keep authored action/socket contracts; replace the hand/arm contact foundation instead of adding arbitrary offsets | Use deterministic `QA_PHASE` captures to separate magazine transforms from hand articulation; only change reload sockets if isolated evidence shows a transform defect | `qa/hands-isolate/arqa/phase*-mag.png`, `phase*-nohands.png`, and deterministic pump/reload phase dumps; hands gate remains failed |
| Characters combine Quaternius bodies with primitive helmets, armor, packs, and fallback capsules | `characters.ts:323-469,923-1011` had a procedural costume attachment layer and one shared dark material treatment | Replace visible costume modules; retain hit proxies and animation state | Production loads the CC0 Quaternius SWAT GLB, strips its built-in pistol, maps 24 clips, binds semantic materials (`Skin`, `Visor`, `Swat`, `Swat_Black`, `Grey`, `Black`, `DarkBrown`) to distinct PBR roles, and bypasses primitive costume attachments; the old UBC body is compatibility/fallback only | `qa/quality-rework/characters-semantic/char-neocity-0.png` through `-3.png`; independent third-person silhouette/material review remains required and the asset is currently untracked |
| World materials can look flat and asset-license audits do not describe the art pipeline | Existing checksums cover files but not source-member/transform recipes; npm license audit is not art provenance | Separate code dependency and art asset audits | Add canonical intake records, immutable hashes, source/member/recipe metadata, and build checks for legal files | `npm run audit:assets`, independent license/provenance check |
| Ashara’s market reads as sparse/stylized and lacks believable desert massing/roofscape | Mali, Antics, and the temporary fort were rejected for geometry, attribution, or identity reasons; repeated Quaternius stands/walls created a long thin strip with weak foundations and no roofscape | Reject weak pilots; integrate a coherent authored market with explicit collision and leave the gate open | Replaced the repeated KayKit market copies with one original XO-authored `market-hall.glb` (73,356-tri LOD0, 5,038-tri LOD2, 12-box collision hull) plus four varied CC0 KayKit background buildings, 11 cargo pieces, nine market-goods props, a dirt lane and seven Quaternius enclosure modules. The hall uses authored thick walls, a real recessed arch, windows/shutters, canopy, hardware, stall and roofscape; collision is an explicit open-front shell. The MegaKit detail pilot remains removed. This is a real hero-asset improvement, not a final district or material pass | `qa/poi-ashara-market-close.png`, `qa/poi-ashara-market.png`, `qa/poi-ashara-market-east.png`, `qa/poi-ashara-market-south.png`; `docs/asset-recipes/xo-market-hall/`; production hashes in manifest/checksums; environment gate remains failed pending independent review and broader context work |
| Online guest presentation scope identity can use stale mutable Actor state | `PlayerController.sampleCommand()` previously sampled ADS before accepting the local weapon identity, so a remote replica could pass an adjacent/previous weapon into the sample | Preserve deterministic authority while binding presentation to the equipped weapon | `sampleCommand(adsAmount, dt, weaponId)` now records the sampled weapon before scope scaling; `main.ts` passes the local actor’s equipped weapon; unit coverage verifies replica sniper 4x scope reduction and AR isolation | `tests/unit/player-controller.test.ts`; typecheck/lint/focused player tests pass; online host/guest browser regression remains required |
| Ashara MegaKit detail pilot was rejected after live inspection | The geometry-only roof/overhang modules were valid files but visually produced black/white toy roof masses over the KayKit buildings; hiding the three roof instances removed the dominant artifact, and a MeshBasic white override confirmed poor silhouettes rather than a lighting-only defect | Reject and remove the pilot; do not mask it with material/lighting tuning | Removed all eight MegaKit production binaries, plan instances, material mappings, preloads and active provenance rows; retained the 3-building/11-cargo/7-enclosure KayKit slice and recorded the rejection in the matrix | `qa/poi-ashara-market-close.png` (detail-on/off comparisons), `qa/boot-probe-ashara/05-final.png`; environment gate remains failed pending a structurally different authored district |
| Environment assets were all parsed at boot and raw scene caches had unclear ownership | `preloadAll()` loaded every map kit synchronously before `WorldView.create`; preserve materials were cached without explicit external ownership | Rework delivery, not visual quality | Derive per-map paths from `EnvironmentPlan`, preload selected paths with in-flight dedupe/abort/generation guards, hide visual-only instances before clone, and mark shared normalized resources external | `qa-renderer-lifecycle.ts`: programs 2626, textures 207, geometries 242, render targets 27 unchanged across three composer rebuilds; all-map QA zero errors |
| Ashara sky showed large pale rectangles and dust/storm layers read as artifacts | Invalid point geometry and a hard banded storm-wall node material created visible debug-like layers; QA A/B isolated the storm mesh | Fix renderer/effect root cause, not hide with bloom | Remove invalid desert point path, generate missing UVs for custom node-material geometry, smooth storm bands, and retain a temporary `QA_HIDE=storm` diagnostic only | `qa/quality-rework/storm-smoothed.png`; no runtime UV warnings in Ashara QA |
| Prior GATES accept “notable improvement” while recording the low-poly ceiling | Acceptance model evaluates relative change and test success | Replace, do not preserve | Active gates require fresh blind A/B, 9.0/10 minimum pillars, no P0/P1, and no dominant procedural impression | New QA campaign ledger and two consecutive clean full-review rounds |

## Baseline

Fresh headed captures were generated under `qa/rebuild-baseline/` for all four
maps and all five weapon classes. The captures show primitive buildings,
cutout/lollipop vegetation, sparse interiors, block hands, and long primitive
reload poses. They are intentionally retained as local baseline evidence, not
committed artifacts.

## Current implementation entry point

The current authored weapon slice is the pistol at `public/assets/models/weapons/authored-pistol.glb` plus the AR/AK-47, SMG/Suomi KP, Remington 870 pump shotgun and sniper/M700 GLBs at the sibling weapon paths. Sources and hashes are recorded in `docs/ASSET_MANIFEST.md` and `docs/ASSET_CHECKSUMS.txt`; the runtime adapter retains named magazine/bolt/pump/muzzle/sight nodes where present and derives ADS from sight anchors. The M700 skinned source was baked to a static two-mesh production GLB after a Three.js skinned-LOD transform collapse was reproduced; its bolt socket is now derived from the baked receiver bounds. The models are a material and topology improvement over the primitive builders, but fresh independent review still governs whether any class reaches the final gate.

The production character foundation is `public/assets/models/characters/swat-modular.glb`, a glTF→GLB copy of Quaternius Ultimate Modular Men `Swat.gltf` (source SHA-256 `622b3f36fcac90539ef8f7121ec1f11b5e1ae603a085019b3fa96eba20dddfd3`, production SHA-256 `0cd2b3876e5f20f3c85ffc5dcccd05dccb7aaec86235434f7f449f3b44417b7c`). It contains 5 meshes, one 62-joint skin and 24 clips; the runtime maps source clips to the existing state machine, recolors authored materials by skin palette, binds `Wrist.R`, and skips the old primitive helmet/armor/pack block. The source has no textures, so material richness and silhouette review remain open.

The original authored sleeve pilot `public/assets/models/hands/authored-sleeve.glb` remains only an explicit fallback/lineage artifact: captures showed detached tube occlusions, and the separate full-arm Drillimpact pilot was removed completely after a failed integration. The current production hand path is LibHand-first with `integratedArm` capability routing; no sleeve, arm, or glove state may be called AAA. Its source recipe, Fabric023 provenance, and limitations remain in the asset manifest/notices while the hands gate stays failed.

The production hand path now prefers `public/assets/models/hands/libhand-hand.glb`, Marin Saric’s CC BY 3.0 LibHand, because its authored anatomy and finger articulation are materially more credible than the low-poly tactical glove. The runtime remaps its skeleton, applies a dark tactical PBR material treatment, and falls back to J-Toastie’s CC BY 3.0 `authored-tactical-hand.glb` only when LibHand is unavailable. Both exact source URLs, attribution, modifications, and checksums are recorded in the manifest/notices.

The Eden facility pilot uses 25 selected modules from the official Jaron Bragg ModKit v1.2 release, including reinforced/corner/damaged walls, windows, doors, floors, hatches, ceilings, roof/trim/parapet, beams/columns, vents, stairs/railings, pipes, crate variants, rubble/debris and barrels. The release archive SHA-256 is `3393f2d34f046daa0f5a670f89704d274ffeb86674568ae0eb402f773dcec1fb`; all selected production hashes are in `docs/ASSET_CHECKSUMS.txt`. The kit is CC0, but its source materials are flat placeholders and its geometry is procedurally generated; Xo Beta assigns the existing PBR material library and keeps collision/navigation in deterministic map data. Fresh Eden ground, dock, greenhouse, generator and aerial captures are required before propagation.

The CC0 Mali Buildings market candidate, the attribution-ambiguous Antics stall, the temporary Poly Haven fort/collision ring, and the black/white MegaKit detail pilot were rejected after fresh Ashara captures. The current authored Ashara slice is now one original XO market hall at `(-40,ground,-31)` (0.95 scale, yaw 0.06) with four varied CC0 KayKit background buildings, 11 cargo pieces, nine ceramic/brass goods props, a dirt lane and seven Quaternius enclosure modules. The hall’s production LOD0/LOD2/collision hashes are `a91888bbdd640ccb1afd8e6a88f957f8d8d92a2d70b2416ec4953c486531f2c5`, `31ade36ccab5601d86d02aad45343093efb8d2d1d50729b087f482d0f46065e5`, and `3fd5277fbaf11d78fa649f90e7a51c051a95e721a746c0a3881bff6578fb858c`; the full recipe is in `docs/asset-recipes/xo-market-hall/`, with the CC0 Poly Haven `brass_diya_lantern` donor by Bhargav Kubal (12,407 of the LOD0’s 73,158 vertices, 12,742 of its 73,356 triangles) and the ambientCG Bricks098/Fabric023 inputs documented in the manifest/notices. The recipe is reconstructable from documented sources rather than bit-reproducible, and only the LOD0 GLB is wired into the runtime prefab path; the 12-box hull GLB and the 5,038-triangle LOD2 are committed and hashed but not loaded. The hall is materially more authored than the former repeated stalls, but the district still needs broader massing, ground variation, denser dressing, independent review, and further structural work; the Sunwall environment gate stays failed. Static plan meshes remain spatially batched by 128m cells and instanced where compatible; visual/material/collision separation and provenance audits pass, but the pilot is not final art.

## Systemic material library defect (build-wide, fixed)

**Impact.** Every hand-authored PBR material in the game rendered as a flat
fallback colour in every build: roads, sidewalks, concrete, wood, stone, brick,
plaster, metal, rust, corrugated steel, roof tile, marble and the desert lane all
lost their albedo, normal and roughness maps. This is the root cause behind a large
share of the "flat", "untextured", "prototype/blockout" impressions recorded by
independent critics, and it is why lighting and post-processing tuning kept
producing no material response. It is also why an earlier "material" fix appeared to
do nothing: the texture work was correct on disk and simply never reached the GPU.

**Root cause.** `src/render/materials.ts` populated its texture-set cache keyed by
the *material* key and read it back keyed by the *texture directory*:

```ts
sets.set(matKey, await loadTextureSet(dir));   // keyed 'dirtDesert'
...
const set = dir ? sets.get(dir) : undefined;  // read   'packedEarth'
```

Every lookup therefore missed and fell through to the flat fallback palette at
`src/render/materials.ts:666-680` (`MeshStandardNodeMaterial` with a hardcoded
`fallback[key]` colour, no maps). Several material keys intentionally share one
texture set (`dirt`/`dirtDesert`, `concrete`/`concreteDark`), so the *set* is the
thing that has to be addressable. Confirmed by a binary test: setting the
`dirtDesert` tint to magenta did not change the lane, proving the live lane was
using the fallback palette entry `dirtDesert: 0xb79d72` and not the configured
material at all.

**Fix.** Key the cache by `dir`, matching every other access in the file
(`sets.get(dir)` at 658/926, `sets.set(dir, s)` at 929, `sets.clear()` at 936):

```ts
if (!sets.has(dir)) sets.set(dir, await loadTextureSet(dir));
```

**Evidence.** `qa/poi-ashara-market-close.png` before the fix: a flat, untextured
tan ribbon. After: the lane shows real packed-earth aggregate, mottling and value
variation. `qa/poi-oldfront-checkpoint.png` shows textured dirt road, wood grain
and metal on the chest, and rust on the trestle. `qa/poi-neocity-street.png` shows
textured wet asphalt with a light reflection. Full verification after the fix:
`npm test -- --run` 84 files / 827 tests passed, `npm run build` passed, asset
audit 277 production files verified, secret/license/water/zero-cost audits pass.
This is a root-cause fix with build-wide effect, not a per-map art tweak.

## Desert lane material (new derived set)

**Impact.** The Ashara market lane rendered as a saturated red-brown smear
occupying roughly half the frame at the primary approach viewpoint.

**Root cause.** The stock CC0 ambientCG `dirt` albedo averages RGB(80,66,36) - dark
and strongly red. Tinting is a channel-wise multiply, which can only darken, so no
tint value can desaturate it; every desert lane built from that albedo read as
red-brown regardless of tuning.

**Fix.** New derived texture set `public/assets/textures/packedEarth/`. The albedo
is re-authored from the same set's normal map, so albedo value follows surface
relief and colour tracks compaction, mapped onto a deliberately low-chroma sandy
ramp (measured average RGB(150,143,129), chroma r-g 7.2 / g-b 14.7) with two
scales of low-frequency patchiness and gravel speckle (luma min/mean/max
39/144/210, std 21.3). `normal.jpg` and `rough.jpg` are the verified `dirt` files
byte-for-byte, so this is a derived albedo rather than a new asset dependency. The
recipe is `make-packed-earth.py` in the local scratch directory. Checksums recorded
in `docs/ASSET_CHECKSUMS.txt`; `dirtDesert` now samples it at 3.2 m with a
near-neutral tint that sits below the surrounding sand in value, because a
compacted track is darker than the loose ground beside it.

**Note.** `packedEarth` was added to the `TEX_DIRS` boot preload list in
`src/assets/assets.ts`; without it the set would have loaded only through
`createMaterials()` and any capture taken before that resolved would still show the
flat fallback.

## Systemic: the TSL `normalNode` path also kills direct lighting, so terrain was sun-dead

**Impact.** Every map read as flat, dark, untextured ground with no cast shadows on
it. Independent critics on all four maps reported the same thing: a large flat
untextured colour field, a crate visibly floating with daylight beneath it, and
masonry meeting grass along a razor-straight shadowless seam. This was the
campaign's single highest-impact visual defect and it was invisible to inspection
because the terrain material *looked* correct: it reported `map:false`,
`normalMap:false`, `vertexColors:true` and a populated `roughnessNode`.

**Root cause.** `docs/QA_STATE.md` cycle 57 recorded that r185's node pipeline
zeroes all direct lighting (sun *and* sky-fill) for a standard material that
combines `normalMap`/`bumpMap` with any other map, and the fix at the time routed
terrain relief through the TSL `normalNode` slot to avoid the stock one. That dodge
does not work: **the TSL `normalNode` path inherits the same defect.** Measured on
Ashara at 1280x720 with `quality:'ultra', shadows:true, shadowQuality:'high'`: the
terrain splat material is a `MeshStandardNodeMaterial` with a `colorNode` and a
`normalNode`; clearing only `normalNode` on that material, changing nothing else,
turns a near-black red-brown ground into correctly lit sun-bleached sand with a
readable raked key and visible cast shadows
(`qa/probe-ground-nonormal.png`, isolated through the `__xoTerrainQa` QA hook).
Shadow rig state was verified healthy in the same run: `shadowMapEnabled true`,
`sunCastShadow true`, `hasShadowMap true`, `mapSize [2048,2048]`, frustum
`[-110,110,110,-110,10,560]`, and the authored market meshes all `cast:true,
receive:true`.

**Fix.** `src/render/materials.ts` `TerrainSplatMaterial.buildSplatGraph()` no
longer samples any normal map and no longer assigns `this.normalNode`; the
per-layer normal sampling block, the tangent-frame reconstruction and the
`normalParts` accumulator were all removed. Relief is preserved through the baked
albedo sets plus the second `detailMeters`/`detailAmount` octave. A comment in the
graph records the measurement and forbids reintroducing a terrain normal without
re-running the `__xoTerrainQa` isolation captures that prove direct light survives.

**Consequence for the rest of the campaign.** Every lighting judgement made before
this fix was made against an unlit ground, so the key/fill ratios, `envMapScale`
values and material tints all have to be re-measured rather than trusted. The
desert `sunDirection` had already been raked to `[-0.62,-0.42,-0.66]`
(≈24.8° elevation) on the theory that the sun was too high; with the ground
actually lit, that raking is finally doing the job it was introduced for.

## Systemic: `Scene.environmentIntensity` is inert under the r185 node pipeline

**Impact.** The second half of the "no shadows" problem. With the terrain sun-dead
the remaining surfaces were still washed flat, and casts that were computed
correctly were invisible. Critics reported "shadowless", "flat", and "poster-paint"
lighting on every map, and many cycles of tuning had been spent on sky `envIntensity`
values with no measurable effect.

**Root cause.** `src/render/renderer.ts` sets `scene.environmentIntensity` from
`sky.envIntensity`, but the r185 node pipeline does not honour it: sweeping it
0.68 → 0.34 → 0.18 → 0.08 produced near-identical frames, while sweeping each
material's own `envMapIntensity` (0.5 → 0.125 → 0.0125 → 0) changed the image
dramatically and made cast shadows plainly readable. Ashara's
`qwantani_puresky_2k.hdr` is a full sky dome with no dark ground half, so at the
default per-material intensity of 1 its diffuse irradiance outweighed the 3.6-intensity
key light and every surface read as shadowless.

**Fix.** New `SkyConfig.envMapScale?: number`, a multiplier applied to every world
material's `envMapIntensity`, with `renderer.applyEnvMapScale(scale)` called after
`scene.add(world.group)` in both the guest and host/local start paths (before that
add the traversal saw no world materials and the call was a silent no-op).
`applyEnvMapScale` is idempotent and re-bases from the authored value through
`envMapScaleBase` rather than compounding, and returns the number of materials
touched so the QA dump can confirm it ran. Ashara is set to `0.2` from the
measured sweep; the other three maps still carry `envIntensity` values that were
tuned against an inert lever and need their own measurement.

## Independent critic round 7 (31 valid captures, all four maps) — findings and status

The panel read all 31 `qa/poi-*.png` frames, captured with a verified teleport
(the earlier round's NeoCity/Ashara frames were shot at the map spawn corner
because the QA teleport silently ignored payloads without a nonce, so their
"no shadows" and "IBL has no effect" conclusions were evidence-invalid and have
been re-taken). Verdict: dominant impression still reads as procedural /
low-poly / blockout — **YES**; acceptable at a GTA-V / AAA bar — **NO**.
Scores: environment geometry 4, materials 3, lighting 3, terrain/grounding 2,
density 4, art direction 5.

### Fixed in response to this round

| Impact | Root cause | Fix | Evidence |
| --- | --- | --- | --- |
| Objects read as stickers on the ground; no contact darkening anywhere | The contact-shadow discs sit a few centimetres above an undulating heightfield, so they lost the depth test across most of their radius and silently vanished. Lying logs and lamp posts were excluded from the spot list entirely. | `MeshBasicMaterial` on the disc pool gained a negative `polygonOffset` (factor -3, units -6) so it wins the depth test without lifting off the ground; opacity 0.5 → 0.62 with a darker core; the `cyl` branch now emits an elongated spot for horizontal pipe/log runs (previously `if (g.pitch || g.roll) continue`), deriving the run axis from the presentation Euler; lamp posts gained their own contact spots. | `qa/poi-oldfront-forestcamp.png` — logs, barn base and trees now show contact darkening where they previously floated. |
| The single 2048² shadow map spans 220 m, so one texel is 0.107 m and a 2–5 cm contact band is sub-texel | Shadow frustum fitted for whole-map coverage only | Not fixed by a second cascade: three.js only darkens a light's own contribution with its own shadow map, so a shadow-only second light has no visual effect (verified, then reverted). The fitted per-object contact decals above carry the near-field term instead; cascade work remains open. | Reverted `sunNear` experiment; `renderer.ts` comment records why. |
| First-person arm ends in a hard cross-hatched disc | LibHand is a bare-hand scan whose mesh is open at the wrist. With `integratedArm === false` the whole `ArmSolver` group was hidden, so nothing closed the opening and the glove weave texture was seen from inside. The procedural sleeve's flat end caps fanned a full texture width across a few centimetres for the same reason. | The authored sleeve cuff is now always visible (constructor, `solve()` group visibility and `setIntegratedArm`), so a hand-only rig gets authored geometry closing the wrist; the procedural sleeve's ring radius collapses to zero at both ends so its caps are degenerate domes. | `qa/poi-ashara-market-close.png` — the disc artifact is gone in the live capture. |

### Open, ranked by perceptual impact

1. **No real local lights.** Neon, lamp heads, window glows and light pools are
   emissive materials and painted gradients; a lamp post stands in a uniformly
   lit street with no falloff. `StaticLightPool` virtualises to 8 point lights.
2. **Axis-aligned box architecture.** `b.box` cuboids with flat tops, no
   reveals, no setbacks, no roof-form variety — the dominant remaining
   "blockout" read in every district.
3. **Terrain is a single flat texture per map** with visible tile seams and
   unprojected decal quads; no slope/height splat, no macro variation.
4. **Black voids.** Interiors and window openings land on pure `#000` because
   only the key light reaches them and ambient was cut to 0.2–0.45.
5. **Untextured/floating primitives** named per frame: a black slab at
   `ashara/fuel-court`, an orange box at `ashara/market-east`, a blue box at
   `neocity/residential`, a floating pipe stub at `oldfront/farmstead`, a dark
   ellipse artifact on the road at `neocity/spire`, and a full-width bright
   blue band at `neocity/transit`.
6. **Fake reflections** — an inverted mirrored rectangle under the Ashara market
   building, an opaque light-blue fountain disc at `oldfront/cathedral`, hard
   elliptical puddle decals.
7. **Weapon ADS readability** and **SWAT character detail** remain open gates;
   both were last reviewed before the systemic lighting/material fixes and need
   fresh panels.
