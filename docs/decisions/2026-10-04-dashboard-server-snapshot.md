# Dashboard aggregates on the server from one cached snapshot

Date: 2026-10-04
Status: accepted
Links: PR #441; approved B Ledger mockup; #426 (`memory_vectors`, schema v52)

## Context
The Health view replaces the 3D Living Map. The old server sent every memory and every raw
embedding to the browser, which grouped and counted them there.

## Constraints and evidence
- At 100,000 memories the old `embeddings.json` was 361 MB; parsing it took 1.1 s at 821 MB RSS.
- One full snapshot build of that store takes 1.97 s; a warm overview read takes 0.4 ms and
  carries 19.2 KB (scale check in PR #441, schema v52).
- `memory_vectors` has no tenant column and no foreign key to memories.

## Decision
The server builds one snapshot of the live store for the requested tenant, grouped by `origin_project`, and
serves summaries and pages from it. No response carries a vector. A read reuses the snapshot
until an outside commit is older than `COALESCE_MS` (10 s) or `TTL_MS` (5 min) passes; a
dashboard write or `?fresh=1` rebuilds at once. Embedding coverage counts live, tenant-filtered
memories that have a row in `memory_vectors`, never the raw row count.

## Alternatives considered
- Keep aggregating in the browser: hundreds of MB per load at 100k memories.
- Aggregate in SQL per request with no cache: about 2 s per read at 100k memories.
- Count all `memory_vectors` rows: counts superseded and deleted memories, and other tenants.

## Consequences
- An outside write can take up to 10 s to show; dashboard writes show on the next read.
- The snapshot holds about 62 MB of heap at 100k memories.
- Removed routes: `/api/memories`, `/api/embeddings`, `/api/stats`, `/api/conflicts`,
  `/api/peers`, `/api/config`, `/api/star/:id`.

## Reconsider when
- A store passes about 500k memories, where a linear guess puts the build near 10 s.
- `memory_vectors` gains a tenant column or a foreign key to memories.
