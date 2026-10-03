### Added

- **`serve()` accepts an `authResolver` so an add-on can vouch for bearer tokens that are not API keys.** Tokens are routed by shape: an `hk_` token only ever reaches API-key validation, and any other token only reaches the resolver, which never sees a hippo key and cannot override one. A null answer is a 401 without opening the database. The core sanitises each answer (reserved or whitespace-padded subjects, empty or reserved tenants, and unknown roles are rejected or downgraded). A resolver that throws or misses its deadline (`authResolverTimeoutMs`, default 5000 ms) gets a 503 "auth provider unavailable", and an open `/mcp/stream` skips that heartbeat instead of closing as revoked. A resolver admin is a tenant admin: it gets a 403 for `GET /v1/audit?tenant=<other>` and `POST /v1/sleep`, while API-key admins keep both, and it can mint member API keys only, so a minted key never outranks it. The server is importable as `hippo-memory/server`.
- **`listAuditEventsAfter` reads the audit log by id cursor, for exporters.** Ascending, with an optional tenant filter. The audit and database open/close functions are exported from the main entry.

### Security

- **The per-IP rate limiter now covers `/mcp` and `/mcp/stream`, not only `/v1/*`.** Bearer guessing through the MCP transport was unthrottled.
