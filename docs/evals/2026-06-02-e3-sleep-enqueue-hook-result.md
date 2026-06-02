# E3 sleep enqueue-hook — verify result (DESCRIPTIVE)

- Date: 2026-06-02
- Episode: 01KT4CP9K6BEQ4ESCTFV49A8DX (/dev-framework-rl, backend)
- Feature: auto-rebuild the entity/relation graph during `hippo sleep` (producer
  `markGraphDirty` on every graph-source E2 mutation + a fault-isolated drain
  phase in `api.sleep`), so `recall --hops` and cross-object `references` edges
  run on fresh data without a manual `hippo graph extract`.

This is verify-stage evidence: correctness is structural ("the graph after sleep
equals a manual extract, and the queue is drained"), not a tuned metric.

## Runtime evidence

| check | result |
|---|---|
| `tests/graph-sleep-hook.test.ts` (new) | **13/13 pass** (real SQLite, no mocks) |
| full suite `npx vitest run` | **2435 pass / 4 skip / 1 fail** |
| the 1 failure | `server-concurrency.test.ts` `ECONNRESET` under full-suite load — the known environmental flake; **passes in isolation** (re-ran: 1/1 pass); zero references to this diff |
| `scripts/check-graph-writes.mjs` | **green** — all graph writes still funnel through `src/graph.ts` |
| `npm run build` (tsc + benchmarks tsc) | **clean** |

## What the 13 tests lock

1. `saveDecision` enqueues one pending queue item for its tenant.
2. `markGraphDirty` is fail-soft: a bogus/null memoryId neither throws nor enqueues.
3. Coalesce: 3 decisions → 3 pending items, one tenant.
4. `close*` and project-brief `refresh` also enqueue (dirty on every graph-source mutation).
5. `sleep` rebuilds the dirty tenant's graph and drains its queue (`graph: {tenants:1, entities:2, relations:0}`).
6. Only dirty tenants rebuild — a second sleep with no new writes reports no graph work.
7. Multi-tenant: two dirty tenants both rebuild + drain; entities stay tenant-isolated.
8. dryRun: no rebuild, no drain (items stay pending), no `graph` field.
9. Snapshot watermark: an item enqueued DURING the rebuild stays pending.
10. Fault isolation: one tenant's `extractGraph` throwing leaves it pending, others drain, sleep does not reject.
11. End-to-end: a `supersedes` edge is built by sleep with NO manual extract.
12. Redaction: `redactSleepResultForCaller` zeroes `graph.*` for a non-loopback non-self caller; loopback passes through.
13. Clean store: sleep with no graph-source objects omits the `graph` field.

## Notes / honest caveats

- **Audit interaction (pre-existing, by design):** sleep's audit phase (Phase 3)
  removes too-short "junk" memories before the graph drain (Phase 6). A decision
  whose mirror is removed becomes invisible to the graph (null mirror skipped by
  `extractGraph`). This is correct — the graph indexes *post-consolidation* state
  — and is the documented "forgotten-mirror staleness" class, not introduced here.
  (Surfaced during test authoring: short test-decision texts were being audited
  away; tests now use realistic texts that survive, matching the passing tests.)
- **Per-store scope:** the drain runs on whichever `hippoRoot` is slept (local is
  primary); the global store's graph refreshes when the global store is itself
  slept/extracted. Out of scope for this episode.
- **No migration** — the `graph_extraction_queue` substrate already shipped in E3.3.

## Cross-model review (codex `review --commit`)

- **Round 1 — [P1] dirty-tenant snapshot vs. mirror deletion: FIXED.** The queue
  rows are FK'd `ON DELETE CASCADE`; an earlier sleep phase deleting a queued
  mirror (e.g. dedup removing a near-duplicate superseding decision) would drop
  the tenant from a drain-time load and leave its graph stale. Fixed by
  snapshotting dirty tenants at the start of sleep, before any memory-deleting
  phase. Locked by test #14.
- **Round 2 — [P2] snapshot fail-soft: FIXED.** The early snapshot ran outside
  the graph try, so a `loadPendingExtractionTenants` failure aborted core sleep —
  breaking fail-soft. Fixed: the snapshot is wrapped so a queue-read failure skips
  graph refresh (recovered next sleep) without aborting consolidation. Locked by
  test #15.
- **Round 2 — [P2] serialize concurrent tenant rebuilds: FIXED (atomic rebuild).**
  Two `hippo sleep` runs overlapping on the same `hippoRoot` could both run
  `extractGraph` (a non-atomic clear-then-reinsert) and transiently duplicate
  derived graph rows. Fixed at the root: `extractGraph` now reads all source rows
  first (own connections), then runs clear + every insert inside ONE
  `runGraphRebuildTransaction` (`BEGIN IMMEDIATE`) on a single connection. SQLite's
  single-writer serializes concurrent rebuilds (the second waits, then re-derives
  cleanly — no duplicate rows), and a throw mid-rebuild now ROLLS BACK the clear
  (also closing the latent "throw-after-clearGraph bricks the rebuild" edge). The
  reads are preloaded because holding the write transaction while opening a second
  read connection dead-locks (`database is locked`). New `graph.ts` primitives:
  `runGraphRebuildTransaction` + an optional `txDb` on `clearGraph`/`insertEntity`/
  `insertRelation` (existing callers unchanged). Locked by test #16 (rollback-on-throw)
  + the full 71-test graph suite green. Lint (`check-graph-writes`) still green —
  all graph writes funnel through `graph.ts`.
- **Round 3 — [P2] committed save unflagged on post-commit mirror failure: FIXED.**
  `writeEntry` commits the DB row (`RELEASE SAVEPOINT`) then writes markdown
  mirrors; the producer `markGraphDirty` ran *after* `writeEntry` returned, so a
  mirror-write throw after the commit skipped it, leaving a committed
  decision/policy/note/brief with no pending queue row until the next mutation /
  manual extract. Fixed by adding a `writeEntry` **`afterCommit`** hook that runs
  post-commit but pre-mirror; the 4 `save*` paths mark the graph dirty there, so a
  later mirror failure can no longer skip it. (`close*` paths already mark dirty
  after their own `COMMIT` and write no mirror.) The enqueue runs on the
  committed, idle `writeEntry` connection, so its own handle does not contend
  (full suite green, no `database is locked`). The only residual window — a
  process crash between the `RELEASE SAVEPOINT` and the enqueue (microseconds) —
  is inherent to fail-soft and self-heals on the next mutation / manual extract.
