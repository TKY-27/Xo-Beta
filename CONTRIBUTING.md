# Contributing to Xo Beta

Thanks for your interest in improving Xo Beta!

## Ground rules

- **MIT-compatible contributions only.** Don't introduce code or assets under
  copyleft (GPL/AGPL), noncommercial, or unclear licenses.
- **No ripped assets.** All art/audio must be original or CC0/public-domain.
  This project generates everything procedurally — keep it that way unless a
  provenance-documented asset is genuinely needed (see `docs/ASSET_MANIFEST.md`).
- **Keep the AI fair.** Bots must never gain hidden information (positions
  behind walls, inventory contents) except through the perception system.
  If your change touches bot behavior, run `npm run sim -- count=3` and include
  the aggregate stats in your PR description.

## Workflow

1. Fork & create a branch from `main`.
2. `npm install`.
3. Make focused changes; match existing TypeScript style (strict mode is on).
4. Verify:
   ```bash
   npm run typecheck
   npm run test          # unit + integration suites
   npm run build         # must pass before merge
   ```
5. For gameplay/balance changes: run headless sims and note match duration,
   kill distribution and storm deaths before/after.
6. For visual changes: attach screenshots from `tests/browser/qa-maps.ts`.

## Commit style

Short imperative subject lines (`Fix storm wall fade near circle edge`),
details in the body when non-obvious.

## Reporting bugs

Open an issue using the bug template; include browser version, console output,
and steps to reproduce. Balance feedback should include seed numbers so runs
are reproducible (`seed=` argument to the sim CLI).
