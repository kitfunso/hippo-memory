export interface KeyGrants {
  /** Checks the key under the write lock; the change and its auth_grant or auth_ungrant row commit together. */
  changeScopeGrant(change: ScopeGrantChange): Promise<void>;
}

/** One grant or ungrant on a key of `tenantId`, and the actor of its audit row; the api has already refused an open or
 * personal scope. */
export interface ScopeGrantChange {
  readonly tenantId: string;
  readonly keyId: string;
  readonly scope: string;
  readonly op: 'auth_grant' | 'auth_ungrant';
  readonly actor: string;
}
