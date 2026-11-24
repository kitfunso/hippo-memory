# Project write gate: a write to an existing memory is judged by that memory's project

Date: 2026-11-24
Status: accepted
Links: `docs/decisions/2026-11-21-project-write-gate.md`; `src/api/project-write-gate.ts` (`admitRowWrite`, `refusedRowIds`)

## Context

The first record made `remember()` ask the gate with the caller's declared project. A write to a memory that already exists never asked. So a caller that the gate refuses for project B could still supersede, forget, raw-archive or re-score a memory whose origin is B. A supersede also writes new text under B, because the successor keeps the old memory's origin (`createSuccessor`).

## Decision

- The check lives in `src/api/project-write-gate.ts`, beside `admitProjectWrite`. `supersede`, `forget`, `rawArchive`, `outcome` and `conflictResolve` call it first, so REST, MCP and any add-on route that calls these functions share one check. No route handler or tool handler gets its own guard.
- `admitRowWrite(ctx, id, missing?)` judges one memory. It throws 404 or 403, and it returns the row it read, or undefined when no gate is set and nothing was read. `refusedRowIds(ctx, ids)` is the form for many ids. Neither is exported from `hippo-memory/server`: an add-on reaches them through the api functions.
- `askGate` holds the lines that `admitProjectWrite` ran before: the deadline, the 503, the 500 with its cause, the busy-store rethrow, the default text and the frozen actor. `admitProjectWrite` now validates, asks and throws. A second copy of those guards would drift from the first.
- What the gate sees: the memory's stored `originProject`, verbatim, when it is a non-empty string, else null. The caller's declared project, its aliases and the `X-Hippo-Project` header take no part. Those are caller input, and trusting them is the flaw that `promote` has on a shared store, which admits by the body's project. The api `Context` has no caller-project field, so these functions could not use one anyway.
- The stored origin does not pass `assertCallerProject`. An older name, for example one with upper case, must reach the gate and get its 403. It must not turn a write that names no project into a 400. This changes the contract of `ProjectWriteCall.project`: it can now be an unchecked stored origin. The TSDoc and the changelog say so.
- A personal row skips the gate, as a personal `remember` does. The helper tells it apart by scope, not by an empty origin, because an empty origin also marks a team memory written outside any project, and a gate must judge that one. The reach rule already lets only the owner reach a personal row.
- A row with no origin (null, undefined, or an empty string on a team row) goes to the gate as project null. This is the rule that a write with no project gets today.
- Order at each site: no gate on the context means return at once and read nothing, so a server without the option runs as before. Then read the row by id in the caller's tenant. A missing row, or a row out of the caller's reach, answers 404 with the site's own text and the gate is not asked, so a refused caller cannot learn that a row it cannot read exists. A personal row passes. Any other row is asked, and a string answer is a 403. The site then runs its own checks: the owner 403, the superseded 409, the raw refusals, the write screen, the review hold and the store write.
- Supersede: the gate sits in `supersede()`, before the screen and before the review hold, so a refused supersede is never screened or held. The helper returns the row, and `supersedeScreened` takes the checked row, so the row is read once. `supersedeScreened` is at the 50-line cap of `max-lines-per-function`, so one more line there fails the lint ratchet.
- Outcome applies the ids the gate admits, skips the refused ones and never answers 403. Hooks call outcome after each task with the ids the last recall showed. Reads are not bound to a project, so those ids can cross projects, and a 403 would turn a routine call into an error the hook cannot fix. The helper reads the rows once, keyed by id, because a Postgres store returns rows in creation order. It drops missing, unreachable and personal ids without asking. It asks the gate once for each project, one after another, in the order the ids first show it. A gate error (500 or 503) fails the whole call before the store applies anything. When every id is refused, the store is not called.
- `OutcomeResult.refused` is the count of distinct ids the gate refused, set only when it is above 0. `POST /v1/outcome` and `hippo_outcome` show it only then. It counts only rows the caller reaches, so it leaks nothing. The shown-ids form uses the same path. `outcomeForLastRecall` is CLI only and never has a gate.
- Forget and raw archive read the row first when a gate is set. The read and the store write cannot disagree on the origin, for four reasons. No member path changes a live row's origin: supersede keeps it, and only operator maintenance and migrations restamp it (`restampOriginProject`, `stampOriginProjects`, `renameEntrySourceAndOrigin`, migration v39). Both steps name the same id in the same tenant, and ids are random and never reused. The store still checks reach and owner inside its own transaction, so a row that is gone or out of reach by then answers 404. If an operator restamps the row between the two steps, the result is the same as a serial order, and the gate judged the project the row had when the member asked. So the store port does not change.
- `ProjectWriteCall` gains no field. For every gate we know, the answer depends only on tenant, actor and project. The request line already names the route and the role, so an operator can tell a refused DELETE from a refused POST. A union of operation names widens with each new site, and a wider union breaks a consumer's exhaustive switch. An optional field stays additive later.
- A conflict resolve with `rejectLoser` removes more than the loser. The store writes a tombstone for the whole tenant and then deletes or archives every live row in the tenant whose digest matches the loser's value, whatever its project, sparing the kept row and other people's personal rows. No list of those projects exists before the store call, because the store finds the rows inside its own transaction. So `conflictResolve` asks `admitProjectWrite(ctx, null)` when the loser's fate is a reject. The call comes after the loser's row gate and before the removal check and the store call. A personal loser with `rejectLoser` still gets its 400 first. null is the value for a write that names no single project.
- The kept row of a resolve loses the loser's id from its `conflicts_with_json`. That is metadata only, the conflict link, so the gate is not asked about the kept row. The same holds for the DAG parent summary that supersede, forget, archive and outcome mark dirty.

## Alternatives considered

- A check in each route and each tool: many copies of one rule, and an add-on route that calls the api would miss it.
- Trusting the caller's project for these writes: it is caller input, so the caller could name a project it may write to and change a row of another.
- A 403 for the whole outcome call when any id is refused: it breaks the routine hook call, and the caller cannot tell which id to drop.
- An origin compare-and-set in the store port: the four reasons above make the race harmless, and a port change reaches every store.
- An operation field on the call: see the decision on `ProjectWriteCall`.
- For `rejectLoser`, a refusal for every non-admin whenever a gate is set: it takes `rejectLoser` away from callers that the gate would admit for null.
- For `rejectLoser`, leaving `hippo_resolve` to a later change: that leaves the hole open.

## Consequences

- A row with no origin needs an admin or an ungated caller.
- A gated server does one more by-id read for forget, archive and every resolve. Supersede does not, because the helper returns the row. A server with no gate reads nothing more.
- A caller that the gate refuses for null cannot resolve with `rejectLoser`, even when every duplicate is in its own project. An admin, an unbound caller or the CLI can still do it.
- A row whose origin is a legacy or alias name of an allowed project is refused, because the gate sees the one stored name. The operator allows that name too.
- A typed-object supersede still weakens its old mirror memory with no gate. Object writes carry no caller project.
- `hippo_resolve` is off on a shared store, so only a server on a non-shared store reaches the null ask.

## Reconsider when

- A member path starts to change a live row's origin: the read-then-write reasoning for forget and archive no longer holds.
- Typed objects or promote get a caller project: they would call `admitRowWrite` too.
