### Added

- **`POST /v1/auth/keys/self` lets a signed-in SSO user mint their own member key.** It is off unless `serve()` gets `selfServiceKeys: { ttlDays, perSubject }`, and answers 404 until then. Only a caller verified by the `authResolver` may use it; an `hk_` API key or the local CLI gets 403. The key is always `member`, its tenant and owner come from the verified identity, it expires after `ttlDays`, and the body may carry only `label`. Past `perSubject` live keys, the oldest are revoked in the same transaction. Each replaced key gets an `auth_revoke` audit row and the new key an `auth_create` row with `self: true` and `expiresAt`; if any audit write fails, no key is minted and none is revoked.
- **`GET /v1/auth/connect` tells a client where to sign in.** It serves `connectInfo` (`issuer`, `clientId`, `scopes`, `redirectUris`) as given to `serve()`, with no auth even under `HIPPO_REQUIRE_AUTH=1`, and answers 404 when `connectInfo` is unset.
- **`hippo-memory/server` exports the `SelfServiceKeysOpts` and `ConnectInfo` types** for the new `serve()` options.

### Changed

- **Schema v53 gives API keys an owner and an expiry, and older binaries refuse a v53 store.** `api_keys` gains nullable `owner_subject` and `expires_at`; keys minted before v53 or by an admin keep both null and never expire. An expired key gets 401 on every route, MCP and the event stream included, and a cached key stops at its expiry, not a cache TTL later. The migration raises `min_compatible_binary` to the version that ran it, because an older binary would ignore `expires_at` and keep honouring expired keys. Upgrade every hippo binary that shares a store together.
- **A member listing `GET /v1/auth/keys` sees only their own keys.** An SSO member sees the keys they minted; a member API key sees the keys of the person who minted it, or just itself when it has no owner. Admins still see the whole tenant.
- **`POST /v1/auth/keys` now reads its body before it checks auth, capped at 4 KB.** Auth, including any SCIM deactivation check inside the resolver, now runs right before the mint, so a user deactivated while the body was in flight gets no key. A larger body gets 413.
