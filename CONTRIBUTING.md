# Contributing to Xo Beta

Thanks for your interest in improving Xo Beta!

## Ground rules

- **MIT-compatible contributions only.** Don't introduce code or assets under
  copyleft (GPL/AGPL), noncommercial, share-alike (CC-BY-SA), or unclear
  licenses.
- **Asset policy.** High-quality external assets are welcome alongside the
  original code-generated systems. Rules:
  - **Provenance is mandatory.** Every redistributed asset needs a documented
    source URL, author and license in `docs/ASSET_MANIFEST.md`, plus a SHA-256
    checksum in `docs/ASSET_CHECKSUMS.txt`.
  - **CC0 / Public Domain is strongly preferred** for art and audio.
    Permissive attribution licenses (CC-BY 3.0/4.0) are acceptable where the
    attribution is wired into `THIRD_PARTY_NOTICES.md` — never guess an
    author's real name or license; verify against the live source page.
  - **Forbidden:** ambiguous/unverifiable provenance, noncommercial-only,
    proprietary, or ripped assets (extracted from other games or stores).
  - **Licenses stay their own licenses.** Bundling third-party material does
    not relicense it as MIT; keep required notices intact.
  - Don't ship temporary downloads, archives, scraped pages or unused
    candidate assets anywhere under `public/assets/` — production assets only.
- **Keep the AI fair.** Bots must never gain hidden information (positions
  behind walls, inventory contents) except through the perception system.
  If your change touches bot behavior, run `npm run sim -- count=3` and include
  the aggregate stats in your PR description.

## Workflow

1. Fork & create a branch from `master`.
2. Install the Node.js version declared in `package.json`, then run `npm ci`.
3. Make focused changes; match existing TypeScript style (strict mode is on);
   `npm run lint` must pass.
4. Verify:
   ```bash
   npm run typecheck
   npm run lint         # eslint
   npm run test           # unit + integration suites
   npm run audit:assets   # asset ledger + checksums
   npm run audit:secrets  # lightweight source scan
   npm run audit:licenses
   npm run build          # must pass before merge
   ```
5. For gameplay/balance changes: run headless sims and note match duration,
   kill distribution and storm deaths before/after.
6. For visual changes: attach screenshots from `tests/browser/qa-maps.ts`.
7. For deployment changes: run `npm run cloudflare:dry-run`; this validates
   the upload manifest without deploying.

## Commit style

Short imperative subject lines (`Fix storm wall fade near circle edge`),
details in the body when non-obvious.

## Reporting bugs

Open an issue using the bug template; include browser version, console output,
and steps to reproduce. Balance feedback should include seed numbers so runs
are reproducible (`seed=` argument to the sim CLI).
