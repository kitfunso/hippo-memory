// The store share and sync down read, and its text keys a page at a time, so no one read returns
// every row.
import type { EntryTextKey, Sharing, HippoStore } from '../../base/ports/store.js';
import type { TenantId } from '../../base/util/tenant.js';
import type { EntryCursor } from '../../base/ports/store/types.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';
import type { LessonWrites } from '../../base/ports/store/entry-writes.js';
import type { FolderFiles } from '../../base/ports/store/folder-files.js';
import type { Rejections } from '../../base/ports/store/rejections.js';

/** A store with sharing reads and the facts of its folder, as share, peers, sync down and the
 * two-store search need. */
export type SharingStore = HippoStore & {
  readonly hippoDb: {
    readonly sharing: Sharing;
    readonly folderFiles: FolderFiles;
    readonly lessonWrites: LessonWrites;
    readonly rejections: Rejections;
  };
};

/** The text keys of `tenantId`, a page at a time, oldest first. */
export async function* textKeyPages(
  sharing: Sharing,
  tenantId: TenantId,
): AsyncGenerator<EntryTextKey[]> {
  let after: EntryCursor | null = null;
  do {
    const page = await sharing.textKeysPage(tenantId, {
      limit: READ_PAGE_ROWS,
      after: after ?? undefined,
    });
    yield page.keys;
    after = page.next;
  } while (after !== null);
}
