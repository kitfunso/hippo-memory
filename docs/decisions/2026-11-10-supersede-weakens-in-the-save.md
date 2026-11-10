# A superseding decision weakens the old memory in the same save, on every entry point

Date: 2026-11-10
Status: accepted
Links: `src/store/sqlite/records/object-writes.ts` (`weakenWithSave`); `src/surface/cli/decisions.ts`; `tests/cli/cli-maintenance-writes.process.test.ts`

## Context
`hippo decide --supersedes <memory-id>` committed the decision and the supersede link first, then weakened the old memory in a second best-effort write. The code comments gave the reason: a memory-write failure must not leave the memory stale while the table shows the supersession, and a failing weaken would make a retry find no active decision and record a duplicate. Two things were wrong with that trade.
- The weaken could be lost with exit 0. With a store rule refusing the write, `decide` printed a warning, recorded the decision and left the old memory verified with a 365 day half-life.
- Only the CLI weakened. `POST /v1/decisions/:id/supersede`, a create with `supersedesDecisionId` and the SDK `saveDecision` superseded the row and left the memory untouched.

## Evidence
- Built CLI on a temp store, weaken refused by a trigger, the same command run twice: both runs exit 0 with the warning, the decisions table ends with one superseded row and two active rows with no link between them, and the old memory is still verified/365.
- A real `hippo serve` on a temp store: after a CLI supersede the old memory is stale/182 with the tag `superseded`; after an HTTP supersede it is still verified/365.
- No MCP tool creates or supersedes a decision.
- The save already writes its own mirror memory, the row, the supersede link and every audit row in one write scope on one handle, so a second memory write fits in that scope.
- No shipped store rule refuses the weaken's UPDATE. `trg_memories_raw_append_only` is BEFORE DELETE only (`src/db/migrations/v14.ts`), the row writer is `INSERT ... ON CONFLICT(id) DO UPDATE` (`src/store/sqlite/entries/entry-row.ts`), and `trg_memories_graph_referenced_guard` fires only when kind or tenant changes (`src/db/migrations/v37.ts`). Only a custom trigger or a busy store can refuse it, and both leave nothing behind after the rollback, so a retry is safe.
- A plain re-run of `decide --supersedes` after a successful run still records another decision. That is how the verb works and this change keeps it.

## Decision
- The weaken moves into the save. The store weakens the memory the replaced decision mirrors, and the memory a caller names with `weakensMemoryId` (the CLI sets it only for a memory no active decision backs). Both happen in the save's write scope after the new mirror's audit row, with the existing `markStale`, so the half-life halves once.
- A refused weaken fails the whole save. Nothing is recorded, the CLI says the decision was NOT recorded and exits 1.
- HTTP and the SDK now weaken the replaced decision's memory. A decision whose mirror memory is already gone still supersedes and weakens nothing.
- A named memory the tenant does not hold refuses the save with the save-only refusal `memory_missing`; `ObjectRefusal` is not widened.

## Alternatives considered
- Keep the second write and make a retry repeat only the weaken: the retry cannot tell a half-done save from a new decision, and HTTP stays unweakened. Rejected.
- Add the weaken to the HTTP route as a second write: copies the non-atomic shape. Rejected.

## Consequences
- A memory the store cannot rewrite blocks the decision that supersedes it, instead of producing a half-done record.
- The audit log gains one `remember` row for the old memory on the HTTP and SDK paths. The CLI audit order is unchanged.
- `SaveDecisionOptions` gains the optional `weakensMemoryId` in the published testing entry.

## Reconsider when
- A shipped store rule starts to refuse rewrites of old memories, or a caller needs to record a decision while its predecessor's memory is locked.
