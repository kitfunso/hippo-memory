### Changed

- **One shared temp-store fixture for the test suite.** `makeRoot(label, { config })` in `tests/_helpers/make-root.ts` replaces the setup copied into 96 test files. Two suites that need a store-less temp dir keep their own helper. No assertion changed.
