// Copies a hippo.db folder's rows into the tables memoryStore keeps, so a test seeds one folder the way it always
// has and runs the same calls on hippo.db and on the copy. A table it does not copy must be empty, or it throws.
import { closeHippoDb, openHippoDb, withSqliteAllowed, type DatabaseSyncLike } from '../../src/db/index.js';
import { loadPhysicsState } from '../../src/db/physics-state.js';
import type { SessionHandoffRow } from '../../src/base/session/handoff.js';
import type { FailureOutcome, RoutineRule } from '../../src/store/port/failure-log.js';
import type { QuarantineRow, QuarantineStatus } from '../../src/store/port/quarantine.js';
import type { RejectedValueRow } from '../../src/store/port/rejections.js';
import type { SlackWorkspace } from '../../src/store/port/connectors.js';
import { listAuditEventsAfter } from '../../src/store/sqlite/audit.js';
import { readApiKeyRecord } from '../../src/store/sqlite/auth.js';
import { readDormantSnapshot } from '../../src/store/sqlite/dormant-rows.js';
import { GOAL_COLUMNS, rowToGoal, type GoalRow } from '../../src/store/sqlite/goals.js';
import { ENTITY_COLS, RELATION_COLS, rowToEntity, rowToRelation } from '../../src/store/sqlite/graph-rows.js';
import type { EntityRow, RelationRow } from '../../src/store/sqlite/graph-rows.js';
import { HANDOFF_COLUMNS } from '../../src/store/sqlite/handoffs.js';
import { rowSpec, type RowByKind } from '../../src/store/sqlite/object-rows.js';
import {
  MEMORY_CONFLICT_COLUMNS,
  MEMORY_SELECT_COLUMNS,
  SESSION_EVENT_COLUMNS,
  TASK_SNAPSHOT_COLUMNS,
  rowToEntry,
  rowToMemoryConflict,
  rowToSessionEvent,
  rowToTaskSnapshot,
  type MemoryConflictRow,
  type MemoryRow,
  type SessionEventRow,
  type TaskSnapshotRow,
} from '../../src/store/sqlite/rows.js';
import type { ObjectKind } from '../../src/base/records/object-types.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { emptyTables, type MemoryTables } from '../../src/store/memory/tables.js';
import type {
  ArchivedRow,
  CompactionRecord,
  KeyRow,
  LoggedEvent,
  LoggedFailure,
  ParkedLetter,
  RepoRoute,
  SleepRun,
} from '../../src/store/memory/tables.js';

/** The tables memoryStore models that no test seeds before its other side is built. */
const NOT_COPIED = [
  'predictions',
  'cards',
  'card_deps',
  'card_runs',
  'card_comments',
  'working_memory',
  'session_owners',
  'retrieval_policy',
  'goal_recall_log',
  'token_ledger',
  'recall_traces',
] as const;

const OBJECT_KINDS = [
  'decision',
  'incident',
  'process',
  'policy',
  'skill',
  'project_brief',
  'customer_note',
] as const satisfies readonly ObjectKind[];

const key = (...parts: string[]): string => parts.join('\u0000');

/** Every row of a statement whose columns are aliased to T's fields. */
function rows<T>(db: DatabaseSyncLike, sql: string): T[] {
  // SAFETY: each caller's SELECT aliases its columns to the fields of T.
  return db.prepare(sql).all() as T[];
}

interface SqlKeyRow {
  id: number;
  keyId: string;
  keyHash: string;
  tenantId: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  role: string;
  expiresAt: string | null;
  ownerSubject: string | null;
}

const KEYS_SQL = `SELECT id, key_id AS keyId, key_hash AS keyHash, tenant_id AS tenantId, label, created_at AS createdAt,
  revoked_at AS revokedAt, role, expires_at AS expiresAt, owner_subject AS ownerSubject FROM api_keys ORDER BY id`;

function copyKeys(db: DatabaseSyncLike, t: MemoryTables): void {
  for (const row of rows<SqlKeyRow>(db, KEYS_SQL)) {
    const scopes = readApiKeyRecord(db, row.keyId)?.scopes ?? [];
    t.keys.set(row.keyId, { ...row, scopes } satisfies KeyRow);
  }
}

