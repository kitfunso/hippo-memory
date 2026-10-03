### Added

- **`hippo-memory/server` exports `authRevoke`, `ForbiddenError`, `isReservedActor` and the `Context` and `Actor` types, so an add-on can revoke keys when an identity provider deprovisions their minter.** `authRevoke` keeps the HTTP route's checks: a key in another tenant is unknown, and a resolver admin cannot revoke an admin key. `isReservedActor` is the check the core already applies to resolver subjects, so an add-on can tell SSO subjects from built-in actors such as `cli` or `api_key:<id>`.

### Changed

- **`scim` is now a reserved actor name.** A resolver subject `scim` or `scim:...` is rejected, so no SSO user can pose as the provisioning actor in the audit log.
