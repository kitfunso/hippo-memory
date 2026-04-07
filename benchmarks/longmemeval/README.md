# LongMemEval Benchmark for Hippo

Benchmarks hippo memory retrieval against [LongMemEval](https://arxiv.org/abs/2407.15811) (ICLR 2025), a 500-question evaluation covering 5 memory abilities:

| Ability | Description |
|---------|-------------|
| single-session-user | Recall facts from a single conversation |
| multi-session | Synthesize information across multiple sessions |
| temporal-reasoning | Answer time-dependent questions |
| knowledge-update | Track updated/corrected information |
| abstention | Correctly refuse when information is unavailable |

## Setup

```bash
pip install -r requirements.txt
```

Requires:
- `hippo` CLI installed globally (`npm install -g hippo-memory`)
- `ANTHROPIC_API_KEY` environment variable set

## Data

Download the LongMemEval dataset and place the JSON file in this directory. Expected format: array of entries with `question_id`, `question`, `answer`, `question_type`, `haystack_sessions`, `haystack_session_ids`, `haystack_dates`.

## Usage

### Full pipeline

```bash
python run.py --data longmemeval_data.json --output-dir results/
```

### Individual steps

```bash
# 1. Ingest sessions into hippo store
python ingest.py --data longmemeval_data.json --store-dir /tmp/hippo_eval

# 2. Retrieve memories for each question
python retrieve.py --data longmemeval_data.json --store-dir /tmp/hippo_eval --output results/retrieval.jsonl

# 3. Generate answers using Claude
python generate.py --retrieval results/retrieval.jsonl --output results/generation.jsonl

# 4. Evaluate answers
python evaluate.py --generation results/generation.jsonl --output results/evaluation.json
```

### Skip steps (resume after failure)

```bash
# Skip ingestion (reuse existing store)
python run.py --data data.json --store-dir /tmp/hippo_eval --skip-ingest

# Skip generation (reuse existing answers)
python run.py --data data.json --store-dir /tmp/hippo_eval --skip-ingest --skip-generate
```

### Exact-match only (no API calls for evaluation)

```bash
python evaluate.py --generation results/generation.jsonl --skip-llm-judge
```

## Output files

| File | Description |
|------|-------------|
| `retrieval.jsonl` | Retrieved memories per question |
| `generation.jsonl` | Generated answers with ground truth |
| `evaluation.json` | Accuracy scores (overall + per-type) |
| `pipeline_metadata.json` | Timings and configuration |

## Architecture

```
longmemeval_data.json
       |
   [ingest.py]     hippo remember (one memory per session)
       |
   [retrieve.py]   hippo recall --json (one query per question)
       |
   [generate.py]   Claude API (context + question -> answer)
       |
   [evaluate.py]   exact match + Claude LLM judge -> accuracy
```
