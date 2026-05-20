# F6 reranker hardening — pre-registration

**Author:** Claude Code (subagent-driven-development workflow)
**Date:** 2026-05-10
**Plan:** docs/plans/2026-05-10-f6-reranker-hardening.md
**Retraction-discipline reference:** docs/RETRACTION.md

This release does not re-assert the retracted −10pp magnitude.

## Source-read evidence

The five anchors specified in Task 1, Step 1 of the plan were read on 2026-05-10
against the working tree at branch `claude/plan-implementation-workflow-sasNp`.
Each citation pastes the actual signature/struct as it appears in source, with
`file:line` ranges.

### Anchor 1 — `hybridSearch` (reranker slot is post-MMR, pre-budget)

`src/search.ts:234-557`

```ts
// src/search.ts:234-266
export async function hybridSearch(
  query: string,
  entries: MemoryEntry[],
  options: {
    budget?: number;
    now?: Date;
    hippoRoot?: string;
    embeddingWeight?: number;
    explain?: boolean;
    /** Disable MMR re-ranking even when embeddings are available. */
    mmr?: boolean;
    /** MMR balance: 1.0 = pure relevance, 0.0 = pure diversity. Default 0.7. */
    mmrLambda?: number;
    /** Scoring mode: 'blend' (weighted sum of BM25+cosine, default) or
     *  'rrf' (reciprocal rank fusion - combines BM25 and cosine ranks
     *  instead of scores, more robust for long documents). */
    scoring?: 'blend' | 'rrf';
    /** Pre-built BM25 corpus from `buildCorpus`. Pass this across many
     *  queries on the same entry set to skip ~O(N*docLen) tokenization
     *  work per call. Must be built from the same `entries` in the same
     *  order (content + tags.join(' ')). */
    preparedCorpus?: BM25Corpus;
    /** Minimum number of results to return regardless of budget.
     *  Prevents budget saturation when memories are large. Default 1. */
    minResults?: number;
    /** Active scope for scope-boost scoring. Auto-detected if not provided. */
    scope?: string | null;
    /** Include superseded memories in results. Default false. */
    includeSuperseded?: boolean;
    /** Filter to memories current at this ISO date string. */
    asOf?: string;
  } = {}
): Promise<SearchResult[]>
```

Confirmed pipeline order inside `hybridSearch` body, with line citations:

- `src/search.ts:525-543` — MMR re-ranking step. Emits `ordered: SearchResult[]`
  after MMR (or pure-relevance ordering if MMR is disabled / no embeddings).
- `src/search.ts:545-554` — token-budget filter loop, consumes `ordered` and
  produces final `results: SearchResult[]`.
- `src/search.ts:556` — `return results;`.

The reranker slot identified by the plan is **between line 543 (post-MMR
`ordered` is finalized) and line 545 (budget loop begins)**. There is no
reranker hook in the current options bag (lines 237-265) and no call to a
reranker function anywhere in `hybridSearch`. The dry-run below confirms this.

### Anchor 2 — `SearchResult`, `ScoreBreakdown` (extension points)

`src/search.ts:165-225`

```ts
// src/search.ts:168-176
export interface SearchResult {
  entry: MemoryEntry;
  score: number;          // composite score
  bm25: number;
  cosine: number;         // cosine similarity (0 when embeddings not used)
  tokens: number;
  /** Populated when search is called with options.explain === true. */
  breakdown?: ScoreBreakdown;
}
```

