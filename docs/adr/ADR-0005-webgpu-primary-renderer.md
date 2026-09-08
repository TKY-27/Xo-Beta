# ADR-0005: WebGPU-primary renderer with WebGL2 fallback

**Status:** Accepted · **Date:** 2026-09 (WebGPU AAA Overhaul campaign)
**Supersedes:** [ADR-0001](ADR-0001-renderer-choice.md) (renderer *backend* choice; Three.js and the GameRenderer facade stand)

## Context

The overhaul campaign required Bodycam-class physical realism and
Apex/Fortnite-class combat readability at a native 1080p@60 floor. ADR-0001
anticipated a WebGPU migration localized to `src/render/renderer.ts` once
three.js's WebGPU support matured.

## Decision

Render with **`WebGPURenderer` (WebGPU backend) as the primary path**, with
the automatic **WebGL2 fallback** retained (`QA_FORCE_WEBGL=1` exercises it;
Chrome without WebGPU uses it silently). The TSL node material system is used
for all custom shading (`ProjectedStandardMaterial` triplanar ground family,
sky, water, scope optics); plain materials auto-convert to node materials.

## What the migration actually involved (evidence: docs/QA_STATE.md)

- `GameRenderer` facade held: the swap touched renderer setup, post chain
  (TSL `bloom`/`smaa`/`fxaa` instead of EffectComposer passes) and one
  dynamic-near-plane mechanism.
- All instanced world props must use **node materials**: plain
  `MeshStandardMaterial` on `InstancedMesh` loses ambient/hemisphere/env fill
  on WebGPU (`props.ts toNodeStandard` converts every GLB material at ingest).
- r185 defect class 1 — a stochastic instanced-binding fault renders some
  instanced draws void-black with healthy material data; vehicles moved to
  one non-instanced clone each (≤9/map), rust keeps a flat fallback material.
- r185 defect class 2 — the node pipeline zeroes ALL direct lighting for a
  standard material whose **normalMap/bumpMap is combined with any other
  map**. Found via pixel-readback A/B; terrain/prop/rock normal maps were
  dropped (generators retained for the three.js upgrade that fixes the node
  normal path).
- GTAO is disabled: upstream r185 `GTAONode` returns ~0 occlusion on WebGPU.
- WebGPU device loss is observed (`GameRenderer.watchDeviceLoss`) and
  recovers via one guarded automatic reload.

## Consequences

- WebGPU delivers the headroom for the current scene complexity (4 maps,
  22–41k draw calls/frame, 3–5 M triangles) at the 60 fps floor.
- The WebGL2 fallback shares the node pipeline, so visual parity is the
  default; the fallback remains a safety net, not a maintained target.
- Upgrades of three.js must re-audit the normalMap+map combination and the
  instancing fault family (see QA_STATE "Known open items").
