### Changed

- **Every store sets `vectors` and `vectorWrites`, no store keeps `bumpRemembered` or `quarantine`, and `runStoreConformance` checks every required group and base method.** A store-kit adapter must serve both vector groups and can drop both. Quarantine and `hippo_learn` run on hippo.db alone, with hippo.db's own reads and writes on the store workers. See `docs/UPGRADING-3.0.md`.
