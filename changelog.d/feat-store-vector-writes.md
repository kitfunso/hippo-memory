### Added

- **Writing embeddings now goes through the store port, so embed on write and the backfill can run on a store other than hippo.db.** `HippoStore` gains an optional `vectorWrites` member, the exported `VectorWrites` interface, with two methods. `entriesWithoutVector` pages through memories that have no vector for a model, by id, across every tenant or one. `writeVectors` stores one tenant's vectors in one transaction, seeds a particle only where a memory has none, and records the model. It drops the old index first only when another model built it and the write sets `replaceIndex`, which only the rebuild in `embedAll` does. Without the flag, a write under another model keeps nothing and returns `modelMismatch: true`, so a process that read the index before another process rebuilt it cannot wipe that rebuild. A store must also delete a memory's vector and particle when the memory is deleted, as hippo.db does by trigger and foreign-key cascade. Core still computes every vector with the embedding provider; the store only keeps it. `sqliteStore` sets the group with the queries hippo.db runs. The methods need plain SQL and float blobs only, no pgvector.
- `hippo-memory/server` also exports `VectorWrites`, `VectorWrite`, `VectorRowWrite`, `VectorWriteResult`, `VectorBackfillQuery`, `encodeVector`, `float32ToBuffer` and `replacesIndex`, the rule for when a write drops the old index.

### Changed

- **`embedMemory` and `embedAll` take an optional `store` and, when given one, embed through its `vectors` and `vectorWrites` groups and never open hippo.db or take the lock file in `hippoRoot`.** A store without both groups makes `embedAll` reject with `StoreNotPortedError`; `embedMemory` resolves and logs the skip, as it does for any embedding failure. Without a store both run on hippo.db exactly as before.
- With a store, embedding differs from the hippo.db path on purpose:
  - A rebuild writes page by page. If the provider fails part way, the old index is already gone and the new one is partly built; hippo.db keeps the old index whole until the new one is complete. The next run finishes the rest.
  - That next run is an ordinary backfill, so the memories it embeds get no particle. hippo.db's rebuild seeds a particle for every memory at once.
  - `embedAll` does not prune vectors of deleted memories. It relies on the store deleting them with the memory.
  - The model meta row is set only by a write that keeps at least one vector. hippo.db's `embedAll` sets it on every run, even when there is nothing to embed.
  - `writeVectors` writes no audit row, as embedding on hippo.db never wrote one.
  - `embedMemory` does not rebuild the index when another model built it. It skips the write and warns once that `hippo embed` rebuilds it; on hippo.db, `embedMemory` rebuilds.
  - If another process rebuilds the index under its own model while `embedAll` runs, `embedAll` stops and rejects with an error that says to run `hippo embed`, rather than paying the provider for pages no write would keep.

### Tests

- **`tests/vector-writes-conformance.test.ts` runs both `VectorWrites` methods on hippo.db and on an in-memory store over a two-tenant fixture, and checks that values, errors and audit rows match.** It covers tenant scoping, paging, a vector under another model, the limit clamp and its error, rows another tenant owns or with empty or non-finite vectors, no drop when nothing is writable, particles kept and added, a one-row write under another model refused without `replaceIndex` while the other tenant's vectors stay, and the index drop with it.
- `tests/embed-writes-through-store.test.ts` checks that `embedAll` and `embedMemory` with a store open no hippo.db in `hippoRoot`, that `embedAll` through `sqliteStore` leaves the same vectors, model and particles as the path without a store on a first backfill and on a model change, that pages written before a provider failure stay, that `embedAll` stops when another process rebuilds mid-run, that `embedMemory` leaves an index another model built alone even when its read of the index is stale, and that a store without the groups is refused.
