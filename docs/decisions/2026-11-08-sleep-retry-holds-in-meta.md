# Sleep retry holds: per-row `meta` keys, not a tag or a column

Date: 2026-11-08
Status: accepted
Links: this PR; `src/store/sqlite/folder-files/due-mirrors.ts` (the `mirror_due:<id>` keys this follows); `CONTEXT.md`, "Rebuild hold" and "Empty extraction mark"

## Context
Sleep sent two kinds of work to the model on every run, whatever the last result was.
A dirty DAG summary whose rebuild failed stayed dirty, so the next sleep paid for it again. A broken summary also took one of the 20 rebuild slots each run, so 20 broken summaries with the newest `latest_at` starved every healthy one.
A source memory whose extraction found nothing was offered again on each sleep. The batch is the first 20 candidates in created order, so 20 such sources at the head meant no later source was ever offered.
Both passes need a small piece of per-memory state that survives between sleeps: a failure count with a retry time, and a note of which text was empty.

## Constraints and evidence
- The episode's acceptance criterion named a tag as the marker, with no migration. A tag on a source is copied by `createSuccessor` and by a sleep merge, is shown in recall and is FTS-indexed. A tag written through `writeEntry` on a level-2 summary also marks its parent dirty. Written in the middle of a sleep, it races the survivors flush.
- `last_rebuilt_at` and `rebuild_count` feed the recall freshness boost and the score breakdown. A failed rebuild writes nothing to them today, so reusing them would change ranking.
- A new column is a schema migration on live data, which needs a sign-off, and the next schema version is already claimed by another change.
- No other code enumerates the `meta` table. Every reader asks for one key or a prefix range, as the `mirror_due:` and connector replay keys do.
- Ids are globally unique. Every write of a key first checks that its memories row is live, a hold write also checks the row's tenant, and the hold reads join the row.

## Decision
Keep both states in per-row `meta` keys, following `mirror_due:<id>`:
- `rebuild_hold:<summary id>` holds `{"failures": n, "retryAfter": <ISO time or null>}`.
- `empty_extraction:<source id>` holds `{"digest": <hash of the text>, "at": <ISO time>}`.

The digest is `blockHash` of the content, so any edit, whitespace included, offers the source again. A source is marked when the model returns an empty array, or when every fact it returns is refused by a rejected value. A reply whose facts fail the quality check leaves it unmarked, as bad model output is worth a retry. A mark expires after 30 days. A hold starts at the third failure in a row, lasts one day and doubles up to 7 days. A provider failure never counts.
The marker is therefore a meta key and not a tag. This departs from the acceptance criterion, for the reasons above.

## Alternatives considered
- **A tag on the memory:** no migration, but it is copied, shown, indexed and raced as described above.
- **`last_rebuilt_at` and `rebuild_count`:** no new column, but they change the freshness boost and the score breakdown, and extraction would still need a second carrier.
- **A new column on memories:** the cleanest read, but it is a live-data migration and too large for a retry cap.

## Consequences
- A key has no foreign key and no tenant column. The keys stay bounded: a sweep drops keys whose row is gone, archived or no longer dirty, and the settle transaction deletes a hold when a rebuild lands.
- `emptyExtractions` reads `meta` alone, so a mark carries no tenant. This is harmless because sleep runs host-wide and ids are globally unique.
- The new `consolidation` members and the `at` argument are optional. A store built on `hippo-memory/store-kit` without them keeps today's behaviour: no holds and no marks.
- A store with no holds and no marks sleeps and prints as before. No migration runs.

## Reconsider when
- The next schema migration that touches memories could carry these two states as columns.
