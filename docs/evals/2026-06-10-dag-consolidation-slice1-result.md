# DAG consolidation hierarchy — first slice: result (MEASURED-FALSE)

Date: 2026-06-10 | Episode: `01KTQ2P0R20FRY23Y5C43C1NEF` | Branch: `feat/dag-consolidation-slice1` (off `origin/master` 5fafae4)
Plan + pre-registration: `docs/plans/2026-06-09-dag-consolidation-slice1.md`
Ruler: `scripts/lifecycle-stress/` (shipped PR #108).

## Headline

**The slice's hypothesis is FALSIFIED.** "Compressing consolidation summaries that substitute for their redundant children frees active-context budget, so more distinct facts fit and budget-bounded QA improves" — does **not** hold. The substitution **regresses** budget-bounded QA by **−6.3pp** under a binding budget; the compression alone is **neutral** on the relevance path. The mechanism is built, correct, and fully tested (14/14 real-DB) — the *idea* is what the eval rejected, exactly what the lifecycle stress eval exists to do.

## Result

Two cells (deterministic; 4 seeds; CI shown is paired bootstrap).

### Cell A — pre-registered config (6 facts, B=1500, 1x + 10x): SATURATED, cannot measure

| Condition | QA @1x | QA @10x |
|---|---|---|
| hippo-no-lifecycle | 100% | 100% |
| hippo-full | 100% | 100% |
| naive-append | 50% | 0% |

hippo-full vs hippo-no-lifecycle: **+0.0pp [0,0]** at both checkpoints. With only 6 facts, B=1500 fits every answer regardless of consolidation, so QA is pinned at 100% for both hippo conditions — **no accuracy headroom for compression to capture**. Per the methodology's workload-validity gate, this cell cannot test the mechanism (it is "couldn't measure," not a clean null). hippo-full does use marginally fewer tokens (1492 vs 1496 @10x), confirming the mechanism fires.

### Cell B — binding config (16 facts = injector max distinct topics, B=300, 1x): NEGATIVE

| Condition | QA | vs no-lifecycle |
|---|---|---|
| hippo-no-lifecycle | 75.0% | — |
| hippo-full (substitution ON) | 68.8% | **−6.3pp [−6.3, −6.3]** |
| hippo-full (substitution OFF, compression+DAG-node only) | 75.0% | **+0.0pp [0,0]** |
| naive / recency | 0.0% | — |

Deterministic across all 4 seeds (loses exactly 1 fact in 16). B genuinely binds here (naive fit-fraction 14.8%).

## Clean attribution (via the new `--no-substitute` A/B control)

- **Compression + DAG-node-wiring + tombstone alone: neutral on the headline (relevance) path (+0.0pp).** Safe.
- **The substitution is the regression (75.0 → 68.8).** Root cause: a **compressed summary retrieves worse than the raw child it replaces** (the summary blends/compresses, lowering its embedding similarity to a single-fact query). When substitution drops the children, the lower-ranked summary falls below the budget cut under a binding budget, so that fact is lost — where no-lifecycle kept the high-ranked raw child. Compression trades retrieval quality for size, and at this scale the quality loss dominates the size win.
- Secondary caveat: on the **strength-sorted ambient** assembly (no-query fallback), compression+DAG-node alone is **−6.3pp** (full-strength 18.8% vs no-life-strength 25.0%). A weak secondary path; logged as a follow-up.

## What shipped

A research PR (zero **headline** regression by default):

- **Substitution: DEFAULT OFF** (`physicsSearch` `substituteSummaryChildren ?? false`). It is measured-harmful on the headline path; retained as opt-in for the next iteration.
- **Compression + real DAG summary nodes + tombstone: active.** The merge pass now emits genuinely-compressing `dag_level=2` `dag-summary` nodes (relevance-neutral) with `dag_parent_id` child links, drill-down, and a supersession-aware **tombstone** rebuild (excludes + detaches superseded children) — the roadmap's hard dependency, a real correctness win independent of the budget result.
- **Eval improvements:** the binding-regime capability (just `--facts`/`--budget`) + a permanent `--no-substitute` / `LSE_NO_SUBSTITUTE` A/B control to isolate substitution from compression on any future DAG iteration.
- Zero schema migration (reused existing `dag_*` columns).

## Caveats / known limits

- **Strength-sorted secondary-path −6.3pp** from the compression/DAG-node change (substitution off). Headline relevance path is neutral. Follow-up: investigate the strength-sorted assembly's handling of L2 summaries.
- **Injector caps at 16 distinct topics**, so Cell B uses a small store (1x) + low B to bind. A larger distinct-fact pool (eval follow-up) would let the binding regime run at 10x/100x.
- Production cross-fact-drop risk in `substituteDagSummaries` (real `textOverlap` clusters can span facts, unlike the eval's disjoint vocabulary) — moot while substitution is default-off, but a prerequisite to ever enabling it.

## Follow-ups (for the next DAG iteration)

1. **The retrieval-quality gap is the real problem.** Before substitution can help, a summary must retrieve **>=** its best child (e.g. index the summary by its children's query vectors, or only substitute when the summary already out-ranks the children). Until then, compression-for-budget does not pay.
2. Successor re-linking: `supersede` does not propagate `dag_parent_id`, so the tombstone drops the stale child but the successor is not auto-inserted into the summary (the anti-lying requirement IS met; coverage is not).
3. Strength-sorted secondary-path regression (above).
4. Larger distinct-fact pool in the injector to run the binding regime at scale.

## Methodology note

Pre-registered bar was "directional positive at 4 seeds; formal +5pp accept at 20 seeds." The directional-positive gate is **not** met in either regime (saturated, then negative), so per the pre-registered plan this takes the **honest-negative** path. No tuning toward a positive was done; the `--no-substitute` control was added precisely to attribute the result honestly.

## DISPOSITION UPDATE (post codex review) — behavior NOT landed

The "What shipped" framing above is superseded. After three rounds of cross-model (codex) review, the **behavior change is NOT being merged to master.** Only this finding + the methodology/plan docs land. The full implementation (with the round-1/round-2 fixes) is **archived on branch `feat/dag-consolidation-slice1`** as the reference for the next iteration.

**Why:** the hypothesis is falsified (substitution −6.3pp, compression neutral), and three codex rounds surfaced six real correctness edges — all from wiring the DEFAULT merge pass into the extraction-DAG machinery, which inherits that machinery's full invariant surface (tenant scoping, dirty-state, supersession relink) at once. Hardening a measured-false mechanism is negative-value work.

### Implementation correctness edges (codex R1-R3; branch-archived, for the next iteration)
- **R1 idempotency** (FIXED on branch): repeated consolidation re-merged already-parented children → orphaned summaries. Fix: exclude `dag_parent_id`-set + `superseded_by` rows from merge candidates.
- **R1 read-tombstone** (FIXED on branch): `drillDown` surfaced superseded children before rebuild. Fix: read-path `!superseded_by` filter in `drillDown`.
- **R2 compressor value-loss** (FIXED on branch): fuzzy 0.7 Jaccard dropped distinct same-template values. Fix: set-equality collapse + removed the lossy token cap.
- **R2 detach durability** (FIXED on branch): the pendingWrites drop missed detached children. Fix: `rebuildDirtySummaries` returns `detachedChildIds`; caller drops them.
- **R3 mixed-tenant leak** (OPEN): `createDagSummaryNode` assigns `children[0].tenantId` and links all children — a cross-tenant cluster would leak content + orphan other tenants' children. Needs per-tenant partitioning (moot under single-tenant-per-process, real for multi-tenant serving).
- **R3 supersede successor not re-linked** (OPEN): `supersede()` creates the replacement with `dag_parent_id: null`, so the rebuilt summary drops the stale child but does not gain the successor. Anti-lying IS met; coverage is not. Needs `supersede` to propagate `dag_parent_id`.
- **R3 re-dirty churn** (OPEN): the batch-flush DAG hook re-marks a freshly-built merge summary dirty, causing a redundant rebuild next sleep. Needs clear-after-batch (or dirty-suppression for just-built summaries).

### Postmortem (architecture reconsider)
Common root across all three review rounds: routing the default (non-extraction) merge pass through the extraction-DAG node machinery couples it to every invariant that machinery already maintains. For a falsified hypothesis, that coupling is all cost. **The next iteration should redesign around the real blocker — a summary that retrieves at least as well as its best child (follow-up #1) — and re-derive only the machinery it needs, rather than reuse the full extraction-DAG path.** The lifecycle stress eval (now with a binding-regime capability + the `--no-substitute` A/B control) is the ruler that will gate it.
