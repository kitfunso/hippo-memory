# AT1: Rejected-value tombstone — implementation plan

Status: Draft (episode 01M025CW434ZAPVSFC61BGFGCT; not yet engineering-reviewed)
Target: v1.31.0 candidate | Base: origin/master 4aeb04c | Branch: feat/at1-rejected-value-tombstone
Source: ROADMAP.md Part V AT1 [critical, next] (atlas gap, verified real 2026-08-09)

## Problem

`deleteEntry` is a hard `DELETE FROM memories` (store.ts:1654). Supersession hides rows
on read but keys nothing on the *value*. A human who rejects a fact has no durable say:
re-extraction (`capture`), re-import (importers), re-sync (`syncGlobalToLocal`), or a
plain re-`remember` silently re-asserts the rejected value. The Part III DAG
consolidation item is explicitly blocked on this invalidation story existing.

Discovered adjacent defects, confirmed against source this episode:
- `resolveConflict` (store.ts:2449) — today's only human-adjudication surface — writes
  **zero** `audit_log` rows on any path (verified: no `audit()`/`appendAuditEvent` call
  in the function body, nor in its CLI/MCP callers).
- `resolveConflict`'s forget-loser branch does a bare `DELETE FROM memories`
  (store.ts:2502); if the loser is `kind='raw'`, the append-only trigger
  (`trg_memories_raw_append_only`) aborts the whole resolve transaction.

## Design (framing F1, grilled at brainstorm)

Exact-normalized-value semantics, per the two atlas reference systems that carry the
mark: `memsem` (refuses `memory_add` when the normalized value matches) and
`perseus-vault` (digest-keyed tombstone with audited override). Paraphrase/semantic
matching is explicitly out of scope (documented limitation; the roadmap's named threat
is byte-stable re-ingestion, which normalized-digest matching fully covers).

Differentiation from the existing sibling capability: `invalidateMatching`
(invalidation.ts:85) soft-weakens matching live rows (half-life halve + stale tag) but
prevents nothing — a re-assertion writes a fresh row untouched. The tombstone is the
missing *write-side* refusal; invalidate stays unchanged.

### 1. New module `src/rejection.ts`

- `normalizeValueForRejection(content: string): string` — Unicode NFC → lowercase →
  collapse whitespace runs to single space → trim. No punctuation stripping (too
  aggressive; over-normalization creates false refusals, which are worse than misses).
- `rejectionDigest(content: string): string` — full sha256 hex (64 chars) of the
  normalized string. Reuses the strong-identity convention (importers.ts:814
  content-hash tag), NOT the privacy-lossy 16-char convention (recall-trace query
  hashing) — a tombstone lookup key needs collision resistance, not redaction.
- `RejectedValueError` — carries `{digest, reason, rejectedAt}`; thrown by the guard.
- Check/write helpers used by the guard, the CLI verbs, and `resolveConflict`.

### 2. Migration v41: `rejected_values` (additive; template = v40, db.ts:2197-2268)

```sql
CREATE TABLE rejected_values (
  tenant_id  TEXT NOT NULL,
  digest     TEXT NOT NULL,            -- sha256/64 of normalized content
  reason     TEXT,                     -- human-supplied; the only description stored
  rejected_by TEXT,                    -- actor ('user:<id>' / 'cli' / ...)
  rejected_at TEXT NOT NULL,
  source_memory_id TEXT,              -- provenance only; NO FK (v40 precedent
                                       -- db.ts:2245-2249: tombstone outlives the row)
  normalized_chars INTEGER,            -- weak sanity aid for humans listing tombstones
  PRIMARY KEY (tenant_id, digest)
) WITHOUT ROWID;
```

- **No raw content and no preview stored.** Follows the `raw_archive` redaction
  precedent (raw-archive.ts payload is `{redacted:true, ...}`): a rejected value may
  itself be a secret or PII ("never store my key again") — persisting it in the
  tombstone would defeat the point. The human sees the content at reject time (CLI
  echoes it); afterwards the `reason` field is the human-readable identity.
