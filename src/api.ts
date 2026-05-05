/**
 * Domain API layer for Hippo.
 *
 * Pure functions taking a Context (hippoRoot + tenantId + actor) plus
 * operation options. Both the CLI (direct mode) and the HTTP server
 * (`hippo serve`, A1) call into this module so the business logic lives
 * in exactly one place.
 */

import { createHash } from 'node:crypto';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';
import {
  writeEntry,
  writeEntryDbOnly,
  writeEntryMirrors,
  readEntry,
  deleteEntry,
  loadSearchEntries,
  loadEntriesByIds,
  loadChildrenOf,
  loadFreshRawMemories,
  loadSessionRawMemories,
  countSessionRawMemories,
  removeEntryMirrors,
  loadActiveTaskSnapshot,
  loadLatestHandoff,
  listSessionEvents,
  type TaskSnapshot,
  type SessionEvent,
} from './store.js';
import type { SessionHandoff } from './handoff.js';
import {
  createMemory,
  applyOutcome,
  type MemoryKind,
  type MemoryEntry,
  Layer,
} from './memory.js';
import {
  appendAuditEvent,
  queryAuditEvents,
  type AuditEvent,
  type AuditOp,
} from './audit.js';
import { promoteToGlobal, getGlobalRoot } from './shared.js';
import { archiveRawMemory } from './raw-archive.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyListItem,
} from './auth.js';

export interface Context {
  hippoRoot: string;
  tenantId: string;
  /** 'cli' | 'localhost:cli' | 'api_key:<key_id>' | 'mcp' */
  actor: string;
}

/**
 * v1.2.1: source-agnostic private-scope detector. A scope string is treated
 * as private when it has the shape `<lowercase-source>:private:<rest>`.
 *
 * Examples that match:
 *   slack:private:Cabc, github:private:owner/repo, jira:private:PROJ-1
 * Examples that DO NOT match:
 *   slack:public:Cgeneral, acme:public:my-private-channel, null, '',
 *   'unknown:legacy', 'private' (alone), 'private:foo' (no source prefix).
 *
 * Used by api.recall, mcp/server.ts (hippo_recall + hippo_context),
 * cli.ts (cmdRecall continuity). Keep these in sync — the export is the
 * single source of truth so v1.3 GitHub work cannot drift.
 */
const PRIVATE_SCOPE_RE = /^[a-z][a-z0-9_-]*:private:/;
/**
 * Recall-side scope filter. Mirrors the inline rule in `recall` continuity
 * filtering and the row filter at api.ts:198-205. Lifted to a helper so
 * the v1.5.0 DAG substitution path can reuse it without duplicating logic.
 *
 * - When `requested` is set and non-empty: exact match required.
 * - When `requested` is undefined/empty: default-deny on any
 *   `<source>:private:*` scope and on the `unknown:legacy` quarantine bucket.
 *   `null` and public scopes pass.
 */
function passesScopeFilterForRecall(
  scope: string | null,
  requested: string | undefined,
): boolean {
  if (requested !== undefined && requested !== '') {
    return scope === requested;
  }
  if (scope === null) return true;
  if (isPrivateScope(scope)) return false;
  if (scope === 'unknown:legacy') return false;
  return true;
}

export function isPrivateScope(scope: string | null | undefined): boolean {
  return typeof scope === 'string' && PRIVATE_SCOPE_RE.test(scope);
}

export interface RememberOpts {
  content: string;
  kind?: MemoryKind;
  scope?: string;
  owner?: string;
  artifactRef?: string;
  tags?: string[];
  /**
   * Optional hook invoked inside the same transaction as the underlying
   * memories INSERT. Used by ingestion connectors (E1.3+) to stamp
   * idempotency / cursor rows atomically with the memory row, so a crash
   * mid-write cannot produce a memory without its corresponding side-effect
   * log row (or vice versa). If the callback throws, the INSERT is rolled
   * back and the error is rethrown.
   */
  afterWrite?: (db: DatabaseSyncLike, memoryId: string) => void;
}

export interface RememberResult {
  id: string;
  kind: MemoryKind;
  tenantId: string;
}

export function remember(ctx: Context, opts: RememberOpts): RememberResult {
  const entry = createMemory(opts.content, {
    kind: opts.kind ?? 'distilled',
    scope: opts.scope ?? null,
    owner: opts.owner ?? null,
    artifact_ref: opts.artifactRef ?? null,
    tags: opts.tags,
    tenantId: ctx.tenantId,
  });
  // writeEntry threads ctx.actor into its internal audit hook, so exactly
  // one 'remember' event lands in the log with the supplied actor.
  writeEntry(ctx.hippoRoot, entry, { actor: ctx.actor, afterWrite: opts.afterWrite });

  return { id: entry.id, kind: entry.kind, tenantId: ctx.tenantId };
}

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

