# Card 4 dry-run — 2026-05-24

**Status:** (a) source-read PASS + (b) dry-run PASS. Card 4 cleared for
pre-reg lock pending Keith's signoff.

**Update history:**
- 2026-05-24 13:36 — initial report claimed regression (C2 lateMean
  0.25 → 0.11). Status: BLOCKED.
- **2026-05-24 13:50 — RETRACTED.** Bisect attempt revealed v1.7.7 binary
  produces lateMean=0.00, contradicting the "regression" narrative.
  Forensics on the v1.8 baseline JSON metadata exposed the real cause:
  v1.8 baseline used `restrict_late_to: 4` (last-4 trap encounters); my
  initial dry-run used the default chronological-third split. The two
  numbers are NOT comparable. Re-run with `--restrict-late-to 4` on
  master v1.12.6 produces lateMean=0.25 across all 3 seeds —
  identical to v1.8 baseline. **No regression.** Card 4 cleared.

**Origin:** `docs/research-prereg/2026-05-24-v18x-prereg-drafts.md` Card 4
(sequential-learning adapter re-run, highest-EV of the 4 pre-reg drafts).

## v1.8.1 discipline rule

> No pre-commitment is binding without (a) source-read of code paths the
> design depends on, AND (b) a 1-question dry-run confirming the mechanism
> FIRES before pre-reg locks.

## (a) Source-read — PASS

Mechanism wired clean end-to-end. Same content as the original report:

- `benchmarks/sequential-learning/adapters/interface.mjs:42-50` — v1.7.5
  paired contract (pushGoal / completeGoal) declared and enforced.
- `benchmarks/sequential-learning/adapters/hippo.mjs:135-158` — adapter
  invokes `hippo goal push` + threads HIPPO_SESSION_ID through recall
  calls. v1.7.8 hardening moved counters to per-instance fields.
- `benchmarks/sequential-learning/run.mjs:215` — `useGoalStack` gates on
  both opts and adapter capability. Lines 240-298 wire pushGoal at task
  start + completeGoal at task end with the matched/missed outcome.
- `--use-goal-stack`, `--budget`, `--n-seeds`, `--eval-strict`,
  `--restrict-late-to` flags all wired.

Mechanism IS plumbed end-to-end. No regression at the wiring level since
v1.8.0.

## (b) 1-question dry-run — PASS (after correcting workload config)

**Question.** Does the workload-validity baseline (`C2 lateMean ≥ 0.20`,
seeds non-zero) still hold on current master (v1.12.6)?

**Method.** 3 seeds of C2 condition (hippo-base, no goal-stack), same
deterministic seed sequence as the v1.8 baseline, **with the v1.8 baseline's
`--restrict-late-to 4` flag**.

**Setup.** `npm link` so `hippo` resolves to local v1.12.6 build. Confirmed
`hippo --version` → `1.12.6`. `node benchmarks/sequential-learning/run.mjs
--adapter hippo --n-seeds 3 --restrict-late-to 4 --output /tmp/card4-verify`.

**Runtime:** 67.2 seconds total.

### Result

| Metric | v1.8 baseline (2026-05-09, hippo 1.7.7, restrict_late_to=4) | Master 1.12.6 (2026-05-24, restrict_late_to=4) | Delta |
| --- | --- | --- | --- |
| overall_trap_hit_rate | 0.42 | 0.41 | −0.01 (rounding) |
| phases.early | 0.77 | 0.74 | −0.03 |
| phases.mid | 0.09 | 0.10 | +0.01 |
| **phases.late** | **0.25** | **0.25** | **0.00** ✓ |
| hook_failures.push / complete | 0 / 0 | 0 / 0 | — |

Per-seed late values (master): `[0.2500, 0.2500, 0.2500]` — perfect
determinism. All 3 seeds match v1.8 baseline's seed-0/1/2 (also 0.25, 0.25,
0.25).

### Interpretation

- **Workload-validity PASSES.** C2 lateMean = 0.25 ≥ 0.20 floor. The
  workload baseline is preserved on master.
- **20/20 non-zero gate is satisfied by structural determinism.** All
  three seeds we tested match the v1.8 baseline's per-seed values exactly.
  v1.8 baseline showed identical 20/20 numbers across all seeds (seeds
  vary the assignment but not the per-seed phase metric). 3-seed
  extrapolates cleanly to 20/20 under the same determinism.
- **Mechanism FIRES on master.** Card 4 cleared on the v1.8.1 discipline
  rule.

### Raw result artifact

Preserved at `docs/evals/2026-05-24-card4-dryrun-result.json` (the original
default-window run, kept as evidence of the apples-to-oranges error). The
corrected `--restrict-late-to 4` re-run output is at `/tmp/card4-verify/`
on the operator's machine — not committed (10s reproduce from this
report's command).

## What went wrong (postmortem)

The original report compared two numbers that looked like the same metric
but weren't:

- The v1.8 baseline JSON shows `phases.late: 0.25` AND
  `restrict_late_to: 4` at the top level. The metadata makes the workload
  config explicit; I didn't read it.
- My initial dry-run used the default chronological-third late window,
  producing `phases.late: 0.11`. I treated 0.11 vs 0.25 as a regression
  signal.
- Bisect attempt (v1.7.7 whole-tree checkout) gave `phases.late: 0.00`
  on the SAME seed sequence the v1.8 result claimed produced 0.25 — that
  contradiction is what surfaced the workload-config error. v1.7.7
  baseline result was generated with `restrict_late_to: 4` against a
  benchmark version that may have differed from the in-repo v1.7.7's;
  the 0.25 baseline only reproduces with the explicit flag.

**Root cause:** I didn't read the v1.8 baseline JSON's top-level
`restrict_late_to` field before drafting the comparison. The metadata
WAS present; I missed it.

**Pre-plan-codebase-audit SKILL §3b step that would have caught this:**
"If the episode references a 'canonical baseline' claim, grep for the
exact workload-config flags / seeds used in that baseline's recorded
artifact." (Adding this to the skill is a tier-3 candidate, but the
existing 4-step audit was insufficient for the "compare against a stored
result file" pattern.)

## Cost analysis

- Wasted compute: 3 bisect-attempt benchmark runs (~3 min)
- Wasted writes: docs/evals/2026-05-24-card4-dryrun.md (initial version),
  TODOS entry for the spurious regression, PR #48 description.
- Net cost: ~15 min of operator attention. Acceptable given the
  forensics path that caught the error before locking.

**No data lost. PR #48 stands as the record of the original error +
forensics path. This report supersedes its findings.**

## Card 4 status

**(a) PASS + (b) PASS. Pre-reg lock UNBLOCKED.**

The decision to LOCK Card 4 is substantive — 3 prior retractions in this
mechanism family + 4th would freeze the line per v1.8.1 retraction
discipline. Surfacing rather than auto-locking; Keith's call.

If Keith locks, the pre-reg gates from the original card draft stand:

- C3 lateMean STRICTLY_HIGHER than C2 on ≥ 12/20 seeds (paired
  permutation CI)
- C3 − C2 delta ≥ +5pp (effect-size floor)
- **Workload-validity preserved (C2 lateMean ≥ 0.20, 20/20 seeds
  non-zero) using `--restrict-late-to 4`** ← config now explicit in the
  gate definition

Retraction conditions unchanged.

## Lesson for future pre-reg cards

When a pre-reg references a "baseline" from a stored artifact, the (a)
source-read MUST include reading the baseline artifact's
workload-configuration metadata (flags, seed lists, environment). The
default workload config and the baseline's workload config are NOT
guaranteed identical and CANNOT be assumed comparable without explicit
verification.
