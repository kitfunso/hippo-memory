### Changed

- **3.0 break: the store port covers the store calls domain code makes, so a `HippoStore` has new required groups.** Code outside `src/store` reached hippo.db through functions keyed by a folder; each now calls its store's port. A store built on `hippo-memory/store-kit` must add the new groups (`rejections`) and the new methods of the grown ones (`connectorEvents`). `sqliteStore` has them all. `docs/UPGRADING-3.0.md` has one row per group.
