### Changed

- **Internal:** The memory quality repair now lives in `src/store/` and opens its unmigrated handle through `withUnmigratedDb` in `src/db/open.ts`, so no CLI file opens `hippo.db` or sets its own PRAGMAs.
