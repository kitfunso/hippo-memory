import { DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT } from '../../base/util/limits.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { keysetAfter } from '../../base/util/keyset.js';
import type { JsonValue, JsonObject } from '../../base/util/json.js';
import { parseStoredObject } from '../../base/util/stored-json.js';
import type { AppendAuditOpts, AuditEvent } from '../port/types.js';
import type { AuditOp } from '../../base/records/audit-ops.js';
import type { QueryAuditOptions } from '../port/audit-log.js';
import type { AuditPrune } from '../port/audit-maintenance.js';
import type { ListAuditAfterOpts } from '../port/key-audit.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { cachedStatement } from '../../db/statement-cache.js';

// node:sqlite returns INTEGER as bigint above MAX_SAFE_INTEGER, which JSON.stringify cannot serialize without a
// replacer. `JsonValueWithBigInt` keeps `any` out of this boundary and stays assignable as a JSON.stringify replacer.
type JsonValueWithBigInt = JsonValue | bigint;

function isBigIntValue(value: JsonValueWithBigInt): value is bigint {
  return typeof value === 'bigint';
}

function bigintSafeReplacer(_key: string, value: JsonValueWithBigInt): JsonValueWithBigInt {
  return isBigIntValue(value) ? value.toString() : value;
}

const AUDIT_ROW_COLUMNS = 'ts, tenant_id, actor, op, target_id, metadata_json';
const INSERT_AUDIT_ROW_SQL = `INSERT INTO audit_log (${AUDIT_ROW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`;

export function appendAuditEvent(db: DatabaseSyncLike, opts: AppendAuditOpts): void {
  cachedStatement(db, INSERT_AUDIT_ROW_SQL).run(new Date().toISOString(), ...auditRowValues(opts));
}

// Every column is text, so one JSON array binds any number of rows and the statement's text never changes.
const INSERT_AUDIT_ROWS_SQL =
  `INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) ` +
  `SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), ` +
  `json_extract(value, '$[3]'), json_extract(value, '$[4]') FROM json_each(?) ORDER BY key`;

/** appendAuditEvent for many rows in one statement, ids in `events` order; a failure writes none of them. */
export function appendAuditEventsAt(db: DatabaseSyncLike, events: readonly AppendAuditOpts[]): void {
  if (events.length === 0) return;
  cachedStatement(db, INSERT_AUDIT_ROWS_SQL).run(new Date().toISOString(), JSON.stringify(events.map(auditRowValues)));
}

function auditRowValues(opts: AppendAuditOpts): [string, string, string, string | null, string] {
  return [
    opts.tenantId,
    opts.actor,
    opts.op,
    opts.targetId ?? null,
    JSON.stringify(opts.metadata ?? {}, bigintSafeReplacer),
  ];
}

export function queryAuditEvents(db: DatabaseSyncLike, opts: QueryAuditOptions): AuditEvent[] {
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
  // One past the cap: GET /v1/audit reads a row ahead to tell whether another page exists.
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT + 1));
  const rows = cachedStatement(
    db,
    `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE ${where.join(' AND ')}${after.sql} ORDER BY ts DESC, id DESC ` +
      `LIMIT ?`,
  ).all(...params, ...after.params, limit) as AuditRow[];
  return rows.map(rowToAuditEvent);
}

/** Cursor read: events with id > afterId, ascending. Retention prune leaves gaps in the ids, so resume from the last id
 * returned, never from a count. */
export function listAuditEventsAfter(db: DatabaseSyncLike, opts: ListAuditAfterOpts): AuditEvent[] {
  if (!Number.isInteger(opts.afterId) || opts.afterId < 0) {
    throw new RangeError('afterId must be a non-negative integer');
  }
  if (opts.limit !== undefined && !Number.isInteger(opts.limit)) {
    throw new RangeError('limit must be an integer');
  }
  const where: string[] = ['id > ?'];
  const params: unknown[] = [opts.afterId];
  if (opts.tenantId !== ALL_TENANTS) {
    where.push('+tenant_id = ?');
    params.push(opts.tenantId);
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, MAX_AUDIT_LIMIT));
  const rows = cachedStatement(
    db,
    `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`,
  ).all(...params, limit) as AuditRow[];
  return rows.map(rowToAuditEvent);
}