export interface RecallOpts {
  query: string;
  limit?: number;
  mode?: 'bm25' | 'hybrid' | 'physics';
  /**
   * Restrict results to memories whose `scope` equals this value exactly.
   *
   * When `scope` is undefined or empty, recall applies a DEFAULT-DENY rule:
   * any memory whose scope starts with `'slack:private:'` is filtered out so
   * a frontend caller passing `undefined` cannot accidentally surface
   * private-channel content. Memories with scope=null (the common case for
   * non-Slack content) are still returned.
   */
  scope?: string;
  /**
   * v1.5.0 DAG-aware recall. When true (default), entries that overflow the
   * `limit` and share a level-2 parent summary cause that summary to be
   * appended in their place, capped at ceil(limit * 0.3) extra rows. Set to
   * false to disable and get the pre-v1.5 strict-limit behaviour.
   */
  summarizeOverflow?: boolean;
  /**
   * v1.5.2 fresh-tail. When > 0, prepend the last N kind='raw' rows
   * (tenant + scope filtered, dedup against the BM25 hits) so an agent's
   * "what did I just see" recall path always covers the recent window
   * even when the query terms don't match. Capped at 200. Default 0 = off.
   */
  freshTailCount?: number;
  /**
   * v1.6.2 fresh-tail session scope. When set, restricts the fresh-tail
   * window to a specific session. Without it, fresh-tail is tenant-wide,
   * which surfaces newest rows across ALL sessions — useful for "anything
   * new in this tenant", but wrong for "what did I just see in this one
   * conversation". Set to ctx-supplied session id for the correct shape.
   */
  freshTailSessionId?: string;
  /**
   * When true, include a continuity block (active task snapshot, latest matching
   * session handoff, recent session events) on the result. Default false to keep
   * the hot path cheap; agent boot paths should set this to true.
   *
   * All three lookups are tenant-scoped to ctx.tenantId via the v0.40+ store
   * helpers. No risk of cross-tenant leak.
   *
   * Note: when no active snapshot exists, sessionHandoff is null and
   * recentSessionEvents is []. We deliberately do NOT fall back to the latest
   * tenant handoff without a session anchor, to avoid resurrecting stale state
   * after a session ends. The explicit handoff-without-snapshot path remains
   * `hippo session resume`.
   */
  includeContinuity?: boolean;
}

export interface ContinuityBlock {
  activeSnapshot: TaskSnapshot | null;
  sessionHandoff: SessionHandoff | null;
  recentSessionEvents: SessionEvent[];
}

export interface RecallResultItem {
  id: string;
  content: string;
  score: number;
  layer: string;
  strength: number;
  /**
   * v1.5.0 DAG-aware recall (docs/plans/2026-05-05-dag-recall.md Task 2).
   * True when this row is a level-2 topic summary substituted in for
   * overflowed children that didn't fit the limit.
   */
  isSummary?: boolean;
  /**
   * IDs of the overflow leaves this summary covers. Caller can drill
   * into these via `drillDown` (Task 3) to recover the original detail.
   */
  substitutedFor?: string[];
  /** Cached descendant count from schema v25; non-zero for level-2+ rows. */
  descendantCount?: number;
  /**
   * v1.5.2 fresh-tail (docs/plans/2026-05-05-dag-recall.md Task 4). True
   * for rows surfaced via the most-recent-N kind='raw' window, NOT by the
   * BM25 query match. Caller can render them in a separate "recent" band.
   */
  isFreshTail?: boolean;
}

export interface RecallResult {
  results: RecallResultItem[];
  total: number;
  tokens: number;
  continuity?: ContinuityBlock;
  /**
   * Tokens consumed by the continuity block: snapshot (task + summary + next_step)
   * + handoff (summary + nextAction + artifacts) + every event's full content
   * across the last 5 events. Each measured by Math.ceil(len/4), matching
   * the existing `tokens` count and src/search.ts estimateTokens().
   * Undefined when continuity not requested. Callers needing a tighter budget
   * should truncate event.content themselves before display.
   */
  continuityTokens?: number;
}

/**
 * Domain-level recall. Loads BM25-ranked candidates from SQLite scoped to
 * `ctx.tenantId`. The `mode` flag is accepted for forward compatibility (the
 * CLI exposes hybrid/physics paths) but Task 2 wires only the BM25 candidate
 * loader; later tasks can extend this to call the physics/hybrid scorer.
 */
