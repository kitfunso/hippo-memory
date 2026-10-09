// The recall session rings and the recall audit rows, in one place for the CLI, MCP and HTTP surfaces.
import { isRecallBoostAblated } from '../core/ablation.js';
import { auditQueryFields, type AppendAuditOpts, type AuditOp } from '../store/audit.js';
import type { AvailabilityHint } from './availability.js';
import {
  appendRecall,
  biasHintEnabled,
  buildSessionKey,
  getOrCreateRing,
  hashQueryText,
  RingBuffer,
  snapshotRing,
  type AnchoringHint,
  type RecallHistorySnapshot,
} from './recall-history.js';
import type { RecallWrites } from '../store/index.js';
import type { Context } from './types.js';

export type RecallSurface = 'cli' | 'mcp' | 'http';

// One map per surface, each with its own LRU cap, so a repeat on one surface is a first recall on another.
const rings = {
  cli: new Map<string, RingBuffer>(),
  mcp: new Map<string, RingBuffer>(),
  http: new Map<string, RingBuffer>(),
};

/** The session's ring, created on first use; null when anchoring is off or the call has no session. */
export function sessionRing(surface: RecallSurface, tenantId: string, sessionId: string | undefined): RingBuffer | null {
  if (!biasHintEnabled('anchoring') || !sessionId) return null;
  return getOrCreateRing(rings[surface], buildSessionKey(tenantId, sessionId));
}

/** The session's history, read without creating or touching its ring, so a request that then fails evicts no live session. */
export function peekSessionRing(surface: RecallSurface, tenantId: string, sessionId: string): RecallHistorySnapshot {
  const ring = rings[surface].get(buildSessionKey(tenantId, sessionId));
  return ring ? snapshotRing(ring) : [];
}

/** Records this recall's top row and hint, which the next recall's cooldown reads. */
export function noteRecall(ring: RingBuffer, query: string, topId: string | null, anchoredOn: string | undefined): void {
  appendRecall(ring, hashQueryText(query), topId, anchoredOn);
}

export function resetSessionRings(surface: RecallSurface): void {
  rings[surface].clear();
}

/** Whom a recall audit row names. */
export interface RecallAuditCaller {
  readonly tenantId: string;
  readonly actor: string;
}

export function callerOf(ctx: Context): RecallAuditCaller {
  return { tenantId: ctx.tenantId, actor: ctx.actor.subject };
}

/** The strengthen every ranker of `retrieve` hands to the recall's write: the shown ids, in the caller's tenant. */
export function strengthenOf(ctx: Context, ids: readonly string[]): NonNullable<RecallWrites['strengthen']> {
  return { ids, opts: { tenantId: ctx.tenantId, recallBoostAblated: isRecallBoostAblated() } };
}

type RecallAuditMetadata = Readonly<Record<string, string | number | null>>;

export function recallAuditRow(who: RecallAuditCaller, op: AuditOp, targetId?: string, metadata?: RecallAuditMetadata): AppendAuditOpts {
  return { tenantId: who.tenantId, actor: who.actor, op, targetId, metadata };
}

// The row stores a hash of the query, never its text, so an archived memory's words cannot persist there.
export function recallAuditMetadata(query: string, results: number) {
  return { ...auditQueryFields(query), results };
}

/** No session means no ring; the row hashes with SHA-256/16, since hashQueryText is FNV-1a and easy to reverse on short queries. */
export function anchorSkippedRows(who: RecallAuditCaller, query: string): AppendAuditOpts[] {
  if (!biasHintEnabled('anchoring')) return [];
  return [recallAuditRow(who, 'recall_anchor_skipped_no_session', undefined, auditQueryFields(query))];
}

export function anchoringRows(who: RecallAuditCaller, hint: AnchoringHint | null): AppendAuditOpts[] {
  if (hint?.reason === 'memory_dominance') {
    return [recallAuditRow(who, 'recall_anchor_detected_memory_dominance', hint.memoryId, {
      memory_id: hint.memoryId,
      query_count: hint.queryCount ?? null,
    })];
  }
  if (hint?.reason === 'query_repeat') {
    return [recallAuditRow(who, 'recall_anchor_detected_query_repeat', hint.memoryId, { memory_id: hint.memoryId })];
  }
  return [];
}

export function availabilityRows(who: RecallAuditCaller, hint: AvailabilityHint | null): AppendAuditOpts[] {
  if (!hint) return [];
  return [recallAuditRow(who, 'recall_availability_detected', undefined, {
    recent_fraction: hint.recentFraction,
    older_passed_over: hint.olderCandidatesPassedOver,
    returned_count: hint.returnedCount,
  })];
}

export interface ShownRecall {
  readonly query: string;
  readonly ring: RingBuffer | null;
  readonly topId: string | null;
  readonly anchoring: AnchoringHint | null;
  readonly availability: AvailabilityHint | null;
}

/** The hint rows for a list a surface showed, so a surface on the store port can hand them to the recall's one write. */
export function shownRecallRows(who: RecallAuditCaller, shown: ShownRecall): AppendAuditOpts[] {
  return [
    ...(shown.ring ? [] : anchorSkippedRows(who, shown.query)),
    ...anchoringRows(who, shown.anchoring),
    ...availabilityRows(who, shown.availability),
  ];
}
