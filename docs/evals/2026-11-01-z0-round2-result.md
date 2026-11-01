# Z0 round 2 result: hippo adds no cost, and repeat mistakes are not shown to drop

Date: 1 Nov 2026. Read: the Amendment 9 H4 read on fresh A1, through the frozen analyzer.
Full log: `z0-scored-set-record.md`, entries from 31 Oct 23:55 to 1 Nov 12:10. Prereg:
`2026-09-29-z0-built-in-memory-prereg.md` and `2026-10-18-z0-round2-prereg.md`.

## Headline

- **No extra cost.** Over all tasks (sets R and N), hippo's cost ratio to Claude Code's
  built-in memory is 0.999 [0.962, 1.037]. That is inside H3's tie band of 0.95 to 1/0.95.
- **About 12% less spent on teach and correction turns.** The extra-turn part of H3 reads
  0.884 [0.799, 0.977]. The prereg reports this split, but it is not a hypothesis of its own.
- **The harm gate passes.** On tasks with no lesson (set N), the cost ratio is 1.054
  [1.016, 1.093], under the 1.10 bound. The resolve difference is -0.004 [-0.016, 0.008].
- **A drop in repeat mistakes is not shown.** H1 is inconclusive: -8.9 points [-18.5, +0.7],
  adjusted p 0.132 and 0.098 under the two codings. The prereg's minimum effect is 15 points.
  Under round 2's scope item 1, hippo does not count as working on this run.

## What ran

| Arm | What it is | Records |
|---|---|---|
| A0 | No memory | 416 |
| A1 | Claude Code built-in memory, fresh Amendment 9 seeds 1 to 3 | 624 |
| A2 | A1 plus hippo, Amendment 9 build | 624 |
| A4 | Perfect memory (positive control) | 416 |
| A5 | Sham hippo, capture removed | 624 |

- 16 repositories. Model `claude-opus-5-5`, Claude Code 2.1.288 (`pins-h4a9.json`).
- The A2 build is hippo-memory `1739d96cd`: the 2.2.0 token diet plus the 2.3.0 Claude Code
  block change. It predates 3.0.0, so the 3.0.0 hook change that drops another session's
  handoff (PR #1126) is not in these runs.
- Status valid. G1 to G5 pass. G2 (positive control): -0.918 [-1.018, -0.817]. G5: 3 of 45
  reader-sampled grades disagree.
- Drop list: `z0-r2/drop-list-h4a9.json`. Analyzer hashes: `z0-r2-freeze/analyzer.sha256`.

## How the cost number moved

| Read | Set N cost ratio (H4) | Upper bound vs 1.10 |
|---|---|---|
| Round 2 (28 Oct) | 1.119 [1.065, 1.175] | fail |
| Amendment 8, token diet (31 Oct) | 1.075 [1.015, 1.139] | fail |
| Amendment 9, no remember ask (1 Nov) | 1.054 [1.016, 1.093] | pass |

On tasks with no lesson, hippo still costs about 5% more than built-in memory alone.

## Limits

- H1 is the claim hippo exists for, and this run cannot make it. The point estimate favours
  hippo, but the interval reaches +0.7 points, and the effect is under the 15-point minimum.
- A2 against A5 (attribution) is not tested, because H1 is inconclusive. Reported only:
  -0.083 [-0.164, -0.003].
- Set R's resolve rate understates resolved tasks (Amendment 5, item 3). It is not evidence
  for or against hippo.
- The run used Claude Code only. H2 (Codex, set X) did not run.
- Spend: Amendment 9 cost $417.99 by `costUsd`.

## Reproduce

The harness code (the `scripts/token-eval/z0-*.mjs` analyzer, the runners and the drivers)
lives on the local branch `feat/z0-fixed-repo` of the eval box, not on origin. The run records are local to the eval box under
`C:/z0-runs/`. The read's output is `C:/z0-runs/scored/h4-analysis/a9b/a9b-16.txt`, and its
record entry lists the sha256 of every runs file it read.
