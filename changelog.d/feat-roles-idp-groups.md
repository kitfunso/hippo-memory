### Added

- **A viewer role, and one rule that maps an IdP groups claim onto it.** `roleFromGroups` from `hippo-memory/server` turns a groups claim into viewer, editor (stored as `member`) or admin; each resolver keeps its own group lists. Pass a null fallback to refuse a caller in no mapped group; Entra drops the claim above 200 groups, so a null fallback refuses those users. Map a team-admin IdP group to editor, never admin, until team admin ships: admin covers the whole tenant. A viewer signed in through an auth resolver can read and cannot write.
- **Add-on routes take a `level`.** `AddonRoute.level` is 'viewer', 'editor' or 'admin', and an unset level means 'editor'.

### Changed

- **`Actor.role`, `ResolvedBearer.role`, `McpCaller.role` and `ScopeActor.role` gain 'viewer'.** `ScopeActor` also reaches the store-kit entry and the store port.
- **A resolver role outside 'admin', 'member' and 'viewer' now reads as 'viewer'.** It read as 'member' before. An MCP context with no role reads as 'viewer' too.
- **Widening `Actor.role` breaks an exhaustive switch over it at compile time.** Add a 'viewer' case.
- **`DELETE /v1/auth/keys/:keyId` is open to a viewer.** `authRevoke` still lets a resolver caller below admin revoke only the keys it minted.
- **Add-on routes refuse a viewer by default.** Set `level: 'viewer'` on a route that writes nothing.
- **The request line carries `role=`** for /v1, add-on and MCP calls.

### Security

- **Self-mint and the MCP write tools refuse a viewer.** A viewer cannot mint its own member key or call `hippo_remember`, `hippo_outcome`, `hippo_learn`, `hippo_resolve` or `hippo_share`. A key minted while its owner was an editor keeps its role until it is revoked or expires; a viewer can revoke the keys it minted itself.
