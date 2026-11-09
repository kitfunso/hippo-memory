# Storage holds one spelling of "no successor"

Date: 2026-11-09
Status: accepted
Links: `docs/decisions/2026-11-08-blank-superseded-link.md` (this adds to it); PR #1176; `src/db/migrations/v63.ts`; `src/store/sqlite/entries/entry-row.ts`; `src/db/sql-predicates.ts`

## Context
The 2026-11-08 record made every reader treat a non-NULL `superseded_by`, blank included, as superseded. It left storage with two spellings of "no successor": NULL and the empty string. Its stated cost: a blank-linked imported agent memory is no longer kept by the keep rule, so sleep can delete it or move it to dormant storage. It also said no writer or decoder maps a blank to NULL, because that would make a re-saved or restored blank row live. The owner approved the normalising migration on 2026-11-09, which that record named as the reason to reconsider.

## Constraints and evidence
- A one-line UPDATE clears the rows that exist, but three paths can store a blank again: a rebuild from markdown mirrors (`bootstrapLegacyStore`, which starts at the latest schema so no migration runs), a dormant restore whose stored JSON holds a blank, and a host that passes the empty string through `hippo-memory/store-kit`. Each reaches the row through `memoryRowValues` in `src/store/sqlite/entries/entry-row.ts`, the one mapper both `upsertMemoryRow` and `updateMemoryRows` use.
- `trg_memories_kind_check_update` is BEFORE UPDATE and not column-scoped. An UPDATE that touches a row with a NULL or unknown `kind` aborts, and an aborted migration leaves the store unable to open.
- The three direct `UPDATE memories SET superseded_by = ?` statements in `entry-writes.ts` write a real successor id, so they are not a source of blanks.
- No writer produces a whitespace-only link. A quoted whitespace value in a hand-edited mirror decodes to whitespace, and it stays a link.

## Decision
- Storage holds one spelling: NULL. Migration v63 sets `superseded_by` to NULL where it is the empty string and the row's `kind` is one of the four valid values. A row with a NULL or unknown kind is left alone so the migration cannot abort.
- The row mapper stores NULL for the empty string on every write. It does not read the stored row first. This replaces the old rule "no writer or decoder maps a blank to NULL": with the migration and the writer together a blank no longer has a second meaning, because no in-repo path stores one.
- The empty string only. Neither the migration nor the writer trims whitespace.
- The readers and the predicate text (`superseded_by IS NULL`, `isSuperseded`) do not change. A blank written by raw SQL still reads as superseded until a writer rewrites the row; any rewrite (an outcome, a restore, a consolidation write, a sleep strength refresh or replay) stores NULL, so such a row becomes live then.
- No refusing trigger pair. It would add schema, and on a v63 store it would make an older binary's blank write abort. A raw-SQL blank is already safe, because it reads as superseded.

## Alternatives considered
- Migration only: clears today's rows, but the three paths above store a blank again.
- Migration, writer and a trigger pair that refuses a blank on insert and on `UPDATE OF superseded_by`: closes raw SQL and other binaries, at the cost above.
- Blank means live in the predicate: loses three partial indexes, rejected by the 2026-11-08 record.

## Consequences
- The keep-rule consequence in the 2026-11-08 record is gone for migrated stores: a blank-linked imported agent memory is live and kept again.
- The entry a restore returns, and a mirror file written in that call, may still carry a blank line. The next rebuild from mirrors stores NULL, so it heals itself.
- An older binary opens a v63 store, since no `min_compatible_binary` bump is needed for a data-only change. Its writers can store a blank again, and a binary older than the 2026-11-08 change reads a blank inconsistently. Any rewrite on a current binary clears it.
- Rollback: the migration is one-way. A cleared row cannot be told from a row that was always NULL. That is safe, because NULL is the meaning every reader already accepts as live and the cleared rows carried no successor id.

## Reconsider when
- A host or a second store needs the empty string to carry a meaning.
- Raw SQL or another binary keeps storing blanks in practice: then add the trigger pair.
