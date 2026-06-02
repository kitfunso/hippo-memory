# E3 sleep enqueue-hook — auto-rebuild the graph during `hippo sleep`

- Date: 2026-06-02
- Episode: 01KT4CP9K6BEQ4ESCTFV49A8DX (/dev-framework-rl, backend)
- Status: Draft (not yet engineering-reviewed)

## Problem

The E3 graph layer (`entities`/`relations`) is a pure derived function of the
consolidated E2 objects (decision/policy/customer_note/project_brief). It is
rebuilt only by the **manual** `hippo graph extract` command. So after any
`hippo decide` / `hippo policy` / brief refresh, the graph silently goes stale,
and `recall --hops N` + the E3.1 cross-object `references` edges operate on
stale data until someone re-runs extract by hand. E3.3 built a
`graph_extraction_queue` table + an `enqueueExtraction`/`loadExtractionQueue`/
`markExtractionProcessed` API **specifically as the interface for a deferred
`hippo sleep` hook** (see `src/graph.ts:458` docstring) — but the hook was never
wired. No production code calls `enqueueExtraction` today (test-only).

## Goal

Wire both halves so the graph auto-refreshes as part of the normal consolidation
cycle, with **no manual extract** needed in steady state:

- **Producer** — every mutation of a graph-source E2 object marks its tenant
  dirty by enqueuing into `graph_extraction_queue` (fail-soft).
- **Consumer** — `hippo sleep` drains the pending queue: for each dirty tenant,
  run the existing `extractGraph` full rebuild, then mark its drained items
  processed.

`hippo graph extract` stays as the immediate-refresh escape hatch.

## Design

### Producer — `markGraphDirty` helper + 9 call-sites

New helper (in `src/graph.ts`, the sole sanctioned graph writer):

```ts
/** Fail-soft: enqueue the tenant for graph re-extraction. NEVER throws into the
 *  caller — a graph-dirty signal failing must not abort a core E2 write. */
export function markGraphDirty(hippoRoot: string, tenantId: string, memoryId: string | null): void {
  if (!memoryId) return;                       // forgotten mirror -> nothing to enqueue
  try { enqueueExtraction(hippoRoot, tenantId, memoryId); }
  catch (err) { /* log at debug; staleness is recoverable via next sleep / manual extract */ }
}
```

Called from all **9** graph-source mutation sites (audit-enumerated; supersede is
internal to the `save*` calls, so one call per site covers create+supersede):

| Module | Functions |
|---|---|
| `decisions.ts` | `saveDecision`, `closeDecision` |
| `policies.ts` | `savePolicy`, `closePolicy` |
| `customer-notes.ts` | `saveCustomerNote`, `closeCustomerNote` |
| `project-briefs.ts` | `saveProjectBrief`, `closeProjectBrief`, `refreshBrief` |

Each passes the object's mirror `memoryId` (still consolidated-kind on close —
the close path does not mutate the mirror, only the row `status`). The enqueue is
a per-tenant **dirty flag**, not a unit of work: many enqueues between sleeps
coalesce to one rebuild.

