// Keyset paging for a caller that walks a whole read: each page is one bounded statement, and only that page is held.

/** Rows per statement when a caller walks every row a read names. */
export const READ_PAGE_ROWS = 500;

/** Every row of a keyset-paged read, in its order; `read` gets the cursor the page before ended at. */
export function* rowsInPages<T, C>(
  read: (after: C | undefined) => { readonly entries: readonly T[]; readonly next: C | null },
): Generator<T> {
  let after: C | undefined;
  do {
    const page = read(after);
    yield* page.entries;
    after = page.next ?? undefined;
  } while (after !== undefined);
}

/** A keyset-paged read that answers through a Promise, one page per call. */
type PageRead<T, C> = (after: C | undefined) => Promise<{ readonly entries: readonly T[]; readonly next: C | null }>;

/** Each page of `read`, in order, one held at a time. */
export async function* readPages<T, C>(read: PageRead<T, C>): AsyncGenerator<readonly T[]> {
  let after: C | undefined;
  do {
    const page = await read(after);
    yield page.entries;
    after = page.next ?? undefined;
  } while (after !== undefined);
}

/** Every row of `read`, in order. */
export async function readAll<T, C>(read: PageRead<T, C>): Promise<T[]> {
  const rows: T[] = [];
  for await (const page of readPages(read)) rows.push(...page);
  return rows;
}
