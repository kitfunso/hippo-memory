# LC1 — Retrieval-trace persistence (ROADMAP Part IV, Track LC)

Status: Draft (episode 01KZ1FHCK9TPJ14A549PQ03HNF)
Branch: `feat/lc1-recall-trace` (worktree `hippo-wt-lc1`, from origin/master v1.28.0, schema v39)

## Problem

Recall audit rows persist only `{query_hash, query_length, results: <count>}`
(`src/api.ts:962-966`). The returned memory ids, their ranks, and their scores
are never written anywhere, and outcome events do not reference the recall
they judge. The (query -> shown -> outcome) training triple that every Track LC
learned component needs does not exist on disk. `last_retrieval_ids` persists
only the single most recent id set, with no history, no scores, no linkage.

## Goal (from ROADMAP Part IV / LC1)

- Every recall writes a trace row: ids + ranks + scores, per-stage rerank data
  when available.
- Every outcome event references the trace(s) it scores.
- Storage overhead < 5% of DB size; 30 days of dogfood accumulates a
  re-loadable (query, shown, outcome) dataset.

## Design

### Migration v40 — three tables (follows v18 `goal_recall_log` style)

```sql
CREATE TABLE IF NOT EXISTS recall_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT,
  pipeline TEXT NOT NULL CHECK (pipeline IN ('api','cli','context','mcp')),
    -- 'mcp' reserved for the deferred MCP wire-up. Deliberate (critic round-1
    -- noted it as premature): SQLite cannot ALTER a CHECK constraint, so
    -- extending it later means a full table-rebuild migration. One unused
    -- enum value now is cheaper than that rebuild.
  query_hash TEXT NOT NULL,          -- sha256/16, NEVER raw query (audit convention, cli.ts:1532)
  query_length INTEGER NOT NULL,
  result_count INTEGER NOT NULL,
  explain_mode INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_recall_traces_tenant_ts ON recall_traces(tenant_id, ts DESC);

CREATE TABLE IF NOT EXISTS recall_trace_results (
  trace_id INTEGER NOT NULL REFERENCES recall_traces(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'default',  -- denormalized like goal_recall_log (v18
                                              -- precedent): tenant-scoped training queries
                                              -- over the memory index must not need a join
                                              -- back through recall_traces
  memory_id TEXT NOT NULL,           -- NO FK to memories: traces must OUTLIVE forgotten
                                     -- memories (they are LC2's negative class). PRAGMA
                                     -- foreign_keys=ON is real (db.ts:2239), so an FK
                                     -- would either block inserts or cascade-delete
                                     -- exactly the rows training needs. Deliberate.
  result_rank INTEGER NOT NULL,      -- NOT "rank" (SQL keyword; audit rule 10)
  score REAL NOT NULL,
  rerank_json TEXT,                  -- compact RerankStep[] when explain/trace present; else NULL
  PRIMARY KEY (trace_id, result_rank)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_recall_trace_results_tenant_memory
  ON recall_trace_results(tenant_id, memory_id);

CREATE TABLE IF NOT EXISTS recall_trace_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id INTEGER NOT NULL REFERENCES recall_traces(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  outcome TEXT NOT NULL CHECK (outcome IN ('positive','negative')),
  memory_ids_json TEXT NOT NULL      -- ids actually credited by this outcome event
);
CREATE INDEX IF NOT EXISTS idx_recall_trace_outcomes_trace ON recall_trace_outcomes(trace_id);
```

Outcome linkage lives in its own append-only table, NOT in audit metadata:
`audit_log` is pruned by `pruneAuditLog` (op `audit_prune`), and pruning must
never erase training data. No new audit op is added anywhere — the
`AuditOp` union + `VALID_AUDIT_OPS` in cli.ts:7096 + server.ts lockstep
(v1.11.5 CRIT A rule) stays untouched.

### New module `src/recall-trace.ts` — the single producer

One shared writer called from every instrumented path (no per-site SQL):

