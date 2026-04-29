# A3 Envelope — Pinned Decisions

This doc pins the column types, constraints, defaults, and NULL semantics for the
A3 provenance envelope BEFORE any migration code lands. A3 mistakes force
re-migration later (per ROADMAP-RESEARCH.md), so we lock the shape here and
treat every later task as a mechanical execution of these decisions.

## Column shape (in `memories`)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `kind` | TEXT | NOT NULL (enforced via trigger; see below) | `'distilled'` | Allowed: `raw`, `distilled`, `superseded`, `archived`. CHECK enforced via INSERT/UPDATE triggers because `ALTER TABLE ADD COLUMN` cannot add CHECK on an existing-data table. |
| `scope` | TEXT | YES | NULL | NULL = global / un-scoped. Tenant semantics deferred to A5. Index: `idx_memories_scope WHERE scope IS NOT NULL`. |
| `owner` | TEXT | YES | NULL | Format: `user:<id>` or `agent:<id>`. |
| `artifact_ref` | TEXT | YES | NULL | URI to source artifact: `slack://team/channel/ts`, `gh://owner/repo/pr/123`, `file:///abs/path`. |
| `session_id` | (alias) | n/a | n/a | Reuse existing `source_session_id` column. Documented in `MEMORY_ENVELOPE.md` (Task 11). |
| `confidence` | TEXT | already exists | unchanged | `verified | observed | inferred | stale`. No change in this migration. |
| `timestamp` | (alias) | n/a | n/a | Already covered by existing `created` column. No new column. |

## `kind` allowed-set rationale

- `raw`: untransformed source artifact (Slack message, GH PR body, transcript). Append-only.
- `distilled`: anything that has been through extraction/summarization/compression. Default for existing rows.
- `superseded`: a row whose `superseded_by` points at a newer row. Used by recall to filter out stale beliefs without losing history.
- `archived`: post-deletion sentinel. Required because the trigger only fires on `kind='raw'`; the legitimate deletion path flips `kind` to `'archived'` before deleting so the trigger lets the delete through. Non-`raw` rows never hold this value in steady state.

## Backfill rules (Task 4)

Existing data is pre-A3, so all rows enter migration v14 with `kind = NULL`. We fix this in the migration body, in this order:

1. `UPDATE memories SET kind = 'superseded' WHERE kind IS NULL AND superseded_by IS NOT NULL`
2. `UPDATE memories SET kind = 'distilled' WHERE kind IS NULL`

Rationale: every row that exists today has been through some processing — none are raw transcripts. The only meaningful pre-existing distinction is whether a row has been retired by a newer one (superseded) or is current (distilled).

`scope`, `owner`, `artifact_ref` stay NULL on backfill. They get populated when connectors land (Slack ingest, GH ingest, etc., E1.x).

## Append-only invariant on `kind='raw'`

`BEFORE DELETE` trigger on `memories` with `WHEN OLD.kind = 'raw'` raises `RAISE(ABORT, 'raw is append-only')`. The only legitimate path to remove a `kind='raw'` row is `archiveRawMemory(db, id, { reason, who })` (Task 7), which:

1. Snapshots the full row into `raw_archive` as `payload_json`.
2. `UPDATE memories SET kind = 'archived' WHERE id = ?` so the trigger no longer fires.
3. `DELETE FROM memories WHERE id = ?`.
4. All three steps in one transaction.

## CHECK substitute via triggers

Because `ALTER TABLE ADD COLUMN` cannot add a CHECK constraint, we enforce the `kind` allowed-set via two triggers:

- `trg_memories_kind_check_insert` (BEFORE INSERT)
- `trg_memories_kind_check_update` (BEFORE UPDATE)

Both `RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived')` on out-of-set values. NULL passes (the column-level default fills it in).

## Out of scope here

- `tenant_id` / multi-tenancy isolation — A5
- Right-to-be-forgotten retention sweep — A4 (only the `archiveRawMemory` primitive lands here)
- Connector code that writes `kind='raw'` rows — E1.3 Slack, etc.
- `MatchExplanation` envelope surface and `--why` formatter — Tasks 8-9 (separate batch)
- `MEMORY_ENVELOPE.md` user-facing reference — Task 11
