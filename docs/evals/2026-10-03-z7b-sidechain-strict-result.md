# Z7b sub-agent lessons the parent loses, with a stricter judge: result

**Date:** 2026-10-03. **Prereg:** `docs/evals/2026-10-03-z7b-sidechain-strict-prereg.md` (never locked). **Verdict: INVALID before the lock.** No calibration round passed in the three the prereg allows, so the 139 scored sub-agents were never judged.

## What happened

Z7b had to calibrate its prompts on Z7's 114 sub-agents (the dev set) before the lock. A round passes when at least 10 lesson-bearing dev sub-agents are marked by hand and at least 75% are confirmed. A sub-agent is confirmed when one of its lessons is durable, cannot be read back from a file, is not stated by the tool's own error, is not general knowledge, is not a result of the task, and is absent from the parent side.

| | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| Judge prompt | Z7b six-test prompt | Z7's prompt, byte for byte | as round 2 |
| Filter prompt | draft | each class sharpened, tie-break toward removal | round 2 without the tie-break |
| Both judges, before the recheck | 10 | 38 | 38 |
| Both judges, after the recheck | 8 | 30 | 30 |
| Either judge, after the recheck | 16 | 48 | 48 |
| Filter labels (file / self / known / result / keep) | 3 / 3 / 0 / 1 / 23 | 32 / 59 / 23 / 14 / 10 | 30 / 56 / 20 / 12 / 20 |
| Both judges, after the filter | 8 | 4 | 8 |
| Either judge, after the filter | 11 | 4 | 9 |
| Precision sample confirmed | 4 of 11 | 4 of 4 | 5 of 9 |
| Filter removals confirmed (false exclusion sample) | 0 of 6 | 0 of 8 | 0 of 8 |
| Kappa before the recheck | 0.645 | 0.691 | 0.691 |
| Round result | failed on precision | failed on sample size | failed on both |

Every gate that could be measured on dev passed in all three rounds. Parse rates were 100% for the judges, the recheck and the filter. Unplanted decoys kept were 0 of 9, 0 of 27 and 0 of 27; planted decoys kept were 10 of 10, 28 of 28 and 28 of 28. G4 runs only on the scored split.

Round 1's precision sample was every dev sub-agent with a lesson left after the filter, so it was a count of all candidates. Round 2 moved strictness from the judge to the filter (Amendment 2) and added a tie-break toward removal. The run was first stopped there, on the claim that the filter's removals had confirmed 0 of 14. Review showed that claim false: the round-2 filter removed every lesson of a sub-agent confirmed in round 1, which the false-exclusion sample never drew. The stop was withdrawn (Amendment 3) and round 3 dropped the tie-break (Amendment 4). Round 3 kept all five sub-agents confirmed so far, but the four new ones it kept were rejected (file 1, self 2, present 1), and 9 lesson-bearing sub-agents could not make a sample of 10 in any case.

## What the dev set says

Across the three rounds, 34 distinct dev sub-agents were marked by hand and **at least 5 were confirmed**, from 5 different sessions out of 43. The 5 are a floor, not a count: of the 56 sub-agents that either judge gave a lesson in round 1 or rounds 2 and 3, 22 were never marked.

- Floor: 5 of 114, or 0.044 (Wilson 95% interval 0.019 to 0.099, not adjusted for session clusters).
- Ceiling: 27 of 114, or 0.237, if every unmarked candidate held a confirmed lesson.
- The 22 filter-removed sub-agents drawn for the false-exclusion samples confirmed 0 of 22 on the lessons the filter removed, which points toward the floor. The two sets are not disjoint: one of the 22 was confirmed in rounds 2 and 3 on a different lesson set. And one confirmed sub-agent had every lesson removed by the round-2 filter, so the filter does remove true lessons.

This is a dev figure on a definition fixed after Z7's result, not a pre-registered estimate. Z7b's BUILD line was a precision-discounted rate of at least one in ten. The marked sample sits under it; the unmarked candidates leave it open.

## Reading

- Most lessons the judges find in sub-agent work are self-announcing errors (56 of 138 round-3 labels), facts a file holds (30), general knowledge (20) or task results (12). A memory system that reads `subagents/` without a strict filter would mostly store noise.
- The five confirmed lessons are all gotchas in the local environment or its tools, not in project code.
- Precision and sample size pulled against each other: the one filter that reached 75% (round 2) left 4 sub-agents, and the one that kept more (round 3) fell to 5 of 9.
- Z7 stays unmeasured by the pre-registered standard. Z7b gives no grounds to build and no measured rate to rule the idea out.

## Disclosed limits

- The orchestrator who marked the samples also wrote the prompts, and the round-2 and round-3 filter wording was written after reading earlier rounds' lessons.
- The exclusion classes (file, self, known, result) were fixed after Z7's result was known.
- 22 of the 56 judge candidates were never marked by hand.
- The first stop after round 2 rested on a false claim; an Opus method review caught it before merge.

## Reproduce

`node scripts/z7b-sidechain-eval.mjs score --split dev --round <k>` and `agree --split dev --round <k>` print the table's figures from the archive at `~/hippo-archive/z7-sidechain-2026-10-03/work/z7b/dev/`. The mark counts per round are in `calib-marks.json` there. The distinct counts (34 marked, 5 confirmed) are the union of the ids in `marks-r1.json`, `marks-r2.json` and `marks-r3.json`; the 56 candidates are the ids with a non-empty `verified` list in `judge-r1-*.json` or `judge-r3-*.json`. Lesson texts and marks stay in the archive.
