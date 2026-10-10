### Changed

- **Internal:** capture code no longer opens the store or names a connection type. The write gate (`gated-write`) and the compaction record's SQL moved into `src/store`; the spool, transcript reads and hook text stay in `src/capture`, which calls store functions that take a folder and plain values.
