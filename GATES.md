# Gates: first-person quality rework

OWNS: src/render/**, tests/unit/viewmodel.test.ts, tests/browser/qa-boot-probe.ts, docs/QA_STATE.md, GATES.md

Scope: Track the full requested quality campaign separately from the previous 67-cycle campaign. No previous rating or capture is acceptance evidence.

- [ ] G1: All five weapons use continuous skinned anatomical hands and arms with dynamic fingers in normal play.
  EVIDENCE: pending; baseline AR at qa/quality-rework/baseline-ar/04-look.png still shows cylindrical arms and fixed fingers.
- [ ] G2: All five weapons have contact-driven tactical/empty reloads and distinct manipulation, including shotgun shells.
  EVIDENCE: pending
- [ ] G3: Offline and replica presentation share pose evaluation and return movable parts to rest after completion/interruption.
  CHECK: npx vitest run tests/unit/viewmodel.test.ts
  EXPECT: Test Files  1 passed
  EVIDENCE: pending
- [ ] G4: All four maps have improved themed structures/environment with matching collision and navigation.
  EVIDENCE: pending
- [ ] G5: At least 50 substantive visual QA cycles, independent image reviews every five cycles, final visual/technical reviews and closed findings.
  EVIDENCE: pending; baseline capture only, no completed improvement cycle.
- [ ] G6: Fixed 1920x1080 drawing-buffer performance and resource lifecycle measured on all maps and offline/host/guest.
  EVIDENCE: pending; 1280x720 baseline is not performance evidence.
- [ ] G7: Lint, typecheck, full tests, build and asset/license checks pass for the final candidate.
  CHECK: npm run lint && npm run typecheck && npm test && npm run build && npm run audit:assets && npm run audit:licenses
  EXPECT: Total licenses
  EVIDENCE: pending
- [ ] G8: Asset sources, reproducible production, provenance, comparison images/video and unverified requirements recorded without overclaiming.
  EVIDENCE: pending
