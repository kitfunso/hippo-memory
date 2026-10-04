### Fixed

- **The memory-value simulation opens its store once per run, not 12 times a round.** `benchmarks/memory-value/simulate.mjs` now runs inside `withSharedStoreHandles`, so each read and write stops paying the pragmas, migration check and mirror sweep again. The full 30-round determinism test drops from about 30 s to 4 to 8 s on Windows (84 to 94 s on the CI runner against its 90 s limit, where it failed on PR #444), and the harness file from about 35 s to 6 to 14 s. Same rows, same assertions.
- **The recall-trace storage smoke shares one store handle across its 100 recalls.** It measures trace growth, not open cost; it ran at 62% of its 30 s limit on the Windows runner.
