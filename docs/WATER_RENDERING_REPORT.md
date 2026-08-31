# Bounded realistic water rendering report

This report records the provenance, architecture, visual evidence, performance,
and online invariants for the post-Phase-4 Eden water upgrade.

## Baseline and license gate

- Phase 4 base: `9662eb679349a206ac8c33a8f811fb60c2382f3f`
- Phase 3 merge: `828bec0`
- Reference repository checked: `https://github.com/tompng/gpuocean`
- Reference HEAD checked: `379c11f8977d0a609431ca864075d5384974c934`
- License status at that commit: repository metadata reported no license and the
  root contained no `LICENSE`, `LICENSE.md`, `COPYING`, or equivalent file.
- Inspection stopped after repository metadata, the root listing, and README.
  No implementation or shader file was read.
- Upstream code used: none.

No gpuocean source code or shaders were copied, translated, vendored, or
included. The implementation was independently authored for Xo Beta's
existing WebGL2 renderer using only the high-level technique described in
the upstream README.

Every added file is original Xo Beta work or locally generated evidence:

- `src/render/waterWaveField.ts`: deterministic periodic wave-field generation,
  validation, quality configuration, and CPU sampling used by tests.
- `src/render/waterSurfaceSystem.ts`: bounded meshes, materials, depth data,
  shoreline presentation, LOD, QA counters, and resource lifecycle.
- `scripts/check-water-provenance.sh`: repository-local policy audit.
- `tests/unit/water-wave-field.test.ts` and
  `tests/unit/water-surface-system.test.ts`: deterministic profile, wave,
  fallback, shoreline, LOD, and disposal verification.
- `tests/browser/qa-water.ts` and `tests/browser/online-water-e2e.ts`: original
  headed-browser benchmark and direct-P2P integration harnesses.
- `docs/WATER_RENDERING_REPORT.md`: this original architecture, provenance,
  measurement, and limitation record.
- Images under `docs/water-evidence/`: captures produced from Xo Beta at the
  Phase 4 base and from this branch with fixed cameras and settings.
- JSON under `docs/water-evidence/metrics/`: raw locally generated browser
  measurements for the corresponding captures and quality presets.

No dependency, submodule, runtime fetch, third-party notice, or production
asset was added for the reference repository.

## Architecture decision

Xo Beta retains its existing `THREE.WebGLRenderer`, WebGL2 GLSL materials,
EffectComposer pipeline, sky/environment map, lighting, tone mapping, and one
`#game-canvas`. The implementation uses `THREE.ShaderMaterial`, `DataTexture`,
and bounded static geometry. It adds no WebGPU renderer, `navigator.gpu`
requirement, WGSL asset, second canvas, planar reflection pass, server, or
network service.

`WaterSurfaceSystem` owns presentation resources and is delegated to by
`WorldView`. The authoritative `WaterVolume` rectangle, `surfaceY`, depth,
collision, swimming, projectiles, Bots, and networking remain unchanged.
Cosmetic metadata is deliberately excluded from the gameplay map hash, while
all six physical water fields remain included. Host presentation uses
`Match.time`; a guest uses replicated `GameStateView.time`. No water state or
cosmetic clock packet exists.

The system prebuilds three bounded LOD geometries per volume, switches only
visibility at runtime, derives a small depth texture from the canonical terrain
function during loading, and disposes all owned geometry, material, wave, and
depth resources. The renderer-owned environment texture is borrowed and is
never disposed by the water system.

## Previous-water root cause

The previous material combined three fixed sine waves in the vertex shader and
three more fixed analytic bands in the fragment shader. Their directions,
frequencies, amplitude, and color model were shared by every volume, producing
visibly parallel, synchronized bands. Shallow coloration used distance from a
rectangular `WaterVolume` edge rather than terrain depth. Reflections were a
uniform sky-color mix, and river/lake/pond behavior was not distinguished.

The replacement uses deterministic periodic texture data sampled at rotated,
scaled world-space coordinates. Height, gradient, and restrained horizontal
displacement come from the same field, so normals, highlights, and crests stay
attached. Terrain depth controls dry discard, absorption, shallow color, and
shore readability. Shore sediment and foam are generated only from traced
terrain/water intersections, not the volume rectangle.

