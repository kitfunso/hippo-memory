# Public memory benchmarks through Mem0's own runner

This directory lets hippo be scored by Mem0's runner (`mem0ai/memory-benchmarks`) with no change to its code. The plan is `docs/evals/2026-09-24-public-benchmarks-prereg.md`.

- `hippo-mem0-server.mjs`: answers the runner's three HTTP calls with hippo. Use `--arm hippo` for hippo's ranking, or `--arm bm25` for BM25 alone over the same stored turns.
- `evidence_recall.py`: a free retrieval check on the runner's `--predict-only` output for LoCoMo, with no model calls. `longmemeval_evidence_recall.py` and `beam_evidence_recall.py` do the same for LongMemEval-S and BEAM.

## Run it (on a machine with an OpenAI key)

```bash
# hippo, built
cd hippo-memory && npm run build
node benchmarks/public/hippo-mem0-server.mjs --arm hippo --port 8891 --data-dir /tmp/hb-hippo &
node benchmarks/public/hippo-mem0-server.mjs --arm bm25  --port 8892 --data-dir /tmp/hb-bm25 &

# Mem0's runner, unchanged
git clone https://github.com/mem0ai/memory-benchmarks && cd memory-benchmarks
python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
export OPENAI_API_KEY=...

# 1. free: retrieval only
python -m benchmarks.locomo.run --project-name hippo --backend oss --mem0-host http://localhost:8891 --predict-only --dataset-path path/to/locomo10.json

# 2. trial (about $10-15 for all three arms; gpt-4o-mini answers and judges)
python -m benchmarks.locomo.run --project-name hippo-trial --backend oss --mem0-host http://localhost:8891 --answerer-model gpt-4o-mini --judge-model gpt-4o-mini --dataset-path path/to/locomo10.json

# 3. registered models (gpt-5, as in Mem0's published result files)
python -m benchmarks.locomo.run --project-name hippo --backend oss --mem0-host http://localhost:8891 --answerer-model gpt-5 --judge-model gpt-5 --dataset-path path/to/locomo10.json
```

- **The other benchmarks:** swap `benchmarks.locomo` for `benchmarks.longmemeval` or `benchmarks.beam` (the runner fetches their data).
- **The mem0-oss arm:** `docker compose up -d` in the runner, then `--mem0-host http://localhost:8888`.
- **Rescoring with the authors' scorers:** see the prereg ("Scores reported").
