### Changed

- **`hippo recall`'s ranking core writes through the store the caller passes.** Its audit rows, goal log and strengthen now go to `ctx.store` when one is set, as every other recall path does; the second (global) store still gets its own row.
- **Internal:** the store port no longer imports SQLite's busy codes. `isStoreBusy` moved to `src/store/sqlite/busy.ts`, beside the adapter that knows those codes.
- **Internal:** the memory-quality audit rules (`auditMemory`, `auditMemories`) moved from `src/store/audit.ts` to `src/core/memory-audit.ts`, so the store file keeps only the audit-log SQL.
