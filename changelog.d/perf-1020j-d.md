### Changed

- **The conflict refresh in `hippo sleep` reads only the memories that hold conflict refs.** Schema v63 adds a partial index of those rows, so a store of 10,000 memories with 5 conflicted rows visits 10 rows, not 10,000. A store upgrades on first open and keeps every row.
