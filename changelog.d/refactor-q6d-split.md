### Changed

- **`src/api.ts` is split into 17 domain modules under `src/api/`, with behaviour unchanged.** The code moved as-is; `src/api.ts` is now a barrel that re-exports the same names, so every import path still works. The largest new file is 784 lines, down from 4,100.
