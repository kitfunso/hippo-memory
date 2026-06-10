# DAG consolidation hierarchy — first slice (plan, REVISED post outside-voice)

Date: 2026-06-09 | Episode: `01KTQ2P0R20FRY23Y5C43C1NEF` | Branch: `feat/dag-consolidation-slice1` (off `origin/master` 5fafae4)
Status: revised after a senior-code-reviewer pass. Q5 resolved by direct read of `run.mjs`. Accept bar decided: **directional@4 + formal@20**.

## Goal

Make the **default consolidation merge pass** produce genuinely-**compressing** DAG summary nodes wired into hippo's existing summary machinery, so budget-bounded retrieval improves. Measured on the shipped lifecycle stress eval ruler. Roadmap's "DAG consolidation hierarchy — smallest first slice" (L967-973), gated by the eval (PR #108).

## Why (root cause: the shipped eval + this audit)

- Eval (PR #108) found consolidation budget-null because (1) the merge summary is a **concatenation** >= sum(children); (2) `strength*0.3` weakening is **inert** (`calculateStrength` memory.ts:292 never reads stored `strength`).
- **Audit:** hippo ALREADY has the DAG subsystem — `buildDag` (dag.ts:119) builds L2 `dag-summary` nodes (`dag_level=2`, `dag_parent_id` links, `descendant_count`); recall has summary-substitution (api.ts:790), drill child-injection (search.ts:701), summary deboost (search.ts:610; `isDagSummary`=`dag_level∈{2,3}`), `drillDown` (api.ts:1441), supersede→`markSummaryDirty` tombstone (api.ts:1753). BUT `buildDag` fires ONLY for `extracted` facts and uses an LLM. The **merge pass** (consolidate.ts:459-510) — the eval's path — builds flat concat summaries with none of it.
- Fix = **wire the merge pass into the existing machinery + make it compress**, NOT a parallel `summary_of_id` column.

## Pre-registered success bar (FIXED before the run; docs/evals discipline)

The eval (`run.mjs`) calls `physicsSearch` **directly** (run.mjs:47,278); `getContext`/`recall` are never invoked, so all demotion logic must land in `physicsSearch`.

- **SHIP gate for this slice** (4 seeds, B=1500, 1x/10x): (a) **mechanism** confirmed by real-DB tests (compressing summary with tokens < sum(children); children demoted from the packed budget; `drillDown` recovers them; tombstone drops a superseded child); AND (b) **directional** positive point estimate on the relevance-union QA axis at 10x (hippo-full >= hippo-no-lifecycle), stale-answer rate not worse, determinism byte-identical.
- **FORMAL accept** (deferred to the pre-registered 20-seed follow-up cell, roadmap follow-up #5): +5.0pp relevance over hippo-no-lifecycle at 10x, paired-bootstrap CI excludes 0. NOT gated in this slice (4 seeds cannot resolve it; prior CI half-widths ±8-16pp).
- **HONEST-NULL path:** if the point estimate is flat/negative or stale-rate rises, ship the infra + an honest null (a valid *measured* outcome; same discipline as PR #108).
- Primary axis = relevance-union QA. strength-sorted is a noisy secondary (CI ±16pp): reported, not gated.

## Mechanism (3 parts — getContext branch dropped; all in `physicsSearch`)

1. **Zero-dep extractive COMPRESSOR** (replace `mergeContents`): collapse the cluster to the set of DISTINCT normalized informational lines (dedup unit = normalized **line/sentence**, NOT token; all N answer-tokens of a k=3 paraphrase cluster must survive), cap so summary tokens `<` sum(children) by a real margin. **Deterministic:** stamp the summary's `created`/`earliest_at`/`latest_at` from the CHILDREN's (sorted) timestamps, never `Date.now()`; no random; no Map-iteration-order dependence. Output **boilerplate-free dense text** (no `[Consolidated from N...]` prefix that dilutes embedding similarity).
2. **WIRE into DAG machinery** via a shared `createDagSummaryNode()` helper (extracted from `buildDag` dag.ts:143-168; node-creation ONLY, not summary-text gen): summary = `Layer.Semantic`, `dag_level=2`, `'dag-summary'` tag, `descendant_count` + earliest/latest_at from children, `clearSummaryDirtyAfterBuild`. Merged children: set `dag_parent_id` = summary.id, **keep `dag_level=0`** (substitution keys on `>1`, L3 build on `==2`; children must stay 0), keep (do not delete). **Remove** the inert `strength*0.3` write (grep + update consolidate/cli-supersede test assertions in the same commit).
3. **TOKEN-BUDGET substitution — a SHARED primitive applied at every final-assembly site.** The mechanism is a pure exported helper `substituteDagSummaries(candidates, {minChildren:2})` (in `src/search.ts`): given budget-candidate entries, DROP any child whose dag-summary parent (`dag_parent_id`) is ALSO present with >=2 present children, so the (smaller) summary substitutes. Children stay retrievable via `drillDown` (DB-backed). Apply it at BOTH sites that pack a final budget-bounded context:
   - (a) `physicsSearch`'s final pack (search.ts:1016-1030, on `merged` before the loop) — product behavior, behind a `substituteSummaryChildren` option (default ON when a dag-summary has >=2 present children).
   - (b) **the eval's `unionPerFact` GLOBAL REPACK (run.mjs:288-302)** — this is the context the eval actually MEASURES (a single shared B-token budget across all facts). Apply the helper to the `ranked` union before the pack loop. THIS is the binding site: without it, a child dropped on fact F's `physicsSearch` call is re-admitted via fact G (the round-2 crit).
   - **Why this is faithful, not gaming:** the eval measures ONE shared B-token context; a dag-summary that collapses K redundant children into one slot SHOULD occupy one slot, not K — that IS the DAG's value. The helper is applied equally to all conditions (no-op for naive/recency/hippo-no-lifecycle, which have no summaries; fires only for hippo-full, which built them).
   - Eval-path ranking neutralizations (`summaryDeboost:1.0`, `summaryFreshness:false`) are honored in the physics branch (search.ts:951-960); the dense compressor output (part 1) is the source-level fix so the summary competes on relevance.
   - The hybridSearch child-injection block (701-722) is a separate classic-path behavior (never reached after `resetAllPhysicsState`); gating it (`drillChildren`) is a minor correctness fix, not the mechanism.

## Tombstone (invalidation-under-supersession) — the roadmap hard dependency

`supersede` already marks the parent dirty (api.ts:1753). But `rebuildDirtySummaries` (dag.ts:243) calls the **LLM** `generateDagSummary` — a merge-built summary in a zero-dep store would never rebuild (stays dirty forever) → "graph that lies." **Fix:** `rebuildDirtySummaries` **dispatches on provenance** — the extractive compressor (part 1) for merge-built summaries (`source==='consolidation'` / no LLM config), the LLM for `buildDag`-built. The rebuilt merge summary MUST drop the superseded child's content. Mirror the successor-aware `asOf` pattern (search.ts:1067) for any read-time guard.

## Schema

**ZERO MIGRATION (confirmed).** `dag_level`, `dag_parent_id`, `descendant_count`, `earliest_at`, `latest_at`, `summary_dirty`, `last_rebuilt_at`, `rebuild_count` all exist (v13/v25/v28). Schema head stays **v38**; no schema-version test bump. (A minor npm version bump at deploy is a separate ship decision, not required for correctness.)

## Files

- `src/consolidate.ts` — merge pass: zero-dep compressor + emit dag-summary node (via helper) + set child `dag_parent_id`; remove inert weakening.
- `src/dag.ts` — extract `createDagSummaryNode()`; `rebuildDirtySummaries` provenance dispatch + zero-dep rebuild route.
- `src/search.ts` — export pure `substituteDagSummaries(candidates,{minChildren})`; apply in `physicsSearch` final pack (1016-1030) behind `substituteSummaryChildren`; honor `summaryDeboost`/`summaryFreshness`. Separately gate the hybridSearch injection (701-722) behind `drillChildren` (correctness fix).
- `tests/consolidate-hierarchy.test.ts` (new) — real DB, no mocks (compressor, node-wiring, tombstone, helper unit).
- `scripts/lifecycle-stress/run.mjs` — apply `substituteDagSummaries` in `unionPerFact`'s global repack (288-302, the measured context); pass `summaryFreshness:false` + neutralized deboost for the merge class; re-measure. Add the integration assertion to `tests/lifecycle-stress.test.ts`.

## Test plan (real DB, no mocks)

1. compressor: summary tokens `<` sum(children) tokens; ALL N answer-tokens of a k=3 paraphrase cluster survive.
2. merge pass sets `dag_level=2` + `'dag-summary'` + `descendant_count` on summary; `dag_parent_id` set AND `dag_level` still 0 on children.
3a. unit: `substituteDagSummaries` drops >=2 present children of a present dag-summary, keeps lone children, keeps summaries; pure + deterministic.
3b. integration THROUGH the eval assembly: build the merge store, run `unionPerFact` across multi-fact labels at fixed B, assert the assembled context EXCLUDES the substituted children, total tokens < sum(children), and all answer-tokens preserved. (Binds the mechanism to the MEASURED path, not a lone `physicsSearch` call — the round-2 fix.)
4. `drillDown` recovers the demoted children.
5. tombstone: 3 children → supersede A→A' → sleep → rebuilt summary omits A's stale token, includes A''s, `drillDown` omits A.
6. determinism: two full runs byte-identical (guards the timestamp/freshness fix).
7. regression: `consolidate*`, `*dag*`, `api-recall*`, `cli-supersede` suites green.

## Risks / collisions

- The eval's MEASURED context is `unionPerFact`'s global repack (run.mjs:288-302), which packs the per-fact `physicsSearch` union into one shared B. Substitution MUST bind there (not only in `physicsSearch`) or dropped children re-enter via another fact (round-2 crit). The shared helper is applied at both sites. Deboost + freshness are honored in the physics branch (search.ts:951-960), neutralized for the merge class on the eval path; the hybridSearch injection (701-722) is classic-path only and never fires after `resetAllPhysicsState`.
- **E3** (`feat/e3-sleep-enqueue-hook`) owns the dirty-queue + supersede-hook contract this slice extends → `git fetch` + rebase before ship, THEN re-run `cli-supersede` + `*dag*` suites specifically.
- Compression dropping answer tokens → guarded by test 1 + the accuracy floor.
- Default-behavior change for non-eval callers limited to the injection gate (a correctness fix); document it.

## Caveats / documented follow-ups (from plan-eng-critic R3, LOW)

- **Fairness invariant:** substitution is fair across conditions because baselines read the un-consolidated Store A (zero summaries → no-op) while hippo-full reads consolidated Store B. This A/B-store split IS the invariant; a future change that consolidated Store A or pointed a baseline at Store B would silently break equal application. State it in the result doc.
- **Production cross-fact-drop risk:** the eval's clean substitution relies on the injector's disjoint per-fact vocabulary (a merge cluster only contains one fact's dupes). Real-world `textOverlap` clusters CAN span facts, so the product-path substitution (physicsSearch) carries a cross-fact-drop risk: a child whose answer the summary does NOT carry could be dropped. Documented follow-up; do NOT read the eval's clean result as a production safety guarantee. (The high `MERGE_OVERLAP_THRESHOLD` limits this; `substituteSummaryChildren` is the safety valve.)

## Resolved (was: open questions)

Q1 bar → directional@4 + formal@20 (above). Q2 hook → a SHARED `substituteDagSummaries` helper applied at BOTH `physicsSearch`'s final pack AND the eval's `unionPerFact` global repack (run.mjs:288-302, the measured context). Q3 → zero migration. Q4 → remove inert weakening + fix tests. Q5 → minimal scope = parts 1+2 + the shared substitution helper (2 sites) + tombstone; the `drillChildren` gate is a minor correctness fix, not the mechanism.
