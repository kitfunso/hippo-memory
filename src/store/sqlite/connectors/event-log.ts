// The event-log statements both connectors share; each connector names its table, key column and
// extra columns.

import { changedRows, type DatabaseSyncLike } from '../../../db/index.js';
import { placeholders } from '../../../db/sql.js';
import type { ConnectorEventRecord } from '../../../base/records/connectors.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { handleStamp } from '../runtime/handle-clock.js';

/** Which log table a connector writes and the column its dedupe key lives in. */
export interface EventLogSpec {
  readonly table: 'slack_event_log' | 'github_event_log';
  readonly keyColumn: 'event_id' | 'idempotency_key';
}

export function eventSeen(db: DatabaseSyncLike, log: EventLogSpec, key: string): boolean {
  return !!cachedStatement(db, `SELECT 1 FROM ${log.table} WHERE ${log.keyColumn} = ?`).get(key);
}

export function eventMemory(db: DatabaseSyncLike, log: EventLogSpec, key: string): string | null {
  const row = cachedStatement(
    db,
    `SELECT memory_id FROM ${log.table} WHERE ${log.keyColumn} = ?`,
  ).get(key) as { memory_id: string | null } | undefined;
  return row?.memory_id ?? null;
}

export interface MarkEventSeenOptions {
  readonly log: EventLogSpec;
  readonly key: string;
  readonly extra: ReadonlyArray<readonly [string, string]>;
  readonly memoryId: string | null;
}

/** Records the key unless a row holds it already; false means another writer got there first.
 * `extra` pairs connector-only columns with values. */
export function markEventSeen(
  db: DatabaseSyncLike,
  { log, key, extra, memoryId }: MarkEventSeenOptions,
): boolean {
  const names = [log.keyColumn, ...extra.map(([name]) => name), 'ingested_at', 'memory_id'];
  const values = [key, ...extra.map(([, value]) => value), handleStamp(db), memoryId];
  const inserted = cachedStatement(
    db,
    `INSERT OR IGNORE INTO ${log.table} (${names.join(', ')}) VALUES (${placeholders(names.length)})`,
  ).run(...values);
  return changedRows(inserted) > 0;
}

export function eventRecord(
  db: DatabaseSyncLike,
  log: EventLogSpec,
  key: string,
): ConnectorEventRecord {
  return eventSeen(db, log, key)
    ? { seen: true, memoryId: eventMemory(db, log, key) }
    : { seen: false };
}
