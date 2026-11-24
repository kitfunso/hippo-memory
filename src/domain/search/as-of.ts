import type { MemoryEntry } from '../../base/memory/entry.js';
import { isSuperseded } from '../../base/memory/liveness.js';

export interface CurrentnessOptions {
  asOf?: string;
  includeSuperseded?: boolean;
}

/** Rows current at `asOf`, or rows not superseded unless `includeSuperseded`. */
export function currentEntries(entries: MemoryEntry[], options: CurrentnessOptions): MemoryEntry[] {
  if (options.asOf) return entriesAsOf(entries, new Date(options.asOf));
  return options.includeSuperseded ? entries : entries.filter((e) => !isSuperseded(e));
}

function entriesAsOf(entries: MemoryEntry[], asOfDate: Date): MemoryEntry[] {
  const byId = new Map<string, MemoryEntry>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);
  return entries.filter((e) => {
    if (new Date(e.validFrom) > asOfDate) return false;
    if (!isSuperseded(e)) return true;
    const successor = byId.get(e.supersededBy);
    return successor?.validFrom ? new Date(successor.validFrom) > asOfDate : true;
  });
}
