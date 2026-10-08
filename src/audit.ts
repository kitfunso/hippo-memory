import { createHash } from 'node:crypto';
import { canAutoDelete, type MemoryEntry } from './memory.js';
import type { DatabaseSyncLike } from './db.js';
import type { JsonObject } from './working-memory.js';
import { log } from './log.js';
import { keysetAfter, type KeysetPosition } from './keyset.js';
import type { JsonValue } from './json.js';
import {
  automaticDefect, hasNoSpecificity, isFragment, isReleaseCommitNoise, substantiveWordCount,
} from './memory-quality.js';

export type AuditSeverity = 'warning' | 'error';

export interface AuditIssue {
  memoryId: string;
  content: string;
  severity: AuditSeverity;
  reason: string;
}

export interface AuditResult {
  total: number;
  issues: AuditIssue[];
  clean: number;
}

export function auditMemory(entry: MemoryEntry, backsObject = false): AuditIssue | null {
  const issue = classifyMemory(entry);
  // Error means "auto-remove"; a pinned, raw, kept-for-good or object-backing row is never auto-removed, so it can only warn.
  if (issue?.severity === 'error' && (!canAutoDelete(entry) || backsObject)) {
    const why = entry.pinned ? 'pinned' : entry.kind === 'raw' ? 'raw' : backsObject ? 'backs an object' : 'keep rule';
    return { ...issue, severity: 'warning', reason: `${issue.reason} (${why}, kept)` };
  }
  return issue;
}

function classifyMemory(entry: MemoryEntry): AuditIssue | null {
  const content = entry.content.trim();

  if (content.length < 3) {
    return { memoryId: entry.id, content, severity: 'error', reason: 'too short (< 3 chars)' };
  }

  if (content.length < 10) {
    return { memoryId: entry.id, content, severity: 'error', reason: 'too short (< 10 chars)' };
  }

  if (isReleaseCommitNoise(content)) {
    return { memoryId: entry.id, content, severity: 'error', reason: 'release/commit noise, not a useful memory' };
  }

  if (isFragment(content)) {
    return { memoryId: entry.id, content, severity: 'warning', reason: 'sentence fragment — lacks context' };
  }

  const substantive = substantiveWordCount(content);
  if (substantive < 2) {
    return { memoryId: entry.id, content, severity: 'warning', reason: `only ${substantive} substantive word(s) — too vague` };
  }

  if (content.length < 40 && hasNoSpecificity(content)) {
    return { memoryId: entry.id, content, severity: 'warning', reason: 'no specific details (names, paths, numbers, code)' };
  }

  const reason = automaticDefect(entry);
  if (reason !== null) {
    return { memoryId: entry.id, content, severity: 'warning', reason: `automatic memory defect: ${reason}` };
  }

  return null;
}

/** `backing`: ids of memories that back an object (store.memoriesBackingObjects). */
export function auditMemories(entries: MemoryEntry[], backing: ReadonlySet<string>): AuditResult {
  const issues: AuditIssue[] = [];
  for (const entry of entries) {
    const issue = auditMemory(entry, backing.has(entry.id));
    if (issue) issues.push(issue);
  }
  return {
    total: entries.length,
    issues,
    clean: entries.length - issues.length,
  };
}

// ---------------------------------------------------------------------------
// Audit log primitives (append-only mutation trail)
// ---------------------------------------------------------------------------

