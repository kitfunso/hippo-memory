### Changed
- The store-level `createApiKey` now mints a `member` key that expires after 90 days when no role or expiry is given, matching the API layer. Callers that relied on a never-expiring admin key must pass `role: 'admin'`.

### Fixed
- A browser request whose `Origin` is an https page on the server's own host is no longer treated as cross-site.
