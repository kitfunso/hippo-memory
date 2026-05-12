# LongMemEval R@5 target — Track 7 (F14) F13 pipeline on `_s` split — result

**Date:** 2026-05-12
**Author:** controller (claude/plan-implementation-workflow-sasNp)
**Prereg:** `docs/evals/2026-05-12-r5-track7-s-split-prereg.md`
**Predecessor:** F13 chunked-turn (oracle R@5 = 86.8, Gate-B PASS, v1.9.2).

This release does not re-assert the retracted −10pp magnitude.

---

## Provenance disclosure (binding, per prereg)

The `_s` data used in F14 was sourced from `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz` (decompressed SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, 500 questions, ~48 sessions per haystack, 19,195 unique sessions of which 940 are answer-bearing). The Sanderhoff-alt repo is an unaffiliated third-party personal GitHub account with no provenance chain to the canonical HuggingFace release at `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned` (HF Hub host-blocked from this sandbox, verified 2026-05-12). The only integrity signal available is the 500/500 question_id match with our independently verified `data/longmemeval_oracle.json` (SHA-256 `821a2034a...`) plus the canonical-schema match. **The F14 numbers below are conditional on the mirror's integrity.** If the mirror was tampered with relative to the canonical release (e.g. easier distractors substituted in), F14 numbers would be inflated; the schema match precludes wholesale fabrication but cannot detect plausible-distractor substitution.

## Embedder mismatch with gbrain (binding, per prereg)

gbrain v0.28.8 uses OpenAI `text-embedding-3-large@1536` (`api.openai.com` host-blocked from this sandbox). F14 uses `Xenova/bge-base-en-v1.5` (768-dim CLS pooling, locally vendored via Qdrant fastembed GCS). The split is matched (both measure on `_s`, 500 questions, ~48 sessions per haystack); the embedder is not.

## TL;DR

(To be filled in after embed + retrieve + rerank + score.)

## Provenance

- **Dataset:** `data/lme_s/longmemeval_s_cleaned.json` (gitignored, 265 MB, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`).
- **Source URL:** `https://raw.githubusercontent.com/Sanderhoff-alt/longmemeval-zh/main/datasets/longmemeval_s_cleaned.json.gz`.
- **Embedder:** `Xenova/bge-base-en-v1.5` (CLS pooling, no prefix; matches F13).
- **Embed driver:** `node benchmarks/longmemeval/chunk_per_turn_embed.mjs Xenova/bge-base-en-v1.5 benchmarks/longmemeval/data/turn_index_bge_s.json data/lme_s/longmemeval_s_cleaned.json` (resumable mode; warm-started with F13 oracle's 10,866-turn index).
- **Retrieve driver:** `node benchmarks/longmemeval/chunk_per_turn_retrieve.mjs benchmarks/longmemeval/data/turn_index_bge_s.json results/f14_baseline/turn_bge_s_top100.jsonl 100 data/lme_s/longmemeval_s_cleaned.json`.
- **F9 rerank:** 50 sub-agent dispatches over `/tmp/rerank_f14_batches/` (split via `benchmarks/longmemeval/rerank_split_v2.py`), merged via `benchmarks/longmemeval/rerank_merge_v2.py` to `results/f14_rerank/reranked.jsonl`.
- **Evaluator:** `python3 benchmarks/longmemeval/evaluate_retrieval.py`.

## Gate-A — workload validity

(To be filled in.)

## Gate-B — proven value at R@5 (≥ 97.7 % to genuinely best gbrain)

(To be filled in.)

## Per-K table

(To be filled in.)

## Per-type breakdown

(To be filled in.)

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's cumulative-null status is independent of this evaluation. F14 adds (i) the staged `data/lme_s/` data directory (gitignored), (ii) the `turn_index_bge_s.json` index (gitignored, ~3 GB), (iii) a minor `--data` CLI flag addition to `benchmarks/longmemeval/chunk_per_turn_{embed,retrieve}.mjs`, and (iv) F14 prereg + this result doc. F14 introduces no `src/` mechanism change. The cumulative-null finding stands unchanged.

## Outside-voice review trail

(To be filled in.)
