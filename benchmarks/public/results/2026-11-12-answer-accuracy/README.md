# Answer accuracy on five public memory benchmarks (2026-11-12)

hippo 3.5.1 retrieves, Claude Sonnet 5 answers, and each benchmark's scorer marks the answer. The plan is `docs/evals/2026-09-24-public-benchmarks-prereg.md`.

- `<bench>-emb.txt`: hippo with its free local embedder, and its paired difference from each arm run here (BM25, hippo without embeddings, Mem0 on LoCoMo, full chat on DMR), with 95% intervals.
- `<bench>-best.txt`: hippo with the embedder and its free local cross-encoder reranker on (`hippo-best`, Amendment 6 of the plan), paired with the same arms and with `hippo-emb`. It answered at each qa benchmark's own cutoff, at 10 on LongMemEval-S and at 50 and 10 on LoCoMo, where the setting was chosen, so the LoCoMo lines only describe. Where both settings answered at a card's cutoff, the benchmarks page shows the higher and names it.
- `<bench>.txt`: the arms it pairs with (`dmr-full.txt` is the whole conversation in the prompt).
- `competitors.json`: published scores, each with its source URL and a quote; rows we could not fetch from a source page are under `unverified` and not used.
- `mem0-locomo-ingest-gate.json`: the check on Mem0's LoCoMo store run, including its 5,882 extraction calls.

The benchmarks page reads `website/src/data/public-benchmarks.json`. Rebuild it from these files with `python benchmarks/public/site_data.py`.
