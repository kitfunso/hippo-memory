### Changed

- **CI now enforces the coverage thresholds in `vitest.config.ts`.** Each `test` shard writes a coverage blob, and a new `coverage` job merges the three and fails the PR when lines, branches, functions or statements fall under the floor.