- `writeRecallTrace(db, input): number | null` — inserts the trace row + its
  result rows in ONE transaction on the connection it is handed. Per-result
  rerank steps are sanitized before persisting: only `{stage, multiplier,
  scoreBefore, scoreAfter}` survive (F3 privacy fix, final review round) —
  `note` and any other free-form field (e.g. the CLI goal-boost step's
  matched-tag text) are stripped, allowlist not denylist, so raw user
  content can never leak into `rerank_json`.
  `writeRecallTraceAtRoot(root, input)` — convenience wrapper that opens a
  fresh short-lived connection, writes, closes, and returns the trace id (or
  null). **Connection policy is per-site, stated explicitly** (plan-eng-critic
  round-1 catch — the original blanket "same handle everywhere" claim was
  false at getContext):
  - `api.recall`: caller's already-open handle (the trace write sits inside
    the existing try/finally that owns `db`, next to the audit emit).
  - `api.getContext` and `cmdRecall`: `writeRecallTraceAtRoot` — a fresh
    short-lived connection AT the `last_retrieval_ids` write block. The audit
    handles at getContext (~2390-2412) are already closed by then, and that
    block's own convention is per-call handles (`writeEntry`, `saveIndex`).
    This placement is REQUIRED for correctness, not just style: it runs after
    the post-limit slice (~2417) and origin/category annotation (~2424), so
    the trace captures the entries actually returned — writing earlier
    against the still-open audit handle would persist the pre-limit,
    pre-annotation candidate set and silently corrupt the training triple.
  **Fail-soft:** wrapped in try/catch; a trace-write failure must never break
  recall. Loss windows (audit rule 12): (a) crash between recall and trace
  write -> trace lost, accepted, self-healing (next recall traces normally);
  (b) trace INSERT throws -> caught, recall returns normally, unconditional
  `console.error` line (matches the existing fail-soft precedent at api.ts
  ~2843 "api.sleep audit emit failed" — no new debug env var); (c) the fresh
  short-lived connection at getContext/cmdRecall opens only after all read
  work and other writes in the block are complete — short transaction, same
  process, same busy-timeout regime as the block's other per-call handles.
- **`last_trace_id` stamping — atomic lockstep with `last_retrieval_ids`
  (F1 structural fix, final review round; supersedes the original design
  below).** `writeRecallTraceAtRoot` does NOT touch the `last_trace_id` meta
  key — a first-round independent-review fix had it stamp-then-clear on its
  OWN connection, but that was still a second commit relative to
  `last_retrieval_ids`, so a crash between the two writes (or a failed
  second write) could advance one without the other. The fix moves the
  stamp into `store.ts`'s `saveIndex`, which now persists BOTH meta keys in
  ONE transaction (`BEGIN`/`COMMIT`, F1(c)). Callers (`getContext`,
  `cmdRecall`) call `writeRecallTraceAtRoot` FIRST, fold the returned id
  into `localIndex.last_trace_id` (`String(traceId)` on success, `null` on a
  failed trace write), THEN call `saveIndex` once. Call sites that trace
  WITHOUT advancing `last_retrieval_ids` (CLI zero-result, getContext's bare
  empty-result return — see Wire sites) never touch `localIndex` at all, so
  they cannot desync by construction. `readLastTraceId` / `writeLastTraceId`
  standalone accessors were DELETED (F1(e)) — no production caller remained
  once `outcomeForLastRecall` reads `last_trace_id` off the same `loadIndex`
  snapshot it already holds (see Outcome linkage below) and every writer
  goes through `saveIndex`. The strict parse that used to live in
  `readLastTraceId` (trim, `/^\d+$/`, `n>0` — a bare `Number(raw)` let a
  whitespace-only meta value parse as usable `0`, which would reach an
  INSERT as a masked FK violation) now lives in `store.ts`'s
  `parseLastTraceId`, called once inside `buildIndexFromDb` so every
  consumer of `HippoIndex.last_trace_id` gets an already-clean value or
  `null`. `last_trace_id` is still stored EXACTLY like `last_retrieval_ids`
  at the same seven sites (store.ts:69 type, 1118ish load, 1192ish save,
  db.ts meta default, store.ts bootstrap-legacy migration, two empty-index
  defaults).
