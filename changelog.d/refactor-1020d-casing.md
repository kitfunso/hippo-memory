### Changed

- **`MemoryEntry` names its fields in camelCase: `entry.tenantId`, `entry.lastRetrieved` and 25 more replace their snake_case names.** One module, `src/core/memory-wire.ts`, maps an entry to the snake_case keys of every file and wire format, so `hippo export`, markdown mirrors, dormant snapshots and the HTTP and MCP answers keep their bytes. `docs/UPGRADING-3.0.md` lists each old and new name.

### Added

- **`hippo-memory/testing` exports `MemoryWire` and `*Wire` forms of ten eval-kit functions, which take and return snake_case keys.** Frozen eval scripts import them on their import line and read the same keys as before.
