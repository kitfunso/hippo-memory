# A sleep dry run reads rejected values and writes no refusal row

Date: 2026-11-10
Status: accepted
Links: `changelog.d/fix-share-once-truthful-dry-run.md`; `src/domain/consolidate/tombstones.ts`; `src/domain/consolidate/merge.ts`; `CONTEXT.md`, "Rejected value"

## Context
`hippo sleep --dry-run` is the preview a user reads before a real sleep. Its tombstone checks answered "none" without reading the store. A cluster whose merged text a user had rejected was therefore counted as merged in the preview, and the real sleep refused it.
On a real store with that rejection, the dry run printed "merged 2 episodic entries into semantic" and "Merged episodic: 2". The real sleep printed "Merged episodic: 0", logged "skipped 1 merge(s) whose content matches a rejected value" and wrote one `reject_refusal` audit row.

## Decision
- `find` and `rejectedAmong` always read the store. `audit` and `auditOrCount` stay inert under a dry run.
- A dry run builds the merged row as a real run does (building it is pure) so the same refusal runs. A refused cluster adds to `mergesSkippedRejected`, marks its members used and emits no `merged` event.
- The retired-text check reads the same way, so a dry run names the rows a real sleep retires.
- A dry run still writes the one `consolidate` summary audit row it wrote before. No refusal row, memory row or file is written.

## Not covered
- A dry run loads no sessions, so it previews no trace and claims none.
- A dry run does not swap a retired row for its successor in memory. When a rejected text frees its source to merge with a look-alike, the real sleep merges them and the preview does not.
- The successor id in a dry run's `retiredText` line is never stored, so it differs from the id a real sleep gives.
- `hippo share --auto --dry-run` lists candidates without the rejected-value check and is unchanged.

## Alternatives considered
- **Keep the preview blind and say so in the output:** no code change, but a preview that is wrong for a known case stays wrong.
- **Apply the successor swap in memory so the merge counts always match:** a larger change to the survivor set that the refused-cluster case does not need.

## Consequences
- A dry run now does the same tombstone reads as a real run: one batch read a tenant for each page of merged rows, and one or two single reads for each merge cluster. It still writes nothing else.
- A store with no rejected value prints the same dry run as before.

## Reconsider when
- The dry run applies survivor swaps in memory. Its merge count can then match the real one in the case above.