- `recordTraceOutcome(db, {traceId, tenantId, outcome, memoryIds})` — called
  from the outcome choke point. **F4 validation (final review round):**
  before inserting, the function re-reads the named trace's own
  `tenant_id` and skips (console.error, no throw) if the trace is missing or
  belongs to a different tenant than `input.tenantId` — caller-side state
  (`last_trace_id`, applied outcome ids) can go stale relative to the trace
  it names (a tenant switch mid-session, a race between callers). It then
  intersects `input.memoryIds` against that trace's OWN
  `recall_trace_results.memory_id` set and records ONLY the intersection —
  an id that was never actually in this trace's result set is dropped
  rather than recorded as a false credit. If the intersection is empty, no
  row is written at all.

JSDoc on all exports (AGENTS.md). All additive; no public CLI or API surface
changes; no new CLI flags (so no `choices`/DB-CHECK twin risk).

### Wire sites (v1 scope — three pipelines)

1. **`api.recall`** (api.ts ~960, inside the existing try/finally that owns
   the open db handle): write the trace next to the existing audit emit.
   **The v1.11.5 contract lock holds**: api.recall still does NOT touch
   `last_retrieval_ids` (locked by `tests/api-recall-no-side-effects.test.ts`)
   and does NOT write `last_trace_id`. A trace INSERT is the same
   observability class as the audit row it sits beside — not retrieval state.
   SDK callers that batch recalls get one trace per recall (inserts, no
   overwrite race — matching the batched-recall lock test's semantics).
   **F2 fix (final review round):** `RecallOpts` gains an additive
   `suppressRecallTrace?: boolean`, mirroring `suppressAvailabilityHint`'s
   established pattern — when true, this trace write is skipped entirely.
   The MCP handler (`mcp/server.ts` ~502) sets it: its user-visible primary
   ranking comes from a separate physics/hybrid scorer over the full tenant
   store, not this internal `apiRecall` call's BM25 band, so tracing it as
   pipeline `'api'` would mislabel training data with ids/ranks/scores the
   user never actually saw. Real MCP tracing is the reserved `'mcp'`
   pipeline value (schema v40) — an explicit follow-up, not v1 scope.
2. **`api.getContext`** (api.ts ~2462, the block that writes
   `last_retrieval_ids`): write the trace FIRST via `writeRecallTraceAtRoot`
   (fresh short-lived connection; see connection policy above — the trace
   must capture the post-limit, post-annotation `selectedItems`, and the
   audit handles are already closed at this point), fold the returned id
   into `localIndex.last_trace_id`, THEN one `saveIndex` call persists both
   meta keys atomically (F1 lockstep — see connection-policy section).
   Skipped in `pinnedOnly` mode (hot path stays read-only, same reason it
   skips markRetrieved).
   **F5 fix (final review round):** getContext's OTHER early return — the
   bare `selectedItems.length === 0 && !activeSnapshot && !sessionHandoff &&
   recentSessionEvents.length === 0` check right after the origin/category
   annotation, which used to skip tracing entirely — now also writes an
   empty trace (`pipeline: 'context'`, `results: []`) before returning. A
   query that finds nothing is exactly the coverage-gap signal Track LC
   needs. This path never touches `localIndex` (nothing to advance), so it
   cannot desync `last_trace_id`/`last_retrieval_ids` by construction.
   Also skipped when `pinnedOnly` (defensive — in the current control flow
   `pinnedOnly` always exits via its own earlier returns before reaching
   this check, so this guard cannot actually fire today, but is required by
   the same read-only-hot-path contract as the rest of `pinnedOnly`).
3. **CLI `cmdRecall`** (cli.ts ~1788): write ONE trace at `hippoRoot` (where
   `last_retrieval_ids` and outcome attribution live), FIRST, then fold its
   id into `localIndex.last_trace_id` before the single `saveIndex` call —
   same F1 lockstep pattern as getContext. The globalRoot audit emit stays
   as-is; no second trace row. The zero-result branch (independent-review
   must-fix, kept under F1) writes an empty trace but never touches
   `localIndex` — same reasoning as getContext's F5 empty path.

**Out of scope, documented:** the MCP handler's own physics/hybrid pipeline
(J2) — follow-up item, see the F2 fix above; server HTTP recall is covered
via api.recall. No sampling. No retention knob in v1 (measure first;
`audit_prune`-style lever is a follow-up if the <5% budget is ever
threatened).

Per-stage scores: persisted opportunistically. When the caller ran with
`explain` (A7) the RerankStep[] lands in `rerank_json`; the default path
persists ids + ranks + final scores only. Forcing explain-mode computation on
every recall is explicitly NOT done (hot-path cost; A7.2 unification is a
separate roadmap item). ids+ranks+scores+outcomes is the load-bearing training
triple; rerank steps are enrichment.

### Outcome linkage

Linkage is recorded ONLY where the credited ids actually come from the
last-retrieval mechanism — `outcomeForLastRecall` (api.ts, which reads
`last_retrieval_ids` and forwards to api.outcome) and any CLI outcome flow
that resolves its targets from last-retrieval state. It is NOT recorded
unconditionally in `api.outcome`: an SDK caller passing explicit ids with no
preceding CLI/context recall would otherwise get linked to a stale, unrelated
`last_trace_id` (grill catch — wrong-attribution bug). For programmatic
callers, `api.outcome` gains an OPTIONAL additive `traceId?` opt so SDKs can
link explicitly.

**Single-snapshot read (F1(d) fix, final review round):** `outcomeForLastRecall`
reads the trace id off the SAME `loadIndex(ctx.hippoRoot)` snapshot it
already holds for `last_retrieval_ids` (`idx.last_trace_id`) instead of a
second DB round trip via the (now-deleted) `readLastTraceId` helper — one
read, no read-after-read race window between the two values. The value is
already strict-parsed by `buildIndexFromDb`'s `parseLastTraceId`
(store.ts), so `outcomeForLastRecall` never has to re-validate it.

**Consumer-side validation (F4 fix, final review round):** `recordTraceOutcome`
itself re-validates before inserting — see the connection-policy section
above. This is what makes the linkage path robust to staleness beyond the
single-snapshot read: even if `last_trace_id` names a trace from a different
tenant (should not happen via the normal read path, but a defense-in-depth
backstop) or names a trace whose result set doesn't actually contain the
credited ids (e.g. an old-binary write from before F1's lockstep fix, or a
`last_retrieval_ids` update racing a trace write under an unrelated
failure), the row is skipped or filtered down to the true intersection
rather than recording a false credit. Tenant-mismatched ids passed to
`outcome()` itself are still filtered upstream by `outcome()`'s own
`readEntry(..., ctx.tenantId)` loop, before `recordTraceOutcome` ever runs —
the linkage records what was actually credited, after BOTH filters. If
`last_trace_id` is unset (fresh store, pre-v40 flow), skip silently — the
outcome path's existing behavior is unchanged. Staleness note: `last_trace_id`
inherits exactly `last_retrieval_ids`' attribution semantics (most recent
interactive recall wins); no new staleness class is introduced.

