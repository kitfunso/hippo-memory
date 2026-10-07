### Added

- **Revoking a key and reading the audit log now go through the store port, so they can run on a store other than hippo.db.** `HippoStore` gains an optional `keyAudit` member, the exported `KeyAudit` interface, with three methods. `revokeApiKey` revokes one key for a tenant and writes its `auth_revoke` audit row in one transaction. `auditEventsAfter` reads audit rows after an id, in the order and shape of `listAuditEventsAfter`. `auditHighId` returns the highest audit id ever assigned, pruned rows included. A store sets all three or leaves `keyAudit` unset. `sqliteStore` sets them with the queries hippo.db ran before.
- **Store groups are named, and a route or MCP tool names the group it needs.** `hippo-memory/server` exports `StoreGroups`, `StoreGroup` and `hasGroup`. Under another store, a route or tool whose group that store lacks answers 501 `store_not_ported` (MCP error -32603) before its handler runs. `DELETE /v1/auth/keys/:keyId` needs `keyAudit`, so a store that has it can now serve key revokes. The routes and tools that ran on every store before still do.
- `hippo-memory/server` also exports `NotFoundError`, `AuthRevokeReply`, `AuthRevokeResult`, `KeyAudit`, `KeyRevoke`, `AuditEvent` and `ListAuditAfterOpts`.

### Changed

- **`authRevoke` with `ctx.store` set revokes through `ctx.store.keyAudit` and never opens hippo.db.** It returns a promise in that case. A store without `keyAudit` rejects with `StoreNotPortedError`. With no store it runs on hippo.db and returns synchronously, as before. Code that types its context as the wide `Context` now gets `AuthRevokeResult | Promise<AuthRevokeResult>` and should `await` the result.
- On the store path, a failed audit write rolls the revoke back and the caller sees the error. `serve()` always passes a store, `sqliteStore` by default, so `DELETE /v1/auth/keys/:keyId` on hippo.db now answers 500 and leaves the key live when the audit row cannot be written; before, it revoked the key without the row. `hippo auth revoke` and `authRevoke` without a store still keep the revoke and report the audit failure.
- `StoreNotPortedError` now says "has no '<group>' group" where it said "has no '<group>' reads".

### Tests

- **`tests/key-audit-conformance.test.ts` runs every `KeyAudit` method on hippo.db and on an in-memory store over a two-tenant fixture, and checks that values, errors and audit rows match.** It covers an unknown key, another tenant's key, a key already revoked, a revoke and its row, paging, tenant scoping, the limit clamp and its errors, and the high-water id above a pruned row. The runner lives in `tests/_helpers/store-conformance.ts`, so a later store group can reuse it.
- `tests/auth-revoke-store.test.ts` checks that `authRevoke` with a store creates no hippo.db, that a store without `keyAudit` is refused before any write, and that a revoked key is refused at once over `serve()`.
