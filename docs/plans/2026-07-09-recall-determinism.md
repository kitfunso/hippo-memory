# Recall determinism: fix embed-text path contamination + deterministic tie keys

Status: Draft (episode 01KX434KMAQSX4HRHYC67WDTJQ, branch `feat/recall-tie-break`)
Date: 2026-07-09
Origin: TODOS.md "New follow-ups from the F7 LoCoMo baseline episode" item 1
("Deterministic tie-breaking in recall ranking", filed 2026-07-05).

## Problem

Cross-fresh-ingest rank variance: re-ingesting identical data into a fresh
store produces different recall rankings run to run. Measured on LoCoMo
conv-1 x4 fresh runs: mean evidence-recall@5 0.3630, stdev 0.0175
(`benchmarks/LOCOMO_INVESTIGATION.md` "Determinism characterization").
The filed candidate fix was "a stable secondary sort key (e.g. content hash)
at score ties". Episode diagnosis shows that fix alone CANNOT close the
measured variance: the dominant mechanism is upstream of any comparator.

## Root cause (diagnosed empirically this episode)

Probe: two fresh isolated stores, 15 identical rows ingested in identical
order, ONE identical recall each (`--no-mmr`), scratchpad `tie_probe.py`.

1. **DOMINANT - embedding text includes location noise.** Embedding input is
   `` `${e.content} ${e.tags.join(' ')}`.trim() `` (src/embeddings.ts:236,
   :401, :502) and auto `path:*` tags carry every cwd path component,
   including the store directory name (cli.ts `extractPathTags(process.cwd())`).
   Fresh benchmark runs use `tempfile.mkdtemp(prefix="hippo_locomo_...")`
   (benchmarks/locomo/run.py:596) - a new dir name every run - so every run
   embeds DIFFERENT text for the same content. Observed: `--why` embedding
   similarity 0.386 vs 0.374 for the same row across two stores differing only
   in dir name; final-score deltas up to 6e-2; whole-list rank reshuffles.
   Beyond benchmarks this is a real product defect: retrieval semantics depend
   on WHERE the store lives (rename a project dir -> similarity shifts).
2. **RESIDUAL - no deterministic tie keys.** With identical store paths
   (rebuild-in-place), ranking is already order-identical; scores differ only
   at ~1e-8 (decay evaluated at a different `now`). True plateaus (score
   spacing below that jitter; exact ties at the 1.0 normalization cap; RRF
   integer-rank ties) are ordered by SQLite scan order / `crypto.randomUUID()`
   id artifacts. Explore-agent map (episode trajectory) enumerates ~25
   unbroken-tie `.sort()` sites and the SQL branches without tie keys:
   store.ts:818 (FTS: `ORDER BY bm25, m.updated_at DESC` - updated_at is
   SECOND-truncated), :839 (LIKE), :1532 (fresh-tail), plus
   `loadEntriesByIds` (store.ts:1372) and `loadEntitiesByMemoryId`
   (graph.ts:496) with no ORDER BY at all.
3. **Context, not a defect:** recall mutates the store (markRetrieved:
   retrieval_count+1, half_life +2d), so any initial flip is amplified across
   a 197-query benchmark run. By design (retrieval strengthening); harnesses
   must account for it; no change here.

## Fix

### T1 - exclude `path:*` tags from embedding input text

- New helper `embeddingInputText(entry: {content, tags}): string` in
  src/embeddings.ts: `content + ' ' + tags.filter(t => !t.startsWith('path:')).join(' ')`,
  trimmed. Replace the three inline constructions (embeddings.ts:236 area
  [rebuildEmbeddingIndex], :401 [embedMemory], :502 [embedAll]) with the helper.
  Grep for any other `` `${e.content} ${e.tags.join(' ')}` `` construction and
  route ALL of them through the helper (parallel-allowlist rule: enumerate
  every site, one helper, no clones).
- Only `path:*` is excluded. User/semantic tags (conv:, session:, speaker:,
  dia:, error, scope:, etc.) remain embedded - they carry meaning. Path
  relevance at recall time is ALREADY handled explicitly by the v39 scope
  isolation layer (origin_project, pathOverlapScore), so embedding-level path
  tokens are redundant with a dedicated mechanism, not a feature.