```ts
// src/search.ts:178-225
export interface ScoreBreakdown {
  /**
   * - `hybrid`: BM25 blended with a non-zero cosine from a cached doc vector.
   * - `hybrid-no-vec`: Query was embedded but this doc had no cached vector,
   *   so the effective score came from BM25 alone even though weights say
   *   otherwise. Usually means `hippo embed` hasn't run on this memory.
   * - `bm25-only`: Embedding pipeline unavailable or the model requires re-index.
   * - `physics`: Scored by the physics engine (gravity + momentum + cluster).
   */
  mode: 'hybrid' | 'hybrid-no-vec' | 'bm25-only' | 'physics';
  /** BM25 score after normalization by max-in-corpus (0..1). */
  normBm25: number;
  /** Weight applied to BM25 in the hybrid blend. */
  bm25Weight: number;
  /** Weight applied to cosine in the hybrid blend. */
  embeddingWeight: number;
  /** Cosine similarity (0 when embeddings not used). */
  cosine: number;
  /** Blended base score before multipliers. */
  base: number;
  /** Multiplier from memory strength: 0.5 + 0.5*strength. */
  strengthMultiplier: number;
  /** Multiplier from age: 0.8 + 0.2*recencyBoost. */
  recencyMultiplier: number;
  /** 1.2 if tagged 'decision', else 1.0. */
  decisionBoost: number;
  /** 1.0..1.3 based on cwd path tag overlap. */
  pathBoost: number;
  /** 1.5 if scope matches, 0.5 if scope mismatches, 1.0 if neutral. */
  scopeBoost: number;
  /** Extra multiplier applied post-hybrid (e.g. 1.2x for local hits in a
   *  local+global merged search). 1.0 when not applicable. */
  sourceBump: number;
  /** Retrieval-time outcome personalization: 1 + 0.15*tanh(pos - neg), clipped
   *  to [0.85, 1.15]. Immediate nudge from `hippo outcome --good/--bad`.
   *  Separate from the slow strength-via-reward-factor path. */
  outcomeBoost: number;
  /** Pre-MMR rank (1-indexed). Only set when MMR re-ranking ran. */
  preMmrRank?: number;
  /** Post-MMR rank (1-indexed). Only set when MMR re-ranking ran. */
  postMmrRank?: number;
  /** Query terms that appeared verbatim in the doc. */
  matchedTerms: string[];
  /** Final composite score (= base * multipliers). */
  final: number;
  /** Age of the memory in whole days, at scoring time. */
  ageDays: number;
}
```

Confirmed extension points: a reranker hook can attach a new optional
field on `SearchResult` (e.g. `rerankScore?: number`) without affecting the
current `score`/`bm25`/`cosine`/`tokens`/`breakdown` shape, and can attach a
sibling `rerankRank?: number` field on `ScoreBreakdown` analogous to
`preMmrRank` / `postMmrRank` (lines 215-218).

### Anchor 3 — `MemoryEntry` (feature-track signal availability)

`src/memory.ts:46-106`

