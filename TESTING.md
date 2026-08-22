# Testing

Xo Beta's test pyramid runs entirely in CI:

## 1. Unit tests (`tests/unit`, vitest)

Pure logic, no physics needed — run in milliseconds:

- **balance** — weapon stats match the design baseline (pistol 26→38, shotgun
  pellet totals, sniper one-shot rules at epic+ only, fire modes, rarity
  modifier monotonicity, storm schedule windows, movement config sanity).
- **damage** — shield-first absorption, overflow, regional multipliers,
  death boundaries, healing caps.
- **inventory** — five universal slots (five weapons / five heal stacks),
  stacking caps, ammo pools & reload math, selection/cycling.
- **storm-loot** — circle progression to near-zero, geometric damage checks,
  loot rarity distribution vs configured weights, chest tier band guarantees.

```bash
npm run test            # or: npx vitest run tests/unit
```

## 2. Integration tests (`tests/integration`)

Full headless matches through the real simulation + Rapier + nav graph:

- match completes with exactly one winner and a full placement permutation
- bots naturally loot (pickups > threshold), open chests, fight (9-ish
  eliminations)
- storm pressure produces storm kills across a seed sample
- **determinism**: the same seed twice produces identical elimination counts,
  headshots and pickups within a capped window
- combatant count is exactly ten

These take ~40s total. They are the primary regression net for gameplay.

## 3. Headless balance simulations (`tests/sim/run-sim.ts`)

```bash
npx tsx tests/sim/run-sim.ts map=neocity seed=42 difficulty=hard count=3
```

Prints per-match results plus aggregates: duration vs target window, kill
distribution, storm deaths, chest opens, pickups. `SIM_VERBOSE=1` adds
kill timelines. Used to validate balance/AI changes before merging.

## 4. Browser QA (`tests/browser/qa-maps.ts`)

Playwright drives the real dev server through menu → match start → transport →
jump → landing on all three maps with low graphics settings (headless GPU is
slow), asserting HUD appearance, landing state, storm timers and zero console
errors; captures screenshots for visual review.

```bash
npx playwright install chromium   # once
npx tsx tests/browser/qa-maps.ts
```

Screenshots land in `qa/`. Inspect them after any rendering/lighting change.

## CI gates (`.github/workflows/ci.yml`)

1. typecheck (`tsc --noEmit`)
2. unit + integration tests
3. production build
4. dependency license policy audit

Browser QA runs manually/release-time (Playwright browsers aren't installed in
the base CI image by default).
