// hippo.db's side of the connector conformance tests: its store with reads of the event logs, quarantine records
// and dead-letter queues straight from their tables, the same reads memorySide answers from its own.
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import type { LoggedEvent, ParkedLetter } from '../../src/store/memory/tables.js';
import { listAuditEventsAfter } from '../../src/store/sqlite/audit.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { StoreSide } from './store-conformance.js';

/** One quarantine record, without the decision columns. */
export interface HeldRecord {
  readonly tenantId: string;
  readonly memoryId: string;
  readonly originalScope: string | null;
  readonly reason: string;
  readonly status: string;
  readonly quarantinedAt: string;
}

/** A store under test with reads of both event logs, Slack's first, and of the quarantine records, oldest first. */
export interface ConnectorSide extends StoreSide {
  readonly events: () => readonly LoggedEvent[];
  readonly records: () => readonly HeldRecord[];
}

/** A connector side with a read of both dead-letter queues, Slack's first, each oldest first. */
export interface ConnectorEventsSide extends ConnectorSide {
  readonly letters: () => readonly ParkedLetter[];
}

const EVENTS_SQL = `SELECT 'slack' AS connector, event_id AS eventKey, memory_id AS memoryId, NULL AS deliveryId, NULL AS eventName, ingested_at AS loggedAt FROM slack_event_log
  UNION ALL SELECT 'github', idempotency_key, memory_id, delivery_id, event_name, ingested_at FROM github_event_log ORDER BY connector DESC, eventKey`;
const RECORDS_SQL = `SELECT tenant_id AS tenantId, memory_id AS memoryId, original_scope AS originalScope, reason, status, quarantined_at AS quarantinedAt
  FROM memory_quarantine ORDER BY quarantined_at, memory_id`;
const LETTERS_SQL = `SELECT 'slack' AS connector, id, tenant_id AS tenantId, raw_payload AS rawPayload, error, bucket, signature, received_at AS receivedAt,
    team_id AS teamId, slack_timestamp AS slackTimestamp, NULL AS eventName, NULL AS deliveryId, NULL AS installationId, NULL AS repoFullName,
    retry_count AS retryCount, retried_at AS retriedAt FROM slack_dlq
  UNION ALL SELECT 'github', id, tenant_id, raw_payload, error, bucket, signature, received_at, NULL, NULL, event_name, delivery_id, installation_id, repo_full_name,
    retry_count, retried_at FROM github_dlq
  ORDER BY connector DESC, id`;

function onDb<T>(hippoRoot: string, read: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(hippoRoot);
  try {
    return read(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Every row of a statement that names its row type's columns under their field names. */
export function rowsOf<T>(hippoRoot: string, sql: string): T[] {
  // SAFETY: the caller's statement aliases each column to a field of T.
  return onDb(hippoRoot, (db) => db.prepare(sql).all() as T[]).map((row) => ({ ...row }));
}

/** hippo.db's store with the same reads, straight from its tables. */
export function sqliteConnectorSide(hippoRoot: string): ConnectorSide {
  return {
    store: sqliteStore(hippoRoot),
    auditRows: () =>
      onDb(hippoRoot, (db) => listAuditEventsAfter(db, { tenantId: ALL_TENANTS, afterId: 0, limit: 10_000 })),
    events: () => rowsOf<LoggedEvent>(hippoRoot, EVENTS_SQL),
    records: () => rowsOf<HeldRecord>(hippoRoot, RECORDS_SQL),
  };
}

export function sqliteConnectorEventsSide(hippoRoot: string): ConnectorEventsSide {
  return { ...sqliteConnectorSide(hippoRoot), letters: () => rowsOf<ParkedLetter>(hippoRoot, LETTERS_SQL) };
}
