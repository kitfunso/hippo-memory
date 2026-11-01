// What a recall records: its audit rows, then the write around one recall (history, ring, recalled
// counter, token ledger row and the client's shown list).
import { auditQueryFields } from '../../base/records/audit-report.js';
import type { RequiredStore, RecallWrites } from '../../base/ports/store.js';
import type { TokenSurface } from '../../base/ports/store/ledger.js';
import type { AvailabilityHint } from '../availability.js';
import { recordTokens } from '../tokens.js';
import { strengthOf, type Context } from '../types.js';
import { keepShownIds } from './last-recalled.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import type { AuditOp } from '../../base/records/audit-ops.js';
import {
  type AnchoringHint,
  type RecallHistorySnapshot,
  type HintConfig,
  biasHintEnabled,
} from './anchoring.js';
import { type RecallSurface, sessionRing, peekSessionRing, noteRecall } from './session-rings.js';

/** The ids among `ids` that a tenant's rows in `store` hold. */
export async function heldIds(
  store: RequiredStore,
  ids: readonly string[],
  tenantId: string,
): Promise<Set<string>> {
  const held = new Set<string>();
  for (const entry of await store.entriesByIds(ids, tenantId)) held.add(entry.id);
  return held;
}

/** Whom a recall audit row names. */
export interface RecallAuditCaller {
  readonly tenantId: string;
  readonly actor: string;
}

export function callerOf(ctx: Context): RecallAuditCaller {
  return { tenantId: ctx.tenantId, actor: ctx.actor.subject };
}

/** The strengthen every ranker of `retrieve` hands to the recall's write: the shown ids, in the
 * caller's tenant. */
export function strengthenOf(
  ctx: Context,
  ids: readonly string[],
): NonNullable<RecallWrites['strengthen']> {
  return {
    ids,
    opts: { tenantId: ctx.tenantId, recallBoostAblated: !strengthOf(ctx).recallStrengthens },
  };
}

type RecallAuditMetadata = Readonly<Record<string, string | number | null>>;

export function recallAuditRow(
  who: RecallAuditCaller,
  op: AuditOp,
  targetId?: string,
  metadata?: RecallAuditMetadata,
): AppendAuditOptions {
  return { tenantId: who.tenantId, actor: who.actor, op, targetId, metadata };
}

// The row stores a hash of the query, never its text, so an archived memory's words cannot persist
// there.
export function recallAuditMetadata(query: string, results: number) {
  return { ...auditQueryFields(query), results };
}

/**
 * No session means no ring; the row hashes with SHA-256/16, since hashQueryText is FNV-1a and easy
 * to reverse on short queries.
 */
export function anchorSkippedRows(
  config: HintConfig,
  who: RecallAuditCaller,
  query: string,
): AppendAuditOptions[] {
  if (!biasHintEnabled(config, 'anchoring')) return [];
  return [
    recallAuditRow(who, 'recall_anchor_skipped_no_session', undefined, auditQueryFields(query)),
  ];
}

export function anchoringRows(
  who: RecallAuditCaller,
  hint: AnchoringHint | null,
): AppendAuditOptions[] {
  if (hint?.reason === 'memory_dominance') {
    return [
      recallAuditRow(who, 'recall_anchor_detected_memory_dominance', hint.memoryId, {
        memory_id: hint.memoryId,
        query_count: hint.queryCount ?? null,
      }),
    ];
  }
  if (hint?.reason === 'query_repeat') {
    return [
      recallAuditRow(who, 'recall_anchor_detected_query_repeat', hint.memoryId, {
        memory_id: hint.memoryId,
      }),
    ];
  }
  return [];
}

export function availabilityRows(
  who: RecallAuditCaller,
  hint: AvailabilityHint | null,
): AppendAuditOptions[] {
  if (!hint) return [];
  return [
    recallAuditRow(who, 'recall_availability_detected', undefined, {
      recent_fraction: hint.recentFraction,
      older_passed_over: hint.olderCandidatesPassedOver,
      returned_count: hint.returnedCount,
    }),
  ];
}

/** The bias hints over the list a surface showed. The api turns them into audit rows and keeps
 * the anchor for the session ring's cooldown, so a presenter decides what prints and never what
 * is recorded. */
export interface ShownHints {
  readonly anchoring: AnchoringHint | null;
  readonly availability: AvailabilityHint | null;
}

