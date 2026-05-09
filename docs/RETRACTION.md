# Retraction & magnitude-smuggling guard

This doc pins the v1.7.9 retraction of the "−10pp goal-stack late-phase trap-rate lift" magnitude claim and is the guard for any future release against re-asserting a retracted magnitude under a different name. v1.8.1 added two further entries: the v1.8 prereg's v1.9 LongMemEval cross-validation pre-commitment is retracted, and a "Mechanism-effect status (cumulative null escalation)" subsection is appended.

## Pre-registration discipline rule (added v1.8.1)

**No future eval pre-commitment is accepted as binding without (a) source-read of the code paths the design depends on, AND (b) a 1-question dry-run wired through the actual mechanism path that confirms the mechanism FIRES before pre-reg locks.** This rule was added after the v1.9 LongMemEval pre-commitment was retracted: the v1.8 prereg pre-committed v1.9 = LongMemEval cross-validation BEFORE anyone read the source code that constrains v1.9's design (canonical harness calls `hybridSearch`, which never invokes `applyGoalStackBoost`; ingest writes session_id + date tags only, with zero content-derived tokens for the goal-stack to match). Future pre-commitments must satisfy both gates before being treated as binding.

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

## v1.9 pre-commitment retraction (2026-05-09, shipped v1.8.1)

The v1.8 prereg's "Pre-committed v1.9 direction" — *"v1.9 will run the dlPFC goal-stack mechanism on the LongMemEval R@5 corpus as a cross-validation of the mechanism on a fundamentally different benchmark"* — is **RETRACTED publicly**.

**Why:** outside-voice review on two iterations of the v1.9 plan (v1 and v2) identified six structural barriers, each independently confirmed by source-reading:

1. The canonical LongMemEval harness `retrieve_inprocess.mjs` calls `hybridSearch` directly; `applyGoalStackBoost` is NEVER invoked from `hybridSearch`/`physicsSearch` — only from `cli.ts::cmdRecall` / `api.ts::recall` / `mcp/server.ts`.
2. LongMemEval ingest writes session-tags as `[session_id, date:YYYY-MM-DD]` only — zero content-derived tokens. Boost match is exact-equality on tags; structurally 0 firing rate.
3. `pushGoal` API field is `goalName`, not `tag`. v2 plan used wrong field.
4. `MAX_ACTIVE_GOAL_DEPTH = 3`; v2 plan pushed 3 stems would suspend the first.
5. v2's cumulative-null trigger AND clause was unreachable (boost-firing-rate ≥ 50 structurally impossible per #2).
6. v2's workload-validity gate was ceremonial (PASS structurally guaranteed).

Three options were available (re-ingest, harness rewrite, or retract). Per `CLAUDE.md` "Root Cause Over Patches": the v1.8 pre-commitment was made before the source code that constrains v1.9 had been read; forcing a workable v1.9 via re-ingest or harness rewrite is a patch over a design-mismatch (the test would no longer be on LongMemEval-as-shipped). Per the v1.7.9 pre-emptive retraction precedent, public retraction is the principled call.

**What stays shipped:** the dlPFC goal-stack mechanism code (`pushGoal`/`completeGoal` hooks, `--use-goal-stack` flag, `applyGoalStackBoost` helper, MCP/HTTP integration) — all from v1.7.4. The mechanism's CODE is preserved. What is retracted is the *claim that this mechanism can be cross-validated on the LongMemEval corpus as currently scoped*.

**What is also retracted:** the v1.10 pre-commitment from v1.9 plan v2 ("iterate goal-tag mapping") was downstream of v1.9 and is also retracted alongside.

**No new eval pre-commitment in v1.8.1.** Per the new pre-registration discipline rule above, future eval directions are drafted with source-read + dry-run validation before any pre-commitment is treated as binding.

See `docs/evals/2026-05-09-v1.9-pre-commitment-retraction.md` for the full retraction document with audit trail.

## Mechanism-effect status (cumulative null escalation, 2026-05-09, shipped v1.8.1)

This subsection escalates the cumulative null evidence accumulated across v1.7.5/6/7/8 + v1.9-untestability. Pre-committed in v1.9 plan v2 as a trigger; fires now.

| Release | Result on the dlPFC goal-stack mechanism's effect |
|---------|----------------------------------------------------|
| v1.7.5 | C2 SANITY_FAIL on full-late workload (saturation; mechanism could not be tested) |
| v1.7.6 | B*=NULL across budget sweep (workload floor; mechanism could not be tested) |
| v1.7.7 | C2 SANITY_FAIL on `--restrict-late-to 4` (N=4 lattice gate; mechanism could not be tested) |
| v1.7.9 | −10pp magnitude RETRACTED publicly on cumulative evidence |
| v1.8.0 | C2 PASS on adversarial workload; C3 = C2 across all 20 seeds (sign-only direction count: 0 STRICTLY_LOWER / 0 STRICTLY_HIGHER / 20 TIED). Mechanism produced ZERO detectable behavioural change at the per-seed late-4 lattice. |
| v1.8.1 | v1.9 LongMemEval cross-validation retracted (mechanism structurally untestable on this corpus per 6 source-read barriers). |

**Cumulative read of the evidence:** the dlPFC goal-stack mechanism remains shipped in code from v1.7.4. Across **every workload pre-registered and tested to date** (sequential-learning v1.7.x family + v1.8 adversarial categories), the mechanism has not produced a detectable behavioural effect at the metric level. The LongMemEval cross-validation that was pre-committed in v1.8 prereg as the "different benchmark" sanity check is now retracted because the corpus's tag namespace + harness call shape jointly preclude the mechanism from firing without re-architecture.

**The mechanism's effect, AS MEASURED on the workloads we have tested, is null.** The mechanism's CODE is preserved. The mechanism's THEORY (dlPFC-style goal-conditioned recall) is preserved. What is acknowledged here is: the mechanism's *effect on the workloads we have been able to test* is undetectable.

**Honest reading:** the mechanism may still produce an effect on workloads not yet tested (synthesised multi-turn conversations with explicit topic goals; observability-only telemetry in real hippo usage; alternative benchmarks with content-derived session tags). Future eval releases will pre-register such workloads under the new discipline rule (source-read + dry-run before pre-commit). Until then, the mechanism is shipped without a specific effect claim.

This escalation was pre-committed as a trigger in v1.9 plan v2 (a `SAME ≥ 495/500 AND boost-firing-rate ≥ 50/500` clause) and fires here on a different but informationally-equivalent condition: v1.9 untestable + cumulative v1.7.5/6/7/8 nulls.
