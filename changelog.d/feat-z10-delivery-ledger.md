### Added

- **An optional delivery ledger records what the per-prompt hook did on each turn.** It is off by default; turn it on with `{"deliveryLedger":{"enabled":true}}` in the store's `config.json`. Each `hippo context --pinned-only` call writes one event (session, turn number, block state, counts, token totals, hashes) and one row per candidate memory: emitted, reused or rejected, with the stage and reason it was dropped (scope, quality, duplicate, gate, budget or limit). It stores ids, hashes, counts and reasons only, never prompt or memory text. A ledger failure prints one stderr line and never changes the hook's output or exit code. Schema v50 adds the `delivery_events` and `delivery_candidates` tables; the change is additive; to roll back, drop those two tables and set `schema_version` back to 49. Rows older than 90 days are pruned.

### Known limitations

- The latency gate for turning the ledger on by default is open: the p95 bound failed in all four measured runs (ratio 1.44 to 1.75 against 1.10) on a loaded machine with a fixed run order. The flag stays off by default until a counterbalanced quiet run passes. Full numbers: `docs/evals/2026-10-03-z10-ledger-slice1-result.md`.
- With prompt recall on (the default), recent memories dropped by the quality filter get no candidate row.
- Calls that inject nothing (an empty or disabled block) open the store separately to write their event, which costs more than the shared write.
- `prompt_hash` is an unsalted, truncated SHA-256, so a very short prompt can be guessed from it.
- `recall_trace_id` and `query_hash` are always empty in this release; the `*` and query paths that fill them come in slice 2.
