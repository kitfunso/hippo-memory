### Changed

- **Internal:** `hippo embed` status and `hippo dedup` count by id instead of decoding every vector or loading every row.
- **Internal:** `hippo dag` looks up each summary's children in one index instead of filtering the store once per summary.
- **Internal:** the MCP stdio loop joins pending input only when a frame can have ended, so a large frame split over many chunks is no longer re-copied per chunk.
- **Internal:** `hippo learn` and auto-share write their rows in one transaction instead of one per row; auto-share reuses the rows it already read.
