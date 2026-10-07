### Added

- **Recall's vector arm now reads through the store port, so hybrid and physics recall can run on a store other than hippo.db.** `HippoStore` gains four optional reads, `embeddingIndexState`, `storedVectors`, `nearestEntries` and `physicsParticles`, exported together as the `VectorReads` interface. `sqliteStore` answers them with the queries recall ran before. `GET /v1/memories` and MCP `hippo_recall` hand the request's store to hybrid and physics search. When an embedding provider is set, a store without the four reads answers 501 `store_not_ported` and logs the reads it lacks. With no provider, recall still runs on BM25 alone.
- **`hippo-memory/server` exports `rankVectorRows`, `decodeVector`, `bufferToFloat32` and `EMBEDDING_MODEL_META_KEY`.** An add-on store decodes and ranks vectors with the code hippo.db uses, so it returns the same ids in the same order. The query is rounded to float32, scores are computed in float64, and a tie goes to the smaller id.
- **A stale embedding index under another store names the right fix.** Recall still falls back to BM25 with a warning, and the warning now says to run `hippo embed` on the SQLite store and rebuild that store's database from it.

### Fixed

- **`decodeVector` no longer throws on a Node `Buffer` that starts at an odd byte offset.** Its fallback copied with `slice()`, which on a `Buffer` returns a view at the same offset. It now copies into a new `Uint8Array`.

### Tests

- **`tests/recall-vector-reads-parity.test.ts` runs hybrid and physics recall on hippo.db and on an in-memory store that decodes and ranks with the exported pieces.** It covers `GET /v1/memories` and MCP `hippo_recall`, with a local OpenAI-compatible embeddings server as the provider. Replies, rows written and provider calls match. The seed has another tenant's rows holding the query's own text, archived, superseded and private rows, a vector with no row, an 8-dim vector under the same model, a zero vector and an exact tie. The fallback cases are an empty index, a stale model and a provider that answers 500.
- `tests/store-port-sqlite.test.ts` checks each new `sqliteStore` read against the hippo.db function behind it, and that a hybrid or physics recall over `serve()` still opens hippo.db once. `tests/server-other-store-fails-closed.test.ts` checks the 501 and the log line for a store without the reads. `tests/embedding-vectors-sqlite-import.test.ts` covers `rankVectorRows` and the odd-offset `Buffer`.
