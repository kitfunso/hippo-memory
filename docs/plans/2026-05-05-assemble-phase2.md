# Phase 2 — Hippo Assemble (Bio-Aware Context Engine)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `api.assemble(ctx, sessionId, opts)` and the matching CLI/MCP/HTTP surfaces. When an agent processes a turn, it asks Hippo for the chronological context for a session: fresh-tail raw rows + summary substitutions for older rows + budget-fit. Adapts the lossless-claw context-engine pattern to Hippo's score-ranked memory store.

**Architecture:** Read `memories` rows where `kind='raw' AND source_session_id = sessionId AND tenant_id = ctx.tenantId`, ordered by `created ASC`. The newest `freshTailCount` rows always pass through unchanged. For older rows, substitute parent summaries when available (level 2). Apply Hippo-additive eviction policy: when over-budget, evict the lowest-strength oldest non-fresh-tail rows first (decay + retrieval-count weighted) instead of pure chronological-oldest. Returns ordered `AssembledContextItem[]` ready for an LLM context window.

**What's Hippo-additive vs lossless-claw:**

| Capability | Lossless-claw | Hippo Phase 2 |
|---|---|---|
| Chronological ordering | yes | yes |
| Fresh-tail protection | yes | yes (re-uses v1.5.2 helper) |
| Summary substitution | yes (chunk → leaf summary, then condensed) | yes (level-1 → level-2 from existing dag.ts) |
| Budget eviction policy | newest-older first | **decay × retrieval-count weighted** |
| Three-level escalation in summary gen | yes | defer — existing dag.ts is single-tier |
| Conversation message ordering with role | yes (separate messages table) | NO — Hippo uses connector raw rows + session_events; no role concept |
| Sub-agent expansion (lcm_expand_query) | yes | NO — drillDown covers it without delegation |
| Large file externalization | yes | NO — out of scope |

The eviction policy is the real differentiator. Lossless-claw evicts oldest-first because conversation order is causal. Hippo can do better: a memory's `strength` already encodes decay × retrieval-count, so when budget is tight, evict the lowest-strength rows regardless of age. This means high-importance older rows survive while low-strength recent ones get summarized.

**Pre-conditions established by survey:**
- `session_events` table is keyed on `session_id` but holds AGENT-EMITTED notes (event_type = 'note' / 'outcome' / 'handoff'), not arbitrary messages. Phase 2 reads from `memories WHERE kind='raw' AND source_session_id=...` instead.
- `loadFreshRawMemories` exists from v1.5.2 (Phase 1 Task 4) but isn't session-scoped. Phase 2 needs a session-scoped variant.
- DAG summaries (level 2) link via `dag_parent_id`. Already populated for clusters of ≥3 level-1 facts. No new schema needed.
- v1.4.0 connectors stamp `source_session_id` only when the caller passes one. Slack and GitHub ingest do NOT today; they leave it null. **This means Phase 2 is most useful for agent-emitted memories OR for connectors that grow per-session ingest later.** Document this clearly.
- Strength formula is in `src/memory.ts:calculateStrength`. We re-use, don't re-derive.

**Out of scope:**
- Three-level escalation in summary generation (normal → aggressive → deterministic). dag.ts uses single-prompt summarization. Defer.
- Recursive condensation (level 2 → level 3). cmdDag advertises it; no build path exists. Defer.
- Adding a `role` column to session_events to mirror lossless-claw's message shape. Defer.
- Sub-agent delegation. Hippo callers drill themselves via existing `drillDown`.
- Large file externalization. Hippo memories are short text.

**Roadmap leftover decisions (Task 36):**
- **Phase 3 (sub-agent expansion + large file ext + cache-aware compaction):** Reject as a Hippo unit of work. The first two are lossless-claw-specific and don't fit Hippo's role as a memory store. Cache-aware compaction is an optimization for the sleep path and could be a v1.6.x patch later.
- **Level 3 entity profiles:** Useful but requires LLM clustering of level-2 summaries — more work than Phase 2. File for Phase 2.5 if usage warrants.

---

### Task 1: `loadSessionRawMemories` helper

**Files:**
- Modify: `src/store.ts` — add a session-scoped raw-row loader
- Create: `tests/dag-assemble-helpers.test.ts`

**Step 1: Add the helper**

```ts
/**
 * All `kind='raw'` rows for a given session, tenant-scoped, oldest first.
 * Used by `api.assemble` (docs/plans/2026-05-05-assemble-phase2.md Task 2)
 * to walk a session's chronological context. Excludes superseded rows.
 *
 * If sessionId is omitted or empty, returns []. The caller MUST pass
 * tenantId for cross-tenant isolation; the optional `tenantId` parameter
 * keeps backwards-compat with single-tenant callers but production uses
 * explicit ctx.tenantId.
 */
export function loadSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId?: string,
): MemoryEntry[] {
  if (!sessionId) return [];
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = tenantId !== undefined
      ? db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' AND source_session_id = ? AND tenant_id = ? AND superseded_by IS NULL ORDER BY created ASC`,
        ).all(sessionId, tenantId) as MemoryRow[]
      : db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' AND source_session_id = ? AND superseded_by IS NULL ORDER BY created ASC`,
        ).all(sessionId) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}
