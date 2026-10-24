### Changed

- **`MemoryEntry` no longer carries `bm25_score`, the raw FTS5 rank of a store search row.** The rank still orders the rows; a hit's score is on `SearchResult` (`score` and `bm25`). `MemoryWire` keeps the optional key, which 3.0 never writes or reads. See docs/UPGRADING-3.0.md.