export function recall(ctx: Context, opts: RecallOpts): RecallResult {
  const limit = opts.limit ?? 10;
  const all = loadSearchEntries(
    ctx.hippoRoot,
    opts.query,
    undefined,
    ctx.tenantId,
  );
  // Scope filtering runs AFTER the tenant filter inside loadSearchEntries, so
  // a tenant-mismatched scope cannot surface another tenant's row even when
  // both share the same scope string (e.g. 'slack:private:CSHARED').
  let entries: typeof all;
  if (opts.scope !== undefined && opts.scope !== '') {
    entries = all.filter((e) => e.scope === opts.scope);
  } else {
    // v1.2.1: generalize default-deny from `slack:private:*` to ANY
    // `<source>:private:*` scope so adding a connector cannot silently
    // surface private rows to no-scope callers. Frontend callers will pass
    // `undefined` and must not see private rows from any source by default.
    entries = all.filter((e) => !isPrivateScope(e.scope ?? null));
  }
  // BM25 ordering already comes from loadSearchEntries; cap to `limit`.
  // Score is a placeholder — the physics/hybrid scorers in src/search.ts
  // produce richer breakdowns and will replace this when wired up.
  const baseSlice = entries.slice(0, limit);

  // v1.5.0 DAG-aware substitution (Phase 1, Task 2). When entries overflow the
  // limit and ≥2 of them share a level-2 parent summary, append the parent
  // summary so the user sees a compact pointer to the dropped detail. Capped
  // at ceil(limit * 0.3) substitutions so a runaway DAG can't expand results.
  // Each substituted summary is tenant-scoped via loadEntriesByIds and
  // re-checked against the active scope filter (default-deny on private).
  // Drill-down (Task 3) reverses substitution: caller passes substitutedFor[]
  // ids back through `drillDown` to recover the children.
  const summarizeOverflow = opts.summarizeOverflow ?? true;
  type SummaryDecoration = { entry: typeof baseSlice[number]; childIds: string[] };
  let substituted: SummaryDecoration[] = [];
  if (summarizeOverflow && entries.length > limit) {
    const overflow = entries.slice(limit);
    const baseIds = new Set(baseSlice.map((e) => e.id));
    const overflowByParent = new Map<string, typeof overflow>();
    for (const e of overflow) {
      const parentId = e.dag_parent_id;
      if (!parentId) continue;
      if ((e.dag_level ?? 0) > 1) continue;
      const list = overflowByParent.get(parentId) ?? [];
      list.push(e);
      overflowByParent.set(parentId, list);
    }
    const eligibleParentIds = Array.from(overflowByParent.keys()).filter(
      (pid) => (overflowByParent.get(pid)?.length ?? 0) >= 2 && !baseIds.has(pid),
    );
    if (eligibleParentIds.length > 0) {
      const parents = loadEntriesByIds(ctx.hippoRoot, eligibleParentIds, ctx.tenantId);
      const eligibleParents = parents.filter(
        (p) => (p.dag_level ?? 0) === 2 && passesScopeFilterForRecall(p.scope ?? null, opts.scope),
      );
      const maxSub = Math.max(1, Math.ceil(limit * 0.3));
      // Order parents by overflow count descending so the most
      // information-dense substitutions come first.
      eligibleParents.sort((a, b) => {
        const ac = overflowByParent.get(a.id)?.length ?? 0;
        const bc = overflowByParent.get(b.id)?.length ?? 0;
        return bc - ac;
      });
      substituted = eligibleParents.slice(0, maxSub).map((p) => ({
        entry: p,
        childIds: (overflowByParent.get(p.id) ?? []).map((e) => e.id),
      }));
    }
  }

  const baseRanked: RecallResultItem[] = baseSlice.map((entry, idx) => ({
    id: entry.id,
    content: entry.content,
    score: Math.max(0, 1 - idx / Math.max(1, limit)),
    layer: entry.layer,
    strength: entry.strength,
  }));
  // Substituted summaries land at the end with score = 0.5 (mid-rank), so
  // they don't outrank top-N strong matches but stay above lowest-rank
  // leaves on the consumer side. Caller sorts/filters as it sees fit.
  const summaryRanked: RecallResultItem[] = substituted.map((s) => ({
    id: s.entry.id,
    content: s.entry.content,
    score: 0.5,
    layer: s.entry.layer,
    strength: s.entry.strength,
    isSummary: true,
    substitutedFor: s.childIds,
    descendantCount: s.entry.descendant_count ?? s.childIds.length,
  }));
  // v1.5.2 fresh-tail. Surface the last N kind='raw' rows so an agent's
  // "what did I just see" recall path always covers the recent window even
  // when the query terms don't match. Tenant + scope filtered.
  //
  // Dual-membership semantics: `loadSearchEntries` returns all tenant-scoped
  // rows scored by BM25 (even rows with no token overlap can surface at
  // score≈0), so a row in the recent window often ALSO appears as a BM25
  // hit. We don't duplicate. Instead:
  //   1. Mark any baseRanked entry that's in the recent set with isFreshTail.
  //   2. Prepend genuinely-new recent rows (not in BM25 hits or summaries).
  // Net: every recent row carries `isFreshTail=true`, exactly once.
  const freshTailCount = opts.freshTailCount ?? 0;
  const freshRanked: RecallResultItem[] = [];
  if (freshTailCount > 0) {
    const recent = loadFreshRawMemories(
      ctx.hippoRoot,
      freshTailCount,
      ctx.tenantId,
      opts.freshTailSessionId,
    );
    const recentScoped = recent.filter((m) =>
      passesScopeFilterForRecall(m.scope ?? null, opts.scope),
    );
    const recentIdSet = new Set(recentScoped.map((m) => m.id));
    for (const r of baseRanked) {
      if (recentIdSet.has(r.id)) r.isFreshTail = true;
    }
    const seenIds = new Set([
      ...baseRanked.map((r) => r.id),
      ...summaryRanked.map((r) => r.id),
    ]);
    for (const m of recentScoped) {
      if (seenIds.has(m.id)) continue;
      freshRanked.push({
        id: m.id,
        content: m.content,
        score: 1.0,
        layer: m.layer,
        strength: m.strength,
        isFreshTail: true,
      });
      seenIds.add(m.id);
    }
  }

  const ranked = [...freshRanked, ...baseRanked, ...summaryRanked];
  const tokens = ranked.reduce((acc, r) => acc + Math.ceil(r.content.length / 4), 0);

  // TODO(a1-task-4): emit via the shared audit hook in store.ts so we don't
  // double-emit. Recall does not currently write through writeEntry, so no
  // duplicate exists today, but we keep the same shape for symmetry.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    // GDPR Path A: store a sha256 hash (16 hex chars) of the query text
    // instead of the truncated query itself. If a caller queries with content
    // that matches an archived (RTBF) memory, the original text must not
    // persist in audit_log. query_length is preserved for debugging
    // long-prompt patterns and compliance metrics.
    appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      op: 'recall',
      metadata: {
        query_hash: createHash('sha256').update(opts.query).digest('hex').slice(0, 16),
        query_length: opts.query.length,
        results: ranked.length,
      },
    });
  } finally {
    closeHippoDb(db);
  }

  let continuity: ContinuityBlock | undefined;
  let continuityTokens: number | undefined;
  if (opts.includeContinuity) {
    const snapshot = loadActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId);
    // No active snapshot = no anchor = no handoff/events. Avoids resurrecting
    // a stale handoff from a deleted/completed session.
    const sessionId = snapshot?.session_id ?? undefined;
    const sessionHandoff = sessionId
      ? loadLatestHandoff(ctx.hippoRoot, ctx.tenantId, sessionId)
      : null;
    const recentSessionEvents = sessionId
      ? listSessionEvents(ctx.hippoRoot, ctx.tenantId, { session_id: sessionId, limit: 5 })
      : [];
    // Scope filtering on continuity. Mirrors the memory-recall path:
    //   - opts.scope set: EXACT match required (no cross-scope leakage)
    //   - opts.scope unset: default-deny on ANY `<source>:private:*` AND on
    //     legacy 'unknown:legacy' rows quarantined by the v23 migration.
    //     Public and null scopes pass through.
    // v1.1.0 wrongly wrote this as `opts.scope || isPublic`, which allowed
    // ANY explicit scope to see ALL continuity rows. v1.2 closed the latent
    // leak. v1.2.1 generalizes the private check from slack-only to any
    // source so v1.3 GitHub (and future Jira/Linear/etc.) cannot leak.
    const rowScope = (
      r: { scope?: string | null } | null | undefined,
    ): string | null => r?.scope ?? null;
    // v1.2: TaskSnapshot / SessionHandoff / SessionEvent now carry scope; the
    // wrapper just normalizes null vs undefined.
    const passesScopeFilter = (s: string | null): boolean => {
      if (opts.scope !== undefined && opts.scope !== '') {
        return s === opts.scope;
      }
      if (s === null) return true;
      if (isPrivateScope(s)) return false;
      if (s === 'unknown:legacy') return false;
      return true;
    };
    const filteredSnapshot =
      snapshot && passesScopeFilter(rowScope(snapshot)) ? snapshot : null;
    const filteredHandoff =
      sessionHandoff && passesScopeFilter(rowScope(sessionHandoff)) ? sessionHandoff : null;
    const filteredEvents = recentSessionEvents.filter((e) => passesScopeFilter(rowScope(e)));
    continuity = {
      activeSnapshot: filteredSnapshot,
      sessionHandoff: filteredHandoff,
      recentSessionEvents: filteredEvents,
    };
    const tokenize = (s?: string | null): number =>
      s ? Math.ceil(s.length / 4) : 0;
    continuityTokens =
      tokenize(filteredSnapshot?.task) +
      tokenize(filteredSnapshot?.summary) +
      tokenize(filteredSnapshot?.next_step) +
      tokenize(filteredHandoff?.summary) +
      tokenize(filteredHandoff?.nextAction) +
      (filteredHandoff?.artifacts ?? []).reduce((acc, a) => acc + tokenize(a), 0) +
      filteredEvents.reduce((acc, e) => acc + tokenize(e.content), 0);
  }

  return { results: ranked, total: entries.length, tokens, continuity, continuityTokens };
}

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
  const olderItems: AssembledContextItem[] = [];
  let summarized = 0;
  if (summarizeOlder && olderRows.length > 0) {
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
          .filter((p) => (p.dag_level ?? 0) === 2)
          .filter((p) => passesScopeFilterForRecall(p.scope ?? null, opts.scope))
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
      olderItems.push({
        id: r.id,
        content: r.content,
        createdAt: r.created,
        strength: r.strength,
      });
    }
  } else {
    for (const r of olderRows) {
      olderItems.push({
        id: r.id,
        content: r.content,
        createdAt: r.created,
        strength: r.strength,
      });
    }
  }

  const tailItems: AssembledContextItem[] = tailRows.map((r) => ({
    id: r.id,
    content: r.content,
    createdAt: r.created,
    isFreshTail: true,
    strength: r.strength,
  }));

  olderItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  tailItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let items: AssembledContextItem[] = [...olderItems, ...tailItems];

  let tokens = items.reduce((acc, it) => acc + Math.ceil(it.content.length / 4), 0);
  let evicted = 0;
  while (tokens > budget && items.length > 0) {
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
    const cost = Math.ceil(items[worstIdx].content.length / 4);
    items = items.filter((_, i) => i !== worstIdx);
    tokens -= cost;
    evicted++;
  }

  return { sessionId, items, tokens, totalRaw, summarized, evicted, truncated };
}

