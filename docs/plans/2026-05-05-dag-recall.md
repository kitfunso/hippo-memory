# DAG-Aware Recall — Phase 1

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Hippo's existing DAG hierarchy (`dag_level` 0..3) load-bearing in the recall path so a tight token budget returns summary nodes instead of dropping leaves. Reuses the lossless-claw context-engine idea where it fits, adapted to Hippo's "score-ranked memory list" model.

**Architecture:** Three pieces. (1) **Cached summary metadata** — add `descendant_count`, `earliest_at`, `latest_at` to summary rows so the assembler can reason about scope without re-walking the DAG. (2) **Budget-aware substitution in `search`** — when a query matches N leaves whose token cost exceeds the budget, replace the lowest-scoring contiguous group with their level-2 parent summary. Substituted-summary tokens are capped at `budget * 0.3` so a runaway DAG can't blow the budget. Substituted summary inherits the max score of dropped children. (3) **Drill-down API** — `hippo recall --drill <summary_id>` to walk from a summary to its children, and the same path exposed via MCP and the HTTP API.

**Self-review revisions (2026-05-05, post-plan-write):**
- `passesScopeFilter` is a LOCAL function in `api.ts:270` and `cli.ts:1249`, NOT exported. Use the exported `isPrivateScope(scope)` from `src/api.ts:71` directly.
- `loadEntriesByIds` and `loadChildrenOf` do NOT exist in `store.ts`. Both must be added as part of Task 1 (or a new Task 1.5).
- Substitution token cap: total substituted-summary tokens must not exceed `budget * 0.3` (rounded down). Beyond that, accept the leaf overflow.
- Substituted summary score = `max(dropped_child_score)` so it lands near where its strongest child would have, not at hardcoded 0.5.

**Pre-conditions established by survey:**
- Schema: `memories.dag_level` (0=raw, 1=extracted, 2=topic summary, 3=entity profile), `memories.dag_parent_id`, `memories.parents_json`. No migration needed for those.
- `src/dag.ts` already builds level-2 summaries during sleep via Jaccard-on-entity-tags clustering. Level 1 → 2 build path exists.
- `src/consolidate.ts:289-308` invokes `buildDag` after fact extraction.
- `src/cli.ts:4597-4638` (`cmdDag`) prints stats and a tree view; recognises level 3 as "entity profiles" but no level 2 → 3 build path exists. Phase 1 scope: defer level 3 build.
- **`src/search.ts` and `src/multihop.ts` have zero references to `dag_level`.** This is the actual gap.
- Lossless-claw reference: `https://github.com/Martian-Engineering/lossless-claw` (LCM paper from Voltropy). Cloned to `/tmp/lossless-claw`. Concepts lifted: depth-aware compaction, three-level escalation, fresh tail, drill-down expansion. Not lifted: delegation grants, sub-agent expansion, large file externalization.

