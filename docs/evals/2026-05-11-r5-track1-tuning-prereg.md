# LongMemEval R@5 target — Track 1 hybrid-tuning pre-registration

**Author:** Claude Code (subagent-driven-development workflow)
**Date:** 2026-05-11
**Plan:** docs/plans/2026-05-11-r5-track1-hybrid-tuning.md
**Retraction-discipline reference:** docs/RETRACTION.md

This release does not re-assert the retracted −10pp magnitude.

## TL;DR / scope

This pre-registration covers a staged hyperparameter sweep over `hybridSearch`
options (`embeddingWeight`, `mmrLambda`, `budget`, `min-results`) on the
LongMemEval 500-question workload, using the v0.27 hippo store at
`hippo_store2/`. No mechanism changes are made in `src/`. The goal is to find
the configuration that maximises R@5 and to determine whether tuning can beat
the F6 baseline (75.6%) by at least 2 percentage points.

28 total runs across three stages; each stage fixes the prior winner and sweeps
one new variable.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. The result doc, the CHANGELOG entry, the README
"What's new" entry, and any commit body authored under this plan must satisfy:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <touched-files>
```

returns zero matches.

## Workload-validity gates (binding)

- **Gate-A (sweep completion):** all 28 planned runs must complete with a non-empty `*.eval.json` file. Any harness crash or evaluator error invalidates the sweep until the failing run is fixed and re-run.
- **Gate-B (best-config improvement):** the best configuration's overall R@5 on LongMemEval must be ≥ baseline R@5 + 2pp (i.e. ≥ 77.6% given baseline 75.6%). If the best configuration cannot beat baseline by 2pp, the workload is declared insensitive to hybrid hyperparameter tuning on this corpus and no R@5 effect of tuning is claimed.

## Sweep grid (28 runs total)

### Stage 1 — `embeddingWeight` sweep (7 runs)

Fix `mmrLambda` at default (0.7), `budget` at default (1000000), `min-results`
at default (10). Sweep:

| Run | `embeddingWeight` |
|-----|-------------------|
| 1   | 0.2               |
| 2   | 0.3               |
| 3   | 0.4               |
| 4   | 0.5               |
| 5   | 0.6               |
| 6   | 0.7               |
| 7   | 0.8               |

Winner: the `embeddingWeight` value yielding the highest R@5. Carried forward to
Stage 2.

### Stage 2 — `mmrLambda` sweep at best `embeddingWeight` (5 runs)

Fix `embeddingWeight` = Stage 1 winner, `budget` at default, `min-results` at
default. Sweep:

| Run | `mmrLambda` |
|-----|-------------|
| 8   | 0.0         |
| 9   | 0.3         |
| 10  | 0.5         |
| 11  | 0.7         |
| 12  | 1.0         |

Winner: the `mmrLambda` value yielding the highest R@5. Carried forward to
Stage 3.

### Stage 3 — `budget` × `min-results` grid at best `(embeddingWeight, mmrLambda)` (16 runs)

Fix `embeddingWeight` = Stage 1 winner, `mmrLambda` = Stage 2 winner. Full
factorial cross of:

| `budget` | `min-results` | Run |
|----------|---------------|-----|
| 50       | 5             | 13  |
| 50       | 10            | 14  |
| 50       | 20            | 15  |
| 50       | 50            | 16  |
| 100      | 5             | 17  |
| 100      | 10            | 18  |
| 100      | 20            | 19  |
| 100      | 50            | 20  |
| 500      | 5             | 21  |
| 500      | 10            | 22  |
| 500      | 20            | 23  |
| 500      | 50            | 24  |
| 1000     | 5             | 25  |
| 1000     | 10            | 26  |
| 1000     | 20            | 27  |
| 1000     | 50            | 28  |

Winner: the `(budget, min-results)` pair yielding the highest R@5.

## Failure handling

Gate-B FAIL is descriptive (no retraction protocol fires) because this plan
changes no mechanism in `src/`. The result doc records the verdict and the
CHANGELOG / README do NOT advertise tuning as a value-add. Plans F9 and F10 can
still proceed using the v0.27 default hyperparameters.

## Outside-voice review

[Filled by the controller after the outside-voice subagent review completes.]
