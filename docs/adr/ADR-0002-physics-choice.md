# ADR-0002: Physics — Rapier WASM

**Status:** Accepted · **Date:** 2026-08

## Decision

Use **@dimforge/rapier3d-compat** for colliders, queries and character
movement. Projectiles do not use rigid bodies; they integrate analytically and
query swept raycasts each substep (robust CCD with full hit-region control).

## Rationale

- Rapier's KinematicCharacterController provides autostep, snap-to-ground,
  slope limits and slide handling that would be months of edge-case work to
  reimplement against box worlds with stairs.
- WASM runs identically in browser and Node, enabling headless bot simulations
  and integration tests without a display.
- Deterministic-enough stepping for our fixed 60 Hz tick.

## Notes / gotchas discovered during development

- The query pipeline syncs only during world.step(); we flush after collider
  construction and step once per fixed tick.
- Collision groups give us soft player collision (actors pass through actors)
  while keeping actor hit volumes hittable by projectile rays via ray filters.
- Heightfield scale parameter is the TOTAL extent of the grid, not per-cell
  spacing; heights must be provided column-major.
