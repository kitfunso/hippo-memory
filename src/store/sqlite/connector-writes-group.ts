// hippo.db's half of the ConnectorWrites store group: a connector's write or archive with its companion rows, in one
// transaction on one handle.
import type { DatabaseSyncLike } from '../../db/index.js';
import { githubEventMemoryAt, markGitHubEventSeenAt } from '../connectors/github.js';
import { markSlackEventSeenAt, slackEventMemoryAt } from '../connectors/slack.js';
import type { OnHandle } from '../open.js';
import { openStore } from './handles.js';
import type { ConnectorEvent, ConnectorWrite, ConnectorWriteOutcome, ConnectorWrites, Sync } from '../port.js';
import { recordQuarantine } from '../quarantine.js';
import { stampOriginProjectIn } from '../entry-row.js';
import { writeEntryMirrorsIn } from '../entry-writes.js';
import { archiveRawAt, writeInOwnTenant } from './entry-writes-group.js';

/** Unwinds a write whose event key is already logged. Caught in this file, so no caller ever sees it. */
class EventAlreadyLogged extends Error {}

/** False when the key was logged before: the insert ignores a taken key, so the first writer's row stays. */
function logEvent(db: DatabaseSyncLike, event: ConnectorEvent, memoryId: string): boolean {
  if (event.connector === 'slack') return markSlackEventSeenAt(db, event.eventId, memoryId);
  const { idempotencyKey, deliveryId, eventName } = event;
  return markGitHubEventSeenAt(db, { idempotencyKey, deliveryId, eventName, memoryId });
}

function loggedMemory(db: DatabaseSyncLike, event: ConnectorEvent): string | null {
  return event.connector === 'slack'
    ? slackEventMemoryAt(db, event.eventId)
    : githubEventMemoryAt(db, event.idempotencyKey);
}

/** The record, then the log row, go in after the memory row and ahead of its remember row, as a second store must order
 * them. */
function writeWithCompanions(db: DatabaseSyncLike, { entry, actor, event, quarantine }: ConnectorWrite): void {
  writeInOwnTenant(db, entry, actor, (handle, memoryId) => {
    if (quarantine) {
      recordQuarantine(handle, {
        tenantId: entry.tenant_id,
        memoryId,
        originalScope: quarantine.originalScope,
        reason: quarantine.reason,
        actor,
      });
    }
    if (event && !logEvent(handle, event, memoryId)) throw new EventAlreadyLogged();
  });
}

function writeOnce(db: DatabaseSyncLike, write: ConnectorWrite): ConnectorWriteOutcome {
  try {
    writeWithCompanions(db, write);
    return { outcome: 'written' };
  } catch (err) {
    if (!(err instanceof EventAlreadyLogged) || !write.event) throw err;
    // The scope has unwound, so this reads the winner's committed row.
    return { outcome: 'duplicate', memoryId: loggedMemory(db, write.event) };
  }
}

/** Each call on its own handle; the mirror follows the commit, so a duplicate or a rolled-back write leaves none. */
export function sqliteConnectorWrites(on: OnHandle): Sync<ConnectorWrites> {
  return {
    writeConnectorEntry: (write) =>
      on((db, files) => {
        const entry = stampOriginProjectIn(files, write.entry);
        const result = writeOnce(db, { ...write, entry });
        if (result.outcome === 'written') writeEntryMirrorsIn(files, entry);
        return result;
      }, openStore),
    // The log write's answer is unread: a key logged before keeps its row and the archive stands.
    archiveConnectorEntry: (archive) =>
      on((db, files) =>
        archiveRawAt(db, files, archive, (handle, archivedId) => {
          logEvent(handle, archive.event, archivedId);
        }),
      ),
  };
}
