### Added

- **The delivery ledger now records session ends and agent-run `hippo context` calls.** With `deliveryLedger.enabled` on, `hippo session-end` writes one boundary row for a host's SessionEnd payload, after its background worker has started, so a locked store never delays capture. A manual run and a `--turn` call (the end of one reply) write no row. `hippo context` without `--pinned-only`, the call the instruction block asks an agent to run, writes one `context` row that lists the memories it returned and the ones its limit cut. The delivery ledger stays off by default, and what both commands print, save and exit with is unchanged.
- **A `context` row links the recall trace its call wrote.** When the call returned memories, `recall_trace_id` names that trace and `query_hash` equals the trace's own query hash, so a reader can join a delivery to its ranked results. A call that returned nothing keeps the query hash and links no trace id. The per-prompt hook writes no trace, so its rows keep both fields empty.

### Changed

- **`delivery_events.ledger_version` is now 3.** It means a binary that can write `session-end` and `context` rows wrote the row, so `event_type` has six values and `surface` can be `context`. There is no schema change.
