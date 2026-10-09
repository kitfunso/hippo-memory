### Changed

- **Two more internal modules moved down a layer.** The blocked-SQLite error now lives in `src/util/` and the session-digest tag and row check in `src/core/`. Two upward imports are gone from `.layers-baseline.json`. No behaviour changes.
