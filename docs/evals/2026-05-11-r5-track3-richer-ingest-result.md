# LongMemEval R@5 target — Track 3 (F10) richer-ingest result

**Date:** 2026-05-11
**Plan:** `docs/plans/2026-05-11-r5-track3-richer-ingest.md`
**Prereg:** `docs/evals/2026-05-11-r5-track3-richer-ingest-prereg.md`
**Predecessors:** F6 (features-default R@5 = 75.4%), F8 (hybrid tuning R@5 = 76.8%), F9 v2 (sub-agent LLM rerank R@5 = 78.0%), F11 (bge-base R@5 = 77.0%).

This release does not re-assert the retracted −10pp magnitude.

---

## TL;DR

- **Gate-A (signal coverage):** PASS. 940/940 memories have at least one non-default signal value; 3 of 5 signal fields exceed 50% non-default coverage (`confidence` 75.4%, `schema_fit` 93.3%, `strength` 80.7%).
- **Gate-B (proven value at R@5):** FAIL. features-enriched R@5 = 59.2%. The prereg locked threshold = 80.4% (= F6's MiniLM-era features-default 75.4% + 5pp); the apples-to-apples re-measurement on bge-base gives features-default 75.8% and threshold 80.8%. The FAIL verdict holds under both thresholds (59.2 < 80.4 and 59.2 < 80.8); the result doc uses the re-measured 80.8% as the binding number for the same-embedding-space comparison.
- **HARD RETRACTION triggers** per prereg failure-handling. `src/rerankers/features.ts` + `tests/rerankers/features.test.ts` + `benchmarks/micro/fixtures/reranker-features.json` + the `'features'` dispatcher case in `src/rerankers/index.ts` are removed in the follow-up commit (Tasks 11-13).
- Roadmap target R@5 ≥ 85% NON-binding per prereg; NOT MET. Current cross-track best remains F9 v2's R@5 = 78.0% (sub-agent LLM rerank on MiniLM).

**Hypothesis (post-hoc, supported by but not isolated from the data):** the features reranker is the wrong abstraction for this corpus. Re-weighting candidates by session-level signals (confidence, kind, schema_fit, strength, outcome_pos/neg) appears to introduce variance that is orthogonal to query-document relevance. The hypothesised mechanism — re-weighting by signals that reflect SESSION-level properties rather than QUERY-DOCUMENT relevance — is consistent with the observed across-category regression (features-enriched is below features-default in all 6 categories), but a controlled mechanism-isolation experiment is out of scope for this release.

---

## Provenance

- Dataset: `data/longmemeval_oracle.json`, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`.
- Source store: `hippo_store2/` (940 sessions, ingested by F6 via `ingest_direct.py`; re-embedded with `Xenova/bge-base-en-v1.5` in F11).
- Enriched store: `hippo_store_enriched/` (940 sessions, ingested by `benchmarks/longmemeval/ingest_enriched.py` consuming `benchmarks/longmemeval/data/signals.jsonl`; embedded with `Xenova/bge-base-en-v1.5`).
- Embedding-model compatibility gate (Task 8 step 1): PASS. Both stores recorded `Xenova/bge-base-en-v1.5` in `meta.embedding_model` (F11 result doc, Gate verdicts section confirms `hippo_store2`'s value).
- Subagent enrichment dispatch (Task 4): 19 invocations, 4 waves of 5 (last wave 4), Claude Sonnet via `general-purpose` subagent. All 19 batches produced valid JSON output (50 sessions each for batches 000-017; 40 sessions for batch 018; total 940 signal records).
- Subagent wall-time actuals: each invocation ≈ 60-115 s. 4 waves × ≈ 90 s = approx 6-7 minutes wall (faster than the prereg's 15-25 min estimate due to controller-side parallel dispatch).
- Subagent cost: not directly measured per-call; aggregate Sonnet tokens within the prereg's pre-registered ≤ $2 envelope.
- Ingest wall time: `ingest_enriched.py` 940 sessions in 0.7 s.
- Re-embed wall time (enriched store, bge-base FP16 on CPU): 11 min 8 s (overlap with concurrent retrieval pass on `hippo_store2`).
- `embeddings.json` size: 15 MB (both stores; 940 × 768-dim vectors).
- Harness command:

```bash
HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache \
  node benchmarks/longmemeval/retrieve_inprocess.mjs \
    --data data/longmemeval_oracle.json \
    --store-dir <hippo_store2|hippo_store_enriched> \
    --output results/f10_enrichment/<run>.jsonl \
    [--reranker features] \
    --embedding-weight 0.5 --mmr-lambda 0.7 --budget 50 --min-results 5
```

- Evaluator command:

```bash
python3 benchmarks/longmemeval/evaluate_retrieval.py \
  --retrieval results/f10_enrichment/<run>.jsonl \
  --data data/longmemeval_oracle.json \
  --output results/f10_enrichment/<run>.eval.json
```

---

## Signal distribution (`signals.jsonl`, 940 records)

| field | values |
|---|---|
| `confidence` | observed=525, verified=231, inferred=184, stale=0 |
| `kind` (extracted) | episodic=552, semantic=302, procedural=86 |
| `kind` (used in DB) | raw=940 (see "Known limitation" below) |
| `schema_fit` distribution | 0.4: 12, 0.6: 191, 0.8: 540, 1.0: 197 |
| `strength` distribution | 0.5: 5, 1.0: 360, 1.5: 521, 2.0: 54 |
| `outcome_positive` | 0: 501, 1: 360, 2: 78, 3: 1 |
| `outcome_negative` | 0: 852, 1: 79, 2: 9, 3: 0 |

### Known limitation: `kind` namespace mismatch

The plan's signal-extraction prompt asked sub-agents to label each session's `kind` as `episodic | semantic | procedural` (content type). However, the hippo DB schema enforces `kind ∈ {raw, distilled, superseded, archived}` (provenance / lifecycle) via SQLite triggers in `src/db.ts` lines 310-352, and `src/rerankers/features.ts`'s `KIND_WEIGHT` table uses the same four lifecycle values.

The two namespaces are unrelated. The prompt's `kind` values cannot be written to the DB without violating the schema constraint, and would not match `KIND_WEIGHT` keys (silently falling back to weight 1.0) even if they could.

Resolution: `ingest_enriched.py` hardcodes `kind = "raw"` for all 940 sessions. The prompt's `kind` field is recorded in `signals.jsonl` but discarded by the ingest. The other 4 signal fields (`confidence`, `schema_fit`, `strength`, `outcome_positive`/`outcome_negative`) match the consumer schema and DO carry through to the reranker.

This is a planning bug that escaped both the parent-plan outside-voice review and the prereg outside-voice review. Recorded here as a known limitation. It affects only the `kind`-dimension signal density (one of five extracted fields); the other four fields satisfy Gate-A independently (see Gate-A section).

---

## Gate-A — signal coverage

Operationalised: a sqlite query counts how many memories have at least one signal field differing from its neutral default.

```
total memories                                : 940
any-field non-default                         : 940 (100.0%)   threshold ≥ 752 (80%)
  confidence != 'verified'                    : 709 (75.4%)
  schema_fit != 0.5                            : 877 (93.3%)
  strength != 1.0                              : 759 (80.7%)
  outcome_positive > 0                         : 439 (46.7%)
  outcome_negative > 0                         :  88 (9.4%)
fields with ≥ 50% non-default coverage        : 3/5            threshold ≥ 3
```

**Gate-A verdict: PASS.** Both binding conditions met.

---

## Gate-B — proven value at R@5

Three retrieval passes against the F8 winning hyperparameters (`embeddingWeight=0.5, mmrLambda=0.7, budget=50, minResults=5`), all on the bge-base embedding model.

### Overall R@K

| run | store | reranker | R@1 | R@3 | R@5 | R@10 | answer_in_content@5 |
|---|---|---|---:|---:|---:|---:|---:|
| baseline-default (F11) | hippo_store2 | none | 50.8% | 66.8% | 77.0% | 77.0% | 49.8% |
| baseline-enriched | hippo_store_enriched | none | 47.0% | 66.6% | 73.4% | 73.4% | 48.2% |
| features-default | hippo_store2 | features | 51.0% | 68.2% | 75.8% | 75.8% | 49.4% |
| features-enriched (Gate-B candidate) | hippo_store_enriched | features | 33.8% | 51.2% | 59.2% | 59.2% | 41.4% |

All raw values; no Δ-pp prose.

### Per-type R@5

| category | n | baseline-default | baseline-enriched | features-default | features-enriched |
|---|---:|---:|---:|---:|---:|
| knowledge-update | 78 | 94.9% | 88.5% | 93.6% | 70.5% |
| multi-session | 133 | 74.4% | 70.7% | 70.7% | 61.7% |
| single-session-assistant | 56 | 100.0% | 100.0% | 100.0% | 83.9% |
| single-session-preference | 30 | 30.0% | 20.0% | 23.3% | 13.3% |
| single-session-user | 70 | 70.0% | 64.3% | 71.4% | 30.0% |
| temporal-reasoning | 133 | 73.7% | 72.9% | 74.4% | 65.4% |

features-enriched regresses on every category vs. features-default; the single-session-user regression is the largest at 71.4 → 30.0.

### Verdict

**Gate-B verdict: FAIL.** Measurable evidence: features-enriched R@5 = 59.2%; threshold per prereg = features-default R@5 + 5pp = 75.8 + 5 = 80.8%. Shortfall = 21.6pp.

Two observations:

1. Even the no-reranker comparison degrades on the enriched store: baseline-enriched R@5 = 73.4% vs baseline-default 77.0%. The hybrid search's physics-state init consumes the per-memory `strength` and other signal fields; non-uniform per-memory `strength` values (clipped to [0.5, 2.0]) shift the physics-derived scores in ways that, on this corpus, degrade ranking. This effect is independent of the features reranker.

2. The features reranker compounds the damage: 73.4% (baseline-enriched, no reranker) → 59.2% (features-enriched, reranker on) = additional 14.2pp regression. The reranker's per-memory multipliers (`confW ∈ [0.70, 1.30]`, `schemaFitW ∈ [0.7, 1.0]`, `strengthW ∈ [0.8, 0.998]`, `outcomeW ∈ [0.93, 1.07]`) introduce variance that does not correlate with query-document relevance. Session-level signal values reflect SESSION properties (how confident-sounding the user was, what kind of session it is, etc.) rather than whether the session contains the answer to a specific query.

### Retraction protocol — HARD RETRACTION fires

Per the prereg's Gate-B FAIL clause, the features reranker mechanism is removed from `src/`. Specifically:

- `git rm src/rerankers/features.ts`
- `git rm tests/rerankers/features.test.ts`
- `git rm benchmarks/micro/fixtures/reranker-features.json`
- Edit `src/rerankers/index.ts` to remove the `'features'` case from the reranker dispatcher.

These changes land in a follow-up commit, per plan Tasks 11-13. The commit body cites this result doc, names every removed file, and ships the verbatim retraction sentence.

---

## Roadmap-target framing

Roadmap target R@5 ≥ 85% per `ROADMAP-RESEARCH.md`. **NON-binding** per the F10 prereg.

Observed best R@5 across all tracks executed so far:

- F8 hybrid tuning (MiniLM): 76.8%
- F9 v2 sub-agent LLM rerank (MiniLM): 78.0%
- F11 bge-base baseline (no reranker): 77.0%
- F10 features-enriched (bge-base, features reranker): 59.2% (this result)

Roadmap target NOT MET by any track. The 85% target remains an open question; future tracks would need a different mechanism — most likely a cross-encoder reranker trained on query-document pairs (currently blocked by the HF egress restriction documented in F11) or a richer query-aware retrieval mechanism.

---

## Cumulative-null status

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's cumulative-null status is independent of this evaluation. F10 changes the contents of memory rows (entry-level signal columns in the enriched store) but does not alter the goal-stack mechanism in `src/`. The features reranker's removal on Gate-B FAIL (Tasks 11-13 follow-up) is a per-mechanism honesty action — the reranker did not move R@5 by the binding threshold even when given real signals, so it gets retired. This is independent of the cumulative-null escalation status documented in RETRACTION.md.

---

## What this implies for hippo's reranker abstraction

The features reranker (Track 1 of the F6 reranker hardening) was hypothesised to add value when ingest populated entry-level signals. F10 tested that hypothesis with sub-agent-extracted signals on 75.4% of memories' `confidence`, 93.3% of `schema_fit`, 80.7% of `strength`, and partial coverage on outcome counters — a stronger signal density than any realistic production deployment would achieve via heuristic ingest. Observed: features-enriched R@5 = 59.2 vs features-default R@5 = 75.8 on the same store.

Hypothesis consistent with the data: session-level signals (how confident-sounding a session is, what content-type it represents, etc.) are not the right axis along which to discriminate candidate memories during retrieval — the right axis is query-document relevance, which requires query-aware scoring (cross-encoder rerank, LLM rerank, or query-conditioned features). This is not isolated from confounds (signal-extraction noise, physics-state interactions, etc.) by a controlled mechanism-isolation experiment.

The features reranker code path is retired regardless of which causal hypothesis is correct: Gate-B requires features-enriched ≥ features-default + 5pp, and the FAIL is unambiguous. The dispatcher case is removed in the follow-up commit.

---

## Outside-voice review trail

### Review (2026-05-11, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS_WITH_NOTES (15/15 checks).

Summary of per-check results:

1. Verbatim retraction sentence — PASS (line 8).
2. Strict magnitude grep — PASS (0 matches).
3. Soft-magnitude scan — PASS (no smuggling; one ordinal "largest" flagged as low-risk).
4. Gate-A PASS with measurable evidence — PASS.
5. Gate-B FAIL with both observed (59.2) and threshold shown — PASS (after fix).
6. HARD RETRACTION 4 file paths enumerated — PASS.
7. "Wrong abstraction" framing honest — PASS (after the hypothesis hedge fix).
8. R@K table honest (raw values, no Δ-pp prose) — PASS.
9. Per-type table both directions — PASS (all 6 categories shown).
10. Known limitation (kind-namespace) honestly disclosed with src/db.ts + features.ts references — PASS.
11. Roadmap NON-binding explicit — PASS.
12. Cumulative-null cite `docs/RETRACTION.md:94-113` — PASS.
13. Cross-track baseline honest (R@5=78.0 F9 v2 named as current best) — PASS.
14. Provenance complete (both store ids, embedding-model parity, dispatch shape, signal distribution, wall times) — PASS.
15. No causal over-claims — PASS (after the hypothesis hedge fix).

**Required fixes:** none remaining after the two notes were applied:
- Threshold deviation (prereg 80.4 vs re-measured 80.8) explicitly acknowledged; FAIL holds under both.
- TL;DR causal claim softened from "is the wrong abstraction" to "Hypothesis (post-hoc, supported by but not isolated from the data)".

Controller authorised to proceed with Tasks 11-13 (HARD RETRACTION).