- Reserved-word check on column names: clean (§3b rule 10).
- **No `min_compatible_binary` bump — a deliberate tradeoff, flagged to the ship
  gate (critic round-1 med: the v40 "pure observability" analogy is weaker here).**
  Honest statement: an old binary sharing a synced store writes WITHOUT the guard —
  no refusal, no warning — until upgraded; that is a real durability gap in
  multi-binary deployments. Bumping closes it by locking every old binary out of the
  store entirely (hard refuse-to-open), which is disproportionate for the dominant
  single-user single-binary local deployment. Decision: no bump; the gap is
  documented in MEMORY_ENVELOPE.md ("rejection is enforced by binaries >= 1.31.0;
  upgrade all binaries that share a store"), and the ship-gate human can override to
  bump before release.
- Tenant model: tombstones are tenant-scoped (PK includes tenant_id) and **per-store**
  (each SQLite store carries its own table). Consequence spelled out: a value rejected
  in the local store refuses local re-writes — including `syncGlobalToLocal`
  re-importing it from global (the exact roadmap threat) — but does not reach into
  other stores' tables. Rejecting in the store where the value lives is the v1
  contract.

### 3. Write-path guard (single choke point)

Placement per the verified write-path enumeration: `upsertEntryRow` (store.ts:997) is
the **only** `INSERT INTO memories` in src (spot-checked). Guard runs there:

- Fires when the incoming content's digest matches a tombstone AND the write
  *introduces* that content: the row is new, OR the stored row's content digest
  differs from the incoming one (`upsertEntryRow` is an UPSERT — a same-id edit TO a
  rejected value is a content introduction and must be refused; grill issue 2).
  Unchanged same-id re-persists (recall boost, decay, star toggle) are exempt by
  construction; `refine-llm`'s in-place paraphrase rewrite is only refused in the
  pathological case where the rewrite lands exactly on a rejected normalized value —
  which is a correct refusal.
- Guard cost, stated honestly (critic round-1 med): `upsertEntryRow` today contains
  ZERO `SELECT`s — the guard adds NEW queries to the hottest write path. Ordering
  minimizes them: (a) compute the incoming normalized digest; (b) probe
  `rejected_values (tenant_id, digest)` — a miss ends the guard (ONE indexed point
  query; the overwhelmingly common case); (c) only on a tombstone hit, `SELECT` the
  stored row's content by id to classify new-row vs content-introduction. Net: +1
  point query per guarded write, +2 on the rare hit path — bounded and small next to
  the existing FTS + mirror + audit I/O per write, but new, not free. Filter applied
  in SQL, not post-hoc (probation memory `feedback_sql_filter_before_limit_window`).
- Hit → throw `RejectedValueError`. **Fail-loud, no fallback** (probation memory
  `feedback_fallbacks_absent_not_broken`): the caller's write fails with the reason;
  nothing silently downgrades.
- **Bypass flag** `bypassRejectionGuard` is a direct optional parameter on
  `upsertEntryRow` itself (critic round-1 crit 1: threading via `writeEntryDbOnly`
  opts is architecturally impossible — `writeEntryDbOnly` has exactly two callers,
  `writeEntry` store.ts:1317 and `api.supersede` api.ts:1831, and none of the bypass
  callers goes through it; they call `upsertEntryRow` directly). Exactly ONE call
  site passes the bypass (round-3 correction), with an in-code comment obligation:
  - `batchWriteAndDelete` (calls `upsertEntryRow` at store.ts:1714) —
    consolidation merge + auto-promote writes are LLM paraphrase rollups of
    already-guarded leaf facts; refusing a paraphrase mid-batch would abort the
    whole consolidation transaction and the digest would almost never match anyway
    (false confidence, not protection). The guard belongs on leaf inserts.
  - `writeEntryDbOnly`'s own call (store.ts:1352) passes NO bypass — the guard is
    live for every producer routed through `writeEntry` / `api.supersede`.
- **Recovery paths run the guard WITH per-row containment — they do NOT bypass
  (round-3 redesign; replaces the round-2 mirror-purge-in-archive design the critic
  correctly killed).** `bootstrapLegacyStore` (store.ts:906) and `rebuildIndex`
  (store.ts:1861) exist to re-insert rows found in markdown mirrors but missing from
  SQL — exactly the channel through which a stale mirror could resurrect a rejected
  value. Instead of bypassing the guard and trying to guarantee no stale mirror ever
  exists (unwinnable: filesystem purges are best-effort by design here), both paths
  run the guard per row and catch `RejectedValueError` → skip the row, count it, log
  once, best-effort `reject_refusal` audit — written INLINE inside the still-open
  loop transaction (round-3 advisory 3: the per-row skip does not roll anything
  back, so the post-rollback `auditRejectionRefusal` helper — built for the
  rolled-back writeEntry/supersede case — is the wrong tool here; a direct `audit()`
  call in-loop is correct and commits with the pass). The `rejected_values` table lives in the
  same DB being rebuilt, so it is available during both passes. This closes
  resurrection STRUCTURALLY: a rejected value cannot re-enter via recovery no matter
  what state the mirrors are in.
- **Mirror purge follows the codebase's existing post-commit + reaper pattern
  (round-2 crit fix, designed from source).** `archiveRawMemory` keeps its exact
  current signature — db-only work inside its own inner SAVEPOINT, which is what
  makes it safely composable inside outer transactions (`github_delete_all`
  deletion.ts:78-101; resolveConflict's BEGIN/COMMIT; the reject verb's
  transaction). NO filesystem I/O is added anywhere inside any transaction scope
  (the established rule: batchWriteAndDelete purges mirrors only after
  `db.exec('COMMIT')`, store.ts:1730-1738; writeEntry/writeEntryDbOnly split exists
  for the same reason). The reject flow reuses the EXISTING purge + reaper
  mechanism verbatim from `api.archiveRaw` (api.ts:1913-1938): after the OUTERMOST
  commit, best-effort `removeEntryMirrors` per removed id; on success stamp
  `raw_archive.mirror_cleaned_at` for raw rows so the `openHippoDb` reaper stops
  retrying; on failure the stamp stays NULL and the reaper retries on next open.
  Non-raw removed rows get the same post-commit best-effort purge (no reaper exists
  for them — acceptable, because the recovery-path guard above already makes a
  surviving mirror harmless). `api.archiveRaw` and `connectors/github/deletion.ts`
  are NOT modified — no duplication, no signature change, no new callers to audit.
  Pinned by tests: (a) reject a raw row → `rebuildIndex` → value absent (via guard
  skip, regardless of mirror state); (b) a mid-transaction failure in the reject
  verb leaves every mirror intact (rollback safety).
- Every other producer — remember (CLI/api/MCP/HTTP), capture + pre-compact extraction,
  autolearn/git-learn, all importers, connectors, domain-object writers,
  promote/share/sync copy paths, supersede's successor write — hits the guard with no
  code change at their site. Copy paths are deliberately IN scope: promote/share/sync
  must not carry a rejected value into a wider scope; the guard at the destination
  store covers them.

**Refusal audit must survive the rollback — written by the transaction OWNER, never
inside a scope a caller can roll back (critic round-1 crit 3).** The guard only
throws; `RejectedValueError` carries `{digest, tenantId, entryId, reason}`. The
`reject_refusal` audit row is written post-rollback by the two connection/transaction
owners, via one shared helper `auditRejectionRefusal(db, err, actor)` (best-effort
`audit()` semantics):
- `writeEntry` (store.ts:1299): catch after its SAVEPOINT unwinds — no outer
  transaction exists there, so the post-rollback write commits immediately — then
  rethrow.
- `api.supersede` (api.ts:1842 catch): after its own `db.exec('ROLLBACK')` — the
  refusal audit lands in a fresh implicit transaction that the aborted outer one
  cannot claw back — then rethrow.
`batchWriteAndDelete` bypasses the guard, so no refusal can originate there. Tests
assert BOTH surfaces: refused `remember` AND refused `supersede` → no memory row,
exactly one `reject_refusal` audit row each, with digest metadata.

**Refusal containment at multi-item write loops (grill issue 1 — design requirement,
not an afterthought).** A refusal is per-VALUE; sibling items must survive:
- `writeExtractedItems` (capture.ts:261) and `cmdCaptureCore` (capture.ts:649): catch
  `RejectedValueError` per item — skip, count, continue; summary reports
  `rejected: N`. The PreCompact path keeps CS1's hard exit-0 contract: a refusal can
  never crash the hook.
- `importEntries` (importers.ts:143), `importVault` (via `remember`): per-item catch;
  `ImportResult` gains an explicit `rejected` counter (round-2 low: folding into the
  existing `skipped` would make deduped indistinguishable from tombstoned); import
  summaries print it.
- `learnFromMemoryMd` (cli.ts:2647) is NOT ImportResult-shaped — it returns a bare
  `number` with two callers printing a bare count (cli.ts:540, cli.ts:2903; round-3
  advisory 1). No signature change: per-item catch, count rejected skips internally,
  and print one summary line from inside the function ("skipped N rejected value(s)")
  when the count is non-zero. Callers unchanged.
- Connector ingest (slack/github): a `RejectedValueError` is a PERMANENT skip
  (acked/marked done), never DLQ-retried — a tombstone hit is not transient.
- DAG summary builds (critic round-1 high): `buildDag` (writeEntry at dag.ts:155) and
  `buildEntityProfiles` (dag.ts:378) loop over clusters writing NEW LLM-synthesized
  summaries through the live guard (they use plain `writeEntry`, not the bypassed
  batch writer). Per-cluster catch-and-skip — a refused summary skips that cluster
  and the sleep cycle continues; refusing a summary that lands exactly on a rejected
  value is correct, aborting the whole DAG phase is not. Their member re-parenting
  writes (dag.ts:160/383) are same-id updates, unaffected by construction.
- `syncGlobalToLocal` / `promoteToGlobal` / `shareMemory`: sync skips-and-counts;
  promote/share of a rejected value is a single-item op and fails loud with the
  refusal error (correct: the human asked for that one value).
- Single-item surfaces (remember CLI/api/MCP/HTTP, domain-object writers, supersede):
  fail loud with the tombstone's reason — no catch.
Test: transcript yielding 3 extractions with 1 rejected → 2 written + 1
`reject_refusal` audit row + hook exit 0.

### 4. CLI verbs + api

- `--reason` is REQUIRED on both reject forms (grill issue 4): with no content stored,
  the reason is the tombstone's only human-readable identity — a nullable reason
  makes `rejections`/`unreject` listings of anonymous digests nobody can act on.
- Store targeting (grill issue 6): reject/unreject/rejections follow the same
  store-resolution flags as `remember`; rejecting in the global store means running
  against the global store. v1 contract, documented.
- **`deleteEntryCore` split (round-2 high fix, designed from source).** `deleteEntry`
  (store.ts:1641) opens and closes its OWN connection and cannot compose inside a
  caller's transaction. Split it exactly like writeEntry/writeEntryDbOnly: new
  db-scoped `deleteEntryCore(db, id, opts)` — row-meta SELECT, `DELETE FROM
  memories`, FTS delete, `forget` audit, DAG dirty-mark; NO filesystem I/O; returns
  `{tenantId, dagParentId} | null`. `deleteEntry` becomes the thin wrapper (open →
  core → post-commit `removeEntryMirrors` + `writeIndexMirror` → close), behavior
  byte-identical for every existing caller.
- `hippo reject <memory-id> --reason "<why>"` — ONE connection, one transaction:
  write tombstone; enumerate ALL live rows in the tenant whose normalized digest
  matches (O(N) scan, human-triggered command on ~1-5k-row stores — acceptable,
  documented); remove each kind-aware IN-transaction — `kind='raw'` via
  `archiveRawMemory` (its inner SAVEPOINT nests safely; append-only trigger
  respected), others via `deleteEntryCore`; audit `reject_value` (metadata: digest,
  removed count); COMMIT. THEN post-commit: best-effort `removeEntryMirrors` per
  removed id, `mirror_cleaned_at` stamps for raw ids (reaper backstop), one
  `writeIndexMirror`. Duplicate handling is the K1/R7 lesson: ALL matching rows,
  not just the id passed.
- **Audit-row semantics on the reject path (round-3 advisory 2, following the
  api.ts:1873-1877 no-double-emit precedent):** `deleteEntryCore` takes
  `opts.suppressForgetAudit?: boolean`; the reject path sets it so removed non-raw
  rows do NOT each emit a `forget` row — the single aggregate `reject_value` row
  (digest + removed ids + count) is the trail. `archiveRawMemory`'s own
  `archive_raw` audit is KEPT (it is the GDPR archival trail and semantically true —
  the row was archived). Test 3 pins the contract: one `reject_value`, zero `forget`
  rows from the reject call, one `archive_raw` per raw removal. Default
  (`suppressForgetAudit` unset) keeps `deleteEntry` byte-identical.
- `hippo reject --value "<text>" --reason "<why>"` — pre-emptive tombstone for a value
  not currently stored (or already deleted); zero-removal path, same audit.
- `hippo rejections` — list tombstones (digest prefix, reason, rejected_by,
  rejected_at, source_memory_id, normalized_chars).
- `hippo unreject <digest-prefix>` — delete tombstone, audit `unreject_value`. This is
  the **only** escape hatch in v1: no per-write force-override flag (a second path
  through the guard is a second thing to get wrong; `perseus-vault` has one, `memsem`
  does not — start minimal, add on demand).
- `api.ts`: `reject` / `unreject` / `listRejections` (Context-based, tenant-checked) so
  HTTP/MCP endpoints can be added later without touching store internals. HTTP + MCP
  *verbs* are a documented follow-up — note the guard itself already protects every
  surface today; only the reject-administration surface is CLI/api-first.

### 5. `resolveConflict` wiring + audit fix

- Additive-optional signature (public export, index.ts:26 — §3b rule 5):
  `resolveConflict(hippoRoot, conflictId, keepId, forgetLoser, tenantId, opts?)` with
  `opts = { rejectLoserValue?, rejectedBy?, reason? }`. Existing call shapes
  (cli.ts:3705, mcp/server.ts:1144) compile unchanged.
- `rejectLoserValue` → tombstone the loser's normalized digest + kind-aware removal
  inside the existing BEGIN/COMMIT (raw → `archiveRawMemory`, else
  `deleteEntryCore` — both db-scoped, both compose); mirror purge + reaper stamps
  run AFTER resolveConflict's own COMMIT, same post-commit pattern as the reject
  verb.
- Kind-aware removal also fixes the pre-existing forget-loser crash on raw losers
  (route through the same helper the reject verb uses).
- Add the missing audit: op `resolve` on every resolution path (metadata: conflictId,
  keepId, loser disposition). Closes the audit-invisibility gap.
- CLI: `hippo resolve ... --reject-loser [--reason "..."]`; MCP `hippo_resolve` gains
  optional `rejectLoser` + `reason` params.

### 6. AuditOp lockstep (§3b rule 2 — all three sites, one commit)

New ops: `reject_value`, `reject_refusal`, `unreject_value`, `conflict_resolve`
(domain-namespaced per the existing convention — `decision_supersede`,
`predict_close`, `archive_raw`; bare `resolve` is vague; grill issue 5).
Sites: `AuditOp` union (audit.ts:130-176), `VALID_AUDIT_OPS` cli.ts:7258,
`VALID_AUDIT_OPS` server.ts:168. Each entry carries the lockstep comment convention.

### 7. Tests (real DB, per repo convention)

1. **Acceptance (roadmap criterion, verbatim):** reject value X → re-run a capture
   extraction that re-asserts X → write refused, `audit_log` records the refusal;
   supersession behavior unchanged for non-rejected corrections (cmdSupersede +
   api.supersede suites stay green).
2. Guard: new-row refused across remember/capture/import surfaces; same-id re-persist
   of a surviving row unaffected; consolidation bypass proven (merged content equal to
   a rejected value still writes — exemption is by design and the test pins it);
   tenant isolation (tenant B writes the same value freely); normalization variants
   (case/whitespace/NFC) all refused; unreject restores writability.
3. Reject verb: removes ALL same-digest duplicates in one call; raw rows archived not
   crashed (append-only trigger respected); `reject --value` pre-emptive path; audit
   rows for `reject_value` with removed-count metadata.
4. resolveConflict: `resolve` audit row on weaken path AND forget path (was zero);
   `--reject-loser` tombstones + removes; raw loser no longer aborts; old 5-arg call
   shape still compiles (additive check).
5. Copy-path: global→local sync of a locally-rejected value is refused (the roadmap
   threat, end-to-end).
6. Migration: v41 applies on fresh + existing stores; idempotent under re-open;
   schema_version = 41; no min_compatible_binary change.
7. **AT5 paired case:** after reject, the value never resurfaces via recall (query
   that previously returned it returns without it, and stays clean after a capture
   re-assertion attempt).

### 8. Docs

CHANGELOG v1.31.0 entry; MEMORY_ENVELOPE.md "Rejected values" section (semantics,
per-store scope, no-content-stored rationale, normalization contract);
ROADMAP.md AT1 status flip is a ship-stage doc edit in the MAIN checkout (hot file —
targeted Edit only).

## Non-goals (v1)

- Semantic/paraphrase-tolerant matching (research; documented limitation).
- HTTP/MCP reject-administration endpoints (follow-up; guard already covers those
  write surfaces).
- AT3 quarantine tier, AT4 review queue (separate roadmap items; AT4 overlaps AT3 —
  build together later).
- Per-write force-override flag.
- Retroactive store scan (tombstone set starts empty; nothing to backfill).

## Execution split (executors are sonnet sub-agents; orchestrator reviews every diff)

- T1: `src/rejection.ts` + migration v41 + guard in store.ts (+ bypass threading) —
  the core invariant.
- T2 (after T1 lands): CLI verbs + api trio + resolveConflict wiring + AuditOps
  3-site lockstep.
- T3 (parallel with T2 tail): tests + docs.

## Risks / open questions

- **Wallclock:** 4h episode budget vs 5-6d roadmap effort estimate — the estimate
  includes human cadence; the episode compresses to the code+tests scope above. If the
  execute stage overruns, ship T1+T2 with the acceptance tests and move remaining test
  breadth to a follow-up (cap-honest, human decides at ship).
- **O(N) duplicate scan in reject verb:** acceptable at current store sizes;
  follow-up if stores grow 100x (a digest column on memories is the escape, not
  needed now).
- **False refusals:** normalization is conservative (no punctuation stripping) to keep
  false-refusal risk near zero; a false refusal is loud (error names the tombstone +
  reason + unreject path), never silent.
- **Reject-vs-concurrent-writer race (grill issue 7, accepted):** a write that passes
  the guard before the tombstone commits can land after it. Single-user CLI reality;
  the next reject (or a re-run) catches it. Documented limitation, not v1-blocking.

Grill applied 2026-08-15 (7 issues: multi-item refusal containment; same-id
content-change gating; mirror-purge proof; required reason; conflict_resolve naming;
store targeting; race accepted). Test list updated to match: containment test (3
extractions / 1 rejected / hook exit 0), same-id-edit refusal test, raw-reject →
rebuild test.

Critic round 2 applied 2026-08-15 (fail 48 → revised from source): the round-1
mirror fix was itself wrong (fs unlinks inside SAVEPOINT scope = unrecoverable loss
on rollback; existing api.ts:1913-1938 purge+reaper never reconciled). Round-3
design read from source: archiveRawMemory signature UNCHANGED (db-only, composable);
recovery paths (bootstrapLegacyStore/rebuildIndex) switched from bypass to
guard-with-per-row-skip — structural closure of resurrection independent of mirror
state; reject/resolve purge mirrors post-OUTERMOST-commit reusing the existing
reaper bookkeeping; deleteEntryCore split (deleteEntry cannot compose — owns its
connection); ImportResult gains an explicit `rejected` counter. batchWriteAndDelete
is now the SOLE bypass caller.

Critic round 1 applied 2026-08-15 (fail 25 → revised): bypass flag moved to a direct
`upsertEntryRow` parameter (threading via writeEntryDbOnly was impossible — 2 callers
only); archiveRawMemory mirror-purge designed in-plan with both external callers
named (api.ts:1908, connectors/github/deletion.ts:81) — also fixes the pre-existing
archive→rebuild resurrection defect; refusal audit moved to the transaction owners'
post-rollback catch blocks (writeEntry + api.supersede) via one shared helper, tested
on both surfaces; dag.ts buildDag/buildEntityProfiles added to containment
(per-cluster catch-and-skip); guard cost restated honestly (+1 point query common
case, +2 on tombstone hit — new queries, upsertEntryRow had none); min_compatible_binary
no-bump restated as an explicit tradeoff with the multi-binary gap documented and
flagged to the ship gate.
