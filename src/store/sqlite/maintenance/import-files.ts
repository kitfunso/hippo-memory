// The port calls the published importers make on hippo.db, kept synchronous because those importers
// return their result rather than a Promise.
import type { EntryWrite } from '../../../base/ports/store/entry-writes.js';
import type { EntryFilter } from '../../../base/records/reports.js';
import type { RejectionCheck } from '../../../base/records/rejections.js';
import type { EntryTextKey } from '../../../base/records/sharing.js';
import { listTextKeysHolding } from '../sharing/copy-rows.js';
import { writeEntryInOwnTx } from '../entries/entry-writes.js';
import type { SqliteStoreOptions } from '../runtime/grant.js';
import { handlesOf, openStore } from '../runtime/handles.js';
import { inPortTerms } from '../runtime/port-errors.js';
import { refusedAmong } from '../review/rejections.js';

/** The FolderFiles, EntryWrites, Rejections and Sharing calls an import makes, each answered
 * at once. */
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
      inPortTerms(() =>
        on((db) => writeEntryInOwnTx(db, files, write.entry, { actor: write.actor }), openStore),
      ),
    refusedAmong: (checks) => inPortTerms(() => on((db) => refusedAmong(db, checks))),
    textKeysHolding: (filter, texts) =>
      inPortTerms(() => on((db) => listTextKeysHolding(db, filter, texts), openStore)),
  };
}
