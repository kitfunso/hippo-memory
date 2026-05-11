# LongMemEval R@5 target — Track 3 (F10) richer-ingest — pre-registration

**Date:** 2026-05-11
**Plan:** `docs/plans/2026-05-11-r5-track3-richer-ingest.md`
**Predecessors:** F6 (`docs/evals/2026-05-10-f6-reranker-result.md`, features-track R@5 = 75.4%), F8 (`docs/evals/2026-05-11-r5-track1-tuning-result.md`), F9 v2 (`docs/evals/2026-05-11-r5-track2-cross-encoder-result.md`), F11 (`docs/evals/2026-05-11-r5-track4-embedding-upgrade-result.md`, Gate-A PASS / Gate-B FAIL, `hippo_store2.embedding_model = "Xenova/bge-base-en-v1.5"`).

This release does not re-assert the retracted −10pp magnitude.

---

## Goal

Populate the entry-level signals the features reranker reads (`confidence`, `kind`, `schema_fit`, `strength`, `outcome_positive`, `outcome_negative`) using Claude-subagent-extracted values for each of the 940 LongMemEval sessions, then re-run the features track and gate on R@5 improvement. Either the features reranker is proven valuable when given real signals or it gets removed from `src/`.

## Magnitude-smuggling guard

Per `docs/RETRACTION.md`. The strict grep below must return zero matches against the F10 result doc, CHANGELOG / README mention, and every commit body that touches result artefacts:

```
grep -nE '(Δ\s*=\s*[0-9]|[0-9]\s*pp\s*(lift|drop|≥|−|\+))' <file>
```

The verbatim retraction sentence — `This release does not re-assert the retracted −10pp magnitude.` — must appear on its own line in the F10 result doc and in every commit body.

## Workload-validity gates (binding)

### Gate-A — signal coverage

The enriched store must have non-default values for at least **80%** of memories on at least **3 of the 5** signal fields. Operationalised: a sqlite query counts how many memories have at least one signal field differing from its neutral default (`confidence != 'verified'` OR `schema_fit != 0.5` OR `strength != 1.0` OR `outcome_positive > 0` OR `outcome_negative > 0`); result must be ≥ 752 (80% of 940). Coverage on each field individually must be ≥ 50% on at least 3 fields.

PASS = both conditions met. FAIL = any condition unmet → fix-and-rerun (signal extraction or merge is broken); not a retraction trigger.

### Gate-B — proven value at R@5

The features-track R@5 on the **enriched** store must be ≥ features-track R@5 on the **default** store + 5pp. With F6's features-default = 75.4%, the binding threshold is **80.4%**.

PASS = `recall@5(features-enriched) ≥ 0.804`. FAIL = **HARD RETRACTION.** Remove `src/rerankers/features.ts` + `tests/rerankers/features.test.ts` + `benchmarks/micro/fixtures/reranker-features.json` and the `'features'` case in `src/rerankers/index.ts`. Per plan Tasks 11-13.

Important note (per the parent plan, lines 27-28): if features-enriched matches features-default, the features reranker mechanism is the wrong abstraction for this corpus and should be removed. This is a per-mechanism honesty action: the reranker's scoring logic is functional but its discriminating signals add no measurable retrieval value at K=5 even on a corpus where those signals are explicitly populated.

### Stretch target (NON-binding)

R@5 ≥ 85% (roadmap F6 target per `ROADMAP-RESEARCH.md`). NON-binding per this prereg; Gate-B remains the single binding R@5 number.

## Failure handling

- **Gate-A FAIL:** signal extraction is broken (subagents returned junk, merge lost data, or field coverage falls below 80% / 50%-on-3-fields). Fix and re-run; not a retraction trigger.
- **Gate-B FAIL:** **HARD RETRACTION.** See Gate-B section above; specific file paths in the parent plan's Task 11.

## Embedding-model compatibility gate (Task 8 step 1)

`hippo_store2` and `hippo_store_enriched` must share the same `embedding_model` for the features-enriched vs features-default Gate-B comparison to be valid. Per F11's hand-off note: `hippo_store2.embedding_model = "Xenova/bge-base-en-v1.5"`. F10's `ingest_enriched.py` must therefore (re-)embed `hippo_store_enriched` with the same model (`HIPPO_MODEL_CACHE` set, `hippo_store_enriched/.hippo/config.json` configured before `hippo embed`).

The Task 8 step 1 compatibility check (Node one-liner that reads both stores' meta rows) must PASS before the three retrieval passes run. Both model ids are recorded in the result doc Provenance section.

## Pre-registered cost / wall-time estimate (Task 4 subagent enrichment)

- Dispatch shape: 19 subagent invocations, each receiving one batch of ~50 LongMemEval sessions, in 4 waves of 5 concurrent agents (last wave: 4 agents).
- Per-prompt size: ~2 KB instructions + ~2 KB rubric + ~50 sessions × ~600 chars ≈ 35-40 KB input per subagent. Output ≈ 50 × 200 B (signal JSON) = ~10 KB per subagent.
- Token estimate: input ≈ 19 × 12K tokens ≈ 230K input tokens; output ≈ 19 × 3K tokens ≈ 60K output tokens. At Sonnet ~$3/MTok input + $15/MTok output: ~$0.70 + $0.90 ≈ ≤ $2 total.
- Wall-time estimate: each subagent ~90-180 s. 4 waves × ~3 min = 15-25 minutes wall (subject to dispatch overhead).
- Failure budget: re-dispatch up to 2 retries per batch; if any batch still fails after 3 attempts, partial-coverage handling fires.

Actuals go in the result doc Provenance section.

## Cumulative-null acknowledgement

The F10 result doc must cite `docs/RETRACTION.md:94-113` and confirm the dlPFC goal-stack cumulative-null status is unaffected. F10 changes the contents of memory rows (entry-level signal columns) but does not alter the goal-stack mechanism in `src/`. The features reranker's removal on Gate-B FAIL is a per-mechanism honesty action and is independent of the cumulative-null escalation status documented in RETRACTION.md.

## Outside-voice review

The plan that embeds this prereg was reviewed (verdict PASS_WITH_NOTES at commit `01a3975`; four required fixes applied: confidence-tier alignment, cumulative-null cite, cost/wall-time estimate, embedding-model compatibility gate). This prereg document itself is dispatched for a fresh isolated-context review before Task 4 (subagent dispatch) begins. The result doc will undergo a separate outside-voice review before any CHANGELOG / README mention.

## Provenance (to be completed during execution)

- Dataset: `data/longmemeval_oracle.json`, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c` (anchored from F8 result doc).
- Source store: `hippo_store2/` (940 sessions, ingested by F6 via `ingest_direct.py`, re-embedded with `Xenova/bge-base-en-v1.5` by F11).
- Enriched store: `hippo_store_enriched/` (940 sessions, ingested by `ingest_enriched.py` consuming `signals.jsonl`).
- Embedding model (BOTH stores, post-Task 7): `Xenova/bge-base-en-v1.5`. Compatibility gate output recorded verbatim.
- Subagent dispatch: 19 invocations × ~50 sessions, model Sonnet (general-purpose subagents), 4 waves of 5. Actual wall time + token totals + cost recorded in result doc.
- Signal distribution table (output of Task 5 step 2) recorded in result doc.

## Outside-voice review trail (filled in after dispatch)

`<reviewer verdict + per-check results + required fixes>`
