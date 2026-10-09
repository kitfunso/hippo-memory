### Changed

- **Every transaction start now goes through `src/db/busy.ts`.** Internal only: read snapshots, dry runs and the lock-waiting writes use `withReadSnapshot`, the new `withTrialScope` and `withWriteScope`'s optional `busyWaitMs`; behaviour on success is unchanged.
