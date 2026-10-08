### Fixed

- **`hippo serve` no longer runs WAL checkpoints inside a request.** A worker thread now checkpoints a served store, so a slow disk flush stalls the worker and not the event loop. Before, about one recall in three ran four `fsync` calls, and on a slow disk each of those requests took 100 to 340 ms.
- **A recall no longer truncates `stats.json`.** The file is now overwritten in place. A truncate waits for the previous write of the file to reach the disk, which stalled recalls for 50 to 250 ms on a slow disk.

### Changed

- **A served store copies its WAL into `hippo.db` about every 32 responses, where it was about every 3.** `synchronous = NORMAL` is unchanged, and a crash of the process still loses nothing. After a power loss, the commits since the last checkpoint can be lost, as before; that window is now about 1,100 WAL pages, close to SQLite's default of 1,000. The CLI and the stdio MCP server checkpoint as before.
- **The WAL of a served store can grow to 4,000 pages (16 MB) under constant load.** At that size a request checkpoints the WAL itself, as every request did at 100 pages before. `hippo serve` still checkpoints and removes the WAL when it stops.
