### Changed

- **Moved the test runner from vitest 3 to vitest 5 and added a coverage floor.** `npm audit` now reports no advisories; vitest 3 pulled in `@vitest/mocker` with a path traversal advisory (GHSA-82fw-gwwq-j7x9). `npm run test:coverage` measures `src/` with v8 coverage and fails when lines, branches, functions or statements fall below the floor in `vitest.config.ts`. No runtime or CLI change.