interface FailureSqlRow extends Omit<LoggedFailure, 'outcome' | 'rule'> {
  outcome: FailureOutcome;
  rule: RoutineRule | null;
}

const FAILURES_SQL = `SELECT id, ts, tenant_id AS tenantId, session_id AS sessionId, tool, outcome, skip_rule AS rule,
  sig_hash AS sigHash, detail_hash AS detailHash, owner_subject AS ownerSubject, origin_project AS originProject,
  request_id AS requestId FROM failure_log ORDER BY id`;

interface CompactionSqlRow extends Omit<CompactionRecord, 'snapshotSaved' | 'items'> {
  saved: number;
  itemsJson: string | null;
}

const COMPACTIONS_SQL = `SELECT tenant_id AS tenantId, id, session_id AS sessionId, origin_project AS originProject,
  started_at AS startedAt, snapshot_saved AS saved, status, items_json AS itemsJson, items_written AS itemsWritten,
  request_id AS requestId FROM compactions ORDER BY started_at, id`;

function copyLogs(db: DatabaseSyncLike, t: MemoryTables): void {
  t.failures = rows<FailureSqlRow>(db, FAILURES_SQL).map((row) => ({ ...row }));
  for (const { saved, itemsJson, ...row } of rows<CompactionSqlRow>(db, COMPACTIONS_SQL)) {
    const items: string[] = itemsJson === null ? [] : JSON.parse(itemsJson);
    t.compactions.push({ ...row, snapshotSaved: saved === 1, items });
  }
  t.sleepRuns.push(
    ...rows<SleepRun>(db, 'SELECT timestamp, decayed, merged, removed FROM consolidation_runs ORDER BY timestamp, id'),
  );
}

const REJECTED_SQL = `SELECT tenant_id AS tenantId, digest, reason, rejected_by AS rejectedBy, rejected_at AS rejectedAt,
  source_memory_id AS sourceMemoryId, normalized_chars AS normalizedChars FROM rejected_values`;
const ARCHIVE_SQL = `SELECT memory_id AS memoryId, archived_at AS archivedAt, reason, archived_by AS archivedBy
  FROM raw_archive ORDER BY id`;

interface QuarantineSqlRow extends Omit<QuarantineRow, 'status'> {
  status: QuarantineStatus;
}

const QUARANTINE_SQL = `SELECT tenant_id AS tenantId, memory_id AS memoryId, original_scope AS originalScope, reason,
  status, quarantined_at AS quarantinedAt, decided_at AS decidedAt, decided_by AS decidedBy FROM memory_quarantine`;

function copyEntries(db: DatabaseSyncLike, t: MemoryTables): void {
  // SAFETY: the SELECT names MEMORY_SELECT_COLUMNS, then updated_at; rowid order is the order rows went in.
  const memories = db
    .prepare(`SELECT ${MEMORY_SELECT_COLUMNS}, updated_at FROM memories ORDER BY rowid`)
    .all() as (MemoryRow & { updated_at: string })[];
  t.entries = new Map(memories.map((row) => [row.id, rowToEntry(row)]));
  for (const row of memories) t.updatedAt.set(row.id, row.updated_at);
  for (const row of rows<RejectedValueRow>(db, REJECTED_SQL)) t.rejected.set(key(row.tenantId, row.digest), row);
  t.rawArchive.push(...rows<ArchivedRow>(db, ARCHIVE_SQL));
  t.quarantine.push(...rows<QuarantineSqlRow>(db, QUARANTINE_SQL).map((row): QuarantineRow => ({ ...row })));
  const vectors = rows<{ id: string; model: string; vector: Uint8Array }>(
    db,
    'SELECT memory_id AS id, model, vector FROM memory_vectors',
  );
  for (const row of vectors) t.vectors.set(row.id, { model: row.model, bytes: new Uint8Array(row.vector) });
  for (const [id, particle] of loadPhysicsState(db)) t.particles.set(id, particle);
}

interface Keyed {
  tenant_id: string;
  owner_subject: string | null;
  origin_project: string | null;
}

