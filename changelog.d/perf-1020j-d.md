### Changed

- **The conflict refresh in `hippo sleep` reads only the memories that hold conflict refs.** Schema v63 adds a partial index of those rows, so a store of 10,000 memories with 5 conflicted rows visits 10 rows, not 10,000. A store upgrades on first open and keeps every row.
- **Recall traces older than 90 days that have no outcome are deleted.** The delivery ledger's prune now also deletes each such trace and its result rows, unless it is the store's last recall; traces with an outcome stay as training data. Schema v63 indexes traces by time so the prune reads only the old ones.
