// The event-log statements both connectors share; each connector names its table, key column and extra columns.

import type { DatabaseSyncLike } from '../../db/index.js';
import type { ConnectorEventRecord } from '../port.js';
import { placeholders } from '../../util/sql.js';
import { onHandle } from '../open.js';

/** Which log table a connector writes and the column its dedupe key lives in. */
export interface EventLogSpec {
  readonly table: 'slack_event_log' | 'github_event_log';
  readonly keyColumn: 'event_id' | 'idempotency_key';
}

export function eventSeenAt(db: DatabaseSyncLike, log: EventLogSpec, key: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${log.table} WHERE ${log.keyColumn} = ?`).get(key);
}

export function eventMemoryAt(db: DatabaseSyncLike, log: EventLogSpec, key: string): string | null {
  // SAFETY: the SELECT projects only `memory_id`, a nullable column; .get() returns undefined when no row matches.
  const row = db.prepare(`SELECT memory_id FROM ${log.table} WHERE ${log.keyColumn} = ?`).get(key) as
    | { memory_id: string | null }
    | undefined;
  return row?.memory_id ?? null;
}

/** Records the key unless a row holds it already; false means another writer got there first. `extra` pairs connector-only columns with values. */
export function markEventSeenAt(
  db: DatabaseSyncLike,
  log: EventLogSpec,
  key: string,
  extra: ReadonlyArray<readonly [string, string]>,
  memoryId: string | null,
): boolean {
  const names = [log.keyColumn, ...extra.map(([name]) => name), 'ingested_at', 'memory_id'];
  const values = [key, ...extra.map(([, value]) => value), new Date().toISOString(), memoryId];
  const inserted = db
    .prepare(`INSERT OR IGNORE INTO ${log.table} (${names.join(', ')}) VALUES (${placeholders(names.length)})`)
    .run(...values);
  return Number(inserted.changes ?? 0) !== 0;
}

export function eventRecord(hippoRoot: string, log: EventLogSpec, key: string): ConnectorEventRecord {
  return onHandle(hippoRoot, (db): ConnectorEventRecord =>
    eventSeenAt(db, log, key) ? { seen: true, memoryId: eventMemoryAt(db, log, key) } : { seen: false });
}
