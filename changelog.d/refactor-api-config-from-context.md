### Changed

- **The root SQLite handle exports are deprecated.** `openHippoDb`, `openHippoDbReadOnly`, `closeHippoDb` and `DatabaseSyncLike` stay on the package root in 2.x with a `@deprecated` note; the root stops exporting them in 3.0.
