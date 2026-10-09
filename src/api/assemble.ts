// Session context assembly under a token budget.

import { requireGroup, storeFor } from '../store-port.js';
import { estimateTokens } from '../util/token-text.js';
import type { MemoryEntry } from '../memory.js';
import { passesScopeFilterForRecall, assertScopeRequestAllowed, personalScopeOf } from '../recall-scope.js';
import { classifyOriginProject, projectNames } from '../project-identity.js';
import type { CallerProject } from '../prompt-hook.js';
import type { Context } from './types.js';

export const DEFAULT_ASSEMBLE_BUDGET = 4000;

// ---------------------------------------------------------------------------
// assemble — Hippo DAG Phase 2 (bio-aware context engine)
// ---------------------------------------------------------------------------

export interface AssembleOpts {
  /** Token budget. Default DEFAULT_ASSEMBLE_BUDGET. */
  budget?: number;
  /** Recent raw rows always kept verbatim. Default 10. */
  freshTailCount?: number;
  /** Substitute parent summaries for older raws when ≥2 share a level-2
   *  ancestor. Default true. */
  summarizeOlder?: boolean;
  /**
   * Restrict to a specific scope, same rule as
   * `recall`: when set, exact match required (so an authorised caller can
   * assemble a `slack:private:CSEC` session by passing scope explicitly).
   * When undefined, default-deny applies to ANY `<source>:private:*` and
   * `unknown:legacy` rows.
   */
  scope?: string;
  /**
   * Hard row cap on the SELECT that loads session raws. Default 5000 to
   * protect against degenerate sessions. When the cap is hit, `truncated`
   * is set on the result so the caller knows to widen.
   */
  rowCap?: number;
  cost?: AssembleCost;
  project?: CallerProject;
}

// Absent, the budget pays for content alone. `fixed` gets the largest count the header can print.
export interface AssembleCost {
  item: (it: AssembledContextItem) => number;
  fixed: (widest: number) => number;
}

export interface AssembledContextItem {
  id: string;
  content: string;
  /** ISO timestamp of the source row's `created` field (or `earliest_at`
   *  for substituted summaries). */
  createdAt: string;
  /** Fresh-tail protected window (last freshTailCount raws). */
  isFreshTail?: boolean;
  /** Level-2 summary substituted for older raw rows that share a parent. */
  isSummary?: boolean;
  /** When isSummary, the raw ids this summary covers. drillDown
   *  recovers the originals. */
  substitutedFor?: string[];
  /** Decay × retrieval × emotional. Lets callers render a confidence
   *  hint without re-deriving from MemoryEntry. */
  strength: number;
}

export interface AssembleResult {
  sessionId: string;
  items: AssembledContextItem[];
  tokens: number;
  /**
   * Tenant + scope-filtered raw row count for the session, uncapped by `rowCap`, so
   * "session has N msgs" stays accurate when items[] is the windowed view.
   */
  totalRaw: number;
  summarized: number;
  evicted: number;
  /**
   * True when `rowCap` truncated the loaded window. The cap keeps the NEWEST
   * rows, so the items[] array represents the freshest tail of the session;
   * older rows beyond the cap are silently absent. Use `totalRaw - items.length
   * - summarized + ...` to estimate how much you didn't see, or widen `rowCap`.
   */
  truncated: boolean;
}

/**
 * Build a chronologically-ordered context window for a session. Adapts the
 * lossless-claw context-engine pattern to Hippo's score-ranked memory store.
 *
 * Algorithm:
 *   1. Load all kind='raw' rows for the session, tenant + scope filtered.
 *   2. Split: newest `freshTailCount` are protected (fresh tail).
 *   3. For older rows, when ≥2 share a level-2 parent, substitute the
 *      summary; everything else passes through as raw.
 *   4. Hippo-additive eviction: when over-budget, drop the lowest-strength
 *      non-fresh-tail item first. Fresh-tail rows are never evicted.
 *
 * Strength-weighted eviction is the differentiator from lossless-claw,
 * which evicts oldest-first. A high-strength older row (high retrieval
 * count, slow decay) survives; a low-strength recent row (newer but
 * unimportant) goes first.
 *
 * Returns `items: []` cleanly when:
 *   - sessionId is empty
 *   - no raws exist for the session
 *   - all rows fail the scope/tenant filter
 */
export async function assemble(
  ctx: Context,
  sessionId: string,
  opts: AssembleOpts = {},
): Promise<AssembleResult> {
  assertScopeRequestAllowed(ctx.actor, opts.scope);
  const budget = opts.budget ?? DEFAULT_ASSEMBLE_BUDGET;
  const freshTailCount = opts.freshTailCount ?? 10;
  const summarizeOlder = opts.summarizeOlder ?? true;
  const own = personalScopeOf(ctx.actor) ?? undefined;

  if (!sessionId) {
    return { sessionId, items: [], tokens: 0, totalRaw: 0, summarized: 0, evicted: 0, truncated: false };
  }

  const { scoped, totalRaw, truncated } = await loadScopedRaws(ctx, sessionId, opts, own);
  if (scoped.length === 0) {
    return { sessionId, items: [], tokens: 0, totalRaw, summarized: 0, evicted: 0, truncated };
  }

  // Split newest N into fresh tail; rest is older.
  const tailStartIdx = Math.max(0, scoped.length - freshTailCount);
  const olderRows = scoped.slice(0, tailStartIdx);
  const tailRows = scoped.slice(tailStartIdx);

  // Substitute parent summaries for older rows that share one.
  const { olderItems, summarized } = summarizeOlder && olderRows.length > 0
    ? await substituteSummaries(ctx, olderRows, opts.scope, own, opts.project)
    : { olderItems: olderRows.map(rawItem), summarized: 0 };

  const tailItems = tailRows.map(freshTailItem);

  // Byte compare is chronological for the fixed-form UTC ISO timestamps
  // (invariant documented in src/memory.ts above MemoryEntry).
  const cmpIso = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  olderItems.sort((a, b) => cmpIso(a.createdAt, b.createdAt));
  tailItems.sort((a, b) => cmpIso(a.createdAt, b.createdAt));
  const itemCost = opts.cost?.item ?? ((it: AssembledContextItem) => estimateTokens(it.content));
  const room = budget - (opts.cost?.fixed(Math.max(budget, totalRaw)) ?? 0);
  const { items, tokens, evicted } = evictToBudget([...olderItems, ...tailItems], itemCost, room);

  return { sessionId, items, tokens, totalRaw, summarized, evicted, truncated };
}

