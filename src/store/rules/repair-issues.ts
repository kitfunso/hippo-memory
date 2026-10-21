// Quality repair's issue list, once for both adapters: which rows are defects and which of those a protection keeps.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { repairDefect, repairKeeps } from '../../base/memory/memory-audit.js';
import type { QualityRepairIssue, RepairProtection } from '../port/audit.js';

/** The issues among `entries` in their order, each defect kept when `protect` names the row. */
export function repairIssues(
  entries: readonly MemoryEntry[],
  parents: ReadonlyMap<string, MemoryEntry>,
  backing: ReadonlySet<string>,
  protect: RepairProtection,
): QualityRepairIssue[] {
  return entries.flatMap((entry): QualityRepairIssue[] => {
    const defect = repairDefect(entry, parents);
    if (defect === null) return [];
    const kept = repairKeeps(entry, backing.has(entry.id), protect);
    return [
      kept === undefined
        ? { id: entry.id, ...defect }
        : { id: entry.id, ...defect, disposition: 'protected', protection: kept },
    ];
  });
}
