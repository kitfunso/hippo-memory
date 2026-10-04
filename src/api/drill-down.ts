// DAG drill-down from a summary to its children.

import { closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { openStore } from '../store/open.js';
import { selectEntriesByIds, selectChildrenByParent } from '../store/entry-reads.js';
import { estimateTokens } from '../token-ledger.js';
import type { MemoryEntry } from '../memory.js';
import { passesScopeFilterForRecall } from '../recall-scope.js';
import type { Context } from './types.js';

// ---------------------------------------------------------------------------
// drillDown — DAG-aware recall Phase 1 Task 3
// ---------------------------------------------------------------------------

export interface DrillDownOpts {
  /** Cap on number of children returned. Default 50. */
  limit?: number;
  /**
   * Optional token budget. When set, children are appended in chronological
   * order (created ASC) until adding the next child would exceed the budget.
   * Token cost = the child's printed line under `cost`, else ceil(content.length / 4).
   *
   * For depth > 1, the budget is GLOBAL cumulative (NOT per-level).
   */
  budget?: number;
  /**
   * v0.30 / E5 — walk N levels down (default 1 = direct children only).
   * Higher values include children of children, etc. Internal hard cap 10
   * to prevent pathological depth walks. BFS uses visited Set for dedup
   * (defensive against shared-child data anomalies; DAG is acyclic by
   * construction).
   */
  depth?: number;
  cost?: DrillDownCost;
}

export interface DrillDownSummary { id: string; content: string; descendantCount: number; earliestAt: string | null; latestAt: string | null }
export interface DrillDownChild { id: string; content: string; layer: string; dagLevel: number; created: string }

// Absent, the budget pays for child content alone. `fixed` gets the largest child count the heading can print.
export interface DrillDownCost {
  child: (c: DrillDownChild) => number;
  fixed: (summary: DrillDownSummary, widest: number) => number;
}

export interface DrillDownResult {
  summary: DrillDownSummary;
  children: DrillDownChild[];
  totalChildren: number;
  truncated: boolean;
}

/**
 * v1.6.4 discriminated failure shape. Two reasons distinguishable:
 *   - `not_found`: covers genuinely-missing, wrong-tenant, AND
 *     scope-blocked (codex round 3 P1 — distinguishing scope_blocked
 *     from not_found on non-HTTP surfaces leaked private-row existence
 *     to no-scope callers, even though the HTTP route already collapsed
 *     them. Collapse at the API layer.)
 *   - `not_drillable`: id is a leaf row (level 0/1). Caller-actionable.
 *
 * If a future drillDown gains a `scope` opt for explicit-scope callers,
 * a `scope_blocked` failure could be safely re-introduced ONLY for that
 * code path (caller already proved authorization by passing a scope).
 */
export interface DrillDownFailure {
  failure: 'not_found' | 'not_drillable';
}

export type DrillDownOutcome = DrillDownResult | DrillDownFailure;

/**
 * Walk one step down the DAG from a level-2 (or higher) summary to its direct
 * children. Companion to `recall(... summarizeOverflow: true)` — when recall
 * surfaces a summary with `substitutedFor: [...]`, the caller drills into the
 * summary id to recover the original detail.
 *
 * Tenant scope: only summaries owned by `ctx.tenantId` are reachable. The same
 * scope filter that recall applies is enforced on the children — a level-2
 * summary in `slack:public:CGEN` cannot leak `slack:private:*` children even
 * if the underlying DAG accidentally linked across scopes.
 *
 * Returns a discriminated `DrillDownOutcome`: `DrillDownResult` on success,
 * or `{failure: '...'}` for `not_found` (covers genuinely-missing AND wrong-
 * tenant, intentionally indistinguishable), `not_drillable` (id is a leaf
 * row), or `scope_blocked` (caller has no scope grant for the row's scope).
 *
 * Pre-v1.6.4 returned null for all four cases. JS callers migrate via
 * `'failure' in result` checks; HTTP route maps `not_drillable` to 422.
 */
export function drillDown(
  ctx: Context,
  summaryId: string,
  opts: DrillDownOpts = {},
): DrillDownOutcome {
  const limit = opts.limit ?? 50;
  // v0.30 / E5: depth defaults 1 (backward compat); hard cap 10 levels
  // prevents pathological deep trees. CLI/HTTP/MCP reject invalid values.
  const depth = Math.max(1, Math.min(Math.trunc(opts.depth ?? 1), 10));
  const db = openStore(ctx.hippoRoot);
  try {
    return drillDownOn(db, ctx, summaryId, depth, opts, limit);
  } finally {
    closeHippoDb(db);
  }
}

function drillDownOn(
  db: DatabaseSyncLike,
  ctx: Context,
  summaryId: string,
  depth: number,
  opts: DrillDownOpts,
  limit: number,
): DrillDownOutcome {
  const summary = selectEntriesByIds(db, [summaryId], ctx.tenantId).get(summaryId) ?? null;
  // No unscoped cross-tenant probe here: the tenant-scoped read's miss covers
  // both "doesn't exist" and "exists in another tenant" by design.
  // Distinguishing them via an unscoped lookup would leak existence to
  // unauthorised tenants. The two cases collapse into not_found.
  if (!summary) return { failure: 'not_found' };
  if ((summary.dag_level ?? 0) < 2) return { failure: 'not_drillable' };
  if (!passesScopeFilterForRecall(summary.scope ?? null, undefined)) {
    // codex round 3 P1: collapse to not_found. A distinguishable
    // "scope_blocked" tells a no-scope caller "this row exists, just
    // not for you" — same existence-leak the HTTP 404 collapse was
    // already preventing. Match the HTTP behaviour at the API level.
    return { failure: 'not_found' };
  }

  const { collected, level0DirectCount } = collectDescendants(db, ctx.tenantId, summaryId, depth);

  const summaryOut: DrillDownSummary = {
    id: summary.id,
    content: summary.content,
    // v0.30 / E5: the STORED direct-child count; the legacy fallback counts
    // level-0 children, never the BFS-depth-N total (independent-review MED #4).
    descendantCount: summary.descendant_count ?? level0DirectCount,
    earliestAt: summary.earliest_at ?? null,
    latestAt: summary.latest_at ?? null,
  };
  const all: DrillDownChild[] = collected.map((c) => ({
    id: c.id,
    content: c.content,
    layer: c.layer,
    dagLevel: c.dag_level ?? 0,
    created: c.created,
  }));

  const { children, truncated } = capChildren(all, summaryOut, opts, limit);

  return {
    summary: summaryOut,
    children,
    // v0.30 / E5: totalChildren = BFS-collected count (depth-aware). For
    // depth=1 this equals the eligible direct-children count (backward
    // compat). For depth>1 it is the cumulative count across levels.
    totalChildren: collected.length,
    truncated,
  };
}

interface DescendantWalk {
  collected: MemoryEntry[];
  level0DirectCount: number;
}

interface CappedChildren {
  children: DrillDownChild[];
  truncated: boolean;
}

// BFS with a visited set: dag_parent_id is not unique, so a misconfigured tree could emit a child twice past depth 1.
// The level-0 count is kept apart so a legacy summary's descendantCount fallback counts direct children only.
function collectDescendants(
  db: DatabaseSyncLike,
  tenantId: string,
  summaryId: string,
  depth: number,
): DescendantWalk {
  const collected: MemoryEntry[] = [];
  const visited = new Set<string>([summaryId]);
  let frontier: string[] = [summaryId];
  let level0DirectCount = 0;
  for (let level = 0; level < depth; level++) {
    const nextFrontier: string[] = [];
    const kidsByParent = selectChildrenByParent(db, frontier, tenantId);
    for (const parentId of frontier) {
      const kids = kidsByParent.get(parentId) ?? [];
      const eligibleKids = kids.filter((c) => passesScopeFilterForRecall(c.scope ?? null, undefined));
      for (const k of eligibleKids) {
        if (visited.has(k.id)) continue;
        visited.add(k.id);
        collected.push(k);
        nextFrontier.push(k.id);
        if (level === 0) level0DirectCount++;
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }
  return { collected, level0DirectCount };
}

/** Global cumulative token budget first, then the `limit` cap. */
function capChildren(
  all: DrillDownChild[],
  summaryOut: DrillDownSummary,
  opts: DrillDownOpts,
  limit: number,
): CappedChildren {
  let children = all;
  let truncated = false;
  if (opts.budget !== undefined) {
    const out: DrillDownChild[] = [];
    let used = 0;
    const room = opts.budget - (opts.cost?.fixed(summaryOut, all.length) ?? 0);
    for (const c of all) {
      const t = opts.cost ? opts.cost.child(c) : estimateTokens(c.content);
      if (out.length > 0 && used + t > room) {
        truncated = true;
        break;
      }
      out.push(c);
      used += t;
    }
    children = out;
  }
  if (children.length > limit) {
    children = children.slice(0, limit);
    truncated = true;
  }
  return { children, truncated };
}