// The one list of audit ops: the AuditOp type, `hippo audit list --op` and GET /v1/audit?op= all read it.
export const AUDIT_OPS = [
  'remember',
  'recall',
  'promote',
  'supersede',
  'forget',
  'archive_raw',
  'auth_revoke',
  'auth_create', // emitted by api.authCreate
  'outcome',
  'consolidate', // emitted once per api.sleep invocation
  'audit_prune', // emitted by pruneAuditLog after each retention prune
  'summary_marked_dirty', // emitted by markSummaryDirty on the 0->1 transition
  'summary_marked_clean', // emitted by clearSummaryDirtyAfterBuild after the buildDag child-link loop
  'summary_rebuilt', // emitted by applyRebuildResult on a successful sleep-cycle rebuild
  'predict_create', // emitted by savePrediction
  'predict_close', // emitted by closePrediction
  'predict_baserate', // emitted by computePredictionBaserate
  'recall_autodebias_hint', // emitted by computePlanningFallacyOutput on success
  'recall_autodebias_hint_no_class_match', // telemetry: forward-claim detected, no class scored
  'recall_autodebias_hint_tiebreak', // telemetry: forward-claim detected, two or more classes tied
  'recall_anchor_detected_query_repeat', // emitted by the anchoring detector when the same query returns the same top-1
  'recall_anchor_detected_memory_dominance', // emitted by the anchoring detector when one memory wins top-1 across distinct queries
  'recall_anchor_skipped_no_session', // telemetry: no sessionId, so ring tracking was skipped
  'recall_availability_detected', // emitted when the availability/recency-bias hint fires
  'decision_create', // emitted by saveDecision
  'decision_supersede', // emitted by saveDecision when --supersedes resolves to an active decision
  'decision_close', // emitted by closeDecision
  'incident_open', // emitted by saveIncident
  'incident_resolve', // emitted by resolveIncident
  'incident_close', // emitted by closeIncident
  'process_create', // emitted by saveProcess
  'process_supersede', // emitted by saveProcess on a supersession
  'process_close', // emitted by closeProcess
  'policy_create', // emitted by savePolicy
  'policy_supersede', // emitted by savePolicy on a supersession
  'policy_close', // emitted by closePolicy
  'skill_create', // emitted by saveSkill
  'skill_supersede', // emitted by saveSkill on a supersession
  'skill_close', // emitted by closeSkill
  'project_brief_create', // emitted by saveProjectBrief
  'project_brief_supersede', // emitted by saveProjectBrief on a supersession, including a refresh
  'project_brief_close', // emitted by closeProjectBrief
  'customer_note_create', // emitted by saveCustomerNote
  'customer_note_supersede', // emitted by saveCustomerNote on a supersession
  'customer_note_close', // emitted by closeCustomerNote
  'mv_rescue', // emitted by consolidate() per rescued entry when config.memoryValue.enabled
  'reject_value', // emitted by the `hippo reject` verb
  'reject_refusal', // emitted when the rejection guard refuses a write
  'unreject_value', // emitted by the `hippo unreject` verb
  'conflict_resolve', // emitted by resolveConflict on every resolution path
  'half_life_migrate', // emitted by migrateDefaultHalfLife with the rescaled ids
  'dormant_restore', // emitted by api.restoreDormant
  'auth_grant', // emitted by api.authGrant
  'auth_ungrant', // emitted by api.authUngrant
  'quarantine', // emitted by recordQuarantine inside remember's write transaction
  'quarantine_approve', // emitted by api.quarantineApprove
  'quarantine_reject', // emitted by api.quarantineReject
  'agent_memory_restore', // emitted by the agent memory sync when a deleted note comes back
  'agent_memory_set_aside', // emitted by the agent memory sync when a note is deleted or refused
  'project_merge', // emitted by `hippo projects merge --apply` with every id it touched
  'project_repair', // emitted by `hippo projects repair --apply` with every id it touched
  'quality_repair', // emitted by `hippo audit repair --apply` for each memory it moved to dormant storage
] as const;

export type AuditOp = (typeof AUDIT_OPS)[number];

export interface AppendAuditOpts {
  tenantId: string;
  actor: string; // 'cli' | 'api_key:hk_...' | 'system'
  op: AuditOp;
  targetId?: string;
  // Callers attach arbitrary contextual data here (out-of-scope src/cli.ts's
  // emitCliAudit still types this Record<string, unknown>); appendAuditEvent
  // never reads a field off it, only JSON.stringify's it wholesale below, so
  // it stays genuinely opaque rather than claiming a parsed contract it can't
  // enforce at every call site.
  metadata?: unknown;
}

// node:sqlite returns INTEGER columns as bigint when the value exceeds
// Number.MAX_SAFE_INTEGER. Audit metadata can carry such values (row ids,
// counts), and JSON.stringify cannot serialize bigint without a replacer.
// Mirrors the bigintSafeReplacer in src/raw-archive.ts.
// `JsonValueWithBigInt` stands in for JSON.stringify's own `(key: string,
// value: any) => any` replacer contract without exposing `any`/`unknown` at
// this function's boundary; it is still assignable where JSON.stringify
// expects a replacer.
type JsonValueWithBigInt = JsonValue | bigint;

function isBigIntValue(value: JsonValueWithBigInt): value is bigint {
  return typeof value === 'bigint';
}

function bigintSafeReplacer(_key: string, value: JsonValueWithBigInt): JsonValueWithBigInt {
  return isBigIntValue(value) ? value.toString() : value;
}

export type AuditQueryFields = {
  query_hash: string;
  query_length: number;
};

export function auditQueryFields(query: string): AuditQueryFields {
  return {
    query_hash: createHash('sha256').update(query).digest('hex').slice(0, 16),
    query_length: query.length,
  };
}