// ---------------------------------------------------------------------------
// drillDown — DAG-aware recall Phase 1 Task 3
// ---------------------------------------------------------------------------

export interface DrillDownOpts {
  /** Cap on number of children returned. Default 50. */
  limit?: number;
  /**
   * Optional token budget. When set, children are appended in chronological
   * order (created ASC) until adding the next child would exceed the budget.
   * Token cost = ceil(content.length / 4) per child.
   */
  budget?: number;
}

export interface DrillDownResult {
  summary: { id: string; content: string; descendantCount: number; earliestAt: string | null; latestAt: string | null };
  children: Array<{ id: string; content: string; layer: string; dagLevel: number; created: string }>;
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
  const summary = readEntry(ctx.hippoRoot, summaryId, ctx.tenantId);
  // No unscoped cross-tenant probe here — readEntry's null return covers
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

  const allChildren = loadChildrenOf(ctx.hippoRoot, summaryId, ctx.tenantId);
  const eligible = allChildren.filter((c) => passesScopeFilterForRecall(c.scope ?? null, undefined));
  let children = eligible;
  let truncated = false;
  if (opts.budget !== undefined) {
    const out: typeof eligible = [];
    let used = 0;
    for (const c of eligible) {
      const t = Math.ceil(c.content.length / 4);
      if (out.length > 0 && used + t > opts.budget) {
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

  return {
    summary: {
      id: summary.id,
      content: summary.content,
      descendantCount: summary.descendant_count ?? eligible.length,
      earliestAt: summary.earliest_at ?? null,
      latestAt: summary.latest_at ?? null,
    },
    children: children.map((c) => ({
      id: c.id,
      content: c.content,
      layer: c.layer,
      dagLevel: c.dag_level ?? 0,
      created: c.created,
    })),
    totalChildren: eligible.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// outcome
// ---------------------------------------------------------------------------

/**
 * Apply a positive/negative outcome to a list of recently-recalled memory ids.
 * Used by the MCP `hippo_outcome` tool. Tenant-scoped: ids that don't belong
 * to ctx.tenantId are silently skipped (matches the prior MCP semantics —
 * a stale id from another tenant doesn't crash the call). Each successful
 * outcome emits one audit_log row with op='outcome' tagged with ctx.actor.
 */
export function outcome(
  ctx: Context,
  ids: ReadonlyArray<string>,
  good: boolean,
): { applied: number } {
  let applied = 0;
  const db = openHippoDb(ctx.hippoRoot);
  try {
    for (const id of ids) {
      const entry = readEntry(ctx.hippoRoot, id, ctx.tenantId);
      if (!entry) continue;
      const updated = applyOutcome(entry, good);
      writeEntry(ctx.hippoRoot, updated, { actor: ctx.actor });
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        op: 'outcome',
        targetId: id,
        metadata: { good },
      });
      applied++;
    }
  } finally {
    closeHippoDb(db);
  }
  return { applied };
}

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

/**
 * Delete a memory by id. `deleteEntry` threads ctx.actor into its internal
 * audit hook, so exactly one 'forget' event lands with the supplied actor.
 *
 * Tenant scope: deleteEntry looks up the row by id alone, so without an
 * explicit tenant guard a Bearer for tenant A could delete tenant B's row
 * by guessing or leaking the id. Pre-check the row's tenant_id and deny
 * cross-tenant access with a not-found error (no info leak about whether
 * the id exists in another tenant).
 */
export function forget(ctx: Context, id: string): { ok: true; id: string } {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const row = db
      .prepare(`SELECT tenant_id FROM memories WHERE id = ?`)
      .get(id) as { tenant_id?: string } | undefined;
    if (!row || row.tenant_id !== ctx.tenantId) {
      throw new Error(`memory not found: ${id}`);
    }
  } finally {
    closeHippoDb(db);
  }
  const removed = deleteEntry(ctx.hippoRoot, id, { actor: ctx.actor });
  if (!removed) {
    throw new Error(`memory not found: ${id}`);
  }
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

/**
 * Copy a local memory into the global store. Mirrors `cmdPromote` in cli.ts:
 * the `writeEntry` inside `promoteToGlobal` emits a 'remember' on the global
 * db; we add a 'promote' audit event on the global db so the user-facing
 * intent stays distinct from the underlying upsert.
 *
 * Note: `promoteToGlobal` does not currently take a tenantId override — it
 * reads the entry from the local root via `readEntry` (no tenant filter) and
 * preserves the entry's existing tenantId on the global side. Task 4 may
 * tighten this once writeEntry/readEntry thread tenant context.
 */
export function promote(
  ctx: Context,
  id: string,
): { ok: true; sourceId: string; globalId: string } {
  // Tenant scope: promoteToGlobal reads the entry from the local root via
  // readEntry without a tenant filter, so a Bearer for tenant A could
  // promote tenant B's row by guessing or leaking the id. Pre-check the
  // row's tenant_id and deny cross-tenant access with the same not-found
  // wording archiveRaw uses (no info leak about whether the id exists in
  // another tenant).
  const ownerDb = openHippoDb(ctx.hippoRoot);
  try {
    const row = ownerDb
      .prepare(`SELECT tenant_id FROM memories WHERE id = ?`)
      .get(id) as { tenant_id?: string } | undefined;
    if (!row || row.tenant_id !== ctx.tenantId) {
      throw new Error(`memory not found: ${id}`);
    }
  } finally {
    closeHippoDb(ownerDb);
  }

  // promoteToGlobal threads ctx.actor into the writeEntry call on the global
  // db, which emits a 'remember' audit row. We then add the user-facing
  // 'promote' event on the global db so the audit trail keeps the intent
  // distinct from the underlying upsert.
  const globalEntry = promoteToGlobal(ctx.hippoRoot, id, { actor: ctx.actor });

  const db = openHippoDb(getGlobalRoot());
  try {
    appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      op: 'promote',
      targetId: globalEntry.id,
      metadata: { sourceId: id },
    });
  } finally {
    closeHippoDb(db);
  }

  return { ok: true, sourceId: id, globalId: globalEntry.id };
}

// ---------------------------------------------------------------------------
// supersede
// ---------------------------------------------------------------------------

/**
 * Replace an old memory with new content, chaining old.superseded_by = new.id.
 * Mirrors `cmdSupersede` in cli.ts (without flag-driven layer/tag/pin overrides
 * — A1 keeps the API minimal; the CLI handler will continue to handle those
 * flags and pass the resolved values once Task 4 lands).
 */
export function supersede(
  ctx: Context,
  oldId: string,
  newContent: string,
): { ok: true; oldId: string; newId: string } {
  // Read old (tenant-scoped). readEntry filters by tenantId, so a Bearer for
  // tenant A on tenant B's id throws "Memory not found" here without any
  // info leak.
  const old: MemoryEntry | null = readEntry(ctx.hippoRoot, oldId, ctx.tenantId);
  if (!old) {
    throw new Error(`Memory not found: ${oldId}`);
  }
  // Guard: not already superseded. The CAS UPDATE below race-safely closes
  // the window between this read and the write; this check just produces a
  // clearer error in the common single-writer case.
  if (old.superseded_by) {
    throw new Error(
      `Memory ${oldId} is already superseded by ${old.superseded_by}. Supersede that one instead.`,
    );
  }

  const newEntry = createMemory(newContent, {
    layer: old.layer ?? Layer.Episodic,
    tags: [...old.tags],
    pinned: old.pinned,
    source: old.source,
    confidence: 'verified',
    tenantId: ctx.tenantId,
  });

  // Race-safe transition: open a fresh db handle, BEGIN IMMEDIATE, run all
  // three steps (CAS on old + writeEntryDbOnly(new) + supersede audit row)
  // inside the same transaction. Two concurrent supersedes: exactly one CAS
  // wins (changes=1), the other gets changes=0 and throws CONFLICT. No
  // dangling-pointer window: the new memory's row commits atomically with
  // the old.superseded_by pointer.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // 1. CAS update: only succeed if old.superseded_by IS NULL AND the
      //    row still belongs to ctx.tenantId. Tenant filter is belt-and-
      //    braces with the readEntry above — it costs nothing and closes
      //    a hypothetical window where ownership changes between read and
      //    update.
      const result = db.prepare(`
        UPDATE memories
        SET superseded_by = ?
        WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL
      `).run(newEntry.id, oldId, ctx.tenantId);
      if ((result.changes ?? 0) === 0) {
        db.exec('ROLLBACK');
        throw new Error(`Memory ${oldId} already superseded by another writer`);
      }
      // 2. Write new memory inside same tx via writeEntryDbOnly (DB-only
      //    path). This emits its OWN 'remember' audit row for the new
      //    memory inside the SAVEPOINT — atomic with the row INSERT.
      writeEntryDbOnly(db, newEntry, { actor: ctx.actor });
      // 3. User-facing 'supersede' audit row inside the same tx so the
      //    chain pointer + audit trail commit atomically.
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        op: 'supersede',
        targetId: oldId,
        metadata: { newId: newEntry.id },
      });
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
    // Mirrors after COMMIT, while the db handle is still open. Same
    // invariant as the original writeEntry: a mirror failure leaves disk
    // MISSING the markdown for the new memory (self-heals on next backfill
    // via writeIndexMirror reading the DB) but DOES NOT desync the DB or
    // roll back the supersede. Logged + swallowed, non-fatal.
    try {
      writeEntryMirrors(ctx.hippoRoot, db, newEntry);
    } catch (mirrorErr) {
      console.error(
        'supersede: mirror write failed (non-fatal, will self-heal):',
        mirrorErr,
      );
    }
  } finally {
    closeHippoDb(db);
  }

  return { ok: true, oldId, newId: newEntry.id };
}

