### Internal

- **CI runs the test suite on a RAM disk.** Some GitHub runners have a disk slow enough that the SQLite-backed test files ran 3 to 7 times slower and hit their timeouts, while pure in-memory tests on the same runners ran faster. The Vitest steps in the `test` and `node-floor` jobs now set `TMPDIR=/dev/shm`, so the suite's speed no longer depends on the runner's disk.