function copySessions(db: DatabaseSyncLike, t: MemoryTables): void {
  const ownership = (row: Keyed) => ({ tenantId: row.tenant_id, owner: row.owner_subject, origin: row.origin_project });
  const keyed = 'tenant_id, owner_subject, origin_project';
  // SAFETY: each SELECT below names its row type's columns, then the three Keyed columns.
  const snapshots = db
    .prepare(`SELECT ${TASK_SNAPSHOT_COLUMNS}, ${keyed} FROM task_snapshots ORDER BY id`)
    .all() as (TaskSnapshotRow & Keyed)[];
  for (const row of snapshots) t.snapshots.push({ ...ownership(row), row: rowToTaskSnapshot(row) });
  // SAFETY: as above.
  const handoffs = db
    .prepare(`SELECT ${HANDOFF_COLUMNS}, ${keyed} FROM session_handoffs ORDER BY id`)
    .all() as (SessionHandoffRow & Keyed)[];
  for (const { tenant_id, owner_subject, origin_project, ...row } of handoffs) {
    t.handoffs.push({ ...ownership({ tenant_id, owner_subject, origin_project }), row });
  }
  // SAFETY: the SELECT names SESSION_EVENT_COLUMNS, then tenant_id.
  const events = db
    .prepare(`SELECT ${SESSION_EVENT_COLUMNS}, tenant_id FROM session_events ORDER BY id`)
    .all() as (SessionEventRow & { tenant_id: string })[];
  for (const row of events) t.events.push({ tenantId: row.tenant_id, row: rowToSessionEvent(row) });
  // SAFETY: the SELECT names GOAL_COLUMNS, GoalRow's columns.
  const goals = db.prepare(`SELECT ${GOAL_COLUMNS} FROM goal_stack ORDER BY rowid`).all() as GoalRow[];
  t.goals.push(...goals.map(rowToGoal));
  // SAFETY: the SELECT names MEMORY_CONFLICT_COLUMNS, MemoryConflictRow's columns.
  const conflicts = db
    .prepare(`SELECT ${MEMORY_CONFLICT_COLUMNS} FROM memory_conflicts ORDER BY id`)
    .all() as MemoryConflictRow[];
  t.conflicts.push(...conflicts.map(rowToMemoryConflict));
  for (const { tenantId, id } of rows<{ tenantId: string; id: string }>(
    db,
    'SELECT tenant_id AS tenantId, id FROM dormant_memories',
  )) {
    const snapshot = readDormantSnapshot(db, tenantId, id);
    if (snapshot) t.dormant.set(key(tenantId, id), snapshot);
  }
}

function copyObjectKind<K extends ObjectKind>(db: DatabaseSyncLike, t: MemoryTables, kind: K): void {
  const spec = rowSpec(kind);
  // SAFETY: the SELECT names spec.cols, exactly the columns of the kind's row.
  const found = db.prepare(`SELECT ${spec.cols} FROM ${spec.table} ORDER BY id`).all() as RowByKind[K][];
  const table = t.objects[kind];
  for (const row of found) {
    const object = spec.rowTo(row);
    table.set(object.id, object);
  }
}

function copyGraph(db: DatabaseSyncLike, t: MemoryTables): void {
  for (const kind of OBJECT_KINDS) copyObjectKind(db, t, kind);
  // SAFETY: each SELECT names exactly the columns of the row type it is read as.
  const entities = db.prepare(`SELECT ${ENTITY_COLS} FROM entities ORDER BY id`).all() as EntityRow[];
  t.entities.push(...entities.map(rowToEntity));
  // SAFETY: as above.
  const relations = db.prepare(`SELECT ${RELATION_COLS} FROM relations ORDER BY id`).all() as RelationRow[];
  t.relations.push(...relations.map(rowToRelation));
}

const EVENTS_SQL = `SELECT 'slack' AS connector, event_id AS eventKey, memory_id AS memoryId, NULL AS deliveryId,
    NULL AS eventName, ingested_at AS loggedAt FROM slack_event_log
  UNION ALL SELECT 'github', idempotency_key, memory_id, delivery_id, event_name, ingested_at FROM github_event_log`;
