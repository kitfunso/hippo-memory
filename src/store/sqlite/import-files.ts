// The port calls the published importers make on hippo.db, kept synchronous because those importers return their
// result rather than a Promise.
import type { TenantId } from '../../base/util/tenant.js';
import type { EntryWrite } from '../port/entry-writes.js';
import type { RejectionCheck } from '../port/rejections.js';
import type { EntryTextKey } from '../port/sharing.js';
import { selectTextKeysHolding } from './entry-reads.js';
import { writeEntryRow } from './entry-writes.js';
import { handlesOf, openStore } from './handles.js';
import { inPortTerms } from './port-errors.js';
import { refusedAmong } from './rejections.js';

/** The FolderFiles, EntryWrites, Rejections and Sharing calls an import makes, each answered at once. */
interface SqliteImportFiles {
  ensure(): void;
  writeEntry(write: EntryWrite): void;
  refusedAmong(checks: readonly RejectionCheck[]): boolean[];
  textKeysHolding(tenantId: TenantId, texts: readonly string[]): EntryTextKey[];
}

/** hippo.db under `hippoRoot` as an import reaches it, each call on its own short-lived handle and each throw in the
 * port's terms, as a store's rejection would be. */
export function sqliteImportFiles(hippoRoot: string): SqliteImportFiles {
  const { on, files } = handlesOf(hippoRoot);
  return {
    ensure: () => inPortTerms(() => on(() => undefined, openStore)),
    writeEntry: (write) => inPortTerms(() => on((db) => writeEntryRow(db, files, write), openStore)),
    refusedAmong: (checks) => inPortTerms(() => on((db) => refusedAmong(db, checks))),
    textKeysHolding: (tenantId, texts) =>
      inPortTerms(() => on((db) => selectTextKeysHolding(db, tenantId, texts), openStore)),
  };
}
