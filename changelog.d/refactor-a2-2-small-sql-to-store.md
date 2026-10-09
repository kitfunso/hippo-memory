### Changed

- **Internal: 16 small SQL statements moved into the store layer.** Session owners, pilot arm, invalidation, half-life migration, project merge and agent-memory sync call store functions instead of preparing SQL. No behaviour changes.
