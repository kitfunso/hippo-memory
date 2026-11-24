/** True when the memory has a successor link of any value, a blank one included. */
export function isSuperseded<T extends { readonly supersededBy?: string | null }>(
  entry: T,
): entry is T & { readonly supersededBy: string } {
  return entry.supersededBy !== null && entry.supersededBy !== undefined;
}
