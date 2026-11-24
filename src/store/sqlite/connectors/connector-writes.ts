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

class EventAlreadyLogged extends Error {}

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
    return { outcome: 'duplicate', memoryId: loggedMemory(db, write.event) };
  }
}

function archiveConnectorEntry(
  db: DatabaseSyncLike,
  files: StoreFiles,
  archive: ConnectorArchive,
): string {
  return archiveRaw(db, files, archive, (handle, archivedId) => {
    logEvent(handle, archive.event, archivedId);
  });
}

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