/** How many of a tenant's audit rows are older than `cutoff`. */
function countAuditBefore(db: DatabaseSyncLike, tenantId: string, cutoff: string): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = cachedStatement(db, `SELECT COUNT(*) AS c FROM audit_log WHERE tenant_id = ? AND ts < ?`).get(
    tenantId,
    cutoff,
  ) as { c: number | bigint };
  return Number(row.c);
}

/** Deletes a tenant's audit rows older than `cutoff`; returns how many went. */
function deleteAuditBefore(db: DatabaseSyncLike, tenantId: string, cutoff: string): number {
  const result = cachedStatement(db, `DELETE FROM audit_log WHERE tenant_id = ? AND ts < ?`).run(tenantId, cutoff);
  return Number(result.changes ?? 0);
}

/** Latest time each target got a good outcome at or after `since`, from the audit rows; unlike queryAuditEvents it has
 * no row cap, and the ts range rides the (tenant_id, ts) index so older rows are never read. */
export function confirmedOutcomeTimesAt(db: DatabaseSyncLike, tenantId: string, since: string): Map<string, string> {
  const rows = cachedStatement(
    db,
    `SELECT target_id, MAX(ts) AS ts FROM audit_log
       WHERE tenant_id = ? AND ts >= ? AND op = 'outcome' AND target_id IS NOT NULL
         AND json_extract(metadata_json, '$.good') = 1
       GROUP BY target_id`,
  ).all(tenantId, since) as { target_id: string; ts: string }[];
  return new Map(rows.map((r) => [r.target_id, r.ts]));
}

const AUDIT_COLUMNS = 'id, ts, tenant_id, actor, op, target_id, metadata_json';

// SAFETY: every read cast to this row selects AUDIT_COLUMNS; scripts/check-row-casts.mjs proves it.
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
    // SAFETY: audit_log.op is only ever written by appendAuditEvent, whose opts.op is typed AuditOp at the INSERT call
    // site, so every stored value is a valid AuditOp.
    op: r.op as AuditOp,
    targetId: r.target_id,
    metadata: safeJsonParse(r.metadata_json, r.id),
  };
}

function safeJsonParse(raw: string, id: number): JsonObject {
  // Damaged metadata reads as empty so the audit row itself stays listable.
  return parseStoredObject({ table: 'audit_log', id, column: 'metadata_json' }, raw) ?? {};
}

/** An audit row that did not land, with what its write threw. */
export interface FailedAuditEvent {
  event: AppendAuditOpts;
  error: unknown;
}

/** Appends each event as its own write on one handle, so a row that fails drops only itself. Returns the rows that
 * failed, for the caller to report. */
export function recordAuditEventsRowByRowAt(
  db: DatabaseSyncLike,
  events: readonly AppendAuditOpts[],
): FailedAuditEvent[] {
  const failed: FailedAuditEvent[] = [];
  for (const event of events) {
    try {
      appendAuditEvent(db, event);
    } catch (error) {
      failed.push({ event, error });
    }
  }
  return failed;
}

/** Deletes a tenant's audit rows older than the cutoff and records the prune in the same write scope, so neither lands
 * alone; returns the row count. */
export function pruneAuditRowsAt(db: DatabaseSyncLike, prune: AuditPrune): number {
  const { tenantId, cutoff, actor, olderThanDays } = prune;
  if (prune.dryRun) return countAuditBefore(db, tenantId, cutoff);
  return withWriteScope(db, 'audit_prune', () => {
    const count = deleteAuditBefore(db, tenantId, cutoff);
    // Written after the delete with ts = now, so the cutoff just applied cannot take it.
    appendAuditEvent(db, {
      tenantId,
      actor,
      op: 'audit_prune',
      metadata: { cutoff, count, dryRun: false, olderThanDays },
    });
    return count;
  });
}
