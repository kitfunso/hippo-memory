# Project write gate: one serve option, asked once in remember()

Date: 2026-11-21
Status: accepted
Links: kitfunso/hippo-memory#1277

## Context
POST /v1/memories and MCP `hippo_remember` take the project name from the caller and stamp it on the row. An add-on cannot mount those paths, and `serve()` has no middleware, so an add-on could not stop a key writing under another project's name.

## Decision
- `ServeOptions.projectWriteGate(call)` returns null to let a write run, or a string to refuse it with 403 and that text.
- `admitProjectWrite(ctx, project)` is the one place that asks. `remember()` calls it first, so REST and MCP share one check. Add-on routes call it from `hippo-memory/server`.
- The helper validates the name with `assertCallerProject` before it asks, so a malformed name answers 400 and never reaches the gate.
- No gate on the context means no check and no change for a server without the option.
- Any answer but null refuses: an empty string, undefined or a non-string gets a default text. A gate that throws or rejects, whatever it throws (even an HttpError), fails the write with 500, except a busy-store error, which keeps its 503 and Retry-After; the original is the `cause` and the reply holds none of its text.
- The gate has a deadline, `ServeOptions.projectWriteGateTimeoutMs` (default 5000), the same helper `authResolver` uses. Past it the signal aborts and the write answers 503 'project write gate unavailable'.
- Statuses: 400 bad name (gate not asked), 403 refusal, 500 any other throw, 503 for a busy store or past the deadline.
- The gate gets a frozen copy of the actor, scopes included, so a JS gate cannot change the request's actor.
- The local CLI key (subject `localhost:cli`, no owner) reaches the gate. A gate that should let it through must allow it.
- Personal writes are never asked: their origin is empty and names no project.
- The gate runs before the salience read and before any content screen or review hold, so a refused write is never held.
- These exported helpers store a row under a caller's project and never ask the gate: `captureSessionTexts`, `preCompactForCaller`, `saveCompactionItemsForCaller`, `captureFailureForCaller`, `sessionEndHandoffForCaller`. An add-on route must call `admitProjectWrite` before them (the enterprise wrapper in Part B does).

## Alternatives considered
- A guard in each write route and each `*ForCaller` function: many copies of one rule, and add-on routes still need the helper.
- A core key-binding table or an `api_keys` column: SSO sessions have no key row, and it needs a migration for an add-on feature.
- Validating inside `remember()` before the helper: it changes a gate-less server, where a skipped write today never sees the name check.

## Consequences
- The add-on owns what a binding means and where it is stored; core only asks.
- Writes that name no project reach the gate with a null project.

## Reconsider when
- Object-kind routes or supersede start to stamp a caller's project: they would need the same gate.
