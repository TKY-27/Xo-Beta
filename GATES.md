# Gates: generation-level rebuild

**Status:** active · **Started:** 2026-09
**Supersedes:** the relative-improvement gates in the previous campaign

Historical QA records are context, not acceptance evidence. A candidate is not
complete because it is stable, fast, artifact-free, better than baseline, or has
passed tests. Every gate below requires fresh running-build evidence and an
independent critic who did not implement the reviewed area.

## Hard completion gates

- [ ] G1 Environment geometry / asset fidelity >= 9.0/10 on every map, with no dominant blockout or primitive-built impression.
- [ ] G2 Materials and surface detail >= 8.5/10 with physically plausible PBR, texture scale, normals, roughness, and material separation.
- [ ] G3 Lighting, shadows, atmosphere, and grounding >= 8.5/10 without using bloom, contrast, or saturation to hide geometry.
- [ ] G4 Terrain, foliage, and world grounding >= 8.5/10 with believable transitions and density.
- [ ] G5 Characters and animation >= 8.5/10 with authored visible costume geometry and readable silhouettes.
- [ ] G6 First-person weapon quality >= 9.0/10 for all five classes at hip, ADS, firing, reload, sprint, and inspect.
- [ ] G7 Hands, arms, and reload animation >= 9.0/10 with credible anatomy, grip, contact, and weapon-specific choreography.
- [ ] G8 VFX and audiovisual feedback >= 8.5/10; effects do not read as cubes, strips, cards, or debug geometry.
- [ ] G9 Input and aiming responsiveness >= 9.0/10 at 60 Hz and 120 Hz, with authoritative simulation consistency.
- [ ] G10 Movement feel >= 8.5/10, supported by recorded movement traces.
- [ ] G11 Combat readability >= 9.0/10 under the new environment, weather, VFX, and lighting.
- [ ] G12 HUD and UX >= 8.5/10, including accessibility and clear interaction language.
- [ ] G13 Visual consistency and art direction >= 8.5/10 across all four maps.
- [ ] G14 Performance and frame pacing >= 8.5/10 with fixed 1920x1080 evidence and no uncontrolled growth.
- [ ] G15 Stability and multiplayer correctness >= 8.5/10 in offline, host, and guest checks.
- [ ] G16 Asset provenance and licensing >= 8.5/10 with independently verified source, license, notices, and hashes.

## Non-negotiable findings

- [ ] No unresolved P0 or P1 defect.
- [ ] No reviewer identifies a remaining dominant low-poly, procedural-demo, primitive-built, toy, clay, floating, blockout, or AI-slop ceiling.
- [ ] Blind matched A/B reviews consistently favor the candidate for geometry, materials, depth, scale, animation, grounding, readability, and art direction—not post-processing alone.
- [ ] Two consecutive fresh full-review rounds have no new P0/P1 findings.
- [ ] Weighted overall score is >= 9.0/10 and no category is < 8.5/10.

## Evidence protocol

Every review records the exact commit/build, map, seed, resolution, capture
paths, input trace, performance environment, and reviewer independence. Previous
scores, test counts, and implementation effort never satisfy a gate. The active
root-cause record is `docs/REBUILD_ROOT_CAUSE_MATRIX.md`; the asset policy is
`docs/adr/ADR-0006-authored-presentation-first-assets.md`.
