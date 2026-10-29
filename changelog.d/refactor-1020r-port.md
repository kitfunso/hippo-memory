### Changed

- **Every store sets `vectors` and `vectorWrites`, no store keeps `bumpRemembered`, and `runStoreConformance` checks every required group and base method.** A store-kit adapter must serve both vector groups and can drop `bumpRemembered`. See `docs/UPGRADING-3.0.md`.
