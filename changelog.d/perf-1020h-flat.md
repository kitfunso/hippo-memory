### Added

- **`hippo recall`, `hippo context` and the prompt hooks ask a running `hippo serve` for the nearest vectors.** On a store that the server holds with 1,000 or more vectors, the CLI asks the server's vector graph through the new route `POST /v1/vectors/nearest` instead of scoring every stored vector itself. It prints the same output as before. A server that does not answer in 1 s costs one warn line, then the local scan.
- **The new config key `vectorGraph.maxVectors` caps the vector graph.** The default is 200,000 vectors, about 400 MB of heap. Past the cap the store logs one warn line with the count and scans instead.

### Changed

- **A served store searches its vector graph from 1,000 stored vectors, down from 20,000.** The graph beat the scan at p50 and p95 from 1,000 vectors on, and gave the same top 10 as the exact scan at 1,000 to 5,000 vectors. docs/ARCHITECTURE.md has the bench.
- **The nearest-vector scan reads 1,024 vectors at a time and keeps only the best matches.** Its memory no longer grows with the store.
- **Sleep and its batch writes read tombstones and live rows in batches.** The retired-text check reads each tenant's tombstones once a page. A flush reads the live rows and tombstones of a window of up to 500 writes at a time, where it read them once a row.
- **A page of memories over every tenant is one query.** It was one query per tenant per page.
- **A mention read on a store with full-text search runs its full-text hits and its non-ASCII rows as two reads.** Only the non-ASCII read checks each row's text, and it stops at the last hit when the hits fill the page.
- **A wait on another process's embedding lock backs off from 50 ms to 1 s between tries.** It keeps the same 10 s limit.
- **Store-kit stores add `consolidation.rejectedDigests` and answer `embeddingIndex.summary()` with a vector count.** docs/UPGRADING-3.0.md has the rows.
- **CI fails when the 1k-memory p99 recall bench passes 40 ms on its fastest round.** It only reported the number before.