```ts
// src/memory.ts:46-106
export interface MemoryEntry {
  id: string;
  created: string;         // ISO 8601
  last_retrieved: string;  // ISO 8601
  retrieval_count: number;
  strength: number;        // 0..1, current computed strength
  half_life_days: number;
  layer: Layer;
  tags: string[];
  emotional_valence: EmotionalValence;
  schema_fit: number;      // 0..1
  source: string;
  outcome_score: number | null;  // null = no feedback yet
  outcome_positive: number;      // cumulative positive outcome count
  outcome_negative: number;      // cumulative negative outcome count
  conflicts_with: string[];
  pinned: boolean;
  confidence: ConfidenceLevel;  // epistemic confidence tier
  content: string;         // the actual memory text
  parents: string[];       // IDs of source memories this was consolidated from (may be empty)
  starred: boolean;        // user-bookmarked
  trace_outcome: TraceOutcome;      // final outcome for trace-layer entries; null otherwise
  source_session_id: string | null; // set by auto-promote; null for everything else
  valid_from: string;               // ISO 8601 timestamp when this belief became true
  superseded_by: string | null;     // ID of the memory that replaced this one; null = current
  extracted_from: string | null;
  dag_level: number;            // 0=leaf, 1=extracted_fact, 2=topic_summary, 3=entity_profile (independent of envelope `kind`)
  dag_parent_id: string | null; // ID of parent summary node in the DAG; null = root level
  // Cached DAG metadata (schema v25). Populated for level-2+ summary rows so
  // recall can reason about scope without re-walking the DAG. Always 0 / null
  // for level-0 leaves and level-1 facts.
  descendant_count?: number;
  earliest_at?: string | null;
  latest_at?: string | null;
  // A3 provenance envelope (schema v14)
  kind: MemoryKind;             // raw | distilled | superseded | archived
  scope: string | null;         // e.g. 'team:eng', 'project:foo'; null = global
  owner: string | null;         // 'user:<id>' or 'agent:<id>'
  artifact_ref: string | null;  // URI to source artifact (slack://, gh://, file://)
  // A5 stub auth (schema v16)
  tenantId: string;             // 'default' for single-tenant deployments
  /**
   * F1 (v1.7.0): raw SQLite FTS5 bm25() score from the FTS path of
   * `loadSearchEntries`.
   *
   * Populated ONLY when ALL of the following hold:
   *   - `loadSearchEntries` was called with a non-empty query, AND
   *   - FTS5 is available (meta `fts5_available = 1`), AND
   *   - the FTS join returned at least one row (path 2 of `loadSearchRows`).
   *
   * `undefined` on every other path: empty query, FTS unavailable, LIKE
   * fallback, full-store fallback, `readEntry`, `loadAllEntries`, manual
   * upsert, deserializeEntry from markdown.
   *
   * SCALE: FTS5 bm25() is negative; lower = better match (ascending order).
   * NOT a drop-in for the JS-side BM25 in `src/search.ts` — that is a
   * different scorer (different tokenizer, different params, positive
   * scale). Treat `bm25_score` as provenance/rank metadata only.
   */
  bm25_score?: number;
}
```

All six fields the feature-track reranker needs are present and typed:

- `confidence: ConfidenceLevel` — `src/memory.ts:63`
- `schema_fit: number` (0..1) — `src/memory.ts:56`
- `kind: MemoryKind` (raw | distilled | superseded | archived) — `src/memory.ts:81`
- `strength: number` (0..1) — `src/memory.ts:51`
- `outcome_positive: number` — `src/memory.ts:59`
- `outcome_negative: number` — `src/memory.ts:60`
- `emotional_valence: EmotionalValence` — `src/memory.ts:55`

### Anchor 4 — `retrieve_inprocess.mjs` flag-parsing (new flags slot in cleanly)

`benchmarks/longmemeval/retrieve_inprocess.mjs:18-30`

```js
// benchmarks/longmemeval/retrieve_inprocess.mjs:18-30
function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const DATA_PATH = flag('--data', 'data/longmemeval_oracle.json');
const STORE_DIR = flag('--store-dir', 'hippo_store2');
const OUTPUT_PATH = flag('--output', 'results/retrieval_v27.jsonl');
const BUDGET = parseInt(flag('--budget', '1000000'), 10);
const LIMIT = parseInt(flag('--limit', '0'), 10);
const EMB_WEIGHT = flag('--embedding-weight', null);
const NO_MMR = process.argv.includes('--no-mmr');
const MIN_RESULTS = parseInt(flag('--min-results', '10'), 10);
```

Confirmed: `flag(name, fallback)` is a positional `--flag value` parser with no
schema enforcement. New flags such as `--reranker <track>` or
`--reranker-config <json-path>` slot in cleanly by adding one
`flag('--reranker', null)` line in the same block. Boolean flags follow the
`process.argv.includes('--no-mmr')` pattern at line 29.

### Anchor 5 — `benchmarks/micro/run.py` fixture format docstring (cli_args supports new flag)

`benchmarks/micro/run.py:1-65`

