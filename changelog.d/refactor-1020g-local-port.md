### Changed

- **The ledger, the vector index, promotion, sharing and the store's folder are optional store groups.** They were part of hippo.db's local files, so a store built on `hippo-memory/store-kit` could not serve them. Each is now a group of async methods that `sqliteStore` serves on its worker threads and an add-on store may leave out. `Context` no longer carries `hippoRoot`. See `docs/UPGRADING-3.0.md`.
