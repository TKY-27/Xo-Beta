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
- **world/character contact** — capsule feet-space invariants, settling,
  terrain support, structures, stairs, chests and map placement bounds.
- **storm/loot/movement/VFX/localization** — schedule and distribution rules,
  short-tap input latency, finite effect state and EN/JA coverage.

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

They are the primary regression net for gameplay and physics integration.

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

1. lint + typecheck
2. secret, dependency, asset and license audits
3. complete unit + integration test suite
4. production build and `dist/` release audit
5. Cloudflare Wrangler dry-run (no deployment)

Browser QA runs manually/release-time (Playwright browsers aren't installed in
the base CI image by default).
