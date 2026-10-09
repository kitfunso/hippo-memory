# Memory quality: the gate judges where a memory came from, never a person's words

Date: 2026-10-05
Status: accepted
Links: `src/memory-quality.ts` (`isAutomaticEntry`, `isReusable`, `isWorthSurfacing`); `src/quality-repair.ts`; `src/api/dormant.ts` `restoreDormant`; CONTEXT.md "Automatic memory"

## Context
The quality gate from #493 refuses fragments, raw tool output and build chatter. Its checks are regexes, and at build time they flagged 4 of 5 ordinary hand-written rules.
So the gate must never decide what a person keeps. The open question was how to tell a row hippo wrote from a row a person wrote, once promote, share, restore and invalidation have touched it.

## Decision
A row is automatic only when its confidence is `observed` or `inferred` and its provenance names a hippo writer: source (capture, git-learn, git, consolidation, `compaction:*`), a writer tag (`captured`, `compaction-memory`, `git-learned`) on a promoted or shared copy, `extracted_from`, `dag_level >= 1`, or a bundle header.

Source alone was not enough: promote and share rewrite source but keep tags, so a promoted capture escaped the gate.
Tags alone were too much: a person can set them, and `hippo import --markdown` turns a "## Captured" heading into the tag `captured`. So a writer tag counts only where source no longer can, on a `promoted:` or `shared:` row.
Requiring observed or inferred does two jobs. A row restored from an audit repair is stamped `verified` and leaves the gate for good, with no lookup in `audit_log`, which `audit prune` deletes. And invalidation's `stale` on a person's verified successor does not make it read as automatic.

Only certain defects act. An uncertain reason such as possible-fragment stores the row and lists it for review. A bundle is judged by its parts and held back only when every part has a certain defect, because its parts may be a person's words.

## Consequences
A future automatic writer that leaves confidence at the `verified` default escapes the gate. That fails safe: a defect gets through, a person's row is never hidden.
An invalidated automatic row (`stale`) also leaves the gate. Counting `stale` as automatic would judge a person's successors, because the confidence slot holds both who vouched and whether the row was invalidated. Splitting that slot comes first; it is in TODOS.md.
A promoted copy of a person's note that carries a writer tag reads as automatic. Closing that needs the original writer stored on the row, which copies keep; it is in TODOS.md.