**Why fail-soft is load-bearing:** these are core commands. An enqueue throwing
(e.g. a mirror that is somehow not consolidated-kind, a race-deleted memory) must
not break `hippo decide`. Graph staleness is recoverable; a broken write is not.
The `catch` logs at **warn** (not silent) so a *systematic* enqueue failure is
operator-visible, and a happy-path test (producer test #1) fails if enqueue ever
stops working — staleness is recoverable but not silently masked.

**CRITICAL — post-commit placement (atomicity, not deadlock).** `markGraphDirty`
is called **post-commit**, never inside the write transaction. The driver is the
**fail-soft requirement**, not a lock deadlock: an in-transaction enqueue would be
*atomic* but a throw would roll back the whole E2 write — the opposite of
fail-soft. So the enqueue is deliberately **post-commit and non-atomic**: a crash
in the µs window between the write committing and the enqueue leaves the tenant
dirty-but-unflagged, which the next mutation or a manual `graph extract` recovers.
Fail-soft beats atomic here. (Note: the DB runs WAL + `busy_timeout=5000`
[db.ts:1907-1908], so `enqueueExtraction`'s second `openHippoDb` connection does
NOT hard-deadlock against a *committed* writer — the lock is already released; the
post-commit rule is about transaction semantics, not lock contention.)

Placement differs by mutation shape (audit-confirmed):
- **`save*` (writeEntry-based):** `writeEntry` opens, commits, and **closes** its
  own connection before returning, so call `markGraphDirty` right after the
  `writeEntry(...)` call returns (connection already closed) — clean.
- **`close*` (manual `openHippoDb` + `BEGIN IMMEDIATE`, returns from inside `try`,
  `closeHippoDb` in `finally`):** there is no post-`finally` tail to use, so call
  `markGraphDirty` **after `db.exec('COMMIT')`, immediately before the `return`**.
  The COMMIT has released the write lock, so the second connection proceeds
  (busy_timeout covers any transient). `refreshBrief` delegates to
  `saveProjectBrief`, so the save\* placement covers it.

Placing the call inside the mutation function (vs at each CLI/HTTP/MCP call-site)
keeps it DRY — every caller gets the dirty-flag automatically.

### Consumer — drain phase inside `api.sleep`

The rebuild belongs with consolidation (root location), so both CLI `hippo sleep`
and HTTP `/v1/sleep` / MCP refresh the graph — not bolted onto `cmdSleepCore`
(which would leave HTTP callers stale). New late phase in `api.sleep`, after the
existing consolidate/dedup/audit/share/ambient phases:

1. `const tenants = loadPendingExtractionTenants(hippoRoot)` — new graph.ts read,
   `SELECT DISTINCT tenant_id FROM graph_extraction_queue WHERE status='pending'`.
2. For each dirty tenant (fault-isolated per tenant):
   - **Snapshot** the pending item ids first (`loadExtractionQueue(..., {status:'pending'})`).
   - If `dryRun` → record a "would rebuild" detail, do NOT extract, do NOT mark.
   - Else → `extractGraph(hippoRoot, tenant)` (full idempotent rebuild), then
     `markExtractionProcessed` for **only the snapshotted ids** (items enqueued
     during the rebuild stay pending → caught next sleep; no lost-update race).
   - A per-tenant extract throw → leave that tenant's items pending, push an error
     detail, continue to the next tenant. The graph phase never aborts sleep.

### Reporting + redaction

Add an optional structured field to `SleepResult`:

```ts
graph?: { tenants: number; entities: number; relations: number };
```

`tenants`/`entities`/`relations` are **cross-tenant aggregates**, so they belong
in `redactSleepResultForCaller` (sleep-redact.ts) alongside the existing
`deduped`/`audit`/`ambient` counters it zeroes. **Honest status:**
`redactSleepResultForCaller` is currently layered-defence with **zero callers** —
`/v1/sleep` (server.ts) sends the raw `SleepResult` and is loopback-only-gated
upstream, so today `deduped`/`audit`/`ambient` already egress unredacted over
HTTP. Adding `graph.*` to the redact function keeps it consistent for when the
non-loopback serving gate lands (per the file's own D3 sequencing note); it
introduces **no new leak vs. the status quo** and does NOT imply the HTTP path is
redacted today. `renderSleepResult` (cli.ts) prints a one-line summary
(`Graph: rebuilt N tenants (X entities, Y relations)`) when `graph` is present
and non-zero. Under `dryRun`, `tenants` reflects dirty tenants but
`entities`/`relations` stay 0 (nothing rebuilt).

### Testability — `SleepPhases` DI seam

Add `extractGraph` (and the new `loadPendingExtractionTenants`) to the
`SleepPhases` interface + `DEFAULT_SLEEP_PHASES` so
`tests/api-sleep-phase-faults.test.ts`-style tests can inject a throwing
extractor and assert the graph phase is fault-isolated (sleep still completes;
the failing tenant's items remain pending).

## New / changed surface

- `src/graph.ts`: `markGraphDirty` (fail-soft producer), `loadPendingExtractionTenants` (DISTINCT-tenant read).
- `src/api.ts`: `SleepResult.graph?`, `SleepPhases` += `extractGraph`/`loadPendingExtractionTenants`, new graph-drain phase in `sleep()`.
- `src/sleep-redact.ts`: redact `graph.*`.
- `src/cli.ts`: `renderSleepResult` prints the graph line.
- `src/decisions.ts`, `policies.ts`, `customer-notes.ts`, `project-briefs.ts`: `markGraphDirty` call at each of the 9 sites.
- **No migration** — `graph_extraction_queue` already exists (E3.3).

## Test plan (real SQLite, temp dirs — no mocks, no external DB)

New `tests/graph-sleep-hook.test.ts`:
1. Producer: `saveDecision` enqueues one pending queue item for its tenant.
2. Producer fail-soft: enqueue failure (inject) does NOT throw out of `saveDecision`.
3. Producer coalesce: 3 decisions → 3 pending items, all same tenant.
4. Close enqueues (dirty on close); refreshBrief enqueues.
5. Consumer: after `sleep`, the graph is rebuilt (entities present) and the
   tenant's queue items are `processed`.
6. Consumer dirty-only: a tenant with no pending items is NOT rebuilt (queue empty → skip).
7. Multi-tenant: two dirty tenants both rebuilt + drained; tenant isolation holds.
8. dryRun: `sleep --dry-run` does NOT rebuild and does NOT mark processed (items stay pending); `graph.tenants` reported, entities/relations 0.
9. Snapshot race: an item enqueued after the snapshot stays pending after drain.
10. Fault-isolation: an injected `extractGraph` throw for tenant A leaves A pending, sleep completes, tenant B still drained.
11. End-to-end: `saveDecision` (no manual extract) → `sleep` → `recall --hops 1` traverses the freshly-built edge.
12. Redaction: `redactSleepResultForCaller` zeroes `graph.*` for a non-loopback non-self caller; loopback passes through.
13. SleepResult shape unchanged when no tenant is dirty (`graph` omitted or zero).

Plus: existing sleep tests (`api-sleep*.test.ts`) still green; `npm test` full
suite; `scripts/check-graph-writes.mjs` green (all graph writes still funnel
through graph.ts).

## Out of scope (explicit)

- Real-time graph (the graph refreshes at **sleep**, not on every write — manual
  `graph extract` remains for immediate refresh). This is the intended contract.
- Incremental/partial extraction (extractGraph is a full idempotent rebuild; the
  queue is a dirty flag, not a work unit).
- New entity source types (incident/process/skill/prediction) — still the
  deferred semantic-relations follow-up; the 9 call-sites cover exactly today's
  4 graph-source object types.
- Per-tenant scoping of the rest of `api.sleep` (the open TODOS item) — the graph
  phase is per-dirty-tenant, but consolidation stays whole-hippoRoot as today.
- **Global-store graph.** The drain operates on whichever `hippoRoot` is being
  slept; `markGraphDirty` enqueues into the same root the write happened in
  (local is the primary case). `recall --hops` reads local+global graphs (E3.2),
  but the **global** store's graph refreshes when the global store is itself
  slept/extracted — this hook does not cross-write a remote root's queue. Per-store
  by design; consistent with how `autoShare` (not the E2 tables) is what crosses
  to global.
- **Forgotten-mirror staleness (pre-existing).** A source row whose memory mirror
  is forgotten (memory_id nulled) *without* a `close*` call leaves an active row
  that `extractGraph` skips, with no enqueue. This is a pre-existing class,
  recoverable by the next sleep/manual extract, and consistent with the
  "refresh at sleep" contract — not addressed here.

## Disposition

Deterministic wiring of an already-built, already-tested substrate into the
lifecycle. Ships always-on (the hook is the feature; there is no precision/quality
gate to clear — correctness is "graph matches a manual extract after sleep, queue
drained"). Minor version bump (new behavior, additive `SleepResult` field).
