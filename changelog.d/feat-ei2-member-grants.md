### Added

- **Admins can grant and revoke a member key's read of a private scope over HTTP.** `POST /v1/auth/keys/:keyId/grants` takes `{"scope": "..."}` and `DELETE /v1/auth/keys/:keyId/grants?scope=...` removes it. Both need an admin key.
- **`hippo auth list` shows each key's grant scopes.** A key with none shows `-`.

### Fixed

- **A member key with a read grant could copy a private row it did not write.** Promote and share now need the owning key or an admin key. A key that only holds a read grant gets 403, and a row it cannot read still gets 404.
- **A shared copy now names who made it.** The audit log shows the caller's subject, not `cli`.
- **Drill-down hid a granted member's private summary.** It now opens the summary and shows the children in scopes the key may read. An admin key drills as before.
