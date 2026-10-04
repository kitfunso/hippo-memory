### Changed

- **Each schema migration lives in its own file under `src/db/migrations/`.** `src/db/migrations/index.ts` imports them in version order and holds the current schema version, so a new migration is one new file plus an edit to that index. Opening, locking, busy waits, meta reads and the migration runner move to small modules in `src/db/`, and `src/db.ts` only re-exports them, so every import path still works. The move changes no SQL: new tests pin the exact `sqlite_master` text and `user_version` of a fresh store and of a v1 store upgraded through every migration.
