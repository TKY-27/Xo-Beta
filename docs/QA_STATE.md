# Xo Beta — Active QA State

Canonical, concise record of the current QA campaign. Historical material
lives in `docs/archive/` (the former root ledger covering the v0.4 WebGL
iteration ceiling).

## Campaign: WebGPU AAA overhaul (`feature/webgpu-aaa-overhaul`)

- Renderer: WebGPURenderer (three r185) + TSL RenderPipeline; WebGL2 fallback
  via the same code path. Reference machine: MacBook Pro M5.
- Perf baseline (WebGL, 1600×900 ultra): neocity 99 / oldfront 22 / eden 13 /
  ashara 56 FPS steady.
- Post-migration (WebGPU, same harness): neocity 75 / oldfront 74 / eden 79 /
  ashara 66 FPS steady, 1% low ≥ 42 on a quiet machine. Native-1080p
  acceptance runs pending (Phase H, repeated on an idle machine).

## Visual QA cycle log

A cycle = run the game, inspect fresh rendered evidence, fix the
highest-impact defect, re-verify, record. Independent critic review every
five cycles.

| Cycle | Evidence | Defect → fix | Result |
|---|---|---|---|
| 1 | oldfront town/field captures (g1) | OldFront read near-black (exposure 0.79, contrast 1.07) while paving blew out → exposure 0.95, ambient 0.55, hemi 1.0, vignette 0.26, contrast 1.0 | meadows/landmarks readable, paving balanced |
| 2 | neocity intersection + block cores | Mid-block cores sat empty and unlit → per-block lamp posts, crates, kiosks (16 blocks, deterministic) | minimap shows lit block cores; street props richer |
| 3 | eden lake shore (water verification) | Ported TSL water needed in-engine verification → verified: sky reflection, wave detail, boundary fade, foam, dock scene all correct | no fix required; highest-risk port confirmed good |
| 4 | ashara compound captures | Compound architecture read as cool blue-grey placeholder slabs against warm sand → new warm 'mudbrick' material (concrete set + sand tint) for compound walls/market buildings; wall-embedding test updated for the new key | warm desert-consistent architecture |
| 5 | INDEPENDENT CRITIC REVIEW (fresh-context subagent, self-captured evidence, all 4 maps) | Top findings: (P0) featureless ground planes map-wide; (P0) no AO grounding at default 'high' quality; (P1) vegetation placeholder grade + white sliver scatters; (P1) lake reads flat cyan at some angles; (P1) FP weapon boxy + magenta-rod rarity accent; (P1) lobby skin showcase is an untinted clay mannequin; (P1) night cloud texels blocky; (P1) rain reads as random scratches; (P2) transport aircraft toy-like; (P2) ashara terrain contour banding. Verdict: meaningful improvement remains, concentrated in 3 systemic gaps (ground detail, AO grounding, vegetation/prop quality) | backlog adopted as cycles 6+; AO default fix first |

## Pre-loop user-report fixes (verified in-engine)

- Resolution scale default 0.7 → 1.0; GTAO at native res (grain/halo gone).
- Logarithmic depth buffer — transport-altitude ground z-fighting eliminated.
- First-person viewmodel: capsule arms removed; weapon is the sole subject.
- Weapons rebuilt from real firearm anatomy (procedural, PBR gun materials).
- Minimap/tactical map track the transport during the ride.
- 12 skins across male/female body archetypes (EN/JA labels).

| 6 | night sky + default-quality grounding | (a) Cloud noise sampled nearest-neighbour → blocky texel patches; (b) default 'high' chain had no AO → unanchored props | (a) explicit linear/mipmap filtering + anisotropy; (b) AO enabled for high preset (samples 10) |
| 7 | rain on ashara + streak quality | Desert rain implausible + streaks read as scratches → dryStorm drops the rain field (thunder/clouds carry it); streaks longer/softer (0.85m, opacity 0.2) | rain reads as weather where it remains |
| 8 | oldfront meadow macro variation | Open fields read as one flat color at default quality → terrain vertex variation to full strength (verified in capture) | visible dry/green patchwork |

