// A memory's `created` in the one form whose bytes sort by time, so every SQL read can order by the column itself.

/** `stamp` as Date.toISOString() writes the instant Date reads in it; null when Date cannot read it. */
export function isoInstant(stamp: string): string | null {
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