```python
# benchmarks/micro/run.py:11-33 (fixture-format docstring)
"""
Each fixture is a JSON file under fixtures/ with shape:

  {
    "name": "decay-basic",
    "mechanic": "decay",                  # decay | recall | consolidation | salience | ...
    "remembers": [                         # ordered hippo remember calls
      "Bob's coffee order is oat milk latte",
      "Alice prefers green tea",
      {"text": "...", "tags": ["auth-rewrite"]}   # object form attaches --tag flags
    ],
    "actions": [                           # optional, run after remembers in order
      {"type": "supersede",
       "remember_index": 0,
       "new_content": "Bob switched to oat milk flat white"}
    ],
    "queries": [
      {"q": "what does Bob drink",
       "must_contain_any": ["oat milk", "latte"],     # at least one in top-k
       "must_not_contain_any": ["espresso"],          # optional, all must be ABSENT
       "top_k": 3,
       "cli_args": ["--include-superseded"]}
    ]
  }
"""
```

Confirmed: each query carries an opaque `cli_args: list[str]` that the harness
forwards verbatim to `hippo recall`. A new `--reranker <track>` CLI flag slots
in by appending it to a fixture's `cli_args` array (e.g.
`["--reranker", "features"]`). No schema migration of the fixture format is
needed.

## 1-question dry-run evidence

Procedure (per Task 1, Step 2):

1. `npm run build` — succeeded (full TypeScript compile + benchmarks compile,
   no errors; only output is the two `tsc` invocations).
2. Ran the literal command from the plan:

```
node -e '
  import("./dist/search.js").then(async ({ hybridSearch, buildCorpus }) => {
    const { createMemory } = await import("./dist/memory.js");
    const entries = [
      createMemory("CI pipeline failure on push to master"),
      createMemory("Python dict ordering guarantees in 3.7+"),
    ];
    let rerankerCalled = false;
    const stubReranker = async (query, results) => {
      rerankerCalled = true;
      return results.map((r, i) => ({ ...r, rerankScore: 1 - i * 0.01 }));
    };
    const out = await hybridSearch("CI failure", entries, { budget: 10000, reranker: stubReranker });
    console.log("reranker fired:", rerankerCalled);
    console.log("results:", out.length);
  });
'
```

Literal stdout/stderr captured (combined `2>&1`):

```
reranker fired: false
results: 1
(node:6929) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
```

Interpretation:

- The script did **not** error. `hybridSearch` accepted the call with the
  `reranker` property present in the options object — TypeScript's structural
  typing and the absence of any runtime schema validation on the options bag
  mean an unknown property is silently dropped at the JS boundary.
- `rerankerCalled` was logged as `false`, proving the stub closure was never
  invoked. The mechanism path `hybridSearch -> reranker` is **NOT wired in
  v1.8.1**.
- `results: 1` confirms that the hybrid pipeline ran end-to-end (BM25 path,
  budget filter, return) and returned the one entry that lexically matched
  "CI failure" — the call worked, it just bypassed any reranker.
- The Node experimental SQLite warning is unrelated noise from the
  `loadAllEntries` / store import path pulled in transitively.

This is the expected and informative outcome the plan calls for: the
source-read identified the correct seam (post-MMR, pre-budget, between
`src/search.ts:543` and `:545`), and the dry-run independently confirms that
seam is empty in v1.8.1. Task 2 of the plan must:

1. Add a `reranker?: RerankerFn` field to the `hybridSearch` options bag at
   `src/search.ts:237-265`.
2. Insert an `await options.reranker(query, ordered)` call between line 543
   (`ordered` finalized) and line 545 (budget loop), assigning the returned
   array back to `ordered` so the budget filter consumes the reranked order.
3. Reflect the new `rerankScore` / `rerankRank` fields on `SearchResult` /
   `ScoreBreakdown` per Anchor 2.

If Task 2 lands correctly, this exact dry-run snippet should print
`reranker fired: true` instead of `false`. That re-run is the regression-style
acceptance check for Task 2; this prereg captures the pre-state.

## Workload-validity gate (binding)

