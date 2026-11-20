### Added

- **Admins can grant and revoke a member key's read of a private scope over HTTP.** `POST /v1/auth/keys/:keyId/grants` takes `{"scope": "..."}` and `DELETE /v1/auth/keys/:keyId/grants?scope=...` removes it. Both need an admin key.
- **`hippo auth list` shows each key's grant scopes.** A key with none shows `-`.

### Fixed

- **A member key with a read grant could copy a private row it did not write.** Promote and share now need the owning key or an admin key. A key that only holds a read grant gets 403, and a row it cannot read still gets 404.
- **A shared copy now names who made it.** The audit log shows the caller's subject, not `cli`.
- **Drill-down hid a granted member's private summary.** It now opens the summary and shows the children in scopes the key may read. An admin key drills as before.

### Changed

- **`hippo share` and MCP `hippo_share` now answer a missing id with `memory not found: <id>`.** It was `Memory not found: <id>`; promote already used the new text.
- **`hippo auth grant` and the grant route refuse a scope with a leading or trailing space.** A padded scope is almost always a typing slip, and it would not reach the rows the admin meant. A grant stored that way before can still be removed as stored. A row whose scope was stored with a space cannot get a new grant.