// ---------------------------------------------------------------------------
// archive_raw
// ---------------------------------------------------------------------------

/**
 * Archive a kind='raw' memory: snapshot into raw_archive, mark archived, delete.
 *
 * `archiveRawMemory` audits the operation internally (op='archive_raw') using the
 * row's own tenant_id. We DO NOT emit a second audit event here to avoid double-
 * emitting the archive_raw op (unlike Task 1 remember/forget where the underlying
 * helpers hardcode actor='cli'). Instead we pass `ctx.actor` through as `who`,
 * and raw-archive.ts uses that for the audit row.
 */
export interface ArchiveRawOpts {
  /**
   * Connector idempotency hook (v0.39 commit 3). Runs inside the same
   * SAVEPOINT as the archive — throwing rolls the archive back. Used by the
   * Slack deletion connector to mark the deletion event seen atomically.
   */
  afterArchive?: (db: DatabaseSyncLike, archivedMemoryId: string) => void;
}

export function archiveRaw(
  ctx: Context,
  id: string,
  reason: string,
  opts: ArchiveRawOpts = {},
): { ok: true; archivedAt: string } {
  const db = openHippoDb(ctx.hippoRoot);
  let mirrorOk = false;
  try {
    // Tenant scope: archiveRawMemory looks up the row by id alone, so a
    // Bearer for tenant A could archive tenant B's raw row without this
    // pre-check. Deny cross-tenant access with the same not-found message
    // archiveRawMemory itself would throw on a missing row, so we don't
    // leak whether the id exists in another tenant.
    const row = db
      .prepare(`SELECT tenant_id FROM memories WHERE id = ?`)
      .get(id) as { tenant_id?: string } | undefined;
    if (!row || row.tenant_id !== ctx.tenantId) {
      throw new Error(`memory not found: ${id}`);
    }
    archiveRawMemory(db, id, {
      reason,
      who: ctx.actor,
      afterArchive: opts.afterArchive,
    });
    // archiveRawMemory deletes the memories row but leaves any legacy markdown
    // mirror in <root>/{buffer,episodic,semantic}/<id>.md untouched. If we left
    // the mirror in place, a subsequent initStore() on an empty memories table
    // would silently re-import the row via bootstrapLegacyStore — defeating the
    // archive (and the GDPR right-to-be-forgotten promise on raw rows). Mirror
    // forget() at src/store.ts:1046, which uses the same removeEntryMirrors call.
    // The DB transaction has already committed; if filesystem unlink fails here
    // we log and continue. The mirror reaper in openHippoDb will catch it on
    // next DB open: raw_archive.mirror_cleaned_at stays NULL until every layer
    // mirror for this id is gone, so the reaper genuinely retries.
    try {
      removeEntryMirrors(ctx.hippoRoot, id);
      mirrorOk = true;
    } catch (mirrorErr) {
      console.error(
        `archiveRaw: mirror cleanup failed for ${id} (will retry via reaper on next openHippoDb):`,
        mirrorErr,
      );
    }
    if (mirrorOk) {
      // Stamp mirror_cleaned_at now so the next openHippoDb reaper SELECT
      // returns empty for this row. NULL stays untouched on failure -> retry.
      db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
        new Date().toISOString(),
        id,
      );
    }
  } finally {
    closeHippoDb(db);
  }
  // archiveRawMemory does not return the archive_at timestamp it wrote. We
  // emit a fresh ISO timestamp here for the API response. Within a millisecond
  // of the actual write, fine for a server response shape.
  return { ok: true, archivedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// auth: create / list / revoke
// ---------------------------------------------------------------------------

export interface AuthCreateOpts {
  label?: string;
}

export interface AuthCreateResult {
  keyId: string;
  plaintext: string;
  tenantId: string;
}

/**
 * Mint a new API key. The new key is ALWAYS bound to `ctx.tenantId`. Callers
 * cannot override the tenant via the opts bag — a previous `tenantId` field
 * was removed because the HTTP layer would happily forward `body.tenantId`,
 * letting tenant A mint a key for tenant B. The HTTP route handler at
 * `src/server.ts` POST /v1/auth/keys mirrors this: it ignores any body
 * `tenantId` and uses the resolved Bearer's tenant exclusively.
 *
 * Per A5 v2 follow-ups (TODOS.md), `auth_create` is currently unaudited —
 * we intentionally match that behavior here for consistency. When A5 v2
 * lands and adds the audit op, this function should mirror the cli handler.
 */
export function authCreate(ctx: Context, opts: AuthCreateOpts): AuthCreateResult {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const result = createApiKey(db, { tenantId: ctx.tenantId, label: opts.label });
    return { keyId: result.keyId, plaintext: result.plaintext, tenantId: ctx.tenantId };
  } finally {
    closeHippoDb(db);
  }
}

