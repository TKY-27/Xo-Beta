# ADR-0004: Simulation-first architecture

**Status:** Accepted · **Date:** 2026-08

## Decision

The fixed-timestep Match simulation owns all gameplay state and never imports
DOM/three/WebAudio. Controllers (human input or bot AI) produce InputCommand
structs consumed by the sim. Rendering/audio/UI subscribe to a typed event bus
and read state after ticks.

## Rationale

- Bots play under exactly the same rules as the player (fairness requirement).
- Headless bot-only matches run in Node for CI tests and balance tuning
  (`npm run sim`), which drove storm pacing, loot density and AI tuning.
- Future multiplayer: a network controller can replace the local input source
  without touching simulation internals.

## Consequences

- Presentation interpolates between fixed states; no gameplay logic may live
  in render/UI layers.
- All tunables centralize in `src/core/balance.ts` so sims and live play stay
  consistent.
