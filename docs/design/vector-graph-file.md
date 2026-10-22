# Vector graph file (wave 1020j)

Goal: every nearest-row read searches a graph (src/db/vector-store.ts:350).

## The file

`vector-graph-<length>.bin` beside hippo.db, one per vector length. No migration. Little-endian:

- Header: magic, version 1, length, M, node count, entry, top level, high-water rowid, live rows, record size and
  upper-links size; a JSON block with `storedModel(db)`.
- Node records of one size, in rowid order: rowid, an FNV-1a hash of the memory id, level, flags (replaced before the
  save, or an older node of a reused rowid), link count, upper-links offset, 2M layer-0 links, int8 vector with its
  own scale (cosine ignores the scale). Length 384, M 16: 532 bytes, 5.1 MB per 10k measured.
- Upper links: M slots and a count per level above 0.

SQL admits candidates by rowid and re-ranks them on the stored floats (src/db/vector-graph-rows.ts:193).

## Writers

- The store worker, after a build or catch-up.
- Sleep (`hippo sleep`, the sleep child) after its phases, not on a dry run, so a store with no server gets one.
- Both save only on drift: no usable file, or rows above the stamp plus stale nodes over 10% of its nodes.
- No build under 1,000 vectors or over `vectorGraph.maxVectors` (the cap bounds build heap).
- writeFileAtomic gains bytes, a mode (hippo.db's bits) and a no-in-place option. EPERM or EBUSY after its rename
  retries: skip, one info line. Other errors: one warn line; sleep goes on.
- The sleep build reads 1,024 rows a statement on a read-only handle and gives a turn every 10 ms, so it holds no
  write lock and no snapshot across turns. The sleep child builds after its reply, so
  the caller never waits on it, and stops 5 s before the sleep's deadline.

## Reader

A `VectorIndex` per store root, used off the worker and by a worker whose graph is building. Each query:

1. Opens and validates the file, reads it whole in one call and closes it at once (a held handle blocks a Windows
   rename). One positional read per visited record cost about 2,900 reads a query at 10k vectors.
2. Finds r, the highest rowid still holding what the graph read: of the newest 32 rows at or under the high-water
   rowid, the first whose node (binary search on rowid) is unflagged and has its memory id's hash (SQLite reuses a
   deleted top rowid).
3. Searches through a view: links, and int8 vectors via `vectorOf`, decoded as the walk reaches each record. Each
   link, offset and level is bounds-checked as it is read; a bad one ends the read with one warn line and a scan.
   Admits rowid at most r, unflagged.

## Rows above the stamp

`matches` returns `{ matches, coveredRowid: r }`. topVectorMatches seeds its heap with them, then pages rows above r
by rowid (src/db/vector-graph-rows.ts:80), scored exactly. The heap keeps one entry per id (latest read wins).
Deleted rows drop out at admission. A walk that visits every node answers with what it admitted: `searchView`
returns `visited`, the nodes its bottom layer reached.

The worker drops "more than 32 new rows: scan all" (src/db/vector-graph-index.ts:30): behind, it answers rows up to r
from its graph and catches up in the background. A worker whose graph is building, dropped or over the cap reads the
file. A re-embed (`INSERT OR REPLACE`) always gives the row a new rowid above every other, so no node is updated in
place; its old node's rowid is gone, so it counts as stale.

## Stale or missing: scan

The reader returns undefined and the full scan runs when:

- the file is missing (no log), short, or has a bad magic, version or link (one warn line);
- the model differs from `storedModel(db)`, or no file has the query length;
- the intact walk finds no row;
- stale nodes (nodes minus rows up to r, one count on the key index) pass 10%.

## Tests (real SQLite store, 1,500 clustered vectors)

- File results equal the worker graph's and the scan's: all rows, one tenant, one scope.
- After 100 added rows, 5% deleted, a re-embed and reused top rowids: equal to the scan.
- 20% deleted, model change, other length, missing, truncated or bad file: undefined.
- EBUSY on rename: no file, one log line, old file intact.
- A worker 33 rows behind answers graph plus scan.

## Timing

`MODE=oneshot` in benchmarks/vector-index/bench.mjs: one recall in a fresh process at 10k and 50k, with and without
the file (p50, p95), plus file size and recall@10. Gate: faster at both sizes; recall@10 within 0.002 of the worker
graph's at NOISE=2. Measured (docs/ARCHITECTURE.md, src/db/vector-graph-file.ts): file p50 28.4 ms against 61.9 at
10k and 29.7 against 199.6 at 50k, recall@10 1.000 at both.

Unchanged: the cap and the hop to a running server.
