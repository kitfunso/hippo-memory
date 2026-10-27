### Changed

- **Packed api, domain and base files split by reason to change, and `cliCore.rank` takes flat fields.** `limit`, `scorerWindow` and the engine fields sit at the top level, with no `window` or `search` key. See `docs/UPGRADING-3.0.md`.