const LETTERS_SQL = `SELECT 'slack' AS connector, id, tenant_id AS tenantId, raw_payload AS rawPayload, error, bucket,
    signature, received_at AS receivedAt, team_id AS teamId, slack_timestamp AS slackTimestamp, NULL AS eventName,
    NULL AS deliveryId, NULL AS installationId, NULL AS repoFullName, retry_count AS retryCount, retried_at AS retriedAt
    FROM slack_dlq
  UNION ALL SELECT 'github', id, tenant_id, raw_payload, error, bucket, signature, received_at, NULL, NULL, event_name,
    delivery_id, installation_id, repo_full_name, retry_count, retried_at FROM github_dlq
  ORDER BY connector DESC, id`;
const CURSORS_SQL = `SELECT tenant_id AS tenantId, repo_full_name AS repo, issues_hwm AS issues,
  issue_comments_hwm AS issueComments, pr_review_comments_hwm AS prReviewComments FROM github_cursors`;
const REPOSITORIES_SQL = `SELECT repo_full_name AS repoFullName, tenant_id AS tenantId, added_at AS addedAt
  FROM github_repositories ORDER BY added_at, tenant_id`;

interface GithubCursorRow {
  tenantId: string;
  repo: string;
  issues: string | null;
  issueComments: string | null;
  prReviewComments: string | null;
}

function copyConnectors(db: DatabaseSyncLike, t: MemoryTables): void {
  for (const row of rows<LoggedEvent>(db, EVENTS_SQL)) t.connectorLog.set(key(row.connector, row.eventKey), row);
  t.deadLetters.push(...rows<ParkedLetter>(db, LETTERS_SQL));
  const workspaces = 'SELECT team_id AS teamId, tenant_id AS tenantId, added_at AS addedAt FROM slack_workspaces';
  for (const row of rows<SlackWorkspace>(db, workspaces)) t.slackWorkspaces.set(row.teamId, row);
  const slackCursors =
    'SELECT tenant_id AS tenantId, channel_id AS channelId, latest_ts AS latestTs FROM slack_cursors';
  for (const row of rows<{ tenantId: string; channelId: string; latestTs: string }>(db, slackCursors)) {
    t.slackCursors.set(key(row.tenantId, row.channelId), row.latestTs);
  }
  for (const { tenantId, repo, ...cursors } of rows<GithubCursorRow>(db, CURSORS_SQL)) {
    t.githubCursors.set(key(tenantId, repo), cursors);
  }
  const installations = 'SELECT installation_id AS id, tenant_id AS tenantId FROM github_installations';
  for (const row of rows<{ id: string; tenantId: string }>(db, installations)) {
    t.githubInstallations.set(row.id, row.tenantId);
  }
  t.githubRepositories.push(...rows<RepoRoute>(db, REPOSITORIES_SQL));
}

function copyStoreState(db: DatabaseSyncLike, t: MemoryTables): void {
  t.audit.push(...listAuditEventsAfter(db, { tenantId: ALL_TENANTS, afterId: 0, limit: 10_000 }));
  for (const row of rows<{ name: string; seq: number }>(db, 'SELECT name, seq FROM sqlite_sequence')) {
    t.seq.set(row.name, Number(row.seq));
  }
  for (const row of rows<{ key: string; value: string }>(db, 'SELECT key, value FROM meta')) {
    t.meta.set(row.key, row.value);
  }
}

function refuseUncopied(db: DatabaseSyncLike): void {
  for (const table of NOT_COPIED) {
    const [found] = rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`);
    if (Number(found?.n ?? 0) > 0) throw new Error(`loadTables does not copy ${table}; seed it through the port`);
  }
}

/** Every table of the hippo.db folder at `hippoRoot` that memoryStore models, as plain tables. */
export function loadTables(hippoRoot: string): MemoryTables {
  return withSqliteAllowed(() => {
    const db = openHippoDb(hippoRoot);
    try {
      refuseUncopied(db);
      const t = emptyTables();
      copyEntries(db, t);
      copyKeys(db, t);
      copyLogs(db, t);
      copySessions(db, t);
      copyGraph(db, t);
      copyConnectors(db, t);
      copyStoreState(db, t);
      return t;
    } finally {
      closeHippoDb(db);
    }
  });
}
