## What does this PR do?

<!-- One or two sentences. -->

## How was it verified?

- [ ] `npx tsc --noEmit`
- [ ] `npm run test`
- [ ] `npm run audit:assets`
- [ ] `npm run audit:secrets`
- [ ] `npm run audit:licenses`
- [ ] `npm run build`
- Gameplay changes: headless sims attached (`npm run sim -- count=3`)
  - duration before/after:
  - eliminations / storm deaths before/after:
- Visual changes: screenshots attached (`tests/browser/qa-maps.ts`)
- Deployment changes: `npm run cloudflare:dry-run`

## Fair-AI checklist (bot changes only)

- [ ] Bots gain no hidden information beyond perception/memory
- [ ] Determinism preserved for fixed seeds
