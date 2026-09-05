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

## Known open items

- Engine-level WebGPU validation warnings (`Binding size … is zero`) from
  three r185 node-material instancing: non-fatal, renders correctly, tracked
  upstream; qa-perf filters them from the fatal-error gate.
- OldFront gable shells are one-sided; players on those roofs see through the
  slopes from inside (cosmetic, queued for a cycle).
- Native 1080p60 acceptance measurements (Phase H) still to run on an idle
  reference machine.
