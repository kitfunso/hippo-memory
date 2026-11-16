# Recall rank without age: registration (2026-11-16)

**Status:** LOCKED before any run of arm B on any measure below. Plan: `fix/rank-age-decay` branch; the plan page and its outside review are in the session scratchpad (`rank-plan/plan.html`, `rank-plan/review.md`).

**Openly post hoc:** the change comes from a DolphinBench finding (below). DolphinBench data has been looked at, so it is reported (R1, O1) and never used as a guard. The guards run on data no arm of this change has touched.

**Corrections before the lock.** The first draft named E1 seeds 141 to 160 as unused. That is false: the 2026-09-28 release confirmation ran them (`2026-09-28-e1-release-confirmation-result.md:49`). This file now uses seeds 161 to 180. A grep of `docs/` and `scripts/` for every `--seeds` and "seeds N to M" block finds no use of 161 to 180. One arm A run on 141 to 160 started and was stopped before any score was read; nothing from it is used.

## The finding that started this

DolphinBench v3 (3 personas, histories from 2023 to 2027, 580 graded agent tests with load-bearing facts). The hook's search was replayed in-process on the saved v3 stores with hippo 3.5.1 and four rank variants, no model calls (`hippo-bench/comparability/scripts/dolph_ablate.mjs`, outputs `replay-*-x.json`). Evidence recall is the share of a test's source sessions that the shown memories cover:

| Rank | Evidence recall | Any source shown |
|---|---|---|
| 3.5.1 as shipped | 38.3% | 42.8% |
| strength decay off | 53.3% | 58.6% |
| 30-day recency off | 41.5% | 45.9% |
| both off | 53.7% | 59.1% |
| keyword control (BM25 order) | 54.2% | 59.8% |

With decay off, 100 tests gain a source session and 8 lose one (`dolph_flip.py`). The files `replay-default.json` and `replay-nodecay.json` (no `-x`) are byte-identical: the server's `--half-life-days` acts only when a memory is written. They are not evidence.

Why earlier evals missed it: E1 runs 20 weekly sessions, so a 365-day half-life barely acts (`2026-09-23-mechanism-audit-round2-result.md`, headline 3).

## Arms

- **A:** `origin/master` at `d86ce480b`, built once. This is the last build that can re-run R2a and the M4 recency gate; B removes those switches.
- **B:** the `fix/rank-age-decay` commit that the result file names, built once. In `strengthRecencyMultipliers` (`src/domain/search/boosts.ts`):
  - strength = `0.5 + 0.5 * calculateStrength(entry, now, { ...model, decays: false }) * staleShare`. With decay off, `calculateStrength` returns the wrong-mark share (1, halved per net wrong mark). `staleShare` is 0.5 when the stored `confidence` is `'stale'`, else 1. So a stale mark counts like one wrong mark.
  - recency = 1. The 30-day factor and its eval switches go.
  - A conflict loser (`weaken`) gets `confidence = 'stale'`. A decision save that names the memory it replaces sets `superseded_by` on it.
  - No new use lift. Recall count and outcomes still act in sleep. Sleep keeps full decay.

Each arm runs from its own worktree and `dist/`. Same seeds, same data, same flags.

## Rule

Benefit points the good way: B minus A for a recall, A minus B for an intrusion or persistence rate.

- **Guard pass (non-inferiority):** the 95% CI lower bound of the benefit is above -3 pp. A guard with a wide CI fails. This is the release confirmation's C1 rule.
- **HELPS** (reported): the 95% CI lower bound is above 0 and the point is at least +3 pp.
- **Alive check, each guard:** the arms must differ. E1: at least 1% of final-epoch probes have a different rank for the current version (`docs/evals/rank-age/e1_alive.mjs`). LoCoMo and LongMemEval: at least 1% of questions have a different top-10 list (`docs/evals/rank-age/paired_by_type.py`). A guard whose alive check fails is void, and B does not merge.
- **Explain probe:** in one temp store with a 90-day-old memory, B's `hippo explain <query>` prints recency x1.000 and A's prints less than 1.

## Guards

**G1, E1 lifecycle, half-life 365, seeds 161 to 180.** In each worktree: `node scripts/e1-lifecycle/run.mjs --arms full --half-life 365 --seeds <s> --out-dir <dir>`, one seed per process. Then `compare.mjs --a <A>:full --b <B>:full --seeds 161-180`, 10,000 draws.
- currentR5, hotR5, cleanStaleR5 and cleanTrapR5 must pass non-inferiority.
- Superseded break-even: the 95% lower bound of s\* must stay above 7.1%. That is the September upper proxy (`2026-09-23-mechanism-audit-prereg.md:134`). A recount on `~/.hippo/hippo.db` (read-only, 2026-11-16) finds 551 of 25,962 live memories with a stored stale mark or a recorded conflict, 2.1%; the stricter 7.1% stays.
- Demoted break-even: the 95% lower bound of s\* must stay above 1.4% (same source).
- Stale intrusion, trap persistence and MRR are reported.

**G1b, E1 lifecycle, half-life 35, seeds 161 to 180.** The same runs and compare with `--half-life 35`. Over 20 weekly sessions that is approximately 4 half-lives, the decay depth that 365 days gives over DolphinBench's 4 years. Same rules as G1. This is the guard that can see the stale-version cost.

