// hippo.db's half of the ConnectorWrites store group: a connector's write or archive with its
// companion rows, in one transaction on one handle.
import type { DatabaseSyncLike } from '../../../db/index.js';
import { logEvent, loggedMemory } from './events.js';
import type { Handles, StoreFiles } from '../runtime/open.js';
import { bound, type Bodies } from '../runtime/bound.js';
import { openStore } from '../runtime/handles.js';
import type {
  ConnectorArchive,
  ConnectorWrite,
  ConnectorWriteOutcome,
  ConnectorWrites,
} from '../../../base/records/connectors.js';
import { recordQuarantine } from './quarantine.js';
import { writeEntryInOwnTx } from '../entries/entry-writes.js';
import { archiveRaw } from '../entries/sqlite-entry-writes.js';

/** Unwinds a write whose event key is already logged. Caught in this file, so no caller ever
 * sees it. */
class EventAlreadyLogged extends Error {}

/** The record, then the log row, go in after the memory row and ahead of its remember row, as a
 * second store must order them. */
function writeWithCompanions(
  db: DatabaseSyncLike,
  files: StoreFiles,
  { entry, actor, event, quarantine }: ConnectorWrite,
): void {
  const afterWrite = (handle: DatabaseSyncLike, memoryId: string): void => {
    if (quarantine) {
      recordQuarantine(handle, {
        tenantId: entry.tenantId,
        memoryId,
        originalScope: quarantine.originalScope,
        reason: quarantine.reason,
        actor,
      });
    }
    if (event && !logEvent(handle, event, memoryId)) throw new EventAlreadyLogged();
  };
  writeEntryInOwnTx(db, files, entry, { actor, afterWrite });
}

function writeOnce(
  db: DatabaseSyncLike,
  files: StoreFiles,
  write: ConnectorWrite,
): ConnectorWriteOutcome {
  try {
    writeWithCompanions(db, files, write);
    return { outcome: 'written' };
  } catch (err) {
    if (!(err instanceof EventAlreadyLogged) || !write.event) throw err;
    // The scope has unwound, so this reads the winner's committed row.
    return { outcome: 'duplicate', memoryId: loggedMemory(db, write.event) };
  }
}

/** archiveRaw with the event logged in its write; the log write's answer is unread: a key logged
 * before keeps its row and the archive stands. */
function archiveConnectorEntry(
  db: DatabaseSyncLike,
  files: StoreFiles,
  archive: ConnectorArchive,
): string {
  return archiveRaw(db, files, archive, (handle, archivedId) => {
    logEvent(handle, archive.event, archivedId);
  });
}

/** Each call on its own handle; the mirror follows the commit, so a duplicate or a rolled-back
 * write leaves none. */
export function sqliteConnectorWrites({ on, files }: Handles): ConnectorWrites {
  return {
    ...bound(
      on,
      {
        writeConnectorEntry: (db, write) => writeOnce(db, files, write),
      } satisfies Bodies<Pick<ConnectorWrites, 'writeConnectorEntry'>>,
      openStore,
    ),
    ...bound(on, {
      archiveConnectorEntry: (db, ...args) => archiveConnectorEntry(db, files, ...args),
    } satisfies Bodies<Pick<ConnectorWrites, 'archiveConnectorEntry'>>),
  };
}
