### Changed

- **Lookups by artifact use an index.** Connector deletes and vault re-imports no longer scan the tenant; existing stores get the index (schema v58) on next open.