```

**Step 2: Test (5 cases)**

Cases: empty session id → []; rows in oldest-first order; tenant scope respected; superseded rows excluded; no rows for unknown session.

**Step 3: Commit.**

---

### Task 2: `api.assemble` core logic

**Files:**
- Modify: `src/api.ts` — new `assemble(ctx, sessionId, opts)` function
- Create: `tests/dag-assemble.test.ts`

**Step 1: Types**

```ts
export interface AssembleOpts {
  /** Token budget. Default 4000. */
  budget?: number;
  /** Number of recent raw rows always kept verbatim. Default 10. */
  freshTailCount?: number;
  /** Substitute parent summaries for older raws when available. Default true. */
  summarizeOlder?: boolean;
}

export interface AssembledContextItem {
  /** memory id (raw or summary) */
  id: string;
  content: string;
  /** ISO timestamp of the source row's `created` field */
  createdAt: string;
  /** True for the v1.5.2 fresh-tail protected window. */
  isFreshTail?: boolean;
  /** True when this is a level-2 summary substituted for one or more raw rows. */
  isSummary?: boolean;
  /** When isSummary, the raw row ids this summary covers. */
  substitutedFor?: string[];
  /** Cached strength (decay × retrieval × emotional). Lets the caller render
   *  a "confidence" hint without re-deriving from MemoryEntry. */
  strength: number;
}

