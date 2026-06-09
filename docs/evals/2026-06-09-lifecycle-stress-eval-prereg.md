# 2026-06-09 Lifecycle Stress Eval (first slice) - Pre-Registration

**Status:** DRY-RUN COMPLETE, NOT LOCKED AS A POSITIVE PRE-REG. The pre-lock dry-run (gate G3) found the HEADLINE mechanism does NOT fire on current hippo (consolidated summaries rank BELOW the strength-weakened source episodics in physicsScore), so this is reported as a MEASURED NULL rather than locked-then-run for a positive. See `docs/evals/2026-06-09-lifecycle-stress-eval-result.md`. The methodology below stands as the reusable ruler (harness in `scripts/lifecycle-stress/`).
**Author:** Keith So (orchestrated via /dev-framework-rl episode 01KTPKDCP4N3JZ8JQCA72FCG13)
**Roadmap anchor:** ROADMAP.md Part III "Lifecycle stress eval (keystone) [next]" - the ruler that gates the DAG consolidation feature ("build the ruler before the thing it measures").
**Revision note:** v3, after two plan-eng-critic rounds + two codex (cross-model) rounds, grounded in a source-read of the ranking/consolidation BODIES (not just signatures). v1 was circular (handed hippo the supersession oracle). v2 named a no-op decay lever and scored by source-memory-id (which consolidation would have scored as a loss). v3: HEADLINE is the EARNED effect (the sleep consolidation pipeline compresses redundancy so more distinct facts survive a fixed budget), scoring is BY FACT VALUE (so a consolidated summary is credited), the decay arm is DROPPED (no clean query-path lever), and supersession is a fair within-hippo ablation.

## Mechanism claim

Under a FIXED active-context token budget, as a single store grows 10x to 100x with controlled redundancy, hippo's lifecycle (the `sleep` consolidation pipeline, plus supersession) assembles a budget-bounded context that answers MORE distinct queried facts correctly than recency or relevance-without-lifecycle. The headline is EARNED: `sleep` discovers and merges near-duplicate clusters from the stream with no oracle labels, freeing budget for more distinct facts. Supersession's effect on stale answers is a SEPARATE within-hippo ablation (op on vs off): hippo is supplied the supersession edges (modeling the metadata an agent records when it makes a correction), so the stale axis measures EXPLOITATION of lifecycle metadata, not discovery.

## Why this eval exists