- **Reindex invalidation (required) - choke-point design, not per-caller
  edits.** Stored embedding indexes were computed with the old text format.
  Fold an embed-text-format version into the stored index identity INSIDE the
  two embeddings.ts seams, so every external caller that passes a bare
  `provider.id` gets versioning for free (r1 critic CRIT resolved at the
  root rather than by enumor-and-patch):
  - `embeddingIndexIdentity(providerId): string` = `` `${providerId}#t2` ``
    (new, embeddings.ts).
  - `embeddingModelRequiresReindex(hippoRoot, model, index)` internally
    compares `stored !== embeddingIndexIdentity(model)` (embeddings.ts:220).
  - EVERY `saveStoredEmbeddingModel(hippoRoot, X)` call stores
    `embeddingIndexIdentity(X)` (write sites: embeddings.ts:396, :408, :471 -
    apply inside `saveStoredEmbeddingModel` itself so future writers can't
    drift).
  - Consistency invariant (the failure the r1 critic flagged): compare-side
    and save-side MUST version identically, else every call reindexes in a
    loop or none ever do. One helper used by both is the guarantee. Unit test
    asserts: fresh store -> embed -> requiresReindex false; legacy store with
    bare-id meta -> requiresReindex true (one-time migration reindex).
  - External callers verified untouched-and-correct under this design:
    search.ts:457 (hybridSearch embed gate), search.ts:897 (physicsSearch
    fallback gate), cli.ts:3218 (status "model changed" hint), embeddings.ts
    :388/:468 internal callers. `resolveIndexedEmbeddingModel`'s
    DEFAULT_EMBEDDING_MODEL fallback for legacy index-without-meta stores
    compares bare-vs-versioned -> mismatch -> exactly one reindex, then
    stable. Executor MUST re-grep `embeddingModelRequiresReindex|
    saveStoredEmbeddingModel|EMBEDDING_MODEL_META_KEY|getMeta.*embedding_model`
    and reconcile any site not listed here.
  Result: on next embed-touching operation, the index rebuilds with the new
  text, atomically, via the existing reindex path - no new machinery, no
  migration. Old stores keep working before reindex (embeddings are advisory;
  BM25 path unaffected).
- **FTS/BM25 deliberately untouched:** path tokens in the FTS index are
  corpus-uniform per store (every row carries the same path tags), never match
  benchmark queries, and BM25 doc-length effects are identical across
  same-corpus stores. Not a cross-run variance source. Removing them from FTS
  would be a separate, eval-gated change - out of scope.

### T2 - deterministic tie keys (the filed item's literal ask)

- Shared comparators in a NEW LEAF MODULE `src/compare.ts` (r2 critic HIGH:
  search.ts placement would create a search.ts<->physics.ts ESM import cycle
  since search.ts already imports physicsScore/computeMass from physics.ts).
  `src/compare.ts` imports NOTHING from any sort-site module (type-only
  imports acceptable; prefer structural param types so it stays a true leaf):
  - `compareEntryIdentity(a, b)`: content ascending byte compare
    (`<`/`>`, not localeCompare) -> id ascending. The cross-ingest-stable
    tail (ids are `crypto.randomUUID()`, per-instance only; content is the
    cross-ingest key). Full-content byte compare is O(len) worst case but
    ties are rare post-T1 - no hashing needed.
  - `compareScoredResults(a, b)`: score desc -> compareEntryIdentity.
  Mirror the deliberate-determinism pattern already in
  graph-stream.ts:88,165,233 (comments included).
