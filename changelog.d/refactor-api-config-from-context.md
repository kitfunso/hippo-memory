### Changed

- **The root SQLite handle exports are deprecated.** `openHippoDb`, `openHippoDbReadOnly`, `closeHippoDb` and `DatabaseSyncLike` stay on the package root in 2.x with a `@deprecated` note and are also on `hippo-memory/store-kit`, where they live from 3.0.
