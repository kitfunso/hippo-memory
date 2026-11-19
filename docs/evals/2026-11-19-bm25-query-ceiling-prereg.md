# Prereg, 2026-11-19: BM25 divided by the query's full-match score in hybrid recall

**Why.** Hybrid recall (`scoring: 'blend'`, the default with embeddings) scores `0.4 * normBm25 + 0.6 * cosine`, and `normBm25` was the raw BM25 score divided by the best raw score in the pool (`src/domain/search/hybrid.ts:187`). In a small store, a memory that matched one common query word was the pool's best, so it got `normBm25 = 1` and the full 0.4. On 18 Nov, in a 3-memory store, a match on the word "out" put an unrelated memory first, over the memory the embedder ranked higher (cosine 0.517 against 0.321).

**Change.** The divisor becomes the larger of the pool's best score and `bm25FullMatch`: the BM25 score of a document of average length that holds every query term once (`src/domain/search/bm25.ts`). A memory that matches all query terms keeps a weight near 1. A memory that matches one of three terms gets about its share. RRF scoring and BM25-only recall do not use this divisor and do not change.

**Data and harness.** LoCoMo, the 1,540 saved hippo-emb queries in `~/hippo-bench/retrieval-emb-locomo/predicted_locomo-hippo-emb`, on a copy of the kept store `~/hippo-bench/stores-v3/locomo-hippo-emb`. Two read-only `hippo-mem0-server` processes with the hippo-emb flags (`--embeddings 1`): base serves the master build at `7055edb0e`, new serves this branch. Same queries, same store, top 200, the Mem0 client's order. No model calls. Script: `replay_two_builds.py` (scratchpad, copied into the result note).

**Harness gate.** Base must give back every saved hippo-emb file's results exactly. If one differs, the run is void. Dry run on 3 questions: base 3 of 3 the same as saved; new changed the top-10 order on 3 of 3, so the change takes effect.

**Primary metric.** Evidence recall@10 (`benchmarks/public/evidence_recall.py`, the share of a question's gold evidence turns in the top 10), new minus base, paired bootstrap 95% interval from `--baseline` (4,000 draws, seed 1), over every question with evidence.

**Decision rule.** Ship if the mean difference at k=10 is -0.5 points or more AND the interval's upper end is 0 or more. Otherwise do not ship, and record the result. Recall@5 and recall@50 are reported and do not decide. Questions in one conversation share a store, so the plain bootstrap interval is narrower than a per-conversation one; that makes the rule stricter against a drop, not looser.

**Not measured here.** hippo-best (the cross-encoder over the top 50) and LongMemEval: no kept LongMemEval store has vectors. The unit test `gives a memory that matches one of three query words part of the BM25 weight` fails on the old divisor and passes on the new one.
