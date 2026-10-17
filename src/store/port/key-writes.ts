import type { ApiKeyListRow, ListApiKeysOpts, NewApiKey } from '../auth.js';
import type { JsonValue } from '../../util/json.js';

/** A key to insert and the actor and metadata of its auth_create row, whose tenant and target are the key's. Neither
 * holds the plaintext. */
export interface KeyMint {
  readonly key: NewApiKey;
  readonly actor: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface SelfKeyMint extends KeyMint {
  readonly key: NewApiKey & { readonly ownerSubject: string; readonly expiresAt: string };
  /** Live keys the owner may hold in the tenant once this one is in. */
  readonly perSubject: number;
}

/** `listApiKeyRows`'s filters, always inside one tenant. */
export interface KeyListQuery extends Omit<ListApiKeysOpts, 'tenantId'> {
  readonly tenantId: string;
}

export interface KeyWrites {
  /** Inserts the key and appends its auth_create row in one transaction; with either one failing, neither is written. A
   * key id taken in any tenant rejects, since keys are looked up by id alone. */
  createApiKey(mint: KeyMint): Promise<void>;
  /** Serialized per (tenant, owner) before the count (BEGIN IMMEDIATE / pg_advisory_xact_lock): revoke the owner's
   * oldest live keys to `perSubject - 1`, then insert the key; append auth_revoke `{ replacedBy }` per revoked key,
   * then auth_create. Live: unrevoked and not expired (NaN counts as expired). */
  createSelfApiKey(mint: SelfKeyMint): Promise<string[]>;
  /** As `listApiKeyRows`: newest inserted first, each with its scope grants; `active` drops revoked rows and an
   * expires_at not above now's toISOString. */
  listApiKeys(query: KeyListQuery): Promise<ApiKeyListRow[]>;
}