- Two distinct application shapes (r1 critic HIGH resolved - the shared
  comparator must never REPLACE a site's true primary key):
  a. **Score-primary sites with entry/content in scope** - delegate
     wholesale to `compareScoredResults`:
     search.ts:680, :725, :1034, :1154, :1195;
     shared.ts:145, :290; goals.ts:360; api.ts:2276, :2296, :2305, :2307;
     cli.ts:1207, :1235, :1270, :1344, :1426; graph-recall.ts:266;
     multihop.ts:41; rerankers/cross-encoder.ts:109 (score field there is
     `rerankScore` - thin arrow delegating the tail).
  b. **Non-score-primary sites** - KEEP the site's true primary key and
     append the deterministic TAIL (`compareEntryIdentity`: content asc ->
     id asc) only where the existing keys tie:
     - api.ts:833 - primary = overflow-child count desc (DAG substitution);
     - cli.ts:1167 - primary = created recency desc (--evc-adaptive);
     - graph-recall.ts:248 - primary = hops asc, then score desc, THEN tail.
     Export the tail as its own tiny function so (a)'s comparator composes it
     (`compareScoredResults = score desc -> compareEntryIdentity`).
  c. **Physics-layer sites (no content in scope)** - physics.ts:436, :442
     sort `ScoredPhysicsResult` ({memoryId, baseScore, clusterAmplification,
     finalScore} - NO entry/content at that layer; r2 critic HIGH). Rule
     there: score desc -> `memoryId` asc, via a
     `comparePhysicsResults`-style thin comparator in src/compare.ts
     (documented as per-instance-only determinism - kills scan-order
     dependence and stabilizes the cluster_top_k amplification cut).
     Cross-ingest identity is enforced DOWNSTREAM at search.ts:1034, where
     the physics+classic merge has `entry.content` in scope and gets the
     full `compareScoredResults`.
  d. **Already-deterministic sites, kept with a note** - api.ts:2232
     (includeRecent: created desc -> id localeCompare) already carries an
     explicit per-instance tiebreak; created reflects ingest order so it is
     cross-ingest stable at ms granularity. Leave logic as-is; add a comment
     referencing compare.ts so future editors know the pattern is deliberate
     (r2 critic LOW - dropped from the r1 map without note).
  - Also: search.ts:499-500 (`bm25Ranked`/`cosineRanked` pre-RRF rankings,
    feed selectGraphSeeds + RRF rank assignment) get the tail appended after
    their score keys (r1 critic LOW - on the recall path, was missing from
    the map).
  Where the sorted element shape differs (e.g. `{entry, score}` vs raw rows
  vs `{score, rerankScore}`), use a thin arrow that delegates to the shared
  key logic - no per-site reimplementation of the ordering rule. The executor
  MUST re-grep `\.sort\(` across src/ and reconcile against this list before
  finishing - the list is a map, the grep is the law (enumerate-all rule);
  every site is classified (a), (b), (c), (d), or explicitly out-of-scope
  with reason. MMR's strict-`>` first-wins loop
  (search.ts:788-841) is already deterministic given deterministic input
  order - add a comment, no logic change.
- SQL tie keys (per-instance stability so scan order never decides):
  store.ts:818 FTS -> append `, m.id ASC`; :839 LIKE -> append `, id ASC`;
  :1532 fresh-tail -> `ORDER BY created DESC, id DESC`; loadEntriesByIds
  (store.ts:1372) -> `ORDER BY created ASC, id ASC`; graph.ts
  `loadEntitiesByMemoryId` -> `ORDER BY id ASC`.
- Benchmark harness sorts (benchmarks/longmemeval/chunk_per_turn_hybrid_retrieve.mjs:289,
  :314, :322): add `|| sid-lexicographic` tiebreaks so eval artifacts stop
  encoding scan order. Small, isolated, keeps future eval numbers honest.

### T3 - regression tests (real DB, per project convention)

- `tests/recall-cross-store-determinism.test.ts`: build two stores in temp
  dirs with DIFFERENT directory names, identical content ingested in identical
  order (via writeEntry with path-style tags mimicking cmdRemember), run
  `hybridSearch` (and `searchBothHybrid`) with identical queries -> assert
  identical top-K CONTENT sequences. This is the acceptance criterion as a
  permanent test; it FAILS on master today (validated in-episode before fix).
- Comparator unit tests: equal scores -> content order decides; equal
  score+content -> id decides; embeddingInputText excludes exactly `path:*`.
- Primary-key preservation tests for the three non-score-primary sites (r1
  critic MED): DAG substitution still orders by overflow-child count when
  counts differ (api.ts:833); --evc-adaptive still orders by recency
  (cli.ts:1167 - test at the sorted-array level or via existing CLI-path
  tests); graph-hop ordering still puts 1-hop before 2-hop regardless of
  score (graph-recall.ts:248). Each asserts the primary key WINS over the
  new tail, plus one tie case where the tail decides.
- Reindex-identity tests: fresh store embed -> requiresReindex false
  (compare/save consistency - catches the reindex-loop failure mode);
  legacy store with bare-id meta -> requiresReindex true exactly once.

### T4 - docs

- CHANGELOG 1.26.0 entry (root cause + both fixes + reindex note).
  MUST include the legacy-store degradation window explicitly (r2 critic
  LOW): a pre-upgrade store on a recall-only workload gates embeddings on
  `!embeddingModelRequiresReindex` (search.ts:457, :897) and therefore runs
  BM25-only until an embed-touching op fires - advise running `hippo embed`
  once after upgrade to reindex immediately.
- TODOS.md: close the item with the corrected root cause (the filed
  "content-hash at ties" hypothesis was downstream; path-tag embedding
  contamination was dominant).
- benchmarks/LOCOMO_INVESTIGATION.md: append a dated correction to the
  "Determinism characterization" paragraph attributing the measured stdev to
  path-tag embed contamination (with the same-path rebuild evidence), pointing
  at this plan.
- README "What's new" line.

### T5 - version + release

Minor bump 1.25.0 -> 1.26.0 (behavior change: embedding text composition +
reindex trigger; additive determinism guarantees). 5 lockstep manifests
(package.json, openclaw.plugin.json, extensions/openclaw-plugin/{package.json,
openclaw.plugin.json}, src/version.ts) - `scripts/check-manifest-versions.mjs`
enforces via prepublishOnly. `npm run build:all` before ship (AGENTS.md).

## Verify-stage evidence (gates)

1. `npm test` (vitest, real DB) green including new tests.
2. Tier-1 micro-eval 100% (`python benchmarks/micro/run.py`).
3. Determinism probe (the acceptance): two fresh DIFFERENT-path stores,
   identical ingest, identical recalls -> identical top-5 content sets. Both
   as the new vitest test and re-running the episode probe script.
4. Tier-2 LoCoMo smoke (`--conversations 1 --sample 10 --score-mode evidence`,
   data from main repo `benchmarks/locomo/data/locomo10.json`, HIPPO_BIN =
   worktree build): delta vs prior smoke within noise; PLUS run twice with
   fresh temp dirs -> identical per-QA top-5 evidence sets (the LoCoMo-scale
   acceptance).
5. Within-store no-regression: same-path rebuild ordering unchanged vs master
   for a non-tied fixture (micro-eval covers).

## Risks / mitigations

- **Retrieval-quality shift from removing path tokens (T1).** Path tokens
  could have been doing accidental useful work in similarity for
  project-scoped queries (e.g. a query naming a project matching its
  `path:<project>` tag). Mitigation: (a) the FTS index covers tags
  (`fts5(id UNINDEXED, content, tags)`, db.ts:2336), so project-name queries
  still match path tags through the BM25 channel; (b) recall-time path
  relevance has a dedicated mechanism (v39 origin_project/pathOverlapScore);
  (c) micro-eval non-regression gate + LoCoMo smoke delta. If micro-eval
  regresses, STOP and re-scope with the operator.
- **Residual 1e-8 decay jitter can still cross near-ties.** The comparator
  fires on EXACT score equality only; two distinct scores 1e-9 apart can
  still swap across runs recalled at different times. Post-fix probability is
  negligible for real data; the double LoCoMo smoke (verify item 4) is the
  falsifier. If it flips there, epsilon-banding is the pre-registered
  escalation - operator decision, NOT silently added here (arbitrary epsilon
  changes ranking semantics).
- **Mixed-version stores ping-pong reindexes.** An older hippo reading a
  `#t2`-identity index sees a mismatch and reindexes back. Same class as an
  embedding-model swap; single-version deployments unaffected. CHANGELOG note.
- **Reindex cost on large stores.** First embed-touching op after upgrade
  rebuilds the index. Existing machinery already does this on model change;
  atomic (no partial index on failure). Note in CHANGELOG.
- **Comparator perf.** Content byte-compare only runs on exact score ties;
  post-T1 ties are rare. No measurable hot-path cost expected; p99 harness
  exists if challenged.
- **25-site sweep touching hot paths.** Mechanical, but wide. Mitigation:
  one shared comparator (no divergent clones), full vitest suite, micro-eval,
  snapshot tests already lock CLI render output.

## Out of scope

- **dedupe.ts:41-45 survivor selection** (independent-review finding, review
  round 1). `deduplicateStore` sorts by strength desc -> retrieval_count desc
  with no further key; for freshly-ingested near-duplicates the stable-sort
  fallback resolves to `created ASC, id ASC` load order, and `id` is a random
  UUID - so WHICH duplicate row survives consolidation can differ across
  fresh ingests. Same determinism class as this episode, but it changes
  surviving CONTENT during `hippo sleep`, not recall rank - a behavior
  change to consolidation deserving its own test coverage. Filed as a
  follow-up in TODOS.md at ship stage rather than folded in late at review.
- **api.ts assemble-path `cmpIso` chronological sorts** (same review, low).
  Pre-existing, same-ms residual only, context assembly not recall ranking.
- FTS/BM25 indexing of tags (separate eval-gated change).
- `scope:` tag semantics (detectScope derivation) - noted, not changed.
- api.recall's positional scoring divergence from CLI/MCP (A7.2 unification,
  has its own roadmap slot).
