### Changed

- **Recall on stores with 20,000+ vectors uses an in-memory HNSW graph in the server.** One store worker thread builds the graph in the background from `memory_vectors`, with no migration, and keeps it up to date with each write. A nearest-row read then scores a few hundred vectors instead of every one; until the graph is ready, and in the CLI, hooks and sleep, reads still score every admitted vector.
