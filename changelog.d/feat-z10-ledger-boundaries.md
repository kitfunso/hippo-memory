### Added

- **The delivery ledger now records the two compaction hooks.** With `deliveryLedger.enabled` on, `hippo pre-compact` and `hippo compact-resume` each write one boundary row to `delivery_events`, so a reader sees where the context was reset between two prompt rows. A repeat fire of one hook within two seconds becomes a duplicate row. A missing boundary row is a gap, not proof that no compaction happened. The delivery ledger stays off by default, and what both hooks print, save and exit with is unchanged.

### Changed

- **`delivery_events.ledger_version` is now 2.** It means a binary that can write boundary rows wrote the row, and `event_type` has four values: `prompt-submit`, `pinned-manual`, `pre-compact` and `compact-resume`. There is no schema change.
