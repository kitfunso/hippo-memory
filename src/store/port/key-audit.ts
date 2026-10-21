export interface KeyRevoke {
  readonly tenantId: string;
  readonly keyId: string;
  readonly actor: string;
  readonly at: string;
}

export interface KeyAudit {
  /** Sets revoked_at to `at` and appends one auth_revoke row (the key's tenant, `actor`, the key id) in one
   * transaction, then resolves to `at`. A revoked key resolves to its own revoked_at and writes nothing; a key missing
   * from `tenantId` rejects with NotFoundError `Unknown key_id: <keyId>`. */
  revokeApiKey(revoke: KeyRevoke): Promise<string>;
}