export interface AssembleResult {
  sessionId: string;
  items: AssembledContextItem[];
  /** Total estimated tokens (≈ chars/4) of the items. */
  tokens: number;
  /** Total raw rows in the session BEFORE substitution / eviction. */
  totalRaw: number;
  /** Number of older raw rows that were summarized into a parent. */
  summarized: number;
  /** Number of raw rows evicted (over-budget, no parent summary). */
  evicted: number;
}
```

**Step 2: Algorithm**

```ts
export function assemble(ctx: Context, sessionId: string, opts: AssembleOpts = {}): AssembleResult {
  const budget = opts.budget ?? 4000;
  const freshTailCount = opts.freshTailCount ?? 10;
  const summarizeOlder = opts.summarizeOlder ?? true;

  const rows = loadSessionRawMemories(ctx.hippoRoot, sessionId, ctx.tenantId);
  const totalRaw = rows.length;

  // Apply default-deny + scope filter (mirror recall behaviour).
  const scoped = rows.filter((r) => passesScopeFilterForRecall(r.scope ?? null, undefined));

  if (scoped.length === 0) {
    return { sessionId, items: [], tokens: 0, totalRaw, summarized: 0, evicted: 0 };
  }

  // Split: fresh tail = newest freshTailCount; older = the rest.
  const freshTailIds = new Set(
    scoped.slice(-freshTailCount).map((r) => r.id),
  );
  const older = scoped.filter((r) => !freshTailIds.has(r.id));
  const tail = scoped.filter((r) => freshTailIds.has(r.id));

  // Try to substitute older rows with their parent summary.
  let summarized = 0;
  const olderItems: AssembledContextItem[] = [];
  if (summarizeOlder && older.length > 0) {
    const olderByParent = new Map<string, MemoryEntry[]>();
    const orphans: MemoryEntry[] = [];
    for (const r of older) {
      if (r.dag_parent_id) {
        const list = olderByParent.get(r.dag_parent_id) ?? [];
        list.push(r);
        olderByParent.set(r.dag_parent_id, list);
      } else {
        orphans.push(r);
      }
    }
    const parentIds = Array.from(olderByParent.keys()).filter(
      (pid) => (olderByParent.get(pid)?.length ?? 0) >= 2,
    );
    const parents = parentIds.length > 0
      ? loadEntriesByIds(ctx.hippoRoot, parentIds, ctx.tenantId)
          .filter((p) => (p.dag_level ?? 0) === 2)
          .filter((p) => passesScopeFilterForRecall(p.scope ?? null, undefined))
      : [];
    const parentIdSet = new Set(parents.map((p) => p.id));
    const claimedRawIds = new Set<string>();
    for (const parent of parents) {
      const claimed = (olderByParent.get(parent.id) ?? []).map((r) => r.id);
      claimed.forEach((id) => claimedRawIds.add(id));
      olderItems.push({
        id: parent.id,
        content: parent.content,
        createdAt: parent.earliest_at ?? parent.created,
        isSummary: true,
        substitutedFor: claimed,
        strength: parent.strength,
      });
      summarized += claimed.length;
    }
    // Older rows whose parent summary didn't qualify pass through as raw.
    for (const r of older) {
      if (claimedRawIds.has(r.id)) continue;
      olderItems.push({
        id: r.id,
        content: r.content,
        createdAt: r.created,
        strength: r.strength,
      });
    }
    // Orphans (no parent at all) already handled by the loop above since
    // we iterate `older` not `orphans` separately.
  } else {
    for (const r of older) {
      olderItems.push({ id: r.id, content: r.content, createdAt: r.created, strength: r.strength });
    }
  }

  const tailItems: AssembledContextItem[] = tail.map((r) => ({
    id: r.id,
    content: r.content,
    createdAt: r.created,
    isFreshTail: true,
    strength: r.strength,
  }));

  // Sort olderItems by createdAt asc; tailItems by createdAt asc; concat.
  olderItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  tailItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let items = [...olderItems, ...tailItems];

  // Budget fit. Hippo-additive eviction: drop the lowest-strength
  // non-fresh-tail item first when over budget.
  let tokens = items.reduce((acc, it) => acc + Math.ceil(it.content.length / 4), 0);
  let evicted = 0;
  while (tokens > budget && items.length > 0) {
    // Find the lowest-strength non-fresh-tail item.
    let worstIdx = -1;
    let worstStrength = Infinity;
    for (let i = 0; i < items.length; i++) {
      if (items[i].isFreshTail) continue;
      if (items[i].strength < worstStrength) {
        worstStrength = items[i].strength;
        worstIdx = i;
      }
    }
    if (worstIdx === -1) break; // Only fresh tail remains; cannot evict more.
    const cost = Math.ceil(items[worstIdx].content.length / 4);
    items = items.filter((_, i) => i !== worstIdx);
    tokens -= cost;
    evicted++;
  }

  return { sessionId, items, tokens, totalRaw, summarized, evicted };
}
```

**Step 3: Tests (8 cases)**

1. Empty session id → `items: []`.
2. Single raw row → 1 item, isFreshTail since freshTailCount default covers it.
3. Many raws + parent summary → older substituted, tail raw, counts correct.
4. Older raws without parent → pass through as raw items.
5. Budget tight → lowest-strength evicted first; fresh-tail untouched.
6. Tenant isolation: rows from other tenant ignored.
7. Scope filter: private-scoped rows excluded.
8. summarizeOlder=false → no substitutions.

**Step 4: Commit.**

---

### Task 3: CLI + MCP + HTTP surfaces

**CLI:** `hippo assemble --session <id> [--budget N] [--fresh-tail N] [--no-summarize-older] [--json]`

**MCP tool:** `hippo_assemble` — args `session_id` (required), `budget`, `fresh_tail_count`. Returns formatted summary block.

**HTTP route:** `GET /v1/sessions/:id/assemble?budget=N&freshTail=N&summarizeOlder=0|1`. Bearer auth, tenant scope from key. Returns AssembleResult JSON. 404 when session has zero raw rows.

3 tests per surface (~9 total).

---

### Task 4: Documentation + ship

**CHANGELOG:** new "Added" section under v1.6.0 listing the four surfaces + the bio-aware eviction angle. Acknowledge lossless-claw lineage with the differentiator table.

**README:** "What's new in v1.6.0" entry naming `assemble`, the bio-aware eviction, and the explicit non-goals (no role column, no sub-agent delegation).

**Plan doc:** mark complete by adding `## Implementation log` at bottom.

**Bump 5 manifests + lockfile + version.ts to 1.6.0.** This is a minor — new public API surface.

**Verification:**
- `npx vitest run` passes ≥1290 tests
- `node scripts/ci-seed-provenance.mjs` still exits 0
- CI green on master after push

---

## Risk register

- **`source_session_id` rarely populated.** Today, only certain agent-emitted memories carry it. Slack and GitHub ingest don't (they don't know which "session" the message belongs to). Mitigation: `assemble` returns `items: []` cleanly when no rows match. Doc note. Future: add a `--scope <name>` mode that aggregates by tag instead of session_id.
- **Strength-based eviction may drop important older context.** If strength is uncalibrated for a given workload, the lowest-strength row could still be the one the agent needs. Mitigation: opt-out via `summarizeOlder: false` keeps everything chronological. Future: optional `protectIds: string[]` array.
- **Summary substitution can over-compress.** If a session's older rows ALL link to one parent summary, the assemble returns just the summary + fresh tail. Acceptable per design. Caller can re-call with `summarizeOlder: false` for the unsubstituted view.
- **No three-level escalation in summary gen.** dag.ts uses a single Anthropic prompt; a poor LLM response produces a poor summary. Acceptable for Phase 2; Phase 2.5 can lift the lossless-claw escalation pattern.
