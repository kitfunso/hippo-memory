### Added

- **Six new optional store groups for integrators.** `Sessions`, `Cards`, `Goals`, `Conflicts`, `Dormant` and `Reports` join the store port, so a custom store can serve snapshots and handoffs, the card board, goals, conflict resolving, dormant memories and the status, token and failure reports. A store without one leaves it unset, and the matching verbs answer 501.

### Changed

- Internal: the conflicts, dormant, status, token and refine api files read and write through the store port instead of opening hippo.db by folder; the CLI and MCP callers await them.
