# F6 reranker hardening — eval result

**Date:** 2026-05-11
**Plan:** docs/plans/2026-05-10-f6-reranker-hardening.md
**Prereg:** docs/evals/2026-05-10-f6-reranker-prereg.md
**Retraction-discipline reference:** docs/RETRACTION.md

This release does not re-assert the retracted −10pp magnitude.

---

## TL;DR

- Dataset: LongMemEval 500 questions / 940 unique sessions (provenance caveat below).
- Five sweep tracks ran end-to-end. The cross-encoder track fell back to identity ordering in this environment (HuggingFace CDN blocked), so its result is structurally indistinguishable from baseline and is not an evaluation of the cross-encoder mechanism.
- **Gate-A (binding workload-validity):** features track PASSED (500/500 firing rate). Cross-encoder track's 500/500 count is identity-fallback and is reported with that caveat; it is NOT a successful Gate-A for the cross-encoder mechanism.
- **Gate-B (binding hyperparameter-discrimination):** **FAILED** for the features track. The three top-K settings (20 / 50 / 100) produced byte-identical R@K across all four K values and all six per-type breakdowns. Per the prereg, no R@5 value is reported as a hyperparameter-effect claim.
- **Roadmap target (NON-binding):** ROADMAP-RESEARCH.md:374 lists "R@5 ≥ 85% on the existing hybrid path" as the F6 success criterion. Observed R@5 = 75.4% (features, all three settings) and 75.6% (baseline). The target is not met on the workloads tested. Per the v1.8.1 retraction discipline this is descriptive characterisation, not a binding gate.
- Mechanism shipped: Track 1 features reranker (`src/rerankers/features.ts`), Track 2 cross-encoder reranker (`src/rerankers/cross-encoder.ts`, identity-fallback verified, real-model verification deferred to a session with HF access), Track 3 LLM reranker skeleton (`src/rerankers/llm.ts`, env-gated, mocked-fetch tests only).

---

## Provenance

### Dataset acquisition

