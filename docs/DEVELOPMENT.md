# Development Guide

## Prerequisites

- Node.js 22+
- npm 10+
- Desktop Google Chrome for headed release/browser QA (`channel: 'chrome'`)
- Playwright is installed through the repository dependencies; no bundled
  Chromium download is required for the primary QA harnesses

## Quick start

```bash
npm ci
npm run dev        # http://localhost:5173
```

## Project layout

```
src/
  core/       balance config, RNG, events, settings
  physics/    Rapier wrapper, character bodies, queries
  world/      map data model, builders, nav graph, the four maps
  sim/        fixed-timestep match simulation (headless-safe)
  ai/         perception, memory, navigation, combat, bot brains
  render/     three.js scene, materials, characters, VFX, camera
  audio/      WebAudio sample playback, ambience and original stings
  ui/         HUD, menus, minimap, results (DOM)
  player/     keyboard/mouse controller
  main.ts     boot flow & game loop wiring
tests/
  unit/         pure logic tests (fast)
  integration/  full headless match tests
  sim/          balance CLI (run-sim.ts)
  browser/      Playwright QA harnesses
docs/         ADRs, asset manifest, deep-dive docs
```

## Core concepts to know before changing things

1. **Everything gameplay-critical lives in `src/core/balance.ts`.** If you're
   adding a magic number somewhere else, you probably shouldn't be.
2. **The simulation never touches the DOM or WebGL.** `src/sim`, `src/world`
   and `src/ai` run headless in Node — this is what powers `npm run sim` and
   integration tests.
3. **Controllers produce `InputCommand`s; actors consume them.** Player and
   bots are both just controllers. Never special-case "the human" in sim code.
4. **Physics queries need a stepped pipeline.** If you add colliders at load,
   call `phys.flush()` afterwards.
5. **Events are the observation seam.** Audio/UI/VFX react to `Match.events`;
   bot hearing consumes the same events players' ears would.

## Common tasks

### Tune weapon/balance values

Edit `src/core/balance.ts`, then validate with headless matches:

```bash
npx tsx tests/sim/run-sim.ts map=neocity seed=42 difficulty=hard count=3
```

Watch avg duration (target 13–18 min), eliminations (~9), storm deaths,
chest opens. Add `SIM_VERBOSE=1` for kill timelines.

### Add map content

Maps live in `src/world/maps/*.ts` using `WorldBuilder`. Structure helpers
(`addBuilding`, stairs, walls-with-gaps) automatically register nav platforms.
After layout changes:

```bash
npx tsx tests/sim/run-sim.ts map=<yourmap> count=1   # verify bots navigate
npx tsx tests/browser/qa-maps.ts                    # verify visuals
```

### Debug a stuck bot

Development builds started with `?qa=1` expose a local QA hook
(`window.__xoState`); production builds remove it. The sim CLI prints per-bot
placements/kills/damage. Most stuck cases are nav connectivity: check that your
structure registered walkable platforms.

### Verify determinism

```bash
npx vitest run tests/integration -t "same seed"
```

Gameplay randomness flows through seeded streams (`Rng` / `gameNext()`).
Presentation-only effects may use `Math.random()`.

## Code style

- TypeScript strict mode; no `any` in game code.
- Comments explain *why*, not *what*.
- No console spam — use the event bus or the QA debug hooks.
- Keep files focused; if a module exceeds ~700 lines consider splitting.

## Pre-push checklist

```bash
npm run typecheck
npm run lint
npm run test
npm run audit:assets
npm run audit:secrets
npm run audit:licenses
npm audit --audit-level=high
npm run build
npm run cloudflare:dry-run  # deployment/configuration changes only
```

CI runs the applicable gates (see `.github/workflows/ci.yml`).
