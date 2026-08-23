# Architecture

Xo Beta is a browser-native battle royale built around one principle:
**the simulation is the game; everything else observes it.**

```
            ┌──────────────────────────────────────────────┐
            │                  Match (src/sim)             │
            │  fixed 60 Hz tick · owns all gameplay state  │
            │                                              │
  InputCommand ──► ActorController ──► movement/combat/…  │
  (player or bot)    (src/player | src/ai)                 │
            │                                              │
            │   emits MatchEvents on an EventBus           │
            └──────────┬───────────────────────────────────┘
                       │ read-only observation + events
        ┌──────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼              ▼
   src/render      src/audio       src/ui        src/ai
   three.js view   WebAudio SFX    HUD/menus     bot controllers
                   music           minimap       (produce InputCommands)
```

## Layers

### `src/core`
Engine-agnostic foundations: seeded RNG (`Rng`, plus a shared `gameNext()` stream for reproducible combat randomness), typed event bus, centralized balance configuration (`balance.ts` — every tunable number lives here), persistent settings.

### `src/physics`
Thin wrapper over **Rapier** (WASM). Static world colliders, kinematic character bodies with Rapier's `KinematicCharacterController` (autostep, snap-to-ground, slope limits), raycasts with collision-group filtering, and per-collider metadata that maps rays back to actor hit regions or destructible props.

Key detail: Rapier's query pipeline only syncs during `world.step()`. The match steps physics once per fixed tick and flushes after collider construction so queries are always valid.

Actors use soft player collision: character capsules collide with the world but pass through each other, while invisible hit-region colliders (head/chest/abdomen/arms/legs) remain hittable by projectile rays.

### `src/world`
Data-driven maps. `WorldBuilder` records primitive geometry (`GeoSpec`), walkable platform rectangles, loot/chest spawns, POIs, water volumes and lighting into a plain `MapDef`. Colliders are built from the same data (`buildColliders`) so headless simulation and the visual scene always agree.

**Navigation** (`nav.ts`): at load time the nav graph samples points across every platform rect (plus terrain sampling when a heightfield exists), validates ground height and headroom via physics queries, then connects neighbors with typed edges:

- `walk` — flat/stepped connection
- `jump` — gap crossing
- `mantle` — ledge climb within movement limits
- `drop` — controlled fall
- `swim` — water traversal

A* over this graph gives bots full multi-level navigation (interiors, stairs, roofs, underground). Disconnected islands are pruned so paths never dead-end silently.

### `src/sim`
The fixed-timestep simulation. `Match` orchestrates phases (`transport → drop → live → results`), owns actors, projectiles, loot entities, chests, storm state and elimination bookkeeping, and emits strongly-typed events.

- `movement.ts` — one shared advanced-movement state machine (ground/air/slide/wall-run/mantle/grapple/pound/swim/freefall/glide) used identically by player and bots.
- `combat.ts` — projectile pool with substepped CCD raycasts, regional damage, falloff, ricochet, glass penetration; weapon timers (ADS blend, bloom decay, recoil recovery, reload channels).
- `loot.ts` / inventory: five universal slots, stacking heals, ammo pools; chest roll tables.
- `storm.ts` — randomized non-concentric circle schedule tuned for ~15-minute matches.

Everything here runs headless in Node (no DOM/three.js imports), which powers `npm run sim` and the integration tests.

### `src/ai`
Bot brains producing the same `InputCommand` as humans:

1. **Perception** — FOV cone + LOS raycasts with exposure/distance falloff, hearing driven by *gameplay* events (shots, footsteps, chest opens), memory entries with confidence decay. Bots never read hidden transforms.
2. **Utility decisions** — scored modes (combat / loot / heal / rotate / third-party / ambush / search / wander) re-evaluated on an interval; storm urgency and loot needs dominate appropriately.
3. **Combat execution** — reaction delay, tracking-limited aim with gaussian error, projectile leading and gravity compensation, burst discipline, range-appropriate weapon switching. Elite bots (VEX/RAZOR/ORBIT) run near-maximum parameters regardless of difficulty.
4. **Navigation integration** — throttled A*, waypoint steering, traversal-edge execution, stuck detection with repath/hop recovery.
5. **Match-local adaptation** — bots track observed engagement distances/aggression of opponents and adjust caution within a session.

Difficulty tiers scale reaction/error/tracking/movement-skill for non-elite bots only.

### `src/render`
three.js presentation consuming simulation state read-only: instanced world geometry from `MapDef`, skinned GLB combatants (Quaternius rigs + Universal Animation Library clips) with procedural costume attachments and an animation state machine, first-person viewmodel composed from CC0 weapon parts with sway/bob/recoil/reload/ADS choreography, pooled VFX (tracers, flashes, sparks, shockwaves, shield-break bursts, elimination wisps, grapple ropes), shader water and storm wall, HDRI image-based lighting, camera rig with FP/TPS modes + collision, and a composer (bloom/GTAO/SMAA-FXAA/output grading).

### `src/audio`, `src/ui`, `src/player`
Recorded sample playback (CC0/CC-BY packs — see docs/ASSET_MANIFEST.md) through WebAudio spatialization: HRTF panning, distance filtering, per-surface footsteps, zone ambience beds with underwater/indoor processing. Continuous music is intentionally absent from matches; lobby/result stings only. DOM-based HUD/menus/minimap/results. Input layer translating keyboard/mouse into commands with pointer-lock handling and remappable bindings.

## Key decisions

See `docs/adr/`:

- ADR-0001: Renderer choice — Three.js over Babylon/WebGPU-first stacks
- ADR-0002: Physics choice — Rapier WASM
- ADR-003: Fully procedural asset pipeline
- ADR-0004: Simulation-first architecture & future multiplayer path

## Future multiplayer

The `InputCommand`/controller seam means a network controller could replace
the local input source without touching simulation code. No fake networking
exists today; nothing in the sim assumes single-player beyond spawn counts.
