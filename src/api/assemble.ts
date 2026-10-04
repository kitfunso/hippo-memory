// Session context assembly under a token budget.

import { loadEntriesByIds, loadSessionRawMemories, countSessionRawMemories } from '../store/entry-reads.js';
import { estimateTokens } from '../token-ledger.js';
import type { MemoryEntry } from '../memory.js';
import { passesScopeFilterForRecall, assertScopeRequestAllowed } from '../recall-scope.js';
import type { Context } from './types.js';

// ---------------------------------------------------------------------------
// assemble — Hippo DAG Phase 2 (bio-aware context engine)
// ---------------------------------------------------------------------------

export interface AssembleOpts {
  /** Token budget. Default 4000. */
  budget?: number;
  /** Recent raw rows always kept verbatim. Default 10. */
  freshTailCount?: number;
  /** Substitute parent summaries for older raws when ≥2 share a level-2
   *  ancestor. Default true. */
  summarizeOlder?: boolean;
  /**
   * Restrict to a specific scope. v1.6.1 senior-review P1 #3 parity with
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
   * Tenant + scope-filtered raw row count for the session — what the caller
   * could have seen given their grant. Pre-v1.6.1 was pre-filter (confusing
   * for all-private sessions); pre-v1.6.3 was capped (under-reported on
   * sessions > rowCap). v1.6.3 reports the FULL post-filter count via a
   * separate COUNT(*) query so consumers can render "session has N msgs"
   * accurately even when items[] is the windowed view.
   */
  totalRaw: number;
  summarized: number;
  evicted: number;
  /**
   * True when `rowCap` truncated the loaded window. With v1.6.2's NEWEST-cap
   * semantics, the items[] array represents the freshest tail of the session;
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
export function assemble(
  ctx: Context,
  sessionId: string,
  opts: AssembleOpts = {},
): AssembleResult {
  assertScopeRequestAllowed(ctx.actor, opts.scope);
  const budget = opts.budget ?? 4000;
  const freshTailCount = opts.freshTailCount ?? 10;
  const summarizeOlder = opts.summarizeOlder ?? true;
  const rowCap = opts.rowCap ?? 5000;

  if (!sessionId) {
    return { sessionId, items: [], tokens: 0, totalRaw: 0, summarized: 0, evicted: 0, truncated: false };
  }

  const rows = loadSessionRawMemories(ctx.hippoRoot, sessionId, ctx.tenantId, rowCap);
  const truncated = rows.length === rowCap;
  // v1.6.3 senior-review P0-1: report the FULL post-filter row count even
  // when the cap windows the loaded set. Pre-v1.6.3 used `scoped.length`
  // which under-reported on long sessions and made consumers render
  // wrong "session has N msgs" UX.
  const scoped = rows.filter((r) =>
    passesScopeFilterForRecall(r.scope ?? null, opts.scope),
  );
  let totalRaw: number;
  if (truncated) {
    // v1.6.3 codex P1 / senior P0: scope-aware unbounded COUNT. The helper
    // SQL-encodes the same default-deny rule passesScopeFilterForRecall
    // applies in TS, so a no-scope caller cannot infer private rows by
    // comparing totalRaw to items.length on a truncated session.
    totalRaw = countSessionRawMemories(ctx.hippoRoot, sessionId, ctx.tenantId, opts.scope);
  } else {
    totalRaw = scoped.length;
  }
  if (scoped.length === 0) {
    return { sessionId, items: [], tokens: 0, totalRaw, summarized: 0, evicted: 0, truncated };
  }

  // Split newest N into fresh tail; rest is older.
  const tailStartIdx = Math.max(0, scoped.length - freshTailCount);
  const olderRows = scoped.slice(0, tailStartIdx);
  const tailRows = scoped.slice(tailStartIdx);

  // Substitute parent summaries for older rows that share one.
  const { olderItems, summarized } = summarizeOlder && olderRows.length > 0
    ? substituteSummaries(ctx, olderRows, opts.scope)
    : { olderItems: olderRows.map(rawItem), summarized: 0 };

  const tailItems: AssembledContextItem[] = tailRows.map((r) => ({
    id: r.id,
    content: r.content,
    createdAt: r.created,
    isFreshTail: true,
    strength: r.strength,
  }));

  // F4 (v1.6.5): byte compare canonical UTC ISO timestamps. ~50× faster than
  // localeCompare and chronological by virtue of the timestamp invariant
  // documented in src/memory.ts above MemoryEntry.
  const cmpIso = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  olderItems.sort((a, b) => cmpIso(a.createdAt, b.createdAt));
  tailItems.sort((a, b) => cmpIso(a.createdAt, b.createdAt));
  const itemCost = opts.cost?.item ?? ((it: AssembledContextItem) => estimateTokens(it.content));
  const room = budget - (opts.cost?.fixed(Math.max(budget, totalRaw)) ?? 0);
  const { items, tokens, evicted } = evictToBudget([...olderItems, ...tailItems], itemCost, room);

  return { sessionId, items, tokens, totalRaw, summarized, evicted, truncated };
}

function rawItem(r: MemoryEntry): AssembledContextItem {
  return {
    id: r.id,
    content: r.content,
    createdAt: r.created,
    strength: r.strength,
  };
}

/** Older rows with every level-2 parent shared by two or more of them standing in for those rows. */
interface SubstitutedOlder {
  olderItems: AssembledContextItem[];
  summarized: number;
}

function substituteSummaries(
  ctx: Context,
  olderRows: MemoryEntry[],
  scope: string | undefined,
): SubstitutedOlder {
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
    ? loadEntriesByIds(ctx.hippoRoot, eligibleParentIds, ctx.tenantId)
        .filter((p) => (p.dag_level ?? 0) === 2 && !p.superseded_by)
        .filter((p) => passesScopeFilterForRecall(p.scope ?? null, scope))
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
