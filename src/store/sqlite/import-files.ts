// The port calls the published importers make on hippo.db, kept synchronous because those importers
// return their result rather than a Promise.
import type { EntryWrite } from '../../base/ports/store/entry-writes.js';
import type { EntryFilter } from '../../base/ports/store/reports.js';
import type { RejectionCheck } from '../../base/ports/store/rejections.js';
import type { EntryTextKey } from '../../base/ports/store/sharing.js';
import { listTextKeysHolding } from './copy-rows.js';
import { writeEntryRow } from './entry-writes.js';
import type { SqliteStoreOptions } from './grant.js';
import { handlesOf, openStore } from './handles.js';
import { inPortTerms } from './port-errors.js';
import { refusedAmong } from './rejections.js';

/** The FolderFiles, EntryWrites, Rejections and Sharing calls an import makes, each answered at
 * once. */
interface SqliteImportFiles {
  ensure(): void;
  writeEntry(write: EntryWrite): void;
  refusedAmong(checks: readonly RejectionCheck[]): boolean[];
  textKeysHolding(filter: EntryFilter, texts: readonly string[]): EntryTextKey[];
}

/** hippo.db under `hippoRoot` as an import reaches it, each call on its own short-lived handle
 * and each throw in the port's terms, as a store's rejection would be. */
export function sqliteImportFiles(
  hippoRoot: string,
  opts: SqliteStoreOptions = {},
): SqliteImportFiles {
  const { on, files } = handlesOf(hippoRoot, opts);
  return {
    ensure: () => inPortTerms(() => on(() => undefined, openStore)),
    writeEntry: (write) =>
      inPortTerms(() => on((db) => writeEntryRow(db, files, write), openStore)),
    refusedAmong: (checks) => inPortTerms(() => on((db) => refusedAmong(db, checks))),
    textKeysHolding: (filter, texts) =>
      inPortTerms(() => on((db) => listTextKeysHolding(db, filter, texts), openStore)),
  };
}