**G2, LoCoMo retrieval.** Categories 1 to 4 (1,531 questions with evidence), embeddings off. One `hippo-mem0-server.mjs --arm hippo --embeddings 0 --dist <arm>/dist` from the round-2 harness (`eval/public-bench-r2` at `7eae0ce07`), with Mem0's runner `benchmarks.locomo.run --predict-only --top-k 200`. Each memory keeps its session date. Metric: evidence recall at top 10 and top 50, `evidence_recall.py --k 10,50 --baseline <A>`, 4,000 paired draws. Both cutoffs must pass non-inferiority. The temporal category is a named secondary read with its own paired CI.

**G3, LongMemEval-S retrieval.** 500 questions, arm `hippo365` (embeddings off), `runner/run_retrieval.py --bench longmemeval-s` with `HIPPO_SERVER_DIST=<arm>/dist`. Each memory keeps its haystack date. Metric: evidence recall at top 10 and top 50, `longmemeval_evidence_recall.py --k 10,50 --baseline <A>`, 4,000 paired draws. Both cutoffs must pass non-inferiority. Knowledge-update and temporal-reasoning are named secondary reads with their own paired CIs.

Per-category CIs and the alive share come from `docs/evals/rank-age/paired_by_type.py`, which reuses each scorer's `score_run`.

## Reported, not gated

**R1, DolphinBench replay on the built code.** `dolph_ablate.mjs` default variant on A's `dist/` and on B's `dist/`, paired. Evidence recall, any source shown, and `dolph_flip.py` counts of tests gained and lost. The losing tests are classified by whether the needed session is the newest version of a fact that changed. The same counts are given for the replay's `neither` variant.

**R2, sleep on long histories.** Sleep makes a memory dormant below strength 0.05 (`src/domain/consolidate/decay.ts:17`). On copies of the v3 stores, with the clock at each persona's test date, count the entries below 0.05 under the production model and the gold evidence sessions among them. Report R1 on B with those entries removed. This checks the decay step only; merge is not simulated.

**O1, DolphinBench agent rerun.** The hippo arm on A and on B, in the same window, with the same method and model as the v3full runs. Pass rate, paired over tests, and each against the keyword control. This is the outcome measure. It runs when Claude subscription tokens allow. If tokens allow only B, the result file first gives the share of tests where A's replay list equals v3full's list and states the drift risk.

## What a pass allows

If G1, G1b, G2 and G3 pass and every alive check passes, B merges to master. O1 reports after. If any guard fails, B does not merge. The failure and the next route go in the result file. The named next route for a cleanStaleR5 or s\* failure is an arm with `newestOnTopicFirst` on by default (`src/api/recall/rank-stages.ts:200-239`), which demotes the older of two near-duplicate top hits.

A pass supports one claim: on long histories, hippo's recall no longer buries a relevant memory because of its age. It does not support a claim against any competitor until O1 runs. On the replay, B still trails plain BM25 order by 0.5 pp (53.7% against 54.2%). The change removes a harm; it adds nothing over BM25 there.

## Scope

- The per-prompt hook block ranks by token overlap and never reads strength (`src/base/rank/prompt-recall.ts:70-85`, `src/api/context/context-select.ts:173-193`). It does not change. The change reaches `hippo recall`, MCP and HTTP recall, multihop and `hippo context` with a query.
- `hippo context` with no query still picks memories by decayed strength.
- Age stays in rank on purpose in `newestOnTopicFirst` (`--evc-adaptive`) and `temporalBoost` (cue words such as "last" and "current").
- The LIKE fallback (CJK, terms under 3 characters, stores with no FTS) scans the newest 2,000 rows. The opt-in utility rerank reads stored, decayed strength. Physics search is off by default. These are out of scope.
- `lossAversionRatio`, the emotional weight and pinning stop acting on the recall rank. They still act in sleep.

## NOT-DONE

- E1 never writes `superseded_by`, so G1 and G1b see only rank-driven stale effects.
- A use lift (recall count as a rank boost) is not part of B. If wanted, it is its own registration: B-lift against B, scheduled recalls on reworded queries, capped at 1.15, counting only recalls from a query.

## Amendment before any arm B run (2026-11-16)

Written after the lock and before any arm B run on any measure. Three points of the Arms section do not match the built B:

- The function is `rankStrengthMultiplier` in `src/domain/search/boosts.ts`, not `strengthRecencyMultipliers`. The formula is the one above.
- A decision save does **not** set `superseded_by` on the memory it replaces. `alsoWrite` never gets the new mirror's id, and the stored stale mark (set by `markStale`, as before) already demotes the row in rank. So the stale factor is the only rank effect of a decision replace. This changes no guard, metric or rule.
- `staleShare` is also 0.5 when the row has a successor link (`superseded_by`, read through `isSuperseded`). The `supersede` write sets only that link, never a stale mark, so without this a recall that keeps superseded rows would rank a replaced row by match alone. An `asOf` rank skips the link, because its pool holds only rows current at that date. Default recall drops superseded rows before the rank, and E1 never writes the link, so G1 and G1b do not see it. The pinned-order tests found it.