For each track T in {features, cross-encoder, llm}:
  Gate-A (firing rate): on the LongMemEval 500-question dataset with the
    v0.27 hippo store, the reranker function is invoked on ≥95% of queries
    (at least 475 of 500). Below 475, the workload is declared invalid for
    track T and no R@5 number is reported as a mechanism-effect claim.
  Gate-B (variance): R@5 measured at three reranker hyperparameter
    settings (per-track config, see plan Task 5/8/11) MUST differ from
    each other by at least one entry. If all three settings produce
    identical R@5 to four decimal places, the workload does not
    discriminate the reranker hyperparameters and no R@5 number is
    reported as a hyperparameter-effect claim.

## Descriptive characterisation (NON-binding)

R@1, R@3, R@5, R@10, MRR, NDCG@10 reported per track per hyperparameter
setting. Per-category breakdowns (single-session-assistant, single-session-user,
single-session-preference, multi-session, knowledge-update, temporal-reasoning).
Latency p50/p99 per track. These numbers are descriptive characterisation,
not pre-registered pass/fail thresholds.

## Roadmap target (NON-binding)

ROADMAP-RESEARCH.md:374 lists "R@5 ≥ 85%" as the F6 success criterion.
Per the v1.8.1 pre-registration discipline this is treated here as a
non-blocking target, not a pre-registered numeric gate. The mechanism
ships if Gate-A passes for any track; whether R@5 reaches 85% is
descriptive.

## Cumulative null status

Per docs/RETRACTION.md:94-113, the dlPFC goal-stack mechanism's
measured effect on tested workloads is null. The reranker mechanisms
introduced here are independent of dlPFC goal-stack. Their effect on
LongMemEval is open and characterised descriptively below.

## Review trail

### Outside-voice review (2026-05-10)

**Reviewer:** general-purpose subagent dispatched by the subagent-driven-development workflow controller. Isolated context (did not see prior reasoning trace). Read `docs/RETRACTION.md` fresh.

**Note on "outside voice" interpretation:** the v1.8.1 discipline rule at `docs/RETRACTION.md:41` requires "an outside-voice review on whether the framing satisfies the guard." A subagent dispatched by the controller is structurally independent (no shared reasoning trace, reads the artifact fresh) but is not a separate human reviewer. This interpretation was approved by the user prior to dispatch and is documented here for audit.

**Verdict:** PASS

**Per-check results:**

1. Verbatim retraction sentence — PASS (line 8: "This release does not re-assert the retracted −10pp magnitude.")
2. Source-read evidence is real, not ceremonial — PASS. Spot-checks against `src/search.ts` and `src/memory.ts` confirmed byte-accurate signature pastes for `hybridSearch` (lines 234-266), `SearchResult` (168-176), `ScoreBreakdown` (178-225), and `MemoryEntry` (46-106). All six `MemoryEntry` field-line citations (`confidence` 63, `schema_fit` 56, `kind` 81, `strength` 51, `outcome_positive` 59, `outcome_negative` 60, `emotional_valence` 55) verified.
3. Dry-run evidence is literal output — PASS. Captured stdout/stderr (PID 6929, Node SQLite ExperimentalWarning) is real Node 22+ stderr, not a hypothetical. Negative-fire result (`reranker fired: false, results: 1`) is the informative outcome that confirms the v1.8.1 seam is empty.
4. Magnitude-smuggling grep — PASS. Exactly 1 match (line 8 verbatim retraction citation, allowed). No `Δ = N`, no `Npp lift/drop/≥/−/+`, no use of "magnitude" outside the citation.
5. Gate framing — PASS. Gate-A and Gate-B framed as workload-validity / discrimination checks; "R@5 ≥ 85%" target explicitly non-binding.
6. Cumulative-null acknowledgement — PASS. Independence of the reranker mechanism from dlPFC goal-stack asserted with `docs/RETRACTION.md:94-113` cite.
7. Review trail section empty — PASS at review time (now filled by this entry).

**Required fixes:** None. Controller authorized to proceed to Task 2.