## Visual profiles

| Profile | Max vertical displacement | Choppiness | Speed | Clarity | Foam | Period |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Lake | 0.16 | 0.32 | 0.65 | 0.72 | 0.48 | 66 |
| River | 0.07 | 0.24 | 0.90 | 0.58 | 0.40 | 50 |
| Pond | 0.09 | 0.18 | 0.45 | 0.66 | 0.28 | 42 |

All displacement targets are within the requested bounds. The visual wave never
changes the flat physical surface.

| Quality | Wave texture | Bands | Choppiness | Shore foam | Wave bytes (3 volumes) |
| --- | ---: | ---: | --- | --- | ---: |
| Low | 32 x 32 | 2 | Off | Off | 24,576 |
| Medium | 64 x 64 | 3 | Off | On | 98,304 |
| High | 128 x 128 | 4 | On | On | 393,216 |
| Ultra | 256 x 256 | 5 | On | On | 1,572,864 |
| Cinematic | 384 x 384 | 6 | On | On | 3,538,944 |

The terrain depth textures use 53,504 bytes total. Exact water texture totals
are therefore 78,080 bytes on Low, 151,808 on Medium, 446,720 on High,
1,626,368 on Ultra, and 3,592,448 on Cinematic. Half-float linear data is used
only after a WebGL2 capability check; otherwise deterministic RGBA8 data is
used.

## Visual evidence

All solo pairs use Eden, seed `42042`, High quality, 1920 x 1080, the same
camera transform/FOV, time `18`, exposure, and Chrome/Apple-M5 renderer.

| View | Phase 4 water | New water |
| --- | --- | --- |
| Lake shoreline | [before](water-evidence/before/lake-shoreline.jpg) | [after](water-evidence/after/lake-shoreline.jpg) |
| Lake low sun | [before](water-evidence/before/lake-low-sun.jpg) | [after](water-evidence/after/lake-low-sun.jpg) |
| Lake dock | [before](water-evidence/before/lake-dock.jpg) | [after](water-evidence/after/lake-dock.jpg) |
| Elevated lake | [before](water-evidence/before/lake-elevated.jpg) | [after](water-evidence/after/lake-elevated.jpg) |
| River along channel | [before](water-evidence/before/river-along.jpg) | [after](water-evidence/after/river-along.jpg) |
| River across channel | [before](water-evidence/before/river-across.jpg) | [after](water-evidence/after/river-across.jpg) |
| Actor swimming in river | [before](water-evidence/before/river-swimming.jpg) | [after](water-evidence/after/river-swimming.jpg) |
| Pond close | [before](water-evidence/before/pond-close.jpg) | [after](water-evidence/after/pond-close.jpg) |
| Elevated pond | [before](water-evidence/before/pond-elevated.jpg) | [after](water-evidence/after/pond-elevated.jpg) |
| Actor swimming | [before](water-evidence/before/lake-swimming.jpg) | [after](water-evidence/after/lake-swimming.jpg) |
| Underwater upward | [before](water-evidence/before/underwater-up.jpg) | [after](water-evidence/after/underwater-up.jpg) |
| Online host near lake | [before](water-evidence/online-before/host.jpg) | [after](water-evidence/online-after/host.jpg) |
| Online guest near lake | [before](water-evidence/online-before/guest.jpg) | [after](water-evidence/online-after/guest.jpg) |

The complete machine-readable captures are under
[`docs/water-evidence/metrics`](water-evidence/metrics/).

A deterministic ten-frame low-sun sequence advanced presentation time by
1/30 second per frame. Retained frames at [18.000 s](water-evidence/temporal/low-sun-00.jpg),
[18.133 s](water-evidence/temporal/low-sun-04.jpg), and
[18.300 s](water-evidence/temporal/low-sun-09.jpg) show continuous wave and
highlight motion without a seam, phase pop, or detached highlight.

## Performance

