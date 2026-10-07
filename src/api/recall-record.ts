// The recall session rings and the recall audit rows, in one place for the CLI, MCP and HTTP surfaces.
import { appendAuditEvent, auditQueryFields, reportAuditWriteFailure, type AppendAuditOpts, type AuditOp } from '../audit.js';
import type { AvailabilityHint } from '../availability.js';
import { closeHippoDb, openHippoDb } from '../db.js';
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
} from '../recall-history.js';

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

export interface RecallAuditor {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly actor: string;
  /** Log and count a failed write instead of throwing, for a CLI command that has already done its work. */
  readonly bestEffort?: boolean;
}

/** Whom a recall audit row names; a surface that writes through the store port needs no root. */
export type RecallAuditCaller = Pick<RecallAuditor, 'tenantId' | 'actor'>;

type RecallAuditMetadata = Readonly<Record<string, string | number | null>>;

export function recallAuditRow(who: RecallAuditCaller, op: AuditOp, targetId?: string, metadata?: RecallAuditMetadata): AppendAuditOpts {
  return { tenantId: who.tenantId, actor: who.actor, op, targetId, metadata };
}

function writeRecallAudit(who: RecallAuditor, row: AppendAuditOpts): void {
  try {
    const db = openHippoDb(who.hippoRoot);
    try {
      appendAuditEvent(db, row);
    } finally {
      closeHippoDb(db);
    }
  } catch (err) {
    if (!who.bestEffort) throw err;
    reportAuditWriteFailure(row.op, String(err), row.targetId);
  }
}

/** One audit row on its own short-lived handle. */
export function appendRecallAudit(who: RecallAuditor, op: AuditOp, targetId?: string, metadata?: RecallAuditMetadata): void {
  writeRecallAudit(who, recallAuditRow(who, op, targetId, metadata));
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

/** For a surface that computes its hints over the list it shows: feeds the ring after the final detect, then audits the hints. */
export function recordShownRecall(who: RecallAuditor, shown: ShownRecall): void {
  if (shown.ring) noteRecall(shown.ring, shown.query, shown.topId, shown.anchoring?.memoryId);
  for (const row of shownRecallRows(who, shown)) writeRecallAudit(who, row);
}
