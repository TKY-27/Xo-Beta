# ADR-0006: Authored presentation-first asset pipeline

**Status:** Accepted · **Date:** 2026-09
**Supersedes:** [ADR-0003](ADR-0003-procedural-assets.md)

## Decision

Code-generated presentation is an implementation option, not a project value.
Visible hero weapons, hands, character costume components, environment modules,
and major props must use authored meshes when a permissively licensed asset is
available and passes a quality, provenance, and performance review. Procedural
techniques remain appropriate for terrain distribution, weather, decals,
particles, runtime destruction, animation layering, collision generation, and
LOD distribution.

The deterministic simulation boundary remains unchanged. `MapDef`, `GeoSpec`,
collision, navigation, cover metadata, and gameplay IDs remain data contracts;
visual meshes, material variants, and prefab instances are a parallel render
layer. Collision proxies must not dictate visible geometry.

## Asset intake

Every external production asset must be:

- downloaded from the canonical source, not an unverified mirror;
- locally stored under `public/assets/`;
- checked for author, original URL, exact license, redistribution rights, and
  modification history;
- recorded in `docs/ASSET_MANIFEST.md`, `THIRD_PARTY_NOTICES.md`, and
  `docs/ASSET_CHECKSUMS.txt`;
- inspected for technical validity, scale, material response, topology, and
  normal first-person or gameplay-range appearance;
- free of runtime CDN dependencies.

CC0, CC-BY, and other permitted licenses may be retained when their obligations
are compatible with the repository. Unclear provenance, noncommercial terms,
incompatible share-alike terms, and proprietary extracted game assets are
excluded. A permissive license does not waive the visual quality gate.

## Delivery architecture

GLB/glTF is the baseline authored visual format. The runtime loader converts
standard materials to the WebGPU node-material path, preserves named movable
nodes and attachment sockets, and supports lazy per-map loading, prefetching,
LODs, instancing, and explicit lifecycle disposal. Render meshes, collision
proxies, navigation, and gameplay metadata are separate fields. Compression is
introduced only after measuring its visual and runtime tradeoff.

## Consequences

- Existing primitive hero builders may be replaced without rewriting the
  simulation, networking, or renderer facade.
- A failed asset load may use a debug or clearly reported non-production
  fallback, but production must not silently present a primitive hero as final.
- Quality, license, and performance gates are independent. Passing tests or
  provenance checks cannot substitute for fresh visual evidence.
- The old relative-improvement gates and score inflation rules are invalid for
  this campaign.
