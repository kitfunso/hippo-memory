// A store other than hippo.db for the ConnectorWrites group, built on the in-memory entry-writes store: it copies the event logs and
// the quarantine records out of hippo.db once, then keeps both in memory and lands them exactly when the staged entry does.
import { listAuditEventsAfter } from '../../src/audit.js';
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import type { EntryWrites, HippoStore } from '../../src/server.js';
import { sqliteStore } from '../../src/store-port.js';
import type { ConnectorEvent, ConnectorWrites } from '../../src/store/port.js';
import { inMemoryEntryWritesStore } from './in-memory-entry-writes-store.js';
import type { StoreSide } from './store-conformance.js';

/** One event log row; the delivery id and event name are GitHub's and null for Slack. */
export interface LoggedEvent {
  readonly connector: ConnectorEvent['connector'];
  readonly eventKey: string;
  readonly memoryId: string | null;
  readonly deliveryId: string | null;
  readonly eventName: string | null;
  readonly loggedAt: string;
}

export interface HeldRecord {
  readonly tenantId: string;
  readonly memoryId: string;
  readonly originalScope: string | null;
  readonly reason: string;
  readonly status: string;
  readonly quarantinedAt: string;
}

/** A store under test with reads of the rows a connector write adds beside the entry: events by connector then key, records oldest first. */
export interface ConnectorSide extends StoreSide {
  readonly events: () => readonly LoggedEvent[];
  readonly records: () => readonly HeldRecord[];
}

export interface InMemoryConnectorWritesStore extends ConnectorSide {
  readonly store: HippoStore & { readonly entryWrites: EntryWrites; readonly connectorWrites: ConnectorWrites };
  readonly forgotten: () => number;
}

const EVENTS_SQL = `SELECT 'slack' AS connector, event_id AS eventKey, memory_id AS memoryId, NULL AS deliveryId, NULL AS eventName, ingested_at AS loggedAt FROM slack_event_log
  UNION ALL SELECT 'github', idempotency_key, memory_id, delivery_id, event_name, ingested_at FROM github_event_log ORDER BY connector DESC, eventKey`;
const RECORDS_SQL = `SELECT tenant_id AS tenantId, memory_id AS memoryId, original_scope AS originalScope, reason, status, quarantined_at AS quarantinedAt
  FROM memory_quarantine ORDER BY quarantined_at, memory_id`;

function onDb<T>(hippoRoot: string, read: (db: ReturnType<typeof openHippoDb>) => T): T {
  const db = openHippoDb(hippoRoot);
  try {
    return read(db);
  } finally {
    closeHippoDb(db);
  }
}

function rowsOf<T>(hippoRoot: string, sql: string): T[] {
  // SAFETY: each of the two statements above names its row type's six columns under their field names.
  return onDb(hippoRoot, (db) => db.prepare(sql).all() as T[]).map((row) => ({ ...row }));
}

const eventsAt = (hippoRoot: string): LoggedEvent[] => rowsOf<LoggedEvent>(hippoRoot, EVENTS_SQL);
const recordsAt = (hippoRoot: string): HeldRecord[] => rowsOf<HeldRecord>(hippoRoot, RECORDS_SQL);

/** hippo.db's store with the same reads, straight from its tables. */
export function sqliteConnectorSide(hippoRoot: string): ConnectorSide {
  return {
    store: sqliteStore(hippoRoot),
    auditRows: () => onDb(hippoRoot, (db) => listAuditEventsAfter(db, { afterId: 0, limit: 10_000 })),
    events: () => eventsAt(hippoRoot),
    records: () => recordsAt(hippoRoot),
  };
}

/** Drops a staged write whose event key is already logged. */
class AlreadyLogged extends Error {}

const eventKeyOf = (event: ConnectorEvent): string => (event.connector === 'slack' ? event.eventId : event.idempotencyKey);
/** One key space per connector, as hippo.db keeps one log table for each. */
const slotOf = (connector: string, eventKey: string): string => `${connector}\u0000${eventKey}`;

function logRow(event: ConnectorEvent, memoryId: string): LoggedEvent {
  const github = event.connector === 'github' ? event : null;
  return {
    connector: event.connector, eventKey: eventKeyOf(event), memoryId,
    deliveryId: github?.deliveryId ?? null, eventName: github?.eventName ?? null, loggedAt: new Date().toISOString(),
  };
}

/** Byte order, as hippo.db compares text. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const slackFirst = (a: LoggedEvent, b: LoggedEvent): number => (a.connector === b.connector ? byBytes(a.eventKey, b.eventKey) : a.connector === 'slack' ? -1 : 1);
const oldestFirst = (a: HeldRecord, b: HeldRecord): number => byBytes(a.quarantinedAt, b.quarantinedAt) || byBytes(a.memoryId, b.memoryId);

export function inMemoryConnectorWritesStore(hippoRoot: string): InMemoryConnectorWritesStore {
  const base = inMemoryEntryWritesStore(hippoRoot);
  const events = new Map(eventsAt(hippoRoot).map((row): [string, LoggedEvent] => [slotOf(row.connector, row.eventKey), row]));
  const records = recordsAt(hippoRoot);
  const slot = (event: ConnectorEvent): string => slotOf(event.connector, eventKeyOf(event));

  const connectorWrites: ConnectorWrites = {
    async writeConnectorEntry({ entry, actor, event, quarantine }) {
      try {
        await base.writeWith({ entry, actor }, (tx, rememberAt) => {
          if (event && events.has(slot(event))) throw new AlreadyLogged();
          // Nothing below throws, so the record and the log row land exactly when the staged entry does.
          if (quarantine) {
            const { originalScope, reason } = quarantine;
            tx.audit.splice(rememberAt, 0, { tenantId: entry.tenantId, actor, op: 'quarantine', targetId: entry.id, metadata: { reason, originalScope } });
            records.push({ tenantId: entry.tenantId, memoryId: entry.id, originalScope, reason, status: 'pending', quarantinedAt: new Date().toISOString() });
          }
          if (event) events.set(slot(event), logRow(event, entry.id));
        });
        return { outcome: 'written' };
      } catch (err) {
        if (!(err instanceof AlreadyLogged) || !event) throw err;
        return { outcome: 'duplicate', memoryId: events.get(slot(event))?.memoryId ?? null };
      }
    },
    async archiveConnectorEntry({ event, ...archive }) {
      return base.archiveWith(archive, () => {
        if (!events.has(slot(event))) events.set(slot(event), logRow(event, archive.id));
      });
    },
  };

  return {
    store: { ...base.store, connectorWrites },
    auditRows: base.auditRows,
    events: () => [...events.values()].sort(slackFirst),
    records: () => structuredClone(records).sort(oldestFirst),
    forgotten: base.forgotten,
  };
}
