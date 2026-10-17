// hippo.db's CompactionHooks: the folder-keyed record functions, which each open their own handle with the hook's wait.
import {
  recordCompactionStart, recordSnapshotSaved, replayStoredCompactions, saveCompactionAt,
} from '../compactions-record.js';
import type { CompactionHooks } from '../port/compaction-hooks.js';

export function sqliteCompactionHooks(hippoRoot: string): CompactionHooks {
  return {
    start: (start, log) => recordCompactionStart(hippoRoot, start, log),
    markSnapshotSaved: (tenantId, recordId, log) => recordSnapshotSaved(hippoRoot, tenantId, recordId, log),
    save: (meta, text, at, log, baseHalfLifeDays) => saveCompactionAt(hippoRoot, meta, text, at, log, baseHalfLifeDays),
    replay: (sources, log, opts) => replayStoredCompactions(hippoRoot, sources, log, opts),
  };
}
