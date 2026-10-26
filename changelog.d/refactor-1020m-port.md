### Changed

- **A server settles each route's store need once at boot, and each layer keeps only its own work.** Sleep results carry typed events in place of display lines (`/v1/sleep` still answers `details`), `hippo-memory/store-kit` gains `runStoreConformance`, and `serve()` warns when `HIPPO_V1_RPS=0` or `HIPPO_CALLER_RPS=0` turns a rate limit off.
