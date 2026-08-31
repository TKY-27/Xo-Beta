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
- **character/world penetration**: every standing or swimming navigation node
  on all production maps fits the real capsule; building doors and stair paths,
  long-idle support, mantle blockers, swim exits and glide landings exercise the
  same Rapier/KCC paths used by matches

They are the primary regression net for gameplay and physics integration.

## 3. Headless balance simulations (`tests/sim/run-sim.ts`)

```bash
npx tsx tests/sim/run-sim.ts map=neocity seed=42 difficulty=hard count=3
```

Prints per-match results plus aggregates: duration vs target window, kill
distribution, storm deaths, chest opens, pickups. `SIM_VERBOSE=1` adds
kill timelines. Used to validate balance/AI changes before merging.

## 4. Browser QA (`tests/browser/qa-maps.ts`)

Playwright drives system Chrome through menu → match start → transport → jump →
landing → real movement on all four maps (NEO CITY, OLD FRONT, EDEN FACILITY
and ASHARA REACH). Headed mode uses Ultra settings; `HEADLESS=1` is diagnostic
only. The harness fails closed on HUD/phase/landing/movement/collision/world
composition/runtime-console state and captures screenshots for visual review.

```bash
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

## Phase 5 release matrix

The release gate keeps evidence classes separate. A local unit or simulated
run does not prove a real browser, external-network, deployment, signing, or
production result.

### Required local checks

```bash
npm ci
npm run lint
npm run typecheck
npm run audit:assets
npm run audit:secrets
npm run audit:licenses
npm audit --audit-level=high
npm test
npx vitest run tests/unit/net-fuzz.test.ts
npm run build
npm run sim
npm run cloudflare:dry-run
npm run audit:zero-cost
```

`npm run audit:zero-cost` must produce
`dist/zero-cost-networking-audit.json` for the exact tested commit. It scans
source, configuration, lockfile metadata, the production bundle, and generated
Wrangler output; documentation mentions of unsupported TURN are allowed.

### Browser, network, mode, and lifecycle matrix

| Dimension | Required cases | Evidence rule |
| --- | --- | --- |
| Browser | Chrome, Edge, Firefox; Safari manual smoke | Record each browser separately; Chromium-only results do not cover the others |
| Human count | 2, 3, 4; fifth participant rejected | Use the online lobby harness and record capacity/rejection |
| Mode | FFA Bots off/on, 1v1, 2v1, 2v2, 5v5 Bots, four humans vs six Bots | 1v1/2v1/2v2 are team configurations; each result must identify the exact roster |
| Network | same machine, LAN, separate networks, Wi-Fi↔hotspot, IPv4, IPv6 where available, direct UDP, bounded direct-failure | No universal NAT claim; unavailable paths remain explicitly unverified |
| Lifecycle | create/link/code/join, ready invalidation, start, deployment, glass/combat, leave/rejoin alive/dead/expiry, host disconnect, result/menu, second room, repeated matches | Capture cleanup/resource evidence after every lifecycle series |
| Visibility | hidden tab, visibility restore, blur, minimized window where available | Hidden host warning and bounded host-inactive termination must be observed |
| Performance | host and guest p50/p95/p99/worst frame, simulation/presentation/encode/decode, bytes/RTT/jitter/loss, queue/heap/resource/draw metrics | State the device, browser, map, mode, human count, and duration for every sample |

The deterministic browser scripts are:

```bash
npm run test:browser:online
npm run test:browser:online:gameplay
```

They mock only the public signaling hub and use real browser WebRTC/DataChannel
objects. They are not evidence for separate networks, carrier NAT, IPv6, or
paid-service behavior. Browser and network cases that cannot be run on the
test machine must be reported as unavailable rather than passed. Direct
failure must stop after the bounded attempt, show the localized limitation,
and leave no active connections or timers.

The Phase 5 performance budget is intentionally device-bound. The current
reference device is an Apple M5 (`arm64`, macOS 26.5.1, 25.7 GB RAM), with
headed Chrome at 1600x900, Ultra quality, native resolution, and one 10-second
steady-state sample per production map. These are release thresholds for this
reference configuration, not universal browser or hardware promises.

| Metric | Reference-device release budget | Current evidence / rationale |
| --- | --- | --- |
| Frame p95 / p99 / worst | <=33 ms / <=50 ms / <=250 ms | The latest four-map steady headed sample reached at most 17.2 / 18.9 / 65.1 ms; the 33 ms target preserves a 30 FPS floor while the tail bounds expose stalls. |
| Host simulation step | p95 <=4 ms at 60 Hz | Matches the authoritative snapshot-rate tuning gate and leaves most of a 16.7 ms tick for presentation and browser work. |
| Presentation step | p95 <=8 ms | Leaves headroom inside one 60 Hz frame after simulation; the attribution sample reported 4.29 ms on Eden. |
| Snapshot / input payload | snapshot p95 <=16 KiB; input payload <=128 B | 16 KiB is the protocol snapshot budget; input is the explicit `MAX_INPUT_PAYLOAD_BYTES` contract. The latest two-context online sample had 2,124 B snapshot p95. |
| Host upload | <=64 KiB/s per guest and <=192 KiB/s for three guests | Bounds the maximum four-human room without a relay or server; actual bytes must be measured over a steady online run. |
| RTT / jitter / loss | record p95; target <=250 ms / <=50 ms / <=5% | These are operational impairment thresholds for the reference run, not a NAT-compatibility promise. |
| DataChannel buffered amount | lossy <=64 KiB; reliable <=256 KiB | Matches the transport back-pressure constants; sends are rejected when the bound would be exceeded. |
| Reliable/control backlog | <=64 reliable events per peer and <=64 pending control packets | Matches the finite queue limits; overflow disconnects or fails closed rather than growing memory. |
| Heap and resources after disposal | no monotonic increase across three matches; post-dispose values within 10% of baseline after GC opportunity | A browser heap/resource trace is required; static disposal code is not a substitute for a long-session measurement. |
| Glass, lights, geometry | no draw-call-per-window regression; active lights <=8; per-map triangles/draws <=110% of the reference baseline | Preserves instancing and the map-specific visual budget; geometry is compared per map rather than using a misleading global number. |

The release receipt must include the measured host and guest p50/p95/p99
frame, simulation, presentation, encode/decode, snapshot, input, throughput,
RTT/jitter/loss, prediction, queue, heap, resource, glass, light, and triangle
values, plus the exact browser, map, mode, human count, and duration. A missing
measurement is an unmet release gate. The repository does not claim a universal
frame rate, latency, NAT compatibility, or memory ceiling from static analysis.
