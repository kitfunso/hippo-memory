import type { AuditEvent } from './types.js';

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
  /** As `listAuditEventsAfter`: rows above `afterId` in ascending
   * id order, with its RangeErrors, limit clamp and tenant filter. */
  auditEventsAfter(opts: ListAuditAfterOpts): Promise<AuditEvent[]>;
  /** The highest audit id ever assigned, pruned rows included, 0 before the first; a tail that sees it drop knows the
   * log was restored. */
  auditHighId(): Promise<number>;
}

export interface ListAuditAfterOpts {
  /** Last id already consumed; 0 starts from the beginning. */
  afterId: number;
  /** Clamped to 1..10000; default 1000. */
  limit?: number;
  /** Omit for every tenant (deployment-wide export). */
  tenantId?: string;
}
