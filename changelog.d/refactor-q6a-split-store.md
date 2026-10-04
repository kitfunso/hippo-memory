### Changed

- **`src/store.ts` is split into 16 modules under `src/store/`, with no change in behaviour.** It was 4,271 lines; the largest module is now 468. Code moved byte for byte: only imports and `export` keywords changed, and no function was split. Every importer points at the module that holds the name, and the package entry point keeps the same exports.
