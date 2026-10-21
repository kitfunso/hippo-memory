// The in-memory ConnectorWrites group: the entry, its quarantine record and its event log row land in one staged write.
import type { ConnectorEvent, ConnectorWrites, ConnectorWrite, ConnectorWriteOutcome } from '../port/connectors.js';
import { archiveOne, put, stage } from './staged.js';
import type { LoggedEvent, MemoryTables } from './tables.js';

/** Drops a staged write whose event key is already logged. */
class AlreadyLogged extends Error {}

const eventKeyOf = (event: ConnectorEvent): string =>
  event.connector === 'slack' ? event.eventId : event.idempotencyKey;

/** One key space per connector, as hippo.db keeps one log table for each. */
export const eventSlot = (event: ConnectorEvent): string => `${event.connector}\u0000${eventKeyOf(event)}`;

function logRow(event: ConnectorEvent, memoryId: string | null): LoggedEvent {
  const github = event.connector === 'github' ? event : null;
  return {
    connector: event.connector,
    eventKey: eventKeyOf(event),
    memoryId,
    deliveryId: github?.deliveryId ?? null,
    eventName: github?.eventName ?? null,
    loggedAt: new Date().toISOString(),
  };
}

/** Logs the event unless its key already has a row, which then stays as it is. */
export function logOnce(t: MemoryTables, event: ConnectorEvent, memoryId: string | null): void {
  if (!t.connectorLog.has(eventSlot(event))) t.connectorLog.set(eventSlot(event), logRow(event, memoryId));
}

function writeIn(t: MemoryTables, { entry, actor, event, quarantine }: ConnectorWrite): ConnectorWriteOutcome {
  try {
    stage(t, actor, (tx) => {
      const rememberAt = tx.audit.length;
      put(t, tx, entry, actor);
      if (event && t.connectorLog.has(eventSlot(event))) throw new AlreadyLogged();
      // Nothing below throws, so the record and the log row land exactly when the staged entry does.
      if (quarantine) {
        const { originalScope, reason } = quarantine;
        const metadata = { reason, originalScope };
        tx.audit.splice(rememberAt, 0, {
          tenantId: entry.tenantId,
          actor,
          op: 'quarantine',
          targetId: entry.id,
          metadata,
        });
        const quarantinedAt = new Date().toISOString();
        const record = { tenantId: entry.tenantId, memoryId: entry.id, originalScope, reason, quarantinedAt };
        t.quarantine.push({ ...record, status: 'pending', decidedAt: null, decidedBy: null });
      }
      if (event) t.connectorLog.set(eventSlot(event), logRow(event, entry.id));
    });
    return { outcome: 'written' };
  } catch (err) {
    if (!(err instanceof AlreadyLogged) || !event) throw err;
    return { outcome: 'duplicate', memoryId: t.connectorLog.get(eventSlot(event))?.memoryId ?? null };
  }
}

export function memoryConnectorWrites(t: MemoryTables): ConnectorWrites {
  return {
    writeConnectorEntry: async (write) => writeIn(t, write),
    archiveConnectorEntry: async ({ event, ...archive }) => archiveOne(t, archive, () => logOnce(t, event, archive.id)),
  };
}
