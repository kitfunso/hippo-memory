# LongMemEval: regression story RESOLVED 2026-04-26

## Verdict

There is **no LongMemEval retrieval regression** between v0.28.0 and v0.34
(working tree at base d3d9bc7 + uncommitted salience/ambient/eval-suite/store
edits). On the canonical in-process harness with matched 940-session stores,
both versions score byte-identical:

| Metric | v0.28.0 | v0.34 |
|---|---|---|
| recall@1 | 49.6 | 49.6 |
| recall@3 | 68.8 | 68.8 |
| recall@5 | 76.2 | 76.2 |
| recall@10 | **82.8** | **82.8** |
| answer_in_content@5 | 51.2 | 51.2 |

`diff` of `retrieval_500q_eval.json` between the two runs is empty across
all overall and per-type metrics.

v0.34 also runs the same retrieval ~**20x faster** (102s vs 2002s on 500q).

## Root cause of the false alarm

The earlier "v0.34 collapsed to 14.8% recall@10" finding came from running
two **different harnesses** and comparing them as if they were the same:

| Run | Harness | Budget | min-results | recall@10 |
|---|---|---|---|---|
| Apr 20 v0.27 baseline | `retrieve_inprocess.mjs` | 1,000,000 | 10 | 81.0 |
| Apr 25 "v0.34 recovery" | `retrieve.py` (CLI) | 4,000 | 1 (default) | 14.8 |

`retrieve.py` shells out to `hippo recall` per question with default
budget=4000. LongMemEval sessions are stored as ~14k-char concatenated
turns — with budget=4000, only ~1 result fits per query, so recall@K is
effectively capped at recall@1. That has nothing to do with retrieval
quality and everything to do with token-budget saturation.

`retrieve_inprocess.mjs` uses budget=1,000,000 and min-results=10 by
default, which is what produces meaningful recall@K curves on this
benchmark. That is the harness used for all published v0.27 results.

## Canonical harness (use only this for parity comparisons)

```bash
node benchmarks/longmemeval/retrieve_inprocess.mjs \
  --data data/longmemeval_oracle.json \
  --store-dir <store> \
  --output <out>.jsonl
# defaults: --budget 1000000 --min-results 10, MMR on

python benchmarks/longmemeval/evaluate_retrieval.py \
  --retrieval <out>.jsonl --data data/longmemeval_oracle.json \
  --output <out>_eval.json
```

`retrieve.py` numbers are **NOT comparable** to `retrieve_inprocess.mjs`
numbers and must not be mixed in any table. The script now prints a
warning banner saying as much.

## Stop-doing list

- Stop citing the 14.8% number.
- Stop running parity comparisons across `retrieve.py` and
  `retrieve_inprocess.mjs`.
- Stop attributing benchmark deltas to code without first re-checking the
  harness and the store memory count.

## Open items split off from this story

- LoCoMo regression — see `LOCOMO_INVESTIGATION.md`. Salience contributes
  most of the LoCoMo hit and is real there; do not import LongMemEval
  framing into that investigation.
- Lazy DB creation in v0.34 `hippo init` — see `INIT_LAZY_DB.md`.
