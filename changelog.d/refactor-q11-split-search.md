### Changed

- **`src/search.ts` is split into small modules under `src/search/`, with ranking unchanged.** A snapshot test pins scores, order and breakdowns for every ranking path, and it passes unchanged after the move. The public exports from the package entry point keep their names and signatures. The longest function went from 422 lines to 34.
- **The as-of filter looks up successors by id instead of scanning the pool for each row.**
- **Physics recall loads particles only for the candidate rows, not every row in the store.** `loadPhysicsState` now reads ids in chunks of 500, so a long id list stays under SQLite's bound-parameter limit.
