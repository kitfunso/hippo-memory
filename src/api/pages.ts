// Paged api lists: the row count a page reads, and the walk over every page for the verbs that print them all.
import { BadRequestError } from '../base/errors/api-errors.js';
import type { KeysetPosition } from '../base/util/keyset.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, resolveListLimit } from '../base/util/limits.js';

/** The caller's row count, else the default; a 400 past the cap or below one. */
export function pageLimit(limit: number | undefined): number {
  const resolved = resolveListLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  if (resolved === undefined) throw new BadRequestError(`limit must be a positive integer <= ${MAX_LIST_LIMIT}`);
  return resolved;
}

/** Each page `read` answers, in order, until one names no next position: one page in hand at a time. */
export async function* keysetPages<P extends { readonly next: KeysetPosition | null }>(
  read: (after: KeysetPosition | undefined) => Promise<P>,
): AsyncGenerator<P> {
  let after: KeysetPosition | undefined;
  do {
    const page = await read(after);
    yield page;
    after = page.next ?? undefined;
  } while (after);
}