/** The recall a surface showed a list for: its query, and its session, absent or empty when it
 * named none. */
export interface ShownQuery {
  readonly query: string;
  readonly sessionId: string | undefined;
}

/** The hint rows for a list a surface showed, written in the recall's one write. */
export function shownRecallRows(
  ctx: Context,
  shown: ShownQuery,
  hints: ShownHints,
): AppendAuditOptions[] {
  const who = callerOf(ctx);
  return [
    ...(shown.sessionId ? [] : anchorSkippedRows(ctx.config, who, shown.query)),
    ...anchoringRows(who, hints.anchoring),
    ...availabilityRows(who, hints.availability),
  ];
}

/** How one surface's recall is recorded. The surfaces differ in these three values and in the
 * list they hand over, nowhere else. */
export interface RecallRecording {
  /** Whose session rings the recall reads and feeds. */
  readonly ring: RecallSurface;
  /** The label of its token ledger row. */
  readonly ledger: TokenSurface;
  /** 'every': an empty list still reaches the stats write, which then only rewrites stats.json;
   * 'shown': an empty list skips it; 'none': no stats write, and the ledger row books 0 items. */
  readonly counts: 'every' | 'shown' | 'none';
}

/** Each surface's recording; docs/recall-surface-differences.md names why they differ. */
export const RECALL_RECORDING = {
  http: { ring: 'http', ledger: 'http_recall', counts: 'every' },
  cli: { ring: 'cli', ledger: 'recall', counts: 'shown' },
  mcp: { ring: 'mcp', ledger: 'mcp_recall', counts: 'none' },
} as const satisfies Record<RecallSurface, RecallRecording>;

/** What a recorded recall takes into ranking. */
export interface RecallLead {
  readonly recallHistory: RecallHistorySnapshot | undefined;
  readonly leadingAudit: readonly AppendAuditOptions[];
}

/** For a surface whose hint `retrieve` judges: the session's history, or the row saying the
 * recall named no session. */
export function recallLead(
  ctx: Context,
  how: RecallRecording,
  query: string,
  sessionId: string | undefined,
): RecallLead {
  return {
    // Peeked, never created: a recall that then fails must not LRU-evict a live session.
    recallHistory:
      sessionId && biasHintEnabled(ctx.config, 'anchoring')
        ? peekSessionRing(ctx, how.ring, sessionId)
        : undefined,
    // Written first in the recall's own write, so a recall that fails leaves no row.
    leadingAudit: sessionId ? [] : anchorSkippedRows(ctx.config, callerOf(ctx), query),
  };
}

/** The list a recall showed, as its ranker counted and priced it. */
export interface ShownList {
  readonly query: string;
  /** The recall's session, which keys the ring. */
  readonly sessionId: string | undefined;
  /** The ids shown, best first. */
  readonly ids: readonly string[];
  /** The memory this recall's anchoring hint named; the next recall's cooldown reads it. */
  readonly anchoredOn: string | undefined;
  readonly tokens: number;
  /** The session the ledger row names: the recall's own on HTTP, the host agent's on the CLI,
   * none on MCP. */
  readonly ledgerSessionId: string | null;
  /** False when the audit rows could not be written and the caller answers anyway. */
  readonly written: boolean;
}

/** Runs after the recall's own write, in order: the ring, the counter, the ledger, then the
 * client's shown list. */
export async function recordShownRecall(
  ctx: Context,
  store: RequiredStore,
  how: RecallRecording,
  shown: ShownList,
): Promise<void> {
  // A surface that only peeked has its ring created here, after the write, so a recall that fails
  // cannot LRU-evict a live session.
  const ring = sessionRing(ctx, how.ring, shown.sessionId);
  if (ring) {
    noteRecall({
      ring,
      query: shown.query,
      topId: shown.ids[0] ?? null,
      anchoredOn: shown.anchoredOn,
      now: ctx.infra.clock(),
    });
  }
  const items = how.counts === 'none' ? 0 : shown.ids.length;
  // A recall with no audit row counts nothing, as it strengthens and traces nothing.
  if (shown.written && (how.counts === 'every' || items > 0)) await store.bumpRecallStats(items);
  // The ledger books text that was sent, so its row does not wait on the audit write.
  await recordTokens(ctx, how.ledger, {
    items,
    tokens: shown.tokens,
    sessionId: shown.ledgerSessionId,
  });
  keepShownIds(ctx, shown.ids);
}
