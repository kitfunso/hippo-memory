### Changed

- **Internal:** capture code no longer opens the store or names a connection type. The write gate (`gated-write`) and the compaction record, spool and replay moved into `src/store`, and capture calls store functions that take a folder and plain values.
