# ADR-0001: Renderer choice — Three.js (WebGL2)

**Status:** Accepted · **Date:** 2026-08

## Context

Xo Beta needs a production-grade browser renderer with PBR, shadows,
post-processing, instancing and long-term maintenance stability. Candidates:
Three.js (WebGL2), Babylon.js, WebGPU-first stacks.

## Decision

Use **Three.js r185+ with WebGLRenderer (WebGL2)**.

## Rationale

- WebGL2 remains the most universally supported GPU API across Chrome/Edge/Safari;
  WebGPU availability is still not universal on the target desktop browsers.
- Three.js post-processing ecosystem (EffectComposer, UnrealBloomPass,
  OutputPass, FXAA) covers all required effects without extra dependencies.
- Instancing, fog, tone mapping, shadow systems are mature and well-documented.
- Babylon.js is equally capable but Three.js's smaller runtime surface fits a
  fully custom simulation better; we only need render, not gameplay framework.
- WebGPU renderer in three.js is still maturing; migrating later is feasible
  because all game code sits behind our own GameRenderer facade — no raw
  THREE usage outside src/render.

## Consequences

- Desktop-browser focus simplifies material/shader choices.
- A future WebGPU swap is localized to `src/render/renderer.ts`.
