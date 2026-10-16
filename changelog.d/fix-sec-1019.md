### Security

- **A write into a private scope now needs the grant a read of it needs.** A member key without a grant gets a 403 for `<source>:private:*` scopes, and no client request can write a quarantine scope. Admins and connectors keep their reach.
- **`GET /v1/audit` validates `?tenant=` and no longer echoes bad `op` or `since` input.** A malformed tenant is a 400; the op and since errors say what is allowed instead.

### Changed

- **`loadAllEntries(hippoRoot, tenantId)` now requires the tenant id.** Omitting it used to return every tenant's rows. See `docs/UPGRADING-3.0.md`.
