### Changed

- **BREAKING: `GET /v1/audit` now needs an admin key.** A member key used to read its whole tenant's audit log; it now gets 403. Use an admin key; see `docs/UPGRADING-2.0.md`.
