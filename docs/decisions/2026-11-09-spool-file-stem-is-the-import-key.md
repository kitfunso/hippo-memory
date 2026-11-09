# The spool file stem is the key that makes a spool import idempotent

Date: 2026-11-09
Status: accepted
Links: `changelog.d/fix-spool-import-idempotent.md`; `src/infra/spool-import.ts`; `src/store/sqlite/capture/compaction-hooks.ts`

## Context
When the store is busy, a compaction summary waits in the spool as a file. A replay claims the file and imports it. `importSpooled` in `src/surface/capture/compaction-record.ts` saves the record, then the importer unlinks the claim, then the items are written.

If the unlink stays busy, or the process dies after the save, the claim stays. `src/infra/spool-recovery.ts` puts a claim back after `STALE_MS` (10 minutes), and the next replay imports it again. `recordSummary` matched only `started` rows, so the second import inserted a second `summarised` row. The `compactions` table then held the same summary twice.

## Evidence
- `importSpooled` calls `recordSpooled`, then `recorded()`, then `saveRecordItems`. `recorded()` is the step that calls `removeClaim` (`src/infra/spool-import.ts`).
- `recoverStaleClaims` puts back a claim that is over `STALE_MS` old, with the attempt number raised by one. The stem stays the same.
- `latestStartedRows` selects `status = 'started'` rows only (`src/store/sqlite/capture/compaction-rows.ts`). A record that is already `summarised` is never found, so a new row is inserted.
- The stem is the one name a spool file keeps while it is claimed, put back and claimed again.

## Decision
- The spool file stem is the import key. The store keeps it in the existing `compactions.request_id` column as `spool:<stem>`.
- When the prefixed form is longer than `MAX_ID_LEN` (256), the store keeps `spool:` plus the sha256 hex of the stem instead.
- `recordSpooled` looks the key up before it saves. A hit reuses the saved record. A miss saves the record with the key.
- Alternatives rejected:
  - A marker file beside the claim. There is still a window between the two file operations.
  - Unlink before save. A death between the two loses the summary.
  - A hash of the body as the key. Two genuinely identical summaries would merge into one.

## Consequences
- No schema change. The key uses a column that already exists.
- A record saved by an older binary has no key. Its leftover claim imports once more and then gets the key.
- A caller's own request id can match a key only if it sends the same `spool:` text on purpose. If that caller is another session, the import of that file fails as another session's request and counts as a failed try.
- The hash form is not injective in theory: a raw stem could equal the hex of a longer stem. No real stem can be that, so this is accepted.
- A busy unlink that lasts through 3 attempts still ends as `.bad`, but with exactly one record.
- A store kit that ignores the optional `importKey` keeps the old behaviour.