Other external api.outcome callers, named for completeness (critic round-2
note): server.ts POST /v1/outcome passes explicit ids and no `traceId` — no
linkage, correct; mcp/server.ts calls api.outcome from the MCP pipeline,
which never writes a trace in v1 — no linkage, correct. Neither caller
changes behavior.

## Tasks (executors; T1 -> T2 -> T3 sequential, same files overlap)

- **T1**: migration v40 + `src/recall-trace.ts` + meta plumbing (all seven
  `last_retrieval_ids`-pattern sites for `last_trace_id`) + unit tests
  (scratch HIPPO_HOME, never a repo checkout).
- **T2**: wire the three recall paths + tests: api.recall writes trace rows
  and does NOT write last_trace_id (extends the no-side-effects invariant in a
  NEW test file — the locked test file is not edited); getContext writes
  trace + linkage; cmdRecall writes trace + linkage at hippoRoot only.
- **T3**: outcome linkage at api.outcome + E2E test: recall -> outcome ->
  recall_trace_outcomes row references the right trace + ids; plus a
  storage-overhead smoke (100 traced recalls, assert DB growth sane).

## Test plan

- Migration: fresh store lands at v40 with all three tables; v39 store
  upgrades cleanly (fresh + upgrade paths).
- Helper: happy path; fail-soft (trace write against a closed/readonly db
  does not throw out of `writeRecallTrace`); WITHOUT ROWID composite-PK
  uniqueness.
