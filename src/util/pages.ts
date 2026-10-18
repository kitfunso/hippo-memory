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
