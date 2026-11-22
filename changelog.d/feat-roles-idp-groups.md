### Added

- **A viewer role, and one rule that maps an IdP groups claim onto it.** `roleFromGroups` from `hippo-memory/server` turns a groups claim into viewer, editor (stored as `member`) or admin; each resolver keeps its own group lists. A viewer signed in through an auth resolver can read and cannot write.
- **Add-on routes take a `level`.** `AddonRoute.level` is 'viewer', 'editor' or 'admin', and an unset level means 'editor'.

### Changed

- **`Actor.role`, `ResolvedBearer.role`, `McpCaller.role` and `ScopeActor.role` gain 'viewer'.** `ScopeActor` also reaches the store-kit entry and the store port.
- **Add-on routes refuse a viewer by default.** Set `level: 'viewer'` on a route that writes nothing.
- **The request line carries `role=`** for /v1, add-on and MCP calls.

### Security

- **Self-mint and the MCP write tools refuse a viewer.** A viewer can no longer mint its own member key or call `hippo_remember`, `hippo_outcome`, `hippo_learn`, `hippo_resolve` or `hippo_share`.
