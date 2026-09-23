# LongMemEval-S per-haystack retrieval: what reproduces (2026-09-23)

A check of the public claim "98.6% R@5 with the zero-dependency default", from [2026-06-09-longmemeval-per-haystack-dual.md](2026-06-09-longmemeval-per-haystack-dual.md).

## Summary

- **98.6 reproduces exactly, but only on the build it was measured with.** Replaying June's embedding backend (`@xenova/transformers` 2.17.2, int8 MiniLM weights) gives June's R@5 in all five retrieval settings.
- **Today's build gives 98.0.** With `@huggingface/transformers` 4.2.0, the backend hippo loads first, the five settings score 96.8 to 98.0.
- **98.6 was the best of five settings, picked after the run.** With 500 questions, the 95% interval on a score near 98% is about ±1.2 points. So 98.0, 98.6 and gbrain's published 97.6 are a tie.
- **The number comes from the benchmark scripts, not `hippo recall`.** The scripts index every conversation turn, rank turns with BM25 and dense cosine, fuse the two rankings with RRF, and keep each session's best turn. They share hippo's tokenizer and RRF function, not its recall path.
- **MiniLM is an optional install.** Since 1.28.0 (2026-07-28), a default install has no embedder; `npm i @huggingface/transformers` adds one. None of these numbers describe a default install.
- **The June scripts were never committed.** The per-haystack retriever (`chunk_per_turn_haystack_retrieve.mjs`) and the voyage embedding scripts are not in git history. `chunk_per_turn_hybrid_retrieve.mjs --per-haystack` now replays the MiniLM leg. The voyage-3-large 99.8 was not re-run: it needs a paid key and the missing scripts.

## Results

Any-evidence R@5: a hit when any answer session is in the top 5, as `evaluate_retrieval.py` scores it. The data is `longmemeval_s_cleaned.json`, with 500 questions, each ranked within its own haystack. In every run, 0 retrieved ids fell outside the question's haystack.

| Setting | BM25 : dense weights | June 2026 doc | June build, replayed | Today's build |
|---|---|---|---|---|
| dense_only | 0 : 1 | 96.6 | 96.6 | 96.8 |
| turn_sym | 0.5 : 0.5, turn BM25 | 97.4 | 97.4 | 97.8 |
| turn_asym | 0.2 : 0.8, turn BM25 | 97.6 | 97.6 | 97.8 |
| session_sym | 0.5 : 0.5, session BM25 | **98.6** | **98.6** | **98.0** |
| session_asym | 0.2 : 0.8, session BM25 | 97.8 | 97.8 | **98.0** |

- The replay also matches June's R@3 and R@10 in every setting. R@1 matches in three settings and differs in two: turn_sym gives 89.0 against June's 88.6, and session_sym 88.8 against 89.6. The cause was not investigated.
- Today's R@1 by setting: 85.4, 90.0, 87.0, 88.4, 87.4. Today's R@10: 98.8, 99.6, 98.8, 99.4, 99.0.
- All-evidence R@5 counts a hit only when every answer session is in the top 5. It is 85.8 to 87.6 on the June build and 86.0 to 87.4 today. It matters for the questions that have more than one answer session.
- Embedding the 199,509 turns took 68 minutes on the June build and 44 minutes on today's, on a 24-thread desktop CPU.

## What changed in the public claims

- README, website, `llms.txt` and [the eval index](README.md) now quote 98.0 with a free local embedder, say it is the best of five settings, and call the gbrain comparison a tie.
- The voyage-3-large 99.8 stays, labelled as measured in June 2026.
- The June doc and ROADMAP carry correction banners pointing here.

## Reproduce

```bash
npm run build
D=data/lme_s/longmemeval_s_cleaned.json   # SHA-256 d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442
node benchmarks/longmemeval/chunk_per_turn_bm25_index.mjs $D benchmarks/longmemeval/data/bm25_corpus_s
# Today's build: npm i --no-save @huggingface/transformers@4.2.0
# June's build: also set LME_TRANSFORMERS=file:///<abs path>/node_modules/@xenova/transformers/src/transformers.js (2.17.2)
HIPPO_MODEL_CACHE=<model dir> node benchmarks/longmemeval/chunk_per_turn_embed.mjs \
  Xenova/all-MiniLM-L6-v2 benchmarks/longmemeval/data/turn_index_minilm_s.jsonl $D
# One run per setting. Session settings pass bm25_corpus_s_sessions.json instead.
HIPPO_MODEL_CACHE=<model dir> node benchmarks/longmemeval/chunk_per_turn_hybrid_retrieve.mjs \
  --turn-index benchmarks/longmemeval/data/turn_index_minilm_s.jsonl \
  --bm25 benchmarks/longmemeval/data/bm25_corpus_s_turns.json --data $D --out ret_turn_sym.jsonl \
  --rrf-weight-bm25 0.5 --rrf-weight-dense 0.5 --rrf-k 60 --top-k 100 --per-haystack
python benchmarks/longmemeval/evaluate_retrieval.py --retrieval ret_turn_sym.jsonl --data $D
python benchmarks/longmemeval/score_haystack.py $D ret_*.jsonl   # haystack leak check and all-evidence R@k
```
