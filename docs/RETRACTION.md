# Retraction & magnitude-smuggling guard

This doc pins the v1.7.9 retraction of the "−10pp goal-stack late-phase trap-rate lift" magnitude claim and is the guard for any future release (especially v1.8.0 adversarial trap categories) against re-asserting a retracted magnitude under a different name.

## What was retracted

The v0.11.0 informal "78% → 14% over 50 tasks" headline did not reproduce on the formal sequential-learning benchmark across three pre-registered workload variants (v1.7.5 full-late SANITY_FAIL, v1.7.6 budget sweep B*=NULL, v1.7.7 `--restrict-late-to 4` SANITY_FAIL). C2 hippo-base late mean = 0.0% across every seed in every variant.

**The magnitude is RETRACTED. The mechanism is shipped; no magnitude is currently claimed.** See `CHANGELOG.md` v1.7.9 entry for the full retraction.

## What this guards against

Re-asserting the retracted magnitude under a different name. Specifically, any of the following in a future result doc, README, CHANGELOG, RESEARCH/ROADMAP-RESEARCH update, or marketing copy:

- `Δ = ` followed by a percentage-point number on late-phase trap rate
- `Xpp lift`, `Xpp drop`, `≥Xpp`, `−Xpp`, `+Xpp`
- "magnitude" applied to the goal-stack mechanism's effect on trap rate
- A pre-registered numeric pass/fail threshold on a single trap-rate metric
- "Lift" or "improvement" applied to the goal-stack mechanism without explicit "this is workload-validity, not magnitude" framing

## What this does NOT guard against

Legitimate workload-validity gates and discrimination checks are explicitly allowed:

- The N-lattice gate (`mean ∈ [0.05, 0.50]` AND ≥3 distinct seeds non-zero) IS a discrimination check on workload validity. It is not a magnitude claim about the mechanism.
- Per-seed rate reporting on individual conditions (C2, C3) for descriptive purposes.
- Hook failure counts.
- On/off comparisons that report whether the mechanism produced detectable behavioral differences (rather than asserting a specific magnitude).

## Workflow for v1.8 and beyond

Any v1.8.0+ result doc, CHANGELOG entry, or README update touching the sequential-learning benchmark MUST:

1. Reference this `docs/RETRACTION.md`.
2. State explicitly: "This release does not re-assert the retracted −10pp magnitude."
3. If reporting any number that could be read as a magnitude lift, frame it as workload-validity or descriptive characterisation, not as a mechanism-magnitude claim.
4. Pass an outside-voice review on whether the framing satisfies the guard. The v1.7.9 ship chain established this pattern; future releases inherit it.

## When this guard sunsets

This guard sunsets if and only if a future eval produces a discriminating workload (C2 hippo-base late mean within the N-lattice gate band) AND a properly pre-registered hypothesis test at that workload returns SUPPORTED with paired CI lower bound > 0. Until then, the magnitude is retracted, and any future release must satisfy this guard.

## Related documents

- `CHANGELOG.md` v1.7.9 entry (top of file)
- `docs/evals/2026-05-09-v1.7.9-retraction-inventory.md` (literal grep anchor + retraction targets)
- `docs/evals/2026-05-09-v1.7.7-goal-stack-eval-result.md` (last formal eval before retraction)
- `docs/evals/2026-05-09-v1.7.7-goal-stack-eval-prereg.md` (the prereg whose SANITY_FAIL ≠ NOT_SUPPORTED distinction v1.7.9 corrects)
- `README.md` "What's new in v1.7.9" section
- `ROADMAP-RESEARCH.md:158` v1.7.9 status update block

## v1.8.0 outcome (2026-05-09)

v1.8.0 ran adversarial trap categories (3 new: timezone_naive, idempotency_retry, float_accumulation; lesson vocabulary <0.30 Jaccard with v1.7.5 lessons; uniform position distribution; categories authored BEFORE C3) under the magnitude-smuggling guard pinned in this doc.

**Did the guard hold?** Yes. The result doc, prereg, claim inventory, plan, CHANGELOG entry, README "What's new in v1.8.0" block, and this RETRACTION.md "v1.8.0 outcome" subsection ALL contain the verbatim sentence "This release does not re-assert the retracted −10pp magnitude" and reference this guard. Pre-publish staged-diff outside voice (Task 13 of the v1.8 plan) verifies compliance with the hardened magnitude grep + retraction-citation allowlist.

**v1.8 result framing held:**
- Workload-validity verdict: PASS (C2 lateMean=0.25, 20/20 seeds non-zero — first non-saturated workload across v1.7.5/6/7/8).
- C3 reporting: per-seed lattice histogram (descriptive frequency distribution over discrete values) + sign-only direction count (0 STRICTLY_LOWER / 0 STRICTLY_HIGHER / 20 TIED).
- NO magnitude framing. NO Δ pp, NO median pp, NO 5-number summary, NO juxtaposed condition late-mean reporting. Two-section result template enforced "Do not subtract across sections."

**v1.9 direction:** LongMemEval R@5 cross-validation, pre-committed in v1.8.0 prereg BEFORE v1.8 ran. Different corpus, different metric, different mechanism stress. The v1.8 PASS verdict does not change the v1.9 pre-commitment. Any v1.9 result-doc framing must satisfy this guard.

**Has the guard sunset?** No. The "When this guard sunsets" criteria require a future eval producing a discriminating workload AND a properly pre-registered hypothesis test returning SUPPORTED with paired CI lower bound > 0. v1.8 satisfied workload validity but reported sign-only direction (no SUPPORTED verdict; no magnitude claim). The guard remains in force for v1.9+.
