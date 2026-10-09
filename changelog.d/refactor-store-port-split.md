### Changed

- **The store port interface and its SQLite adapter now live in separate files.** `src/store/port.ts` holds the interface and `src/store/sqlite/store.ts` the adapter; `src/store-port.ts` re-exports the same names. No behaviour change.
