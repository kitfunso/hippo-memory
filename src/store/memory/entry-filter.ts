// The memory store's half of the entry filter (port/reports.ts): each field one test of a row, as hippo.db's WHERE
// term in sqlite/entry-filter.ts reads it; tests/store/entry-filter-parity.test.ts holds the two equal.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { keysetPage } from '../../base/util/keyset.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { EntryFilter, EntryNarrowing, PageRequest } from '../port/reports.js';
import type { EntryCursor, EntryPage } from '../port/types.js';
import { oldestFirst } from '../rules/order.js';
import type { MemoryTables } from './tables.js';

// An alias, not `keyof` inline: a mapped type over it lets TESTS[key] read as Test<K> for a generic key.
type Field = keyof EntryNarrowing;
type Test<K extends Field> = (value: NonNullable<EntryNarrowing[K]>, e: MemoryEntry) => boolean;

type Tests = { readonly [K in Field]: Test<K> };

const TESTS: Tests = {
  ids: (ids, e) => ids.includes(e.id),
  origins: (origins, { originProject: origin }) => origin !== undefined && origin !== null && origins.includes(origin),
  source: (source, e) => e.source === source,
  sourcePrefix: (prefix, e) => e.source.startsWith(prefix),
  artifactRefPrefix: (prefix, e) => e.artifactRef !== null && e.artifactRef.startsWith(prefix),
  tag: (tag, e) => e.tags.includes(tag),
  kinds: (kinds, e) => kinds.includes(e.kind),
  live: (_live, e) => (e.supersededBy ?? '') === '',
  sessionId: (sessionId, e) => e.sourceSessionId === sessionId,
};

function passes<K extends Field>(filter: EntryFilter, key: K, e: MemoryEntry): boolean {
  const value = filter[key];
  return value === undefined || TESTS[key](value, e);
}

/** Whether `filter` keeps `e`. */
export function keeps(filter: EntryFilter, e: MemoryEntry): boolean {
  if (filter.tenantId !== ALL_TENANTS && e.tenantId !== filter.tenantId) return false;
  // SAFETY: Object.keys lists TESTS' own keys, which are the keys of EntryNarrowing.
  return (Object.keys(TESTS) as Field[]).every((key) => passes(filter, key, e));
}

/** A page of the rows `filter` keeps, in loadAllEntries' order or, with `page.newest`, newest first. */
export function entriesWhereIn(t: MemoryTables, filter: EntryFilter, page: PageRequest): EntryPage {
  const { after, newest } = page;
  const sign = newest ? -1 : 1;
  const rows = [...t.entries.values()]
    .filter((e) => keeps(filter, e) && (after === undefined || sign * oldestFirst(e, after) > 0))
    .sort((a, b) => sign * oldestFirst(a, b));
  const kept = keysetPage(rows.slice(0, page.limit + 1), page.limit, (e): EntryCursor => ({
    created: e.created,
    id: e.id,
  }));
  return { entries: structuredClone(kept.rows), next: kept.next };
}
