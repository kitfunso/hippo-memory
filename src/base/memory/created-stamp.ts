// A memory's `created` in the one form whose bytes sort by time, so every SQL read can order by the column itself.

/** `stamp` as Date.toISOString() writes the instant Date reads in it; null when Date cannot read it. */
export function isoInstant(stamp: string): string | null {
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// The length of toISOString's 'YYYY-MM-DDTHH:mm:ss.sssZ', the one form whose text order is time order.
const ISO_STAMP_CHARS = 24;

/** `stamp` itself in toISOString's form, else the instant Date reads in it, else '' so it sorts oldest. */
export function sortableStamp(stamp: string): string {
  return [...stamp].length === ISO_STAMP_CHARS && /z$/i.test(stamp) ? stamp : (isoInstant(stamp) ?? '');
}
