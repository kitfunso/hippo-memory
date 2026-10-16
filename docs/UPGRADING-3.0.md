# Upgrading to 3.0

hippo 3.0 removes names that 2.1 marked `@deprecated`. Nothing else changes: an entry keeps its field names, hippo.db keeps its columns and files on disk keep their format. HTTP and MCP answers keep their shape.

| Removed in 3.0 | Use instead |
| --- | --- |
| `openHippoDb`, `openHippoDbReadOnly`, `closeHippoDb` and the `DatabaseSyncLike` type on the package root. | The root's store functions, such as `loadAllEntries`, `writeEntry` and `queryAuditEvents`, or `sqliteStore(hippoRoot)` from `hippo-memory/store-kit`. No package entry hands out a raw SQLite handle. |