Reference device: Google Chrome (Playwright Chrome channel), 1920 x 1080,
ANGLE Metal on Apple M5. Measurements use a fixed lake-dock camera, seed
`42042`, time `18`, matching renderer settings, a 10-second headed rAF sample,
and synchronous first/warm visible-water frames. A development-only QA hook
freezes the settled simulation during the sample so Bot decisions and match
progression cannot skew the renderer comparison; production simulation is
unchanged. These are local-device measurements, not a claim for other GPUs.

| Preset | Build | p50 | p95 | p99 | Worst | First | Warm | Frames >50 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| High | Phase 4 | 8.3 ms | 9.2 ms | 9.3 ms | 16.7 ms | 1.4 ms | 1.3 ms | 0 |
| High | New | 8.3 ms | 9.2 ms | 9.4 ms | 17.4 ms | 1.7 ms | 1.4 ms | 0 |
| Ultra | Phase 4 | 17.0 ms | 25.1 ms | 26.4 ms | 35.6 ms | 2.6 ms | 2.4 ms | 0 |
| Ultra | New | 16.6 ms | 17.5 ms | 18.3 ms | 31.9 ms | 2.1 ms | 2.4 ms | 0 |

High p95 was unchanged, p99 changed by +0.1 ms, and the synchronized warm
frame changed by +0.1 ms. The presentation EMA changed from 1.50 to 1.67 ms.
Ultra p95 improved by 7.6 ms under the matched run, its synchronized warm frame
was unchanged at 2.4 ms, and its presentation EMA changed from 2.25 to
2.15 ms. Both remain within the 1.5 ms High / 2.5 ms Ultra incremental budgets,
with no frame over 50 ms. Cinematic measured p50 16.7 ms, p95 24.8 ms,
p99 25.6 ms, worst 37.2 ms, and zero frames over 50 ms. Headed rAF pacing can
still reflect Chrome/display scheduling, so the synchronized frame and
presentation measurements are retained alongside the frame percentiles.

At the matched High camera, renderer totals remained 2 measured draw calls;
triangles changed from 18,008 to 18,023. The water system's deterministic
active-object count across the three authored volumes is 7 draws, while its
selected surface meshes contain 7,398 triangles. The matched renderer total
above includes the terrain shoreline presentation. Low disables foam and
reports 5 configured draws and 4,198 selected surface triangles.

High renderer memory counters changed from 172 to 180 geometries and 129 to
135 textures. Program count remained 116. First-visible time changed from
1.4 to 1.7 ms; warm-visible changed from 1.3 to 1.4 ms. No shader, console,
WebGL, additional-canvas, or first-visible multi-second failure occurred.

## Online invariants and bandwidth

The before and after online captures each used two isolated headed Chrome
contexts, the real application create/join/ready/start-barrier flow, native
`RTCPeerConnection` and four production DataChannels. Only signaling was a
deterministic in-memory test hub. The selected ICE pair was succeeded,
nominated, host-to-host, and never relay. This is direct same-machine P2P proof,
not real-network compatibility evidence.

- Both peers loaded Eden with the exact same canonical seed.
- Host rendered the authoritative Match; guest rendered `ClientReplica`.
- Host and guest reported the same three water volumes and High resources.
- Each peer created one WebGL canvas and reported no console or WebGL error.
- No external WebSocket, relay candidate, water channel, water packet, or
  water-related production request was observed.
- Snapshot payload size was exactly 196 bytes before and 196 bytes after.
  Phase 4 sent 21 observed snapshots (4,116 bytes); the new build sent 23
  (4,508 bytes) because the one-second observation crossed two more 20 Hz
  ticks. Per-snapshot size was unchanged.
- The one reliable control send was 4,599 bytes before and 4,586 bytes after;
  the difference is payload data such as the random canonical match seed, not
  a water field.
- RTC host upload over the observation windows was 20,185 bytes before and
  21,364 bytes after. Channel labels and packet layouts were unchanged, and
  the extra two snapshots account for 392 bytes of the timing-dependent RTC
  delta. No water channel, packet, or high-frequency field exists.

