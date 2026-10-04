// The recall session rings and the recall audit rows, in one place for the CLI, MCP and HTTP surfaces.
import { appendAuditEvent, auditQueryFields, reportAuditWriteFailure, type AuditOp } from '../audit.js';
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

type RecallAuditMetadata = Readonly<Record<string, string | number | null>>;

/** One audit row on its own short-lived handle. */
export function appendRecallAudit(who: RecallAuditor, op: AuditOp, targetId?: string, metadata?: RecallAuditMetadata): void {
  try {
    const db = openHippoDb(who.hippoRoot);
    try {
      appendAuditEvent(db, { tenantId: who.tenantId, actor: who.actor, op, targetId, metadata });
    } finally {
      closeHippoDb(db);
    }
  } catch (err) {
    if (!who.bestEffort) throw err;
    reportAuditWriteFailure(op, String(err), targetId);
  }
}

// The row stores a hash of the query, never its text, so an archived memory's words cannot persist there.
export function recallAuditMetadata(query: string, results: number) {
  return { ...auditQueryFields(query), results };
}

/** No session means no ring; the row hashes with SHA-256/16, since hashQueryText is FNV-1a and easy to reverse on short queries. */
export function auditAnchorSkipped(who: RecallAuditor, query: string): void {
  if (biasHintEnabled('anchoring')) appendRecallAudit(who, 'recall_anchor_skipped_no_session', undefined, auditQueryFields(query));
}

export function auditAnchoring(who: RecallAuditor, hint: AnchoringHint | null): void {
  if (hint?.reason === 'memory_dominance') {
    appendRecallAudit(who, 'recall_anchor_detected_memory_dominance', hint.memoryId, {
      memory_id: hint.memoryId,
      query_count: hint.queryCount ?? null,
    });
  } else if (hint?.reason === 'query_repeat') {
    appendRecallAudit(who, 'recall_anchor_detected_query_repeat', hint.memoryId, { memory_id: hint.memoryId });
  }
}

export function auditAvailability(who: RecallAuditor, hint: AvailabilityHint | null): void {
  if (!hint) return;
  appendRecallAudit(who, 'recall_availability_detected', undefined, {
    recent_fraction: hint.recentFraction,
    older_passed_over: hint.olderCandidatesPassedOver,
    returned_count: hint.returnedCount,
  });
}

export interface ShownRecall {
  readonly query: string;
  readonly ring: RingBuffer | null;
  readonly topId: string | null;
  readonly anchoring: AnchoringHint | null;
  readonly availability: AvailabilityHint | null;
}

/** For a surface that computes its hints over the list it shows: feeds the ring after the final detect, then audits the hints. */
export function recordShownRecall(who: RecallAuditor, shown: ShownRecall): void {
  if (shown.ring) noteRecall(shown.ring, shown.query, shown.topId, shown.anchoring?.memoryId);
  else auditAnchorSkipped(who, shown.query);
  auditAnchoring(who, shown.anchoring);
  auditAvailability(who, shown.availability);
}
