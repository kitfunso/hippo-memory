# Vector graph file (wave 1020j)

Goal: every nearest-row read searches a graph (src/db/vector-store.ts:350).

## The file

`vector-graph-<length>.bin` beside hippo.db, one per vector length. No migration. Little-endian:

- Header: magic, version 1, length, M, node count, entry, top level, high-water rowid, live rows; a JSON block with
  `storedModel(db)` and the rowid and id of the 32 highest-rowid nodes.
- Node records of one size: rowid, level, flags (replaced before the save), link count, upper-links offset, 2M
  layer-0 links, int8 vector. Length 384, M 16: 528 bytes, about 5.3 MB per 10k.
- Upper links: M slots and a count per level above 0.

SQL admits candidates by rowid and re-ranks them on the stored floats (src/db/vector-graph-rows.ts:193).

## Writers

- The store worker, after a build or catch-up.
- Sleep (`hippo sleep`, the sleep child) after its phases, not on a dry run, so a store with no server gets one.
- Both save only on drift: no usable file, or rows above the stamp plus stale nodes over 10% of its nodes.
- No build under 1,000 vectors or over `vectorGraph.maxVectors` (the cap bounds build heap).
- writeFileAtomic gains bytes, a mode (hippo.db's bits) and a no-in-place option. EPERM or EBUSY after its rename
  retries: skip, one info line. Other errors: one warn line; sleep goes on.

## Reader

A `VectorIndex` per store root, used off the worker and by a worker whose graph is building. Each query:

1. Opens and validates the file; closes it after the search (a held handle blocks a Windows rename).
2. Finds r, the highest rowid still holding what the graph read, by the `intactRowid` walk of 32 rows against the
   stored ids (SQLite reuses a deleted top rowid).
3. Searches through a view: links, and int8 vectors via `vectorOf` (src/db/vector-graph.ts:39). One positional read
   per visited record, cached for that search; nothing loads the whole file. Admits rowid at most r, unflagged.

## Rows above the stamp

`matches` returns `{ matches, coveredRowid: r }`. topVectorMatches seeds its heap with them, then pages rows above r
by rowid (src/db/vector-graph-rows.ts:80), scored exactly. The heap keeps one entry per id (latest read wins).
Deleted rows drop out at admission. A walk that visits every node answers with what it admitted.

The worker drops "more than 32 new rows: scan all" (src/db/vector-graph-index.ts:30): behind, it answers rows up to r
from its graph and catches up in the background.

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
graph's at NOISE=2.

Unchanged: the cap and the hop to a running server.
