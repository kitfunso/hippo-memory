// Session context assembly under a token budget.

import { estimateTokens } from '../base/util/token-text.js';
import { READ_PAGE_ROWS, readAll } from '../base/util/pages.js';
import type { MemoryEntry } from '../base/memory/entry.js';
import {
  passesScopeFilterForRecall,
  assertScopeRequestAllowed,
  personalScopeOf,
} from '../base/scope/recall-scope.js';
import { projectNames } from '../base/scope/project-identity.js';
import { eligibleSummaryParents } from './summary-parents.js';
import type { CallerProject } from './prompt-hook.js';
import type { Context, ContextWith } from './types.js';
import type { EntryCursor } from '../base/ports/store/types.js';

export const DEFAULT_FRESH_TAIL_COUNT = 10;
const DEFAULT_ROW_CAP = 5000;

export const DEFAULT_ASSEMBLE_BUDGET = 4000;

export interface AssembleOptions {
  /** Token budget. Default DEFAULT_ASSEMBLE_BUDGET. */
  budget?: number;
  /** Recent raw rows always kept verbatim. Default 10. */
  freshTailCount?: number;
  /** Substitute parent summaries for older raws when ≥2 share a level-2 ancestor. Default true. */
  summarizeOlder?: boolean;
  /** Exact scope match when set, so an authorised caller can assemble a private session.
   * When undefined, default-deny applies to every `<source>:private:*` and `unknown:legacy` row. */
  scope?: string;
  /** Hard row cap on the SELECT that loads session raws (default 5000); `truncated` is set when
   * it is hit. */
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
  /** ISO timestamp of the source row's `created` field (or `earliest_at` for substituted
   * summaries). */
  createdAt: string;
  /** Fresh-tail protected window (last freshTailCount raws). */
  isFreshTail?: boolean;
  /** Level-2 summary substituted for older raw rows that share a parent. */
  isSummary?: boolean;
  /** When isSummary, the raw ids this summary covers. drillDown recovers the originals. */
  substitutedFor?: string[];
  /** Decay × retrieval × emotional. Lets callers render a confidence hint without re-deriving
   * from MemoryEntry. */
  strength: number;
}

export interface AssembleResult {
  sessionId: string;
  items: AssembledContextItem[];
  tokens: number;
  /** Tenant + scope-filtered raw row count, uncapped by `rowCap`, so "session has N msgs" stays
   * accurate for a windowed items[]. */
  totalRaw: number;
  summarized: number;
  evicted: number;
  /** True when `rowCap` truncated the window; the cap keeps the NEWEST rows, so older rows
   * beyond it are absent. */
  truncated: boolean;
}

/** Chronological context window for a session; over budget, evicts the lowest-strength non-fresh-tail item first (fresh
 *  tail is never evicted).
 *  Returns `items: []` for an empty sessionId, no raws, or when every row fails the scope/tenant filter. */
export async function assemble(
  ctx: ContextWith<'dagReads'>,
  sessionId: string,
  opts: AssembleOptions = {},
): Promise<AssembleResult> {
  assertScopeRequestAllowed(ctx.actor, opts.scope);
  const budget = opts.budget ?? DEFAULT_ASSEMBLE_BUDGET;
  const freshTailCount = opts.freshTailCount ?? DEFAULT_FRESH_TAIL_COUNT;
  const summarizeOlder = opts.summarizeOlder ?? true;
  const own = personalScopeOf(ctx.actor) ?? undefined;

  if (!sessionId) return emptyResult(sessionId, 0, false);

  const { scoped, totalRaw, truncated } = await loadScopedRaws(ctx, sessionId, opts, own);
  if (scoped.length === 0) return emptyResult(sessionId, totalRaw, truncated);

  // Split newest N into fresh tail; rest is older.
  const tailStartIdx = Math.max(0, scoped.length - freshTailCount);
  const olderRows = scoped.slice(0, tailStartIdx);
  const tailRows = scoped.slice(tailStartIdx);

  // Substitute parent summaries for older rows that share one.
  const { olderItems, summarized } =
    summarizeOlder && olderRows.length > 0
      ? await substituteSummaries(ctx, { olderRows, scope: opts.scope, own, project: opts.project })
      : { olderItems: olderRows.map(rawItem), summarized: 0 };

  const tailItems = tailRows.map(freshTailItem);

  // Byte compare is chronological for the fixed-form UTC ISO timestamps (invariant documented in
  // src/base/memory/entry.ts above MemoryEntry).
  const cmpIso = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  olderItems.sort((a, b) => cmpIso(a.createdAt, b.createdAt));
  tailItems.sort((a, b) => cmpIso(a.createdAt, b.createdAt));
  const itemCost = opts.cost?.item ?? ((it: AssembledContextItem) => estimateTokens(it.content));
  const room = budget - (opts.cost?.fixed(Math.max(budget, totalRaw)) ?? 0);
  const { items, tokens, evicted } = evictToBudget([...olderItems, ...tailItems], itemCost, room);

  return { sessionId, items, tokens, totalRaw, summarized, evicted, truncated };
}

