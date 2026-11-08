# A blank superseded_by link means superseded

Date: 2026-11-08
Status: accepted
Links: PR #1176; PR #1097 (pinned the opposite for context and the dashboard); `src/base/memory/liveness.ts`; `src/db/sql-predicates.ts`

## Context
Readers disagreed on a memory whose stored `superseded_by` is `''`. Recall search, ambient context and the supersede guard read it as superseded. Context, the dashboard, sleep's duplicate scan and the keep rule read it as live. One predicate needs one meaning.

## Constraints and evidence
- Four partial indexes pin predicate text, and SQLite uses one only when the query repeats its WHERE term. Three use `superseded_by IS NULL`: `idx_memories_current`, `idx_memories_created_drift` (v51), `idx_memories_l2_unparented` (v59). The fourth, `idx_memories_duplicate_hash` (v61), uses `COALESCE(superseded_by, '') = ''`.
- Keith's store (read-only copy, schema v61) holds 0 blank rows: 22625 memories, 21704 with `superseded_by IS NULL`, 921 linked.
- No writer or decoder makes a blank. It comes only from an older binary's store or raw SQL.

## Decision
- Any non-NULL `superseded_by`, blank included, marks a memory superseded. The one SQL spelling is `superseded_by IS NULL`. The duplicate read adds the v61 index text as an AND-ed term, so that index stays in use.
- No writer or decoder maps a blank to NULL. Such a map would make a re-saved or restored blank row live, a second meaning.

## Alternatives considered
- Blank is live, spelled with COALESCE everywhere: loses three partial indexes or needs an index-rebuild migration.
- Blank is live through a data migration that sets blanks to NULL: parked for Keith. It changes the keep-rule answer below. It would add to this decision, and leave the spelling as it is.

## Consequences
- A blank-linked imported agent memory is no longer kept by the keep rule, so sleep can delete it or move it to dormant storage.
- Superseding a blank-linked memory fails with "is already superseded.", the same as recall already implied.

## Reconsider when
- A store with blank rows shows up, or Keith approves the normalising migration.
