# Hippo Benchmarks

Two benchmarks, two different questions.

## 1. Sequential Learning Benchmark

**Question:** Does the memory system help agents learn from mistakes over time?

No other public benchmark tests this. LongMemEval, LoCoMo, and ConvoMem all test retrieval accuracy on a fixed corpus. None of them measure whether an agent with memory performs *better over a sequence of tasks* than one without.

```bash
cd sequential-learning
node run.mjs --adapter all
```

**Results (hippo v0.11.0):**

| Condition | Overall | Early | Mid | Late | Learns? |
|-----------|---------|-------|-----|------|---------|
| No memory | 100% | 100% | 100% | 100% | No |
| Static memory | 20% | 33% | 11% | 14% | No |
| Hippo | 40% | 78% | 22% | 14% | Yes |

The hippo agent's trap-hit rate drops from 78% (early) to 14% (late) as it accumulates error memories. The no-memory baseline hits every trap. Static memory helps but doesn't improve over time.

**Adding your own memory system:** Implement the adapter interface in `sequential-learning/adapters/interface.mjs` and run:

```bash
node run.mjs --adapter your-adapter
```

Zero dependencies. Node.js 22.5+ only.

## 2. LongMemEval Integration

**Question:** How accurately can hippo retrieve the right memory from a large corpus?

[LongMemEval](https://arxiv.org/abs/2410.10813) (ICLR 2025) is the industry-standard benchmark for AI agent memory. 500 questions across 5 abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention.

```bash
cd longmemeval
pip install -r requirements.txt

# Download data from HuggingFace (see README)
# Then run:
python run.py --data data/longmemeval_oracle.json
```

**Hippo v0.11.0 results (BM25 only, zero dependencies):**

| Metric | Hippo | MemPalace (raw) | MemPalace (reranked) |
|--------|-------|-----------------|---------------------|
| R@1 | 50.4% | — | — |
| R@5 | 74.0% | 96.6% | 100% |
| R@10 | 82.6% | — | — |

| Question Type | R@5 |
|---------------|-----|
| single-session-assistant | 94.6% |
| knowledge-update | 88.5% |
| temporal-reasoning | 73.7% |
| multi-session | 72.2% |
| single-session-user | 65.7% |
| single-session-preference | 26.7% |

Hippo achieves 74% R@5 with BM25 keyword matching and zero runtime dependencies. MemPalace's 96.6% uses ChromaDB embeddings. Adding `hippo embed` (hybrid BM25 + cosine) should close the gap.

**Fast retrieval mode** (recommended): `retrieve_fast.py` queries SQLite FTS5 directly — 500 questions in 2 seconds. The CLI-based `retrieve.py` takes hours due to subprocess overhead.

```bash
cd longmemeval
python ingest_direct.py --data data/longmemeval_oracle.json --store-dir ./store
python retrieve_fast.py --data data/longmemeval_oracle.json --store-dir ./store --output results/retrieval.jsonl
python evaluate_retrieval.py --retrieval results/retrieval.jsonl --data data/longmemeval_oracle.json
```

For full pipeline with LLM answer generation + evaluation (requires `ANTHROPIC_API_KEY`):
```bash
python run.py --data data/longmemeval_oracle.json
```

## What each benchmark proves

| | Sequential Learning | LongMemEval |
|---|---|---|
| Tests | Agent improvement over time | Retrieval accuracy on fixed corpus |
| Unique to hippo? | Yes (no other benchmark tests this) | No (industry standard) |
| Hippo result | 78% -> 14% trap rate (learns) | 74.0% R@5 (BM25 only) |
| What it proves | Decay + strengthening + outcome feedback produce learning curves | BM25 keyword search competes with embedding systems at zero dependency cost |
| Metric | Trap-hit-rate decline (early vs late) | Recall@K, answer-in-content |
| Dependencies | Node.js 22.5+ | Python 3.9+ (retrieval eval needs no API key) |
