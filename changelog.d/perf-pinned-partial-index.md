### Changed

- **Building context no longer scans the whole memories table to find pinned rows.** Schema v51 adds a partial index on pinned rows (tenant, created, id) and a second, normally empty, index that makes the date-drift check a single seek instead of a tenant-wide scan. Both are additive and built on first open.
