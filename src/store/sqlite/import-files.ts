// The port calls the published importers make on hippo.db, kept synchronous because those importers return their
// result rather than a Promise.
import type { EntryWrites } from '../port/entry-writes.js';
import type { FolderFiles } from '../port/folder-files.js';
import type { Rejections } from '../port/rejections.js';
import type { Sharing } from '../port/sharing.js';
import { sqliteEntryWrites } from './entry-writes.js';
import { sqliteFolderFiles } from './folder-files.js';
import { handlesOf } from './handles.js';
import { sqliteRefusedAmong } from './rejections.js';
import type { Sync } from './served.js';
import { sqliteImportKeys } from './sharing.js';

export type SqliteImportFiles = Sync<
  Pick<FolderFiles, 'ensure'> &
    Pick<EntryWrites, 'writeEntry'> &
    Pick<Rejections, 'refusedAmong'> &
    Pick<Sharing, 'textKeysHolding'>
>;

/** hippo.db under `hippoRoot` as an import reaches it, each call on its own short-lived handle. */
export function sqliteImportFiles(hippoRoot: string): SqliteImportFiles {
  const handles = handlesOf(hippoRoot);
  const { on } = handles;
  return {
    ensure: sqliteFolderFiles(handles).ensure,
    writeEntry: sqliteEntryWrites(on).writeEntry,
    refusedAmong: sqliteRefusedAmong(on).refusedAmong,
    textKeysHolding: sqliteImportKeys(on).textKeysHolding,
  };
}
