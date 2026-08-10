# LC2-E3 Wiring — Result (ALL GATES GREEN)

Status: FINAL. Gates per `docs/evals/2026-08-10-lc2-e3-wiring-prereg.md` (locked pre-run;
Amendment 1 dated before the G1 run).
Episode: 01KZP10K2DNX13DWDGB62G63DV. Date: 2026-08-10.

## What shipped

The frozen E2 learned memory-value scorer is wired into the sleep decay pass as a
**rescue-only veto** behind `memoryValue.enabled` (default `false`):

- Flag off (default): behavior is bit-identical to pre-E3 master (test-proven, G2).
- Flag on: a non-pinned memory condemned by the strength threshold is kept ("rescued")
  iff it ranks in the top 30% of its own tenant's non-pinned candidate set by learned
  score, AND that tenant's non-pinned candidate set has at least 10 members — below that
  floor a rank statistic is noise and the tenant never rescues (review-round fix; without
  it a condemned-only 1-entry tenant would be rescued every single sleep forever). The
  scorer can only rescue, never condemn: deletes(flag-on) ⊆ deletes(flag-off) by
  construction. Every rescue writes an `mv_rescue` audit row (rank, tenant, score
  context), after the cycle's store effects are durable.
- Weights ship as a digest-pinned src constant synced by CI test to the committed E2
  artifact (sha256 `1e747abed0df771fc9c354da8562771b336c4042faf0266f565bba1b5a8c5a40`).

## Gate results

| Gate | Bar | Result |
|---|---|---|
| G1 code parity | src scorer reproduces registered held-out weighted 0.48973684210526314 at keep 0.30, ε 5e-5, through the harness's own selection | **PASS, delta 0 (exact)** — strong arm: full-500 scratch rebuild (`--full --keep-stores`, isolated root) reproduced registered baselines exactly (heldout recency 0.4203, uniform 0.2468, n=190; train recency 0.3862), then `report-src-parity.mjs` over the rebuilt held-out stores: src 0.48973684210526314 vs registered 0.48973684210526314; recency cross-check delta 0 |
| G2 default-path non-regression | full suite green + flag-off bit-identity | **PASS** — 359 test files passed / 3 skipped, exit 0, on the final tree; bit-identity test green. LongMemEval not re-run for the off path per the pre-registered justification |
| G3 behavioral properties | rescue semantics incl. merge + conflict-detection participation; subset; pinned; fail-loud; dry-run parity | **PASS** — all green on the final tree |
| G4 scale characterization | determinism, subset, per-tenant isolation at ~2k entries / 3 tenants | **PASS** — properties green; rescue rate **17.7%** of condemned (58/327; per-tenant 19.8/17.1/16.3) — REPORTED, not gated |

Additional live-path evidence (not gated): real-CLI drive on a fresh store — flag-on
`sleep --dry-run` and real `sleep` exit 0 through `dist/cli.js` (exercising
`validateWeights` on the live path); `hippo audit list --op mv_rescue` accepted by the
CLI allow-list.

## What this does and does not claim

Claimed: (1) the src scoring path is code-equivalent to the E2 fit-time path in the
fit-time context — proven end-to-end at delta 0, not composed; (2) default-off behavior
is bit-identical to pre-E3 master; (3) the rescue mechanism satisfies its structural
properties at characterized scale.

NOT claimed: transfer of the learned weights to real production stores; any production
outcome improvement; validation of production-scale rank behavior. The caveat rides the
artifact: **usage-feature signs reflect E1's anti-oracle simulation, NOT real usage
value** — the flag is an experiment surface, not a recommendation.

Flag-flip preconditions (pre-registered): dogfood evidence via `mv_rescue` audit rows +
full LongMemEval per-haystack R@5 non-regression + tier-1 micro-eval fire-rate
non-regression, each under its own pre-registered protocol.

## Reproduction

- Rebuild scratch: `HIPPO_MV_SCRATCH_ROOT=<root> node benchmarks/memory-value/run.mjs
  --data <longmemeval_s_cleaned.json> --full --keep-stores`
- Gate: `HIPPO_MV_SCRATCH_ROOT=<root> node benchmarks/memory-value/report-src-parity.mjs`
- Tests: `npx vitest run tests/memory-value-wiring.test.ts`
