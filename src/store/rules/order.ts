// The row orders both adapters keep, each written once: hippo.db sorts by its ORDER BY text, the memory store with the
// comparator built from the same keys.
import type { KeysetPosition } from '../../base/util/keyset.js';
import type { MemoryEntry } from '../../base/memory/memory.js';

/** Byte order, as hippo.db compares text; JavaScript's own string order differs above the basic plane. */
export const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** One sort key: the hippo.db column and how two read rows compare on it, ascending. */
export interface OrderKey<R> {
  readonly column: string;
  readonly compare: (a: R, b: R) => number;
  readonly desc?: boolean;
}

/** A TEXT column, compared as hippo.db compares it. */
export const textKey = <R>(column: string, of: (row: R) => string): OrderKey<R> => ({
  column,
  compare: (a, b) => byBytes(of(a), of(b)),
});

/** The comparator that sorts rows as `ORDER BY orderSql(keys)` does. */
export function comparing<R>(keys: readonly OrderKey<R>[]): (a: R, b: R) => number {
  return (a, b) => {
    for (const key of keys) {
      const c = key.compare(a, b);
      if (c !== 0) return key.desc ? -c : c;
    }
    return 0;
  };
}

/** The keys as an ORDER BY list, without the ORDER BY. */
export const orderSql = <R>(keys: readonly OrderKey<R>[]): string =>
  keys.map((k) => `${k.column} ${k.desc ? 'DESC' : 'ASC'}`).join(', ');

type EntryKey = OrderKey<Pick<MemoryEntry, 'created' | 'content' | 'id'>>;
const CREATED: EntryKey = textKey('created', (e) => e.created);
const CONTENT: EntryKey = textKey('content', (e) => e.content);
const ID: EntryKey = textKey('id', (e) => e.id);

/** loadAllEntries' order and every page of it: created, then id. */
export const STORE_ORDER: readonly EntryKey[] = [CREATED, ID];
/** A by-id read: created, content, then id, since ids are random. */
export const BY_ID_ORDER: readonly EntryKey[] = [CREATED, CONTENT, ID];
/** The fresh raw tail: newest first, content then id breaking a tie. */
export const FRESH_RAW_ORDER: readonly EntryKey[] = [{ ...CREATED, desc: true }, CONTENT, ID];

export const oldestFirst = comparing(STORE_ORDER);
export const byIdOrder = comparing(BY_ID_ORDER);
export const freshRawOrder = comparing(FRESH_RAW_ORDER);

/** A list walked by (key, id) descending, as keysetAfter pages it in SQL; an id is a text or an integer column. */
export type DescendingKeyset<R> =
  | { readonly key: (row: R) => string; readonly textId: (row: R) => string }
  | { readonly key: (row: R) => string; readonly intId: (row: R) => number };

/** How `row`'s id compares with `id`, as the id column compares. */
const idOrder = <R>(walk: DescendingKeyset<R>, row: R, id: string | number): number =>
  'intId' in walk ? walk.intId(row) - Number(id) : byBytes(walk.textId(row), String(id));

const idOf = <R>(walk: DescendingKeyset<R>, row: R): string | number =>
  'intId' in walk ? walk.intId(row) : walk.textId(row);

/** The comparator of a (key, id) descending walk. */
export function newestFirst<R>(walk: DescendingKeyset<R>): (a: R, b: R) => number {
  return (a, b) => byBytes(walk.key(b), walk.key(a)) || idOrder(walk, b, idOf(walk, a));
}

/** Whether `row` comes after `after` in the walk, as `(key, id) < (?, ?)` reads it. */
export function isBelow<R>(walk: DescendingKeyset<R>, row: R, after: KeysetPosition): boolean {
  const byKey = byBytes(walk.key(row), String(after.key));
  return byKey < 0 || (byKey === 0 && idOrder(walk, row, after.id) < 0);
}