Per-haystack retrieval recall is saturated (default MiniLM 98.6 R@5, above gbrain's 97.6; `docs/evals/2026-06-09-longmemeval-per-haystack-dual.md`), so it cannot discriminate memory systems on the product thesis's moat: deciding what to keep, consolidate, and supersede as a store grows. No existing benchmark forces a forget/consolidate decision. This eval builds the instrument that does, in the large-store regime where retrieval stops being free.

## Scope of THIS first slice

IN:
- One held-out injector distribution. Three growth checkpoints (1x / 10x / 100x of a base unit).
- Four LOCAL main conditions across all checkpoints, plus two within-hippo attribution arms at the primary 100x cell. No frontier model.
- Three axes: QA accuracy (HEADLINE), active-context token cost, stale-answer rate (secondary), each deterministic (no LLM reader), scored BY FACT VALUE.
- >=20 seeds, paired statistics. Read-only, hermetic scoring.

OUT (explicitly deferred, so scope cannot creep):
- naive-append + frontier-1M-context-model baseline (flaky egress). Next follow-up.
- An LLM reader for QA (this slice uses a deterministic answer-token presence/rank proxy).
- AUTOMATIC DISCOVERY of staleness (conflict detection). This slice SUPPLIES supersession edges and measures only the SELECTION effect of applying them.
- A decay-as-lever arm: on the physics query path there is no clean retrieval-time decay knob (see source-read), so decay is held at hippo's default in ALL hippo conditions and decay-as-lever is a named follow-up.
- Fine-grained attribution INSIDE `sleep` (merge vs replay vs dedup): `sleep` runs several phases; this slice attributes to the `sleep` pipeline as a whole vs supersession, not to the merge step in isolation.
- Multiple injector distributions, real-trace corpora, composite-weight tuning.

## (a) Source-read (verified against the code bodies, file:line)

- `getContext(ctx, opts): Promise<ContextResult>` - `src/api.ts:2117`. For a real query it picks `physicsSearch` when `ctxConfig.physics?.enabled !== false` (the default `'auto'`), else `hybridSearch` (`api.ts:2293-2306`). This local physics/hybrid branch is taken only when the global store is empty; with a non-empty global, getContext uses the merged-global branch (`api.ts:2285`). The empty-global hermeticity pin (G4) guarantees the physics branch. `opts.budget` default 1500 (`api.ts:2122`). Superseded rows are HARD-EXCLUDED from assembly (`api.ts:2145-2147`). Returns `ContextResult { entries:{entry,score,tokens}[], tokens }` (`api.ts:2092`).
- Ranking on the physics path: `physicsScore` (`physics.ts:409-425`) = `gravity + momentum` (no temperature term). `gravity` uses `mass = computeMass(strength, retrievalCount) = max(0.01, strength*(1+0.1*log2(retrievalCount+1)))` (`physics.ts:122-123`). So the only age channel is `strength`. `computeTemperature(ageDays, temperatureDecay)` exists (`physics.ts:130`) but `temperature` is NOT a term in `physicsScore` and is built with a hardcoded `1.0`; therefore `temperature_decay` is a NO-OP for ranking. There is no clean retrieval-time decay knob on this path -> decay-as-lever is dropped from slice 1.
- Budget packing: `physicsSearch`/`hybridSearch` apply the budget as a greedy top-ranked fill that GUARANTEES at least `minResults` items (default 1) regardless of budget (`search.ts:762-771`). The harness pins `minResults` and records actual tokens (does not assume `tokens <= B`).
- `markRetrieved` (`src/search.ts`, imported `api.ts:65`): `getContext`/`recall` reinforce and WRITE BACK. So getContext is NOT a read-only scorer -> scoring uses a read-only path (below).
- `sleep(ctx, opts)` - `api.ts:2517` (`SleepOpts{dryRun?,noShare?}`). Runs MORE than merge: `consolidate` + replay (`replay.count` default 5) + physics sim + decay + dedup + audit + ambient (+ graph) phases, and CAN auto-share to global / run LLM phases when env enables them. The harness pins `noShare:true`, an empty global root, no LLM/network (Hermeticity), AND `replay.count = 0` for slice 1 (replay otherwise reinforces sampled survivors, `consolidate.ts:248-251`, which could lift weakened originals back above the budget cut and dilute the compression effect). Because `sleep` is multi-phase, slice 1 attributes to the pipeline as a whole.
- `consolidate(...)` merge pass - `src/consolidate.ts:459-510`: clusters `Layer.Episodic`, NOT `'extracted'`-tagged entries where pairwise `textOverlap >= MERGE_OVERLAP_THRESHOLD` (Jaccard, 0.35) and cluster size `>= MERGE_MIN_CLUSTER` (2); creates a new `Semantic` summary via `createMemory` (`consolidate.ts:493`) and WEAKENS each source episodic to `strength*0.3` (kept, not deleted; `consolidate.ts:506`). `mergeContents` (`consolidate.ts:544-555`): for k=2, `"[Consolidated from 2 related memories]\n\n<longest original>"`; for k>=3, a bulleted summary (each bullet <=120 chars). The summary CARRIES the original content (so a fact's answer token survives into it), which is why scoring must be by value, not source id.
- `supersede(ctx, oldId, newContent)` - `api.ts:1693`: CREATES a new memory from `newContent`, returns its id (does not link two pre-existing ids). The injector captures the returned id.
- `estimateTokens` - `src/search.ts` (`Math.ceil(len/4)`).

## Hermeticity (pre-registered; gate G4)

Each condition runs against an ISOLATED store: a fresh temp `HIPPO_HOME` per seed with an EMPTY global root (no merge of the operator's real global store). `sleep(noShare:true)`; LLM phases disabled (no `ANTHROPIC_API_KEY`; zero-dep local MiniLM embeddings; no network). `physics.enabled` pinned for all hippo conditions (see Conditions). This is what makes the run LOCAL and reproducible.

## Read-only scoring (pre-registered; gate G2)

Scoring MUST NOT let `markRetrieved` write-back accumulate across queries. The harness scores via a no-write search path (call `physicsSearch` directly + replicate getContext's budget packing, never the write-back) OR a per-query pristine store snapshot, pinned at G2. Recency baselines are already pure functions over the stream; this makes the hippo conditions equally side-effect-free during scoring.

## Conditions

Main (all checkpoints, 20 seeds). All read the SAME injected stream; all answer within budget B. `physics.enabled` pinned to its default (physicsSearch) for every hippo condition.
1. **naive-append (recency-fill).** Retain all; pack newest-first to B. No ranking, no dedup.
2. **recency-window (last-N + relevance).** Keep the last N memories (N = the most-recent whose cumulative tokens reach 2*B), relevance-rank to B. No lifecycle.
3. **hippo-no-lifecycle.** All memories; hippo read-only ranked assembly to B; NO `sleep`, NO `supersede`. Raw hippo retrieval (default decay, held constant).
4. **hippo-full.** All memories; hippo read-only ranked assembly to B; `sleep` run at each checkpoint; `supersede` applied when the injector emits a correction.

Attribution arms (PRIMARY 100x cell, 20 seeds), each isolable because `supersede` is a separate call from `sleep`:
5. **hippo-sleep-only.** `sleep` ON, no `supersede`. Isolates the sleep/consolidation pipeline's budget-compression effect.
6. **hippo-supersede-only.** no `sleep`, `supersede` ON. Isolates supersession's stale-filter effect.

## The held-out injector

A time-ordered stream. Content carries only natural facts plus an OPAQUE per-fact answer token; all eval labels live in a side metadata file keyed by an OPAQUE id (AUTHORING.md Lesson 1: no descriptive id leaks into scoring).

Fact classes (kept SEPARATE to avoid cross-contaminating merge clusters):
- **stable facts** - distractor mass + some queried.
- **redundant clusters (HEADLINE driver)** - each queried fact stated as k near-duplicate EPISODIC, untagged memories that all carry the SAME current answer token. Surface-varied, but bounded so pairwise `textOverlap >= 0.35` holds (so `sleep` merges them) WHILE current-vs-distractor relevance stays tied. EACH member places its answer token within the first 120 chars of the FIRST content line, so the token survives BOTH merge paths: k=2 (`mergeContents` keeps the longest original) and k>=3 (each bullet is truncated to `content.split('\n')[0].slice(0,120)`, `consolidate.ts:554`). `sleep` should merge the k dupes into one summary (carrying the answer token), freeing budget; naive/no-lifecycle keep all k.
- **evolving facts (SECONDARY stale axis)** - a fact corrected over time; for the lifecycle conditions the correction is applied via `supersede(ctx, oldId, newContent)` (returned id captured to the sidecar). The held-out label marks the current answer token.

Relevance parity: within a cluster, surface forms are generated so current vs non-current/old members are not systematically more/less relevant to the query. The pre-lock dry-run MEASURES the per-query score gap (does not assume a tie) AND measures pairwise `textOverlap` (must be >=0.35 for the redundant dupes); these two constraints are co-verified (G3).

Growth: scale distractor + redundant-cluster counts to 10x/100x while holding the queried-fact SET fixed across checkpoints. Label sidecar per memory: `{opaque_id, class, fact_key, answer_token, version, valid_from, superseded_by, is_current}`. hippo never sees these fields.

## The three axes (deterministic, scored BY FACT VALUE, no LLM reader)

For queried fact F: `answer(F)` = its current opaque answer token; `staleAnswer(F)` = a superseded answer token. A condition "contains" a token if any assembled entry's content includes it (so a consolidated SUMMARY that carries the token counts, fixing the score-by-id flaw).
1. **QA accuracy (HEADLINE).** Over the M queried facts at fixed B: fraction where the assembled context contains `answer(F)` AND no entry carrying a `staleAnswer(F)` outranks the first entry carrying `answer(F)`. Earned because fitting many facts under B requires compressing each redundant cluster (sleep), not an oracle. Presence is a deterministic lower bound on reader accuracy.
2. **Active-context token cost.** Report `ContextResult.tokens` and distinct-facts-correct per 1000 actual tokens (efficiency). `minResults` pinned; actual tokens recorded (not assumed `<= B`).
3. **Stale-answer rate (SECONDARY ablation).** Over evolving facts: fraction where the context contains a `staleAnswer(F)` AND (`answer(F)` absent OR a stale entry outranks the first current entry). Reported as hippo-full / hippo-supersede-only vs hippo-no-lifecycle (op on vs off), caveated as exploitation-not-discovery; NOT a fair-win claim over naive.

Composite (pre-registered, reported ALONGSIDE the three axes): `score = 0.45*QA_accuracy + 0.40*(1 - stale_rate) + 0.15*efficiency_norm`, with `efficiency_norm = 0` when `QA_accuracy < 0.5` (a near-empty context cannot score high efficiency). Weights fixed before any run. The composite is NOT the headline claim (its stale term rests on supplied supersession metadata); only the QA-accuracy success bar gates the mechanism verdict.

## Fixed budget (the signal mechanism)

Primary B = 1500 tokens (`getContext` default). Secondary sweep B in {1500, 4000}. A fixed B makes scale bite: as the store grows, the fraction that fits shrinks, so selection quality determines the answer.

## Checkpoints, seeds, statistics

- Checkpoints: S in {1x=100, 10x=1,000, 100x=10,000} memories; queried-fact set held fixed across S.
- Seeds: 20 distinct injector streams, hash-derived, recorded, paired across conditions.
- Stats: paired per-seed deltas with a paired permutation 95% CI (AUTHORING.md Lesson 3; pattern `benchmarks/sequential-learning/aggregate.mjs`). Mean-only forbidden.
- Runtime fallback (named now): if 20 seeds at 100x is infeasible, reduce the 100x cell to the first 10 seed indices (paired subset) and report it. 1x/10x stay at 20.
- Runtime control: embeddings computed once per seed-store, reused across conditions; only hippo conditions build a store (naive/recency are pure functions over the stream + shared embeddings).

## Workload-validity gate (Lesson 4 - runs BEFORE the mechanism gate)

On naive-append at 100x, B=1500: budget-binding (fraction of the store fitting B <= 0.10) AND naive QA accuracy materially below ceiling (<= 0.60). ALSO compute budget-binding on the ACTUAL post-sleep retrievable set for hippo-full (summary + weakened-but-kept originals that still outrank the cut), so the gate confirms hippo is also under genuine budget pressure (consolidated originals are weakened, not removed). If any fails -> workload invalid at local scale; report it, make NO mechanism claim (honest-null path).

## Pre-registered success bars (set BEFORE running; primary 100x, B=1500, paired over 20 seeds)

- **Headline (hippo-full vs naive-append AND vs recency-window):** QA-accuracy improvement >= 0.15 absolute, paired 95% CI lower bound > 0.05, at equal-or-fewer active-context tokens.
- **Earned-lifecycle isolation (hippo-full vs hippo-no-lifecycle):** QA-accuracy paired-delta 95% CI excludes 0.
- **Attribution (100x):** report hippo-sleep-only and hippo-supersede-only deltas vs hippo-no-lifecycle so the headline is attributable to the sleep pipeline (expected primary driver) vs supersession.
- **Secondary (stale axis):** hippo-supersede-only and hippo-full reduce stale-answer rate vs hippo-no-lifecycle, paired CI excludes 0; reported as an op-on-vs-off ablation, caveated.

## (b) 1-question dry-run (pre-lock gate - the mechanism must FIRE before lock)

Smallest scenario: ~40 memories, 4 queried facts each a 3-member redundant episodic cluster (carrying the fact's answer token), plus distractors; B small enough to force a cut. Required observations BEFORE lock: (i) `sleep` merges each cluster (merge count > 0); (ii) the consolidated summary carries the answer token and OUTRANKS the weakened (strength*0.3) originals so the originals fall out of budget-B packing (per-fact token footprint drops); (iii) hippo-full answers MORE of the 4 facts within B than naive-append. If any fails, the consolidation mechanism is not wired as believed; STOP and fix before locking.

## Pre-lock gates (all must pass before Status -> PRE-REG-LOCKED)

- **G1 Sentinel/leak sanity:** seed ONLY distractor/noise, query a queried-fact topic, assert recall at floor; no opaque id/label/answer-token appears in noise content.
- **G2 Read-only + correct-path:** source-read + a 2-row probe confirming the scoring path is read-only (no `markRetrieved` write-back accumulation) and uses the actual getContext query path (physicsSearch) with `minResults` pinned.
- **G3 Dry-run + merge/parity co-verify:** the (b) scenario fires (merge happens AND per-fact footprint drops AND more facts answered); AND the post-sleep summary content CONTAINS `answer(F)` for EVERY redundant-cluster queried fact (not merely merge-count>0, so a 120-char bullet truncation that drops the token is caught); AND redundant dupes measure pairwise `textOverlap >= 0.35` WHILE current-vs-distractor relevance is tied.
- **G4 Hermeticity:** probe confirms no merge of the operator global store, `sleep(noShare:true)` does not write global, no LLM/network call (embeddings local).

## Retraction conditions

- Workload-validity fails -> "workload-invalid at <=100x local scale", NO mechanism claim.
- hippo-full vs hippo-no-lifecycle QA CI includes 0 -> "lifecycle shows no measurable effect at <=100x local scale" (honest null).
- hippo-full QA < naive-append -> report as a regression, not a win.
- Any pre-lock gate (G1-G4) fails -> do not lock; fix root cause first.

## Threats to validity (documented, not hidden)

- Synthetic injector: measures relative lifecycle benefit on a controlled distribution, not real traffic. Real-trace replication is a follow-up.
- No LLM reader: answer-token presence/rank is a lower bound on reader accuracy.
- Supersession supplied, not discovered: the stale axis measures exploitation, not discovery; caveated.
- Coarse attribution: `sleep` runs multiple phases; slice 1 attributes to the pipeline vs supersession, not to merge in isolation. Finer attribution is a follow-up.
- Cluster amplification: `physicsScore` amplifies co-clustered near-duplicates (`physics.ts:444-477`); in hippo-no-lifecycle the k undeduped dupes mutually amplify, which can RAISE that baseline's ranking of the queried fact and NARROW the headline delta. This biases conservative (against the headline), so it does not threaten validity; noted for interpretation.
- Local scale ceiling (100x = 10k): if the lifecycle only separates beyond 10k, this slice reports an honest null and the next slice raises the ceiling.

## Deliverables / file layout

- `scripts/lifecycle-stress/inject.mjs` - held-out injector (+ label sidecar; captures supersede() return ids; carries opaque answer tokens).
- `scripts/lifecycle-stress/run.mjs` - harness: isolated stores, conditions across checkpoints x seeds at B via the read-only path, scores the 3 value-based axes, emits results JSON.
- Aggregation (paired permutation CI + composite + attribution table) is implemented inline in `run.mjs`'s `aggregate()` (no separate file).
- `tests/lifecycle-stress-*.test.ts` - injector determinism, sidecar integrity, value-based metric computation, G1 leak sanity, G2 read-only invariance, merge-fires + footprint-drop, workload-validity. Real-DB (project rule).
- `docs/evals/2026-06-09-lifecycle-stress-eval-result.md` - result doc (post-run, references this pre-reg).

## Results

<filled in post-run, after PRE-REG-LOCKED>
