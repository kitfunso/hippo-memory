import { canAutoDelete, type MemoryEntry } from '../core/memory.js';
import { closeHippoDb, openHippoDb, withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import type { JsonObject } from './working-memory.js';
import { log } from '../util/log.js';
import { blockHash } from '../util/token-text.js';
import { keysetAfter, type KeysetPosition } from '../util/keyset.js';
import type { JsonValue } from '../util/json.js';
import { warnDamagedColumn } from '../util/stored-json.js';
import {
  automaticDefect, hasNoSpecificity, isFragment, isReleaseCommitNoise, substantiveWordCount,
} from '../core/memory-quality.js';

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
  // Opaque on purpose: appendAuditEvent only JSON.stringify's it wholesale and never reads a field,
  // so no parsed contract is claimed.
  metadata?: unknown;
}

// node:sqlite returns INTEGER as bigint above MAX_SAFE_INTEGER, which JSON.stringify cannot serialize without a replacer.
// `JsonValueWithBigInt` keeps `any` out of this boundary and stays assignable as a JSON.stringify replacer.
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
    query_hash: blockHash(query),
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

/** One audit row in the store under `hippoRoot`, as its own write. */
export function recordAuditEvent(hippoRoot: string, event: AppendAuditOpts): void {
  const db = openHippoDb(hippoRoot);
  try {
    appendAuditEvent(db, event);
  } finally {
    closeHippoDb(db);
  }
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

/** Adds the failures a store worker counted on its own thread, so the process reports one number. */
export function addAuditWriteFailures(count: number): void {
  auditWriteFailures += count;
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

/** Cursor read: events with id > afterId, ascending. Retention prune leaves gaps in the ids,
 * so resume from the last id returned, never from a count. */
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

/** How many of a tenant's audit rows are older than `cutoff`. */
function countAuditBefore(db: DatabaseSyncLike, tenantId: string, cutoff: string): number {
  // SAFETY: row comes from `SELECT COUNT(*) AS c`; COUNT(*) always yields exactly one row with a
  // numeric `c` column (number or bigint depending on the node:sqlite driver's integer handling).
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE tenant_id = ? AND ts < ?`)
    .get(tenantId, cutoff) as { c: number | bigint };
  return Number(row.c);
}

/** Deletes a tenant's audit rows older than `cutoff`; returns how many went. */
function deleteAuditBefore(db: DatabaseSyncLike, tenantId: string, cutoff: string): number {
  const result = db
    .prepare(`DELETE FROM audit_log WHERE tenant_id = ? AND ts < ?`)
    .run(tenantId, cutoff);
  return Number(result.changes ?? 0);
}

/** Latest time each target got a good outcome, from the audit rows, read on a handle of its own; unlike queryAuditEvents it has no row cap. */
export function confirmedOutcomeTimes(hippoRoot: string, tenantId: string): Map<string, string> {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: the SELECT list is exactly target_id and ts; no other shape reaches this cast.
    const rows = db.prepare(
      `SELECT target_id, MAX(ts) AS ts FROM audit_log
         WHERE tenant_id = ? AND op = 'outcome' AND target_id IS NOT NULL
           AND json_extract(metadata_json, '$.good') = 1
         GROUP BY target_id`,
    ).all(tenantId) as { target_id: string; ts: string }[];
    return new Map(rows.map((r) => [r.target_id, r.ts]));
  } finally {
    closeHippoDb(db);
  }
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
    metadata: safeJsonParse(r.metadata_json, r.id),
  };
}

function safeJsonParse(raw: string, id: number): JsonObject {
  try {
    const v = JSON.parse(raw);
    // SAFETY: JSON.parse returns only an object, array or primitive; `instanceof Object` is true for the first two,
    // both valid JsonObject shapes here.
    return v instanceof Object ? (v as JsonObject) : {};
  } catch {
    // Malformed metadata reads as empty so the audit row itself stays listable.
    warnDamagedColumn({ table: 'audit_log', id, column: 'metadata_json' }, 'not valid JSON');
    return {};
  }
}

/** An audit row that did not land, with what its write threw. */
export interface FailedAuditEvent {
  event: AppendAuditOpts;
  error: unknown;
}

/** Appends each event as its own write on one handle, so a row that fails drops only itself. Returns the rows that failed, for the caller to report. */
export function recordAuditEventsRowByRow(hippoRoot: string, events: readonly AppendAuditOpts[]): FailedAuditEvent[] {
  const db = openHippoDb(hippoRoot);
  try {
    const failed: FailedAuditEvent[] = [];
    for (const event of events) {
      try {
        appendAuditEvent(db, event);
      } catch (error) {
        failed.push({ event, error });
      }
    }
    return failed;
  } finally {
    closeHippoDb(db);
  }
}

export interface AuditPrune {
  tenantId: string;
  /** ISO time; rows with `ts` before it go. */
  cutoff: string;
  actor: string;
  olderThanDays: number;
  /** Count the rows and delete nothing. */
  dryRun: boolean;
}

/** Deletes a tenant's audit rows older than the cutoff and records the prune in the same write scope, so neither lands alone; returns the row count. */
export function pruneAuditRows(hippoRoot: string, prune: AuditPrune): number {
  const { tenantId, cutoff, actor, olderThanDays } = prune;
  const db = openHippoDb(hippoRoot);
  try {
    if (prune.dryRun) return countAuditBefore(db, tenantId, cutoff);
    return withWriteScope(db, 'audit_prune', () => {
      const count = deleteAuditBefore(db, tenantId, cutoff);
      // Written after the delete with ts = now, so the cutoff just applied cannot take it.
      appendAuditEvent(db, { tenantId, actor, op: 'audit_prune', metadata: { cutoff, count, dryRun: false, olderThanDays } });
      return count;
    });
  } finally {
    closeHippoDb(db);
  }
}
