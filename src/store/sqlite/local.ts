// What only hippo.db does: operations no port method covers, so they never run on another store.
import { changeScopeGrantAt, type ScopeGrantChange } from '../key-writes.js';
import { onHandle } from '../open.js';

/** Off the port: only the local CLI changes grants, through synchronous published functions a store's Promise cannot answer. */
export function changeScopeGrant(hippoRoot: string, change: ScopeGrantChange): void {
  onHandle(hippoRoot, (db) => changeScopeGrantAt(db, change));
}
