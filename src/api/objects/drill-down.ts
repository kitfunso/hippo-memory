import type { SummaryDescendants } from '../../base/ports/store.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { leadInField, shownText } from '../../base/memory/lead-in.js';
import { DAG_LEVEL, type MemoryEntry } from '../../base/memory/entry.js';
import { personalScopeOf } from '../../base/scope/recall-scope.js';
import { descendantAdmits, type DescendantAdmission } from '../../base/scope/read-admission.js';
import type { CallerProject } from '../prompt-hook.js';
import type { ContextWith } from '../types.js';

export const DEFAULT_DRILL_DOWN_LIMIT = 50;
export const MAX_DRILL_DOWN_DEPTH = 10;

export interface DrillDownOptions {
  limit?: number;
  /** Token budget: children append in created order until the next would exceed it (cost:
   * printed line under `cost`, else ceil(content.length / 4)). For depth > 1 the budget is
   * global and cumulative, not per level. */
  budget?: number;
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
  leadIn?: string;
  layer: string;
  dagLevel: number;
  created: string;
}

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

/** `not_found` covers missing, wrong-tenant AND scope-blocked, because distinguishing
 * scope_blocked leaked private-row existence to no-scope callers. `not_drillable`: the id is a
 * leaf row (level 0/1), which the caller can act on. */
export interface DrillDownFailure {
  failure: 'not_found' | 'not_drillable';
}

export type DrillDownOutcome = DrillDownResult | DrillDownFailure;

/** One step down the DAG from a level-2+ summary to its direct children (the way back from
 * `recall(... summarizeOverflow: true)` substitutions). Only `ctx.tenantId` summaries are
 * reachable; children get recall's scope filter. Returns `DrillDownResult` or `{failure}`; HTTP
 * maps `not_drillable` to 422. */
export async function drillDown(
  ctx: ContextWith<'dagReads'>,
  summaryId: string,
  opts: DrillDownOptions = {},
): Promise<DrillDownOutcome> {
  const limit = opts.limit ?? DEFAULT_DRILL_DOWN_LIMIT;
  const depth = Math.max(1, Math.min(Math.trunc(opts.depth ?? 1), MAX_DRILL_DOWN_DEPTH));
  const admit: DescendantAdmission = {
    ownScope: personalScopeOf(ctx.actor) ?? undefined,
    grants: ctx.actor.scopes,
    project: opts.project,
  };
  const pastLimit = Math.floor(limit) + 1;
  const walked = await ctx.store.dagReads.summaryWithDescendants(ctx.tenantId, summaryId, {
    depth,
    admit,
    minSummaryLevel: DAG_LEVEL.topic,
    page: limit >= 0 && Number.isSafeInteger(pastLimit) ? { rows: pastLimit } : undefined,
  });
  if (!walked) return { failure: 'not_found' };
  if (!descendantAdmits(walked.summary, admit)) return { failure: 'not_found' };
  if (!isDrillable(walked.summary)) return { failure: 'not_drillable' };
  return drillResult(walked, opts, limit);
}

function isDrillable(row: MemoryEntry): boolean {
  return (row.dagLevel ?? 0) >= DAG_LEVEL.topic;
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
    descendantCount: summary.descendantCount ?? sizes[0] ?? 0,
    earliestAt: summary.earliestAt ?? null,
    latestAt: summary.latestAt ?? null,
  };
  const all: DrillDownChild[] = collected.map((c) => ({
    id: c.id,
    content: c.content,
    ...leadInField(c),
    layer: c.layer,
    dagLevel: c.dagLevel ?? 0,
    created: c.created,
  }));

  const fixed = opts.budget !== undefined ? (opts.cost?.fixed(summaryOut, total) ?? 0) : 0;
  const { children, truncated } = capChildren(all, fixed, opts, limit);

  return {
    summary: summaryOut,
    children,
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
      const t = opts.cost ? opts.cost.child(c) : estimateTokens(shownText(c));
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
