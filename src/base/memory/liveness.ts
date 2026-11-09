// A blank link counts as superseded: the CAS guard, recall and three partial indexes read it so.

/** True when the memory has a successor link of any value, a blank one included. */
export function isSuperseded<T extends { readonly supersededBy?: string | null }>(
  entry: T,
): entry is T & { readonly supersededBy: string } {
  return entry.supersededBy !== null && entry.supersededBy !== undefined;
}
