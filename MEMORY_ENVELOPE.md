# Memory envelope

Every row in `memories` carries the canonical envelope as of schema v14 (A3) + v15 (hardening).

## Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `kind` | TEXT | yes | `raw \| distilled \| superseded \| archived`. Default `distilled`. Append-only when `kind='raw'`. |
| `scope` | TEXT | no | NULL = global / un-scoped. Format conventions: `team:<id>`, `project:<id>`, `customer:<id>`. A5 will tighten tenant semantics. |
| `owner` | TEXT | no | `user:<id>` or `agent:<id>`. |
| `artifact_ref` | TEXT | no | URI to the source artifact. Examples: `slack://team/channel/<ts>`, `gh://owner/repo/pr/<n>`, `file:///abs/path`. |
| `session_id` | TEXT | no | Aliased to existing `source_session_id` column. Same field, named in the envelope for clarity. |
| `confidence` | TEXT | yes | `verified \| observed \| inferred \| stale`. Existing field, repurposed as part of the envelope. |
| `created` | TEXT | yes | Existing timestamp; satisfies envelope `timestamp`. |

## Invariants

1. **Append-only on raw.** `DELETE FROM memories WHERE kind='raw'` aborts via `trg_memories_raw_append_only`. The only legitimate path to remove a `kind='raw'` row is `archiveRawMemory(db, id, { reason, who })` from `src/raw-archive.ts`, which snapshots into `raw_archive`, flips `kind` to `'archived'`, then deletes in one SAVEPOINT (also purges the `memories_fts` row so archived content is not searchable post-archive).
2. **Kind enforcement.** INSERT/UPDATE with `kind=NULL` or `kind` outside `{raw, distilled, superseded, archived}` aborts via `trg_memories_kind_check_insert` / `_update` (v15). ALTER TABLE cannot add CHECK on existing-data columns in SQLite, so triggers fill the gap.
3. **Provenance discipline.** New tables introduced after v14 must include `kind` and (post-A5) `tenant_id`. See `ROADMAP-RESEARCH.md` §"Schema migration order".

## CLI surface (v15)

- `--kind` accepts `distilled` (default) or `superseded` only. `raw` is reserved for ingestion connectors (E1.x: Slack/Jira/Gmail) that route deletions through `archiveRawMemory`. Existing `hippo forget` / consolidation / conflict-resolution paths abort on `kind='raw'` via the append-only trigger, so exposing `--kind raw` would create unforgettable memories. `archived` is an internal sentinel set only inside `archiveRawMemory`'s SAVEPOINT.
- `--scope <value>` writes the envelope `scope` column AND adds a `scope:<value>` tag (additive dual-write). Recall's `--scope` filter currently matches the tag form. When envelope-column-based filtering lands (post-A5), this dual-write becomes a transition aid; until then the duplication is intentional.
- `--owner <value>` and `--artifact-ref <uri>` are passed through unchanged; format is advisory (`user:<id>` / `agent:<id>` for owner; URI scheme for artifact_ref).

## Footguns to avoid

- **Do not use `INSERT OR REPLACE` on `memories`.** SQLite fires the `BEFORE DELETE` trigger during conflict resolution; on a `kind='raw'` row this aborts the upsert. Use `upsertEntryRow` (ON CONFLICT DO UPDATE) in `src/store.ts` or `archiveRawMemory` for raw rows.
- **Do not directly `DELETE FROM memories` for `kind='raw'`.** Always go through `archiveRawMemory(db, id, { reason, who })` so the audit trail in `raw_archive` is preserved.
- **Ingestion code must declare `kind` explicitly** when writing genuinely raw transcripts. The default in `createMemory()` is `'distilled'`; current callers (`importers.ts` for ChatGPT/Claude/Cursor pastes, `capture.ts` for session capture) keep this default because their content is curated/processed, not raw transcript. When E1.x connectors land (Slack/Jira/Gmail), they MUST set `kind: 'raw'` explicitly.

## Surfacing

- `hippo recall --why` prints envelope lines under each result.
- `hippo remember` accepts `--kind`, `--scope`, `--owner`, `--artifact-ref` flags.
- The TypeScript type `MemoryEntry` (in `src/memory.ts`) carries the envelope; `createMemory` defaults missing fields to `kind='distilled'` + nulls.

## What this enables

- **A4 right-to-be-forgotten.** `archiveRawMemory` is the primitive; A4 will wrap it in a `hippo forget --user X --everywhere` workflow.
- **A5 multi-tenancy.** `scope` + `owner` are the foundation; A5 adds `tenant_id` and RLS / app-layer enforcement.
- **E1 ingestion connectors.** Every Slack/Jira/GitHub message lands as `kind='raw'` with full provenance; `hippo sleep` promotes selected receipts to `kind='distilled'`.
- **E3 graph layer.** Graph indexer reads only `kind IN ('distilled','superseded')` rows; `kind='raw'` is structurally inaccessible.

## Rejected values (AT1, schema v41)

A human who rejects a fact gets a durable say: `hippo reject` tombstones the
value so it refuses to come back, across every write surface, not just the
one row the human saw.

### Semantics

- **Exact-normalized-value match, not semantic.** `normalizeValueForRejection`
  (`src/rejection.ts`) does Unicode NFC → lowercase → collapse whitespace runs
  → trim. No punctuation stripping — over-normalization creates false
  refusals, which are worse than misses. `rejectionDigest` is the full
  sha256 hex (64 chars) of the normalized string.
