### Added

- **`hippo-memory/store-kit` exports `memoryStore()` and its `MemoryTables` type, the second supported store.** CI runs the HTTP server and MCP suites on `serve({ store: memoryStore() })`; `hippo-memory/testing` keeps both exports.

### Changed

- **`MemoryConflict` in `hippo-memory/store-kit` names its fields in camelCase: `memoryAId`, `memoryBId`, `detectedAt` and `updatedAt`.** `hippo conflicts --json`, `hippo trace --json` and the conflict mirrors keep their snake_case keys. See docs/UPGRADING-3.0.md.
