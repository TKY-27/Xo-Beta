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

## Pre-loop user-report fixes (verified in-engine)

- Resolution scale default 0.7 → 1.0; GTAO at native res (grain/halo gone).
- Logarithmic depth buffer — transport-altitude ground z-fighting eliminated.
- First-person viewmodel: capsule arms removed; weapon is the sole subject.
- Weapons rebuilt from real firearm anatomy (procedural, PBR gun materials).
- Minimap/tactical map track the transport during the ride.
- 12 skins across male/female body archetypes (EN/JA labels).

## Known open items

- Engine-level WebGPU validation warnings (`Binding size … is zero`) from
  three r185 node-material instancing: non-fatal, renders correctly, tracked
  upstream; qa-perf filters them from the fatal-error gate.
- OldFront gable shells are one-sided; players on those roofs see through the
  slopes from inside (cosmetic, queued for a cycle).
- Native 1080p60 acceptance measurements (Phase H) still to run on an idle
  reference machine.
