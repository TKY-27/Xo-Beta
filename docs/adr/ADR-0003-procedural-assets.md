# ADR-0003: Fully procedural asset pipeline

**Status:** Accepted · **Date:** 2026-08

## Decision

Every asset — geometry, textures, characters, weapons, sound, music — is
generated procedurally at runtime by code in this repository. No downloaded or
authored binary assets ship with the project.

## Rationale

- **Licensing cleanliness:** an MIT OSS release with zero third-party asset
  provenance risk. Nothing to audit, nothing to misattribute.
- **Download size:** no multi-hundred-MB art pipeline; the whole game ships as
  JS + WASM (~1 MB compressed engine code + rapier).
- **Originality:** Xo Beta has its own visual identity by construction.
- **Iteration speed:** balance/layout changes are code changes, reviewable in PRs.

## Consequences

- Visual fidelity ceiling is bounded by what procedural generation expresses;
  we invest in lighting, materials and composition rather than sculpted meshes.
- Audio is synthesized (WebAudio oscillators/noise + envelopes); weapon sounds
  are tuned per class, spatialized with HRTF panners.
- If hand-authored assets are ever introduced they MUST enter through
  `docs/ASSET_MANIFEST.md` with license provenance, and must be compatible
  with the MIT release (CC0/public-domain preferred).
