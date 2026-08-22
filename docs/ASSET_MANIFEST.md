# Asset Manifest

**Policy:** Xo Beta ships **zero third-party assets**. All visual, audio and
map content is generated procedurally at runtime by this codebase and is
original work distributed under the repository MIT license (see ADR-0003).

| Asset class | Source | Provenance |
| --- | --- | --- |
| PBR material textures | Generated on `<canvas>` at runtime (`src/render/materials.ts`) | Original, this repo |
| World geometry / maps | Data-driven builders (`src/world/maps/*.ts`) rendered via instanced primitives | Original, this repo |
| Character models & animation | Procedural rigs + pose state machine (`src/render/characters.ts`) | Original, this repo |
| Weapon viewmodels | Primitive assemblies (`src/render/viewmodel.ts`) | Original, this repo |
| VFX (tracers, flashes, particles, shockwaves) | Pooled primitive systems (`src/render/vfx.ts`) | Original, this repo |
| Sky gradients | Custom shader (`src/render/renderer.ts`) | Original, this repo |
| Sound effects & music | WebAudio synthesis (`src/audio/audio.ts`) | Original, this repo |
| Fonts / UI styling | System font stack + CSS (`src/ui/styles.css`) — no webfont downloads | Original, this repo |

## If a third-party asset is ever introduced

1. It must carry a permissive license compatible with the MIT release
   (CC0, public domain, MIT, BSD, Apache-2.0 preferred).
2. Add a row here with: path, source URL, author, license, license URL,
   date acquired, modifications made.
3. Record the file checksum (`shasum -a 256 <file>`).
4. Update `THIRD_PARTY_NOTICES.md` with any required attribution.

Assets with unknown provenance, "personal use only", noncommercial or
copyleft terms must not enter the distributable.
