// A store's text keys a page at a time, so no one read returns every row.
import type { EntryCursor } from '../store/port/consolidation.js';
import type { EntryTextKey, Sharing } from '../store/port/sharing.js';

const TEXT_KEY_PAGE_ROWS = 500;

/** The text keys of `tenantId`, or of every tenant when it is undefined, oldest first. */
export function* eachTextKey(sharing: Sharing, tenantId: string | undefined): Generator<EntryTextKey> {
  let after: EntryCursor | null = null;
  do {
    const page = sharing.textKeysPage(tenantId, { limit: TEXT_KEY_PAGE_ROWS, after: after ?? undefined });
    yield* page.keys;
    after = page.next;
  } while (after !== null);
}
