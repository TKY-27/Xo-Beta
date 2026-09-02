# Changelog

## 0.4.0 — World and Combat Fidelity Update (public beta)

New functionality:
- Sniper scopes support 1x/2x/4x angular magnification (remappable key,
  mouse wheel while scoped, LB+D-pad on gamepad) with lens-density scope
  resolution instead of a fixed ~640px target.
- Bullet impacts leave pooled, material-aware marks for ~6 s; world
  surfaces now report their real material to presentation.
- Visible per-map sky atmospheres: gradient, sun/moon disc, scrolling
  cloud layers, stars and horizon haze (NeoCity blue-hour rain, Old Front
  overcast, Eden daytime, Ashara dust) — the HDRI remains the IBL source.
- Deterministic combat-cover hardening: fully exposed combat cells drop
  from 31-39% to 19-28% per map while 30 m+ sightlines are preserved.

Refinements:
- Per-weapon recoil profiles (kick, climb, recovery, ADS/crouch, camera,
  viewmodel) shared by sim, camera and viewmodel; distance-falloff math
  pinned by boundary tables.
- Locomotion cadence calibrated and shared across host/replica; melee
  now plays the licensed jab/cross clips; guests see punches via a
  bounded meleeSwing event (hits stay host-authoritative).
- Windows vary per opening (single/dual/transom/occupied-dark) instead
  of one repeated centre-post unit; terrain gains generated micro-normal
  detail.

Collider corrections:
- Stair flights reopened across all maps (divider crossings, landing
  overlaps, planter/parapet/wall site bugs) and gain movement ramps with
  a STEP tread group; every authored flight is covered by a traversal
  harness.
- Railings gained functional guard envelopes; rocks use measured
  per-variant compound colliders instead of one oversized AABB (rocks
  now participate in the gameplay map hash; protocol version 2).

Known limitations:
- `test:browser:online:gameplay` fails its "guest sends compact input
  ticks" fixture assertion; verified pre-existing at the v0.3.0 baseline
  and outside CI. Follow-up scheduled.
- Freefall/melee limb angles and sky visuals are first-pass tuned; a
  browser visual QA pass against fixed camera positions is scheduled.
- Not universally compatible: still Chromium-first; WebKit/Playwright
  coverage remains partial. Direct-P2P only (no TURN/SFU): restrictive
  NATs may still fail to connect.


All notable changes to Xo Beta are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com); versioning is
[SemVer](https://semver.org) — until 1.0.0, minor versions may break behavior.

## [Unreleased] — next version 0.3.0 private P2P release candidate

### Added
- Friends-only private direct-P2P rooms for up to four humans, with Bot-filled
  ten-combatant matches, team battle, humans-versus-Bots, no friendly fire,
  tactical ping, and bounded guest reconnect.
- Host-authority documentation, fail-closed protocol fuzz coverage, bounded
  admission/reconnect transactions, per-peer replay/rate-state expiry, and the
  machine-readable zero-cost networking audit receipt.
- A localized hidden-host warning and bounded host-inactivity match shutdown.

### Known limitations
- There is no TURN or paid fallback; direct WebRTC connection can fail.
- Rooms exist only while the host is present. A host disconnect ends the match,
  and an untrusted host can theoretically cheat in the friends-only model.
- Browser, NAT, IPv6, long-session, and production deployment evidence remains
  environment-specific and must be recorded by the release gate.

## [0.2.0] — 2026-08 · AAA finalization & immersion pass

### Added
- Redistributed CC0 asset pipeline with full provenance tracking
  (`docs/ASSET_MANIFEST.md`, `docs/ASSET_CHECKSUMS.txt`,
  `THIRD_PARTY_NOTICES.md`): ambientCG PBR texture sets, Poly Haven HDRIs,
  Quaternius character rigs + animation library and nature kit, Kenney
  blaster/car kits, recorded sound effects (Kenney packs, OpenGameArt CC0,
  Free Firearm Sound Library gunshots).
- Skinned GLB combatants driven by the 43-clip Universal Animation Library:
  locomotion/jump/crouch/swim/death clips with speed-warped footfalls,
  upper-body aim layers (neutral/up/down), procedural costume attachments
  (helmets, chest plates, pauldrons, backpacks) per combatant identity,
  weapon attachment to the right-hand bone.
- Composed five weapon classes from CC0 blaster parts with rarity
  attachments (silencer/scope/mag) and emissive accent finishes; shared by
  viewmodel, world loot and character hands.
- HDRI image-based lighting per map (night starfield backdrop authored
  procedurally), GTAO ambient occlusion, SMAA support, display-referred
  grading pass (per-map vignette/saturation/contrast/lift), cinematic
  quality preset with 4096px shadows.
- Recorded-sample audio engine: per-weapon gunshot samples with distance
  filtering, surface-aware footsteps, material impacts, explosions, doors,
  tiered chest audio, UI set, ambience beds per map with indoor/underwater
  processing. Continuous match music removed by design; lobby pad +
  victory sting remain.
- Contextual loot panel (name/type/rarity/meta/keybind/inventory-full),
  world-projected damage numbers (normal/shield/headshot-gold/kill),
  shield-break VFX/SFX, headshot feedback tick, sound captions option.
- Tactical full-screen map: POI labels, storm circles + next-circle,
  transport route, click-to-move marker, aim-point ping (L3 / keybind).
- Gamepad support (sticks/triggers/d-pad face buttons, look sensitivity,
  deadzone, vibration) merged into the input command layer.
- Accessibility settings: damage-number toggle, color-vision palettes,
  reduced-motion mode, captions, camera-shake slider; English + complete
  Japanese localization across menus/HUD/settings/results via `src/core/i18n`.
- 3D lobby: hangar scene with the selected combatant under studio lighting
  behind the menu stack; premium chamfered glass UI design system.

### Changed
- All three maps received environment passes: dense lit-window grids,
  street furniture (lanterns/lamps with pooled virtual lights), road
  markings/crosswalks/manholes, hanging cables, neon blade signs, rooftop
  clutter, banners, dirt/concrete paths linking POIs, market stalls,
  gravestones, dock/farm/camp dressing, solar arrays and facility conduits.
- World materials rebuilt on real PBR sets with world-space projection
  (no instance stretching); vegetation/rocks now instanced GLB models;
  vehicles use Kenney Car Kit with tinted liveries.
- Water upgraded to a shader surface (fresnel sky reflection, sun glint,
  sparkle bands) plus underwater master-bus low-pass muffle.
- Lighting pools: static lights are virtualized (22-slot nearest pool) to
  keep fragment cost constant on night maps.

### Removed
- Continuous in-match music layers (explore/combat/final) — replaced by
  location-reactive soundscapes per design brief.
- Unverifiable-provenance gunshot samples — replaced with recorded shots from
  the CC0 Free Firearm Sound Library (see `docs/ASSET_MANIFEST.md`).
- Unused duplicate assets: `models/ual_standard.glb` (canonical copy lives in
  `models/characters/`) and loose `models/vehicles/colormap.png` (the GLBs
  reference `Textures/colormap.png`); unused candidate texture sets
  (`facadeB`, `facadeC`, `metalFloor`). The final production-asset sweep also
  removed 147 unreferenced audio/model pack members while preserving every
  runtime file and shared GLB dependency recorded by the checksum audit.

### Security
- Strict Content-Security-Policy in production headers; debug introspection
  hooks (`__xoState`, `?qa=1` teleport) are now dev-build only; kill feed
  builds DOM via text APIs instead of HTML strings; CI gained a secret-scan
  step and ESLint.

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
