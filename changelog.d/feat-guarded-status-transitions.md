### Fixed

- **A task snapshot clear no longer closes a snapshot that another process closed first.** Every status move on compaction records, goals, conflicts, quarantined memories and task snapshots now names the statuses it may leave, so a second writer finds nothing to change instead of overwriting the first.
- **The store refuses a task snapshot or conflict status outside its list.** `hippo snapshot clear --status` and `hippo conflicts --status` reject a value outside their list with exit 1, where a misspelt status used to be stored for good.

### Changed

- **Schema v62 adds the status triggers.** Four triggers check the status of task snapshots and conflicts on insert and on status update; rows already stored are kept as they are.