**Out of scope (Phase 2/3 followups):**
- Level 2 → level 3 entity-profile build path.
- "Context engine" mode where Hippo replaces conversation messages with summaries (lossless-claw's primary use case). Separate plan, separate API surface.
- Sub-agent delegation for expansion.
- Large file externalization.
- Cache-aware compaction (Anthropic prompt-cache aware build batching).

---

### Task 1: Cached summary metadata

**Files:**
- Modify: `src/db.ts` — schema bump v24 → v25, add `descendant_count`, `earliest_at`, `latest_at` columns
- Modify: `src/memory.ts` — extend `MemoryEntry` with the same three fields (optional)
- Modify: `src/store.ts` — `MEMORY_SELECT_COLUMNS` const + writeEntry mapping
- Modify: `src/dag.ts` — populate the three fields when writing level-2 summaries
- Create: `tests/dag-summary-metadata.test.ts`

**Step 1: Bump schema to v25 with idempotent ALTER + backfill.**

In `src/db.ts`, after the v24 migration:

```ts
if (currentVersion < 25) {
  if (!tableHasColumn(db, 'memories', 'descendant_count')) {
    db.exec(`ALTER TABLE memories ADD COLUMN descendant_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tableHasColumn(db, 'memories', 'earliest_at')) {
    db.exec(`ALTER TABLE memories ADD COLUMN earliest_at TEXT`);
  }
  if (!tableHasColumn(db, 'memories', 'latest_at')) {
    db.exec(`ALTER TABLE memories ADD COLUMN latest_at TEXT`);
  }
  // Backfill: derive descendant_count, earliest_at, latest_at for existing
  // level-2 summary rows from their dag_parent_id children + recursively.
  // Best-effort backfill; new summaries populate at write time.
  db.exec(`UPDATE memories SET
    descendant_count = (
      SELECT COUNT(*) FROM memories AS c WHERE c.dag_parent_id = memories.id
    )
    WHERE dag_level >= 2 AND descendant_count = 0`);
  setMeta(db, 'schema_version', '25');
  setMeta(db, 'min_compatible_binary', '1.4.0');
}
```

**Step 2: Extend `MemoryEntry` and `MEMORY_SELECT_COLUMNS`.**

`MemoryEntry` gains:
```ts
descendant_count?: number;
earliest_at?: string | null;
latest_at?: string | null;
```

Update `MEMORY_SELECT_COLUMNS` in `src/store.ts:186` to include the three columns.

**Step 3: Populate at write time in `dag.ts`.**

When `buildDag` writes a level-2 summary, set:
- `descendant_count = members.length` (children currently linked)
- `earliest_at = min(member.created)` across cluster members
- `latest_at = max(member.created)` across cluster members

**Step 4: Test.**

`tests/dag-summary-metadata.test.ts` — open a temp store, insert 5 level-1 facts with sequential `created` timestamps, run `buildDag` (mocked LLM returning a fixed summary), assert the resulting level-2 row has `descendant_count = 5`, `earliest_at = ts[0]`, `latest_at = ts[4]`.

**Step 5: Commit.**

```bash
git add src/db.ts src/memory.ts src/store.ts src/dag.ts tests/dag-summary-metadata.test.ts
git commit -m "feat: cache descendant_count + earliest/latest_at on summary rows"
```

---

### Task 2: Budget-aware summary substitution in recall

**Files:**
- Modify: `src/search.ts` — add a post-ranking pass that swaps leaf groups for parent summaries when over budget
- Modify: `src/api.ts` — `recall` signature gains `summarizeOverflow?: boolean` (default true); `--no-summarize-overflow` flag passes false
- Create: `tests/dag-recall-substitution.test.ts`

**Step 1: Add the substitution pass to `search.ts`.**

After the existing budget-fill loop, before returning:

```ts
// DAG summary substitution (codex round 1 P0 candidate: keep behavior off by
// default if scope filtering ever drops the parent summary; we honour the
// existing scope filter explicitly in the lookup).
if (options.summarizeOverflow !== false && results.length > 0) {
  const overflowed = deduped.slice(results.length);
  if (overflowed.length > 0) {
    const overflowedLeaves = overflowed.filter((r) => (r.entry.dag_level ?? 0) <= 1);
    const parentIds = new Set<string>();
    for (const r of overflowedLeaves) {
      const parent = r.entry.dag_parent_id;
      if (parent) parentIds.add(parent);
    }
    if (parentIds.size > 0) {
      const summaries = loadEntriesByIds(hippoRoot, Array.from(parentIds))
        .filter((e) => e.dag_level === 2)
        .filter((e) => passesScopeFilter(e, options.scope));
      let savedTokens = 0;
      let droppedLeaves = 0;
      for (const summary of summaries) {
        // Only substitute if the summary is cheaper than the children we drop.
        const childIds = new Set(
          overflowedLeaves
            .filter((r) => r.entry.dag_parent_id === summary.id)
            .map((r) => r.entry.id),
        );
        const childTokenSum = overflowed
          .filter((r) => childIds.has(r.entry.id))
          .reduce((s, r) => s + r.tokens, 0);
        const summaryTokens = estimateTokens(summary.content);
        if (summaryTokens < childTokenSum && results.length + 1 <= effectiveMin + 50) {
          results.push({
            entry: summary,
            score: 0.5,  // mid-rank; summaries are not ranked-in by their own scoring
            tokens: summaryTokens,
            isSummary: true,
            substitutedFor: Array.from(childIds),
          });
          savedTokens += childTokenSum - summaryTokens;
          droppedLeaves += childIds.size;
        }
      }
      if (savedTokens > 0) {
        // Re-sort by score so the substituted summary lands near its children.
        results.sort((a, b) => b.score - a.score);
      }
    }
  }
}
```

**Step 2: Define `loadEntriesByIds` in `src/store.ts`** (it likely already exists for batched lookup; if not, add an `IN (?,?,?)` query bounded to ≤500 ids).

**Step 3: Tests.**

`tests/dag-recall-substitution.test.ts` cases:

1. **No DAG, no change.** Insert 30 level-0 leaves with no level-2 parent. Recall with `budget = 200` — confirm result count + tokens match the pre-Phase-1 behaviour (no summaries injected).

2. **Budget tight, summary substitutes.** Insert 5 level-1 facts under one level-2 summary. Recall with budget too small to hold all 5 — confirm the level-2 summary appears in results and at least 3 of the level-1 children dropped.

3. **Scope filter respected.** Level-2 summary is `slack:private:CXYZ`; query has no scope. The summary must NOT be substituted (existing default-deny `*:private:*` filter applies before substitution).

4. **Tenant isolation respected.** Summary in tenant A; recall in tenant B. Summary not substituted.

5. **Substitution cost-positive.** A level-2 summary that's BIGGER than the children it would replace — confirm substitution is skipped.

6. **`--no-summarize-overflow` opt-out.** Recall with `summarizeOverflow: false` — no substitutions even when beneficial.

**Step 4: Commit.**

---

### Task 3: Drill-down API + CLI

**Files:**
- Modify: `src/api.ts` — new `drillDown(ctx, summaryId, opts)` function returning child memories
- Modify: `src/cli.ts` — extend `cmdRecall` to accept `--drill <id>`, OR add `cmdRecallDrill`
- Modify: `src/mcp/server.ts` — new MCP tool `hippo_drill` mirroring `drillDown`
- Modify: `src/server.ts` — new HTTP route `GET /v1/recall/drill/:id`
- Create: `tests/dag-drill-down.test.ts`

**Step 1: `drillDown` in `api.ts`.**

```ts
export interface DrillDownResult {
  summary: MemoryEntry;
  children: MemoryEntry[];
  totalChildren: number;
}