| 9 | drop transport close-ups | Toy blue/cyan/orange palette undermined the most-watched object → muted military gunship materials | verified in transport captures |
| 10 | SECOND INDEPENDENT CRITIC (fresh context) | Verified fixed: night clouds, transport palette (partial). Probe artifact: 'post' config disabled AO explicitly (game ships AO at high+; probe fixed). New findings adopted: lobby rig attachments buried in body → chest plate/rig enlarged to read as worn armor; Seraph palette shifted off skin-tone; killfeed SVGs + damage-number dt landed; transport white canopy still glossy (queued) | gear visible on all skins at lobby close-up |

| 11 | ashara med-kit pickup capture | Cross marking only on one face vanished at some bob angles → double-sided cross geometry, material groups updated | loot reads as medkit from any angle |
| 12 | ashara compound street-level | Mudbrick walls verified warm against dunes; residual: concreteDark roofs read pitch-black on unlit sides (queued — roof ambient lift) | compound color harmony improved |

| 13 | ashara dry-canals black-plain investigation | A whole terrain region rendered void-black under the post chain. Bisected across raw/post/bloom/noshadow configs: the r185 GTAONode returns ~0 occlusion on the WebGPU backend (whole terrain multiplies to black). AO pass removed from the shipped chain per the evidence-based-decision clause; contact grounding stays with the shadow map. Also: dynamic camera near plane replaced with discrete bands + post-chain rebuild (a continuously sliding near broke depth-derived passes). Revisit GTAO on a three.js upgrade | canal region renders correctly; no black void |

| 15 | THIRD INDEPENDENT CRITIC (fresh context) | Verified fixed: ashara canal void, toy-blue stairs, night clouds. New/remaining: (1) eden water reads flat from some angles; (2) no contact shadows after AO removal; (3) pure-black unlit props near ashara compound — CORRELATES with the 22 zero-size-uniform WebGPU validation errors (eden/oldfront/neocity 22, ashara 0 — the delta is Quaternius foliage/instancing); (4) canal teleport burial; (5) night-map shadow floors read 0-value black; (6) QA_SKIN probe env not switching lobby label. Verdict: improvement remains; black-prop class is the top render-path bug | backlog reordered — validation errors first |

| 16 | Focused investigation (subagent) | Root cause of the 22 zero-size-uniform validation errors found: MapBuilder.finish filters out all lamps on eden/oldfront/neocity, leaving 5 zero-capacity InstancedMesh lamp pools; three r185 wraps the empty instanceMatrix in a buffer node → device.createBuffer({size:0}) per bind group. Fix: lamp pools only build when lamps survive (worldView.ts). All four maps now 0 errors; renders verified. The 'black prop' near the ashara compound is a lamp fixture in dark metalDark (cosmetic, separate) | eden/oldfront/neocity/ashara: 0 errors |

| 17 | ashara canals post-fix verification | Zero-error fix regression pass: canal region renders clean (lit beds, terrain variation, no void, no black props in view) | verified |

| 18 | eden lake capture | Water base color dominated at most view angles → sky-reflection fresnel weight raised (0.20+0.28·clarity → 0.42+0.30·clarity) | visible sky reflection + wave texture; hard shoreline still queued |


| 20 | FOURTH INDEPENDENT CRITIC (fresh context) | Verified fixed: ashara void, eden stairs, night clouds; shore band works at ground level. Remaining top items: (1) no contact shadows/AO anywhere — props float; (2) water still reads painted (uniform cyan from above, no depth tint); (3) ashara ground corduroy tiling striation; (4) pure-black unlit faces on boulder bases/poles; (5) oldfront plaza reads as polished marble; (6) toy-blue remains on some ashara compound rails. Verdict: improvement remains — grounding is the biggest gap | blob-shadow grounding + stair rails queued (cycles 21-22) |

