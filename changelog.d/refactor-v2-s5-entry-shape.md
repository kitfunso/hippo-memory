### Changed

- **BREAKING: `MemoryEntry.tenantId` is now `tenant_id`, and `summary_dirty` is a boolean.** Every other stored field was already snake_case. `writeEntry` throws a TypeError for an entry that still carries `tenantId`. `CreateMemoryOptions.tenantId` is unchanged. `hippo export` JSON emits the new names; 1.x dormant snapshots are read in both shapes. See `docs/UPGRADING-2.0.md`.
