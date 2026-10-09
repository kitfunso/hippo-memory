### Changed

- **Twenty hand-written `BEGIN IMMEDIATE` blocks now run through `withWriteScope`, and the ones that roll back and return a value through the new `withWriteScopeOr`, both in `src/db/busy.ts`.** Internal; no behaviour change.
