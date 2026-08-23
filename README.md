# Xo Beta

**A browser-native single-player 3D battle royale. Ten combatants drop onto a dense arena — one human, nine autonomous bots — and the last one standing wins.**

Xo Beta runs entirely client-side in desktop browsers. No plugins, no installs, no gameplay servers. Presentation combines original code-generated systems with redistributed CC0 (public-domain) art and audio packs — see [docs/ASSET_MANIFEST.md](docs/ASSET_MANIFEST.md) for full provenance.

---

## Features

- **Complete match loop** — transport flyover → free jump → glide → landing → looting → shrinking storm → final circle → results screen.
- **Three handcrafted arenas** — *NEO CITY* (neon metropolis at night), *OLD FRONT* (overcast historical town with a cathedral landmark), *EDEN FACILITY* (lakeside research station in daylight).
- **Advanced movement** — sprint, crouch, slide, double jump, ground & air dash, wall run, wall jump, mantle, grappling hook, ground pound, bunny-hop momentum, swimming and diving. Bots use the same movement systems.
- **Five weapon classes** — pistol (semi), SMG (auto), AR (auto), shotgun (pump), sniper (bolt) — each across five rarity tiers, with real projectile simulation: travel time, gravity drop, falloff, ricochets and per-pellet shotgun spread.
- **Fair AI opponents** — nine named bots with distinct personalities (VEX, RAZOR, ORBIT form the elite benchmark trio). Perception through vision cones + line of sight + gameplay sound events only — no wallhacks, no omniscience. They loot, heal, rotate, third-party fights and use advanced traversal.
- **Full loot economy** — floor loot, three chest tiers (standard / elite / vault), med kits and shield cells, five universal inventory slots, ammo pools.
- **Polished presentation** — PBR materials, dynamic lighting per map preset, bloom post-processing, tracers/muzzle flashes/impacts/debris, stylized no-gore elimination effects, spatialized procedural audio and adaptive music.

## Controls (default, remappable)

| Action | Key |
| --- | --- |
| Move | `W A S D` |
| Look / Fire / ADS | Mouse / LMB / RMB |
| Jump / Double jump | `Space` |
| Sprint | `L-Shift` |
| Crouch / Slide | `L-Ctrl` |
| Dash | `Q` |
| Grapple | `F` |
| Ground pound | `C` |
| Interact | `E` |
| Reload | `R` |
| Inventory slots | `1–5` |
| Drop weapon | `X` |
| Med Kit / Shield Cell | `G` / `H` |
| FP/TPS camera | `V` |
| Full map info / Spectate switch | `M` / `←` `→` |

## Supported browsers

Chrome and Edge (recommended), Safari 16+. A desktop browser with keyboard and mouse is required — touch devices see a friendly notice.

## Development

```bash
npm install
npm run dev          # vite dev server at http://localhost:5173
```

```bash
npm run build        # typecheck + production build to dist/
npm run preview      # serve the production build locally
npm run test         # unit + integration tests (vitest)
npm run sim -- map=neocity difficulty=hard count=3   # headless bot matches
npm run audit:licenses               # dependency license policy check
npx tsx tests/browser/qa-maps.ts     # automated browser QA (Playwright)
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture orientation and
[TESTING.md](TESTING.md) for the full test strategy.

## Deploying to Cloudflare

The production build is a static bundle served by a Cloudflare Worker using
[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/):

```bash
npm run build
npx wrangler deploy      # uses wrangler.jsonc
```

Details in [DEPLOYMENT.md](DEPLOYMENT.md).

## Architecture summary

Simulation-first design: a fixed-timestep match simulation (`src/sim`) is fully
decoupled from rendering (`src/render`), audio (`src/audio`), UI (`src/ui`) and
input (`src/player`). Controllers — human or bot (`src/ai`) — both produce an
`InputCommand`, so bots play by exactly the same rules as the player and future
network controllers could slot in without rewriting the game. Physics is Rapier
(WASM); navigation is a generated multi-level nav graph with jump/mantle/drop/swim
links; all content is data-driven from map definitions. See
[ARCHITECTURE.md](ARCHITECTURE.md), [BOT_AI.md](BOT_AI.md),
[GAME_DESIGN.md](GAME_DESIGN.md).

## License & assets

Code is released under the [MIT License](LICENSE). The presentation layer
combines original code-generated systems (VFX, water, storm, UI, character
costumes/assembly) with redistributed third-party art and audio packs under
CC0 / Public Domain terms. Full provenance, per-asset licenses,
acquisition dates and SHA-256 checksums are tracked in
[docs/ASSET_MANIFEST.md](docs/ASSET_MANIFEST.md),
[docs/ASSET_CHECKSUMS.txt](docs/ASSET_CHECKSUMS.txt) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Nothing is fetched from
runtime CDNs; all assets ship with the build.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
