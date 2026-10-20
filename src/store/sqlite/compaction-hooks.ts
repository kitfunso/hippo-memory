// hippo.db's CompactionHooks: the record functions take the store's opener, which each call opens with the hook's wait.
import {
  recordCompactionStart,
  recordSnapshotSaved,
  replayStoredCompactions,
  saveCompactionAt,
} from './compactions-record.js';
import type { OnHandle } from './open.js';
import type { CompactionHooks } from '../port/compaction-hooks.js';

export function sqliteCompactionHooks(on: OnHandle): CompactionHooks {
  return {
    start: (tenantId, start, log) => recordCompactionStart(on, tenantId, start, log),
    markSnapshotSaved: (tenantId, recordId, log) => recordSnapshotSaved(on, tenantId, recordId, log),
    save: (save) => saveCompactionAt(on, save),
    replay: (tenantId, sources, log, opts) => replayStoredCompactions(on, tenantId, sources, log, opts),
  };
}
