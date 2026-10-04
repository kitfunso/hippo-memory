### Fixed

- **A recall-scope test no longer times out on Windows CI.** It seeded 221 rows with a store open and close per row; it now seeds them through one shared connection, which halves its run time.
