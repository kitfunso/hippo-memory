### Changed

- **The store port now owns its types, and the ledger group has one more method.** A store that sets `localFiles` adds `ledger.noteSkipped(error)`, which says why a ledger row did not land; published names, `sleep` and `consolidate` are unchanged.
