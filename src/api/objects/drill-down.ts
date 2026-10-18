// DAG drill-down from a summary to its children.

import type { SummaryDescendants } from '../../store/port.js';
import { estimateTokens } from '../../util/token-text.js';
import { DAG_LEVEL, type MemoryEntry } from '../../core/memory.js';
import { personalScopeOf } from '../../core/recall-scope.js';
import { descendantAdmits, type DescendantAdmission } from '../../core/read-admission.js';
import type { CallerProject } from '../prompt-hook.js';
import type { Context } from '../types.js';

const DEFAULT_DRILL_DOWN_LIMIT = 50;

export interface DrillDownOptions {
  /** Cap on number of children returned. Default 50. */
  limit?: number;
  /** Token budget: children append in created order until the next would exceed it (cost: printed line under `cost`,
   * else ceil(content.length / 4)). For depth > 1 the budget is global and cumulative, not per level. */
  budget?: number;
  /** Levels to walk down (default 1 = direct children); capped at 10 internally. BFS dedups with a visited Set,
   * defensive against shared-child anomalies. */
  depth?: number;
  cost?: DrillDownCost;
  project?: CallerProject;
}

export interface DrillDownSummary {
  id: string;
  content: string;
  descendantCount: number;
  earliestAt: string | null;
  latestAt: string | null;
}
export interface DrillDownChild {
  id: string;
  content: string;
  layer: string;
  dagLevel: number;
  created: string;
}

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

/** `not_found` covers missing, wrong-tenant AND scope-blocked, because distinguishing scope_blocked leaked private-row
 * existence to no-scope callers. `not_drillable`: the id is a leaf row (level 0/1), which the caller can act on. */
export interface DrillDownFailure {
  failure: 'not_found' | 'not_drillable';
}

export type DrillDownOutcome = DrillDownResult | DrillDownFailure;

/** One step down the DAG from a level-2+ summary to its direct children (the way back from `recall(...
 * summarizeOverflow: true)` substitutions). Only `ctx.tenantId` summaries are reachable; children get recall's scope
 * filter. Returns `DrillDownResult` or `{failure}`; HTTP maps `not_drillable` to 422. */
export async function drillDown(
  ctx: Context,
  summaryId: string,
  opts: DrillDownOptions = {},
): Promise<DrillDownOutcome> {
  const limit = opts.limit ?? DEFAULT_DRILL_DOWN_LIMIT;
  // v0.30 / E5: depth defaults 1 (backward compat); hard cap 10 levels
  // prevents pathological deep trees. CLI/HTTP/MCP reject invalid values.
  const depth = Math.max(1, Math.min(Math.trunc(opts.depth ?? 1), 10));
  const admit: DescendantAdmission = { ownScope: personalScopeOf(ctx.actor) ?? undefined, project: opts.project };
  const pastLimit = Math.floor(limit) + 1;
  const walked = await ctx.store.dagReads.summaryWithDescendants(ctx.tenantId, summaryId, {
    depth,
    admit,
    // A leaf answers not_drillable, so nothing under it is read.
    minSummaryLevel: DAG_LEVEL.topic,
    page: limit >= 0 && Number.isSafeInteger(pastLimit) ? { rows: pastLimit } : undefined,
  });
  // No unscoped cross-tenant probe: the tenant-scoped miss covers "missing" and "in another tenant" alike,
  // because telling them apart would leak existence to unauthorised tenants.
  if (!walked) return { failure: 'not_found' };
  // A distinguishable "scope_blocked" would tell a no-scope caller "this row
  // exists, just not for you", the existence leak the HTTP 404 collapse prevents.
  if (!descendantAdmits(walked.summary, admit)) return { failure: 'not_found' };
  if (!isDrillable(walked.summary)) return { failure: 'not_drillable' };
  return drillResult(walked, opts, limit);
}

function isDrillable(row: MemoryEntry): boolean {
  return (row.dag_level ?? 0) >= DAG_LEVEL.topic;
}

function drillResult(
  { summary, levels, sizes: counted }: SummaryDescendants,
  opts: DrillDownOptions,
  limit: number,
): DrillDownResult {
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
    // totalChildren is the BFS-collected count, cumulative across levels (equals the direct-children count at depth=1).
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
  opts: DrillDownOptions,
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
