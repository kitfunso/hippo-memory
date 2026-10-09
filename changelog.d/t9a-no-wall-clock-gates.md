### Changed

- **CI no longer fails on a slow runner's clock.** The recall latency step reports p50, p95 and p99 to the job summary and gates nothing; the request-path step gates the same HTTP recall on statements run, rows read and store opens. Six test files swap elapsed-time assertions for counts, query plans or a clock the test owns. Internal only, no runtime behaviour changes.
