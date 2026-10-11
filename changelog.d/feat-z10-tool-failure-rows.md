### Added

- **Tool failures in the delivery ledger.** With `deliveryLedger.enabled`, `hippo capture-error` now writes one `tool-failure` row per failed tool call, linked to its failure log row. A second hook run for the same tool call is marked as a duplicate when the host sends a tool call id (Claude Code does; the Copilot CLI does not). The ledger stays off by default.
- **One store hash per store.** Ledger rows written by this version (`ledger_version` 4) hash the store's resolved folder, so a store reached through a link or junction has one hash. Older rows still read.

### Changed

- **Schema v55.** Adds two columns and one index to `delivery_events`. Nothing is backfilled, and an older binary can still open and write the store.
