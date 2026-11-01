// The KeyWrites group: minting, listing, granting and revoking API keys.
import type { JsonValue } from '../../util/json.js';
import type { KeysetPosition } from '../../util/keyset.js';
import type { TenantId } from '../../util/tenant.js';
import type { MethodEffects } from './types.js';

export interface KeyRevoke {
  readonly tenantId: string;
  readonly keyId: string;
  readonly actor: string;
  readonly at: string;
}

/** One grant or ungrant on a key of `tenantId`, and the actor of its audit row; the api has
 * already refused an open or personal scope. */
export interface ScopeGrantChange {
  readonly tenantId: string;
  readonly keyId: string;
  readonly scope: string;
  readonly op: 'auth_grant' | 'auth_ungrant';
  readonly actor: string;
}

/** A key to insert and the actor and metadata of its auth_create row, whose tenant and target
 * are the key's. Neither holds the plaintext. */
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

/** `listApiKeyRows`'s filters; ALL_TENANTS is sent only by the host's `hippo auth list`. */
export type KeyListQuery = ListApiKeysOptions;

/** Every key write commits with its audit rows in one transaction, so with either one failing,
 * neither is written. */
export interface KeyWrites {
  /** Inserts the key and appends its auth_create row. A key id taken in any tenant rejects,
   * since keys are looked up by id alone. */
  changeApiKey(change: 'create', mint: KeyMint): Promise<void>;
  /** Serialized per (tenant, owner) before the count: revoke the owner's oldest live keys to
   * `perSubject - 1`, then insert the key; append auth_revoke `{ replacedBy }` per revoked key,
   * then auth_create. Live: unrevoked and not expired (NaN counts as expired). Resolves to the
   * revoked ids. */
  changeApiKey(change: 'create_self', mint: SelfKeyMint): Promise<string[]>;
  /** Sets revoked_at to `at` and appends one auth_revoke row (the key's tenant, `actor`, the key
   * id), then resolves to `at`. A revoked key resolves to its own revoked_at and writes nothing;
   * a key missing from `tenantId` rejects with NotFoundError `Unknown key_id: <keyId>`. */
  changeApiKey(change: 'revoke', revoke: KeyRevoke): Promise<string>;
  /** Checks the key under the write lock, then grants or ungrants the scope with its auth_grant
   * or auth_ungrant row. */
  changeApiKey(change: 'scope', grant: ScopeGrantChange): Promise<void>;
  /** As `listApiKeyRows`: newest inserted first, each with its scope grants; `active` drops
   * revoked rows and an expires_at not above now's toISOString. */
  listApiKeys(query: KeyListQuery): Promise<ApiKeyListRow[]>;
}

/** What each KeyWrites method does to the store; every adapter honours it. */
export const KEY_WRITES_EFFECTS = {
  changeApiKey: 'write',
  listApiKeys: 'read',
} as const satisfies MethodEffects<KeyWrites>;

/** `changeApiKey`'s overloads as one argument list, so an adapter writes one body. */
export type KeyChangeArgs =
  | [change: 'create', mint: KeyMint]
  | [change: 'create_self', mint: SelfKeyMint]
  | [change: 'revoke', revoke: KeyRevoke]
  | [change: 'scope', grant: ScopeGrantChange];

/** `KeyWrites` as an adapter writes it; the port's overloads pair each change with its answer. */
export interface KeyCalls {
  changeApiKey(...args: KeyChangeArgs): Promise<void | string[] | string>;
  listApiKeys: KeyWrites['listApiKeys'];
}

/** A listed key plus its row id, the paging key the list item itself does not expose. */
export interface ApiKeyListRow {
  rowId: number;
  key: ApiKeyListItem;
}

export interface ApiKeyListItem {
  keyId: string;
  tenantId: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Authorization role from the `role` column (schema migration v26).
   * Fail-safe cast: any non-'admin' value reads as 'member'. */
  role: 'admin' | 'member';
  /** Restricted scopes this key may read. */
  scopes: string[];
  /** ISO time the key stops working; null when it never expires. */
  expiresAt: string | null;
  /** The auth-resolver subject that minted this key for itself; null for keys an admin or the
   * CLI minted. */
  ownerSubject: string | null;
}

export interface ListApiKeysOptions {
  /** Only keys that still work: unrevoked and unexpired. */
  active: boolean;
  /** Only this tenant's keys; ALL_TENANTS is every tenant's (the CLI's single-tenant view). */
  tenantId: TenantId;
  /** Only keys minted by this auth-resolver subject. */
  ownerSubject?: string;
  /** Only this one key. */
  keyId?: string;
  /** Resume after this row: the position the previous page ended on (key and id are both the row
   * id). */
  after?: KeysetPosition;
  limit?: number;
}

/** One api_keys row as core hands it to a store: the hash of the secret, never the secret. */
export interface NewApiKey {
  readonly keyId: string;
  readonly keyHash: string;
  readonly tenantId: string;
  readonly label: string | null;
  readonly role: 'admin' | 'member';
  readonly createdAt: string;
  /** The auth-resolver subject a self-service key belongs to; null for a key an admin or the CLI
   * mints. */
  readonly ownerSubject: string | null;
  /** ISO time the key stops working; null means it never expires. */
  readonly expiresAt: string | null;
}
