### Changed

- **The vector scan page test seeds each store once per file.** `tests/store/vector-scan-pages.test.ts` builds the 2.5-page store and the page-plus-10 store in `beforeAll`, so the file runs in about half the time.
