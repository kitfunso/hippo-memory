// What only hippo.db does: operations no port method covers, so they never run on another store.
import type { ArchiveOpts } from '../../raw-archive.js';
import { changeScopeGrantAt, type ScopeGrantChange } from '../key-writes.js';
import { onHandle } from '../open.js';
import type { RawArchive } from '../port.js';
import { archiveRawAt } from './entry-writes-group.js';

/** The port's writes with an option that needs hippo.db's own handle, so no served store can run them. */
export interface SqliteLocal {
  /** entryWrites.archiveRaw with a connector's hook, which writes on the archive's handle inside its write scope. */
  archiveRaw(archive: RawArchive, afterArchive: NonNullable<ArchiveOpts['afterArchive']>): string;
}

export function sqliteLocal(hippoRoot: string): SqliteLocal {
  return {
    archiveRaw: (archive, afterArchive) => archiveRawAt(hippoRoot, archive, afterArchive),
  };
}

/** What a served store hands a body in place of SqliteLocal: each operation is refused. */
export const NO_LOCAL: SqliteLocal = {
  archiveRaw() {
    throw new Error('afterArchive runs on hippo.db only, never through a store');
  },
};

/** Off the port: only the local CLI changes grants, through synchronous published functions a store's Promise cannot answer. */
export function changeScopeGrant(hippoRoot: string, change: ScopeGrantChange): void {
  onHandle(hippoRoot, (db) => changeScopeGrantAt(db, change));
}