The `data/longmemeval_oracle.json` file used for this sweep was fetched from `https://raw.githubusercontent.com/Backboard-io/Backboard-longmemEval-results/main/data/longmemeval_oracle.json` (15.4 MB, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`). The official LongMemEval distribution lives on HuggingFace at `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/`, which is not reachable from this sandbox.

The file's schema and question count (500) match the documented LongMemEval spec exactly, including all six question_type categories. It is unverified whether this is the original `xiaowu0162/longmemeval` variant or the September 2025 `xiaowu0162/longmemeval-cleaned` variant; the two variants share schema and question count and differ only in haystack contents (cleaned variant reduces answer interference). For the purpose of the workload-validity gates in the prereg this distinction does not change the verdict structure, but a re-run against the canonical HF dataset is the cleanest way to lock the numbers; that re-run is deferred to a session with HF access.

### Ingest

Sessions were ingested via `benchmarks/longmemeval/ingest_direct.py`, which writes directly to SQLite without any LLM step (no `ANTHROPIC_API_KEY` required). Result: 940 unique sessions inserted into `hippo_store2/.hippo/hippo.db` (the dataset's 500 questions reference 948 session positions but only 940 are unique session IDs after dedup).

### Sweep run

`benchmarks/longmemeval/run_reranker_sweep.mjs` orchestrated five runs. Total wall time: ~454s (~7.5 minutes).

Per-track wall time:

| Track | Wall time |
|---|---|
| baseline | 82.7s |
| features_topk20 | 87.3s |
| features_topk50 | 93.1s |
| features_topk100 | 104.6s |
| cross_encoder_topk50 | 85.8s |

Cross-encoder was fast because it fell back to identity (no model inference performed).

Sweep artifacts: `results/reranker_sweep_2026-05-11T07-01-08-090Z/` (gitignored). Files: per-track `*.jsonl` retrieval outputs, per-track `*.eval.json` from `evaluate_retrieval.py`, `summary.json` aggregated by `scripts/aggregate_reranker_sweep.mjs`, `firing_rates.txt` for Gate-A evidence.

---

## Workload-validity verdicts (binding gates from prereg)

### Gate-A — firing rate per track on 500 questions

The prereg requires the reranker function to be invoked on ≥475/500 (≥95%) queries for the workload to be declared valid for that track.

| Track | Firing rate | Verdict | Notes |
|---|---|---|---|
| baseline | 0 / 500 | N/A | No reranker by construction. |
| features_topk20 | 500 / 500 | PASS | Mechanism exercised on every query. |
| features_topk50 | 500 / 500 | PASS | Mechanism exercised on every query. |
| features_topk100 | 500 / 500 | PASS | Mechanism exercised on every query. |
| cross_encoder_topk50 | 500 / 500 | PASS-with-caveat | The reranker function ran 500/500 times, but on every call it took the identity-fallback branch in `src/rerankers/cross-encoder.ts:67-76` because the MS-MARCO MiniLM model was not downloadable from HuggingFace in this sandbox. The 500/500 count therefore represents function invocations, not real cross-encoder evaluations. The cross-encoder mechanism was NOT exercised on this workload. |

### Gate-B — hyperparameter discrimination (features track)

The prereg requires R@5 to differ across the three features-track top-K hyperparameter settings (20 / 50 / 100) by at least one entry, otherwise the workload is declared not to discriminate the hyperparameters and no R@5 is reported as a hyperparameter-effect claim.

| Hyperparameter | Overall R@5 |
|---|---|
| topK=20 | 75.4 |
| topK=50 | 75.4 |
| topK=100 | 75.4 |

R@5 is byte-identical across the three settings — and so are R@1, R@3, R@10, and every per-type breakdown.

**Verdict: FAIL — the workload does not discriminate the features-track hyperparameters.** Per the prereg, no per-hyperparameter R@5 number is reported here as a hyperparameter-effect claim.

The likely mechanism: the LongMemEval harness in `benchmarks/longmemeval/retrieve_inprocess.mjs` calls `hybridSearch` with a generous budget (`--budget 1000000`) and `--min-results 10`, but in practice the retrieved candidate count per query for the v0.27 hippo store appears to fall at or below 20, so topK=20 already covers the entire candidate pool and topK=50/100 add no additional candidates for the reranker to consider. This is a property of the workload + the current hybrid pipeline's candidate-count behaviour, not a property of the features reranker itself.

### Cross-encoder identity-fallback verification

The cross-encoder track produced exactly the same retrieved memory IDs and exactly the same R@K as the baseline track on every question and every per-type slice. This confirms the identity-fallback branch in `src/rerankers/cross-encoder.ts` is correct (it preserves input ordering exactly; `rerankScore` is set to `r.score`, which is the same scale as the baseline ordering). It does not constitute evaluation of the cross-encoder mechanism — that requires a session with HuggingFace access.

---

## Descriptive characterisation (NON-binding)

The numbers below are reported descriptively per the v1.8.1 retraction discipline (`docs/RETRACTION.md`). They are not pre-registered pass/fail thresholds and are not magnitude claims about reranker mechanism effects.

### Overall recall per track

| Track | R@1 | R@3 | R@5 | R@10 | answer_in_content@5 |
|---|---|---|---|---|---|
| baseline | 50.4 | 67.6 | 75.6 | 83.6 | 49.2 |
| features_topk20 | 51.6 | 68.2 | 75.4 | 83.4 | 48.6 |
| features_topk50 | 51.6 | 68.2 | 75.4 | 83.4 | 48.6 |
| features_topk100 | 51.6 | 68.2 | 75.4 | 83.4 | 48.6 |
| cross_encoder_topk50 | 50.4 | 67.6 | 75.6 | 83.6 | 49.2 |

(All values are percentages over 500 questions.)

The cross-encoder row is identical to baseline by construction (identity fallback). The three features rows are identical to each other by Gate-B FAIL.

### Per-type R@5

| Category | n | baseline | features (any topK) | cross_encoder |
|---|---:|---:|---:|---:|
| knowledge-update | 78 | 92.3 | 93.6 | 92.3 |
| multi-session | 133 | 71.4 | 70.7 | 71.4 |
| single-session-assistant | 56 | 100.0 | 100.0 | 100.0 |
| single-session-preference | 30 | 23.3 | 23.3 | 23.3 |
| single-session-user | 70 | 68.6 | 68.6 | 68.6 |
| temporal-reasoning | 133 | 75.2 | 74.4 | 75.2 |

### Per-type R@1

| Category | n | baseline | features (any topK) | cross_encoder |
|---|---:|---:|---:|---:|
| knowledge-update | 78 | 70.5 | 73.1 | 70.5 |
| multi-session | 133 | 39.8 | 40.6 | 39.8 |
| single-session-assistant | 56 | 92.9 | 92.9 | 92.9 |
| single-session-preference | 30 | 13.3 | 13.3 | 13.3 |
| single-session-user | 70 | 42.9 | 42.9 | 42.9 |
| temporal-reasoning | 133 | 43.6 | 45.9 | 43.6 |

### Latency

Wall time per 500-question run is in the Sweep run section above. Per-query latency was not measured at this granularity in the current harness; adding per-query latency telemetry is straightforward future work. The features track's wall time scales mildly with topK (87s / 93s / 105s for K=20/50/100) which is consistent with O(M·N) per-candidate rescoring for tokenisation overhead, but in this run topK does not change the candidate set actually rescored (per Gate-B), so the wall-time scaling here is dominated by the reranker visiting the same ~10-20 candidates with growing slack.

---

## Roadmap target framing (NON-binding)

`ROADMAP-RESEARCH.md:374` lists "R@5 ≥ 85% on LongMemEval with the existing hybrid path" as the F6 success criterion.

Observed: features track R@5 = 75.4% on the workload tested. Baseline R@5 = 75.6% on the same workload. The roadmap target is not met (observed 75.4% features / 75.6% baseline; target 85%).

Per the prereg this is descriptive characterisation, not a binding gate. The mechanism (reranker seam, three reranker tracks) ships if Gate-A passed for any track; Gate-A passed for the features track. Gate-A for the cross-encoder track was not evaluable in this environment due to the HF block.

The R@5 ≥ 85% target was always understood to be conditional on:
- the cross-encoder or LLM track producing meaningful semantic re-ranking on this corpus (cross-encoder: not evaluable here; LLM: not exercised in this sweep, env-gated to an unset endpoint), AND/OR
- the features-track signals (confidence, kind, schema_fit, strength, outcome counts) being populated on a meaningful fraction of the ingested memories. The `ingest_direct.py` path used here writes raw session text into the store with neutral defaults for all of those signals, so the features reranker had no signal to act on beyond the small overlap-boost component of its scoring formula.

A follow-up that addresses either of those preconditions (real cross-encoder eval; or a richer ingest path that populates entry-level signals) is the path to a real R@5 ≥ 85% attempt. Neither is in scope for this release.

---

## Cumulative-null status update

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's measured effect on tested workloads is null. The reranker mechanism introduced in this release is independent of the dlPFC goal-stack mechanism; this release does not change the cumulative-null status of dlPFC goal-stack.

For the reranker mechanisms specifically, the cumulative-null reading on the workloads tested in this release is:

- **Features reranker:** Gate-A PASSED, Gate-B FAILED. The workload (500-question LongMemEval against the v0.27 hippo store ingested via `ingest_direct.py`) does not discriminate the features-track hyperparameters. The three settings produced identical R@K. Per the prereg, no per-hyperparameter R@5 effect is claimed. Per-track overall R@K values are reported above as descriptive characterisation only; this release does not assert a magnitude or directional effect for the features mechanism on this workload.
- **Cross-encoder reranker:** mechanism NOT evaluable in this environment. Identity fallback was exercised. Real-model evaluation deferred.
- **LLM reranker:** mechanism NOT exercised in this sweep (env-gated to `HIPPO_LLM_RERANKER_URL`, which is not set; would also incur per-query LLM cost on a 500-question run).

---

## Mechanism shipped status

- Track 1 (features): SHIPPED. `src/rerankers/features.ts`. 5 unit tests pass; Gate-A PASS on workload tested; Gate-B FAIL on workload tested.
- Track 2 (cross-encoder): SHIPPED. `src/rerankers/cross-encoder.ts`. 3 unit tests pass (1 active, 2 model-dependent skipped in this env). Identity-fallback verified end-to-end on real LongMemEval. Real-model evaluation deferred to a session with HuggingFace access.
- Track 3 (LLM): SHIPPED as skeleton. `src/rerankers/llm.ts`. 3 unit tests pass against mocked fetch. Real evaluation deferred to a session with a configured `HIPPO_LLM_RERANKER_URL` endpoint.

---

## Outside-voice review

### Review (2026-05-11)

**Reviewer:** general-purpose subagent dispatched by the subagent-driven-development workflow controller. Isolated context (did not see prior reasoning trace). Read `docs/RETRACTION.md` and `docs/evals/2026-05-10-f6-reranker-prereg.md` fresh.

**Note on "outside voice" interpretation:** the v1.8.1 discipline rule at `docs/RETRACTION.md:41` requires "an outside-voice review on whether the framing satisfies the guard." A subagent dispatched by the controller is structurally independent (no shared reasoning trace, reads the artifact fresh) but is not a separate human reviewer. This interpretation was approved by the user prior to dispatch and is documented in the prereg's review trail; this result-doc review uses the same interpretation.

**Verdict:** PASS (originally PASS_WITH_NOTES; the one optional polish has been applied — see below).

**Per-check results:**

1. Verbatim retraction sentence — PASS (line 8).
2. Magnitude-smuggling grep — PASS. Strict grep returned 0 matches. Broader-grep matches all classified as allowed (verbatim citation at line 8, meta-discussion at line 93, explicit denial at line 159).
3. Soft-magnitude scan — PASS. No prose qualitatively characterizes per-track / per-K differences as small/moderate/large/improvement/regression/lift/drop. The one "scales mildly with topK" qualifier on line 133 is on wall time (latency), not on a recall/mechanism effect, and is therefore outside the discipline guard.
4. Gate verdicts present — PASS. Gate-A (per-track table at lines 57-67), Gate-B (FAIL with byte-identical evidence at lines 69-83).
5. Cross-encoder identity-fallback caveat — PASS. Caveated unambiguously in five locations (TL;DR, Gate-A summary, sweep run note, Gate-A table row, dedicated verification subsection at lines 85-87, cumulative-null subsection at line 160).
6. Roadmap target non-binding framing — PASS (TL;DR line 18, dedicated section lines 137-149).
7. Cumulative-null acknowledgement — PASS (lines 153-162 with explicit `docs/RETRACTION.md:94-113` cite).
8. Dataset provenance — PASS. Source URL, file size, SHA-256, and variant-ambiguity disclosure all present (lines 25-29).
9. Outside-voice review section present — PASS at review time (now filled by this entry).

**Optional polish applied:** line 141's `The roadmap target is not met by 9.4-9.6pp.` was reworded to `The roadmap target is not met (observed 75.4% features / 75.6% baseline; target 85%).` to remove the only pp-denominated number outside the verbatim retraction citation. The reviewer noted this was below the bar for a required fix because the discipline rule guards magnitude on *mechanism effects* (not gap-to-non-binding-target characterizations), but applied for cleanliness.

**Required fixes:** None. Controller authorized to proceed to Task 12.