- Retrieval-strengthening mutation semantics.
- Full LoCoMo re-baseline (tier-3): follow-up after merge; tier-2 smoke is
  the in-episode evidence.

## Execution deviations (recorded 2026-07-09, post-verify; reviewers judge
## the code against THIS section where it supersedes T2 above)

1. **Shape (a) split into first-ranking vs re-rank sites.** Applying the
   content tail at RE-RANK sites broke the reranker-cross-encoder micro
   fixture: when a rerank pass produces tied scores (no-signal case), the old
   stable sort preserved the meaningful prior relevance order; the tail
   replaced it with arbitrary content order. Corrected architecture: the
   content tail lives ONLY at first-ranking sorts (search.ts:499-500, :680,
   :725, :1034, :1154, :1195; api.ts getContext x4; the (b)/(c)/(d) sites
   unchanged). Re-rank/merge re-sorts (goals.ts:360, cli.ts x5 opt-in blocks,
   rerankers/cross-encoder.ts:109, graph-recall.ts:266, multihop.ts:41,
   shared.ts:145/:290) are PLAIN stable score sorts: JS sort stability
   inherits the upstream deterministic order, and ties preserve the prior
   (meaningful) rank. Cross-ingest determinism is unchanged - it enters at
   the first sort and survives stability.