/** The session's raw rows the caller may see, newest `rowCap` at most, with the uncapped count of them. */
interface ScopedRaws {
  scoped: MemoryEntry[];
  totalRaw: number;
  truncated: boolean;
}

async function loadScopedRaws(ctx: Context, sessionId: string, opts: AssembleOpts, own: string | undefined): Promise<ScopedRaws> {
  const rowCap = opts.rowCap ?? 5000;
  const origins = opts.project ? projectNames(opts.project) : undefined;
  const dag = requireGroup(storeFor(ctx), 'dagReads');
  const rows = await dag.sessionRawEntries({ tenantId: ctx.tenantId, sessionId, cap: rowCap, origins });
  const truncated = rows.length === rowCap;
  // `scoped.length` under-counts a capped session, so totalRaw falls back to a COUNT below.
  const scoped = rows.filter((r) =>
    passesScopeFilterForRecall(r.scope ?? null, opts.scope, own),
  );
  let totalRaw: number;
  if (truncated) {
    // The COUNT applies the same default-deny scope rule in SQL, so a no-scope
    // caller cannot infer private rows by comparing totalRaw to items.length.
    totalRaw = await dag.sessionRawCount({ tenantId: ctx.tenantId, sessionId, scope: opts.scope, ownScope: own, origins });
  } else {
    totalRaw = scoped.length;
  }
  return { scoped, totalRaw, truncated };
}

function rawItem(r: MemoryEntry): AssembledContextItem {
  return {
    id: r.id,
    content: r.content,
    createdAt: r.created,
    strength: r.strength,
  };
}

function freshTailItem(r: MemoryEntry): AssembledContextItem {
  return {
    id: r.id,
    content: r.content,
    createdAt: r.created,
    isFreshTail: true,
    strength: r.strength,
  };
}

/** Older rows with every level-2 parent shared by two or more of them standing in for those rows. */
interface SubstitutedOlder {
  olderItems: AssembledContextItem[];
  summarized: number;
}

async function substituteSummaries(
  ctx: Context,
  olderRows: MemoryEntry[],
  scope: string | undefined,
  own: string | undefined,
  project: CallerProject | undefined,
): Promise<SubstitutedOlder> {
  const olderItems: AssembledContextItem[] = [];
  let summarized = 0;
  const olderByParent = new Map<string, MemoryEntry[]>();
  for (const r of olderRows) {
    if (!r.dag_parent_id) continue;
    const list = olderByParent.get(r.dag_parent_id) ?? [];
    list.push(r);
    olderByParent.set(r.dag_parent_id, list);
  }
  const eligibleParentIds = Array.from(olderByParent.keys()).filter(
    (pid) => (olderByParent.get(pid)?.length ?? 0) >= 2,
  );
  const parents = eligibleParentIds.length > 0
    ? (await storeFor(ctx).entriesByIds(eligibleParentIds, ctx.tenantId))
        .filter((p) => (p.dag_level ?? 0) === 2 && !p.superseded_by)
        .filter((p) => passesScopeFilterForRecall(p.scope ?? null, scope, own))
        .filter((p) => !project || classifyOriginProject(p.origin_project, project) !== 'cross-project')
    : [];
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
  for (const r of olderRows) {
    if (claimedRawIds.has(r.id)) continue;
    olderItems.push(rawItem(r));
  }
  return { olderItems, summarized };
}

/** Drops the weakest non-fresh-tail item until the total fits `room`; fresh-tail items are never evicted. */
interface BudgetFit {
  items: AssembledContextItem[];
  tokens: number;
  evicted: number;
}

function evictToBudget(
  start: AssembledContextItem[],
  itemCost: (it: AssembledContextItem) => number,
  room: number,
): BudgetFit {
  let items = start;
  let tokens = items.reduce((acc, it) => acc + itemCost(it), 0);
  let evicted = 0;
  while (tokens > room && items.length > 0) {
    let worstIdx = -1;
    let worstStrength = Infinity;
    for (let i = 0; i < items.length; i++) {
      if (items[i].isFreshTail) continue;
      if (items[i].strength < worstStrength) {
        worstStrength = items[i].strength;
        worstIdx = i;
      }
    }
    if (worstIdx === -1) break;
    const cost = itemCost(items[worstIdx]);
    items = items.filter((_, i) => i !== worstIdx);
    tokens -= cost;
    evicted++;
  }
  return { items, tokens, evicted };
}
