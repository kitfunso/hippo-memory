import type { MemoryEntry } from '../memory.js';

export interface CurrentnessOptions {
  /** Keep only rows current at this ISO date string. */
  asOf?: string;
  /** Keep superseded rows when no `asOf` is given. */
  includeSuperseded?: boolean;
}

/** Rows current at `asOf`, or rows not superseded unless `includeSuperseded`. */
export function currentEntries(entries: MemoryEntry[], options: CurrentnessOptions): MemoryEntry[] {
  if (options.asOf) return entriesAsOf(entries, new Date(options.asOf));
  return options.includeSuperseded ? entries : entries.filter((e) => !e.superseded_by);
}

function entriesAsOf(entries: MemoryEntry[], asOfDate: Date): MemoryEntry[] {
  // A merged pool can repeat an id; the first row wins, as a scan from the front would pick.
  const byId = new Map<string, MemoryEntry>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);
  return entries.filter((e) => {
    if (new Date(e.valid_from) > asOfDate) return false;
    if (!e.superseded_by) return true;
    const successor = byId.get(e.superseded_by);
    return successor?.valid_from ? new Date(successor.valid_from) > asOfDate : true;
  });
}
