### Changed

- **New production exports that only tests use are now blocked in CI.** `scripts/check-test-only-exports.mjs` lists every `src/` export that no other `src/` file names but a test does, and fails on any not in `.test-only-exports-baseline.json`. The baseline can only shrink. No runtime behaviour changes.
