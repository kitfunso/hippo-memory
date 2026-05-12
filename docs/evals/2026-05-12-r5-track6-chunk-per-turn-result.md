# LongMemEval R@5 target — Track 6 (F13) chunk-per-turn ingestion — result

**Date:** 2026-05-12
**Author:** controller (claude/plan-implementation-workflow-sasNp)
**Prereg:** `docs/evals/2026-05-12-r5-track6-chunk-per-turn-prereg.md`
**Predecessors:** F12 (e5-large + top-100, Gate-B FAIL with R@5 = 78.8, HARD RETRACTION); F11+F9 stack (R@5 = 78.2, current deployable cross-track best).

This release does not re-assert the retracted −10pp magnitude.

---

## Split-mismatch disclosure (binding, per prereg)

This track measures `data/longmemeval_oracle.json` (3 sessions per haystack). gbrain v0.28.8's 97.60 R@5 figure is on `longmemeval_s_cleaned.json` (~40 history sessions per haystack), reachable only via HuggingFace (HF host-blocked from this sandbox, verified 2026-05-12). gbrain also uses OpenAI `text-embedding-3-large@1536` (api.openai.com host-blocked from this sandbox, same audit). Numbers below are NOT directly comparable to gbrain's; the binding comparison is against our own F11+F9 deployable baseline of R@5 = 78.2 on the oracle split.

## TL;DR

- **Gate-A:** PASS. 10,866 unique turns embedded (one per `(session_id, turn_idx)` tuple), covering all 940 sessions in `data/longmemeval_oracle.json`. Vector dim 768 (BGE-base), L2-norms tight, every turn vector carries its parent `session_id` as a tag.
- **Gate-B:** **PASS**. F13 + F9 stack R@5 = 86.8 % on `data/longmemeval_oracle.json`. Threshold was ≥ 83.2 %; cleared by 3.6 percentage points. The F13 chunked-turn baseline alone scored 79.0; the F9 sub-agent rerank on top-20 turns lifted R@5 to 86.8 — the reranker captured 7.8 / 14.4 = 54 % of the available top-20 headroom (vs ~7-10 % capture rate that F11+F9 and F12+F9 achieved on session-level retrieval). The chunked candidates are short single turns (~500 chars) which gives the reranker clean signal.
- This is the new deployable cross-track best on the oracle split: prior best was F11+F9's R@5 = 78.2; F13+F9 surpasses it by 8.6 raw R@5 points. R@1 also lifted dramatically (51.0 → 70.8) and R@10 / R@20 jumped (83.2 → 90.2, 89.2 → 93.4).
- Roadmap target R@5 ≥ 85 % is NON-binding per prereg but is also now exceeded on the oracle split (86.8 > 85.0).
- **The split-mismatch with gbrain (oracle vs `_s`) is unchanged.** F13+F9's 86.8 is on oracle (3 sessions per haystack); gbrain v0.28.8's published 97.60 is on `_s` (~40 sessions per haystack) with OpenAI `text-embedding-3-large@1536`. Both HF Hub (the `_s` distribution channel) and OpenAI API are host-blocked from this sandbox per the 2026-05-12 egress audit. F13+F9 is the new in-sandbox high water mark; gbrain's `_s` figure remains NOT directly comparable.
- Embedder pivot vs prereg: the prereg authorised a BGE-base fallback if e5-large turn-embed wall time exceeded the budget (it did: ~2 h vs ~32 min). BGE-base chunked was the variant that cleared Gate-B; e5-large chunked was not run.

## Provenance

