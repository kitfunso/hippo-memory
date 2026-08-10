# LC2-E3 Wiring — Pre-registered Gates (LOCKED)

Status: LOCKED 2026-08-10, before any verify-stage gate run.
Episode: 01KZP10K2DNX13DWDGB62G63DV
Plan: docs/plans/2026-08-10-lc2-e3-mv-wiring.md (plan-eng-critic pass 90, round 3)
Discipline: docs/RETRACTION.md — amendments to this doc are dated, appended, and made
BEFORE the affected run; results are reported against these gates as written.

## What is being gated

`src/` wiring of the frozen E2 learned memory-value scorer into the sleep decay pass as a
rescue-only veto behind `memoryValue.enabled` (default `false`). Weights artifact:
`benchmarks/memory-value/weights-learned.json`, sha256
`1e747abed0df771fc9c354da8562771b336c4042faf0266f565bba1b5a8c5a40` (E2 freeze, PR #140).

## Claim scoping (binding on the result doc)

This episode claims, at most: (1) the src scoring path is code-equivalent to the E2
fit-time path in the fit-time context; (2) default-off behavior is bit-identical to
pre-E3 master; (3) the flag-on rescue mechanism satisfies its structural properties.
It does NOT claim: transfer of the learned weights to real production stores; that
rescue improves any production outcome; validation of production-scale rank behavior.
The usage-feature caveat rides every artifact: usage-feature signs reflect E1's
anti-oracle simulation, NOT real usage value.

## Gates

### G1 — code parity through the fit-time context
The E1 retention harness's held-out evaluation, with per-entry scores produced by the
COMPILED src scorer (`dist` build of `src/memory-value.ts`) over the fit-time scratch
stores, reproduces the registered E2 held-out weighted retention
**0.48973684210526314 at keep budget 0.30, epsilon 5e-5**.
- Adapter contract: eval-only file under `benchmarks/memory-value/`; it feeds
  src-computed SCORES into the harness's OWN keep-selection so the registered
  tie-break stays in force. It does not use `rescueSet` (production-only semantics).
- Dim equivalence (pre-stated): the 22 dead dims carry no weight keys and min-max
  normalize to 0 in every store, so the 8-dim src scorer and the 30-dim harness
  evaluation produce identical scores by construction.
- Primary path: run over the existing E1 scratch stores (fit.mjs --report's
  scratch-existence precheck posture). Fallback (pre-registered): if scratch no longer
  exists, rebuild the held-out scratch via the E1 harness before running; if rebuild is
  infeasible in-session, G1 falls back to the composition argument (tests a+b+c:
  feature parity + normalization parity + weights sync ⇒ score equality) and the result
  doc MUST label G1 as "composed, not end-to-end" — a weaker pass, reported as such.

### G2 — default-path non-regression
Full vitest suite green on the final tree, AND the flag-off bit-identity test passes
(cloned store, flag off: survivor set and decision details identical to the pre-E3
single-phase loop; zero mv audit rows).
- Pre-registered justification for NOT re-running LongMemEval on the off path: flag-off
  makes the new code unreachable and bit-identity is test-proven; a 77-minute eval of an
  unreachable path adds no information. (The roadmap's LongMemEval gate targeted
  constants-replacement, which would have changed default behavior.)
- Flag-flip preconditions (pre-registered now, binding on any future default change):
  dogfood evidence via `mv_rescue` audit rows, PLUS full LongMemEval per-haystack R@5
  non-regression, PLUS tier-1 micro-eval fire-rate non-regression, each under its own
  pre-registered protocol.

### G3 — behavioral properties
Tests (e), (f), (g), (i) green on the final tree: rescue semantics with same-cycle
merge-pass AND conflict-detection participation; deletes(flag-on) ⊆ deletes(flag-off);
pinned exemption unchanged; fail-loud on malformed weights (enabled + broken constant
throws, never silently behaves as off); dry-run decisions == real-run decisions.

### G4 — scale characterization
Test (h) properties green at ~2,000 entries / 3 tenants: determinism, subset property,
per-tenant isolation (an entry's rescue outcome unchanged under other-tenant composition
changes). The rescue rate is REPORTED in the result doc and explicitly NOT gated —
production-scale rank behavior is characterized, not validated.

## Amendment 1 (2026-08-10, before any G1 run)

G1's primary-path premise was wrong: the E1 harness deletes each scratch store's SQLite
dir BY DESIGN once features.jsonl exists (run.mjs `--keep-stores` opt-out; cleanup
comment at run.mjs:206). The "existing E1 scratch stores" never had store/ dirs after
the E1 runs completed — verified 2026-08-10: all 500 dirs carry features/gold/meta only.
The pre-registered fallback fork is exercised in its stronger arm: rebuild via the E1
harness — full 500-question run (`--full --keep-stores`, isolated
HIPPO_MV_SCRATCH_ROOT, default simulation ON so store usage counters match fit-time),
then run the G1 adapter over the rebuilt held-out stores. Ingest determinism is
test-enforced (cross-ingest determinism test), so rebuilt stores are score-equivalent
to fit-time. G1's target number and epsilon are unchanged. Two adapter pre-checks
already ran and are disclosed: a synthetic-store E2E equality check (adapter vs
brute-force, exact match) and the recency cross-check over the real per-question
features (0.42026315789473684, delta 0 vs registered) — neither touches the gated
src-weighted number.

## Disclosure

Tests (a)-(i) were written and run green during the execute stage (development runs,
15/15). The gate runs of record are the verify-stage runs on the final tree, after all
review-round fixes land. G1 has not been run in any form before this lock.
