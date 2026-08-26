# ADR-0003: Original and redistributed asset pipeline

**Status:** Accepted (supersedes the original fully procedural decision) · **Date:** 2026-08

## Decision

Keep simulation, VFX, water, storm, UI and character costume assembly original
and code-generated. Redistribute selected third-party presentation assets only
when their source, license, local path and checksum are documented in
`docs/ASSET_MANIFEST.md`, `docs/ASSET_CHECKSUMS.txt` and
`THIRD_PARTY_NOTICES.md`.

## Rationale

- **Provenance:** every redistributed file has an independently reviewable
  source and checksum; files with ambiguous rights are excluded.
- **Scope:** only runtime-referenced production subsets ship, limiting download
  size and avoiding unused pack contents.
- **Originality:** gameplay and the defining presentation systems remain
  project-owned code.
- **Redistribution:** third-party assets retain their own CC0, Public Domain or
  SIL OFL terms instead of being represented as MIT-licensed project code.

## Consequences

- Asset additions must update the manifest, checksum inventory and notices.
- `npm run audit:assets` fails when the production asset set and checksum
  inventory diverge.
- Runtime CDN loading remains prohibited; the build is self-contained.
- The repository MIT license applies to original code and assets only;
  redistributed files keep their documented licenses.
