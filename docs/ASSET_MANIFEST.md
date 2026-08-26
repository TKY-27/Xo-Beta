# Asset Manifest

**Policy:** Xo Beta combines original code-generated assets (repository MIT
license) with redistributed third-party assets under permissive licenses —
CC0 / Public Domain for art and audio, and SIL OFL 1.1 for fonts. All
redistributed files live under `public/assets/`; nothing loads from runtime
CDNs. SHA-256 checksums for every redistributed production file are listed in
`ASSET_CHECKSUMS.txt`.

| Asset class | Local path | Source / author | License | Acquired | Modifications |
| --- | --- | --- | --- | --- | --- |
| HDRI skies (kloofendal_overcast_puresky, qwantani_puresky) | public/assets/sky/*.hdr | polyhaven.com — Poly Haven team | CC0 1.0 | 2026-08-22 | none. (dikhololo_night removed 2026-08-24 — NEO CITY now uses a procedural blue-hour sky rendered at runtime, original code) |
| PBR texture sets x21 (asphalt, bricksOld, concrete, concreteDark, corrugated, dirt, facadeA, facilityFloor, grass, marble, metal, metalDark, plaster, plasterOld, rock, roofTile, rust, sidewalk, stoneBrick, wood, woodDark) | public/assets/textures/<set>/{color,normal,rough}.jpg | ambientcg.com — Lennart Demets / ambientCG contributors | CC0 1.0 | 2026-08-22 | renamed + re-encoded Color/NormalGL/Roughness maps to color.jpg/normal.jpg/rough.jpg; no pixel edits |
| Combat rig animations (43 clips) | public/assets/models/characters/ual_standard.glb | quaternius.com Universal Animation Library — Quaternius | CC0 1.0 | 2026-08-22 | none |
| Character bodies (Superhero male/female) + hair/skin textures | public/assets/models/characters/hero_*.{gltf,bin}, T_*.png | quaternius.com Universal Base Characters (Standard) — Quaternius | CC0 1.0 | 2026-08-22 | glTF buffer URIs + two broken texture URIs repaired to point at shipped files; costume pieces attached procedurally at runtime (original code) |
| Runtime nature subset: 5 broadleaf trees, 4 pines, 3 dead trees, 2 bushes, fern, clover, flower group and 2 rocks, including referenced buffers/textures | public/assets/models/nature/* | quaternius.com Stylized Nature MegaKit (Standard subset) — Quaternius | CC0 1.0 | 2026-08-22 | instance transforms applied at runtime; unused pack members excluded from the repository |
| Runtime blaster subset: blaster-a/d/e/f/p, scope-large-a, silencer-small, clip-large/small + shared colormap | public/assets/models/weapons/* | kenney.nl Blaster Kit — Kenney NL | CC0 1.0 | 2026-08-22 | composed per weapon class with procedural attachments/materials; unused parts excluded |
| Runtime vehicle subset: sedan, SUV, van, truck, taxi, police, delivery-flat, hatchback-sports, race-future + shared colormap | public/assets/models/vehicles/* | kenney.nl Car Kit — Kenney NL | CC0 1.0 | 2026-08-22 | per-instance tint materials; unused variants and standalone wheel models excluded |
| Runtime footsteps + material impacts + UI/mech/explosion/laser SFX subset | public/assets/audio/{steps,impacts,ui,mech,explosions,lasers}/*.wav | kenney.nl Impact Sounds, Interface Sounds, UI Audio, Sci-Fi Sounds — Kenney NL | CC0 1.0 | 2026-08-22 | selected OGG sources decoded to WAV PCM 16-bit 44.1 kHz (no DSP); only samples referenced by the audio manifest are retained |
| Pistol / SMG / AR / shotgun / sniper gunshots (9 files) | public/assets/audio/guns/{pistol_a,pistol_b,pistol_c,smg_a,smg_b,ar_a,ar_b,shotgun_a,sniper_a}.wav | opengameart.org/content/the-free-firearm-sound-library — The Free Firearm Sound Library team (Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney) | CC0 1.0 | 2026-08-23 | trimmed from near-distance single-shot recordings (Walther PPQ / Colt 1911 / Bersa .380 / Carl Gustav M45 / PPSh / AR-15 / AK-47 / Benelli Nova / Mosin Nagant), resampled 96 kHz/24-bit -> 44.1 kHz/16-bit PCM, peak-normalized to -6 dBFS, short fades applied |
| Water splashes (2) | public/assets/audio/water/{splash_05,splash_11}.wav | opengameart.org "40 CC0 water / splash / slime SFX" — rubberduck | CC0 1.0 | 2026-08-22 | OGG -> WAV; unused variants excluded |
| Chest opening | public/assets/audio/chest/openchest.wav | opengameart.org/content/open-chest-sfx — Oiboo | CC0 1.0 | 2026-08-22 | loudness-normalized |
| Ambience beds: birds_loop, wind_loop, river_loop | public/assets/audio/ambience/*.wav | opengameart.org/content/park-ambiences + ambient-bird-sounds — Thimras (wind/river), isaiah658 (birds) | CC0 1.0 | 2026-08-22 | excerpted into loopable segments, mono 32 kHz WAV |
| City ambience bed: city_loop | public/assets/audio/ambience/city_loop.wav | opengameart.org "Scifi City - Ambient Loop" — TinyWorlds | CC0 1.0 | 2026-08-22 | mono 32 kHz WAV |
| UI fonts: Saira Condensed, Inter Tight, Noto Sans JP | public/assets/fonts/*.{woff2,txt} | Saira Project Authors; Inter Project Authors; Adobe/Source Han Sans contributors | SIL Open Font License 1.1 | 2026-08-24 | web subsets/WOFF2 files are shipped with each font's original OFL notice |

## Source URLs

These are the exact upstream pages used to verify the retained production
assets. ambientCG directory names are local aliases; the source asset ID for
each alias is recorded here so the files can be independently re-audited.

- Poly Haven HDRIs:
  [kloofendal_overcast_puresky](https://polyhaven.com/a/kloofendal_overcast_puresky),
  [qwantani_puresky](https://polyhaven.com/a/qwantani_puresky)
- ambientCG PBR sets:
  `asphalt` = [Asphalt012](https://ambientcg.com/view?id=Asphalt012),
  `bricksOld` = [Bricks054](https://ambientcg.com/view?id=Bricks054),
  `concrete` = [Concrete034](https://ambientcg.com/view?id=Concrete034),
  `concreteDark` = [Concrete016](https://ambientcg.com/view?id=Concrete016),
  `corrugated` = [CorrugatedSteel009](https://ambientcg.com/view?id=CorrugatedSteel009),
  `dirt` = [Ground047](https://ambientcg.com/view?id=Ground047),
  `facadeA` = [Concrete030](https://ambientcg.com/view?id=Concrete030),
  `facilityFloor` = [Tiles053](https://ambientcg.com/view?id=Tiles053),
  `grass` = [Grass001](https://ambientcg.com/view?id=Grass001),
  `marble` = [Marble014](https://ambientcg.com/view?id=Marble014),
  `metal` = [Metal052B](https://ambientcg.com/view?id=Metal052B),
  `metalDark` = [Metal049A](https://ambientcg.com/view?id=Metal049A),
  `plaster` = [Plaster001](https://ambientcg.com/view?id=Plaster001),
  `plasterOld` = [Plaster007](https://ambientcg.com/view?id=Plaster007),
  `rock` = [Rock034](https://ambientcg.com/view?id=Rock034),
  `roofTile` = [RoofingTiles009](https://ambientcg.com/view?id=RoofingTiles009),
  `rust` = [Rust005](https://ambientcg.com/view?id=Rust005),
  `sidewalk` = [PavingStones070](https://ambientcg.com/view?id=PavingStones070),
  `stoneBrick` = [Bricks063](https://ambientcg.com/view?id=Bricks063),
  `wood` = [Planks009](https://ambientcg.com/view?id=Planks009),
  `woodDark` = [Wood052](https://ambientcg.com/view?id=Wood052)
- Quaternius:
  [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html),
  [Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html),
  [Stylized Nature MegaKit](https://quaternius.com/packs/stylizednaturemegakit.html)
- Kenney:
  [Blaster Kit](https://kenney.nl/assets/blaster-kit),
  [Car Kit](https://kenney.nl/assets/car-kit),
  [Impact Sounds](https://kenney.nl/assets/impact-sounds),
  [Interface Sounds](https://kenney.nl/assets/interface-sounds),
  [UI Audio](https://kenney.nl/assets/ui-audio),
  [Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds)
- OpenGameArt audio:
  [Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library),
  [water splashes](https://opengameart.org/content/40-cc0-water-splash-slime-sfx),
  [chest](https://opengameart.org/content/open-chest-sfx),
  [park ambience](https://opengameart.org/content/park-ambiences),
  [birds](https://opengameart.org/content/ambient-bird-sounds),
  [city ambience](https://opengameart.org/content/scifi-city-ambient-loop)
- Google Fonts source repositories:
  [Saira Condensed](https://github.com/google/fonts/tree/main/ofl/sairacondensed),
  [Inter Tight](https://github.com/google/fonts/tree/main/ofl/intertight),
  [Noto Sans JP](https://github.com/google/fonts/tree/main/ofl/notosansjp)

## Self-generated branding & map art (original work, repository MIT license)

| Asset | Local path | Generated by |
| --- | --- | --- |
| Favicon mark (X/O geometric) | public/assets/branding/favicon.svg | hand-authored SVG, 2026-08-24 |
| Apple touch icon | public/assets/branding/apple-touch-icon.png | tests/browser/gen-branding.ts (headless render of the mark), 2026-08-24 |
| Social share card 1200x630 | public/assets/branding/og-card.jpg | tests/browser/gen-branding.ts over a NEO CITY in-engine capture, 2026-08-24 |
| Map browser hero cards 1600x900 | public/assets/maps/{neocity,oldfront,eden}.jpg | tests/browser/qa-heroes.ts in-engine captures (HUD/viewmodel hidden), 2026-08-24 |

## Verification

1. Every retained file under `public/assets/{sky,textures,models,audio,fonts}` that is
   not generated by this repo's build appears in ASSET_CHECKSUMS.txt.
   `npm run audit:assets` verifies both file-set completeness and SHA-256.
2. To re-verify a provenance claim, compare the recorded SHA-256 against the
   source project's published archive.
3. Runtime VFX, characters' procedural costumes, weapons assembly, water,
   storm shaders and all UI remain original work licensed under the
   repository MIT license.
