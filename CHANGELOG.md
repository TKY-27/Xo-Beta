# Changelog

All notable changes to Xo Beta are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com); versioning is
[SemVer](https://semver.org) — until 1.0.0, minor versions may break behavior.

## [0.1.0] — 2026-08

Initial release.

### Added
- Complete single-player battle royale: transport → drop → loot → storm →
  winner, with spectator mode and results screen.
- Three arenas: NEO CITY, OLD FRONT, EDEN FACILITY (with swimming/diving).
- Five weapon classes × five rarities; real projectile simulation with drop,
  falloff, ricochet, glass penetration, per-pellet shotgun spread.
- Advanced movement: sprint/slide/double-jump/dash/wall-run/wall-jump/mantle/
  grapple/ground-pound/bunny-hop/swim — shared by player and bots.
- Nine personality-driven bots with fair perception-based AI, multi-level
  navigation (jump/mantle/drop/swim links), match-local adaptation; VEX /
  RAZOR / ORBIT elite benchmark trio; Normal→Nightmare difficulties.
- Loot economy: floor loot, standard/elite/vault chests, Med Kit & Shield
  Cell, five universal slots, four ammo pools.
- Storm: eight randomized shrinking phases tuned for ~15-minute matches.
- Presentation: PBR materials, per-map lighting presets (night/overcast/day),
  bloom pipeline, procedural characters & animation, first-person viewmodel,
  pooled VFX, stylized elimination dissolve, kill feed, minimap, HUD.
- Procedural WebAudio: spatialized weapon/foley/UI sounds, ambience beds,
  adaptive music states, victory/defeat stingers.
- Settings: controls remapping, sensitivity, FOV, graphics quality presets,
  audio mixer, gameplay options — all persisted.
- Engineering: fixed-timestep headless-safe simulation, deterministic seeded
  matches, unit + integration test suites, bot-only balance simulation CLI,
  Playwright browser QA harness, Cloudflare Workers Static Assets deployment.
