# Deployment

Xo Beta deploys as a static bundle served by a Cloudflare Worker using
**Workers Static Assets** (the current recommended approach for new static
projects — no deprecated Sites path involved).

## Build

```bash
npm ci
npm run build        # typecheck + Vite build + dist audit → dist/
npm run cloudflare:dry-run  # validates Wrangler packaging; does not upload
```

The bundle is fully self-contained: three.js and the Rapier WASM are code-split
chunks under `dist/assets/`. There are no runtime server dependencies.

## Deploy

```bash
npx wrangler login   # once
npx wrangler deploy  # uses wrangler.jsonc
```

`wrangler.jsonc` configures:

- `assets.not_found_handling = "single-page-application"` so deep routes work,
- long-lived immutable caching for hashed `/assets/*`,
- no-cache for the HTML shell at `/`, `index.html` and SPA fallback routes,
- common security headers (frame denial, content-type nosniff, referrer policy,
  restrictive permissions policy).

No secrets, bindings, Worker entry point or environment variables are required:
this is an assets-only Worker and the game is entirely client-side.

The checked-in Wrangler version and Node.js floor are declared in
`package.json`. The release audit rejects symlinks, development hooks, missing
legal notices, more than 20,000 files and any individual file over 25 MiB.

## Verify after deploy

1. Open the workers.dev URL (or your custom domain).
2. Confirm the main menu renders and PLAY starts a match.
3. DevTools console should show no errors.
4. Network tab: `/`, `index.html` and an SPA fallback route are `no-cache`;
   hashed `assets/*` are `public, max-age=31536000, immutable`.
5. Confirm the CSP is present and the console contains no CSP violations.

## Notes

- The Rapier chunk (~2.8 MB, ~1 MB gzipped) loads lazily during boot; the
  loading screen covers it.
- If a future asset ever exceeded Workers Static Assets' per-file limits,
  prefer splitting/chunking it; only move to R2 with documented justification
  per ADR-0003's licensing rules.
- `npm run cloudflare:dry-run` proves local configuration/package generation;
  it does not prove account permissions, a live route, custom-domain DNS or a
  successful public deployment. Verify those only after an authorized deploy.

## Local production preview

```bash
npm run preview     # serves dist/ exactly as built
```
