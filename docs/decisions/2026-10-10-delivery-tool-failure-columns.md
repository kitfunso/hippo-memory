# Delivery ledger tool failures: two columns on delivery_events, keyed by the host's tool call id

Date: 2026-10-10
Status: accepted
Links: PR #797; `docs/evals/2026-09-30-z10-ledger-prereg.md`, "Slice 3" and Amendment 4; supersedes `2026-10-10-delivery-store-hash-path.md` for rows at `ledger_version` 4

## Context
Z10's exit stayed open until the ledger recorded tool failures. `failure_log` already kept each failure's time, session, tool and signature hash, so a ledger row adds its place in the ledger's id order, a link to the log row, and a per-call duplicate check. The store-hash record of the same day left one limit: a project `.hippo` that links to the global store read as foreign, because the hook hashed the path it took.

## Constraints and evidence
- `captureToolFailure` stores the lesson inside `try` and logs the failure in `finally` (`src/capture/capture-error.ts`), so the lesson is written before its log row; a time window starting at the log row can never hold the lesson.
- `failure_log.request_id` is the server client's queue-record id, not the host's tool call id.
- Parallel tool calls can fail within one millisecond, so a time-window duplicate rule would merge real failures.
- A live Claude Code 2.1.288 PostToolUseFailure payload carried `tool_use_id` and `prompt_id`; the Copilot CLI's camelCase payload has no tool call id (`src/cli/stdin.ts`).
- The store hash is read only by the ledger writer in `src/` and by the Z10 reader.

## Decision
- Migration v55 adds `delivery_events.tool_use_id` and `failure_id`, with a partial unique index on (tenant, session, `tool_use_id`) over numbered rows.
- `hippo capture-error` writes one `tool-failure` row after its log row. A second row with the same `tool_use_id` is a duplicate; a row with no id is never one.
- The reader links a failure to its lesson by `failure_log.sig_hash = failureHash(memory content)` for a `stored` outcome, not by time.
- From `ledger_version` 4 the writer hashes the store's resolved root, so each store has one hash; the reader keeps the two path rules for rows at version 3.

## Alternatives considered
- A new `tool_failures` table: a second ledger for one event type, and the reader would join two orders.
- Columns on `failure_log` instead: the failure would still have no place in the ledger's id order.
- A 2-second window as the duplicate key: merges parallel failures.
- Linking the lesson by audit time: fails by construction, and mixes the recorder's clock with the real clock.
- Keeping the path hash for version 4: leaves the linked-`.hippo` limit open.

## Consequences
- Tool failures read in ledger order next to the turns, with their outcome and lesson. Copilot CLI rows get no duplicate check.
- `failure_id` has no foreign key; both tables prune at 90 days, so a dangling id reads `log-missing`.
- The unique index leaves out `event_type`, while the duplicate lookup filters on it. They agree because only `tool-failure` rows carry `tool_use_id`; a later event type that sets it needs `event_type` in the key.
- The hook now pays one realpath per row; the overhead check includes it.

## Reconsider when
- A host sends a tool call id under another name, or stops sending it.
- The server failure caller needs ledger rows.
- A reader needs `prompt_id`.
