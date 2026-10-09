### Changed

- **Test timeouts now fit the test.** The suite runs as two vitest projects: `unit` at 5 s per test and 10 s per hook, and `process` at 30 s for files that start a process, a worker thread or the HTTP server. Which project a file joins is read from its source when the config loads. Nine files that are slow for a reason their own source does not show set 30 s at the top, each with the reason. A hung in-memory test now reports in 5 s, where it took 30. Internal only, no runtime behaviour changes.
