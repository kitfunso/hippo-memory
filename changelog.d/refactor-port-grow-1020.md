### Changed

- **3.0 break: the store port covers the store calls domain code makes, so a `HippoStore` has new required groups.** Code outside `src/store` reached hippo.db through functions keyed by a folder; each now calls its store's port. A store built on `hippo-memory/store-kit` must add the new groups (`rejections`, `failureLog`) and the new methods of the grown ones (`connectorEvents`, `lessonWrites`). `sqliteStore` has them all. `captureFailureForCaller` on `hippo-memory/server` now returns a Promise. `docs/UPGRADING-3.0.md` has one row per group.
