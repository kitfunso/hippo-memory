### Changed

- **Schema v57 adds `token_ledger.sent_keys`.** Each per-prompt hook row records which memories and sections it printed, so the hook can tell what the agent's current context window already holds. Older rows stay NULL and never stop a send; no backfill, and an older binary still writes.
