// A store's text keys a page at a time, so no one read returns every row.
import type { EntryCursor } from '../store/port/consolidation.js';
import type { EntryTextKey, Sharing } from '../store/port/sharing.js';
import type { TenantId } from '../util/tenant.js';

const TEXT_KEY_PAGE_ROWS = 500;

/** The text keys of `tenantId`, a page at a time, oldest first. */
export function* textKeyPages(sharing: Sharing, tenantId: TenantId): Generator<EntryTextKey[]> {
  let after: EntryCursor | null = null;
  do {
    const page = sharing.textKeysPage(tenantId, { limit: TEXT_KEY_PAGE_ROWS, after: after ?? undefined });
    yield page.keys;
    after = page.next;
  } while (after !== null);
}
