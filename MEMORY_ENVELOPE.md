# Memory envelope

Every row in `memories` carries the canonical envelope as of schema v14 (A3).

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

1. **Append-only on raw.** `DELETE FROM memories WHERE kind='raw'` aborts via `trg_memories_raw_append_only`. The only legitimate path to remove a `kind='raw'` row is `archiveRawMemory(db, id, { reason, who })` from `src/raw-archive.ts`, which snapshots into `raw_archive`, flips `kind` to `'archived'`, then deletes in one transaction.
2. **Kind enforcement.** INSERT/UPDATE setting `kind` to anything outside `{raw, distilled, superseded, archived}` aborts via `trg_memories_kind_check_insert` / `_update`. ALTER TABLE cannot add CHECK on existing-data columns in SQLite, so triggers fill the gap.
3. **Provenance discipline.** New tables introduced after v14 must include `kind` and (post-A5) `tenant_id`. See `ROADMAP-RESEARCH.md` §"Schema migration order".

## Surfacing

- `hippo recall --why` prints envelope lines under each result.
- `hippo remember` accepts `--kind`, `--scope`, `--owner`, `--artifact-ref` flags.
- The TypeScript type `MemoryEntry` (in `src/memory.ts`) carries the envelope; `createMemory` defaults missing fields to `kind='distilled'` + nulls.

## What this enables

- **A4 right-to-be-forgotten.** `archiveRawMemory` is the primitive; A4 will wrap it in a `hippo forget --user X --everywhere` workflow.
- **A5 multi-tenancy.** `scope` + `owner` are the foundation; A5 adds `tenant_id` and RLS / app-layer enforcement.
- **E1 ingestion connectors.** Every Slack/Jira/GitHub message lands as `kind='raw'` with full provenance; `hippo sleep` promotes selected receipts to `kind='distilled'`.
- **E3 graph layer.** Graph indexer reads only `kind IN ('distilled','superseded')` rows; `kind='raw'` is structurally inaccessible.

## Out of scope here (deferred)

- `tenant_id` column (A5)
- Encryption-at-rest, secret-scrub, PII redaction (A4)
- Right-to-be-forgotten workflow (A4 — `archiveRawMemory` primitive lands here only)
- Connector code that writes `kind='raw'` rows (E1.x)
- Graph extraction queue table (E3.1)
