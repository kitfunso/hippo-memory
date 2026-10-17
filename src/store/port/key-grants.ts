import type { ScopeGrantChange } from '../key-writes.js';

export interface KeyGrants {
  /** Checks the key under the write lock; the change and its auth_grant or auth_ungrant row commit together. */
  changeScopeGrant(change: ScopeGrantChange): Promise<void>;
}
