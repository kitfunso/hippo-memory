# Z7b sub-agent lessons the parent loses, with a stricter judge: result

**Date:** 2026-10-03. **Prereg:** `docs/evals/2026-10-03-z7b-sidechain-strict-prereg.md` (never locked). **Verdict: INVALID before the lock.** Calibration could not pass, so the 139 scored sub-agents were never judged.

## What happened

Z7b had to calibrate its prompts on Z7's 114 sub-agents (the dev set) before the lock. A round passes when at least 10 lesson-bearing dev sub-agents are marked by hand and at least 75% are confirmed. A sub-agent is confirmed when one of its lessons is durable, cannot be read back from a file, is not stated by the tool's own error, is not general knowledge, is not a result of the task, and is absent from the parent side.

| | Round 1 | Round 2 |
|---|---|---|
| Judge prompt | Z7b six-test prompt | Z7's prompt, byte for byte |
| Filter prompt | draft | each class sharpened, tie-break toward removal |
| Both judges, before the recheck | 10 | 38 |
| Both judges, after the recheck | 8 | 30 |
| Either judge, after the recheck | 16 | 48 |
| Filter labels (file / self / known / result / keep) | 3 / 3 / 0 / 1 / 23 | 32 / 59 / 23 / 14 / 10 |
| Both judges, after the filter | 8 | 4 |
| Either judge, after the filter | 11 | 4 |
| Precision sample confirmed | 4 of 11 | 4 of 4 |
| Filter removals confirmed (false exclusion) | 0 of 6 | 0 of 8 |
| Kappa before the recheck | 0.645 | 0.691 |
| Round result | failed on precision | failed on sample size |

Every gate that could be measured on dev passed in both rounds. Parse rates were 100% for the judges, the recheck and the filter. Unplanted decoys kept were 0 of 9 and 0 of 27; planted decoys kept were 10 of 10 and 28 of 28. G4 runs only on the scored split.

Round 1's precision sample was every dev sub-agent with a lesson left after the filter, so it is a count of all candidates, not a sample. Its 7 rejections were file 3, self 1, present 1, known 1 and result 1, and the filter had labelled every one `keep`. Round 2 moved strictness from the judge to the filter (Amendment 2). The filter then kept only true lessons, but left too few sub-agents for a sample of 10. Round 3 could pass only by keeping at least 6 more sub-agents, and the filter's removals had confirmed 0 of 14, so the run stopped (Amendment 3).

## What the dev set says

Across both rounds, 24 distinct dev sub-agents were marked by hand and **5 were confirmed**, from 5 different sessions out of 43. That is 5 of 114, or 0.044 (Wilson 95% interval 0.019 to 0.099, not adjusted for session clusters).

The count is not a full census. Round 2 left 48 sub-agents with a lesson after the recheck; 22 of them were marked, and the filter removed every lesson from the other 26. If those 26 held lost lessons at the upper rule-of-three rate for 0 of 14 (about 0.2), they would add about 5 more, giving roughly 10 of 114 (0.09). This is a dev figure on a definition fixed after Z7's result, not a pre-registered estimate.

Z7b's BUILD line was a precision-discounted rate of at least one in ten. Z7's own sample sits near one in twenty-five, and under one in ten even on the pessimistic count.

## Reading

- Most lessons the judges find in sub-agent work are self-announcing errors (59 of 138 round-2 labels), facts the file holds (32), general knowledge (23) or task results (14). A memory system that reads `subagents/` would mostly store noise.
- The five confirmed lessons are all gotchas in the local environment or its tools, not in project code.
- Z7 stays unmeasured by the pre-registered standard. Under both preregs' rules this means no build and no third run without a new data source. The dev count says a third run would not change that.

## Disclosed limits

- The orchestrator who marked the samples also wrote the prompts, and the round-2 filter wording was written after reading round-1 lessons.
- The exclusion classes (file, self, known, result) were fixed after Z7's result was known.
- 26 of round 2's 48 candidate sub-agents were never marked by hand.

## Reproduce

`node scripts/z7b-sidechain-eval.mjs score --split dev --round <k>` and `agree --split dev --round <k>` print the table's figures from the archive at `~/hippo-archive/z7-sidechain-2026-10-03/work/z7b/dev/`. The mark counts per round are in `calib-marks.json` there, and the distinct counts (24 marked, 5 confirmed) are the union of the ids in `marks-r1.json` and `marks-r2.json`. Lesson texts and marks stay in the archive.
