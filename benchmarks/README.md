# Hippo Benchmarks

Three benchmarks, three different questions.

## 1. Sequential Learning Benchmark

**Question:** Does the memory system help agents learn from mistakes over time?

No other public benchmark tests this. LongMemEval, LoCoMo, and ConvoMem all test retrieval accuracy on a fixed corpus. None of them measure whether an agent with memory performs *better over a sequence of tasks* than one without.

```bash
cd sequential-learning
node run.mjs --adapter all
```

> **v0.11.0 informal results — RETRACTED v1.7.9.** v0.11.0 reported informal numbers that did not reproduce on the formal sequential-learning harness across three pre-registered workload variants (v1.7.5 full-late SANITY_FAIL, v1.7.6 budget sweep B*=NULL, v1.7.7 `--restrict-late-to 4` SANITY_FAIL). Every C2 hippo-base late mean returned 0% across every seed. **The magnitude is RETRACTED. The mechanism is shipped; no magnitude is currently claimed.** See top-level `CHANGELOG.md` v1.7.9 entry and `docs/RETRACTION.md`.

<details>
<summary>Original v0.11.0 informal numbers (RETRACTED — preserved as audit trail in git, not reproduced here)</summary>

v0.11.0 reported a single-run informal headline citing late-phase trap-rate decline. The specific numbers are archived at git tag `v0.11.0`. Retained in version control, not reproduced here, since reproduction risks accidental re-citation.

</details>

The benchmark, harness, and adapter contract remain shipped.

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

## 3. LoCoMo Integration

**Question:** How accurately does hippo retrieve the gold evidence turn for a question over a long multi-session conversation?

[LoCoMo](https://arxiv.org/abs/2402.17753) is 10 conversations (5,882 turns, 1,986 QAs across single-hop / multi-hop / temporal-reasoning / open-domain / adversarial categories). Hippo scores it with a deterministic gold-`dia_id` evidence-recall metric — no LLM judge in the scoring path.

```bash
cd locomo
HIPPO_BIN="node <path-to-hippo-build>/bin/hippo.js" python run.py \
  --data data/locomo10.json --score-mode evidence
# evidence mode auto-names the output results/hippo-v<version>-evidence.json;
# an explicit --output-name must include .json (run.py uses the value verbatim)

python score_evidence.py \
  --data data/locomo10.json \
  --result results/hippo-<version>-evidence.json \
  --output results/hippo-<version>-evidence-rescored.json
```

**v1.25.0 baseline (2026-07-05):** evidence recall@5 = **0.363** — 2.10x the April v0.32.0 baseline (0.173) under the identical protocol (top-k 5, `--budget 4000`, fresh store per conversation, same on-disk data file — unmodified since 2026-04-22 per mtime; no April sha exists for cryptographic confirmation). This is a single-run point estimate with measured run-to-run variance (repeat stdev 0.0175 on a 197-QA conversation slice), and it is deterministic evidence recall, not comparable to Mem0/Letta's published LLM-judge LoCoMo numbers — different metric, different harness. Informational only; never gates a feature (ROADMAP F7). Full table, protocol, and caveats: `LOCOMO_INVESTIGATION.md`.

## What each benchmark proves

| | Sequential Learning | LongMemEval | LoCoMo |
|---|---|---|---|
| Tests | Agent improvement over time | Retrieval accuracy on fixed corpus | Gold-evidence retrieval on long multi-session conversations |
| Unique to hippo? | Yes (no other benchmark tests this) | No (industry standard) | No (industry standard) |
| Hippo result | RETRACTED v1.7.9 — mechanism shipped, no magnitude claimed (see CHANGELOG v1.7.9) | 74.0% R@5 (BM25 only) | 0.363 evidence recall@5 (v1.25.0; informational only, never gates a feature) |
| What it proves | Decay + strengthening + outcome feedback produce learning curves | BM25 keyword search competes with embedding systems at zero dependency cost | Deterministic before/after tracking of hippo's own retrieval stack on conversational memory (no LLM judge) |
| Metric | Trap-hit-rate decline (early vs late) | Recall@K, answer-in-content | Evidence recall@5 (gold dia_id, deterministic) |
| Dependencies | Node.js 22.5+ | Python 3.9+ (retrieval eval needs no API key) | Python 3.9+ (evidence scoring needs no API key) |