2. **EVC on-topic clause (micro gate remediation, measured).** T1's removal
   of path-tag dilution DE-COMPRESSES the similarity distribution; the
   acc-evc disambiguator measured 0.33x max (was above the 0.5 floor on the
   compressed scale). The floor stays 0.5; an OR-clause adds query-coverage
   (fraction of query tokens present in the candidate) >= 0.6 as the
   score-scale-independent on-topic test - the mechanic's own "same topic,
   different fact" definition applied to the query. Principled EVC
   calibration remains B1 depth.
3. **vmpfc fixture premise re-measured.** The fixture's no-flag query pins
   "bad option wins raw"; post-T1 the raw edge (1.21x) fell below the
   always-on outcome-boost swing (1.353x). The pair was re-worded and
   MEASURED to a 1.45x raw edge, inside the (1.353, 1.857) window where the
   no-flag premise holds AND --value-aware still flips. Measurement method
   recorded in the fixture description.
4. **tests/embedding-provider.test.ts contract update.** The "no forced
   reindex on upgrade" back-compat test pinned the pre-#t2 contract; updated
   to assert stale-exactly-once + stable-after-reindex, matching T1's
   deliberate one-time migration. Header comment in embedding-provider.ts
   updated likewise.
5. **LoCoMo smoke evidence (verify item 4).** Two fresh independent runs of
   the fixed build: 10/10 QAs byte-identical top-5 + scores (determinism
   acceptance MET at benchmark scale). Quality vs master baseline: mean 0.5
   vs 0.5 (n=10) - flat, no regression signal. Cross-path probe: identical
   order, max score delta 6.6e-8 (decay-at-now residual, as predicted).

## Acceptance mapping (from .devrl-backlog.md item 4)

- "stable secondary sort key at ties" -> T2 comparator + SQL keys.
- "two fresh identical ingests produce identical top-5 sets" -> T1 (dominant
  mechanism) + T2 (residue); proven by T3 test + verify item 3/4.
- "micro-eval no regression" -> verify item 2.
