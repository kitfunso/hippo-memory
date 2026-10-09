### Changed

- **Internal: the graph write and queue SQL sits in the store layer.** The statements that write `entities`, `relations` and `graph_extraction_queue`, and the reads a graph rebuild diffs against, moved from `src/graph` to `src/store`. No behaviour changes.