/**
 * List API keys visible to the calling tenant.
 *
 * Divergence from `cmdAuthList` in src/cli.ts: the CLI today returns ALL keys
 * regardless of tenant (single-tenant deployments). The API surface is tenant-
 * scoped because future multi-tenant deployments will share a hippoRoot, and
 * tenant A must not see tenant B's keys. Read-only — no audit emit (matches A5).
 */
export function authList(
  ctx: Context,
  opts: { active: boolean },
): ApiKeyListItem[] {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const all = listApiKeys(db, opts);
    return all.filter((k) => k.tenantId === ctx.tenantId);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Revoke an API key.
 *
 * Security: the key must belong to `ctx.tenantId`. Cross-tenant revoke is
 * rejected with the same "not found" message used for missing keys, so that a
 * caller cannot probe which key_ids exist on other tenants.
 *
 * Audit: emits 'auth_revoke' with `tenantId` set to the KEY ROW's tenant_id
 * (M1 fix from A5 review, mirrors src/cli.ts:cmdAuthRevoke). Skipped on no-op
 * revoke (already revoked) so re-running doesn't pad the audit log.
 */
export function authRevoke(
  ctx: Context,
  keyId: string,
): { ok: true; revokedAt: string } {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const row = db
      .prepare(`SELECT key_id, tenant_id, revoked_at FROM api_keys WHERE key_id = ?`)
      .get(keyId) as
      | { key_id: string; tenant_id: string; revoked_at: string | null }
      | undefined;
    if (!row) {
      throw new Error(`Unknown key_id: ${keyId}`);
    }
    // Cross-tenant access denied: same message as missing key, no info leak.
    if (row.tenant_id !== ctx.tenantId) {
      throw new Error(`Unknown key_id: ${keyId}`);
    }

    let revokedAt: string;
    let alreadyRevoked = false;
    if (row.revoked_at) {
      alreadyRevoked = true;
      revokedAt = row.revoked_at;
    } else {
      revokeApiKey(db, keyId);
      const updated = db
        .prepare(`SELECT revoked_at FROM api_keys WHERE key_id = ?`)
        .get(keyId) as { revoked_at: string | null } | undefined;
      revokedAt = updated?.revoked_at ?? new Date().toISOString();
    }

    if (!alreadyRevoked) {
      try {
        appendAuditEvent(db, {
          tenantId: row.tenant_id, // M1: KEY's tenant, not ctx.tenantId.
          actor: ctx.actor,
          op: 'auth_revoke',
          targetId: keyId,
        });
      } catch {
        // Audit must not crash a successful revoke.
      }
    }

    return { ok: true, revokedAt };
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// audit: list
// ---------------------------------------------------------------------------

export interface AuditListOpts {
  op?: AuditOp;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
}

/**
 * Read audit events scoped to `ctx.tenantId`. Read-only — no audit emit (matches
 * A5: cmdAuditList does not record a 'recall'-style read event).
 */
export function auditList(ctx: Context, opts: AuditListOpts): AuditEvent[] {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    return queryAuditEvents(db, {
      tenantId: ctx.tenantId,
      op: opts.op,
      since: opts.since,
      limit: opts.limit,
    });
  } finally {
    closeHippoDb(db);
  }
}
