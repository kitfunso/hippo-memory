# Z7 sub-agent lesson gap: result

**Date:** 2026-10-03. **Pre-registration:** `docs/evals/2026-10-03-z7-sidechain-gap-prereg.md`, locked at `06589ab` before any scored call. **Verdict: INCONCLUSIVE.** The interval cleared the BUILD bar, then the precision audit confirmed only 6 of 10 sampled sub-agents, below the 0.75 the pre-registration requires for BUILD to stand.

## Answer

The judges found a lost lesson in about a third of sampled sub-agents: 31 of 90 (`p` 0.344, 95% session-cluster interval 0.221 to 0.475, 34 sessions). That clears BUILD's lower bound of 0.20. But when I checked a seeded sample of 10 by the calibration rule, only 6 held a lesson that is durable, not recoverable from a file, and absent from the parent side. The judges overcount. At that precision the true share could sit near or below the bar, so Z7 stays test-first.

The four rejections fall into two classes:
- The lesson can be read back from the file it concerns: what a script imports, its default pattern, how a config file is written. That gives 2 rejections.
- The tool's own error states the fix, or any capable agent already knows it. That gives 2 rejections.

The same two classes produced the one rejection at dev calibration (4 of 5). The judge prompt applies tests 2 and 3 more loosely than the calibration rule does.

## Pins

- Lock commit `06589ab`; scored item list SHA-256 `cb58dd16d537be7ec882c2faa18d82687bf9af3fac917be644592bd5f9c808ac`. The `dist/` files, prompts, manifest and `claude` version are as listed under Pins in the pre-registration. The guard checked all of them before the marker was written.
- Code measured: master `c2b3840` (v1.53.2), unchanged through the run. The pinned `dist/` sources are unchanged from the script base `28ca777`.
- Selftest: 76 cases pass at the lock commit.
- 442 judge, control, recheck and rule-arm calls, all on plan quota; 0 exhausted failures; 0 resumes.

## Verdict and validity

- Every gate passed. G1 isolation passed for both judges, and G2 parse passed for Sonnet, Opus and the recheck. G3 evidence passed for both judges. G4 control: 30 of 30 control items parsed by both judges, at or below the hit-share bar. G5: unplanted decoys kept 0 of 29. G6: planted decoys kept 16 of 16.
- Primary: `p` 0.344 (0.221 to 0.475), interval width 0.254. Union (either judge): 0.467 (0.341 to 0.588).
- Preliminary verdict BUILD. Precision audit: 6 of 10 confirmed (0.60), against a bar of 0.75. Final verdict INCONCLUSIVE. Flipping the closest rejected call gives 7 of 10, still below the bar.
- Before the recheck, both judges marked 36 of 90 lesson-bearing. The recheck overturned 28 lessons, and 31 sub-agents stayed lesson-bearing. With the session's other sub-agent reports added to the parent side, `p` is 0.322.

## Where the lessons sit

21 of the 31 lesson-bearing sub-agents have at least one surviving lesson whose evidence lies inside a report. A build that read reports alone would reach about two thirds of them. The rest are found only in the work.

## Secondary rows

- `p` per judge: Sonnet 0.367 (33), Opus 0.444 (40). Kappa before the recheck: 0.798.
- Lessons per sub-agent: Sonnet 0.62, Opus 0.99. Kinds: gotcha 122, error 12, correction 11.
- By agent type (lesson-bearing of n): general-purpose 22 of 58, other 6 of 14, reviewer 3 of 17, worker 0 of 1.
- Items with a B or C(ii) window cut: 13 of 90 (0.144).
- Dev calibration precision: 4 of 5 (0.80). Scored audit precision: 6 of 10 (0.60).

## Rule arm

Today's extractor, run on each sub-agent transcript, produced 57 items from 39 of 90 sub-agents (median 0). Opus labelled 0 of 57 as passing tests 2, 3 and 5. A Z7 build cannot reuse `extractFromText(summariseTranscript(...))`; it needs a distil step.

## What would decide it

Precision is the bottleneck. One more judge round on these items cannot fix it, because the prompts are frozen at the lock. A new pre-registration can. Its judge prompt should name the two rejection classes as exclusions, it should calibrate on a fresh dev split until precision is at least 0.75, and it should score a fresh draw. On these numbers, a judge at 0.75 or better precision would need about 0.27 measured before a precision-corrected share holds 0.20. The audited figure here is 0.344 × 0.60, or about 0.21. That figure is illustration only and was not pre-registered.

No private transcript content appears in this file. Item ids, marks and lesson texts are kept in the local archive (`work/scored/audit.md`, `audit-marks.md`).
