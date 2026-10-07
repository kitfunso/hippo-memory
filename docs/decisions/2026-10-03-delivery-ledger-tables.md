# Per-turn delivery events as tables inside the recall-trace producer

Date: 2026-10-03
Status: accepted
Links: ROADMAP.md Z10, S7; docs/evals/2026-09-30-z10-ledger-prereg.md; docs/evals/2026-10-03-z10-ledger-slice1-result.md; PR #375

## Context
Z10 needs one record per hook call: what was considered, emitted, reused or rejected, and why.
ROADMAP S7 says to extend the existing trace producer and schema, with no second ledger.
The per-prompt hook path performs no retrieval, so it writes no `recall_traces` row today.

## Constraints and evidence
- `recall_traces` is one row per retrieval, with `query_hash NOT NULL` and a `pipeline` CHECK
  (api, cli, context, mcp). SQLite cannot widen a CHECK without rebuilding the table.
- A separate SQLite connection for the ledger added about 128 ms at p50 per hook call; writing
  on the token ledger's open connection cut the profiled cost to about 1.5 ms.

## Decision
Schema v50 adds `delivery_events` (one row per pinned-only call) and `delivery_candidates`
(per-memory outcome and reason, at most 16 rejected rows per event). The writer and reader
live in `src/recall-trace.ts`; `src/delivery-recorder.ts` only holds the in-memory observer.
`recall_trace_id` and `query_hash` are reserved for the `*` and query paths and stay null in
slice 1. A turn that injects a block writes its event on the token ledger's connection with a
50 ms lock wait; an empty or disabled turn opens the store itself. Both fail soft. Off by
default behind `deliveryLedger.enabled`.

## Alternatives considered
- Add hook rows to `recall_traces`: needs a table rebuild for the CHECK and a fake query hash.
- A new ledger module with its own connection: a second producer, and the 128 ms cost above.
- Record inside `getContext`: breaks its read-only contract on the pinned-only path.

## Consequences
- Rollback drops two tables and sets `schema_version` back to 49; no existing table or code path reads them.
- `turn_seq` is the ordinal among recorded events; a dropped write shifts later numbers.
- The p95 overhead gate is open (1.44 to 1.75 against 1.10, fixed arm order), so the flag
  stays off by default until a counterbalanced run passes.

## Reconsider when
- Slice 2 adds the `*` and query paths, or `recall_traces` is rebuilt for another reason.
