### Changed

- **Sleep makes its own choices in hippo, and a store's `consolidation` group only reads and writes, in 14 methods where it had 28.** `begin`, `settleSummary`, `commit` and `recordSleep` replace the half-life, rebuild, flush and run-record calls; `dormant.holds` is gone in favour of `dormant.list` with `{ id }` (see UPGRADING-3.0.md).