- **Dataset:** `data/longmemeval_oracle.json`, SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`.
- **Embedder:** `Xenova/bge-base-en-v1.5` (the production F11-era embedder; the prereg authorised a BGE fallback when e5-large's ~2 h wall budget was infeasible — see prereg addendum). Pooling: CLS (per F11's `poolingFor` dispatch). No `passage:` / `query:` prefix (BGE family is symmetric, per F12's `prefixFor` dispatch returning empty for non-e5 models). The F12 multilingual-e5-large weights remain vendored under `benchmarks/longmemeval/data/model-cache/` for any future F13-variant rerun, but were not used to produce this result.
- **Ingestion script:** `benchmarks/longmemeval/chunk_per_turn_embed.mjs` — turn-level (no session truncation), `passage:` prefix.
- **Retrieval script:** `benchmarks/longmemeval/chunk_per_turn_retrieve.mjs` — turn-level cosine, max-pool to session_id, top-K.
- **Evaluator:** `benchmarks/longmemeval/evaluate_retrieval.py`.

## Gate-A — workload validity

**Verdict: PASS.**

Build artifact (gitignored): `benchmarks/longmemeval/data/turn_index_bge.json`, 190,345,931 bytes (~181 MiB), 10,866 turns × 768-dim FP32 + ids + role + content.

Conditions (from prereg):

- Turn count: 10,866 ∈ [10,500, 11,500] — PASS.
- Vector dim: every turn vector has length 768 (BGE-base hidden size) — PASS.
- L2-norm spot-check (100 random turns): all in [0.999, 1.001] — PASS.
- Session-id tag coverage: `len({turn.session_id for turn in turn_index}) == 940` — PASS (all 940 sessions in the oracle universe have at least one turn vector).
- Prefix smoke: not required for BGE-base (BGE is symmetric, no `passage:`/`query:` prefix); the BGE-base branch of `prefixFor` returns the empty string for both roles. The dispatch is exercised at retrieval time via the same `chunk_per_turn_retrieve.mjs` helper. PASS.

Build wall time: 1,914.2 s for 10,866 turns (5.68 turn/s on the 4-core CPU). Retrieval wall time: 25.3 s for 500 queries (19.9 q/s; in-memory dot products dominate the cost).

## Gate-B — proven value at R@5

**Verdict: PASS.** F13 + F9 stack R@5 = 86.8 % on the oracle split. Threshold was ≥ 83.2 % (= F11+F9 deployable best 78.2 + 5pp). Margin: +3.6 pp over Gate-B.

| Configuration | R@1 | R@3 | R@5 | R@10 | R@20 |
|---|---:|---:|---:|---:|---:|
| F11+F9 stack (BGE session-level + rerank) | (see F11 doc) | — | 78.2 | — | — |
| F12+F9 stack (e5 session-level + rerank) | 62.0 | 74.2 | 78.8 | 84.6 | 90.0 |
| F13 baseline (BGE turn-level, hybrid+max-pool) | 51.0 | 72.2 | 79.0 | 86.6 | 93.4 |
| **F13 + F9 stack (BGE turn-level + rerank)** | **70.8** | **84.2** | **86.8** | **90.2** | **93.4** |
| Gate-B threshold | — | — | 83.2 | — | — |

The chunking lever moved R@20 from 89.2 (F12 session-level) to 93.4 (F13 turn-level) — a wider top-20 ceiling for the reranker to work against. The reranker then converted that ceiling much more aggressively than on session-level inputs: 54 % capture rate on F13+F9 vs ~7-10 % on F11+F9 and F12+F9. The plausible mechanism: a sub-agent reading a 500-char turn ("just got my car serviced for the first time on March 15th") can decide whether it directly answers the question; a sub-agent reading a 14,000-char session has to skim 12 turns to find the answer-bearing one before judging relevance, and often picks the first plausible-looking turn rather than the right one.

## Per-K table

Full distribution:

| K | F13 baseline (turn-level, no rerank) | F13 + F9 stack (turn-level + rerank) |
|---:|---:|---:|
| 1 | 51.0 | 70.8 |
| 3 | 72.2 | 84.2 |
| 5 | 79.0 | 86.8 |
| 10 | 86.6 | 90.2 |
| 20 | 93.4 | 93.4 |
| 50 | 96.8 | (n/a — rerank only touches top-20) |
| 100 | 97.6 | (n/a — rerank only touches top-20) |

R@20 is identical pre- and post-rerank because the reranker only reorders the top-20 set (it cannot promote items from positions 21+). All the rerank lift goes to R@1 / R@3 / R@5.

## Per-type breakdown

F13 + F9 stack at R@5:

| question_type | n | R@5 | F12+F9 R@5 (session-level) | direction |
|---|---:|---:|---:|---|
| knowledge-update | 78 | 94.9 | 85.9 | chunking + rerank lifts |
| multi-session | 133 | 91.7 | 89.5 | chunking + rerank lifts |
| single-session-assistant | 56 | 100.0 | 96.4 | chunking + rerank lifts |
| single-session-preference | 30 | 53.3 | 43.3 | chunking + rerank lifts |
| single-session-user | 70 | 78.6 | 50.0 | chunking + rerank lifts substantially |
| temporal-reasoning | 133 | 83.5 | 79.7 | chunking + rerank lifts |
| **all types** | **500** | **86.8** | **78.8** | **chunking + rerank lifts** |

Every category improves under F13+F9 vs F12+F9. The single-session-user category jumped from 50.0 to 78.6 — single-turn-answer questions benefit most from turn-level retrieval, which lets the retriever match on the specific turn that contains the answer rather than on the session-mean.

## Cross-track summary at R@5 (oracle split)

| Configuration | R@5 | Note |
|---|---:|---|
| F8 best (MiniLM hybrid) | 76.8 | F8 result doc |
| F9 v2 (MiniLM + sub-agent rerank) | 78.0 | F9 v2 result doc |
| F11 (BGE-base session-level baseline) | 77.0 | F11 Gate-B FAIL (81.8 threshold, session-level embedder swap alone) |
| F11 + F9 stack (BGE session + sub-agent rerank) | 78.2 | prior deployable cross-track best |
| F12 (e5-large session-level baseline) | 78.0 | F12 baseline |
| F12 + F9 stack (e5 session + sub-agent rerank) | 78.8 | F12 Gate-B FAIL → HARD RETRACTION |
| F13 baseline (BGE turn-level, max-pool to session) | 79.0 | chunking moves the floor |
| **F13 + F9 stack (BGE turn-level + sub-agent rerank)** | **86.8** | **new deployable cross-track best, Gate-B PASS** |
| F11 + F9 + category-aware router | 82.4 | F11 appendix, in-sample upper bound only |
| Roadmap stretch (NON-binding) | 85.0 | now exceeded on oracle split |
| gbrain v0.28.8 hybrid | 97.60 on `_s` | NOT directly comparable — different split (~40 sessions/haystack vs oracle's 3) AND different embedder (OpenAI hosted) |

## Implementation note: max-pool aggregation and the eval contract

Each turn vector in `turn_index_bge.json` carries five fields: `session_id`, `turn_idx`, `role`, `content`, `vec`. At retrieval time, `chunk_per_turn_retrieve.mjs` computes cosine similarity (dot product on L2-normed vectors) between the query and every turn vector, then groups by `session_id` and takes the maximum score per session. The top-K sessions are returned, each tagged with the session_id of its best-matching turn.

The existing `evaluate_retrieval.py` scorer matches `answer_session_ids` against the `tags` field of returned memories (see `benchmarks/longmemeval/evaluate_retrieval.py:51-63` for the `check_session_hit` loop). F13 preserves this contract verbatim — each F13 retrieval result tags itself with `[session_id]`, so the scorer sees a session-level retrieval result and does not need to know that the underlying matching happened at turn granularity.

The F9 sub-agent rerank pattern (`benchmarks/longmemeval/rerank_split_v2.py` + 50 sub-agent dispatches + `rerank_merge_v2.py`) operates on `retrieved_memories[*].content` and `retrieved_memories[*].id`. For F13, the `content` field of each retrieved memory is the best-matching turn's content (not the full session's). This is what made the F9 rerank so much more effective on F13 than on F11/F12: the sub-agent reads a focused 500-character turn instead of an unfocused 14,000-character session.

One batch (042) returned 9 ranked queries instead of 10; the missing query (`gpt4_8279ba03`) falls through to the merge script's "keep retrieval order" path. The aggregate R@5 = 86.8 includes this one query at its baseline rank. The same query's baseline rank in F13's top-100 is sufficient for R@5; no Gate-B impact.

## Outside-voice review trail

### Review (2026-05-12, isolated-context general-purpose subagent, Sonnet)

**Verdict:** PASS_WITH_NOTES (14/14 checks). One required fix and one optional improvement applied:

1. Provenance section corrected: embedder is `Xenova/bge-base-en-v1.5` (the prereg-authorised fallback), not e5-large.
2. Duplicate cumulative-null section removed (the section now appears once below).

Per-check summary:

1. Verbatim retraction sentence on its own line — PASS.
2. Split-mismatch disclosure binding, leads gbrain mention — PASS.
3. Gate-A PASS verdict supported (10866 turns, 768d, L2-norms tight, 940 sessions covered) — PASS.
4. Gate-B arithmetic 86.8 ≥ 83.2 (margin 3.6pp) — PASS.
5. Per-K monotone, per-type sums to 500 — PASS.
6. Cross-track summary consistent with F8 / F9 v2 / F11 / F11+F9 / F12 / F12+F9 / router / gbrain values from prior docs — PASS.
7. Magnitude-smuggling grep 0 matches — PASS.
8. Cumulative-null cite `docs/RETRACTION.md:94-113` — PASS.
9. Embedder-fallback disclosed; prereg addendum acknowledged — PASS (corrected this revision).
10. Max-pool + eval-contract preservation accurate — PASS.
11. Roadmap target NON-binding — PASS.
12. batch_042 missing query disclosed — PASS.
13. Reranker capture-rate framing 54% (7.8/14.4) arithmetically consistent — PASS.
14. Free-form: Provenance embedder mismatch + duplicate cumulative-null section flagged — both addressed in this revision.

Controller authorised to commit and push.

## Cumulative-null acknowledgement

Per `docs/RETRACTION.md:94-113`, the dlPFC goal-stack mechanism's cumulative-null status is independent of this evaluation. F13 adds (i) `benchmarks/longmemeval/chunk_per_turn_embed.mjs`, (ii) `benchmarks/longmemeval/chunk_per_turn_retrieve.mjs`, and (iii) F13 prereg + result docs. F13 introduces no `src/` mechanism change. The cumulative-null finding stands unchanged.
