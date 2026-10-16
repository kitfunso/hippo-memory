# Upgrading to 3.0

hippo 3.0 removes names that 2.1 marked `@deprecated`. Nothing else changes: an entry keeps its field names, hippo.db keeps its columns and files on disk keep their format. HTTP and MCP answers keep their shape.

| Removed in 3.0 | Use instead |
| --- | --- |
| `openHippoDb`, `openHippoDbReadOnly`, `closeHippoDb` and the `DatabaseSyncLike` type on the package root. | The root's store functions, such as `loadAllEntries`, `writeEntry` and `queryAuditEvents`, or `sqliteStore(hippoRoot)` from `hippo-memory/store-kit`. No package entry hands out a raw SQLite handle. |
| The snake_case option keys of `createMemory`: `emotional_valence`, `schema_fit`, `trace_outcome`, `source_session_id`, `valid_from`, `extracted_from`, `dag_level`, `dag_parent_id` and `artifact_ref`. | The camelCase keys 2.1 added: `emotionalValence`, `schemaFit`, `traceOutcome`, `sourceSessionId`, `validFrom`, `extractedFrom`, `dagLevel`, `dagParentId` and `artifactRef`. A snake_case key is now a type error and is ignored at run time. The entry that comes back keeps its snake_case field names. |