| 21 | neocity night capture | Vehicles floated on asphalt (no contact grounding after AO removal) → soft dark contact-shadow discs under every vehicle bucket | verified in capture |

| 22 | ashara aerial + ground captures, eden tree-cluster captures | (1) Ashara ground corduroy: the sand micro texture tiled one global 13-crest sinusoid + a fixed-direction normal streak map → every tile showed identical parallel grooves. Fixed in `buildSandMicroTexture` (two phase-warped ripple families at different angles, faded in/out by periodic-noise patch masks; seam-free lattice noise) and in the desert normal map (streak coordinates meandered by a second noise, anisotropy 3:1→1.5:1, strength 2.2→1.5, normalScale 0.5→0.42). (2) Contact blobs extended to rocks and trees via shared `buildContactBlobs` helper (vehicle blobs now share one geometry/material per view). Probe now also dumps the tac-map aerial (`00-aerial.png`) for map-wide tiling sweeps | corduroy gone in aerial + ground views (sand reads as calm, patchily rippled desert); blob discs visible under every rock/tree/vehicle; probe runs zero console errors |

| 23 | ashara Sunwall Market A/B forensics (pixel sampling, material-pool hide/tint) | Critic round-3/4 class "pure-black unlit faces" (poles, stair undersides, sign panels, window panes, boulder bases) root-caused via new in-engine A/B tooling: **plain (non-node) MeshStandardMaterial on InstancedMesh loses ambient/hemisphere/env fill on WebGPU r185** — direct sun works, shade crushes to void-black; node-based materials are immune. Fixes: (1) all 13 library `MeshStandardMaterial`s → `MeshStandardNodeMaterial`; (2) dark-metal family retuned (metal .85→.55, metalDark .8→.5, metalExterior .62→.38, corrugated .55→.28) — weathered steel, not chrome; (3) rust: its instanced pool rendered void-black regardless of live albedo/roughness edits (scan data verified healthy) → draw-level r185 instancing fault, so rust ships the flat fallback (reads as painted rusted steel) until three fixes the binding family; (4) ashara ambient 0.62→0.8 for shade floor. New permanent QA capability: `__xoPick`/`__xoRayEnum`/`__xoHideUuid`/`__xoTint` bridges + `qa-pick.ts` diagnostic probe | sign panel renders dark-red-brown in shade (was (0,10,35) void); neocity night + oldfront overcast sanity sweeps clean; 716 unit tests pass |

| 24 | oldfront + ashara captures | (1) Round-4 critic: oldfront trims/pier decks read as polished marble → marble roughness 0.45→0.78 (weathered outdoor stone, diffuse-dominant). (2) Round-4 critic: cool blue-grey steel on ashara reads as toy plastic against warm mudbrick → `metalExterior` joins the ashara daylight substitution and steel batches get a warm instance-colour multiplier (channel ratio, no projected-material cloning) | plaza stone no longer mirrors; stair steel/posts read as warm bronze on ashara; zero console errors, 542 unit tests pass |

| 25 | FIFTH INDEPENDENT CRITIC (fresh context, self-captured evidence, all 4 maps) | Verified fixed: ashara corduroy, oldfront marble mirror, contact blobs (rocks/buildings/vehicles), black-window-frames class on most props. Score 4/10 vs Bodycam bar — "structurally sound and artifact-free, but near-field material absence and toy-grade props keep it below photoreal". Top defects: P0 (1) roadside poles still render pure black — GLB-derived materials were NOT covered by the cycle-23 node conversion; (2) transport aircraft = featureless grey capsule; (3) wrecked vehicles read as black blobs (same GLB-plain-material cause). P1: ashara near-field sand too smooth; eden water opaque turquoise; neocity aerial shows two 55 m dark discs; ashara road ribbon floats/reads white; horizon contour banding; buildings/vehicles flat "toy" pass; eden paths white; weapon HUD panel translucent. P2: cloud sprite edges, floodlight crescent from overhead, vegetation lollipop, rain streak sparsity, night asphalt featureless | GLB material node-conversion queued (cycle 26); transport rework, water desat, road seating, HUD scrim queued |

