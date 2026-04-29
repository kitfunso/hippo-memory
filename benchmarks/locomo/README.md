# LoCoMo Benchmark for Hippo

Benchmarks hippo memory retrieval against [LoCoMo](https://github.com/snap-research/locomo) (Snap Research), a long-conversation memory benchmark used by Mem0, Letta, Zep, Supermemory.

## Dataset

- **Source**: https://github.com/snap-research/locomo (locomo10.json)
- **10 conversations**, 19-32 sessions each, 369-689 turns each
- **1986 total QA pairs** across 5 categories:
  - Category 1: single-hop (direct fact recall)
  - Category 2: multi-hop (temporal + multi-session reasoning)
  - Category 3: temporal reasoning
  - Category 4: open-domain / commonsense
  - Category 5: adversarial (unanswerable — ground truth says "no info")

## Setup

```bash
pip install -r requirements.txt
# Requires: hippo CLI installed globally (hippo --version => 0.31.0)
# Judge: uses `claude -p` CLI (no ANTHROPIC_API_KEY required)
```

## Usage

```bash
# Full pipeline: ingest one conv -> recall all its QAs -> judge -> aggregate
python run.py --data data/locomo10.json --output-dir results/

# Deterministic retrieval-only scoring: gold evidence dia_id recall@K, no judge
python run.py --data data/locomo10.json --output-dir results/ \
  --score-mode evidence

# Rescore an existing result JSON deterministically from its saved top-K memories
python score_evidence.py --data data/locomo10.json \
  --result results/hippo-v0.32.0.json \
  --output results/hippo-v0.32.0-evidence.json

# Same harness with OpenAI as the judge
python run.py --data data/locomo10.json --output-dir results/ \
  --judge-backend openai --judge-model gpt-4.1-mini

# Same harness with a local/custom judge command. The prompt is passed on stdin
# and stdout must start with one of: equivalent, partial, wrong, none, weak, strong.
python run.py --data data/locomo10.json --output-dir results/ \
  --judge-backend command --judge-command 'python my_judge.py'

# Cheap structural smoke: no judge, fresh temp store, truncated ingest
python audit_matched_stores.py --data data/locomo10.json --max-conversations 1 --max-turns 50 --sample-qa 2

# Offline analysis of an existing result JSON
python analyze_results.py results/hippo-current-10conv-20qa-stable.json --allow-incomplete
```

Flags:
- `--sample N` — limit to N QAs per conversation (default: all)
- `--conversations K` — limit to first K conversations (default: all 10)
- `--top-k N` — top-K memories to pass to judge (default: 5)
- `--skip-adversarial` — exclude category 5 (no-answer) questions
- `--score-mode` — `judge` for LLM scoring, `evidence` for deterministic
  gold evidence `dia_id` recall@K
- `--judge-backend` — `claude-cli`, `openai`, or `command`
- `--judge-model` — override judge model (defaults: claude-opus-4-7 for
  `claude-cli`, gpt-4.1-mini for `openai`)
- `--judge-command` — shell command for `--judge-backend command`
- `--judge-timeout` — seconds per judge call (default: 60)
- `HIPPO_BIN` — override the Hippo command for judged runs, for example
  `HIPPO_BIN='node C:/Users/skf_s/hippo-v032/bin/hippo.js'`

For version parity checks, run the audit with repeated `--hippo-cmd`
arguments:

```bash
python audit_matched_stores.py \
  --hippo-cmd 'v032=hippo-v032' \
  --hippo-cmd 'current=node C:/Users/skf_s/hippo/bin/hippo.js' \
  --max-conversations 1 --sample-qa 2
```

Omit `--max-turns` for a real matched-store count; keep it for quick smoke
checks only.

## Non-negotiables honored

1. Uses globally installed `hippo` CLI (v0.31.0 published artifact).
2. **Fresh HIPPO_HOME per conversation** (prevents cross-conversation leakage).
3. No hippo source changes — measurement only.
4. Judge model id logged in results.

## Architecture

```
locomo10.json
    |
  [run.py]  --- per conversation:
     |         1. mkdtemp() -> HIPPO_HOME
     |         2. hippo init
     |         3. For each session turn: hippo remember <text> --tag speaker:X --tag session:N
     |         4. For each QA in conv: hippo recall <question> --json --budget 4000
     |         5. LLM judge (claude -p): equivalent / partial / wrong
     |
     -> results/hippo-v0.31.0.json (per-QA + aggregates)
```

## Scoring

- Judge prompt: "Question: X. Expected answer: Y. Hippo returned: Z. Is Z equivalent to Y, partially equivalent, or wrong? Answer one word."
- Equivalent = 1.0, partial = 0.5, wrong = 0.0
- For adversarial (cat 5): correct if top-K returns no relevant memory or abstains.
- Evidence mode: score = fraction of gold `qa[].evidence` dialogue ids found
  in top-K retrieved memories. This is deterministic recall@K, not answer
  equivalence. QAs with no gold evidence are marked unscored.
- Overall score = mean across all QAs.
- `--sample` uses a stable stratified sample per conversation so version
  comparisons can score the same QAs in separate processes.
- Judge subprocess/API failures abort the current conversation, mark the JSON
  as incomplete, and exit nonzero. They are not scored as wrong, because that
  silently fabricates benchmark regressions.

## Deterministic comparison (2026-04-28)

`score_evidence.py` rescored the existing full v0.32 and no-salience current
retrieval outputs by mapping returned memory text back to LoCoMo `dia_id`s.

| Run | scored QAs | evidence recall@5 |
|---|---:|---:|
| `hippo-v0.32.0-evidence.json` | 1,982 | 0.172748 |
| `hippo-v0.34.0-no-salience-evidence.json` | 1,982 | 0.172499 |

Delta: -0.000249. The earlier judged gap is not a reliable retrieval signal.

## First run (2026-04-22): results/hippo-v0.31.0.json

- **Score:** 34.6% overall on a **39-QA partial run** (not the full 1986).
- Scope: stratified 10 QAs per conv, 4 of 5 attempted conversations finished.
- **Major caveat:** on the two larger conversations in the sample (conv-41 / 663 turns, conv-42 / 629 turns), every `hippo recall` subprocess exceeded the 30s timeout and returned no memories, collapsing the score for those 20 QAs to 0 for non-adversarial questions.
- Timeout-free subset (conv-26 + conv-30, 19 QAs) scored **50.0%**.
- `finalize.py` reconstructs the report from the incremental JSONL if a run is stopped early.
