# Physics Search Ablation

**Hippo version:** 0.31.0
**Generated:** 2026-04-22T12:54:24.699Z
**Dataset:** LongMemEval subset (60 stratified questions across 6 types), 60 eval cases, 102 memories
**Ground truth:** `answer_session_ids` from LongMemEval oracle. A retrieval is a hit if any returned memory is tagged with one of the correct session IDs.

## Results

| Metric | Physics OFF (classic) | Physics ON | Delta | 95% CI (paired bootstrap) |
|---|---|---|---|---|
| MRR | 0.8388 | 0.6848 | -0.1540 | [-0.2556, -0.0529] |
| Recall@5 | 84.31% | 74.17% | -10.14 pp | [-19.17, -1.11] pp |
| NDCG@5 | 0.7888 | 0.6570 | -0.1319 | [-0.2221, -0.0444] |
| NDCG@10 | 0.8116 | 0.6930 | -0.1186 | — |
| Mean latency / query | 57.4ms | 42.6ms | -14.8ms (0.74x) | [-16.7, -12.9] ms |

**Total runtime:** classic 3.4s, physics 2.6s.

## Per question type

| Type | N | Classic NDCG@5 | Physics NDCG@5 | Delta | Classic MRR | Physics MRR |
|---|---|---|---|---|---|---|
| knowledge-update | 10 | 0.7250 | 0.5498 | -0.1752 | 0.8333 | 0.6253 |
| multi-session | 10 | 0.5151 | 0.4775 | -0.0375 | 0.6577 | 0.5997 |
| single-session-assistant | 10 | 1.0000 | 0.9500 | -0.0500 | 1.0000 | 0.9333 |
| single-session-preference | 10 | 0.6631 | 0.6631 | +0.0000 | 0.6417 | 0.6254 |
| single-session-user | 10 | 0.9631 | 0.5562 | -0.4069 | 0.9500 | 0.5326 |
| temporal-reasoning | 10 | 0.8668 | 0.7453 | -0.1215 | 0.9500 | 0.7924 |

## Verdict: CUT

Physics loses by -13.19 pp NDCG@5 (95% CI -22.21..-4.44 pp, excludes 0). No query type gives physics an edge. Recommend removal.

## Methodology

- **Corpus:** 102 memories, each representing one conversation session from LongMemEval oracle. Each memory tagged with its `session:<id>`.
- **Queries:** 60 natural-language questions from LongMemEval. Ground truth = the set of sessions that actually contain the answer.
- **Classic path:** `hybridSearch` — BM25 + cosine + MMR re-ranking + path/scope/outcome/recency boosts. Calls the exact production code path used when `config.physics.enabled === false`.
- **Physics path:** `physicsSearch` — gravitational attraction to query, velocity momentum, cluster amplification from nearby high-scoring memories. Calls the exact production code path used when `config.physics.enabled === true`.
- **Shared:** same store, same embedding index, same budget (unbounded tokens, minResults=10). Embeddings populated via `embedMemory` which also initializes physics state. No physics simulation steps were run between embedding and evaluation — particles are at their t=0 positions (= the original embedding).
- **CI:** paired bootstrap, 5000 iterations, alpha=0.05, over per-case differences.

## Caveats

- **Static physics state.** Physics state was initialized from embeddings but no `simulate()` cycles were run, so particle positions equal embedding positions. In production, `hippo sleep` evolves the state via Verlet integration. This eval measures the cluster-amplification + query-gravity scoring contribution, NOT the long-run benefit of drifted positions. A separate eval with N simulation cycles would test that.
- **Single corpus.** LongMemEval conversations are one style (chatty, long form). Results may differ on terse technical rules, code-dominant content, or other distributions.
- **No real-user queries.** All queries are from a benchmark designed for chatbot LLM memory, not for IDE/agent recall patterns that production hippo serves.
- **Bootstrap CI** assumes paired per-case differences are exchangeable — reasonable here since each question is independent.
