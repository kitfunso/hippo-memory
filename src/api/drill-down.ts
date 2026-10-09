// DAG drill-down from a summary to its children.

import { requireGroup, storeFor } from '../store-port.js';
import type { DescendantOrigin, SummaryDescendants } from '../store/port.js';
import { estimateTokens } from '../token-ledger.js';
import type { MemoryEntry } from '../memory.js';
import { passesScopeFilterForRecall, personalScopeOf } from '../recall-scope.js';
import { classifyOriginProject } from '../project-identity.js';
import type { CallerProject } from '../prompt-hook.js';
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
  project?: CallerProject;
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
 * or `{failure: '...'}` for `not_found` (covers genuinely-missing, wrong-
 * tenant and scope-blocked, intentionally indistinguishable) or
 * `not_drillable` (id is a leaf row).
 *
 * Pre-v1.6.4 returned null for all three cases. JS callers migrate via
 * `'failure' in result` checks; HTTP route maps `not_drillable` to 422.
 */
export async function drillDown(
  ctx: Context,
  summaryId: string,
  opts: DrillDownOpts = {},
): Promise<DrillDownOutcome> {
  const limit = opts.limit ?? 50;
  // v0.30 / E5: depth defaults 1 (backward compat); hard cap 10 levels
  // prevents pathological deep trees. CLI/HTTP/MCP reject invalid values.
  const depth = Math.max(1, Math.min(Math.trunc(opts.depth ?? 1), 10));
  const own = personalScopeOf(ctx.actor) ?? undefined;
  const readable = (row: DescendantOrigin): boolean =>
    passesScopeFilterForRecall(row.scope ?? null, undefined, own)
    && (!opts.project || classifyOriginProject(row.origin_project, opts.project) !== 'cross-project');
  const pastLimit = Math.floor(limit) + 1;
  const walked = await requireGroup(storeFor(ctx), 'dagReads').summaryWithDescendants(ctx.tenantId, summaryId, {
    depth,
    // A leaf answers not_drillable, so nothing under it is read.
    admit: (row) => readable(row) && (row.id !== summaryId || isDrillable(row)),
    page: limit >= 0 && Number.isSafeInteger(pastLimit) ? { rows: pastLimit, admit: readable } : undefined,
  });
  // No unscoped cross-tenant probe here: the tenant-scoped read's miss covers
  // both "doesn't exist" and "exists in another tenant" by design.
  // Distinguishing them via an unscoped lookup would leak existence to
  // unauthorised tenants. The two cases collapse into not_found.
  if (!walked) return { failure: 'not_found' };
  // A distinguishable "scope_blocked" would tell a no-scope caller "this row
  // exists, just not for you", the existence leak the HTTP 404 collapse prevents.
  if (!readable(walked.summary)) return { failure: 'not_found' };
  if (!isDrillable(walked.summary)) return { failure: 'not_drillable' };
  return drillResult(walked, opts, limit);
}

function isDrillable(row: MemoryEntry): boolean {
  return (row.dag_level ?? 0) >= 2;
}

function drillResult({ summary, levels, sizes: counted }: SummaryDescendants, opts: DrillDownOpts, limit: number): DrillDownResult {
  const collected = levels.flat();
  const sizes = counted ?? levels.map((level) => level.length);
  const total = sizes.reduce((sum, n) => sum + n, 0);
  const summaryOut: DrillDownSummary = {
    id: summary.id,
    content: summary.content,
    // v0.30 / E5: the STORED direct-child count; the legacy fallback counts
    // level-0 children, never the BFS-depth-N total (independent-review MED #4).
    descendantCount: summary.descendant_count ?? (sizes[0] ?? 0),
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

  const fixed = opts.budget !== undefined ? opts.cost?.fixed(summaryOut, total) ?? 0 : 0;
  const { children, truncated } = capChildren(all, fixed, opts, limit);

  return {
    summary: summaryOut,
    children,
    // v0.30 / E5: totalChildren = BFS-collected count (depth-aware). For
    // depth=1 this equals the eligible direct-children count (backward
    // compat). For depth>1 it is the cumulative count across levels.
    totalChildren: total,
    truncated,
  };
}

interface CappedChildren {
  children: DrillDownChild[];
  truncated: boolean;
}

/** Global cumulative token budget first, then the `limit` cap. */
function capChildren(
  all: DrillDownChild[],
  fixed: number,
  opts: DrillDownOpts,
  limit: number,
): CappedChildren {
  let children = all;
  let truncated = false;
  if (opts.budget !== undefined) {
    const out: DrillDownChild[] = [];
    let used = 0;
    const room = opts.budget - fixed;
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
