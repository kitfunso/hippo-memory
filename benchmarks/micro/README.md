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
    "Bob's coffee order is oat milk latte",
    {"text": "Bob skips espresso", "tags": ["coffee"]}
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

Each entry in `remembers` is either a string OR an object `{"text": "...",
"tags": ["..."]}`. The object form is used for fixtures that need per-memory
metadata, e.g. dlPFC goal conditioning (`--goal <tag>` boost).

**Actions** run after `remembers` and before `queries`, in declared order:

- `supersede` — marks `remembers[remember_index]` as superseded by a new
  memory whose content is `new_content`. Equivalent to running
  `hippo supersede <id> "<new content>"`. Sets `entry.superseded_by` on the
  original.
- `outcomes` — applies positive/negative outcomes to `remembers[remember_index]`.
  Calls `hippo outcome --good --id <id>` `good` times and
  `hippo outcome --bad --id <id>` `bad` times. Used to set up
  value-attribution scenarios (vmPFC mechanic). Example:
  `{"type": "outcomes", "remember_index": 0, "good": 3, "bad": 0}`.
**Per-query `pre_actions`** run before the query's recall subprocess (per query, in declared order):

- `goal_push` — shells out `hippo goal push <name> --session-id <session_id>` against the same temp `HIPPO_HOME`. Used by the dlPFC depth fixture (`fixtures/dlpfc_depth.json`) to push a named goal so `hippo recall` auto-applies the goal-tag boost. The harness threads `HIPPO_SESSION_ID` into the recall subprocess from either an explicit `--session-id` in `cli_args` or from the pre_action's `session_id`. Example:
  `{"op": "goal_push", "name": "db-rewrite", "session_id": "s-db"}`.

The dlPFC depth fixture (`fixtures/dlpfc_depth.json`) uses three disjoint clusters of 6 memories (database / frontend / deploy), each tagged with a cluster-specific marker (`db-rewrite` / `ui-rewrite` / `deploy-rewrite`). All three queries share the same ambiguous text `"rewrite step"` so BM25 alone cannot discriminate clusters; each query pairs a `goal_push` pre_action with an asymmetric assertion: the active cluster's unique marker token (`XDB-MARKER` / `XUI-MARKER` / `XDEP-MARKER`) MUST be in top-3 AND the other two markers MUST NOT be. Each memory carries its cluster's marker token in its text, so any top-3 entry of the active cluster contains the right marker — top-3 ranking is fully deterministic against intra-cluster BM25 ties. Only the goal-tag boost can satisfy the asymmetric `must_not_contain_any` constraint (BM25 alone has no way to suppress the other two clusters), which is what makes this fixture load-bearing for B3 cluster discrimination.

- `recall` — runs `hippo recall <query> --limit 1` `times` times to bump
  `retrieval_count` on the top-ranked match for `query`. The `--limit 1` is
  intentional: in `cli.ts`, results are sliced to `limit` BEFORE
  `markRetrieved()` runs, so only the rank-1 match is bumped (calling recall
  without a limit would bump every returned memory). The fixture's `query`
  must be selective enough to put the target memory at rank 1 — a unique
  marker token is the canonical pattern. After the loop, the harness runs
  `hippo trace <id>` and asserts `retrieval_count >= times`. Used by the
  pineal-salience mechanic, where "salience" emerges from USE rather than
  lexical overlap. Example:
  `{"type": "recall", "query": "marker-pineal-1", "remember_index": 0, "times": 3}`.

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
