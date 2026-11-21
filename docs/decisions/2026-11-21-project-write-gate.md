# Project write gate: one serve option, asked once in remember()

Date: 2026-11-21
Status: accepted
Links: none yet (PR opens after this commit)

## Context
POST /v1/memories and MCP `hippo_remember` take the project name from the caller and stamp it on the row. An add-on cannot mount those paths, and `serve()` has no middleware, so an add-on could not stop a key writing under another project's name.

## Decision
- `ServeOptions.projectWriteGate(call)` returns null to let a write run, or a string to refuse it with 403 and that text.
- `admitProjectWrite(ctx, project)` is the one place that asks. `remember()` calls it first, so REST and MCP share one check. Add-on routes call it from `hippo-memory/server`.
- The helper validates the name with `assertCallerProject` before it asks, so a malformed name answers 400 and never reaches the gate.
- No gate on the context means no check and no change for a server without the option.
- Any answer but null refuses: an empty string, undefined or a non-string gets a default text. A gate that throws fails the write (500).
- Personal writes are never asked: their origin is empty and names no project.
- The gate runs before the salience read and before any content screen or review hold, so a refused write is never held.

## Alternatives considered
- A guard in each write route and each `*ForCaller` function: many copies of one rule, and add-on routes still need the helper.
- A core key-binding table or an `api_keys` column: SSO sessions have no key row, and it needs a migration for an add-on feature.
- Validating inside `remember()` before the helper: it changes a gate-less server, where a skipped write today never sees the name check.

## Consequences
- The add-on owns what a binding means and where it is stored; core only asks.
- Writes that name no project reach the gate with a null project.

## Reconsider when
- Object-kind routes or supersede start to stamp a caller's project: they would need the same gate.
