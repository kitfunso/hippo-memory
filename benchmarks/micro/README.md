# Micro-eval

Tier 1 in the hippo eval pyramid. Deterministic substring scoring, ~30 seconds.

| Tier | What | When | Time |
|------|------|------|------|
| 1 | `benchmarks/micro/` (this) | Every code change | ~30s |
| 2 | LoCoMo stratified subsample (`run.py --conversations 1 --sample 10 --score-mode evidence`) | Before opening a PR | ~5-10 min |
| 3 | LoCoMo full | Release gate | ~85 min evidence / ~6h judge |

## Run

```bash
# default: all fixtures
python benchmarks/micro/run.py

# filter by mechanic or name substring
python benchmarks/micro/run.py --filter recall

# diff against a saved baseline
python benchmarks/micro/run.py --baseline benchmarks/micro/results/baseline.json

# verbose: print failed-query top-k
python benchmarks/micro/run.py --verbose
```

Exit code: `0` if every fixture is 100% pass, `1` otherwise. Wire this into a pre-PR hook if you want.

## Fixture format

Plain JSON in `fixtures/`:

```json
{
  "name": "decay-basic",
  "mechanic": "decay",
  "remembers": [
    "Bob's coffee order is oat milk latte"
  ],
  "actions": [
    {"type": "supersede", "remember_index": 0,
     "new_content": "Bob switched to oat milk flat white"}
  ],
  "queries": [
    {"q": "what does Bob drink",
     "must_contain_any": ["oat milk", "latte"],
     "must_not_contain_any": ["espresso"],
     "top_k": 3,
     "cli_args": ["--include-superseded"]}
  ]
}
```

Pass = at least one substring from `must_contain_any` (case-insensitive) appears
in the top-k recall results AND none of the substrings in `must_not_contain_any`
(if set) appear there. `must_not_contain_any` is optional.

**Actions** run after `remembers` and before `queries`, in declared order:

- `supersede` — marks `remembers[remember_index]` as superseded by a new
  memory whose content is `new_content`. Equivalent to running
  `hippo supersede <id> "<new content>"`. Sets `entry.superseded_by` on the
  original.

## When to add fixtures

When you add a new mechanic or change retrieval/storage behaviour, add 3-10 fixture queries that probe the *specific* expected behaviour. Examples:

- **decay**: store an old + new memory, query → recent should rank higher
- **consolidation**: store two related memories → query expecting a merged or both-found result
- **salience gate**: store relevant + irrelevant → relevant survives the gate
- **recall strengthening**: query memory N times → it should outrank a never-recalled peer

Keep each fixture small (1-10 remembers, 1-5 queries). If a fixture takes > 5s, split it.

## Tier 2 smoke recipe

When micro passes and you want a real-distribution check before a PR:

```powershell
$env:HIPPO_BIN='node C:/Users/skf_s/hippo/bin/hippo.js'
python benchmarks/locomo/run.py `
  --data benchmarks/locomo/data/locomo10.json `
  --output-dir benchmarks/locomo/results `
  --output-name hippo-smoke `
  --conversations 1 --sample 10 `
  --score-mode evidence
```

~50 QAs across categories. Compare deltas vs the prior smoke run, not absolute scores.