export function drillDown(ctx: Context, summaryId: string, opts: { limit?: number; budget?: number } = {}): DrillDownResult | null {
  const { limit = 50, budget } = opts;
  const summary = readEntry(ctx.hippoRoot, summaryId, ctx.tenantId);
  if (!summary || (summary.dag_level ?? 0) < 2) return null;
  if (!passesScopeFilter(summary, undefined)) return null;
  const allChildren = loadChildrenOf(ctx.hippoRoot, summaryId, ctx.tenantId);
  const eligible = allChildren.filter((c) => passesScopeFilter(c, undefined));
  let children = eligible.slice(0, limit);
  if (budget) {
    let used = 0;
    children = [];
    for (const c of eligible) {
      const t = estimateTokens(c.content);
      if (used + t > budget) break;
      children.push(c);
      used += t;
    }
  }
  return { summary, children, totalChildren: eligible.length };
}
```

**Step 2: CLI flag.**

`hippo recall <query> --drill <summary-id> [--limit N] [--budget N]`. When `--drill` is passed, query is ignored; behavior is "show me the children of this summary."

**Step 3: MCP tool.**

Mirror `recall`'s tool schema, drop the query param, add `summaryId`. Return JSON list of children with the summary as a `parent` field.

**Step 4: HTTP route.**

`GET /v1/recall/drill/:summaryId?limit=N&budget=N` returns the same shape. Bearer auth, tenant scope from key.

**Step 5: Tests.**

`tests/dag-drill-down.test.ts`:
1. Drill on a level-2 summary returns its children.
2. Drill on a level-0 leaf returns null (only summaries are drillable).
3. Drill respects tenant isolation (cross-tenant returns null).
4. Drill respects `*:private:*` scope filter on children.
5. Drill with `--budget` truncates child set.

**Step 6: Commit.**

---

### Task 4: Fresh tail (lossless-claw lift)

**Files:**
- Modify: `src/search.ts` — add a "fresh tail" concept: last `freshTailCount` memories of the active scope are always included in recall regardless of score.

**Step 1: Implement fresh tail.**

```ts
const freshTailCount = options.freshTailCount ?? 0;  // default off; opt-in
if (freshTailCount > 0) {
  const tail = entries
    .filter((e) => e.kind === 'raw')
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, freshTailCount);
  const tailIds = new Set(tail.map((e) => e.id));
  // Prepend tail to results, dedup by id, then trim by budget.
}
```

Default off — opt-in via the recall API. Useful for "what did the user just say in the last 5 minutes" continuity recall (which Hippo already has at `src/continuity.ts` but not via this surface).

**Step 2: Test + commit.**

Defer to Phase 1.5 if scope creeps. Mark as P1 not blocking.

---

### Task 5: Documentation

**Files:**
- Modify: `README.md` — add a "Memory hierarchy" subsection under "What it does for your agent" mentioning DAG-aware recall.
- Modify: `docs/architecture.md` (create if absent) — describe the four levels, the build path, the recall substitution.
- Modify: `CHANGELOG.md` — Unreleased section with Added/Changed bullets.

Acknowledge lossless-claw lineage: "Phase 1 DAG-aware recall borrows the assembler-substitutes-summaries pattern from [lossless-claw](https://github.com/Martian-Engineering/lossless-claw) (LCM paper from Voltropy). Hippo's adaptation: substitute on score-ranked overflow, not on conversation order."

---

## Verification checklist

- [ ] Schema v25 migration is idempotent (running twice is a no-op)
- [ ] Backfill on existing v24 DBs populates `descendant_count` for level-2 rows
- [ ] `tests/dag-recall-substitution.test.ts` PASS (6 cases)
- [ ] `tests/dag-drill-down.test.ts` PASS (5 cases)
- [ ] `npx vitest run` PASS (≥1242 tests, +5 from current 1237)
- [ ] `node scripts/ci-seed-provenance.mjs` PASS (provenance gate still clean)
- [ ] `hippo recall <q> --budget 200` against a seeded store returns summary rows with `isSummary: true` flag
- [ ] `hippo recall --drill <summary-id>` returns the substituted children
- [ ] CI green on PR

## Risk register

- **Substitution masking real signal.** A query that needs a specific leaf detail gets a summary instead. Mitigation: substitution only happens for OVERFLOW (results that the budget already dropped); the top-ranked leaves still surface. Drill-down provides the escape hatch.
- **`isSummary` and `substitutedFor` are new SearchResult fields.** Consumers that destructure SearchResult shape may break. Mitigation: both are optional. Run the full test suite (1237 currently); any breakage surfaces.
- **Schema v25 rollback.** Older binaries (1.4.0 and earlier) opening a v25 DB will throw via the rollback guard set in v24. Acceptable — this is the documented behaviour.
- **Backfill on large stores.** The `UPDATE memories SET descendant_count = ...` runs once on first open of a v24-stamped DB. For ≤100k rows this is sub-second; larger stores may pause the migration for a few seconds. Acceptable; run during sleep / opt-in upgrade.
- **MCP tool surface expansion.** New `hippo_drill` tool changes the MCP catalogue. Clients that hardcode the tool list need updating. Mitigation: adding tools is additive in MCP; existing tools unchanged.

## Lossless-claw lifts — explicit summary

| Concept | Hippo Phase 1 | Lossless-claw | Adapted? |
|---|---|---|---|
| Depth-stratified summaries | levels 0/1/2 (3 deferred) | levels 0..N | yes, capped at 2 |
| Three-level escalation (normal/aggressive/fallback) | not in Phase 1 | yes | defer to Phase 2 |
| Fresh tail (last N raw always included) | Task 4 (opt-in) | always-on | adapted (opt-in) |
| Drill-down expansion | Task 3 | `lcm_expand` + sub-agent | simplified — direct child fetch, no sub-agent |
| Context engine assembler | not in Phase 1 | core | Phase 2 |
| Delegation grants / TTL | NO | yes | rejected for Phase 1 |
| Large file externalization | NO | yes | rejected; out of scope |
| Cache-aware compaction | NO | yes | rejected; defer |

## Phase 2 / 3 preview

- **Phase 2:** Context-engine mode. New `hippo assemble --conversation <id>` returns an assembled context array (summaries + fresh tail + budget-fit). MCP/HTTP surfaces. Three-level escalation in summarization (normal → aggressive → deterministic). Optional level 2 → level 3 entity profile build path.
- **Phase 3:** Drill-down via sub-agent delegation (lossless-claw's `lcm_expand_query` analogue). Large file externalization. Cache-aware compaction batching.
