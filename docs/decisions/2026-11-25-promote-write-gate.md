# Project write gate: promote on a shared store asks with the row's own project

Date: 2026-11-25
Status: accepted
Links: `docs/decisions/2026-11-21-project-write-gate.md`; `src/api/project-write-gate.ts` (`admitOriginWrite`); `src/api/memories/promote.ts` (`promoteInPlace`)

## Context

The first gate record made `remember()` ask the gate with the caller's declared project. Promote on a shared store is a second door that writes about a memory, and it never asked. It admits a row by the project in the request body. So a key that the gate limits to project A could promote a row of project B by sending `{name: 'B'}`, or `{name: 'A', aliases: ['B']}`, because the row match reads aliases. An add-on cannot close this from outside: its only check is the gate, and the gate was never called.

## Decision

- `promoteInPlace` asks the gate once, with the row's stored `originProject` when it is a non-empty string, else null. The body project and its aliases never reach the gate. They are caller input.
- The check is `admitOriginWrite(ctx, origin)` in `src/api/project-write-gate.ts`. It shares `askGate` with `admitProjectWrite`, so the deadline, the 503, the 500 with its cause, the busy-store rethrow, the default text and the frozen actor are one copy. `admitOriginWrite` is not exported from `hippo-memory/server`. The ask runs inside `promote()`, so every caller of `promote()` gets it.
- The stored origin does not pass `assertCallerProject`. An older name, for example one with upper case, reaches the gate and gets its answer. It must not turn a promote into a 400. `ProjectWriteCall.project` can therefore be an unchecked stored origin. Its TSDoc and the changelog say so.
- Order: a missing body project answers 400, then a missing, unadmitted or unreachable row answers 404, then the superseded 409 and the quarantine, personal and secret 400s, then the gate, then the audit row. The gate is asked only about a row the caller can read and could promote. A refused caller learns nothing about a row it cannot already read. A personal row never reaches the gate, because the personal 400 comes first.
- A host admin key is asked too, as in `remember()`. The gate decides about admins itself.
- A refusal answers 403 with the gate's text and writes no `promote` audit row.
- A user-global row (origin empty) and a row with no origin both ask with null. That is the value a write that names no project asks with.
- A server with no gate reads nothing more and runs as before.

## Alternatives considered

- Ask with the body project: it is caller input, so the caller names the project it is allowed and still reaches the other row.
- A check in the promote route handler: any other caller of `promote()` would miss it.
- A wrapper route in an add-on: it would have to read the row and repeat the match rule, and it would drift from core.

## Consequences

- A caller that the gate limits to named projects can no longer promote a user-global row, because the gate sees null. A gate that lets null through, and an unbound key, still can.
- A row stored under a legacy or alias name of an allowed project is refused until the gate allows that name too. The gate sees the stored name as it is.
- A promote on a store that is not shared copies the row into the host's global store, and the MCP `hippo_share` tool makes the same copy. Neither asks the gate, and this change leaves both as they are. `hippo_share` is off on a shared store. If an add-on serves a store that is not shared and sets a gate, gate the copy with `admitOriginWrite` on the copy's origin.

## Reconsider when

- `docs/decisions/2026-11-21-project-write-gate.md` names object-kind routes and supersede as the next doors that stamp a caller's project. Promote is a door that writes about an existing row, and it now asks. Any new route that writes about an existing row should ask through `admitOriginWrite` or the row check that goes with it.