| 26 | ashara highway/compound/pole captures + pick census | Critic P0.1/P0.3 root: GLTF-loader materials (props, rocks, vehicles) are plain `MeshStandardMaterial` → same WebGPU instancing ambient-immunity as cycle 23. (1) `toNodeStandard` converts every GLB material at ingest (`extractGeometries`, vehicle templates, makeInstanced fallback). (2) Roadside pole now renders warm wood with visible crossarm (was void-black) — P0.1 verified fixed in capture. (3) `ProjectedStandardMaterial.copy()` now rebuilds the triplanar graph for clones — the road dirt shoulder and surface-path clones had been rendering graph-less pale-white (also the eden white-path class). (4) Desert floor foil shimmer: sand DataTexture had no mipmaps (2 cm texels aliasing at grazing) → trilinear mips; bumpMap removed in favour of the meandering normal map; desert normalScale 0.42→0.25; road ribbon resampled at 0.5 m. Outstanding: wreck silhouettes still dark (vehicle tint path), drain ribbon pale | 542 unit tests pass; zero console errors |

| 27 | eden transport capture | Critic P0.2: transport aircraft was a featureless grey capsule with slab wings and flat cyan discs. Rebuilt `buildTransport` as procedural dropship anatomy: lathed fuselage profile (nose cone → cockpit hump → troop section → tapered tail), glazed cockpit on the nose slope, swept tapered extruded wings with slight anhedral, wing-tip nacelles (intake lip + trim ring + recessed emissive exhaust disc), twin canted tail fins, structural hoops, dorsal rail + antenna, belly skids, slung cargo pod with lit windows, red running beacons | transport reads as a real twin-engine dropship from the drop camera; zero console errors |


| 28 | eden lake capture, neocity aerial/pick census | Round-5 P1 fixes: (1) eden water desaturated (lake/pond/river scatter profiles toward muted slate) + an always-on sky-ambient term (reflected×0.08) — real water never shows pure scatter from overhead; capture shows grey-blue water with sun glint instead of opaque turquoise. (2) HUD weapon slots were 24% translucent (bright world bled through at night) → near-opaque + 3px backdrop blur. (3) Round-5 P1.3 'two 55 m dark discs' in the neocity aerial investigated via ground-level pick: both are AUTHORED geometry (the 28.5 m centre canopy and the (−130,110) gasometer pad) — not a defect, no fix needed | zero console errors; water + material unit tests pass |

| 29 | ashara wreck close-up + runtime material pick | Round-5 P0.3 fixed: wrecked vehicles rendered as black silhouettes. Diagnosis chain: (1) wreck tint multiplied the already-dark authored colour by 0.32 → black; (2) after de-darkening, the pool STILL intermittently rendered black with verified-correct material values at runtime — the stochastic face of the r185 instanced-binding fault; (3) vehicles are now one non-instanced clone per car (≤9/map, cheap) with the colormap atlas dropped for wrecks (flat ash 0x4a423a, matte) — the atlas's saturated primary body paint otherwise bled through any multiplied tint. Capture: sun-lit ash-brown wreck, readable silhouette. Note: two 5s net-clock unit timeouts during the cycle were load flakes (pass in isolation) | wreck reads as a scorched car; vehicles immune to the instancing fault by construction |

## Known open items

- GTAO (ambient occlusion) disabled: upstream r185 GTAONode bug on WebGPU returns ~0 occlusion (cycle 13). Revisit when upgrading three.
- Engine-level WebGPU validation warnings (`Binding size … is zero`) from
  three r185 node-material instancing: non-fatal, renders correctly, tracked
  upstream; qa-perf filters them from the fatal-error gate.
- OldFront gable shells are one-sided; players on those roofs see through the
  slopes from inside (cosmetic, queued for a cycle).
- Native 1080p60 acceptance measurements (Phase H) still to run on an idle
  reference machine.