function emptyResult(sessionId: string, totalRaw: number, truncated: boolean): AssembleResult {
  return { sessionId, items: [], tokens: 0, totalRaw, summarized: 0, evicted: 0, truncated };
}

/** The session's raw rows the caller may see, newest `rowCap` at most, with the uncapped count
 * of them. */
interface ScopedRaws {
  scoped: MemoryEntry[];
  totalRaw: number;
  truncated: boolean;
}

async function loadScopedRaws(
  ctx: ContextWith<'dagReads'>,
  sessionId: string,
  opts: AssembleOptions,
  own: string | undefined,
): Promise<ScopedRaws> {
  const rowCap = opts.rowCap ?? DEFAULT_ROW_CAP;
  const origins = opts.project ? projectNames(opts.project) : undefined;
  const dag = ctx.store.dagReads;
  const rows = await sessionRawRows(ctx, sessionId, rowCap, origins);
  const truncated = rows.length === rowCap;
  // `scoped.length` under-counts a capped session, so totalRaw falls back to a COUNT below.
  const scoped = rows.filter((r) => passesScopeFilterForRecall(r.scope ?? null, opts.scope, own));
  let totalRaw: number;
  if (truncated) {
    // The COUNT applies the same default-deny scope rule in SQL, so a no-scope caller cannot infer
    // private rows by comparing totalRaw to items.length.
    totalRaw = await dag.sessionRawCount({
      tenantId: ctx.tenantId,
      sessionId,
      scope: opts.scope,
      ownScope: own,
      origins,
    });
  } else {
    totalRaw = scoped.length;
  }
  return { scoped, totalRaw, truncated };
}

/** The session's live raw rows oldest first, only the newest `cap` when it is positive; none for
 * an empty id. */
async function sessionRawRows(
  ctx: Context,
  sessionId: string,
  cap: number,
  origins: readonly string[] | undefined,
): Promise<MemoryEntry[]> {
  if (!sessionId) return [];
  const raws = {
    tenantId: ctx.tenantId,
    kinds: ['raw'],
    live: true,
    sessionId,
    origins: origins === undefined ? undefined : ['', ...origins],
  } as const;
  const { store } = ctx;
  if (cap > 0) {
    return (await store.entriesWhere(raws, { limit: cap, newest: true })).entries.reverse();
  }
  return readAll((after?: EntryCursor) =>
    store.entriesWhere(raws, { limit: READ_PAGE_ROWS, after }),
  );
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

/** Older rows with every level-2 parent shared by two or more of them standing in for those
 * rows. */
interface SubstitutedOlder {
  olderItems: AssembledContextItem[];
  summarized: number;
}

interface SubstituteSummariesOptions {
  readonly olderRows: MemoryEntry[];
  readonly scope: string | undefined;
  readonly own: string | undefined;
  readonly project: CallerProject | undefined;
}

async function substituteSummaries(
  ctx: Context,
  { olderRows, scope, own, project }: SubstituteSummariesOptions,
): Promise<SubstitutedOlder> {
  const olderItems: AssembledContextItem[] = [];
  let summarized = 0;
  const olderByParent = groupByParent(olderRows);
  const eligibleParentIds = Array.from(olderByParent.keys()).filter(
    (pid) => (olderByParent.get(pid)?.length ?? 0) >= 2,
  );
  const parents =
    eligibleParentIds.length > 0
      ? eligibleSummaryParents(
          await ctx.store.entriesByIds(eligibleParentIds, ctx.tenantId),
          scope,
          own,
          project,
        )
      : [];
  const claimedRawIds = new Set<string>();
  for (const parent of parents) {
    const claimed = (olderByParent.get(parent.id) ?? []).map((r) => r.id);
    claimed.forEach((id) => claimedRawIds.add(id));
    olderItems.push(summaryItem(parent, claimed));
    summarized += claimed.length;
  }
  for (const r of olderRows) {
    if (claimedRawIds.has(r.id)) continue;
    olderItems.push(rawItem(r));
  }
  return { olderItems, summarized };
}

function groupByParent(rows: MemoryEntry[]): Map<string, MemoryEntry[]> {
  const byParent = new Map<string, MemoryEntry[]>();
  for (const r of rows) {
    if (!r.dagParentId) continue;
    const list = byParent.get(r.dagParentId) ?? [];
    list.push(r);
    byParent.set(r.dagParentId, list);
  }
  return byParent;
}

function summaryItem(parent: MemoryEntry, claimed: string[]): AssembledContextItem {
  return {
    id: parent.id,
    content: parent.content,
    createdAt: parent.earliestAt ?? parent.created,
    isSummary: true,
    substitutedFor: claimed,
    strength: parent.strength,
  };
}

/** Drops the weakest non-fresh-tail item until the total fits `room`; fresh-tail items are never
 * evicted. */
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