Reconnect remains covered by the Phase 4 fake-transport and browser gameplay
tests. Water adds no reconnect state: a full replicated keyframe restores the
same map while the guest reconstructs deterministic cosmetic wave resources
locally from static map metadata and authoritative match time.

## Changed areas

- `src/render/waterSurfaceSystem.ts`
- `src/render/waterWaveField.ts`
- `src/render/worldView.ts`
- `src/world/types.ts`, `src/world/builder.ts`, `src/world/maps/eden.ts`
- `src/net/matchStart.ts` (explicitly hashes physical water fields only)
- `src/main.ts` (quality/time integration, development-only fixed-scene QA,
  and a zero clamp for an impossible negative first-rAF delta found by the
  real-app online test)
- `scripts/check-water-provenance.sh`, `package.json`
- `.github/workflows/ci.yml` (runs the production provenance audit after build)
- focused unit and headed browser tests
- this report and bounded visual/metric evidence

## Validation

Observed on 2026-08-31:

- `npm ci`: passed; 264 packages installed from the lockfile.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run audit:assets`: passed; 214 files audited.
- `npm run audit:secrets`: passed; no committed secret patterns found.
- `npm run audit:licenses`: passed; five MIT and one Apache-2.0 runtime
  packages, with no new dependency.
- `npm audit --audit-level=high`: passed; zero vulnerabilities.
- `npm run audit:water`: passed against source and the production bundle.
- `npm test`: passed; 60 files and 610 tests.
- `npm run build`: passed; 119 modules and 233 audited production files. The
  existing large-chunk warning for Rapier/application bundles remains.
- `npm run sim`: passed; deterministic hard NeoCity simulation, seed `75798`,
  RAZOR winner, 9.3 simulated minutes, 9 eliminations, 1 storm death, 11
  chests, and 105 pickups.
- `npm run cloudflare:dry-run`: passed; 280 static files and no bindings or
  server-side multiplayer path.
- Focused water and physical-map-hash tests passed; 3 files and 25 tests. The
  full suite includes the Phase 4 impairment, reconnect, latency compensation,
  authority, and multi-roster cases.
- `npm run test:browser:online:gameplay`: passed the full two-context path from
  room creation through menu return. The 60 Hz host / 20 Hz snapshot run
  produced 17 snapshot packets (p50 488 bytes, p95/p99 520 bytes), zero dropped
  snapshots, and zero hard movement corrections. Prediction p95 error was
  0.00000456 world units.
- `npm run test:browser:online`: passed all 2-, 3-, and 4-participant lobby,
  reconnect, wrong-build, wrong-secret, host/guest-leave, relay-failure, and
  direct-failure cases across 10 isolated contexts.
- Headed Low/Medium/High/Ultra/Cinematic solo water captures passed without a
  console, WebGL, shader, or additional-canvas error.
- The headed low-sun temporal QA captured ten deterministic 30 Hz presentation
  frames; inspected start/middle/end frames moved continuously without a phase
  pop, seam, or detached highlight.
- Headed two-context direct-P2P online water capture passed with a succeeded,
  nominated, non-relay ICE pair and no external WebSocket.
- Repeated create, quality-change, and idempotent-dispose coverage passed.

## Known limitations

- Refraction, planar reflections, screen-space reflections, underwater
  caustics, and dynamic wake/splash pools are intentionally not implemented.
  The result favors bounded environment reflection and absorption.
- Underwater presentation keeps the existing simple color/fog treatment. The
  required upward capture remains dominated by that treatment and does not
  expose a strongly readable surface underside or simulate caustics.
- Visual waves are intentionally small and never modify collision, buoyancy,
  projectiles, or prediction, so a slight cosmetic surface/flat-physics offset
  remains by design.
- The float fallback is deterministic and unit-tested, but the reference Apple
  M5 used the half-float path; separate low-capability physical hardware was not
  available in this run.
- Visual evidence covers Chrome/Apple M5. Other browser/GPU combinations rely
  on standards-compatible WebGL2 and the tested unsigned-byte fallback.
- Direct same-machine WebRTC is verified. Localhost does not establish general
  NAT or real-network compatibility, and no TURN fallback exists by design.