- **Digest-keyed.** The `rejected_values` table stores `(tenant_id, digest)`
  as its primary key — never the raw text. A lookup is one indexed point
  query.
- **Per-store.** Each SQLite store carries its own `rejected_values` table.
  Rejecting a value in the local store refuses local re-writes — including a
  `syncGlobalToLocal` pull that would otherwise re-import it from global —
  but does not reach into other stores. Rejecting in the store where the
  value lives is the v1 contract.
- **Per-tenant.** The primary key includes `tenant_id`; tenant B can write a
  value tenant A rejected.

### What is (and isn't) stored

- **No raw content and no preview.** Only `reason`, `rejected_by`,
  `rejected_at`, `source_memory_id` (provenance only, no FK — the tombstone
  outlives the row), and `normalized_chars` (a weak sanity aid for humans
  listing tombstones). `reason` is the tombstone's only human-readable
  identity, which is why `hippo reject` requires it.
- **GDPR rationale.** A rejected value may itself be a secret or PII ("never
  store my key again"); persisting it in the tombstone would defeat the
  point. This follows the `raw_archive` redaction precedent (payload is
  `{redacted:true, ...}`). The human sees the content once, at reject time
  (the CLI echoes it); afterwards `reason` is all that remains.

### Write-refusal contract

The guard lives at the single INSERT choke point, `upsertEntryRow`
(`src/store.ts`). It fires when an incoming write's content digest matches a
tombstone AND the write introduces that content (a new row, or a same-id
UPDATE changing content onto a rejected value). A miss costs one indexed
point query; a hit adds one more to classify new-row vs content-introduction.
On a hit it throws `RejectedValueError` — fail-loud, no silent downgrade.

Two shapes of caller, both pinned by tests:

- **Single-item surfaces fail loud.** `hippo remember` (CLI/api/MCP/HTTP),
  domain-object writers, and `api.supersede`'s successor write propagate the
  refusal to the caller with the tombstone's reason.
- **Multi-item surfaces contain the refusal per item and keep going.**
  `capture`/pre-compact extraction, importers, `learnFromMemoryMd`,
  `syncGlobalToLocal`/`promoteToGlobal`/`shareMemory`'s sync-down path,
  connector ingest, and the DAG summary builders (`buildDag`,
  `buildEntityProfiles`) catch `RejectedValueError` per item, skip it, count
  it, and finish the batch. A refusal is per-VALUE — sibling items must
  survive. `bootstrapLegacyStore` and `rebuildIndex` run the same guard
  per row over legacy markdown mirrors, which closes the resurrection path a
  stale/never-purged mirror would otherwise open — structurally, regardless
  of mirror state.
- **One bypass exists, on purpose.** `batchWriteAndDelete` (consolidation
  merges + auto-promote rollups) skips the guard: those writes are LLM
  paraphrase rollups of already-guarded leaf facts, and refusing mid-batch
  would abort the whole consolidation transaction for a coincidental digest
  match. The guard belongs on leaf inserts, not rollups.
- **Refusal audits survive rollback.** The `reject_refusal` audit row is
  written by the transaction owner (`writeEntry`, `api.supersede`) *after*
  its own rollback completes, via `auditRejectionRefusal` — never inside a
  scope the caller's own rollback would claw back.

### `unreject` is the only escape hatch

`hippo unreject <digest-prefix>` deletes the tombstone; there is no per-write
force-override flag. A second path through the guard is a second thing to
get wrong — start minimal, add on demand.

### Multi-binary gap

Schema v41 does **not** bump `min_compatible_binary`. Rejection is enforced
by binaries >= 1.31.0; an older binary sharing a synced store can still
write the rejected value back in, silently — no refusal, no warning. Upgrade
every binary that shares a store. This is a deliberate v1 tradeoff (bumping
would hard-lock every old binary out of the store entirely, disproportionate
for the dominant single-user single-binary deployment), not an oversight.

### Mirror cleanup

Purging a removed row's markdown mirror (`.md` file) is best-effort, not
guaranteed. `cleanupArchivedMirrors` (the reaper, run on every `openHippoDb`)
only scans `raw_archive` — it retries a failed purge for `kind='raw'` ids
only. Non-raw ids have no reaper: if the post-commit unlink (retried once)
still fails, the file stays on disk with no automatic retry, ever. The
failure message names the exact leftover path(s) for a human to delete.

This is not silent data loss, because the tombstone does the actual work: a
stale mirror sitting on disk cannot resurrect the value it names.
`bootstrapLegacyStore` and `rebuildIndex` run the write-refusal guard per row
over exactly this class of file, so re-inserting from a stale mirror is
refused the same as any other write. But the FILE itself persists until a
human deletes it. If the value is later `unreject`ed, that stale mirror CAN
be re-imported by a subsequent `rebuildIndex` — reject then unreject does
not guarantee the old mirror is gone.

### Known limitation

Matching is exact-normalized-value only. A paraphrase of a rejected fact —
different words, same meaning — is not caught. This is out of scope for v1;
semantic/paraphrase-tolerant matching is research, not a documented gap in
the guard's correctness.

## Out of scope here (deferred)

- `tenant_id` column (A5)
- Encryption-at-rest, secret-scrub, PII redaction (A4)
- Right-to-be-forgotten workflow (A4 — `archiveRawMemory` primitive lands here only)
- Connector code that writes `kind='raw'` rows (E1.x)
- Graph extraction queue table (E3.1)
