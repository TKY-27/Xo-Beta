# Development Guide

## Prerequisites

- Node.js 20+ (22 recommended)
- npm 10+
- A desktop browser (Chrome/Edge recommended) for manual testing
- Optional: Playwright chromium for browser QA (`npx playwright install chromium`)

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

## Project layout

```
src/
  core/       balance config, RNG, events, settings
  physics/    Rapier wrapper, character bodies, queries
  world/      map data model, builders, nav graph, the three maps
  sim/        fixed-timestep match simulation (headless-safe)
  ai/         perception, memory, navigation, combat, bot brains
  render/     three.js scene, materials, characters, VFX, camera
  audio/      WebAudio synthesis engine
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

Bots log their mode via the QA hook (`window.__xoState` in a browser) and the
sim CLI prints per-bot placements/kills/damage. Most stuck cases are nav
connectivity: check that your structure registered walkable platforms.

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
npm run typecheck && npm run test && npm run build && npm run audit:licenses
```

CI runs exactly these gates (see `.github/workflows/ci.yml`).
