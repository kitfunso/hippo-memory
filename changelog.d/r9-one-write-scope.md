### Changed

- **Internal: 16 hand-rolled write transactions now run through `withWriteScope`.** Index, physics, audit-prune, snapshot, prediction, conflict, token-ledger and trace writes share one begin, commit and rollback path. A write that starts inside an open transaction now joins it as a savepoint instead of failing.
