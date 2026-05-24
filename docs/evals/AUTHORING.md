# Eval authoring — lessons + template

Conventions for writing evaluation harnesses against the hippo memory store
(BM25, hybrid, MMR, goal-stack, vlPFC, OFC, etc.). Each lesson below is a
real failure mode caught in a past release.

---

## Lesson 1 — Use opaque scenario IDs, never descriptive ones (B5 v1.12.6)

**The bug.** During the E1.3 (v0.37 Slack ingestion) eval, scenario IDs in
the 10-scenario incident-recall benchmark were descriptive strings like
`"login_500_error_after_deploy"` and `"db_connection_pool_exhausted"`. These
IDs were used to thread fixture data through the harness — including being
written verbatim into the ambient-noise messages seeded around each
scenario as decoys.

Result: BM25 scored the seeded ambient noise as `relevant-because-it-shares-the-scenario-id-tokens`, so recall@k looked inflated. The eval reported
~88% R@5 against a true baseline of ~30%.

**The fix.** Use opaque short IDs:

| Bad                                       | Good            |
| ----------------------------------------- | --------------- |
| `login_500_error_after_deploy`            | `S1A2B3`        |
| `db_connection_pool_exhausted_for_redis`  | `S2C4D6`        |
| `payments_webhook_signature_drift`        | `S3E8F0`        |

Opaque IDs CANNOT leak into BM25 scoring because they share no tokens with
the content under test. The semantic meaning lives in a side metadata file
(`scenarios.json`) keyed by the opaque ID.

**Why this matters generally.** Any string the harness threads through both
the fixture content AND the noise corpus is a potential scoring channel. The
sentinel-token leak is the canonical case but it generalises: if your eval
seeds both "signal" and "noise" with any shared text, BM25 / hybrid / cosine
similarity will treat the shared substring as evidence of relevance.

**Pre-commit checklist for new evals.**

1. List every string that appears in both the signal-data and the
   noise-data fixtures.
2. For each, confirm it's either (a) a content token genuinely expected to
   recall (intentional signal), or (b) opaque enough not to bias scoring
   (e.g. `S1A2B3`, ULID).
3. Run a sanity baseline: seed ONLY the noise corpus, query the signal-side
   token, and assert recall is at floor (often 0). If it's not, there's a
   leak.

---

## Lesson 2 — Pre-registration discipline (v1.8.1)

See `docs/RETRACTION.md` "Pre-registration discipline rule" added v1.8.1:

> No pre-commitment is binding without (a) source-read of code paths the
> design depends on, AND (b) a 1-question dry-run confirming the mechanism
> FIRES before pre-reg locks.

Three prior pre-registrations were retracted (v1.7.5, v1.7.6, v1.7.7 +
v1.8.0 magnitude + v1.9 pre-commitment) for failing one or both of (a) and
(b). The cost of a retraction is high — it bleeds credibility from the
mechanism family and risks freezing the line per v1.8.1's three-retraction
rule.

Use `docs/research-prereg/<date>-<name>.md` cards. Each card must include:

- **Mechanism claim** — one sentence.
- **(a) Source-read** — file:line pointers to the code paths the eval
  depends on. Include actual function signatures.
- **(b) 1-question dry-run** — the smallest possible synthetic scenario
  where the mechanism, if implemented, MUST measurably change output.
- **Pre-reg gates** — composite IC floor, walk-forward Sharpe, sign
  consistency, workload validity.
- **Retraction conditions** — explicit list of what triggers a retraction.

---

## Lesson 3 — Multi-seed harnesses + paired-comparison statistics

Single-seed evals are not evals — they're individual trials. Every
mechanism-effect claim needs ≥ 20 seeds + paired comparison (paired
permutation CI, paired t-test on per-seed deltas). Mean-only comparisons
hide variance. See `benchmarks/sequential-learning/aggregate.mjs` for the
canonical paired-permutation pattern.

---

## Lesson 4 — Workload-validity gate before mechanism gate

A null mechanism result is uninterpretable if the workload didn't fire the
mechanism. Every eval needs:

1. **Workload-validity gate.** "On the control condition, does the
   workload exhibit the property the mechanism is supposed to alter?"
   (E.g. C2 lateMean ≥ 0.20, 20/20 seeds non-zero — the v1.8.0 PASS bar.)
2. **Mechanism-effect gate.** Only after workload-validity passes.

v1.7.6's calibration sweep failed the workload-validity gate (phases.late
= 0.0 on every run) and correctly reported `B* = NULL` rather than a
spurious mechanism-effect claim.

---

## Template — copy this for a new eval

```markdown
# <YYYY-MM-DD> <eval-name>

**Status:** DRAFT | PRE-REG-LOCKED <date> | COMPLETED | RETRACTED

## Mechanism claim
<one sentence>

## (a) Source-read
- `src/<file>.ts:<line>` — `<functionName>(<sig>)` — <what it does>
- ...

## (b) 1-question dry-run
<the smallest synthetic scenario where the mechanism, if working, must
measurably change output>

## Pre-reg gates
- Composite IC ≥ <floor>
- Walk-forward Sharpe ≥ <floor>
- Sign consistency ≥ <pct>% across <N> seeds
- Workload-validity: <metric> ≥ <bar>, <K>/<N> seeds non-zero

## Retraction conditions
- <gate-fail> → RETRACT <claim>
- ...

## Fixtures
- Signal corpus: <path>, <N> items
- Noise corpus: <path>, <N> items
- ⚠ Sentinel-token sanity baseline: <pass/fail>

## Results
<filled in post-run>
```

---

## See also

- `docs/RETRACTION.md` — pre-registration discipline rule + retraction inventory.
- `docs/research-prereg/` — active pre-reg cards.
- `benchmarks/sequential-learning/aggregate.mjs` — paired-permutation CI reference.
