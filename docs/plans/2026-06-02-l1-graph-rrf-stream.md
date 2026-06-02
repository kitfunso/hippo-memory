# L1 — Graph-retrieval stream into RRF (plan)

**Date:** 2026-06-02
**Roadmap:** `ROADMAP-RESEARCH.md` Track L item L1 `[next, depends on E3.1]` — "a new graph ranked-list producer that feeds `src/rrf.ts` as a third fusion input beside BM25 + dense, distinct from `src/graph-recall.ts`."
**Episode:** `01KT5302T7P2E2RGSZBMSMH03Y`
**Target version:** 1.21.0 (minor).

## 1. Problem & scope

Add a **graph-retrieval ranked list** as a 3rd RRF stream in `hybridSearch` (`scoring:'rrf'`), beside BM25 + dense. The stream **re-ranks within the candidate pool** by graph proximity to the strong lexical seeds: a memory that is lexically weak for the query but graph-adjacent to a strong lexical hit gets lifted. Opt-in, default-off.

**In scope:** the producer, the `hybridSearch` rrf-path wiring, a thin CLI surface, a pre-registered hippo-native ablation, real-DB tests.
**Out of scope (deferred, named):**
- **L1-eval** — the LongMemEval-oracle graph-stream ablation. The F9 oracle harness fuses *session_ids* and LME has **no native hippo entity graph**; building one needs E3.1 extraction over ~199K LME turns — a separate eval-infra lift, not "pure win." Pre-registered as a follow-up.
- Production `'blend'`-mode graph signal (rrf-mode is L1's surface; `'blend'` is separate).
- PPR/HippoRAG personalized walk (rejected Framing 1 — wasted on today's `supersedes`-mostly graph; revisit when E3.1 cross-object edges densify).
- Orthogonal out-of-pool injection — that is `graph-recall.ts`'s job and already ships. L1 is the complementary within-pool lever.

## 2. Source-read findings (pre-reg Gate (a))

Read at worktree HEAD = `origin/master` `20cfcc2` (v1.20.0) on 2026-06-02:
- **`src/search.ts:466-482`** — rrf fusion builds `bm25Ranked` + `cosineRanked` (orderings of `entries[]` indices over the `eligible` set `bm25>0||cosine>0`), then `rrfFuse([bm25Ranked, cosineRanked], [bm25Weight, embeddingWeight], { absentRank: entries.length + 1 })`. Only under `scoring:'rrf'` **and** `useEmbeddings`; default `scoring='blend'`.
- **`src/rrf.ts`** — `rrfFuse<T>` is already generic over **N** ranked lists; `absentRank` default = `max(list.length)+1`. A 3rd list is mechanically supported with zero change to rrf.ts.
- **`src/search.ts:400-418`** — `entries[]` is **already bi-temporally filtered** (as-of / superseded-drop) *before* fusion. The graph stream therefore needs no re-filtering — it only assigns ranks to entries already in the filtered pool.
- **`src/graph-recall.ts`** — the E3.2 traversal to reuse: `loadEntitiesByMemoryId(root,tenant,memIds)` → seed entities; BFS both directions via `loadNeighborRelations(root,tenant,frontier,{limit})` with a per-hop fanout cap + `visited` set; `loadEntitiesByIds` to resolve reached → memoryId. Expands across local **and** global roots. (graph-recall does post-hoc injection + score inheritance; L1 reuses only the *traversal*.)
- **`src/graph.ts`** read helpers exist: `loadEntitiesByMemoryId` (401), `loadEntitiesByIds` (430), `loadNeighborRelations` (464). Read-only; an L1 module that only SELECTs may live outside graph.ts (E3.3 `check-graph-writes` lint permits reads).
- **rrf-mode has ZERO production callers** (`grep scoring: src/ scripts/ bench/` = empty); the F9 benchmark calls `rrfFuse` **directly in the `.mjs`** (`benchmarks/longmemeval/chunk_per_turn_hybrid_retrieve.mjs:319`), **not** through `hybridSearch`. ∴ wiring a 3rd stream into `hybridSearch` does not touch the F9 benchmark or any production recall path — it is additive and opt-in.
- **13 `hybridSearch` call sites** (api.ts, cli.ts×2, eval.ts, mcp/server.ts×2, shared.ts×2, internal×5). The new option is an optional field → all 13 keep byte-identical behaviour.

## 3. Design — the graph-rank-stream producer

New module **`src/graph-stream.ts`** (read-only; SELECTs only → E3.3 lint green):

```ts
export interface GraphStreamOpts {
  hippoRoot: string;
  tenantId: string;
  globalRoot?: string;          // expand global seeds in their own store, like graph-recall
  hops?: number;                // default 2; hard cap MAX_HOPS=3 (reuse)
  decay?: number;               // per-hop multiplicative decay; default 0.5
  maxNeighbors?: number;        // per-hop fanout cap; default 25 (DEFAULT_MAX_NEIGHBORS)
  seedCount?: number;           // # top lexical seeds to expand from; default min(10, pool)
}
/** Returns entries[] indices ordered by graph-proximity score (desc).
 *  Only indices that are graph-reached AND in-pool appear; the rest are
 *  absent (→ rrfFuse absentRank). Pure reads. */
export function graphRankStream(
  entries: MemoryEntry[],
  seedIndices: number[],        // top lexical seeds (by combined bm25/cosine pre-rank)
  bm25Ranked: number[],         // for seed lexical-strength ordering
  cosineRanked: number[],
  opts: GraphStreamOpts,
): number[];
```

Algorithm:
1. Build `memId → entryIndex` map over `entries[]` (one pass).
2. `seedMemIds = seedIndices.map(i => entries[i].id)`. Per seed, a **seed strength** = `1/(lexRank)` where `lexRank` is the seed's best of (bm25Ranked position, cosineRanked position) — so a neighbour of a *top* seed outranks a neighbour of a weak seed. **Note (plan-eng-critic):** this scale only sets the *within-graph-stream ordering*; RRF then re-ranks the graph list by `1/(k + graphRank)`, so the absolute `1/lexRank` magnitude is **washed out** by fusion — do not tune this curve expecting a fused-score effect, only the induced order matters.
3. For each root in `[hippoRoot, globalRoot?]`: `loadEntitiesByMemoryId` for the seeds present in that store; record `originSeedStrength` per seed entity. BFS both directions up to `hops`, per-hop fanout cap, `visited` set (cycle-safe) — the `produceHitsForRoot` shape from graph-recall.ts.
4. For each **reached** entity at depth `d` (d≥1, i.e. **neighbours only — seeds themselves are NOT scored by the graph stream**, since they already rank via bm25/cosine; scoring them would double-count and dilute the orthogonal graph signal): map `entity.memoryId → entryIndex`; if in-pool, `graphScore[idx] = max(graphScore[idx], originSeedStrength × decay^d)`.
5. **Seed-exclusion guard (plan-eng-critic MED).** `graphScore` is keyed by `entryIndex` **globally across roots**, but each root's BFS seeds its own `visited` set per-root — so a memory that is a seed in the local store could be *reached as a neighbour* in the global store's traversal and pick up a score via `max()`. After accumulation, **explicitly delete every `idx ∈ seedIndices` from `graphScore`** (belt-and-suspenders) so the "seeds are never scored by the graph stream" invariant holds across roots, not just within one.
6. Return `[...graphScore.keys()]` sorted by score desc (ties broken by index asc for determinism).

Defaults: `hops=2, decay=0.5, maxNeighbors=25, seedCount=min(10,pool)`. No new constants beyond these; `k` stays `RRF_K=60` (the rrf.ts JSDoc forbids tuning k without a cross-corpus eval).

## 4. Wiring in `hybridSearch`

New option on the `hybridSearch` options object:
```ts
graphStream?: { weight: number } & GraphStreamOpts;   // weight = RRF weight for the graph list
```
- Active **only** when `graphStream && graphStream.weight > 0 && scoringMode==='rrf' && useEmbeddings`. Otherwise the code path is the existing 2-list fusion — **byte-identical** (locked by a snapshot test).
- When active: compute `seedIndices` (top `seedCount` by combined lexical pre-rank), call `graphRankStream` → `graphRanked`. If `graphRanked.length === 0` (empty graph / no seed maps to an entity / nothing in-pool) → **skip the 3rd list** (fall back to the identical 2-list fusion; no ordering change). **(plan-eng-critic MED:** must *skip*, not "include an empty list" — an all-absent 3rd list adds a uniform constant `w_g/(k+absentRank)` to the RRF base, but `search.ts` multiplies the base by **non-uniform** per-entry multipliers (strength/recency/decision/path/scope/extraction), so `(base+C)·m_i = base·m_i + C·m_i` is **not** order-preserving. Skip-when-empty is the only byte-identical path.**)** Else:
  `rrfFuse([bm25Ranked, cosineRanked, graphRanked], [bm25Weight, embeddingWeight, graphStream.weight], { absentRank: entries.length + 1 })`.
- `absentRank` stays `entries.length + 1` (explicit) so the BM25/dense streams' absent-contribution is unchanged whether or not the 3rd list is present.
- Default graph weight when a caller enables it without specifying: caller must pass `weight` (no implicit default — opt-in is explicit). The ablation/dry-run picks the recommended value.

## 5. CLI surface (thin)

Add `hippo recall --graph-stream` (boolean) + `--graph-hops <N>` (optional): forces `scoring:'rrf'` and sets `graphStream` with a default weight (e.g. 0.5) + defaults above. **Disclosure (for the critic):** `--graph-stream` *implies* rrf-mode recall (production default is `'blend'`), so the flag bundles two behaviours. Rationale to include: makes L1 reachable + manually testable end-to-end on a real store; small wrapper. Alternative if the critic objects: library-API + ablation only, defer the flag. **Decision deferred to plan-eng-critic.**

## 6. Ablation — the success criterion (hippo-native, pre-registered)

**Surface:** a real-DB fixture store with E2 objects → E3 `entities`/`relations`, built so that:
- **Graph queries (G):** the answer memory is **in-pool but lexically weak** (ranks > 5 under 2-stream fusion) and **graph-adjacent** (≤`hops`) to a **strong lexical seed**. This is the case the graph stream should rescue into top-5.
- **Control queries (C):** the answer is a strong lexical hit with **no graph path** from a seed. The graph stream must be **inert / no-harm** here.

**Metric:** R@5 (+ R@3) over G and C, `graphStream` ON vs OFF, same store, same seeds.

**Gate-A (workload validity):** graph non-empty; every G-answer has ≥1 relation path (≤hops) to a seed; every G-answer is in-pool; every G-answer ranks **> 5** under the 2-stream baseline (else there is nothing to lift — a G query that already passes is dropped from G).

**Gate (b) dry-run (BLOCKING before the binding run):** one G query shows its answer at **rank > 5 under 2-stream** and **≤ 5 under 3-stream** — proving the graph stream does **structural work** (moves a real lexically-weak-but-graph-adjacent answer into top-5), not a tiebreaker swap at irrelevant positions. If it fails, the mechanism is inert at the chosen weight → fix weight/design before locking.

**Gate-B (binding):**
- On **G**: `R@5(3-stream) > R@5(2-stream)`, reported as **raw answer counts** (e.g. "4/6 → 6/6"), no pp-smuggling.
- On **C**: `R@5(3-stream) ≥ R@5(2-stream)` — **no harm** on non-graph queries.
- **If G does not improve OR C drops → NULL/PARTIAL.** Report honestly (Honest Reporting rule). The mechanism may still ship as **opt-in infra with the null disclosed** (value = the wiring + the deferred L1-eval), but with **no "lifts R@5" claim**. Ship-vs-hold decided at verify against the actual numbers.

**Claim-scoping (plan-eng-critic MED — binding).** Gate-A keeps only G answers that rank `>5` AND are graph-adjacent to a strong seed — i.e. the fixture is hand-built to contain exactly the class the lever targets. So a PASS proves **"the mechanism rescues the targeted lexically-weak-but-graph-adjacent class without harming controls"** — it is a **mechanism test, NOT evidence of population-level R@5 lift on a representative query distribution** (that is what the deferred L1-eval must show on the oracle split). The result doc and any CHANGELOG/README line must use the mechanism-scoped wording, never an unqualified "L1 lifts R@5." The result doc reports **C-set raw counts AND per-query rank deltas** (not just G/C pass-fail), so an *inert-but-harmless* result is distinguishable from a *genuinely-helpful* one.

Prereg doc: `docs/evals/2026-06-02-l1-graph-stream-prereg.md` — locked only after Gate (a) [done] + Gate (b) dry-run PASS are both recorded with verdicts (F9 discipline). Result doc: `docs/evals/2026-06-02-l1-graph-stream-result.md`.

## 7. Tests (real-DB, no mocks — project rule)

`tests/graph-stream.test.ts`:
- seed→neighbour scoring; per-hop `decay^d`; fanout cap; local+global expansion; dedup keeps max score; deterministic order (ties by index).
- empty graph → `[]` (no-op); reached entity **not in pool** → ignored; a **superseded** entity already filtered out of `entries[]` → never scored (it can't be in-pool).
- seeds themselves not scored by the stream (neighbours only) — **incl. the cross-root case: a memory that is a seed AND a neighbour of another seed in the *other* store must NOT appear in the stream** (locks the §3.5 seed-exclusion guard).

`tests/search-graph-stream-rrf.test.ts`:
- `graphStream` off / `weight:0` / `scoring:'blend'` → **byte-identical** to the 2-stream rrf result (snapshot).
- `graphStream` on with a graph-adjacent lexically-weak entry → that entry's fused rank improves.
- empty graph with `graphStream` on → ordering unchanged (3rd list **skipped**, not included-empty — asserts the §4 skip path).

CLI test (flag ships, plan-eng-critic LOW): `recall --graph-stream` sets `scoring='rrf'` and returns results; **a plain `recall` (no flag) stays `scoring='blend'` byte-for-byte** — locks the rrf-mode coupling as documented behaviour, not a silent mode flip.

## 8. Ship

minor `1.20.0 → 1.21.0`; bump 5 manifests + `src/version.ts` `PACKAGE_VERSION`; CHANGELOG `## 1.21.0`; plan + prereg + result docs. `prepublishOnly` gates (manifest-versions, em-dashes-in-release-notes, check-graph-writes, build) must pass. PR → merge → publish → tag → GitHub release → global install verify.