export function appendAuditEvent(db: DatabaseSyncLike, opts: AppendAuditOpts): void {
  db.prepare(
    `INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    opts.tenantId,
    opts.actor,
    opts.op,
    opts.targetId ?? null,
    JSON.stringify(opts.metadata ?? {}, bigintSafeReplacer),
  );
}

let auditWriteFailures = 0;

/** For callers that keep a mutation when its audit row fails: the failure is logged and counted, never silent. */
export function reportAuditWriteFailure(op: AuditOp, reason: string, targetId?: string | null): void {
  auditWriteFailures++;
  log.error(`audit write failed: ${reason}`, { op, target: targetId ?? undefined });
}

/** Audit rows this process failed to write; the loopback `/health` body reports it. */
export function auditWriteFailureCount(): number {
  return auditWriteFailures;
}

export interface QueryAuditOpts {
  tenantId: string;
  op?: AuditOp;
  since?: string; // ISO timestamp
  limit?: number;
  /** Resume after this row: the (ts, id) position the previous page ended on. */
  after?: KeysetPosition;
}

export interface AuditEvent {
  id: number;
  ts: string;
  tenantId: string;
  actor: string;
  op: AuditOp;
  targetId: string | null;
  metadata: JsonObject;
}

export function queryAuditEvents(db: DatabaseSyncLike, opts: QueryAuditOpts): AuditEvent[] {
  const where: string[] = ['tenant_id = ?'];
  const params: unknown[] = [opts.tenantId];
  if (opts.op) {
    where.push('op = ?');
    params.push(opts.op);
  }
  if (opts.since) {
    where.push('ts >= ?');
    params.push(opts.since);
  }
  const after = keysetAfter('ts', 'id', opts.after);
  // One past the route's 10000 cap: GET /v1/audit reads a row ahead to tell whether another page exists.
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 10001));
  // SAFETY: AUDIT_COLUMNS names exactly the AuditRow columns, in this order.
  const rows = db
    .prepare(
      `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE ${where.join(' AND ')}${after.sql} ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...params, ...after.params, limit) as AuditRow[];
  return rows.map(rowToAuditEvent);
}

export interface ListAuditAfterOpts {
  /** Last id already consumed; 0 starts from the beginning. */
  afterId: number;
  /** Clamped to 1..10000; default 1000. */
  limit?: number;
  /** Omit for every tenant (deployment-wide export). */
  tenantId?: string;
}

/**
 * Cursor read: events with id > afterId, ascending by id. Ids are AUTOINCREMENT
 * and never reused, but deletes (retention prune) leave gaps, so resume from
 * the last id returned, never from a count.
 */
export function listAuditEventsAfter(db: DatabaseSyncLike, opts: ListAuditAfterOpts): AuditEvent[] {
  if (!Number.isInteger(opts.afterId) || opts.afterId < 0) {
    throw new RangeError('afterId must be a non-negative integer');
  }
  if (opts.limit !== undefined && !Number.isInteger(opts.limit)) {
    throw new RangeError('limit must be an integer');
  }
  const where: string[] = ['id > ?'];
  const params: unknown[] = [opts.afterId];
  if (opts.tenantId !== undefined) {
    where.push('+tenant_id = ?');
    params.push(opts.tenantId);
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10000));
  // SAFETY: AUDIT_COLUMNS names exactly the AuditRow columns, in this order.
  const rows = db
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`)
    .all(...params, limit) as AuditRow[];
  return rows.map(rowToAuditEvent);
}

const AUDIT_COLUMNS = 'id, ts, tenant_id, actor, op, target_id, metadata_json';

interface AuditRow {
  id: number;
  ts: string;
  tenant_id: string;
  actor: string;
  op: string;
  target_id: string | null;
  metadata_json: string;
}

function rowToAuditEvent(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    ts: r.ts,
    tenantId: r.tenant_id,
    actor: r.actor,
    // SAFETY: audit_log.op is only ever written by appendAuditEvent, whose opts.op is
    // typed AuditOp at the INSERT call site, so every stored value is a valid AuditOp.
    op: r.op as AuditOp,
    targetId: r.target_id,
    metadata: safeJsonParse(r.metadata_json),
  };
}

function safeJsonParse(raw: string): JsonObject {
  try {
    const v = JSON.parse(raw);
    // SAFETY: JSON.parse only ever returns a plain object, array, string, number,
    // boolean, or null; `v instanceof Object` is true for exactly the first two
    // (both are valid JsonObject shapes for our purposes), matching the prior
    // `typeof v === 'object' && v !== null` check without using typeof.
    return v instanceof Object ? (v as JsonObject) : {};
  } catch {
    // Malformed metadata reads as empty so the audit row itself stays listable.
    return {};
  }
}
