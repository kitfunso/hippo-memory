# Z0 round 4 tests Sonnet with hippo against Opus, on round 3's families, behind a T1 gate

Date: 2026-11-10
Status: accepted
Links: `docs/evals/2026-11-10-z0-round4-prereg.md`, `docs/plans/2026-11-10-z0-round4-prereg-plan.html`,
`docs/evals/2026-11-08-z0-round3-result.md`, `docs/evals/2026-11-09-z0-round3-cost-by-kind.md`

## Context
Round 3 showed fewer repeat mistakes at no extra cost on one model, and no saving. The founder's round 4
hypothesis: "Sonnet 5.5 plus hippo matches Opus 5.5 with built-in memory on tasks solved and repeat mistakes, at a
lower cost per solved task."

## Constraints and evidence
- Round 3 H3 A2/A1 is 1.006 [0.964, 1.049]; A2 against sham hippo is 0.009 [-0.052, 0.070] (round 3 result lines 9-18).
- Round 3's H3 is a cost per task (`ratioT`, `z0-hypotheses.mjs:138` on `04835462b`), not a cost per solved task.
- Sonnet 5.5 list prices are half of Opus 5.5 prices, so Sonnet alone can pass a cost bar with no help from hippo.
- Round 3's prereg put candidate-family sessions before its tag at about $790 (round 3 prereg line 47).
- Four round 3 families leaked (`z0-scored-set-record.md:657`); the runner finds a leak before each session.
- Round 3's recorded list-price spend over every record and attempt was $1,716.76, 17% over the $1,464.81 cost of the 4,345 scored records of the final read. It leaves out unrecorded warm-ups and deleted cut-off resumes.

## Decision
- Arms O1 (Opus, built-in), S1, S2 (hippo), S5 (sham), S0 and S4 (Sonnet controls), all at one pinned effort.
- T1 (S2 against S1, round 3's H1 test) runs first at 0.05. Only if it wins do T2 and T3 run, as a closed test
  at 0.05 whose joint null opens only on a win (Holm when no level is lowered and no test loses).
- T2 is an intersection-union test of S2 against O1: cost per solved task, resolve difference and first-apply repeats.
  It reports pass or no pass only. Its resolve bar uses harmT's estimator: repositories count equally, and each
  (family, seed) cell counts once inside one, with the additive fit when cells are missing. The pooled per-task gap is printed beside it, and enters the headline below -0.03.
- S1 against O1 runs the same test with no verdict. It can only narrow the headline.
- Reuse round 3's 29 repositories on its frozen tree, minus the 4 leaked families, dropped whole.
- Budget on round 3's recorded spend, a lower bound, checked before each batch, never inside one.
- The founder approved $2,140.00 in all. A whole-run check after the pilot asks again before batch 1 if the run does not fit.
- Each test reads seeds 1 to its own seed count, so the count the arms run never changes a test's data.
- Part (a)'s seed rule uses a fixed m of log(1 / 0.9), so the rule that runs does not depend on the pilot.
  On a miss it takes the fewest seeds whose predicted SE is at most 1.1 times the 9-seed SE, so a large family
  spread does not push every arm to 9 seeds.
- A budget refusal removes verdicts only, so spend never changes a test's data or its level.
- Every test and T2 part is simulated with round 3's cell generator on its own cell values, and joint power uses
  lower bounds, so no model of how the parts depend on each other is needed.
- The Level check sets each test's level so that every measured size in its cases is at or below its threshold,
  before any test is read. The adaptive seed rule inflates the size a little more at 29 repositories than at
  round 3's 50. The check is an empirical test of its cases, not a proof for every way the real data can differ.
- Batch 1 can only lower a level or remove verdicts, so the whole run's size is at most its size at the pre-freeze
  levels, which the pre-freeze check measures on round 3's spreads.

## Alternatives considered
- Test S2 against O1 alone: a win cannot tell hippo's part from Sonnet's lower price.
- New families on master's hippo build: tests current hippo, but needs a new author step and screen (round 3 estimated about $790).
- Drop only the leaked lessons: a later lesson supersedes a leaked one (`q133-f2-l2`), so chains break.
- Add an Opus-with-hippo arm (O2): repeats round 3's H1 test for about $385 more (A2's $385.21, `r3-total-spend.py`).

## Consequences
- The result describes round 3's frozen build `cb992a079` (hippo 1.71.0 with later changes ported), not a release and not master.
- The result holds at medium effort only.
- Families were screened on Opus; G2 (S4 against S0) is the positive control on Sonnet.

## Reconsider when
- Batch 1's power read is below 0.8 for T1, or the pilot's cost ratio 0.5 x r is 0.95 or more (r of 1.9).
- Master's hippo build differs from the frozen build in capture or delivery enough that a result on the frozen build no longer describes it.
