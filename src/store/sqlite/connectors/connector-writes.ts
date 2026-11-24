// hippo.db's half of the ConnectorWrites store group: a write, archive or held supersede with its
// companion rows, in one transaction on one handle.
import type { DatabaseSyncLike } from '../../../db/index.js';
import { logEvent, loggedMemory } from './events.js';
import type { Handles, StoreFiles } from '../runtime/open.js';
import { bound } from '../runtime/bound.js';
import { openStore } from '../runtime/handles.js';
import type {
  ConnectorArchive,
  ConnectorWrite,
  ConnectorWriteOutcome,
  ConnectorWrites,
  HeldSupersede,
} from '../../../base/ports/store.js';
import { recordQuarantine } from './quarantine.js';
import { stampOriginProject } from '../entries/entry-row.js';
import {
  writeEntryMirrors,
  archiveRaw,
  commitSupersede,
  writeInOwnTenant,
} from '../entries/entry-writes.js';

/** Unwinds a write whose event key is already logged. Caught in this file, so no caller ever
 * sees it. */
class EventAlreadyLogged extends Error {}

/** The record, then the log row, go in after the memory row and ahead of its remember row, as a
 * second store must order them. */
function writeWithCompanions(
  db: DatabaseSyncLike,
  { entry, actor, event, quarantine }: ConnectorWrite,
): void {
  writeInOwnTenant(db, entry, actor, (handle, memoryId) => {
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

/** supersede with the successor's record and quarantine row in its scope; the mirror follows the commit. */
function supersedeHeld(db: DatabaseSyncLike, files: StoreFiles, write: HeldSupersede): void {
  const successor = stampOriginProject(files, write.successor);
  const { tenantId, actor, quarantine } = write;
  commitSupersede(db, { ...write, successor }, (handle, memoryId) => {
    recordQuarantine(handle, { tenantId, memoryId, actor, ...quarantine });
  });
  writeEntryMirrors(files.hippoRoot, successor);
}

/** Each call on its own handle; the mirror follows the commit, so a duplicate or a rolled-back
 * write leaves none. */
export function sqliteConnectorWrites({ on, files }: Handles): ConnectorWrites {
  return {
    ...bound<Pick<ConnectorWrites, 'writeConnectorEntry'>>(
      on,
      {
        writeConnectorEntry: (db, write) => {
          const entry = stampOriginProject(files, write.entry);
          const result = writeOnce(db, { ...write, entry });
          if (result.outcome === 'written') writeEntryMirrors(files.hippoRoot, entry);
          return result;
        },
      },
      openStore,
    ),
    ...bound<Pick<ConnectorWrites, 'archiveConnectorEntry' | 'supersedeHeld'>>(on, {
      archiveConnectorEntry: (db, ...args) => archiveConnectorEntry(db, files, ...args),
      supersedeHeld: (db, write) => supersedeHeld(db, files, write),
    }),
  };
}