- Wiring: one trace row per recall on each of the three paths; pinnedOnly
  writes nothing; api.recall leaves `last_retrieval_ids` AND `last_trace_id`
  untouched (new test file beside the locked one).
- Outcome E2E: cmdRecall-style flow then outcome positive -> linkage row;
  outcome with no prior trace -> no row, no error.
- Full suite: `npm run build` + `npm test` in the worktree (fresh worktree
  needs dist build first — probation memory).

## Rollback / safety

Derived, additive, rebuildable: dropping the three tables and the
`last_trace_id` meta key restores v39 behavior exactly. No existing rows are
mutated. Never-rules respected: no memory history deleted, no CLI names
changed, no secrets in traces (hash-only queries).

## Limitations (added final review round)

- **Mixed binary versions can contaminate linkage attribution (codex round-2
  med, ACCEPTED with rationale).** A pre-v40 binary writing to a v40 store
  updates `last_retrieval_ids` without touching `last_trace_id`. A new-binary
  outcome then reads a stale trace id; membership validation filters the
  credited ids against that stale trace, but ids that OVERLAP (similar
  queries recall similar memories) still pass and get attributed to the
  wrong recall event. Prevention would mean raising `min_compatible_binary`
  at v40 — locking every pre-1.29 binary out of the store and breaking this
  plan's v39-rollback promise. Deliberately NOT done: the contamination is
  bounded to mixed-binary usage (a transitional state), affects training
  attribution rather than user-facing behavior, and LC2's training loader
  can additionally drop linkages whose outcome ts falls implausibly far
  from the trace ts. Weighed and surfaced at the ship gate; revisit only if
  mixed-binary usage becomes a standing configuration.
- **Partial per-memory outcome failure can omit the linkage row.** `outcome()`
  loops over ids, calling `readEntry`/`writeEntry`/`appendAuditEvent` per id,
  and only calls `recordTraceOutcome` once at the end with whatever ended up
  in `appliedIds`. If the loop applies some ids and then a later id in the
  same call fails partway (e.g. a write error on that specific memory), the
  ids that DID apply still get credited correctly, but this is an accepted,
  pre-existing write pattern (matches how `appliedIds`/`applied` already
  worked before LC1) — not a new gap introduced by tracing, and not
  reworked here.
- **External `traceId` exposure (HTTP/SDK) is a scoped follow-up.** The
  `traceId?` opt on `api.outcome` is reachable today only from in-process TS
  callers. Neither `server.ts`'s POST `/v1/outcome` route nor the Python SDK
  currently accept or forward a caller-supplied trace id — an external
  caller cannot yet do explicit SDK linkage. Wiring that through (request
  body field, SDK method signature) is out of v1 scope; the last-retrieval
  path (`outcomeForLastRecall`) already covers the CLI/HTTP no-body
  last-recall flow without it.

## Success criteria (falsifiable)

1. Every recall on the three wired paths writes exactly one trace row with
   the full returned id+rank+score list (tests assert).
2. An outcome following a CLI/context recall writes a
   `recall_trace_outcomes` row referencing that recall's trace id (E2E test).
3. Storage: 100 traced recalls of 10 results grow the DB by < ~250KB
   (smoke-test bound; sanity proxy for the <5% criterion).
4. Full test suite green; no locked test modified.
